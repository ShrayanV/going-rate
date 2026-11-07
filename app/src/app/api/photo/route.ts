/**
 * GET /api/photo?lat=&lng=
 * -> { data: { url, captured_at, id } | null }
 *
 * The nearest Mapillary street-level photo within ~60 m, if a MAPILLARY_TOKEN is set
 * (free client token from mapillary.com/dashboard/developers). Without a token this
 * returns data: null and the panel simply shows the Street View link instead.
 * The token stays on the server.
 */
type MlyImage = { id: string; thumb_1024_url?: string; captured_at?: number; compass_angle?: number; geometry?: { coordinates: [number, number] } };

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat"));
  const lng = Number(q.get("lng"));
  const token = process.env.MAPILLARY_TOKEN;
  if (!token || !Number.isFinite(lat) || !Number.isFinite(lng)) return Response.json({ data: null });

  const d = 0.0006; // ~60 m box
  const url =
    `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}` +
    `&fields=id,thumb_1024_url,captured_at,compass_angle,geometry&limit=60` +
    `&bbox=${lng - d},${lat - d},${lng + d},${lat + d}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return Response.json({ data: null, reason: `mapillary ${r.status}` });
    const j = (await r.json()) as { data?: MlyImage[] };
    const imgs = (j.data ?? []).filter((x) => x.thumb_1024_url && x.geometry);
    if (!imgs.length) return Response.json({ data: null, reason: "no photos nearby" });
    // Score each photo: metres away, plus a penalty when the camera is not pointing at the
    // building, plus a small one for old captures. Lowest score wins.
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const score = (x: MlyImage) => {
      const [x0, y0] = x.geometry!.coordinates;
      const dx = (lng - x0) * kx;
      const dy = (lat - y0) * 111320;
      const metres = Math.hypot(dx, dy);
      if (metres < 6) return 1e6; // standing inside/at the doorstep: no view of the facade
      const towards = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      const off = x.compass_angle == null ? 90 : Math.abs(((x.compass_angle - towards + 540) % 360) - 180);
      const ageYears = x.captured_at ? (Date.now() - x.captured_at) / 3.15e10 : 5;
      return metres + off * 0.6 + ageYears * 3;
    };
    imgs.sort((a, b) => score(a) - score(b));
    const best = imgs[0];
    // Only keep a photo that is close and pointing at the building; otherwise no photo
    // (the panel still offers the Street View link, which always lands on the right spot).
    {
      const [x0, y0] = best.geometry!.coordinates;
      const metres = Math.hypot((lng - x0) * kx, (lat - y0) * 111320);
      const towards = ((Math.atan2((lng - x0) * kx, (lat - y0) * 111320) * 180) / Math.PI + 360) % 360;
      const off = best.compass_angle == null ? 180 : Math.abs(((best.compass_angle - towards + 540) % 360) - 180);
      if (metres > 40 || off > 50) return Response.json({ data: null, reason: "no photo facing the building" });
    }
    return Response.json(
      { data: { id: best.id, url: best.thumb_1024_url, captured_at: best.captured_at ? new Date(best.captured_at).toISOString().slice(0, 10) : null } },
      { headers: { "cache-control": "public, max-age=3600" } },
    );
  } catch (e) {
    return Response.json({ data: null, reason: `fetch failed: ${String(e).slice(0, 120)}` });
  }
}
