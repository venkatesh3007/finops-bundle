import StudioClient from "./studio-client";

// The working session: chat + the work as it happens on the left, statements on
// the right. Parsing writes code per layout (lib/parser/codegen.js) and runs as
// a cancellable background job (lib/jobs/store.js).
export const dynamic = "force-dynamic";

export default function StudioPage() {
  return <StudioClient />;
}
