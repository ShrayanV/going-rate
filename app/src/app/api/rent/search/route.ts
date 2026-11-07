import { getPredictions } from "@/lib/predictions";
import type { RentRow } from "@/lib/types";

/**
 * GET /api/rent/search?q=2 bed in surry hills under 1200
 * -> { suburb, beds, budget, matched, data: SearchHit[] (top 8) }  or  { outside: "Burwood", data: [] }
 * Natural-language listing search over predictions. Returns data: [] when the query
 * has no beds/budget token and names no City of Sydney suburb, so address search is unaffected.
 */
export type SearchHit = { gnaf_id: string; address: string; suburb: string; lat: number; lng: number; bedrooms: number | null; rent: number };

const strip = (s: string) => s.replace(/\s*\(.*\)$/, "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

type SuburbInfo = { raw: string; name: string; key: string; count: number; lat: number; lng: number };
let suburbCache: Promise<SuburbInfo[]> | null = null;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function suburbs(map: Map<string, RentRow>): Promise<SuburbInfo[]> {
  suburbCache ??= Promise.resolve().then(() => {
    const by = new Map<string, { lat: number[]; lng: number[] }>();
    for (const r of map.values()) {
      if (!r.suburb || r.lat === null || r.lng === null) continue;
      const g = by.get(r.suburb) ?? { lat: [], lng: [] };
      g.lat.push(r.lat);
      g.lng.push(r.lng);
      by.set(r.suburb, g);
    }
    return [...by.entries()].map(([raw, g]) => ({ raw, name: strip(raw), key: norm(strip(raw)), count: g.lat.length, lat: median(g.lat), lng: median(g.lng) }));
  });
  return suburbCache;
}

const FILLER = new Set(["in", "at", "near", "around", "flat", "flats", "apartment", "apartments", "unit", "units", "for", "rent", "rental", "a", "an", "with", "and", "to", "me", "show", "find", "cheap", "pw", "per", "week", "wk", "bed", "beds", "bedroom", "bedrooms"]);

/** Pick the suburb named by the leftover words: exact, then word-prefix ("eliz bay", "surry"), then contained full name. */
function matchSuburb(words: string[], subs: SuburbInfo[]): SuburbInfo | null {
  const text = words.join(" ");
  if (text.length < 3) return null;
  const best = (xs: SuburbInfo[]) => (xs.length ? xs.reduce((a, b) => (b.count > a.count ? b : a)) : null);
  const exact = subs.find((s) => s.key === text);
  if (exact) return exact;
  // every leftover word is a prefix of the corresponding suburb word
  const prefix = subs.filter((s) => {
    const sw = s.key.split(" ");
    return words.length <= sw.length && words.every((w, i) => sw[i].startsWith(w));
  });
  if (prefix.length) return best(prefix);
  // the suburb's full name appears somewhere in the leftover ("surry hills near station")
  return best(subs.filter((s) => ` ${text} `.includes(` ${s.key} `)));
}

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").toLowerCase().trim();
  if (q.length < 2) return Response.json({ data: [], matched: 0 });

  let rest = ` ${q} `;
  let beds: number | null = null;
  let bedsPlus = false;
  let budget: number | null = null;

  // budget: "under 900", "< $900", "max 900", "below 1.2k", "up to 900", "$900"
  const money = /(?:under|below|max|maximum|up to|upto|less than|<=?|budget)\s*\$?\s*(\d+(?:\.\d+)?)\s*(k)?|\$\s*(\d+(?:\.\d+)?)\s*(k)?/;
  const mm = rest.match(money);
  if (mm) {
    const n = Number(mm[1] ?? mm[3]) * (mm[2] || mm[4] ? 1000 : 1);
    if (Number.isFinite(n) && n >= 100 && n <= 20000) budget = Math.round(n);
    rest = rest.replace(mm[0], " ");
  }
  // beds: "studio", "0 bed", "2br", "2 bedroom", "3+ beds"
  const bm = rest.match(/(\d)\s*(\+)?\s*(?:-\s*)?(?:bed(?:room)?s?|br|bdr|bdrm)\b/);
  if (bm) {
    beds = Number(bm[1]);
    bedsPlus = !!bm[2] || beds >= 3;
    rest = rest.replace(bm[0], " ");
  } else if (/\bstudios?\b/.test(rest)) {
    beds = 0;
    rest = rest.replace(/\bstudios?\b/, " ");
  }

  const hasDigits = /\d/.test(rest);
  const words = norm(rest)
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
  const hasToken = beds !== null || budget !== null;

  try {
    const map = await getPredictions();
    const subs = await suburbs(map);
    // Leftover digits mean a street address ("26 tudor street sydney"): leave it to the geocoder unless filters were typed.
    const sub = hasDigits && !hasToken ? null : matchSuburb(words, subs);

    if (!sub) {
      const left = words.join(" ");
      if (hasToken && !hasDigits && /^[a-z ]+$/.test(left) && left.replace(/ /g, "").length >= 3) {
        const outside = left.replace(/\b[a-z]/g, (c) => c.toUpperCase());
        return Response.json({ outside, beds, budget, data: [], matched: 0 });
      }
      if (!hasToken) return Response.json({ data: [], matched: 0 });
    }

    const hits: (SearchHit & { d: number })[] = [];
    const cLat = sub?.lat ?? -33.8688;
    const cLng = sub?.lng ?? 151.2093;
    const kx = Math.cos((cLat * Math.PI) / 180);
    for (const r of map.values()) {
      if (r.lat === null || r.lng === null) continue;
      if (/^(SHOP|OFFICE|SUITE|KIOSK)\b/i.test(r.address)) continue; // not homes
      if (sub && r.suburb !== sub.raw) continue;
      if (beds !== null && !(bedsPlus ? (r.bedrooms ?? 0) >= beds : r.bedrooms === beds)) continue;
      const rent = r.car_space === 1 ? r.rent_with_car_space : r.rent_without_car_space;
      if (budget !== null) {
        if (rent > budget) continue;
        // Same outlier floor as /api/rent/find: drop model results below the 1st percentile of adverts.
        const floor = (r.bedrooms ?? 1) <= 0 ? 310 : r.bedrooms === 1 ? 400 : r.bedrooms === 2 ? 700 : 879;
        if (rent < floor) continue;
      }
      const d = Math.hypot(r.lat - cLat, (r.lng - cLng) * kx);
      hits.push({ gnaf_id: r.gnaf_id, address: r.address, suburb: r.suburb, lat: r.lat, lng: r.lng, bedrooms: r.bedrooms, rent: Math.round(rent), d });
    }
    hits.sort(budget !== null ? (a, b) => a.rent - b.rent || a.d - b.d : (a, b) => a.d - b.d);
    // At most two flats per building so the list spans the suburb rather than one tower.
    const perBuilding = new Map<string, number>();
    const data: SearchHit[] = [];
    for (const hit of hits) {
      const h: SearchHit = { gnaf_id: hit.gnaf_id, address: hit.address, suburb: hit.suburb, lat: hit.lat, lng: hit.lng, bedrooms: hit.bedrooms, rent: hit.rent };
      const b = h.address.replace(/^[^,]*,\s*/, "");
      const n = perBuilding.get(b) ?? 0;
      if (n >= 2) continue;
      perBuilding.set(b, n + 1);
      data.push(h);
      if (data.length >= 8) break;
    }
    return Response.json({ suburb: sub?.name ?? null, beds, beds_plus: bedsPlus, budget, matched: hits.length, data });
  } catch (e) {
    return Response.json({ data: [], matched: 0, error: String(e) }, { status: 500 });
  }
}
