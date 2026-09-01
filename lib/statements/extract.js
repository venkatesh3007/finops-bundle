// Statement extraction — now a thin shim over the EXTRACTOR LAB.
//
// The logic that used to live here (prompt, chunking, post-processing) is a
// versioned module per entity: lib/extractor/*. This keeps the old entry point
// so callers don't care, but every extraction runs whichever version is active
// for that book — including versions the lab wrote for itself after you reported
// a parsing problem. See lib/extractor/lab.js.
import { activeVersion } from "../extractor/store.js";
import { extractWithModule } from "../extractor/run.js";
import { gatewayConfigured } from "./gateway.js";

export const extractConfigured = gatewayConfigured;

export async function extractStatement({ entity, pages, text, filename = "", bank = "", period = null, rules = "", hint = "", onNote = null, repair = true } = {}) {
  if (!gatewayConfigured()) return { error: "extract_not_configured" };
  if (!entity) return { error: "no entity — extraction is always scoped to one book" };
  const version = await activeVersion(entity);
  try {
    const out = await extractWithModule({ source: version.source, pages, text, filename, bank, period, rules, hint, onNote, repair });
    return out.error ? out : { ...out, extractor_version: version.version };
  } catch (e) {
    // A bad self-written module must never take extraction down: fall back to the
    // baseline and flag it, so the lab's mistake is visible but not fatal.
    if (version.version === 1) throw e;
    const base = await activeVersion(entity); // re-read in case another request already reverted
    const { BASELINE_SOURCE } = await import("../extractor/baseline.js");
    const out = await extractWithModule({ source: BASELINE_SOURCE, pages, text, filename, bank, period, rules, hint, onNote, repair });
    return { ...out, extractor_version: base.version, extractor_fallback: `version ${version.version} failed (${String(e.message || e).slice(0, 160)}) — used the baseline for this run` };
  }
}
