// FIXTURE GENERATOR. Writes app/public/predictions.csv with ~12 real City of
// Sydney flats (real GNAF ids and coordinates from the Microburbs API) plus
// ~5,000 synthetic rows (gnaf_id FAKE000001...) jittered around suburb
// centroids so the heatmap and finder have a citywide picture.
// The pipeline overwrites this file with real data in the same columns.
//   node scripts/make-fixture.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "predictions.csv");

// Seeded PRNG so the file is reproducible.
let seed = 20261107;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// [suburb, lat, lng, 1-bed level $/wk without car space, weight (share of rows)]
const SUBURBS = [
  ["Alexandria", -33.9031, 151.1949, 720, 7],
  ["Barangaroo", -33.8614, 151.2017, 1150, 2],
  ["Beaconsfield (NSW)", -33.9115, 151.2015, 690, 1],
  ["Camperdown (NSW)", -33.8897, 151.1770, 700, 4],
  ["Centennial Park (NSW)", -33.8967, 151.2330, 800, 1],
  ["Chippendale", -33.8873, 151.1985, 760, 5],
  ["Darlinghurst", -33.8779, 151.2187, 760, 6],
  ["Darlington (Sydney - NSW)", -33.8906, 151.1935, 690, 2],
  ["Dawes Point", -33.8560, 151.2075, 1050, 1],
  ["Elizabeth Bay", -33.8717, 151.2270, 760, 4],
  ["Erskineville", -33.9030, 151.1850, 700, 4],
  ["Eveleigh", -33.8950, 151.1930, 680, 2],
  ["Forest Lodge", -33.8810, 151.1800, 690, 2],
  ["Glebe (NSW)", -33.8795, 151.1865, 720, 4],
  ["Haymarket", -33.8805, 151.2050, 820, 5],
  ["Millers Point", -33.8600, 151.2035, 1050, 2],
  ["Moore Park", -33.8920, 151.2200, 740, 1],
  ["Potts Point", -33.8705, 151.2250, 760, 6],
  ["Pyrmont", -33.8695, 151.1950, 860, 6],
  ["Redfern", -33.8930, 151.2045, 720, 6],
  ["Rosebery", -33.9195, 151.2045, 690, 5],
  ["Rushcutters Bay", -33.8750, 151.2290, 790, 2],
  ["Surry Hills", -33.8855, 151.2110, 780, 7],
  ["Sydney", -33.8688, 151.2093, 950, 8],
  ["The Rocks", -33.8590, 151.2080, 1000, 1],
  ["Ultimo", -33.8790, 151.1980, 760, 4],
  ["Waterloo (NSW)", -33.9000, 151.2080, 740, 7],
  ["Woolloomooloo", -33.8710, 151.2190, 800, 3],
  ["Zetland", -33.9080, 151.2090, 760, 6],
];
const STREETS = ["Bourke St", "Crown St", "Harris St", "Elizabeth St", "Botany Rd", "George St", "Pitt St", "Kent St", "Abercrombie St", "Danks St", "O'Dea Ave", "Macleay St", "Glebe Point Rd", "Wyndham St", "Gadigal Ave", "Defries Ave", "Cooper St", "Regent St", "Bayswater Rd", "William St"];
const BED_STEP = [-130, 0, 220, 480]; // 0,1,2,3 beds vs the 1-bed level

const REAL = [
  ["GANSW718153687", "UNIT 8/231-241 Harris Street, Pyrmont", "Pyrmont", -33.872797, 151.195371, 2, 1045, 950, 2, 48, 91, 890, "2024-03-15", 950],
  ["GANSW718969497", "UNIT 23/85 Bourke Street, Woolloomooloo", "Woolloomooloo", -33.871012, 151.218521, 2, 980, 870, 3, 36, 516, 820, "2023-11-02", 900],
  ["GANSW719361816", "UNIT 9/10-12 Macleay Street, Elizabeth Bay", "Elizabeth Bay", -33.868591, 151.226053, 1, 790, 700, 2, 24, 743, 650, "2024-06-20", 720],
  ["GANSW707922712", "UNIT 6/60-64 City Road, Chippendale", "Chippendale", -33.886889, 151.194346, 1, 760, 690, 1, 30, 647, "", "", 700],
  ["GANSW715823705", "UNIT 11/1 Danks Street, Waterloo (NSW)", "Waterloo (NSW)", -33.898052, 151.210033, 2, 1010, 890, 2, 120, 1100, 930, "2025-02-08", 900],
  ["GANSW716569787", "UNIT 1503/183 Kent Street, Millers Point", "Millers Point", -33.862851, 151.203553, 2, 1300, 1150, 15, 210, 366, 1200, "2025-09-12", 1150],
  ["GANSW717152429", "UNIT 4/84-86 Wentworth Park Road, Glebe (NSW)", "Glebe (NSW)", -33.875961, 151.190011, 2, 940, 850, 1, 18, 22, 780, "2024-01-27", 850],
  ["GANSW717531695", "UNIT 2/1-7 Bayswater Road, Potts Point", "Potts Point", -33.8751, 151.222671, 1, 720, 650, 1, 40, 79, "", "", 700],
  ["GANSW710352721", "UNIT 12/1 Henderson Road, Alexandria", "Alexandria", -33.896583, 151.198925, 2, 920, 830, 3, 64, 417, 760, "2023-08-19", 850],
  ["GANSW707985005", "UNIT 5/70 Flinders Street, Darlinghurst", "Darlinghurst", -33.883005, 151.217727, 1, 750, 680, 2, 12, 761, 620, "2022-12-03", 700],
  ["GANSW718816359", "UNIT 304/9 Kensington Street, Chippendale", "Chippendale", -33.885194, 151.201607, 2, 1060, 960, 3, 150, 206, 950, "2025-05-30", 950],
  ["GANSW717967171", "UNIT 1503/1 Sterling Circuit, Camperdown (NSW)", "Camperdown (NSW)", -33.884906, 151.176409, 3, 1240, 1140, 15, 320, 1300, 1150, "2025-07-04", 1100],
];

