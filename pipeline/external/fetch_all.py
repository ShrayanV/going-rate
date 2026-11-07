"""Run every external fetch idempotently (each step skips if its output CSV exists).

Usage (from repo root): python pipeline/external/fetch_all.py
Outputs land in pipeline/cache/ (gitignored); raw downloads in pipeline/cache/raw/<source>/.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = ROOT / "pipeline" / "cache"
sys.path.insert(0, str(HERE))

import fetch_bonds, fetch_microburbs, fetch_osm  # noqa: E402

STEPS = [
    ("nsw_bonds", fetch_bonds.main, ["bonds_city_of_sydney.csv", "bonds_postcode_bed_month.csv"]),
    ("microburbs", fetch_microburbs.main, ["suburb_unit_rent_series.csv", "suburb_rent_index.csv", "das_city_of_sydney.csv"]),
    ("osm", fetch_osm.main, ["osm_buildings.csv", "osm_major_roads_nodes.csv", "osm_green_water_nodes.csv", "osm_supermarkets.csv"]),
]

if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, fn, outputs in STEPS:
        if all((CACHE / o).exists() for o in outputs):
            print(f"[{name}] cached, skipping"); continue
        print(f"[{name}] fetching ...")
        try:
            fn(CACHE / "raw" / name, CACHE)
        except Exception as e:
            print(f"[{name}] FAILED: {e}")
    print("done. outputs in", CACHE)
