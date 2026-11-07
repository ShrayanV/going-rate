/** Shapes of the data the app reads. `data` from the API may be null. */

export type Driver = { label: string; delta_per_week: number };
export type Comp = { address: string; bedrooms?: number | null; parking?: number | null; rent: number; date?: string; dist_m?: number | null };

export type RentRow = {
  gnaf_id: string;
  address: string;
  suburb: string;
  lat: number | null;
  lng: number | null;
  bedrooms: number | null;
  rent_with_car_space: number;
  rent_without_car_space: number;
  parking_premium: number;
  floor: number | null;
  flats_in_building: number | null;
  dist_train_m: number | null;
  last_rent: number | null;
  last_rent_date: string | null;
  suburb_median_rent: number | null;
  /** From the supplied input file when it is present locally (not part of the predictions contract). */
  bathrooms?: number | null;
  car_space?: number | null;
  property_type?: string | null;
  drivers: Driver[];
  comps: Comp[];
};

export type AddressMatch = { id: string; display_name: string; sal?: string | null; property_type?: string | null };
export type SuburbListItem = { suburb: string; state?: string };

export type Basics = {
  bed_count: number | null;
  bath_count: number | null;
  parking_count: number | null;
  dwelling_type: string | null;
  land_area_sqm: number | null;
};

export type Stop = { name?: string; label?: string; distance_m: number; lat: number; lng: number } | null;
export type Transport = {
  center_lat: number;
  center_lng: number;
  counts: { train?: number; tram?: number; bus?: number; ferry?: number };
  nearest: { train?: Stop; tram?: Stop; bus?: Stop; ferry?: Stop };
};

export type Amenities = {
  counts: { supermarket?: number; green_spaces?: number; restaurant?: number };
  results: { name: string; category: string; distance_m: number }[];
};

export type Sale = {
  address: string;
  property_type?: string;
  price: number;
  date_sold: string;
  dist_km: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  garage_spaces?: number | null;
  gnaf_pid?: string;
  latitude?: number;
  longitude?: number;
};
export type RentHistoryItem = { date?: string; type?: string; address?: string; price?: number | null; rent?: number | null };
export type Avm = {
  predicted_price: number | null;
  predicted_price_low: number | null;
  predicted_price_high: number | null;
  confidence_score: number | null;
};
export type Da = { area_name: string; description: string; date: string; category?: string; lat?: number; lng?: number };
export type MedianRent = { house: number | null; unit: number | null; as_of?: string };
export type Point = { date: string; value: number };
export type MedianRentSeries = { house: Point[] | null; unit: Point[] | null };
export type PublicHousing = {
  name?: string;
  value?: string;
  on_property?: boolean;
  nearest_distance_m?: number | null;
  search_radius_m?: number;
};

export const CITY_CENTRE: [number, number] = [151.2093, -33.8688];

/** "Glebe (NSW)" -> "Glebe" */
export const shortName = (s: string) => s.replace(/\s*\(.*\)$/, "");
export const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
export const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
export const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bUnit\b/, "Unit");

/**
 * Human address line without the suburb/postcode, for both shapes we see:
 *   API  "UNIT 8/231-241 Harris Street, Pyrmont"      -> "Unit 8/231-241 Harris Street"
 *   CSV  "UNIT 99, 93-105 QUAY STREET HAYMARKET 2000" -> "Unit 99/93-105 Quay Street"
 */
export function addressLine(s: string, sal?: string | null): string {
  let line = s.trim();
  if (/\s\d{4}$/.test(line)) {
    line = line.replace(/\s+\d{4}$/, "");
    const sub = sal ? shortName(sal) : null;
    if (sub && line.toUpperCase().endsWith(" " + sub.toUpperCase())) line = line.slice(0, -sub.length - 1);
    line = line.replace(/^((?:UNIT|LEVEL|SHOP|FLAT|SUITE)\s+\S+),\s*/i, "$1/");
  } else {
    line = line.replace(/,\s*[^,]+$/, "");
  }
  return titleCase(line);
}
