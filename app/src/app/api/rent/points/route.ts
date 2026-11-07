import { getPredictions, perBedroom, terciles } from "@/lib/predictions";

/**
 * GET /api/rent/points?beds=   -> { points: [[lng, lat, value, tier], ...], cuts: [lo, hi], n }
 * value = rent without car space per bedroom (studios count as 1 bedroom).
 * tier 0/1/2 at the citywide terciles of value (over the filtered set).
 * Compact arrays rather than GeoJSON: 65k rows stay under a couple of MB.
 */
export async function GET(req: Request) {
  const beds = new URL(req.url).searchParams.get("beds");
  const bedsN = beds && beds !== "any" ? Number(beds) : null;
  try {
    const map = await getPredictions();
    const rows = [...map.values()].filter((r) => r.lat !== null && r.lng !== null && (bedsN === null || (bedsN >= 3 ? (r.bedrooms ?? 0) >= 3 : r.bedrooms === bedsN)));
    const values = rows.map(perBedroom);
    const cuts = terciles(values);
    const points = rows.map((r, i) => {
      const v = values[i];
      const tier = v < cuts[0] ? 0 : v < cuts[1] ? 1 : 2;
      return [Number(r.lng!.toFixed(5)), Number(r.lat!.toFixed(5)), Math.round(v), tier, r.gnaf_id];
    });
    return Response.json(
      { points, cuts: cuts.map(Math.round), n: points.length, min: Math.round(Math.min(...values)), max: Math.round(Math.max(...values)) },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  } catch (e) {
    return Response.json({ points: [], cuts: [0, 0], n: 0, error: String(e) }, { status: 500 });
  }
}
