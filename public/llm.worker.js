// Web Worker: LFM2.5 via Transformers.js (ONNX Runtime Web, WebGPU). All
// inference happens here so the UI thread stays responsive. Nothing leaves the
// browser — the model weights are fetched once from Hugging Face and cached.
//
// protocol (postMessage):
//   → { type:'load', model }                 ← { type:'progress', ... } | { type:'ready', device } | { type:'error' }
//   → { type:'generate', id, messages, max_new_tokens }
//                                            ← { type:'token', id, text } … { type:'done', id, text }
// Static module worker (public/, NOT bundled by Next): Transformers.js is
// self-hosted from /vendor/transformers/ (copied from node_modules on postinstall).
import { pipeline, env, TextStreamer } from "/vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
// ONNX Runtime Web wasm/JSEP files are self-hosted too (no CDN at runtime).
env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";

const MODELS = {
  "lfm2.5-1.2b": { id: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX", dtype: "q4f16", label: "LFM2.5 1.2B (≈0.9 GB, best answers)" },
  "lfm2.5-350m": { id: "onnx-community/LFM2.5-350M-ONNX", dtype: "q4f16", label: "LFM2.5 350M (≈0.3 GB, fast)" },
};

let generator = null, current = null, device = null;

async function load(key) {
  const spec = MODELS[key] || MODELS["lfm2.5-1.2b"];
  if (generator && current === key) return;
  generator = null; current = key;
  const progress_callback = (p) => postMessage({ type: "progress", file: p.file, progress: p.progress, status: p.status, loaded: p.loaded, total: p.total });
  const hasGpu = typeof navigator !== "undefined" && !!navigator.gpu;
  const tryDevice = async (dev) => pipeline("text-generation", spec.id, { dtype: spec.dtype, device: dev, progress_callback });
  try {
    if (!hasGpu) throw new Error("no WebGPU");
    generator = await tryDevice("webgpu"); device = "webgpu";
  } catch (e) {
    postMessage({ type: "progress", status: "fallback", note: `WebGPU unavailable (${e.message}); using WASM — slower` });
    generator = await tryDevice("wasm"); device = "wasm";
  }
  postMessage({ type: "ready", model: spec.id, device });
}

async function generate({ id, messages, max_new_tokens = 256 }) {
  if (!generator) throw new Error("model not loaded");
  let text = "";
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (t) => { text += t; postMessage({ type: "token", id, text: t }); },
  });
  const out = await generator(messages, { max_new_tokens, do_sample: false, temperature: 0, repetition_penalty: 1.05, return_full_text: false, streamer });
  const full = out?.[0]?.generated_text;
  const final = typeof full === "string" ? full : Array.isArray(full) ? full.at(-1)?.content ?? text : text;
  postMessage({ type: "done", id, text: final || text });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") await load(msg.model);
    else if (msg.type === "generate") await generate(msg);
  } catch (err) {
    postMessage({ type: "error", id: msg.id, error: String(err?.message || err) });
  }
};
