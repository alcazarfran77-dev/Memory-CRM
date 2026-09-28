/*
 * Memoria CRM · Worker de IA local.
 * Ejecuta modelos pre-entrenados (ONNX) en el navegador con Transformers.js,
 * fuera del hilo de la interfaz. Nada sale del equipo: los modelos se leen de
 * ./modelos/ y, solo si faltan y el usuario lo permite, se descargan una vez
 * de Hugging Face y quedan en la caché del navegador.
 */
import { pipeline, env } from "../vendor/transformers.min.js";

export const MODELS = {
  embed: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", // embeddings multilingües (384 dim)
  ner: "Xenova/bert-base-multilingual-cased-ner-hrl",     // personas, organizaciones, lugares
};

const base = new URL("../", import.meta.url);
// Runtime WebAssembly estándar (CPU). Funciona en Chrome, Edge, Firefox y Safari,
// y pesa 14 MB: cabe en la subida web de GitHub (límite 25 MB por archivo).
const ortFile = "ort-wasm-simd-threaded";

env.allowLocalModels = true;
// Ruta RELATIVA al worker (js/): Transformers.js solo busca en local los metadatos
// de archivos cuando la ruta no es una URL absoluta.
env.localModelPath = "../modelos/";
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL(`vendor/ort/${ortFile}.mjs`, base).href,
  wasm: new URL(`vendor/ort/${ortFile}.wasm`, base).href,
};
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 2) : 1;

let embedder = null;
let ner = null;

function progress(model) {
  return (p) => {
    if (p && (p.status === "progress" || p.status === "done" || p.status === "initiate")) {
      self.postMessage({ type: "progress", model, file: p.file, status: p.status, progress: p.progress ?? null, loaded: p.loaded ?? null, total: p.total ?? null });
    }
  };
}

async function load(kind, allowRemote) {
  env.allowRemoteModels = !!allowRemote;
  const task = kind === "embed" ? "feature-extraction" : "token-classification";
  return pipeline(task, MODELS[kind], { dtype: "q8", device: "wasm", progress_callback: progress(kind) });
}

self.onmessage = async (e) => {
  const { id, type } = e.data || {};
  try {
    if (type === "init") {
      const status = { embed: false, ner: false, errors: {} };
      try { embedder = await load("embed", e.data.allowRemote); status.embed = true; }
      catch (err) { status.errors.embed = String(err?.message || err); }
      self.postMessage({ type: "status", ...status, partial: true });
      if (e.data.withNer !== false) {
        try { ner = await load("ner", e.data.allowRemote); status.ner = true; }
        catch (err) { status.errors.ner = String(err?.message || err); }
      }
      self.postMessage({ id, type: "status", ...status });
      return;
    }
    if (type === "embed") {
      if (!embedder) throw new Error("Modelo de embeddings no cargado");
      const out = await embedder(e.data.texts, { pooling: "mean", normalize: true });
      const dims = out.dims[out.dims.length - 1];
      const flat = out.data;
      const vectors = [];
      for (let i = 0; i < e.data.texts.length; i++) vectors.push(Array.from(flat.slice(i * dims, (i + 1) * dims)));
      self.postMessage({ id, type: "result", vectors });
      return;
    }
    if (type === "ner") {
      if (!ner) { self.postMessage({ id, type: "result", entities: [] }); return; }
      const res = await ner(e.data.text, { aggregation_strategy: "simple" });
      const entities = (Array.isArray(res) ? res : [])
        .map((x) => ({ entity_group: String(x.entity_group || x.entity || "").replace(/^[BIES]-/, ""), word: String(x.word || "").trim(), score: Number(x.score) || 0 }))
        .filter((x) => x.entity_group && /^[\p{L}][\p{L}\p{N} .&'-]+$/u.test(x.word) && !x.word.includes("##"));
      self.postMessage({ id, type: "result", entities });
      return;
    }
    throw new Error("Mensaje desconocido: " + type);
  } catch (err) {
    self.postMessage({ id, type: "error", message: String(err?.message || err) });
  }
};
