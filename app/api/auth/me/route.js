import { resolveCaller } from "../../../../lib/tenant";
export const dynamic = "force-dynamic";
export async function GET(req) {
  try {
    const caller = await resolveCaller(req);
    return Response.json({ caller });
  } catch (e) {
    return Response.json({ caller: null, error: String(e?.message || e) }, { status: 200 });
  }
}
