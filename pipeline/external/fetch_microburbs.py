"""Microburbs API: suburb unit median-rent series + development applications.

Reads MICROBURBS_API_KEY / MICROBURBS_API_BASE from .env. Caches raw JSON per
suburb under raw_dir, writes:
  suburb_unit_rent_series.csv  (suburb, date, unit_median_rent)   dates <= 2026-07-31
  suburb_rent_index.csv        (suburb, unit_rent_2026_07, unit_rent_2025_07, yoy_change_pct, last_date)
  das_city_of_sydney.csv       (suburb, date, category, lat, lng, description)  dates <= 2026-07-31

Usage: python pipeline/external/fetch_microburbs.py [raw_dir] [out_dir]
"""
import os, sys, json, time, re
from pathlib import Path
from urllib.parse import quote
import requests, pandas as pd
from dotenv import load_dotenv

CUTOFF = pd.Timestamp("2026-07-31")


def get(session, base, path, cache: Path):
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    for attempt in range(3):
        r = session.get(base + path, timeout=60)
        if r.status_code == 429:
            time.sleep(2 + attempt * 2); continue
        r.raise_for_status()
        cache.write_text(r.text, encoding="utf-8")
        time.sleep(0.12)
        return r.json()
    raise RuntimeError(f"failed {path}: {r.status_code}")


def clean_name(s):
    return re.sub(r"\s*\(.*\)$", "", s).strip()


def main(raw_dir: Path, out_dir: Path):
    load_dotenv()
    base = os.environ.get("MICROBURBS_API_BASE", "https://api-ht.microburbs.com.au")
    key = os.environ["MICROBURBS_API_KEY"]
    raw_dir.mkdir(parents=True, exist_ok=True); out_dir.mkdir(parents=True, exist_ok=True)
    s = requests.Session(); s.headers["Authorization"] = "Bearer " + key
    subs = [x["suburb"] for x in get(s, base, "/v1/suburbs/list", raw_dir / "suburbs_list.json")["data"]]
    print("suburbs:", len(subs))

    series_rows, index_rows, da_rows, dropped_series, dropped_da = [], [], [], 0, 0
    for name in subs:
        slug = re.sub(r"[^A-Za-z0-9]+", "_", name)
        q = quote(name)
        # rent series
        d = get(s, base, f"/v1/suburbs/{q}/market/median-rent-series", raw_dir / f"rent_{slug}.json")["data"]
        unit = pd.DataFrame(d.get("unit") or [])
        if len(unit):
            unit["date"] = pd.to_datetime(unit["date"])
            late = unit["date"] > CUTOFF; dropped_series += int(late.sum()); unit = unit[~late].dropna(subset=["value"])
            for _, r in unit.iterrows():
                series_rows.append((name, r["date"].strftime("%Y-%m-%d"), r["value"]))
            unit = unit.sort_values("date")
            last = unit.iloc[-1]
            ym = unit.groupby(unit["date"].dt.strftime("%Y-%m"))["value"].last().to_dict()
            v_now = ym.get("2026-07", last["value"])
            v_prev = ym.get("2025-07")
            index_rows.append((name, clean_name(name), v_now, v_prev,
                               round((v_now / v_prev - 1) * 100, 2) if v_prev else None,
                               last["date"].strftime("%Y-%m-%d")))
        # DAs
        das = get(s, base, f"/v1/suburbs/{q}/development/da-list", raw_dir / f"da_{slug}.json").get("data") or []
        for x in das:
            dte = pd.to_datetime(x.get("date"), errors="coerce")
            if pd.isna(dte):
                continue
            if dte > CUTOFF:
                dropped_da += 1; continue
            da_rows.append((name, dte.strftime("%Y-%m-%d"), x.get("category"), x.get("lat"), x.get("lng"),
                            (x.get("description") or "")[:200].replace("\n", " ")))
        print(name, "series", len(unit), "das", len(das))

    pd.DataFrame(series_rows, columns=["suburb", "date", "unit_median_rent"]).to_csv(out_dir / "suburb_unit_rent_series.csv", index=False)
    pd.DataFrame(index_rows, columns=["suburb", "suburb_clean", "unit_rent_2026_07", "unit_rent_2025_07", "yoy_change_pct", "last_date"]).to_csv(out_dir / "suburb_rent_index.csv", index=False)
    pd.DataFrame(da_rows, columns=["suburb", "date", "category", "lat", "lng", "description"]).to_csv(out_dir / "das_city_of_sydney.csv", index=False)
    print(f"series rows {len(series_rows)} (dropped after cutoff {dropped_series}); index rows {len(index_rows)}; DA rows {len(da_rows)} (dropped after cutoff {dropped_da})")


if __name__ == "__main__":
    raw = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pipeline/cache/raw/microburbs")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("pipeline/cache")
    main(raw, out)
