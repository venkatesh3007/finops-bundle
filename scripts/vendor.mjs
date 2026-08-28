// postinstall: self-host browser-only vendor files that Next/webpack can't
// bundle (they use import.meta / load sibling .wasm at runtime).
//   public/pdf.worker.min.mjs          ← pdfjs-dist
//   public/vendor/transformers/*       ← @huggingface/transformers dist
//   public/vendor/ort/*                ← onnxruntime-web dist (wasm + WebGPU JSEP runtime)
//
// These are OPTIONAL assets for the on-device (browser) extraction path. The app
// and the server-side gateway extraction work fine without them, so this script
// MUST NEVER fail `npm install` — every step is best-effort. A hard require on a
// deep subpath (`pdfjs-dist/build/pdf.worker.min.mjs`) breaks under dependency
// version drift or a strict package `exports` map, which stalls the live-workspace
// boot (postinstall exits non-zero → install fails → dev server never starts).
import { cpSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);

// Locate a package's install dir. Prefer resolving its package.json, but fall
// back to a direct node_modules path for packages whose `exports` map hides
// ./package.json (e.g. @huggingface/transformers, onnxruntime-web). Never use
// require.resolve() on a deep file path — a strict `exports` can block that and
// take the whole install down with it.
function pkgDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    const p = join(process.cwd(), "node_modules", ...name.split("/"));
    if (existsSync(p)) return p;
    throw new Error(`cannot locate ${name} in node_modules`);
  }
}
function step(label, fn) {
  try {
    fn();
  } catch (e) {
    console.warn(`[vendor] skipped ${label}: ${String(e.message).split("\n")[0]}`);
  }
}

mkdirSync("public/vendor", { recursive: true });

step("pdf.worker", () => {
  const build = join(pkgDir("pdfjs-dist"), "build");
  const src = ["pdf.worker.min.mjs", "pdf.worker.mjs", "pdf.worker.min.js", "pdf.worker.js"]
    .map((f) => join(build, f))
    .find((p) => existsSync(p));
  if (!src) throw new Error(`no pdf.worker.* under ${build}`);
  copyFileSync(src, "public/pdf.worker.min.mjs");
});

step("transformers", () => {
  cpSync(join(pkgDir("@huggingface/transformers"), "dist"), "public/vendor/transformers", { recursive: true });
});

step("ort", () => {
  cpSync(join(pkgDir("onnxruntime-web"), "dist"), "public/vendor/ort", {
    recursive: true,
    filter: (s) => s.endsWith("dist") || /ort-wasm-simd-threaded(\.jsep|\.asyncify)?\.(mjs|wasm)$/.test(s),
  });
});

console.log("vendored: public/pdf.worker.min.mjs, public/vendor/transformers/, public/vendor/ort/");
