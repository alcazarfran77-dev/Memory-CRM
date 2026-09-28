/*
 * Memoria CRM · Fase 1 (versión offline, bilingüe).
 * Captura en 1 frase (español o inglés) → detección de idioma → extracción
 * local (reglas del idioma + modelos pre-entrenados) → IndexedDB → fichas,
 * promesas y búsqueda (texto + significado). Interfaz en ES/EN.
 */
(() => {
"use strict";
/* ---------- utilidades ---------- */
const $ = (id) => document.getElementById(id);
const t = I18N.t;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = NLP.norm;
const uid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysSince = (iso) => Math.floor((startOfDay(Date.now()) - startOfDay(iso)) / DAY);
const round4 = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);
const shortDate = (iso) => { const d = new Date(iso); return t("dateFmt", { d: d.getDate(), m: t("months").split(" ")[d.getMonth()] }); };
function ago(iso) {
  const n = daysSince(iso);
  if (n <= 0) return t("time.today");
  if (n === 1) return t("time.yesterday");
  if (n < 14) return t("time.days", { n });
  if (n < 60) return t("time.weeks", { n: Math.round(n / 7) });
  return t("time.months", { n: Math.round(n / 30) });
}
function dueLabel(due) {
  if (!due) return { text: t("due.none"), cls: "" };
  const n = Math.round((startOfDay(due + "T00:00:00") - startOfDay(Date.now())) / DAY);
  if (n === -1) return { text: t("due.overdue1"), cls: "over" };
  if (n < 0) return { text: t("due.overdue", { n: -n }), cls: "over" };
  if (n === 0) return { text: t("due.today"), cls: "today" };
  if (n === 1) return { text: t("due.tomorrow"), cls: "" };
  return { text: t("due.on", { date: shortDate(due + "T00:00:00") }), cls: "" };
}
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 2800);
}
// Códigos canónicos (acepta datos guardados por la versión anterior, en español)
const typeCode = (v) => NLP.LEGACY.type[v] || v || "other";
const moodCode = (v) => NLP.LEGACY.sentiment[v] || v || "neutral";
const ownerCode = (v) => NLP.LEGACY.owner[v] || v || "me";
const topicName = (v) => NLP.topicLabel(v, I18N.lang);
const typeName = (v) => t("type." + typeCode(v));
const langName = (l) => t("langname." + l);

/* ---------- ajustes ---------- */
const SETTINGS_KEY = "memoria-crm-ajustes";
const settings = { allowRemote: true, withNer: true, autoStart: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} };

/* ---------- datos ---------- */
const S = { clients: new Map(), notes: new Map(), promises: new Map() };
let storeMode = "…";

async function loadAll() {
  for (const c of Store.COLS) {
    const m = new Map();
    (await Store.all(c)).forEach((d) => m.set(d.id, d));
    S[c] = m;
  }
}
async function put(col, obj) {
  S[col].set(obj.id, obj);
  render();
  try { await Store.put(col, obj); } catch (e) { toast(t("toast.saveErr", { msg: e.message || e })); }
}
async function patch(col, id, data) {
  const cur = S[col].get(id); if (!cur) return;
  await put(col, { ...cur, ...data });
}
async function remove(col, id) {
  S[col].delete(id);
  render();
  try { await Store.del(col, id); } catch (e) { toast(t("toast.delErr", { msg: e.message || e })); }
}

