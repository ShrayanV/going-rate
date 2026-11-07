# External data sources (fetched 2026-11-07, hard information cutoff 2026-07-31)

All outputs live in `pipeline/cache/` (gitignored). Re-run with
`python pipeline/external/fetch_all.py` (idempotent; skips cached outputs).
Raw downloads are kept per source under `pipeline/cache/raw/<source>/`.
Nothing dated after 2026-07-31 is used; later rows are dropped and counted in the script logs.

| # | Source | Script | Outputs (pipeline/cache/) | Join key |
|---|--------|--------|---------------------------|----------|
| 1 | NSW Fair Trading rental bond lodgements | `fetch_bonds.py` | `bonds_city_of_sydney.csv`, `bonds_postcode_bed_month.csv` | postcode, bedrooms, month |
| 2 | Microburbs suburb median-rent series | `fetch_microburbs.py` | `suburb_unit_rent_series.csv`, `suburb_rent_index.csv` | suburb |
| 3 | Microburbs development applications | `fetch_microburbs.py` | `das_city_of_sydney.csv` | suburb, lat/lng |
| 4 | OpenStreetMap (Overpass) | `fetch_osm.py` | `osm_buildings.csv`, `osm_major_roads_nodes.csv`, `osm_green_water_nodes.csv`, `osm_supermarkets.csv` | lat/lng |

## 1. NSW rental bond lodgement data
- URL: https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data
  (also catalogued at https://data.nsw.gov.au/data/dataset/rental-bond-lodgement)
- Licence: Creative Commons Attribution 4.0 (CC BY 4.0), NSW Fair Trading.
- Fetched: 2026-11-07. 31 monthly XLSX files, Jan 2024 to Jul 2026 (Aug/Sep 2026 files exist on the page but are after the cutoff and were NOT downloaded).
- Filter: postcode in the 15 City of Sydney postcodes (2000, 2007, 2008, 2009, 2010, 2011, 2015, 2016, 2017, 2018, 2021, 2037, 2042, 2043, 2050), dwelling type `F` (flat/unit), weekly rent 100..5000, bedrooms known. 836,743 raw rows -> 79,947 bonds kept; 0 rows after cutoff.
- `bonds_city_of_sydney.csv`: `month, postcode, dwelling_type, bedrooms, weekly_rent` (one row per bond, actual agreed rent at lodgement).
- `bonds_postcode_bed_month.csv`: `month, postcode, bedrooms, n, median_rent, p25, p75` (1,950 rows).
- Attribution line: "Rental bond lodgement data: NSW Fair Trading, licensed under CC BY 4.0."

## 2. Microburbs suburb unit median-rent series
- URL: `GET https://api-ht.microburbs.com.au/v1/suburbs/{name}/market/median-rent-series` for each of the 29 suburbs in `/v1/suburbs/list`.
- Licence: hackathon API terms (Microburbs); use for this event only, no republishing of raw data.
- Fetched: 2026-11-07. Unit series only; 8,721 rows (2012-01 .. 2026-07-26); 404 rows dated after 2026-07-31 dropped.
- `suburb_unit_rent_series.csv`: `suburb, date, unit_median_rent`.
- `suburb_rent_index.csv`: `suburb, suburb_clean, unit_rent_2026_07, unit_rent_2025_07, yoy_change_pct, last_date` (29 rows; `suburb` is the exact API name e.g. "Glebe (NSW)", `suburb_clean` strips the suffix).
- Attribution line: "Suburb rent series and development applications: Microburbs API (hackathon licence)."

## 3. Microburbs development applications
- URL: `GET https://api-ht.microburbs.com.au/v1/suburbs/{name}/development/da-list`.
- Licence: as above (Microburbs hackathon API).
- Fetched: 2026-11-07. 1,544 DAs kept (2021-11-10 .. 2026-07-08); 40 DAs dated after cutoff dropped. Description truncated to 200 chars.
- `das_city_of_sydney.csv`: `suburb, date, category, lat, lng, description`.

## 4. OpenStreetMap via Overpass API
- URL: Overpass API, mirrors tried in order https://maps.mail.ru/osm/tools/overpass/api/interpreter, https://overpass-api.de/api/interpreter, https://overpass.kumi.systems/api/interpreter (the latter two were at capacity on 2026-11-07); bbox lat -33.935..-33.850, lng 151.160..151.245.
- Licence: Open Database License (ODbL) 1.0, (c) OpenStreetMap contributors. https://www.openstreetmap.org/copyright
- Fetched: 2026-11-07 (live OSM snapshot; OSM has no "as of" date filter, but static built-form/road/park geometry changes very little, treat as cutoff-safe).
- Queries: buildings with `building:levels` or `height` (bbox split in 4, `out center`), highway in motorway/trunk/primary/secondary (every 3rd node), leisure=park / natural=water / natural=coastline (sampled boundary nodes or centroid for tiny parks), shop=supermarket.
- Row counts: supermarkets 140; major-road nodes 5,767; green/water nodes 15,886; buildings 12,578 (4 quadrant queries, all complete).
- Attribution line: "Map data (c) OpenStreetMap contributors, ODbL 1.0."

## Not fetched
- ABS Census 2021 mesh-block counts: skipped (time); organisers supply a blocks file already.

## README attribution block (copy verbatim)
> External data: rental bond lodgements from NSW Fair Trading (CC BY 4.0); suburb rent series and development applications from the Microburbs API (hackathon licence); map features (c) OpenStreetMap contributors (ODbL 1.0). All external data filtered to on or before 2026-07-31.
