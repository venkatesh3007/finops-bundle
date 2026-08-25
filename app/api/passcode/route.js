export async function POST(req) {
  const { code } = await req.json();
  const expected = process.env.APP_PASSCODE;
  if (!expected || code !== expected) return Response.json({ error: "wrong passcode" }, { status: 401 });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: {
    "Content-Type": "application/json",
    "Set-Cookie": `fo_auth=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`,
  } });
}
