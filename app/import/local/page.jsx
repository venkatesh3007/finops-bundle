import LocalClient from "./local-client";

// Optional private mode: parse + classify + ask entirely on-device (LFM2.5 via
// WebGPU). The main /import flow uses frontier extraction through the gateway.
export const dynamic = "force-dynamic";

export default function LocalImportPage() {
  return <LocalClient />;
}
