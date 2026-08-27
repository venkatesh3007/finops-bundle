// postinstall: self-host browser-only vendor files that Next/webpack can't
// bundle (they use import.meta / load sibling .wasm at runtime).
//   public/pdf.worker.min.mjs          ← pdfjs-dist
//   public/vendor/transformers/*       ← @huggingface/transformers dist (self-contained transformers.min.js)
//   public/vendor/ort/*                ← onnxruntime-web dist (wasm + WebGPU JSEP runtime)
import { cpSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
mkdirSync("public/vendor", { recursive: true });
copyFileSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"), "public/pdf.worker.min.mjs");
const tdist = join("node_modules", "@huggingface", "transformers", "dist");
cpSync(tdist, "public/vendor/transformers", { recursive: true });
cpSync(join("node_modules", "onnxruntime-web", "dist"), "public/vendor/ort", { recursive: true, filter: (src) => src.endsWith("dist") || /ort-wasm-simd-threaded(\.jsep|\.asyncify)?\.(mjs|wasm)$/.test(src) });
console.log("vendored: public/pdf.worker.min.mjs, public/vendor/transformers/, public/vendor/ort/");
