# Memoria CRM · Fase 1 (versión sin conexión)

Una app HTML que funciona **sin internet y sin Claude**, en **español e inglés**. Escribes una frase después de cada conversación y la app detecta al cliente, los temas, las promesas con fecha y los detalles personales. Todo se procesa y se guarda **en tu equipo**.

## Idiomas

- **Interfaz:** el selector **ES / EN** (arriba a la derecha, y también en *Ajustes*) cambia todos los textos: títulos, pestañas, botones, fechas y nombres de temas. La elección se recuerda en el navegador. La primera vez se usa el idioma del navegador.
- **Notas:** cada nota se analiza en su propio idioma, sin importar el de la interfaz. El motor detecta si la frase está en español o en inglés (palabras funcionales, contracciones, signos ¿ ¡) y aplica las reglas de ese idioma: fechas (*el viernes* / *by Friday*, 15/10 en español y 10/15 en inglés), promesas (*le prometí* / *I promised*, *me pasa* / *she'll send me*), nombres, empresas (*de Grupo X* / *at X Inc.*), preferencias y ánimo.
- En la tarjeta de *Guardado* ves el idioma detectado con su confianza y el botón **Analizar como…** por si una nota muy corta o mezclada se detectó mal.
- Los temas se guardan como códigos, así que una nota en inglés y otra en español sobre lo mismo se agrupan en el mismo tema. La búsqueda por significado también cruza idiomas.

## Cómo abrirla

| Sistema | Qué hacer |
|---|---|
| Windows | Doble clic en **`Iniciar Memoria CRM.bat`**. Se abre el navegador. Deja la ventana negra abierta mientras la usas. |
| macOS | Doble clic en **`Iniciar Memoria CRM.command`**. La primera vez: clic derecho → Abrir. Necesita Python 3, que ya viene con las herramientas de desarrollo de Xcode. |
| Linux | `./iniciar.sh` |

El lanzador es un servidor web mínimo que solo escucha en tu equipo (`localhost:8765`). Hace falta porque los navegadores no dejan cargar modelos de IA desde una página abierta con doble clic.

**¿Y si abro `index.html` directamente?** También funciona: captura, fichas, promesas y búsqueda por texto. Solo se desactivan los modelos de IA y la app usa su motor de reglas en español.

## La IA local

La IA son dos modelos pre-entrenados abiertos que corren dentro del navegador (ONNX + WebAssembly, con [Transformers.js](https://huggingface.co/docs/transformers.js)):

| Modelo | Para qué | Tamaño |
|---|---|---|
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Embeddings multilingües: temas por significado, búsqueda por significado, detalles personales y sentimiento | ≈ 120 MB |
| `Xenova/bert-base-multilingual-cased-ner-hrl` | NER: reconoce personas y empresas nuevas | ≈ 180 MB |

Además hay un **motor de reglas en español e inglés** (`js/nlp.js`) que siempre está activo. Primero detecta el idioma de la nota y después se encarga de:

- Las promesas: *prometí*, *quedé en*, *le envío*, *tengo que*, *me pidió*… y también lo que prometió el cliente (*me pasa*, *quedó en*).
- Las fechas relativas: *el viernes*, *mañana*, *la próxima semana*, *en 3 días*, *el 15 de octubre*, *15/10*, *fin de mes*.
- El tipo de interacción, el emparejamiento con clientes existentes (incluso con erratas: *Juna* → *Juan*), la empresa, las personas con rol (*su CFO, Marta Ruiz*) y las preferencias (*prefiere*, *su hijo*, *le encanta*…).

### Conseguir los modelos (solo una vez)

Tienes dos opciones:

1. **Automática:** abre la app con el lanzador y con internet. Los modelos se descargan solos de Hugging Face y quedan guardados en el navegador. Desde ese momento funciona sin conexión. Puedes desactivarlo en *Ajustes*.
2. **En la carpeta:** ejecuta `Descargar modelos.bat` (Windows) o `./descargar-modelos.sh` (macOS/Linux). Los modelos quedan en `modelos/` y la carpeta completa se puede copiar a otro equipo o a un USB y funciona sin internet desde el primer uso.

En *Ajustes* ves el estado de cada modelo y el avance de la carga.

## Tus datos

- Se guardan en el navegador (IndexedDB), en este equipo. No salen de él.
- **Ajustes → Descargar respaldo** genera un `.json` con todo. **Restaurar respaldo** lo vuelve a cargar, o lo pasa a otro navegador o equipo.
- Cada navegador tiene su propia base: Chrome y Edge no comparten datos.

## En el móvil

Publica la carpeta en GitHub Pages (gratis, con HTTPS) e instálala desde el navegador del teléfono. La guía paso a paso está en **[PUBLICAR-EN-GITHUB.md](PUBLICAR-EN-GITHUB.md)**. Después de la primera carga funciona sin conexión.

## Estructura

```
index.html              interfaz
css/app.css             estilos (fuentes locales en fonts/)
js/i18n.js              textos de la interfaz en español e inglés
js/nlp.js               detección de idioma + reglas en español e inglés (cliente, promesas, fechas, temas…)
js/ia-worker.js         modelos pre-entrenados en un Web Worker (Transformers.js)
js/ia.js                puente entre la interfaz y el worker
js/store.js             IndexedDB + respaldo
js/app.js               lógica de la app
vendor/                 Transformers.js 4.3.0 y runtime ONNX WebAssembly de 14 MB (sin CDN)
modelos/                modelos ONNX (opcional, ver arriba)
sw.js                   funcionamiento sin conexión en hosting
servidor.ps1 / .py      servidor local de los lanzadores
```

## Límites conocidos

- Los temas y la búsqueda "por significado" dependen de umbrales de similitud (`THRESH` en `js/app.js`). Ajústalos si ves demasiados temas o muy pocos resultados.
- El NER multilingüe tiene buena precisión con nombres propios en mayúscula. Si escribes todo en minúsculas, el motor de reglas y el emparejamiento con clientes existentes siguen funcionando.
- Siguiente fase: briefing pre-reunión, recordatorios con notificaciones y búsqueda semántica con más contexto (Fase 2 del diseño).