function drivers(beds, floor, distTrain, flats) {
  const d = [];
  if (beds >= 2) d.push({ label: `${beds} bedrooms vs suburb mix`, delta_per_week: beds === 2 ? 45 : 160 });
  else d.push({ label: beds ? "1 bedroom" : "Studio", delta_per_week: beds ? -40 : -110 });
  if (floor >= 10) d.push({ label: `Floor ${floor}, likely views`, delta_per_week: 70 });
  else if (floor >= 2) d.push({ label: `Floor ${floor}`, delta_per_week: 15 });
  else d.push({ label: "Ground or first floor", delta_per_week: -10 });
  if (distTrain <= 200) d.push({ label: `Train ${distTrain} m away`, delta_per_week: 35 });
  else if (distTrain <= 600) d.push({ label: `Train ${distTrain} m away`, delta_per_week: 10 });
  else d.push({ label: `Train ${distTrain} m away`, delta_per_week: -20 });
  if (flats >= 100) d.push({ label: `Large building (${flats} flats)`, delta_per_week: -15 });
  else d.push({ label: `Small building (${flats} flats)`, delta_per_week: 12 });
  d.push({ label: "Recent suburb rent growth", delta_per_week: 25 });
  return d;
}
function comps(street, beds, withCar, withoutCar) {
  const dates = ["2026-03-14", "2026-05-02", "2026-06-21", "2026-07-19", "2026-04-08"];
  return Array.from({ length: 4 }, () => {
    const pk = ri(0, 1);
    return {
      address: `UNIT ${ri(2, 40)}/${ri(3, 120)} ${street}`,
      bedrooms: beds,
      parking: pk,
      rent: Math.round(((pk ? withCar : withoutCar) + ri(-60, 60)) / 10) * 10,
      date: pick(dates),
      dist_m: ri(40, 420),
    };
  });
}

const csvq = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = "gnaf_id,address,suburb,lat,lng,bedrooms,rent_with_car_space,rent_without_car_space,parking_premium,floor,flats_in_building,dist_train_m,last_rent,last_rent_date,suburb_median_rent,drivers_json,comps_json";
const lines = [header];

for (const r of REAL) {
  const [g, a, s, lat, lng, b, w, wo, fl, n, dt, lr, ld, md] = r;
  const street = a.split("/", 2)[1].split(",")[0].replace(/^\S+\s/, "");
  lines.push([g, a, s, lat, lng, b, w, wo, w - wo, fl, n, dt, lr, ld, md, JSON.stringify(drivers(b, fl, dt, n)), JSON.stringify(comps(street, b, w, wo))].map(csvq).join(","));
}

const totalWeight = SUBURBS.reduce((a, s) => a + s[4], 0);
let id = 0;
const N = 5000;
for (const [name, clat, clng, level, weight] of SUBURBS) {
  const count = Math.round((N * weight) / totalWeight);
  for (let i = 0; i < count; i++) {
    id++;
    const beds = pick([0, 1, 1, 1, 2, 2, 2, 3]);
    const floor = ri(0, 22);
    const flats = pick([8, 12, 24, 40, 64, 120, 180, 260]);
    const distTrain = ri(40, 1400);
    const noise = ri(-70, 70);
    const without = Math.max(380, Math.round((level + BED_STEP[beds] + noise + (floor >= 10 ? 60 : 0) - (distTrain > 800 ? 25 : 0)) / 5) * 5);
    const premium = ri(8, 30) * 5;
    const withCar = without + premium;
    const street = pick(STREETS);
    const address = `UNIT ${floor * 100 + ri(1, 12)}/${ri(1, 180)} ${street}, ${name.replace(/\s*\(.*\)$/, "")}`;
    const lat = clat + ((rnd() - 0.5) * 2 * 600) / 111320;
    const lng = clng + ((rnd() - 0.5) * 2 * 600) / (111320 * Math.cos((clat * Math.PI) / 180));
    const hasLast = rnd() < 0.6;
    lines.push(
      [
        `FAKE${String(id).padStart(6, "0")}`,
        address,
        name,
        lat.toFixed(6),
        lng.toFixed(6),
        beds,
        withCar,
        without,
        premium,
        floor,
        flats,
        distTrain,
        hasLast ? without - ri(20, 120) : "",
        hasLast ? `202${ri(3, 5)}-${String(ri(1, 12)).padStart(2, "0")}-${String(ri(1, 28)).padStart(2, "0")}` : "",
        level + BED_STEP[beds],
        JSON.stringify(drivers(beds, floor, distTrain, flats)),
        JSON.stringify(comps(street, beds, withCar, without)),
      ]
        .map(csvq)
        .join(","),
    );
  }
}

writeFileSync(out, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${lines.length - 1} rows (${REAL.length} real + ${id} synthetic) to ${out}`);