const notesOf = (cid) => [...S.notes.values()].filter((n) => n.clientId === cid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const promisesOf = (cid) => [...S.promises.values()].filter((p) => p.clientId === cid);
function clientView(c) {
  const notes = notesOf(c.id);
  const last = notes[0];
  const topicCount = {};
  const prefs = [];
  const seenPref = new Set();
  notes.forEach((n) => {
    (n.topics || []).forEach((tp) => { const id = NLP.topicId(tp); if (id) topicCount[id] = (topicCount[id] || 0) + 1; });
    (n.preferences || []).forEach((p) => { const k = norm(p); if (p && !seenPref.has(k)) { seenPref.add(k); prefs.push(p); } });
  });
  const topics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]);
  const pending = promisesOf(c.id).filter((p) => !p.done);
  const lastAt = last ? last.createdAt : c.createdAt;
  const d = daysSince(lastAt);
  const level = !last ? "cold" : d <= 7 ? "hot" : d <= 21 ? "warm" : "cold";
  return { ...c, notes, last, topics, prefs, pending, lastAt, warmth: { cls: "w-" + level, label: t("warmth." + level) } };
}
function sortPromises(arr) {
  return arr.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1; if (b.due) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/* ---------- semántica con el modelo de embeddings (multilingüe) ---------- */
const THRESH = { topic: 0.42, pref: 0.55, sentiment: 0.5, search: 0.35 };
const PREF_PROTOS = [
  "Detalle personal o familiar de la persona: sus hijos, su pareja, sus aficiones o deportes",
  "Preferencia personal de la persona sobre horarios, comida o forma de comunicarse",
  "Personal or family detail about the person: their kids, partner, hobbies or sports",
  "The person's personal preference about schedules, food or how to communicate",
];
const SENT_PROTOS = [
  ["worried", "La persona está preocupada, inquieta o estresada por un problema del negocio"],
  ["worried", "The person is worried, anxious or stressed about a business problem"],
  ["positive", "La persona está contenta, satisfecha y entusiasmada con el trabajo"],
  ["positive", "The person is happy, satisfied and excited about the work"],
  ["negative", "La persona está molesta, enojada o insatisfecha con el servicio"],
  ["negative", "The person is upset, angry or unhappy with the service"],
];
const SEM = { ready: false, topics: null, prefs: null, sent: null };
let backfill = { running: false, done: 0, total: 0 };

async function prepareSemantics() {
  if (SEM.ready || !IA.state.embed) return;
  const topicTexts = NLP.TOPICS.flatMap((tp) => [tp.es + ": " + tp.desc.es, tp.en + ": " + tp.desc.en]);
  const v = await IA.embed([...topicTexts, ...PREF_PROTOS, ...SENT_PROTOS.map((x) => x[1])]);
  const k = topicTexts.length;
  SEM.topics = NLP.TOPICS.map((tp, i) => [v[2 * i], v[2 * i + 1]]);
  SEM.prefs = v.slice(k, k + PREF_PROTOS.length);
  SEM.sent = SENT_PROTOS.map((x, i) => ({ name: x[0], vec: v[k + PREF_PROTOS.length + i] }));
  SEM.ready = true;
}

/** Completa la extracción de reglas con el modelo. Devuelve el vector de la nota. */
async function enrich(ex, text) {
  await prepareSemantics();
  const sents = ex.sentences.length ? ex.sentences : [text];
  const vecs = await IA.embed([text, ...sents]);
  const noteVec = vecs[0];
  const scored = NLP.TOPICS.map((tp, i) => ({ id: tp.id, s: Math.max(...vecs.flatMap((v) => SEM.topics[i].map((tv) => IA.cosine(v, tv)))) }))
    .filter((x) => x.s >= THRESH.topic && !ex.topics.includes(x.id))
    .sort((a, b) => b.s - a.s);
  ex.semanticTopics = [];
  for (const x of scored) {
    if (ex.topics.length >= 4 || ex.semanticTopics.length >= 2) break; // el significado complementa, no sustituye
    ex.topics.push(x.id); ex.semanticTopics.push(x.id);
  }
  sents.forEach((s, i) => {
    const ns = norm(s);
    if (ex.preferences.some((p) => ns.includes(norm(p)) || norm(p).includes(ns))) return;
    if (NLP.isPromiseLike(s) || i === 0) return; // la primera frase suele ser el contexto de la reunión
    const score = Math.max(...SEM.prefs.map((p) => IA.cosine(vecs[i + 1], p)));
    if (score >= THRESH.pref) ex.preferences.push(s.replace(/[.]+$/, ""));
  });
  if (ex.sentiment === "neutral") {
    const best = SEM.sent.map((x) => ({ name: x.name, s: IA.cosine(noteVec, x.vec) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= THRESH.sentiment) ex.sentiment = best.name;
  }
  return round4(noteVec);
}

async function runBackfill() {
  if (backfill.running || !IA.state.embed) return;
  const missing = [...S.notes.values()].filter((n) => !n.vec);
  if (!missing.length) return;
  backfill = { running: true, done: 0, total: missing.length };
  renderStatus();
  try {
    for (let i = 0; i < missing.length; i += 8) {
      const batch = missing.slice(i, i + 8);
      const vecs = await IA.embed(batch.map((n) => n.text));
      for (let j = 0; j < batch.length; j++) {
        const cur = S.notes.get(batch[j].id);
        if (cur) { const upd = { ...cur, vec: round4(vecs[j]) }; S.notes.set(upd.id, upd); await Store.put("notes", upd); }
      }
      backfill.done = Math.min(missing.length, i + 8);
      renderStatus();
    }
  } catch (e) { /* se reintenta en la próxima carga */ }
  backfill.running = false;
  renderStatus();
}

/* ---------- captura ---------- */
let busy = false;
let lastResult = null;
let captureHint = null;

/** opts.lang: "es" | "en" para forzar el idioma (si no, se detecta). */
async function capture(text, opts) {
  opts = opts || {};
  if (busy) return;
  text = text.trim();
  if (!text) { $("capText").focus(); return; }
  busy = true; $("saveBtn").disabled = true;
  $("capResult").innerHTML = `<div class="result"><div class="working"><span class="dots"><i></i><i></i><i></i></span>${esc(t("cap.working"))}</div></div>`;
  const engine = [];
  let entities = null;
  if (IA.state.ner) {
    try { entities = await IA.entities(text); } catch (e) { entities = null; }
  }
  const lite = [...S.clients.values()].map((c) => ({ id: c.id, name: c.name, company: c.company || "", lastAt: clientView(c).lastAt }));
  const hint = opts.hint !== undefined ? opts.hint : captureHint;
  const ex = NLP.analyze(text, { clients: lite, now: new Date(), entities, hintId: hint, lang: opts.lang, fallbackLang: I18N.lang });
  engine.push("NLP " + ex.lang.toUpperCase());
  if (entities) engine.push("NER");
  let vec = null;
  if (IA.state.embed) {
    try { vec = await enrich(ex, text); engine.push("embeddings"); } catch (e) { vec = null; }
  }

  const now = opts.createdAt || new Date().toISOString();
  let client = ex.client.matchId ? S.clients.get(ex.client.matchId) : null;
  if (!client) client = [...S.clients.values()].find((c) => norm(c.name) === norm(ex.client.name)) || null;
  let createdClient = false;
  if (!client) {
    client = { id: uid("c"), name: ex.client.name, company: ex.client.company || "", createdAt: now };
    createdClient = true;
    await put("clients", client);
  } else if (!client.company && ex.client.company) {
    await patch("clients", client.id, { company: ex.client.company });
  }
  const noteId = uid("n");
  await put("notes", {
    id: noteId, clientId: client.id, text, summary: ex.summary || text.slice(0, 120), type: ex.interactionType,
    lang: ex.lang, langConfidence: +ex.langConfidence.toFixed(2), langForced: ex.langForced,
    topics: ex.topics, semanticTopics: ex.semanticTopics || [], people: ex.people, preferences: ex.preferences,
    sentiment: ex.sentiment, createdAt: now, engine: engine.join(" + "), vec,
  });
  const promiseIds = [];
  for (const p of ex.promises) {
    const pid = uid("p"); promiseIds.push(pid);
    await put("promises", { id: pid, clientId: client.id, noteId, text: p.text, due: p.due, owner: p.owner, done: false, doneAt: null, createdAt: now });
  }
  lastResult = { noteId, clientId: client.id, createdClient, promiseIds, hint, confidence: hint ? "high" : ex.client.confidence, reason: hint ? "hint" : ex.client.reason };
  $("capText").value = "";
  setHint(null);
  busy = false; $("saveBtn").disabled = false;
  render();
}
async function discardLast() {
  const { noteId, clientId, createdClient, promiseIds } = lastResult;
  for (const pid of promiseIds) if (S.promises.has(pid)) await remove("promises", pid);
  if (S.notes.has(noteId)) await remove("notes", noteId);
  if (createdClient && notesOf(clientId).length === 0) await remove("clients", clientId);
}
async function undoLast() {
  if (!lastResult) return;
  const note = S.notes.get(lastResult.noteId);
  await discardLast();
  lastResult = null;
  if (note) $("capText").value = note.text;
  toast(t("toast.undone"));
  render();
}
/** Vuelve a analizar la última nota forzando el otro idioma. */
async function reanalyze(lang) {
  if (!lastResult) return;
  const note = S.notes.get(lastResult.noteId);
  if (!note) return;
  const hint = lastResult.hint || null;
  await discardLast();
  lastResult = null;
  await capture(note.text, { lang, hint, createdAt: note.createdAt });
  toast(t("toast.reanalyzed", { lang: langName(lang) }));
}
async function reassign(newClientId) {
  if (!lastResult || !newClientId) return;
  const { noteId, clientId: oldId, createdClient, promiseIds } = lastResult;
  if (newClientId === oldId) return;
  await patch("notes", noteId, { clientId: newClientId });
  for (const pid of promiseIds) if (S.promises.has(pid)) await patch("promises", pid, { clientId: newClientId });
  if (createdClient && notesOf(oldId).length === 0) await remove("clients", oldId);
  lastResult = { ...lastResult, clientId: newClientId, createdClient: false, confidence: "high", reason: "chosen" };
  toast(t("toast.moved", { name: S.clients.get(newClientId)?.name || "" }));
  render();
}
function setHint(cid) {
  captureHint = cid;
  const c = cid && S.clients.get(cid);
  $("capHint").innerHTML = c
    ? t("cap.hintFor", { name: esc(c.name) }) + ` <button type="button" class="link" id="clearHint">${esc(t("cap.clearHint"))}</button>`
    : esc(t("cap.hint")) + ' <span class="mono">Ctrl + Enter</span>';
  const b = $("clearHint"); if (b) b.onclick = () => setHint(null);
}

/* ---------- render ---------- */
let view = "capture";
let currentClient = null;
let confirmDelete = false;
let editingClient = false;
let confirmWipe = false;

function iaSummary() {
  const st = IA.state;
  if (st.loading) {
    const items = Object.values(st.progress).filter((p) => p.total);
    const loaded = items.reduce((a, p) => a + (p.loaded || 0), 0);
    const total = items.reduce((a, p) => a + (p.total || 0), 0);
    return { cls: "loading", text: t("ia.loading") + (total ? " " + Math.round((loaded / total) * 100) + " %" : "…") };
  }
  if (st.embed) return { cls: "on", text: st.ner ? t("ia.on") : t("ia.noNer") };
  return { cls: "", text: t("ia.rules") };
}
function renderStatus() {
  const ia = iaSummary();
  const idx = backfill.running ? " · " + t("status.indexing", { done: backfill.done, total: backfill.total }) : "";
  $("status").innerHTML = "<b>" + esc(storeMode === "memoria" ? t("status.memory") : t("status.local")) + "</b> · " + esc(t("status.clients", { n: S.clients.size })) + "<br>" +
    '<span class="pill-ia ' + ia.cls + '">' + esc(ia.text + idx) + "</span>";
  if (view === "settings") renderSettings();
}
function renderLangSwitch() {
  document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === I18N.lang)));
}
function promiseRow(p, showClient) {
  const d = dueLabel(p.due);
  const c = S.clients.get(p.clientId);
  const who = ownerCode(p.owner) === "client" ? t("pr.committed", { name: c ? c.name.split(" ")[0] : t("pr.client") }) : "";
  return `<label class="row promise${p.done ? " done" : ""}">
    <input type="checkbox" data-promise="${esc(p.id)}" ${p.done ? "checked" : ""} aria-label="${esc(t("pr.markDone"))}">
    <span class="main"><span class="title">${esc(p.text)}</span>
      <span class="sub">${showClient && c ? esc(c.name) + " · " : ""}${who ? esc(who) + " · " : ""}<span class="due ${d.cls}">${esc(p.done ? t("pr.doneLabel") : d.text)}</span></span></span>
  </label>`;
}
function noteRow(n, showClient, q, sim) {
  const c = S.clients.get(n.clientId);
  const hl = (s) => (q ? highlight(s, q) : esc(s));
  const langTag = n.lang && n.lang !== I18N.lang ? `<span class="lang-tag" title="${esc(langName(n.lang))}">${esc(n.lang)}</span>` : "";
  return `<div class="row note"><span class="main">
    ${showClient && c ? `<button class="link" data-open="${esc(c.id)}" style="align-self:flex-start;font-weight:600;text-decoration:none;color:var(--ink)">${esc(c.name)}</button>` : ""}
    <span class="quote" ${n.lang ? `lang="${esc(n.lang)}"` : ""}>${hl(n.text)}</span>
    <span class="meta"><span class="mono">${esc(ago(n.createdAt))} · ${esc(typeName(n.type))}</span>${langTag}
    ${(n.topics || []).map((tp) => `<span class="chip">${hl(topicName(tp))}</span>`).join("")}
    ${sim != null ? `<span class="sim">${esc(t("se.similar", { p: Math.round(sim * 100) }))}</span>` : ""}</span>
  </span></div>`;
}
function renderResult() {
  const box = $("capResult");
  if (busy) return;
  if (!lastResult) { box.innerHTML = ""; return; }
  const note = S.notes.get(lastResult.noteId);
  const c = S.clients.get(lastResult.clientId);
  if (!note || !c) { box.innerHTML = ""; return; }
  const ps = lastResult.promiseIds.map((id) => S.promises.get(id)).filter(Boolean);
  const others = [...S.clients.values()].filter((x) => x.id !== c.id).sort((a, b) => a.name.localeCompare(b.name));
  const doubtful = lastResult.confidence === "low" || ["tie", "typo", "noname"].includes(lastResult.reason);
  const sem = new Set(note.semanticTopics || []);
  const otherLang = note.lang === "en" ? "es" : "en";
  const langInfo = note.lang
    ? `${esc(langName(note.lang))} <span class="muted">· ${esc(note.langForced ? t("res.langForced") : t("res.langAuto"))}${!note.langForced && note.langConfidence != null ? " (" + Math.round(note.langConfidence * 100) + " %)" : ""}</span> <button class="link" id="reLangBtn">${esc(t("res.reanalyze", { lang: langName(otherLang) }))}</button>`
    : "";
  box.innerHTML = `<div class="result" role="status">
    <div class="sec-head"><h2>${esc(t("res.saved"))}</h2><span class="engine">${esc(note.engine || "")}</span></div>
    <div class="who">${esc(c.name)}${c.company ? ` <span class="muted" style="font-weight:600;font-size:15px">· ${esc(c.company)}</span>` : ""}${lastResult.createdClient ? ` <span class="badge">${esc(t("res.new"))}</span>` : ""}</div>
    ${doubtful ? `<div class="warn">${esc(t("res.check", { reason: t("reason." + lastResult.reason) }))}</div>` : ""}
    ${lastResult.createdClient ? `<div class="res-foot"><label class="hint" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${esc(t("res.name"))} <input id="renameInput" value="${esc(c.name)}" style="font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);max-width:100%"></label><button class="btn-ghost" id="renameBtn">${esc(t("res.rename"))}</button></div>` : ""}
    <dl class="kv">
      ${langInfo ? `<dt>${esc(t("res.lang"))}</dt><dd>${langInfo}</dd>` : ""}
      <dt>${esc(t("res.summary"))}</dt><dd lang="${esc(note.lang || "")}">${esc(note.summary)}</dd>
      ${(note.topics || []).length ? `<dt>${esc(t("res.topics"))}</dt><dd><div class="chips">${note.topics.map((tp) => `<span class="chip" ${sem.has(tp) ? `title="${esc(t("res.byMeaning"))}"` : ""}>${esc(topicName(tp))}${sem.has(tp) ? "<small>≈</small>" : ""}</span>`).join("")}</div></dd>` : ""}
      ${ps.length ? `<dt>${esc(t("res.actions"))}</dt><dd><ul>${ps.map((p) => `<li>${esc(p.text)} <span class="due ${dueLabel(p.due).cls}">${esc(dueLabel(p.due).text)}</span>${ownerCode(p.owner) === "client" ? ` <span class="muted">${esc(t("res.clientOwned"))}</span>` : ""}</li>`).join("")}</ul></dd>` : ""}
      ${(note.preferences || []).length ? `<dt>${esc(t("res.details"))}</dt><dd>${note.preferences.map(esc).join(" · ")}</dd>` : ""}
      ${(note.people || []).length ? `<dt>${esc(t("res.people"))}</dt><dd>${note.people.map(esc).join(", ")}</dd>` : ""}
      ${note.sentiment && moodCode(note.sentiment) !== "neutral" ? `<dt>${esc(t("res.mood"))}</dt><dd>${esc(t("mood." + moodCode(note.sentiment)))}</dd>` : ""}
    </dl>
    <div class="res-foot">
      ${others.length ? `<label class="hint">${esc(t("res.other"))} <select id="reassignSel"><option value="">${esc(t("res.moveTo"))}</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</select></label>` : "<span></span>"}
      <div class="cap-actions"><button class="link" id="undoBtn">${esc(t("res.undo"))}</button><button class="btn-ghost" data-open="${esc(c.id)}">${esc(t("res.open"))}</button></div>
    </div>
  </div>`;
  $("undoBtn").onclick = undoLast;
  const rl = $("reLangBtn"); if (rl) rl.onclick = () => reanalyze(otherLang);
  const sel = $("reassignSel"); if (sel) sel.onchange = () => reassign(sel.value);
  const rb = $("renameBtn");
  if (rb) rb.onclick = async () => {
    const v = $("renameInput").value.trim();
    if (!v) return;
    lastResult = { ...lastResult, confidence: "high", reason: "renamed" };
    await patch("clients", c.id, { name: v });
    toast(t("toast.renamed", { name: v }));
  };
}
function renderCapture() {
  renderResult();
  $("capIntro").innerHTML = S.notes.size ? "" : `<div class="empty intro">${t("cap.intro")}</div>`;
  const pend = sortPromises([...S.promises.values()].filter((p) => !p.done));
  $("pendCount").textContent = pend.length ? pend.length : "";
  $("pendList").innerHTML = pend.length
    ? `<div class="list">${pend.slice(0, 12).map((p) => promiseRow(p, true)).join("")}</div>`
    : `<div class="empty">${esc(t("empty.pending"))}</div>`;
  const recent = [...S.notes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  $("recentCount").textContent = S.notes.size ? t("sec.total", { n: S.notes.size }) : "";
  $("recentList").innerHTML = recent.length ? `<div class="list">${recent.map((n) => noteRow(n, true)).join("")}</div>` : `<div class="empty">${esc(t("empty.recent"))}</div>`;
}
function renderClients() {
  const list = [...S.clients.values()].map(clientView).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  $("clientCount").textContent = list.length ? list.length : "";
  $("clientList").innerHTML = list.length ? `<div class="list">${list.map((c) => `
    <button class="row" data-open="${esc(c.id)}">
      <span class="main"><span class="title">${esc(c.name)}</span>
      <span class="sub">${c.company ? esc(c.company) + " · " : ""}${c.last ? esc(c.last.summary) : esc(t("cl.noNotes"))}</span></span>
      <span class="side"><span class="warmth ${c.warmth.cls}">${esc(c.warmth.label)}</span>
      <span class="mono muted">${esc(ago(c.lastAt))}</span>
      ${c.pending.length ? `<span class="badge">${esc(t("cl.pending", { n: c.pending.length }))}</span>` : ""}</span>
    </button>`).join("")}</div>`
    : `<div class="empty">${esc(t("cl.empty"))}</div>`;
}
function renderClient() {
  const box = $("v-client");
  const raw = S.clients.get(currentClient);
  if (!raw) { box.innerHTML = `<button class="link back" data-tab="clients">${esc(t("cl.back"))}</button><div class="empty">${esc(t("cl.gone"))}</div>`; return; }
  const c = clientView(raw);
  const first = c.name.split(" ")[0];
  const pend = sortPromises(c.pending);
  const done = promisesOf(c.id).filter((p) => p.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
  const inputStyle = "font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink)";
  box.innerHTML = `
    <button class="link back" data-tab="clients">${esc(t("cl.back"))}</button>
    <div class="client-head">
      ${editingClient ? `<div class="card">
        <label class="hint" for="editName">${esc(t("res.name"))}</label><input id="editName" value="${esc(c.name)}" style="${inputStyle}">
        <label class="hint" for="editCompany">${esc(t("cl.company"))}</label><input id="editCompany" value="${esc(c.company || "")}" style="${inputStyle}">
        <div class="row-actions"><button class="btn" id="editSave">${esc(t("cl.save"))}</button><button class="link" id="editCancel">${esc(t("cl.cancel"))}</button></div></div>`
      : `<h3>${esc(c.name)}</h3>
      <div class="line">${c.company ? `<span>${esc(c.company)}</span>` : ""}<span class="warmth ${c.warmth.cls}">${esc(t("cl.warmth", { level: c.warmth.label }))}</span><span class="mono">${esc(c.notes.length === 1 ? t("cl.note1") : t("cl.notes", { n: c.notes.length }))}</span><button class="link" id="editClient">${esc(t("cl.edit"))}</button></div>`}
      <div><button class="btn" id="capAbout">${esc(t("cl.captureAbout", { name: first }))}</button></div>
    </div>
    <div class="brief">
      <h2>${esc(t("cl.last"))} · ${esc(c.last ? ago(c.last.createdAt) + " (" + typeName(c.last.type) + ")" : "—")}</h2>
      <div class="quote" ${c.last && c.last.lang ? `lang="${esc(c.last.lang)}"` : ""}>${c.last ? esc(c.last.text) : `<span class="muted">${esc(t("cl.noLast"))}</span>`}</div>
    </div>
    <div class="sec"><div class="sec-head"><h2>${esc(t("sec.pending"))}</h2><span class="count">${pend.length || ""}</span></div>
      ${pend.length ? `<div class="list">${pend.map((p) => promiseRow(p, false)).join("")}</div>` : `<div class="empty">${esc(t("cl.nothingPending", { name: first }))}</div>`}</div>
    ${c.topics.length ? `<div class="sec"><h2>${esc(t("cl.topics"))}</h2><div class="chips">${c.topics.map(([tp, n]) => `<span class="chip">${esc(topicName(tp))}${n > 1 ? `<small>×${n}</small>` : ""}</span>`).join("")}</div></div>` : ""}
    ${c.prefs.length ? `<div class="sec"><h2>${esc(t("cl.prefs"))}</h2><div class="list">${c.prefs.map((p) => `<div class="row"><span class="main">${esc(p)}</span></div>`).join("")}</div></div>` : ""}
    <div class="sec"><div class="sec-head"><h2>${esc(t("cl.history"))}</h2><span class="count">${c.notes.length || ""}</span></div>
      ${c.notes.length ? `<div class="list">${c.notes.map((n) => noteRow(n, false)).join("")}</div>` : ""}</div>
    ${done.length ? `<div class="sec"><h2>${esc(t("cl.done"))}</h2><div class="list">${done.map((p) => promiseRow(p, false)).join("")}</div></div>` : ""}
    <div class="confirm">${confirmDelete
      ? `<span>${esc(t("cl.deleteAsk", { name: c.name, n: c.notes.length }))}</span><button class="link danger" id="delYes">${esc(t("cl.deleteYes"))}</button><button class="link" id="delNo">${esc(t("cl.cancel"))}</button>`
      : `<button class="link danger" id="delClient">${esc(t("cl.delete"))}</button>`}</div>`;
  $("capAbout").onclick = () => { setHint(c.id); go("capture"); $("capText").focus(); };
  const ed = $("editClient"); if (ed) ed.onclick = () => { editingClient = true; renderClient(); };
  const ec = $("editCancel"); if (ec) ec.onclick = () => { editingClient = false; renderClient(); };
  const es = $("editSave"); if (es) es.onclick = async () => {
    const name = $("editName").value.trim(); const company = $("editCompany").value.trim();
    if (!name) return;
    editingClient = false;
    await patch("clients", c.id, { name, company });
    toast(t("toast.clientSaved"));
  };
  const d = $("delClient"); if (d) d.onclick = () => { confirmDelete = true; renderClient(); };
  const n = $("delNo"); if (n) n.onclick = () => { confirmDelete = false; renderClient(); };
  const y = $("delYes"); if (y) y.onclick = async () => {
    const id = c.id; confirmDelete = false;
    for (const p of promisesOf(id)) await remove("promises", p.id);
    for (const nn of notesOf(id)) await remove("notes", nn.id);
    await remove("clients", id);
    if (lastResult && lastResult.clientId === id) lastResult = null;
    toast(t("toast.clientDeleted")); go("clients");
  };
}
function highlight(s, q) {
  const text = NLP.nfc(String(s ?? ""));
  const tokens = norm(q).split(/\s+/).filter((x) => x.length > 1);
  if (!tokens.length) return esc(text);
  const nt = norm(text);
  if (nt.length !== text.length) return esc(text);
  const marks = new Array(text.length).fill(false);
  tokens.forEach((tk) => { let i = nt.indexOf(tk); while (i !== -1) { for (let k = i; k < i + tk.length; k++) marks[k] = true; i = nt.indexOf(tk, i + 1); } });
  let out = "", open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] && !open) { out += "<mark>"; open = true; }
    if (!marks[i] && open) { out += "</mark>"; open = false; }
    out += esc(text[i]);
  }
  return out + (open ? "</mark>" : "");
}

