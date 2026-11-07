import type { NextRequest } from "next/server";

/**
 * GET /api/mb/v1/... -> GET ${MICROBURBS_API_BASE}/v1/...
 * The browser never sees the key; this route adds it server-side.
 */
const API_BASE = (process.env.MICROBURBS_API_BASE || "https://api-ht.microburbs.com.au").replace(/\/+$/, "");

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path[0] !== "v1") {
    return Response.json({ detail: "Only /v1/ paths are forwarded." }, { status: 404 });
  }
  const key = process.env.MICROBURBS_API_KEY;
  if (!key) return Response.json({ detail: "MICROBURBS_API_KEY is not set (see app/.env.local)." }, { status: 500 });

  const upstreamPath = "/" + path.map(encodeURIComponent).join("/") + req.nextUrl.search;
  const t0 = Date.now();
  try {
    const r = await fetch(`${API_BASE}${upstreamPath}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
    });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        "content-type": r.headers.get("content-type") || "application/json",
        "cache-control": r.ok ? "public, max-age=300" : "no-store",
        "x-upstream-url": `${API_BASE}${upstreamPath}`,
        "x-upstream-ms": String(Date.now() - t0),
      },
    });
  } catch (e) {
    return Response.json({ detail: `Upstream unreachable: ${String(e)}` }, { status: 502 });
  }
}
