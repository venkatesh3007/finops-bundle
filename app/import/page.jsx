import ImportClient from "./import-client";

// Browser-side statement import: parse (pdf.js) + classify (rules → on-device
// LFM2.5) + ask + import. Always into the caller's OWN entity — the server
// resolves it from the session; there is no entity parameter.
export const dynamic = "force-dynamic";

export default function ImportPage() {
  return <ImportClient />;
}
