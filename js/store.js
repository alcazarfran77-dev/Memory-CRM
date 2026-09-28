/*
 * Memoria CRM · Almacenamiento local en IndexedDB (persistente, sin servidor).
 * Si IndexedDB no está disponible (algunas ventanas privadas), cae a memoria
 * y la app avisa para que exporten un respaldo.
 */
(function (root) {
  "use strict";
  const DB_NAME = "memoria-crm";
  const VERSION = 1;
  const COLS = ["clients", "notes", "promises"];
  let db = null;
  let memory = null; // respaldo en memoria

  function req(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }

  async function open() {
    try {
      if (!root.indexedDB) throw new Error("IndexedDB no disponible");
      const r = root.indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const c of COLS) if (!d.objectStoreNames.contains(c)) d.createObjectStore(c, { keyPath: "id" });
      };
      db = await req(r);
      // Pedir almacenamiento persistente para que el navegador no lo borre por espacio.
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
      return "indexeddb";
    } catch (e) {
      memory = { clients: new Map(), notes: new Map(), promises: new Map() };
      return "memoria";
    }
  }

  async function all(col) {
    if (memory) return [...memory[col].values()];
    return req(db.transaction(col).objectStore(col).getAll());
  }
  async function put(col, obj) {
    if (memory) { memory[col].set(obj.id, obj); return; }
    const tx = db.transaction(col, "readwrite");
    tx.objectStore(col).put(obj);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function del(col, id) {
    if (memory) { memory[col].delete(id); return; }
    const tx = db.transaction(col, "readwrite");
    tx.objectStore(col).delete(id);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function exportAll() {
    const out = { app: "memoria-crm", version: 1, exportedAt: new Date().toISOString() };
    for (const c of COLS) out[c] = await all(c);
    return out;
  }
  /** mode "merge": añade/actualiza por id. mode "replace": borra todo antes. */
  async function importAll(data, mode) {
    if (!data || data.app !== "memoria-crm") throw new Error("El archivo no es un respaldo de Memoria CRM");
    if (mode === "replace") {
      for (const c of COLS) for (const x of await all(c)) await del(c, x.id);
    }
    let n = 0;
    for (const c of COLS) for (const x of data[c] || []) { if (x && x.id) { await put(c, x); n++; } }
    return n;
  }

  root.Store = { open, all, put, del, exportAll, importAll, COLS };
})(typeof self !== "undefined" ? self : this);
