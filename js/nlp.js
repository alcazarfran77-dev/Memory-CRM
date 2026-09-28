/*
 * Memoria CRM · Motor de lenguaje bilingüe (español / inglés), 100 % local.
 *
 * 1. Detecta el idioma de la nota (es / en).
 * 2. Aplica las reglas de ese idioma: cliente y empresa, promesas con fecha,
 *    tipo de interacción, temas, preferencias, personas y sentimiento.
 * Si el modelo NER multilingüe está cargado, sus entidades (PER/ORG) se usan
 * como señal adicional. Los embeddings (temas por significado, búsqueda) se
 * aplican en app.js.
 *
 * Todo lo que no es texto del usuario se devuelve como CÓDIGO (tipo, tema,
 * sentimiento, motivo) para que la interfaz lo muestre en el idioma elegido.
 */
(function (root) {
  "use strict";

  /* ---------- utilidades ---------- */
  // NFC primero: quitar diacríticos conserva la longitud y los índices coinciden con el texto original.
  const nfc = (s) => String(s ?? "").normalize("NFC").replace(/[‘’]/g, "'");
  const norm = (s) => nfc(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const WORD = "a-záéíóúñü";
  const UP = "A-ZÁÉÍÓÚÑÜ";

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 1) return 2;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    return dp[a.length][b.length];
  }

  const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today0 = (now) => { const x = new Date(now); x.setHours(0, 0, 0, 0); return x; };
  const nextWeekday = (t0, target, forceNext) => {
    let diff = (target - t0.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    if (forceNext && diff < 2) diff += 7;
    return addDays(t0, diff);
  };
  const nextMonday = (t0) => addDays(t0, ((1 - t0.getDay() + 7) % 7) || 7);
  const futureDate = (t0, y, mon, day, explicitYear) => {
    let d = new Date(y, mon, day);
    if (!explicitYear && d < t0) d = new Date(y + 1, mon, day);
    return d;
  };

  /* =====================================================================
   * 1. DETECCIÓN DE IDIOMA
   * Palabras funcionales frecuentes + marcas ortográficas. Funciona bien
   * con notas cortas (una frase), donde los modelos estadísticos fallan.
   * ===================================================================== */
  const ES_WORDS = new Set(("de la que el en y los se del las un por con una su para es al lo como mas pero sus le ya fue este ha si porque esta son entre cuando muy sin sobre tambien hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto antes algunos unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mis tu te ti tus ellas " +
    "prometi quede tengo debo voy envio mando manana hoy ayer semana proxima llamada reunion comida cafe cliente propuesta quiere pidio hablamos preocupado preocupada enviar mandar agendar hijo hija esposa prefiere gusta encanta").split(" "));
  const EN_WORDS = new Set(("the of and to in is it you that he was for on are with as his they be at have this from or had by but some what there we can out other were all your when up how said an each she which do their if will about many then them would like so these her see him has more could go come did my most who over know than first may down been now any new take get made also after before because " +
    "promised need needs send call meeting lunch dinner coffee tomorrow today yesterday week next asked wants worried prefers loves likes son daughter wife husband proposal quote schedule follow i'll i'm i've we'll she'll he'll they'll won't don't doesn't").split(" "));

  function detectLanguage(text, fallback) {
    const raw = nfc(text);
    const lower = norm(raw);
    const words = lower.match(/[a-z']+/g) || [];
    let es = 0, en = 0;
    for (const w of words) {
      if (ES_WORDS.has(w)) es += 1;
      if (EN_WORDS.has(w)) en += 1;
    }
    // "i" suelto y contracciones son muy ingleses; ¿ ¡ ñ y tildes, españoles (ojo: los nombres propios también llevan tildes).
    en += (raw.match(/\bI\b/g) || []).length * 1.5;
    en += (lower.match(/\b\w+'(ll|ve|re|s|t|d|m)\b/g) || []).length * 1.5;
    es += (raw.match(/[¿¡]/g) || []).length * 2;
    es += (raw.match(/[ñÑ]/g) || []).length * 0.5 + (raw.match(/[áéíóúÁÉÍÓÚ]/g) || []).length * 0.4;
    const total = es + en;
    if (total < 1) return { lang: fallback || "es", confidence: 0, scores: { es, en } };
    const lang = es === en ? (fallback || "es") : es > en ? "es" : "en";
    return { lang, confidence: Math.min(1, Math.abs(es - en) / total), scores: { es: +es.toFixed(1), en: +en.toFixed(1) } };
  }

  /* =====================================================================
   * 2. FECHAS
   * ===================================================================== */
  function collectDates(n, pushers) {
    const found = [];
    for (const [re, fn] of pushers) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(n))) {
        const d = fn(m);
        if (d) found.push({ due: ymd(d), start: m.index, end: m.index + m[0].length });
        if (!re.global) break;
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    return found[0];
  }

  const ES_WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  const ES_MONTH_RE = "(ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:t(?:iembre)?)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?)";
  const ES_MONTHS = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11 };
  const ES_NUM = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, quince: 15, "un par de": 2 };

  function parseDateEs(text, now) {
    const t0 = today0(now || new Date());
    const n = norm(text);
    const P = "(?:para |antes de(?:l)? |a mas tardar (?:el )?|el |este |esta |la |a )?";
    return collectDates(n, [
      [new RegExp("\\b" + P + "hoy( mismo)?\\b", "g"), () => t0],
      [new RegExp("\\b" + P + "pasado manana\\b", "g"), () => addDays(t0, 2)],
      [/\b(?:para |antes de )?manana\b/g, (m) => (/(la|las|pasado|de) $/.test(n.slice(Math.max(0, m.index - 8), m.index)) ? null : addDays(t0, 1))],
      [new RegExp("\\b" + P + "(?:proximo |siguiente )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?: (?:que viene|proximo|siguiente))?\\b", "g"),
        (m) => nextWeekday(t0, ES_WEEKDAYS.indexOf(m[1]), /proximo|siguiente|que viene/.test(m[0]))],
      [/\b(?:para |antes de )?(?:la |esta )?(?:proxima semana|semana que viene|siguiente semana)\b/g, () => nextMonday(t0)],
      [/\b(?:este |el )?fin de semana\b/g, () => nextWeekday(t0, 6, false)],
      [/\b(?:para |antes de |a )?(?:fin|finales|final) de(?:l)? mes\b/g, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 0)],
      [/\b(?:el |para el )?(?:mes que viene|proximo mes|siguiente mes)\b/g, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 1)],
      [/\b(?:en |durante |antes de terminar )?este mes\b/g, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 0)],
      [/\b(?:en|dentro de) (\d{1,2}|un par de|una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince) (dias?|semanas?|mes(?:es)?)\b/g, (m) => {
        const k = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : ES_NUM[m[1]];
        if (!k) return null;
        if (m[2].startsWith("dia")) return addDays(t0, k);
        if (m[2].startsWith("semana")) return addDays(t0, 7 * k);
        return new Date(t0.getFullYear(), t0.getMonth() + k, t0.getDate());
      }],
      [new RegExp("\\b(?:el |para el |antes del )?(\\d{1,2}) de " + ES_MONTH_RE + "(?: de (\\d{4}))?\\b", "g"), (m) => {
        const day = +m[1], mon = ES_MONTHS[m[2].slice(0, 3)];
        if (mon == null || day < 1 || day > 31) return null;
        return futureDate(t0, m[3] ? +m[3] : t0.getFullYear(), mon, day, !!m[3]);
      }],
      // España y Latinoamérica: día/mes
      [/\b(?:el |para el |antes del )?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g, (m) => {
        const day = +m[1], mon = +m[2] - 1;
        if (mon < 0 || mon > 11 || day < 1 || day > 31) return null;
        let y = m[3] ? +m[3] : t0.getFullYear(); if (y < 100) y += 2000;
        return futureDate(t0, y, mon, day, !!m[3]);
      }],
      [/\b(?:el |para el |antes del )dia (\d{1,2})\b/g, (m) => {
        const day = +m[1]; if (day < 1 || day > 31) return null;
        const d = new Date(t0.getFullYear(), t0.getMonth(), day);
        return d < t0 ? new Date(t0.getFullYear(), t0.getMonth() + 1, day) : d;
      }],
    ]);
  }

  const EN_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const EN_MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const EN_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const EN_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, "a couple of": 2, "a few": 3 };

  function parseDateEn(text, now) {
    const t0 = today0(now || new Date());
    const n = norm(text);
    const P = "(?:by |on |before |until |no later than |this |for )?";
    return collectDates(n, [
      [new RegExp("\\b" + P + "(?:today|tonight|end of (?:the )?day|eod)\\b", "g"), () => t0],
      [new RegExp("\\b" + P + "(?:the )?day after tomorrow\\b", "g"), () => addDays(t0, 2)],
      [new RegExp("\\b" + P + "tomorrow\\b", "g"), (m) => (/after $/.test(n.slice(Math.max(0, m.index - 6), m.index)) ? null : addDays(t0, 1))],
      [new RegExp("\\b" + P + "(next |this coming |the following )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: next week)?\\b", "g"),
        (m) => nextWeekday(t0, EN_WEEKDAYS.indexOf(m[2]), !!m[1] || /next week/.test(m[0]))],
      [/\b(?:by |before |until )?(?:next week|the following week|early next week)\b/g, () => nextMonday(t0)],
      [/\b(?:this |over the |by the )?weekend\b/g, () => nextWeekday(t0, 6, false)],
      [/\b(?:by |before |at )?(?:the )?end of (?:the )?month\b|\bby month end\b/g, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 0)],
      [/\b(?:by |in )?next month\b/g, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 1)],
      [/\b(?:within |during |by the end of )?this month\b/g, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 0)],
      [/\b(?:in|within) (\d{1,2}|a couple of|a few|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen) (days?|weeks?|months?)\b/g, (m) => {
        const k = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : EN_NUM[m[1]];
        if (!k) return null;
        if (m[2].startsWith("day")) return addDays(t0, k);
        if (m[2].startsWith("week")) return addDays(t0, 7 * k);
        return new Date(t0.getFullYear(), t0.getMonth() + k, t0.getDate());
      }],
      // "October 15", "Oct 15th, 2026"
      [new RegExp("\\b(?:by |on |before )?" + EN_MONTH_RE + "\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b", "g"), (m) => {
        const mon = EN_MONTHS[m[1].slice(0, 3)], day = +m[2];
        if (mon == null || day < 1 || day > 31) return null;
        return futureDate(t0, m[3] ? +m[3] : t0.getFullYear(), mon, day, !!m[3]);
      }],
      // "15 October", "the 15th of October"
      [new RegExp("\\b(?:by |on |before )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?" + EN_MONTH_RE + "(?:,? (\\d{4}))?\\b", "g"), (m) => {
        const day = +m[1], mon = EN_MONTHS[m[2].slice(0, 3)];
        if (mon == null || day < 1 || day > 31) return null;
        return futureDate(t0, m[3] ? +m[3] : t0.getFullYear(), mon, day, !!m[3]);
      }],
      // EE. UU.: mes/día
      [/\b(?:by |on |before )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => {
        const mon = +m[1] - 1, day = +m[2];
        if (mon < 0 || mon > 11 || day < 1 || day > 31) return null;
        let y = m[3] ? +m[3] : t0.getFullYear(); if (y < 100) y += 2000;
        return futureDate(t0, y, mon, day, !!m[3]);
      }],
      [/\b(?:by|on|before) the (\d{1,2})(?:st|nd|rd|th)\b/g, (m) => {
        const day = +m[1]; if (day < 1 || day > 31) return null;
        const d = new Date(t0.getFullYear(), t0.getMonth(), day);
        return d < t0 ? new Date(t0.getFullYear(), t0.getMonth() + 1, day) : d;
      }],
    ]);
  }

  /* =====================================================================
   * 3. TEMAS (ids estables; la interfaz traduce el nombre)
   * ===================================================================== */
  const TOPICS = [
    { id: "expansion", es: "Expansión", en: "Expansion",
      desc: { es: "expansión del negocio, crecer, abrir una nueva planta, sucursal o mercado", en: "business expansion, growth, opening a new plant, site or market" },
      kw: { es: ["expansion", "expandir", "crecer", "crecimiento", "nueva planta", "nuevo mercado", "sucursal", "abrir una"], en: ["expansion", "expand", "grow", "growth", "new plant", "new market", "new site", "open a new"] } },
    { id: "manufacturing", es: "Manufactura", en: "Manufacturing",
      desc: { es: "manufactura, fábrica, planta de producción, líneas de producción", en: "manufacturing, factory, production plant, production lines" },
      kw: { es: ["manufactura", "fabrica", "planta", "produccion", "linea de", "maquinaria", "ensamble"], en: ["manufactur", "factory", "plant", "production", "assembly", "machinery", "shop floor"] } },
    { id: "financing", es: "Financiamiento", en: "Financing",
      desc: { es: "financiamiento, crédito, préstamo, inversión, capital, bancos", en: "financing, funding, credit, loans, investment, capital, banks" },
      kw: { es: ["financiamiento", "financiar", "credito", "prestamo", "inversion", "inversionista", "capital", "fondeo", "banco", "cfo"], en: ["financing", "funding", "loan", "credit", "investment", "investor", "capital", "bank", "cfo"] } },
    { id: "costs", es: "Costos", en: "Costs",
      desc: { es: "reducir costos, gastos, márgenes, ahorro y rentabilidad", en: "cost reduction, expenses, margins, savings and profitability" },
      kw: { es: ["costo", "gasto", "ahorro", "margen", "rentabilidad", "presupuesto"], en: ["cost", "expense", "savings", "margin", "profitab", "budget"] } },
    { id: "scrap", es: "Mermas", en: "Scrap & waste",
      desc: { es: "mermas, desperdicio, scrap, pérdidas de material", en: "scrap, waste, rework and material losses" },
      kw: { es: ["merma", "desperdicio", "scrap", "retrabajo"], en: ["scrap", "waste", "rework", "yield loss"] } },
    { id: "quality", es: "Calidad", en: "Quality",
      desc: { es: "calidad, defectos, no conformidades, auditorías, certificaciones ISO", en: "quality, defects, nonconformities, audits, ISO certification" },
      kw: { es: ["calidad", "defecto", "no conformidad", "auditoria", "iso ", "certificac", "inspeccion"], en: ["quality", "defect", "nonconform", "non-conform", "audit", "iso ", "certif", "inspection"] } },
    { id: "sales", es: "Ventas", en: "Sales",
      desc: { es: "ventas, clientes, cotizaciones, crecimiento comercial", en: "sales, customers, quotes, commercial growth" },
      kw: { es: ["ventas", "vender", "comercial", "cotizac", "clientes nuevos", "pipeline"], en: ["sales ", "sell ", "selling", "commercial", "new customers", "pipeline", "revenue"] } },
    { id: "marketing", es: "Marketing", en: "Marketing",
      desc: { es: "marketing, marca, campañas, redes sociales, posicionamiento", en: "marketing, brand, campaigns, social media, positioning" },
      kw: { es: ["marketing", "marca", "campana", "redes sociales", "posicionamiento", "publicidad"], en: ["marketing", "brand", "campaign", "social media", "positioning", "advertis"] } },
    { id: "talent", es: "Talento", en: "Talent",
      desc: { es: "personas, contratación, equipo, rotación, capacitación, recursos humanos", en: "people, hiring, team, turnover, training, human resources" },
      kw: { es: ["contratar", "contratac", "personal", "rotacion", "capacitac", "recursos humanos", "rrhh", "talento", "sindicato", "equipo de trabajo"], en: ["hiring", "hire ", "staff", "turnover", "training", "human resources", "hr ", "talent", "union ", "headcount"] } },
    { id: "technology", es: "Tecnología", en: "Technology",
      desc: { es: "tecnología, software, ERP, digitalización, automatización, datos e inteligencia artificial", en: "technology, software, ERP, digitalization, automation, data and artificial intelligence" },
      kw: { es: ["software", "erp", "sistema", "digital", "tecnolog", "automatiz", "inteligencia artificial", "ia ", "analisis de datos", "crm ", "aplicacion"], en: ["software", "erp", "system", "digital", "technolog", "automat", "artificial intelligence", "ai ", "machine learning", "data analytics", "crm ", "app "] } },
    { id: "logistics", es: "Logística", en: "Logistics",
      desc: { es: "logística, inventarios, almacenes, proveedores y cadena de suministro", en: "logistics, inventory, warehouses, suppliers and supply chain" },
      kw: { es: ["logistic", "inventario", "almacen", "cadena de suministro", "proveedor", "compras", "distribucion"], en: ["logistic", "inventory", "warehouse", "supply chain", "supplier", "vendor", "procurement", "purchasing", "distribution"] } },
    { id: "strategy", es: "Estrategia", en: "Strategy",
      desc: { es: "estrategia, planeación, objetivos, reestructura, dirección del negocio", en: "strategy, planning, goals, restructuring, business direction" },
      kw: { es: ["estrategia", "estrategic", "planeacion", "plan de negocio", "objetivos", "reestructur", "vision"], en: ["strateg", "planning", "business plan", "goals", "objectives", "restructur", "vision"] } },
    { id: "pricing", es: "Precios", en: "Pricing",
      desc: { es: "precios, tarifas, honorarios, cobro", en: "prices, rates, fees, billing" },
      kw: { es: ["precio", "tarifa", "honorario", "cobrar", "descuento"], en: ["price", "pricing", "fee ", "fees", "discount", "billing"] } },
    { id: "legal", es: "Legal y fiscal", en: "Legal & tax",
      desc: { es: "contratos, temas legales, impuestos y fiscalidad", en: "contracts, legal matters, taxes" },
      kw: { es: ["contrato", "legal", "impuesto", "fiscal", "hacienda", "abogado", "juridic"], en: ["contract", "legal", "tax ", "taxes", "lawyer", "attorney", "compliance"] } },
    { id: "export", es: "Exportación", en: "Export",
      desc: { es: "exportación, importación, comercio internacional y aduanas", en: "export, import, international trade and customs" },
      kw: { es: ["export", "import", "aduana", "internacional"], en: ["export", "import", "customs", "international"] } },
    { id: "proposal", es: "Propuesta", en: "Proposal",
      desc: { es: "propuesta de servicios, diagnóstico, caso de éxito, cotización de consultoría", en: "service proposal, assessment, case study, consulting quote" },
      kw: { es: ["propuesta", "diagnostico", "caso de exito", "casos de exito", "presentacion de servicios"], en: ["proposal", "assessment", "diagnostic", "case study", "case studies", "pitch deck", "quote", "quotation"] } },
    { id: "sustainability", es: "Sostenibilidad", en: "Sustainability",
      desc: { es: "sostenibilidad, medio ambiente, energía, emisiones", en: "sustainability, environment, energy, emissions" },
      kw: { es: ["sostenib", "sustentab", "ambiental", "energia", "emisiones", "residuos"], en: ["sustainab", "environment", "energy", "emission", "carbon", "esg "] } },
  ];
  // Las palabras clave de ambos idiomas se revisan siempre: ayuda con notas mixtas ("call con Juan sobre el ERP").
  function topicsByRules(n) {
    const padded = " " + n.replace(/[^a-z0-9ñ]+/g, " ") + " ";
    return TOPICS.filter((t) => [...t.kw.es, ...t.kw.en].some((k) => padded.includes(" " + k))).map((t) => t.id);
  }


  /* ---------- verbos a infinitivo (primera palabra de un compromiso) ---------- */
  const ES_VERB_LIST = ("enviar mandar pasar preparar compartir llamar escribir confirmar revisar agendar cotizar presentar contactar programar buscar conseguir proponer entregar organizar investigar ver checar hacer dar avisar mostrar ayudar visitar actualizar terminar documentar analizar evaluar definir disenar responder resolver leer decidir incluir cerrar coordinar validar aprobar firmar pagar facturar cobrar invitar reservar comprar conectar recomendar sugerir traer llevar subir corregir marcar agregar ajustar calcular cambiar " +
    "compartir consultar entrevistar explicar gestionar hablar imprimir instalar integrar medir negociar notificar ofrecer planear planificar probar publicar reunir solicitar tramitar verificar").split(" ");
  const ES_IRREG = { hacer: "hago haga hiciera hare haria haremos", ver: "veo vea viera", dar: "doy de diera", decir: "digo diga dijera dire diria", poner: "pongo ponga pusiera pondre pondria", traer: "traigo traiga trajera", tener: "tengo tenga tuviera tendre tendria", conseguir: "consigo consiga consiguiera", corregir: "corrijo corrija corrigiera", sugerir: "sugiero sugiera sugiriera", resolver: "resuelvo resuelva", incluir: "incluyo incluya incluyera", leer: "leyera", probar: "pruebo pruebe", cerrar: "cierro", medir: "mido mida midiera", ofrecer: "ofrezco ofrezca", conectar: "conecto" };
  const NOUNISH = new Set(["pagar", "cambiar", "cobrar", "facturar", "cerrar", "planear", "ajustar", "reunir", "probar"]);
  const ES_FORMS = (() => {
    const m = {};
    const add = (f, inf) => { if (f && !m[f]) m[f] = inf; };
    for (const inf of ES_VERB_LIST) {
      const stem = inf.slice(0, -2), end = inf.slice(-2);
      [inf + "e", inf + "emos", inf + "ia", inf + "iamos"].forEach((f) => add(f, inf));
      if (!NOUNISH.has(inf)) add(stem + "o", inf); // "pago", "cambio", "cobro" suelen ser sustantivos
      if (end === "ar") {
        const subj = stem.endsWith("z") ? stem.slice(0, -1) + "c" : stem.endsWith("c") ? stem.slice(0, -1) + "qu" : stem.endsWith("g") ? stem + "u" : stem;
        [subj + "e", subj + "emos", stem + "ara", stem + "aramos"].forEach((f) => add(f, inf));
      } else {
        [stem + "a", stem + "amos", stem + "iera", stem + "ieramos"].forEach((f) => add(f, inf));
      }
    }
    for (const [inf, forms] of Object.entries(ES_IRREG)) forms.split(" ").forEach((f) => { m[f] = inf; });
    return m;
  })();
  const EN_VERB_LIST = "send email call schedule book prepare review quote share present confirm write contact follow draft deliver set organize research introduce check finish update get provide make look find arrange visit meet pay sign close fix build run prepare submit plan test compile gather circle reach connect".split(" ");
  const EN_FORMS = (() => {
    const m = {};
    for (const v of EN_VERB_LIST) {
      const ing = v.endsWith("e") && !v.endsWith("ee") ? v.slice(0, -1) + "ing" : /^(get|set|run|plan|put)$/.test(v) ? v + v.slice(-1) + "ing" : v + "ing";
      m[ing] = v; m[v + "s"] = v;
    }
    m.writing = "write"; m.making = "make"; m.taking = "take";
    return m;
  })();
  /** Pasa a infinitivo la primera palabra: "enviaré el deck" → "enviar el deck", "sending the deck" → "send the deck". */
  function firstToInfinitive(text, lang) {
    const m = /^([A-Za-zÁÉÍÓÚÑáéíóúñ]+)(.*)$/s.exec(text);
    if (!m) return text;
    const w = norm(m[1]);
    const inf = (lang === "en" ? EN_FORMS : ES_FORMS)[w];
    return inf ? inf + m[2] : text;
  }

  /* =====================================================================
   * 4. PERFILES DE IDIOMA
   * ===================================================================== */
  const ES = {
    code: "es",
    parseDate: parseDateEs,
    types: [
      ["meal", /\b(comida|comimos|almuerzo|almorzamos|desayuno|desayunamos|cena|cenamos|cafe con|un cafe|tomamos cafe)\b/],
      ["call", /\b(llamada|llame|me llamo|hablamos por telefono|telefono|videollamada|zoom|teams)\b/],
      ["visit", /\b(visita|visite|fui a (su|la) (planta|oficina|fabrica))\b/],
      ["meeting", /\b(reunion|junta|nos reunimos|nos vimos|sesion|taller|presentacion)\b/],
      ["email", /\b(correo|email|e-mail|mail)\b/],
      ["message", /\b(whatsapp|mensaje|sms|chat|telegram)\b/],
    ],
    sentiment: [
      ["negative", /\b(molest[oa]|enojad[oa]|insatisfech[oa]|furios[oa]|decepcionad[oa]|queja|se quejo|cancelar|cancelo|mal servicio)\b/],
      ["worried", /\b(preocupad[oa]|preocupacion|le preocupa|inquiet[oa]|estresad[oa]|nervios[oa]|urgente|presion|riesgo|problema)\b/],
      ["positive", /\b(content[oa]|feliz|satisfech[oa]|entusiasmad[oa]|interesad[oa]|le encanto|le gusto|excelente|muy bien|aprobo|firmo|cerramos|agradecid[oa])\b/],
    ],
    pref: /\b(prefiere|le gusta|le gustan|le encanta|le encantan|no le gusta|odia|es fan|aficionad[oa]|su (?:hij[oa]s?|esposa|esposo|pareja|mujer|marido|familia|mama|papa|madre|padre|perro|gato|nieto|nieta)|cumple|cumpleanos|aniversario|juega|vegetarian[oa]|vegan[oa]|alergic[oa]|no toma|no bebe|toma cafe|vacaciones|hobby|pasatiempo|maraton|golf|futbol|beisbol|tenis|equipo favorito|se va a casar|tuvo un bebe|embarazad[oa]|se mudo|habla (?:ingles|frances|aleman))\b/,
    prefSplit: /;|,\s+y\s+|\s+y\s+(?=su\s|le\s|prefiere|es\s)|\.\s*/,
    // Compromisos: cualquier forma de "comprometerse" (prometí, me comprometí, quedamos en, me pidió que, acordamos…).
    // Tupla: [regex, grupoVerbo, esPetición]. grupoVerbo = el verbo conjugado del grupo 1 se pasa a infinitivo.
    // esPetición = si lo que sigue es un sustantivo ("me pidió la propuesta"), se antepone "Enviar".
    mine: [
      [/\b(?:le |les )?prometi(?: que)?\s+/g],
      [/\b(?:yo )?me comprometi(?: con [a-z]+(?: [a-z]+)?)?(?: a| en)?(?: que)?\s+/g],
      [/\b(?:nos comprometimos|quedamos comprometidos)(?: a| en)?(?: que)?\s+/g],
      [/\b(?:mi |el |nuestro |un )?compromiso(?: es| fue| quedo)?(?: de| en| con [a-z]+ de)?(?::|\s+es)?\s+(?=[a-z])/g],
      [/\bquede (?:con [a-z]+(?: [a-z]+)? )?(?:en|de)(?: que)?\s+/g],
      [/\bquedamos (?:en|de)(?: que)?\s+/g],
      [/\b(?:acordamos|acorde|convinimos|pactamos|nos pusimos de acuerdo en|nos comprometimos)(?: que| en| a)?\s+/g],
      [/\b(?:me |nos )?(?:pidio|pidieron|solicito|solicitaron|encargo|encargaron|encomendo)(?: que)?\s+/g, false, true],
      [/\b(?:yo )?me (?:encargo|hago cargo|ocupo|toca encargarme) de\s+/g],
      [/\bme (?:ofreci|propuse) a\s+/g],
      [/\b(?:le |les )?(?:asegure|garantice|confirme|dije) que\s+(?=(?:yo )?(?:le |les |lo |la )?[a-z]+(?:ia|re)\b)/g],
      [/\btengo (?:que|pendiente)\s+/g],
      [/\b(?:me falta|necesito)\s+/g],
      [/\b(?:le |les )?debo\s+/g],
      [/\b(?:le |les )?voy a\s+/g],
      [/\bme toca\s+/g],
      [/\bhay que\s+/g],
      [/\b(?:pendiente(?: de)?|tarea|to-?do|accion|siguiente paso):?\s+/g],
      [/\b(?:le |les )(envio|mando|paso|preparo|comparto|llamo|escribo|confirmo|reviso|agendo|cotizo|aviso|consigo|busco|presento|marco|hago)\s+/g, true],
      // futuro/condicional de 1.ª persona: "le enviaré", "prepararé", "le mandaría"
      [/\b(?:le |les |lo |la |se lo |se la )?([a-z]+(?:are|ere|ire|aremos|eremos|iremos|aria|eria|iria))\s+/g, "form"],
    ],
    theirs: [
      [/\b(?:el |ella |[a-z]+ )?quedo (?:en|de)(?: que)?\s+/g],
      [/\b(?:ellos |ellas )?quedaron (?:en|de)(?: que)?\s+/g],
      [/\bse comprometio(?: conmigo| con nosotros)?(?: a| en)?(?: que)?\s+/g],
      [/\b(?:me |nos )?prometio(?: que)?\s+/g],
      [/\b(?:me |nos )(?:va|van) a\s+/g],
      [/\b(?:me |nos )(envia|manda|pasa|comparte|confirma|avisa|dara|hara llegar|llama|escribe|revisa|enviara|mandara|pasara|compartira|confirmara|avisara|llamara|escribira|revisara)\s+/g, true],
    ],
    verbs: { envio: "enviar", mando: "mandar", paso: "pasar", preparo: "preparar", comparto: "compartir", llamo: "llamar", escribo: "escribir", confirmo: "confirmar", reviso: "revisar", agendo: "agendar", cotizo: "cotizar", aviso: "avisar", consigo: "conseguir", busco: "buscar", presento: "presentar", marco: "marcar", hago: "hacer",
      envia: "enviar", manda: "mandar", pasa: "pasar", comparte: "compartir", confirma: "confirmar", avisa: "avisar", dara: "dar", "hara llegar": "hacer llegar", llama: "llamar", escribe: "escribir", revisa: "revisar",
      enviara: "enviar", mandara: "mandar", pasara: "pasar", compartira: "compartir", confirmara: "confirmar", avisara: "avisar", llamara: "llamar", escribira: "escribir", revisara: "revisar" },
    requestVerb: "Enviar",
    articles: /^(?:el|la|los|las|un|una|unos|unas|su|sus|mi|mis|nuestro|nuestra|dicho|dicha|este|esta|esos|esas)\s/i,
    actionVerbs: "enviar|mandar|llamar|agendar|preparar|revisar|cotizar|compartir|presentar|confirmar|escribir|contactar|programar|dar seguimiento|hacer seguimiento|buscar|conseguir|proponer|pasar|entregar|organizar|investigar",
    promiseAny: /\b(prometi|quede en|quede de|quedamos en|quedamos de|tengo que|me comprometi|nos comprometimos|compromiso|acordamos|me pidio|me encargo|le envio|le mando|pendiente|quedo en|se comprometio|me envia|me pasa|me manda|me va a)\b/,
    clauseCut: /;|\.\s|,\s+(?:pero|aunque|mientras)\b|\s+y\s+(?:el|ella|me|nos|yo|luego)\s/,
    leadStrip: /^(?:(?:que|le|les|a|yo|me|nos|se lo|se la)\s+)+/i,
    tailStrip: /(?:\s+(?:el|la|para|antes del?|a más tardar|y|de))+\s*$/i,
    objectStrip: (t) => t.replace(/^([A-Za-zÁÉÍÓÚáéíóúñ]+(?:ar|er|ir))(?:le|les|lo|la|los|las|me|nos|te|se)\b/, "$1"),
    nameContext: ["con", "a", "para", "le", "visité a", "llamé a", "vi a", "hablé con", "escribí a"],
    honor: "(?:(?:[Ee]l|[Ll]a|[Dd]on|[Dd]oña|[Dd]ra?|[Ii]ng|[Ll]ic|[Ss]ra?|[Mm]tr[oa]|[Aa]rq|[Cc]\\.?[Pp])\\.?\\s+){0,2}",
    notNames: "lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre hoy manana ayer grupo corporativo industrias el la los las su sus mi mis le les me nos yo usted comida llamada reunion junta cafe visita correo email whatsapp cfo ceo coo cto rrhh erp crm ia ok pendiente prometi quede tengo",
    companyAfter: "(?:de|del|en)",
    companyCue: "\\b((?:Grupo|Corporativo|Corporación|Industrias|Textiles|Servicios|Consultores|Constructora|Inmobiliaria|Laboratorios|Farmacéutica|Transportes|Logística|Alimentos|Distribuidora|Comercializadora|Hotel|Hoteles|Banco|Clínica|Hospital|Universidad|Colegio|Despacho|Agencia|Fundación)\\s+" + "[" + UP + "0-9][\\w" + WORD + "&.\\-]*(?:\\s+(?:de\\s+|del\\s+|y\\s+|&\\s+)?[" + UP + "0-9][\\w" + WORD + "&.\\-]*){0,3})",
    companyGeneric: ["grupo", "corporativo", "industrias", "servicios"],
    role: "\\bsu\\s+(cfo|ceo|coo|cto|director(?:a)?(?: [a-záéíóú]+)?|gerente(?: [a-záéíóú]+)?|soci[oa]|jef[ea]|asistente|contador(?:a)?|abogad[oa]|herman[oa]|esposa|esposo)",
    rolePrefix: "su\\s+\\w+(?:\\s+\\w+)?",
    abbr: /\b(Ing|Lic|Dra?|Sra?|Srta|Mtr[oa]|Arq|Av|Ud|Uds|etc|núm|No)\./g,
    unassigned: "Sin asignar",
    contactOf: (c) => "Contacto de " + c,
  };

  const EN = {
    code: "en",
    parseDate: parseDateEn,
    types: [
      ["meal", /\b(lunch|dinner|breakfast|coffee|drinks|brunch)\b/],
      ["call", /\b(call|called|phone|phoned|video call|zoom|teams call|dialed in)\b/],
      ["visit", /\b(visit|visited|site visit|plant tour|toured)\b/],
      ["meeting", /\b(meeting|met|meet up|session|workshop|presentation|sync)\b/],
      ["email", /\b(email|e-mail|emailed|mail)\b/],
      ["message", /\b(whatsapp|text|texted|message|messaged|sms|slack|chat)\b/],
    ],
    sentiment: [
      ["negative", /\b(upset|angry|annoyed|frustrated|unhappy|dissatisfied|disappointed|furious|complained|complaint|cancel(?:l?ed)?|bad service)\b/],
      ["worried", /\b(worried|concerned|concerns?|anxious|stressed|nervous|urgent|pressure|risk|problem|issue)\b/],
      ["positive", /\b(happy|pleased|satisfied|excited|interested|loved|liked|great|excellent|approved|signed|closed the deal|thankful|grateful|thrilled)\b/],
    ],
    pref: /\b(prefers?|likes|loves|doesn't like|does not like|hates|is a (?:big )?fan|(?:his|her|their) (?:son|daughter|sons|daughters|kids|children|wife|husband|partner|family|mom|dad|mother|father|dog|cat|grandson|granddaughter)|birthday|anniversary|plays|vegetarian|vegan|allergic|doesn't drink|does not drink|drinks coffee|vacation|holiday|hobby|marathon|golf|soccer|football|baseball|tennis|favorite team|getting married|had a baby|pregnant|moved to|speaks (?:spanish|french|german))\b/,
    prefSplit: /;|,\s+and\s+|\s+and\s+(?=his\s|her\s|their\s|he\s|she\s|prefers|loves|likes)|\.\s*/,
    mine: [
      [/\bi (?:have |had |just )?promised(?: (?:him|her|them|you))?(?: (?:to|that i'd|that i would|i'd|i would))?\s+/g],
      [/\bi(?:'ve| have| had)? committed(?: myself)?(?: to)?\s+/g],
      [/\bi(?:'m| am) committed to\s+/g],
      [/\bi (?:made|have) a commitment to\s+/g],
      [/\b(?:my |our |the |a )?commitment(?: is| was)?(?: to)?(?::|\s+is)?\s+(?=[a-z])/g],
      [/\b(?:i|we) agreed(?: to| that i'd| that i would| that we'd| on| that)?\s+/g],
      [/\bwe (?:settled on|decided(?: to| that i'd| that i would)?)\s+/g],
      [/\bi (?:said|told (?:him|her|them)) (?:that )?i(?:'d| would)\s+/g],
      [/\bi (?:assured|guaranteed)(?: (?:him|her|them))?(?: that)?(?: i(?:'d| would))?\s+/g],
      [/\bi (?:pledged|undertook|offered|volunteered) to\s+/g],
      [/\bi(?:'m| am) (?:on the hook|responsible) for\s+/g, false, true],
      [/\bi (?:need|have|got|still need|still have) to\s+/g],
      [/\bi (?:must|should)\s+/g],
      [/\bi(?:'ll| will| am going to|'m going to| shall)(?: make sure to| be sure to)?\s+/g],
      [/\bwe(?:'ll| will| need to| have to| are going to|'re going to)\s+/g],
      [/\bi (owe) (?:him|her|them)\s+/g, true],
      [/\b(?:he|she|they|[a-z]+) (?:asked|requested|wants|wanted|needs|needed|expects) (?:me|us) to\s+/g],
      [/\b(?:he|she|they|[a-z]+) asked (?:me |us )?for\s+/g, false, true],
      [/\b(?:he|she|they) requested(?: that i)?\s+/g, false, true],
      [/\b(?:to-?do|pending|follow[- ]up|action item|next steps?|commitment|task):\s*/g],
      [/^\s*(?:need|have) to\s+/g],
    ],
    theirs: [
      [/\b(?:he|she|they)(?:'ll| will| is going to|'s going to| are going to| promised to| agreed to| committed to| said (?:he|she|they)(?:'d| would))\s+/g],
      [/\b(?:he|she|they) (sends|shares|emails) me\s+/g, true],
    ],
    verbs: { owe: "send", sends: "send", shares: "share", emails: "email" },
    actionVerbs: "send|email|call|schedule|book|prepare|review|quote|share|present|confirm|write|contact|follow up|draft|deliver|set up|organize|research|introduce|check|finish|update",
    promiseAny: /\b(i promised|i'll|i will|i need to|i have to|i must|i agreed|we agreed|i committed|commitment|asked me|i owe|he'll|she'll|they'll|he will|she will|they will|follow up)\b/,
    requestVerb: "Send",
    articles: /^(?:the|a|an|his|her|their|our|my|some|this|that|these|those)\s/i,
    clauseCut: /;|\.\s|,\s+(?:but|although|while)\b|\s+and\s+(?:he|she|they|i|we|then)\s/,
    leadStrip: /^(?:to|that)\s+/i,
    tailStrip: /(?:\s+(?:by|on|before|until|the|and|this|next|for|no later than))+\s*$/i,
    objectStrip: (t) => t.replace(/^(send|email|give|show|mail|text|forward|pass|get) (?:him|her|them) (?=\w)/i, "$1 "),
    nameContext: ["with", "to", "for", "called", "met", "emailed", "texted", "visited", "saw", "from"],
    honor: "(?:(?:Mr|Mrs|Ms|Miss|Dr|Prof|Eng)\\.?\\s+)?",
    notNames: "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december today tomorrow yesterday i he she they we you the his her their my our lunch dinner call meeting coffee email whatsapp cfo ceo coo cto hr erp crm ai ok next this",
    companyAfter: "(?:from|at|of)",
    companyCue: "\\b((?:[A-Z][\\w&.\\-]*\\s+){1,3}(?:Inc|LLC|Ltd|Corp|Corporation|Group|Industries|Holdings|Technologies|Labs|Systems|Partners|Co)\\b\\.?|(?:Grupo|Group|Bank of)\\s+[A-Z][\\w&.\\-]*(?:\\s+[A-Z][\\w&.\\-]*){0,2})",
    companyGeneric: ["group", "inc", "llc", "ltd", "corp", "industries", "holdings"],
    role: "\\b(?:his|her|their)\\s+(cfo|ceo|coo|cto|director(?: of [a-z]+)?|(?:plant |general |sales |operations |finance )?manager|partner|boss|assistant|accountant|lawyer|brother|sister|wife|husband)",
    rolePrefix: "(?:his|her|their)\\s+\\w+(?:\\s+\\w+)?",
    abbr: /\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|Co|etc|vs|St)\./g,
    unassigned: "Unassigned",
    contactOf: (c) => "Contact at " + c,
  };
  const PROFILES = { es: ES, en: EN };

  /* =====================================================================
   * 5. EXTRACCIÓN (genérica, parametrizada por perfil)
   * ===================================================================== */
  function interactionType(n, L) {
    let best = null;
    for (const [type, re] of L.types) {
      const m = re.exec(n);
      if (m && (!best || m.index < best.index)) best = { type, index: m.index };
    }
    return best ? best.type : "other";
  }
  const sentimentOf = (n, L) => (L.sentiment.find(([, re]) => re.test(n)) || [null])[0];

  function preferencesOf(sentences, L) {
    const out = [];
    for (const s of sentences)
      for (const clause of s.split(L.prefSplit)) {
        const c = clause.trim().replace(/[.;,]+$/, "");
        if (c && L.pref.test(norm(c)) && !L.promiseAny.test(norm(c))) out.push(cap(c));
      }
    return out;
  }

  function cleanAction(raw, dateSpan, L) {
    let s = raw;
    if (dateSpan) s = s.slice(0, dateSpan.start) + " " + s.slice(dateSpan.end);
    s = s.replace(/\s+/g, " ").trim().replace(L.leadStrip, "").replace(/[\s,.;:]+$/g, "").replace(L.tailStrip, "").replace(/[\s,.;:]+$/g, "").trim();
    if (s.length > 110) s = s.slice(0, 110).replace(/\s+\S*$/, "") + "…";
    return cap(s);
  }

  function extractPromises(sentences, now, L) {
    const out = [];
    for (const sentence of sentences) {
      const s = nfc(sentence);
      const n = norm(s);
      const hits = [];
      const collect = (list, owner) => {
        for (const [re, verbGroup, request] of list) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(n))) {
            let verb = null;
            if (verbGroup === "form") {
              // futuro/condicional genérico: solo cuenta si es un verbo conocido
              verb = ES_FORMS[m[1]] || null;
              if (!verb) continue;
            } else if (verbGroup && m[1]) verb = L.verbs[m[1]] || null;
            hits.push({ start: m.index, end: m.index + m[0].length, owner, verb, request: !!request });
            if (!re.global) break;
          }
        }
      };
      collect(L.theirs, "client");
      collect(L.mine, "me");
      // Frase que empieza con un verbo de acción ("Enviar reporte hoy"), salvo "Call with…" / "Llamar con…", que describen la reunión.
      const lead = new RegExp("^\\s*(" + L.actionVerbs + ")\\b(?!\\s+(?:with|con)\\b)").exec(n);
      if (lead && !hits.length) hits.push({ start: lead.index, end: lead.index, owner: "me", verb: null });
      if (!hits.length) continue;

      hits.sort((a, b) => a.start - b.start || b.end - a.end);
      const uniq = [];
      for (const h of hits) if (!uniq.length || h.start >= uniq[uniq.length - 1].end) uniq.push(h);

      uniq.forEach((h, i) => {
        const stop = i + 1 < uniq.length ? uniq[i + 1].start : s.length;
        let seg = s.slice(h.end, stop);
        const cut = norm(seg).search(L.clauseCut);
        if (cut > 0) seg = seg.slice(0, cut);
        let date = L.parseDate(seg, now);
        let text = cleanAction(seg, date, L);
        if (!date) {
          // Fecha antes del disparador ("En 3 días le mando…"), pero solo dentro de la misma cláusula.
          const prevEnd = i > 0 ? uniq[i - 1].end : 0;
          let pre = s.slice(prevEnd, h.start);
          const parts = pre.split(/[;,.:]|\s(?:y|e|pero|and|but|then|luego)\s/i);
          pre = parts[parts.length - 1];
          date = L.parseDate(pre, now);
        }
        text = cap(firstToInfinitive(text, L.code));
        text = L.objectStrip(text);
        if (h.verb) text = cap(h.verb + " " + text.charAt(0).toLowerCase() + text.slice(1));
        else if (h.request && L.articles.test(text)) text = L.requestVerb + " " + text.charAt(0).toLowerCase() + text.slice(1);
        if (text.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "").length < 4) return;
        out.push({ text, due: date ? date.due : null, owner: h.owner });
      });
    }
    const seen = new Set();
    return out.filter((p) => { const k = norm(p.text); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  const NAME = "[" + UP + "][" + WORD + "']+(?:\\s+[" + UP + "][" + WORD + "']+){0,2}";
  const COMPANY_SEQ = "[" + UP + "0-9][\\w" + WORD + "&.\\-]*(?:\\s+(?:de\\s+|del\\s+|y\\s+|&\\s+|and\\s+|of\\s+)?[" + UP + "0-9][\\w" + WORD + "&.\\-]*){0,3}";
  const cleanName = (s) => nfc(s).trim().replace(/\s+/g, " ");
  const notNamesOf = (L) => L._notNames || (L._notNames = new Set(L.notNames.split(" ")));
  const isNameOk = (s, L) => s && s.length >= 3 && !notNamesOf(ES).has(norm(s).split(" ")[0]) && !notNamesOf(EN).has(norm(s).split(" ")[0]);

  function detectPeople(text, entities, L) {
    const people = [];
    const add = (p) => { if (p && !people.some((x) => norm(x) === norm(p))) people.push(p); };
    const re = new RegExp(L.role + "\\s*,?\\s*(" + NAME + ")?", "gi");
    let m;
    while ((m = re.exec(text))) {
      const role = m[1].length <= 3 ? m[1].toUpperCase() : m[1];
      const name = m[2] && isNameOk(m[2], L) && /^[A-ZÁÉÍÓÚÑ]/.test(m[2]) ? cleanName(m[2]) : null;
      add(name ? `${name} (${role})` : cap(role));
    }
    (entities || []).filter((e) => e.entity_group === "PER" && e.score >= 0.6).forEach((e) => add(cleanName(e.word)));
    return people;
  }

  function scoreClient(c, n, words, L) {
    let score = 0;
    const tokens = norm(c.name).split(/\s+/).filter((w) => w.length >= 3);
    if (!tokens.length) return 0;
    const has = (w) => new RegExp("(^|[^a-z0-9])" + reEsc(w) + "([^a-z0-9]|$)").test(n);
    if (tokens.length > 1 && has(tokens.join(" "))) score += 5;
    if (has(tokens[0])) score += 2;
    if (tokens.slice(1).some(has)) score += 2;
    const generic = [...ES.companyGeneric, ...EN.companyGeneric];
    const comp = norm(c.company || "").split(/\s+/).filter((w) => w.length >= 4 && !generic.includes(w));
    if (comp.length && comp.some(has)) score += 2;
    if (!score && tokens.some((t) => t.length >= 4 && words.some((w) => w.length >= 4 && levenshtein(w, t) === 1))) score += 2.5;
    return score;
  }

  function detectClient(text, clients, entities, hintId, L) {
    const s = nfc(text);
    const n = norm(s);
    const words = n.split(/[^a-z0-9]+/).filter(Boolean);
    const ents = entities || [];

    if (hintId && clients.some((c) => c.id === hintId)) return { matchId: hintId, name: "", company: "", confidence: "high", reason: "hint" };

    const scored = clients.map((c) => ({ c, score: scoreClient(c, n, words, L) })).filter((x) => x.score >= 2);
    scored.sort((a, b) => b.score - a.score || String(b.c.lastAt || "").localeCompare(String(a.c.lastAt || "")));
    if (scored.length) {
      const best = scored[0];
      const tie = scored.length > 1 && scored[1].score === best.score;
      const typo = best.score === 2.5;
      return { matchId: best.c.id, name: best.c.name, company: best.c.company || "", confidence: typo ? "low" : tie ? "medium" : best.score >= 4 ? "high" : "medium", reason: typo ? "typo" : tie ? "tie" : "match" };
    }

    let name = null;
    // Palabras de contexto sin distinguir mayúsculas en su primera letra ("Met Tom", "met Tom"); el nombre sí debe ir en mayúscula.
    const ci = (w) => "[" + w[0].toUpperCase() + w[0] + "]" + reEsc(w.slice(1));
    const ctx = new RegExp("(?:^|\\b)(?:" + L.nameContext.map(ci).join("|") + ")\\s+" + L.honor + "(" + NAME + ")", "g");
    let m;
    while ((m = ctx.exec(s))) { if (isNameOk(m[1], L)) { name = cleanName(m[1]); break; } }
    if (!name) { const lead = new RegExp("^\\s*" + L.honor + "(" + NAME + ")\\s*[:\\-–—,]").exec(s); if (lead && isNameOk(lead[1], L)) name = cleanName(lead[1]); }
    const per = ents.filter((e) => e.entity_group === "PER" && e.score >= 0.6).map((e) => cleanName(e.word));
    if (per.length) {
      if (!name) name = per[0];
      else { const longer = per.find((p) => norm(p).startsWith(norm(name)) && p.length > name.length); if (longer) name = longer; }
    }
    if (name && new RegExp(L.rolePrefix + "\\s*,?\\s*" + reEsc(name), "i").test(s)) name = null; // es "su CFO, Marta", no el cliente

    let company = "";
    if (name) {
      const e = reEsc(name);
      const paren = new RegExp(e + "\\s*\\(([^)]{2,60})\\)").exec(s);
      const after = new RegExp(e + "\\s+" + L.companyAfter + "\\s+(" + COMPANY_SEQ + ")").exec(s);
      if (paren) company = paren[1].trim();
      else if (after && isNameOk(after[1], L)) company = after[1].trim();
    }
    if (!company) { const cue = new RegExp(L.companyCue).exec(s); if (cue) company = cue[1].trim(); }
    if (!company) { const org = ents.find((x) => x.entity_group === "ORG" && x.score >= 0.6); if (org) company = cleanName(org.word); }
    company = company.split(/[.;,:]\s|\s\(/)[0].replace(/[,;:]+$/, "").replace(/\.$/, (d) => (/\b(Inc|Ltd|Corp|Co)\.$/.test(company) ? d : "")).trim();

    if (company) {
      const byCo = clients.find((c) => c.company && norm(c.company) === norm(company));
      if (byCo && !name) return { matchId: byCo.id, name: byCo.name, company: byCo.company, confidence: "medium", reason: "company" };
    }
    return { matchId: null, name: name || (company ? L.contactOf(company) : L.unassigned), company, confidence: name ? "medium" : "low", reason: name ? "new" : "noname" };
  }

  function splitSentences(text, L) {
    const abbrs = [ES.abbr, EN.abbr];
    let t = nfc(text);
    for (const a of abbrs) t = t.replace(a, "$1․");
    return t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/․/g, ".").trim()).filter(Boolean);
  }

  function summarize(sentences) {
    if (!sentences.length) return "";
    let s = sentences[0].replace(/[.]+$/, "");
    if (s.length < 40 && sentences[1]) s += " · " + sentences[1].replace(/[.]+$/, "");
    return s.length > 120 ? s.slice(0, 118).replace(/\s+\S*$/, "") + "…" : s;
  }

  /* =====================================================================
   * 6. API
   * ===================================================================== */
  /**
   * opts: { clients, now, entities, hintId, lang: "es"|"en"|"auto", fallbackLang }
   */
  function analyze(text, opts) {
    opts = opts || {};
    const clean = nfc(text).trim();
    const detected = detectLanguage(clean, opts.fallbackLang);
    const lang = opts.lang === "es" || opts.lang === "en" ? opts.lang : detected.lang;
    const L = PROFILES[lang];
    const n = norm(clean);
    const sentences = splitSentences(clean, L);
    const now = opts.now || new Date();
    const client = detectClient(clean, opts.clients || [], opts.entities, opts.hintId || null, L);
    const people = detectPeople(clean, opts.entities, L).filter((p) => norm(p) !== norm(client.name) && !norm(client.name).startsWith(norm(p)));
    return {
      lang,
      langDetected: detected.lang,
      langConfidence: opts.lang === lang ? 1 : detected.confidence,
      langForced: opts.lang === "es" || opts.lang === "en",
      client,
      summary: summarize(sentences),
      interactionType: interactionType(n, L),
      topics: topicsByRules(n).slice(0, 4),
      people,
      promises: extractPromises(sentences, now, L),
      preferences: preferencesOf(sentences, L),
      sentiment: sentimentOf(n, L) || "neutral",
      sentences,
    };
  }

  /** ¿La frase contiene un compromiso? (para no confundirla con un detalle personal) */
  function isPromiseLike(sentence, lang) {
    const n = norm(sentence);
    const list = lang ? [PROFILES[lang]] : [ES, EN];
    return list.some((L) => {
      if (L.promiseAny.test(n)) return true;
      if (new RegExp("^\\s*(" + L.actionVerbs + ")\\b").test(n)) return true;
      return [...L.mine, ...L.theirs].some(([re]) => { re.lastIndex = 0; return re.test(n); });
    });
  }

  const parseDate = (text, now, lang) => (lang === "en" ? parseDateEn : parseDateEs)(text, now);
  const topicLabel = (id, lang) => { const t = TOPICS.find((x) => x.id === id || x.es === id || x.en === id); return t ? t[lang] || t.es : id; };
  // Datos guardados por versiones anteriores (en español) → códigos actuales
  const LEGACY = {
    type: { comida: "meal", llamada: "call", "reunión": "meeting", reunion: "meeting", visita: "visit", email: "email", mensaje: "message", otro: "other" },
    sentiment: { negativo: "negative", preocupado: "worried", positivo: "positive", neutral: "neutral" },
    owner: { yo: "me", cliente: "client" },
  };
  const topicId = (v) => { const t = TOPICS.find((x) => x.id === v || x.es === v || x.en === v); return t ? t.id : v; };

  const api = { analyze, detectLanguage, isPromiseLike, parseDate, norm, nfc, levenshtein, TOPICS, topicLabel, topicId, LEGACY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NLP = api;
})(typeof self !== "undefined" ? self : this);
