import { readFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import type { RentRow } from "@/lib/types";

/**
 * Server-only loader for public/predictions.csv (see CONTRACT.md).
 * Parsed once per process and cached; only the contract's columns are read.
 */
let cache: Promise<Map<string, RentRow>> | null = null;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s.trim()) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function load(): Promise<Map<string, RentRow>> {
  // private/ is never served as a static file (unlike public/), so supplied-data-derived
  // fields such as comparable adverts are only reachable through our API routes.
  const candidates = [path.join(process.cwd(), "private", "predictions.csv"), path.join(process.cwd(), "public", "predictions.csv")];
  let text = "";
  for (const f of candidates) {
    try {
      text = await readFile(f, "utf8");
      break;
    } catch {
      /* try the next location */
    }
  }
  if (!text) throw new Error("predictions.csv not found in private/ or public/");
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const map = new Map<string, RentRow>();
  for (const r of parsed.data) {
    if (!r.gnaf_id) continue;
    const withCar = num(r.rent_with_car_space);
    const withoutCar = num(r.rent_without_car_space);
    if (withCar === null || withoutCar === null) continue;
    map.set(r.gnaf_id, {
      gnaf_id: r.gnaf_id,
      address: r.address ?? "",
      suburb: r.suburb ?? "",
      lat: num(r.lat),
      lng: num(r.lng),
      bedrooms: num(r.bedrooms),
      rent_with_car_space: withCar,
      rent_without_car_space: withoutCar,
      parking_premium: num(r.parking_premium) ?? withCar - withoutCar,
      floor: num(r.floor),
      flats_in_building: num(r.flats_in_building),
      dist_train_m: num(r.dist_train_m),
      last_rent: num(r.last_rent),
      last_rent_date: r.last_rent_date || null,
      suburb_median_rent: num(r.suburb_median_rent),
      bathrooms: r.bathrooms !== undefined ? num(r.bathrooms) : undefined,
      car_space: r.car_space !== undefined ? num(r.car_space) : undefined,
      property_type: r.property_type !== undefined ? r.property_type || null : undefined,
      drivers: parseJson(r.drivers_json, []),
      comps: parseJson(r.comps_json, []),
    });
  }
  // Enrich with the flat's own facts from the supplied input file, when it is present on this machine.
  // (The file is never committed; without it these fields stay undefined and the UI omits them.)
  try {
    const inputFile = path.join(process.cwd(), "..", "data", "rents-input-flats-city-of-sydney.csv");
    const inText = await readFile(inputFile, "utf8");
    const inParsed = Papa.parse<Record<string, string>>(inText, { header: true, skipEmptyLines: true });
    for (const r of inParsed.data) {
      const row = map.get(r.gnaf_id);
      if (!row || row.car_space !== undefined) continue; // already carried in the predictions file
      row.bathrooms = num(r.bathrooms);
      row.car_space = num(r.car_space);
      row.property_type = r.property_type || null;
      if (row.floor === null) row.floor = num(r.floor_level);
    }
  } catch {
    /* input file not available: fine */
  }
  return map;
}

export function getPredictions(): Promise<Map<string, RentRow>> {
  cache ??= load().catch((e) => {
    cache = null;
    throw e;
  });
  return cache;
}

/** Rent per bedroom, the heatmap's value; studios count as one bedroom. */
export const perBedroom = (r: RentRow) => r.rent_without_car_space / Math.max(1, r.bedrooms ?? 1);

/** Terciles of a numeric array: [lower cut, upper cut]. */
export function terciles(values: number[]): [number, number] {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return [0, 0];
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return [q(1 / 3), q(2 / 3)];
}
