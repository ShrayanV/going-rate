import { getPredictions } from "@/lib/predictions";
import { CITY_CENTRE, type RentRow } from "@/lib/types";

/**
 * GET /api/rent/find?budget=900&beds=any|0|1|2|3&parking=yes|any&near_train=1&sort=city|cheapest|value|train|priciest
 * -> { data: FindHit[] (top 40), matched }
 *
 * parking=yes keeps only flats that HAVE a car space (and prices them with it).
 * Otherwise each flat is priced as it actually comes (with its car space if it has one).
 */
export type FindHit = {
  gnaf_id: string;
  address: string;
  suburb: string;
  lat: number;
  lng: number;
  bedrooms: number | null;
  bathrooms: number | null;
  car_space: number | null;
  floor: number | null;
  rent: number;
  under: number;
  /** Estimate minus the same-bedroom suburb median: negative = cheaper than typical for the area. */
  vs_suburb: number | null;
  dist_train_m: number | null;
  dist_cbd_m: number;
};

export type SortKey = "city" | "cheapest" | "value" | "train" | "priciest";

const distCbd = (r: RentRow) => {
  const dLat = (r.lat! - CITY_CENTRE[1]) * 111320;
  const dLng = (r.lng! - CITY_CENTRE[0]) * 111320 * Math.cos((CITY_CENTRE[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

function valueScore(h: FindHit) {
  if (h.vs_suburb == null) return 1;
  const median = h.rent - h.vs_suburb;
  const r = median > 0 ? h.vs_suburb / median : 0;
  return r < -0.35 ? 1 + r : r;
}

const SORTS: Record<SortKey, (a: FindHit, b: FindHit) => number> = {
  city: (a, b) => a.dist_cbd_m - b.dist_cbd_m || a.rent - b.rent,
  cheapest: (a, b) => a.rent - b.rent || a.dist_cbd_m - b.dist_cbd_m,
  priciest: (a, b) => b.rent - a.rent || a.dist_cbd_m - b.dist_cbd_m,
  // Cheapest relative to the area, as a share of the area median; gaps beyond 35% are
  // more likely model noise than bargains, so they sort after the believable ones.
  value: (a, b) => valueScore(a) - valueScore(b) || a.rent - b.rent,
  train: (a, b) => (a.dist_train_m ?? 1e9) - (b.dist_train_m ?? 1e9) || a.rent - b.rent,
};

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const budget = Number(q.get("budget"));
  if (!Number.isFinite(budget) || budget <= 0) return Response.json({ data: [], matched: 0, error: "budget required" }, { status: 400 });
  const beds = q.get("beds") ?? "any";
  const bedsN = beds === "any" ? null : Number(beds);
  const needCar = q.get("parking") === "yes";
  const nearTrain = q.get("near_train") === "1" || q.get("near_train") === "true";
  const sortKey = (q.get("sort") as SortKey) in SORTS ? (q.get("sort") as SortKey) : "city";

  try {
    const map = await getPredictions();
    const hits: FindHit[] = [];
    for (const r of map.values()) {
      if (r.lat === null || r.lng === null) continue;
      if (/^(SHOP|OFFICE|SUITE|KIOSK)\b/i.test(r.address)) continue; // not homes
      if (bedsN !== null && !(bedsN >= 3 ? (r.bedrooms ?? 0) >= 3 : r.bedrooms === bedsN)) continue;
      if (nearTrain && !(r.dist_train_m !== null && r.dist_train_m <= 600)) continue;
      if (needCar && r.car_space !== 1) continue;
      const rent = r.car_space === 1 ? r.rent_with_car_space : r.rent_without_car_space;
      if (rent > budget) continue;
      // Drop model outliers below the 1st percentile of recent adverts for that bedroom count.
      const floor = (r.bedrooms ?? 1) <= 0 ? 310 : r.bedrooms === 1 ? 400 : r.bedrooms === 2 ? 700 : 879;
      if (rent <= floor) continue; // exactly at the floor = a clamped outlier, not a real estimate
      hits.push({
        gnaf_id: r.gnaf_id,
        address: r.address,
        suburb: r.suburb,
        lat: r.lat,
        lng: r.lng,
        bedrooms: r.bedrooms,
        bathrooms: r.bathrooms ?? null,
        car_space: r.car_space ?? null,
        floor: r.floor,
        rent,
        under: budget - rent,
        vs_suburb: r.suburb_median_rent != null ? Math.round(rent - r.suburb_median_rent) : null,
        dist_train_m: r.dist_train_m,
        dist_cbd_m: Math.round(distCbd(r)),
      });
    }
    hits.sort(SORTS[sortKey]);
    // At most two flats per building so the list covers more of the city.
    const perBuilding = new Map<string, number>();
    const out: FindHit[] = [];
    for (const h of hits) {
      const key = h.address.replace(/^(UNIT|FLAT|APARTMENT|LEVEL)\s+\S+,\s*/i, "");
      const n = perBuilding.get(key) ?? 0;
      if (n >= 2) continue;
      perBuilding.set(key, n + 1);
      out.push(h);
      if (out.length >= 40) break;
    }
    return Response.json({ data: out, matched: hits.length, sort: sortKey });
  } catch (e) {
    return Response.json({ data: [], matched: 0, error: String(e) }, { status: 500 });
  }
}
