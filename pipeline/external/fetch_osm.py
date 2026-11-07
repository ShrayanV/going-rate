"""OpenStreetMap via Overpass (data (c) OpenStreetMap contributors, ODbL 1.0).

One query per theme over the City of Sydney bbox; raw JSON cached in raw_dir;
small CSVs written to out_dir:
  osm_buildings.csv          osm_id, lat, lng, levels, height_m, name
  osm_major_roads_nodes.csv  lat, lng, highway        (every 3rd node)
  osm_green_water_nodes.csv  lat, lng, kind           (park|water|coast)
  osm_supermarkets.csv       lat, lng, name

Usage: python pipeline/external/fetch_osm.py [raw_dir] [out_dir]
"""
import sys, json, time
from pathlib import Path
import requests, pandas as pd

ENDPOINTS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter",  # responsive mirror on 2026-11-07
             "https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
S, W, N, E = -33.935, 151.160, -33.850, 151.245
BBOX = f"{S},{W},{N},{E}"


def overpass(query: str, cache: Path):
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    last = None
    for ep in ENDPOINTS:
        for attempt in range(2):
            try:
                r = requests.post(ep, data={"data": query}, timeout=120,
                                  headers={"User-Agent": "hackathon-rent-model/0.1"})
                if r.status_code in (429, 504, 502):
                    last = r.status_code; time.sleep(10); continue
                r.raise_for_status()
                js = r.json()
                cache.write_text(json.dumps(js), encoding="utf-8")
                time.sleep(2)
                return js
            except Exception as e:
                last = e; time.sleep(5)
    raise RuntimeError(f"overpass failed: {last}")


def num(v):
    if v is None: return None
    try:
        return float(str(v).replace("m", "").replace(",", ".").split(";")[0].strip())
    except ValueError:
        return None


def buildings(raw, out):
    f = out / "osm_buildings.csv"
    if f.exists(): return
    rows = []
    # split bbox into 4 to stay light
    mid_lat, mid_lng = (S + N) / 2, (W + E) / 2
    for i, (s, w, n, e) in enumerate([(S, W, mid_lat, mid_lng), (S, mid_lng, mid_lat, E), (mid_lat, W, N, mid_lng), (mid_lat, mid_lng, N, E)]):
        q = f'[out:json][timeout:180];(way["building"]["building:levels"]({s},{w},{n},{e});way["building"]["height"]({s},{w},{n},{e});relation["building"]["building:levels"]({s},{w},{n},{e}););out center tags;'
        js = overpass(q, raw / f"buildings_{i}.json")
        for el in js["elements"]:
            c = el.get("center") or {}
            t = el.get("tags", {})
            if "lat" not in c: continue
            rows.append((f'{el["type"][0]}{el["id"]}', c["lat"], c["lon"], num(t.get("building:levels")), num(t.get("height")), t.get("name")))
    df = pd.DataFrame(rows, columns=["osm_id", "lat", "lng", "levels", "height_m", "name"]).drop_duplicates("osm_id")
    df.to_csv(f, index=False); print("buildings", len(df))


def roads(raw, out):
    f = out / "osm_major_roads_nodes.csv"
    if f.exists(): return
    q = f'[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary)$"]({BBOX});out geom;'
    js = overpass(q, raw / "roads.json")
    rows = []
    for el in js["elements"]:
        hw = el["tags"].get("highway")
        for i, p in enumerate(el.get("geometry", [])):
            if i % 3 == 0:
                rows.append((p["lat"], p["lon"], hw))
    df = pd.DataFrame(rows, columns=["lat", "lng", "highway"])
    df.to_csv(f, index=False); print("road nodes", len(df))


def green_water(raw, out):
    f = out / "osm_green_water_nodes.csv"
    if f.exists(): return
    q = (f'[out:json][timeout:180];('
         f'way["leisure"="park"]({BBOX});relation["leisure"="park"]({BBOX});'
         f'way["natural"="water"]({BBOX});relation["natural"="water"]({BBOX});'
         f'way["natural"="coastline"]({BBOX});'
         f');out geom;')
    js = overpass(q, raw / "green_water.json")
    rows = []
    for el in js["elements"]:
        t = el.get("tags", {})
        kind = "park" if t.get("leisure") == "park" else ("coast" if t.get("natural") == "coastline" else "water")
        geoms = []
        if el["type"] == "way":
            geoms = [el.get("geometry", [])]
        else:
            geoms = [m.get("geometry", []) for m in el.get("members", []) if m.get("role") in ("outer", "")]
        for g in geoms:
            g = [p for p in g if p]
            if not g: continue
            if kind == "park" and len(g) < 8:
                # tiny park: centre only
                rows.append((sum(p["lat"] for p in g) / len(g), sum(p["lon"] for p in g) / len(g), kind)); continue
            step = max(1, len(g) // 20) if kind != "coast" else 3
            for i, p in enumerate(g):
                if i % step == 0:
                    rows.append((p["lat"], p["lon"], kind))
    df = pd.DataFrame(rows, columns=["lat", "lng", "kind"])
    df = df[(df.lat.between(S - 0.01, N + 0.01)) & (df.lng.between(W - 0.01, E + 0.01))]
    df.to_csv(f, index=False); print("green/water nodes", len(df), df.kind.value_counts().to_dict())


def supermarkets(raw, out):
    f = out / "osm_supermarkets.csv"
    if f.exists(): return
    q = f'[out:json][timeout:180];nwr["shop"="supermarket"]({BBOX});out center tags;'
    js = overpass(q, raw / "supermarkets.json")
    rows = []
    for el in js["elements"]:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None: continue
        rows.append((lat, lon, el.get("tags", {}).get("name")))
    df = pd.DataFrame(rows, columns=["lat", "lng", "name"])
    df.to_csv(f, index=False); print("supermarkets", len(df))


def main(raw: Path, out: Path):
    raw.mkdir(parents=True, exist_ok=True); out.mkdir(parents=True, exist_ok=True)
    for fn in (supermarkets, roads, green_water, buildings):
        try:
            fn(raw, out)
        except Exception as e:
            print("FAILED", fn.__name__, e)


if __name__ == "__main__":
    raw = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pipeline/cache/raw/osm")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("pipeline/cache")
    main(raw, out)