/* ---------- búsqueda: texto + significado ---------- */
const STOP = new Set(("que le lo la el los las de del a al en con por para mi me su sus un una y o cual cuando donde como hay tengo prometi pendiente pendientes promesa promesas debo quede " +
  "what did do does i to the a an of with for my me is are have promised promise promises pending open owe owed about").split(" "));
let searchSeq = 0;
function renderSearch() {
  const q = $("q").value.trim();
  const out = $("searchOut");
  const seq = ++searchSeq;
  if (!q) {
    const topicCount = {};
    S.notes.forEach((n) => (n.topics || []).forEach((tp) => { const id = NLP.topicId(tp); topicCount[id] = (topicCount[id] || 0) + 1; }));
    const top = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 14);
    out.innerHTML = top.length
      ? `<div class="sec"><h2>${esc(t("se.frequent"))}</h2><div class="chips">${top.map(([tp, n]) => `<button class="chip" data-q="${esc(topicName(tp))}">${esc(topicName(tp))}<small>×${n}</small></button>`).join("")}</div></div>`
      : `<div class="empty">${esc(t("se.empty") + (IA.state.embed ? t("se.emptyAI") : ""))}</div>`;
    return;
  }
  const nq = norm(q);
  // Intención "¿qué le prometí a Juan?" / "what did I promise John?": pendientes de ese cliente
  const askPromises = /promet|pendient|debo|quede|compromet|promis|owe|pending|open with/.test(nq);
  const nameTokens = nq.split(/[^a-z0-9ñ]+/).filter((x) => x.length > 2 && !STOP.has(x));
  const clientFor = askPromises ? [...S.clients.values()].find((c) => norm(c.name).split(/\s+/).some((w) => nameTokens.includes(w))) : null;

  const tokens = askPromises && clientFor ? [] : nq.split(/\s+/).filter(Boolean);
  const hit = (s) => { const h = norm(s); return tokens.length && tokens.every((tk) => h.includes(tk)); };
  const topicText = (n) => (n.topics || []).map((tp) => NLP.topicLabel(tp, "es") + " " + NLP.topicLabel(tp, "en")).join(" ");
  const clients = [...S.clients.values()].filter((c) => hit(c.name + " " + (c.company || "")));
  const notes = [...S.notes.values()].filter((n) => {
    const c = S.clients.get(n.clientId);
    return hit([n.text, n.summary, topicText(n), (n.people || []).join(" "), (n.preferences || []).join(" "), c ? c.name : ""].join(" "));
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const proms = sortPromises([...S.promises.values()].filter((p) => { const c = S.clients.get(p.clientId); return hit(p.text + " " + (c ? c.name : "")); }));
  const intent = clientFor ? sortPromises(promisesOf(clientFor.id).filter((p) => !p.done)) : null;

  const blocks = [];
  if (intent) blocks.push(`<div class="sec"><div class="sec-head"><h2>${esc(t("se.pendingWith", { name: clientFor.name }))}</h2><span class="count">${intent.length || ""}</span></div>${intent.length ? `<div class="list">${intent.map((p) => promiseRow(p, false)).join("")}</div>` : `<div class="empty">${esc(t("se.noPendingWith", { name: clientFor.name.split(" ")[0] }))}</div>`}</div>`);
  if (clients.length) blocks.push(`<div class="sec"><h2>${esc(t("se.clients"))}</h2><div class="list">${clients.map((c) => { const v = clientView(c); return `<button class="row" data-open="${esc(c.id)}"><span class="main"><span class="title">${highlight(c.name, q)}</span><span class="sub">${esc(c.company || "")}</span></span><span class="side"><span class="warmth ${v.warmth.cls}">${esc(v.warmth.label)}</span></span></button>`; }).join("")}</div></div>`);
  if (proms.length) blocks.push(`<div class="sec"><h2>${esc(t("se.promises"))}</h2><div class="list">${proms.map((p) => promiseRow(p, true)).join("")}</div></div>`);
  if (notes.length) blocks.push(`<div class="sec"><div class="sec-head"><h2>${esc(t("se.notes"))}</h2><span class="count">${notes.length}</span></div><div class="list">${notes.slice(0, 40).map((n) => noteRow(n, true, q)).join("")}</div></div>`);
  blocks.push('<div id="semOut"></div>');
  const nothing = !intent && !clients.length && !proms.length && !notes.length;
  out.innerHTML = (nothing ? `<div class="empty" id="noLex">${esc(t("se.noLex", { q }) + (IA.state.embed ? t("se.searchingMeaning") : ""))}</div>` : "") + blocks.join("");

  if (!IA.state.embed || q.length < 3) return;
  const lexIds = new Set(notes.map((n) => n.id));
  clearTimeout(renderSearch._t);
  renderSearch._t = setTimeout(async () => {
    let qv;
    try { qv = (await IA.embed([q]))[0]; } catch (e) { return; }
    if (seq !== searchSeq) return;
    const scored = [...S.notes.values()].filter((n) => n.vec && !lexIds.has(n.id))
      .map((n) => ({ n, s: IA.cosine(qv, n.vec) })).filter((x) => x.s >= THRESH.search)
      .sort((a, b) => b.s - a.s).slice(0, 10);
    const box = $("semOut"); if (!box) return;
    const nl = $("noLex"); if (nl) nl.textContent = scored.length ? t("se.meaningFound", { q }) : t("se.nothing", { q });
    box.innerHTML = scored.length ? `<div class="sec"><div class="sec-head"><h2>${esc(t("se.byMeaning"))}</h2><span class="count">${esc(t("se.localModel"))}</span></div><div class="list">${scored.map((x) => noteRow(x.n, true, null, x.s)).join("")}</div></div>` : "";
  }, 250);
}

/* ---------- ajustes ---------- */
const fmtMB = (b) => (b ? (b / 1048576).toFixed(0) + " MB" : "");
const errText = (e) => (e && /^err\./.test(e) ? t(e) : e);
function renderSettings() {
  const st = IA.state;
  const why = IA.canRun();
  const modelRow = (label, key, size) => {
    const err = st.errors && st.errors[key];
    const items = Object.values(st.progress).filter((p) => p.model === key && p.total);
    const loaded = items.reduce((a, p) => a + (p.loaded || 0), 0), total = items.reduce((a, p) => a + (p.total || 0), 0);
    const status = st[key] ? `<span class="st ok">${esc(t("st.loaded"))}</span>`
      : st.loading && (key === "embed" || settings.withNer) ? `<span class="st">${total ? Math.round((loaded / total) * 100) + " % · " + fmtMB(loaded) + " / " + fmtMB(total) : esc(t("st.preparing"))}</span>`
      : err ? `<span class="st err">${esc(t("st.unavailable"))}</span>`
      : key === "ner" && !settings.withNer ? `<span class="st off">${esc(t("st.disabled"))}</span>` : `<span class="st off">${esc(t("st.notLoaded"))}</span>`;
    const bar = st.loading && total && !st[key] ? `<div class="bar" style="grid-column:1/-1"><i style="width:${Math.round((loaded / total) * 100)}%"></i></div>` : "";
    return `<span>${esc(label)} <span class="muted">· ${size}</span></span>${status}${bar}${err ? `<span class="hint" style="grid-column:1/-1;color:var(--danger)">${esc(String(errText(err)).slice(0, 180))}</span>` : ""}`;
  };
  $("iaCard").innerHTML = `
    ${why ? `<div class="warn">${t("st.fileMode", { why: esc(errText(why)) })}</div>` : ""}
    <p>${esc(st.embed ? t("st.aiOn") + (st.ner ? t("st.aiNer") : "") : t("st.aiOff"))}</p>
    <div class="models">
      ${modelRow(t("st.embed"), "embed", "≈ 120 MB")}
      ${modelRow(t("st.ner"), "ner", "≈ 180 MB")}
    </div>
    <label class="toggle"><input type="checkbox" id="optRemote" ${settings.allowRemote ? "checked" : ""}><span>${t("st.optRemote")}</span></label>
    <label class="toggle"><input type="checkbox" id="optNer" ${settings.withNer ? "checked" : ""}><span>${esc(t("st.optNer"))}</span></label>
    <label class="toggle"><input type="checkbox" id="optAuto" ${settings.autoStart ? "checked" : ""}><span>${esc(t("st.optAuto"))}</span></label>
    <div class="row-actions">${why ? "" : `<button class="btn" id="iaStart" ${st.loading ? "disabled" : ""}>${esc(st.loading ? t("st.loading") : st.embed ? t("st.reload") : t("st.loadNow"))}</button>`}</div>`;
  $("optRemote").onchange = (e) => { settings.allowRemote = e.target.checked; saveSettings(); };
  $("optNer").onchange = (e) => { settings.withNer = e.target.checked; saveSettings(); };
  $("optAuto").onchange = (e) => { settings.autoStart = e.target.checked; saveSettings(); };
  const b = $("iaStart"); if (b) b.onclick = () => startIA(true);

  $("storeInfo").innerHTML = storeMode === "memoria"
    ? `<span style="color:var(--danger)">${esc(t("st.storeMemory"))}</span>`
    : esc(t("st.storeInfo", { c: S.clients.size, n: S.notes.size, p: S.promises.size }));
  $("wipeBox").innerHTML = confirmWipe
    ? `<span>${esc(t("st.wipeAsk"))}</span><button class="link danger" id="wipeYes">${esc(t("st.wipeYes"))}</button><button class="link" id="wipeNo">${esc(t("cl.cancel"))}</button>`
    : `<button class="link danger" id="wipeBtn">${esc(t("st.wipe"))}</button>`;
  const w = $("wipeBtn"); if (w) w.onclick = () => { confirmWipe = true; renderSettings(); };
  const wn = $("wipeNo"); if (wn) wn.onclick = () => { confirmWipe = false; renderSettings(); };
  const wy = $("wipeYes"); if (wy) wy.onclick = async () => {
    confirmWipe = false;
    for (const col of Store.COLS) for (const id of [...S[col].keys()]) await remove(col, id);
    lastResult = null; toast(t("toast.wiped")); render();
  };
}
async function exportBackup() {
  const data = await Store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `memoria-crm-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(t("toast.backup"));
}
async function importBackup(file) {
  const msg = $("importMsg");
  try {
    const data = JSON.parse(await file.text());
    const n = await Store.importAll(data, "merge");
    await loadAll();
    msg.textContent = t("st.imported", { n });
    render(); runBackfill();
  } catch (e) {
    msg.textContent = t("st.importErr", { msg: e.message || e });
  }
}

/* ---------- navegación ---------- */
function render() {
  renderStatus();
  renderLangSwitch();
  if (view === "capture") renderCapture();
  else if (view === "clients") renderClients();
  else if (view === "client") renderClient();
  else if (view === "search") renderSearch();
  else if (view === "settings") renderSettings();
}
function go(v, cid) {
  view = v; if (cid) currentClient = cid;
  if (v !== "client") { confirmDelete = false; editingClient = false; }
  ["capture", "clients", "client", "search", "settings"].forEach((x) => { $("v-" + x).hidden = x !== v; });
  document.querySelectorAll("nav.tabs button").forEach((b) => {
    const active = b.dataset.tab === v || (v === "client" && b.dataset.tab === "clients");
    if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  render();
  window.scrollTo(0, 0);
  if (v === "search") setTimeout(() => $("q").focus(), 0);
}

/* ---------- eventos ---------- */
// Ejemplos en el idioma de la interfaz + uno en el otro idioma, para ver la detección.
const EXAMPLES = {
  es: [
    "Comida con Juan Pérez de Grupo Norteña. Preocupado por la expansión a manufactura. Le prometí enviar el caso de éxito del sector el viernes. Prefiere llamadas por la mañana; su hijo juega fútbol.",
    "Llamada con Laura Méndez (Textiles Andina). Quiere reducir mermas en corte. Quedé en mandarle la propuesta de diagnóstico la próxima semana. Ella me pasa los datos de producción del trimestre.",
    "Reunión con Juan: pidió agendar una llamada con su CFO, Marta Ruiz, para hablar de financiamiento.",
    "Lunch with Sarah Collins from Apex Aerostructures. She's worried about scrap rates on the new assembly line. I promised to send her the quality audit checklist by Friday. Her daughter plays tennis.",
  ],
  en: [
    "Lunch with Sarah Collins from Apex Aerostructures. She's worried about scrap rates on the new assembly line. I promised to send her the quality audit checklist by Friday. Her daughter plays tennis.",
    "Call with Tom Baker at Northwind Logistics Inc. He was happy with the pilot. I need to prepare the phase 2 quote before October 15 and I'll email him the contract tomorrow.",
    "Meeting with Sarah: she asked me to schedule a call with her CFO, David Lee, to discuss financing. She'll send me the Q3 numbers next week.",
    "Comida con Juan Pérez de Grupo Norteña. Preocupado por la expansión a manufactura. Le prometí enviar el caso de éxito del sector el viernes. Prefiere llamadas por la mañana; su hijo juega fútbol.",
  ],
};
let exIdx = 0;
$("exampleBtn").onclick = () => { const list = EXAMPLES[I18N.lang]; $("capText").value = list[exIdx % list.length]; exIdx++; $("capText").focus(); };
$("capForm").addEventListener("submit", (e) => { e.preventDefault(); capture($("capText").value); });
$("capText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); capture($("capText").value); } });
$("q").addEventListener("input", () => renderSearch());
$("exportBtn").onclick = exportBackup;
$("importFile").onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); e.target.value = ""; };
document.addEventListener("click", (e) => {
  const lb = e.target.closest("[data-lang]");
  if (lb && lb.tagName === "BUTTON") { I18N.setLang(lb.dataset.lang); return; }
  const open = e.target.closest("[data-open]");
  if (open) { e.preventDefault(); go("client", open.dataset.open); return; }
  const tab = e.target.closest("[data-tab]");
  if (tab) { e.preventDefault(); go(tab.dataset.tab); return; }
  const qb = e.target.closest("[data-q]");
  if (qb) { $("q").value = qb.dataset.q; renderSearch(); }
});
document.addEventListener("change", (e) => {
  const cb = e.target.closest("[data-promise]");
  if (cb) {
    patch("promises", cb.dataset.promise, cb.checked ? { done: true, doneAt: new Date().toISOString() } : { done: false, doneAt: null });
    toast(cb.checked ? t("toast.done") : t("toast.reopened"));
  }
});
I18N.onChange(() => { exIdx = 0; setHint(captureHint); render(); });

/* ---------- arranque ---------- */
let iaWasReady = false;
IA.onChange((st) => {
  renderStatus();
  if (st.embed && !iaWasReady) {
    iaWasReady = true;
    prepareSemantics().then(runBackfill).catch(() => {});
    if (view === "search") renderSearch();
  }
});
function startIA(force) {
  const opts = { allowRemote: settings.allowRemote, withNer: settings.withNer };
  iaWasReady = false; SEM.ready = false;
  return force ? IA.restart(opts) : IA.start(opts);
}

(async function boot() {
  I18N.apply();
  setHint(null);
  storeMode = await Store.open();
  await loadAll();
  render();
  if (settings.autoStart && !IA.canRun()) startIA(false);
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
})();
