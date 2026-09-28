/*
 * Memoria CRM · Cliente del worker de IA.
 * Funciona solo cuando la app se sirve por http(s) (lanzador local o hosting):
 * abriendo index.html con doble clic (file://) el navegador bloquea workers de
 * módulo y WebAssembly, y la app usa únicamente el motor de reglas.
 */
(function (root) {
  "use strict";
  const listeners = new Set();
  const pending = new Map();
  let worker = null;
  let seq = 0;
  const state = { available: false, loading: false, embed: false, ner: false, errors: {}, progress: {}, reason: "" };

  const emit = () => listeners.forEach((fn) => { try { fn(state); } catch (e) {} });

  function canRun() {
    if (!/^https?:$/.test(location.protocol)) return "err.fileMode"; // código; la interfaz lo traduce
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return "err.noWasm";
    return "";
  }

  function friendly(errors) {
    const out = {};
    for (const [k, v] of Object.entries(errors)) {
      out[k] = /failed to fetch|networkerror|not found locally|allowRemoteModels|load failed/i.test(v)
        ? "err.noModel"
        : v;
    }
    return out;
  }

  function call(type, payload, timeoutMs) {
    if (!worker) return Promise.reject(new Error("IA no iniciada"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error("La IA tardó demasiado")); }, timeoutMs || 30000);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      worker.postMessage({ id, type, ...payload });
    });
  }

  function start(opts) {
    const why = canRun();
    if (why) { state.reason = why; emit(); return Promise.resolve(state); }
    if (worker) return Promise.resolve(state);
    state.loading = true; state.reason = ""; emit();
    try {
      worker = new Worker(new URL("js/ia-worker.js", location.href), { type: "module" });
    } catch (e) {
      state.loading = false; state.reason = "err.worker"; emit();
      return Promise.resolve(state);
    }
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "progress") {
        const key = m.model + ":" + (m.file || "");
        state.progress[key] = { model: m.model, file: m.file, progress: m.progress, status: m.status, loaded: m.loaded, total: m.total };
        emit();
        return;
      }
      if (m.type === "status") {
        state.embed = !!m.embed; state.ner = !!m.ner; state.errors = friendly(m.errors || {});
        state.available = state.embed;
        if (!m.partial) { state.loading = false; state.progress = {}; }
        emit();
      }
      const p = m.id && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === "error") p.reject(new Error(m.message)); else p.resolve(m);
    };
    worker.onerror = (e) => {
      state.loading = false; state.reason = "err.worker"; emit();
    };
    return call("init", { allowRemote: !!(opts && opts.allowRemote), withNer: !(opts && opts.withNer === false) }, 15 * 60 * 1000).then(() => state, () => state);
  }

  async function embed(texts) {
    if (!state.embed) return null;
    const r = await call("embed", { texts }, 60000);
    return r.vectors;
  }
  async function entities(text) {
    if (!state.ner) return null;
    const r = await call("ner", { text }, 30000);
    return r.entities;
  }
  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s; // vectores ya normalizados
  }

  function restart(opts) {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;
    pending.forEach((p) => p.reject(new Error("IA reiniciada")));
    pending.clear();
    Object.assign(state, { available: false, loading: false, embed: false, ner: false, errors: {}, progress: {}, reason: "" });
    return start(opts);
  }

  root.IA = { start, restart, canRun, embed, entities, cosine, state, onChange: (fn) => { listeners.add(fn); fn(state); return () => listeners.delete(fn); } };
})(typeof self !== "undefined" ? self : this);
