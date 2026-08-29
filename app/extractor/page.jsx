import ExtractorClient from "./extractor-client";

// The extractor lab: the statement extractor's own code, the statements it is
// graded on, and the loop that rewrites it when you report a parsing problem.
export const dynamic = "force-dynamic";

export default function ExtractorPage() {
  return <ExtractorClient />;
}
