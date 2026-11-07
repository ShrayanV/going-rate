"""NSW Fair Trading rental bond lodgement data (CC BY 4.0).

Downloads monthly XLSX files (2024-01 .. 2026-07) from nsw.gov.au, filters to
City of Sydney postcodes + flat/unit, writes per-bond + aggregate CSVs.

Usage: python pipeline/external/fetch_bonds.py [raw_dir] [out_dir]
"""
import re, sys, time, datetime as dt
from pathlib import Path
import requests, pandas as pd, openpyxl

PAGE = "https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data"
CUTOFF = pd.Timestamp("2026-07-31")
START = pd.Timestamp("2024-01-01")
POSTCODES = [2000, 2007, 2008, 2009, 2010, 2011, 2015, 2016, 2017, 2018, 2021, 2037, 2042, 2043, 2050]
MONTHS = {m.lower(): i for i, m in enumerate(
    ["january","february","march","april","may","june","july","august","september","october","november","december"], 1)}
UA = {"User-Agent": "Mozilla/5.0 (hackathon data fetch)"}


def find_links(raw_dir: Path):
    html_path = raw_dir / "page.html"
    if not html_path.exists():
        html_path.write_text(requests.get(PAGE, headers=UA, timeout=60).text, encoding="utf-8")
    html = html_path.read_text(encoding="utf-8")
    out = {}
    for href in set(re.findall(r'href="([^"]*\.xlsx)"', html, flags=re.I)):
        name = href.rsplit("/", 1)[-1].lower()
        if "lodge" not in name or "year" in name:
            continue
        m = re.search(r"(january|february|march|april|may|june|july|august|september|october|november|december)[_-]?(?:data[_-])?(\d{2,4})", name)
        if not m:
            continue
        mon, yr = MONTHS[m.group(1)], int(m.group(2))
        if yr < 100:
            yr += 2000
        key = f"{yr:04d}-{mon:02d}"
        if START <= pd.Timestamp(f"{key}-01") <= CUTOFF:
            out[key] = "https://www.nsw.gov.au" + href if href.startswith("/") else href
    return dict(sorted(out.items()))


def download(links, raw_dir: Path):
    for key, url in links.items():
        p = raw_dir / f"{key}.xlsx"
        if p.exists() and p.stat().st_size > 1000:
            continue
        for attempt in range(2):
            try:
                r = requests.get(url, headers=UA, timeout=120)
                r.raise_for_status()
                p.write_bytes(r.content)
                print("downloaded", key, len(r.content))
                break
            except Exception as e:
                print("retry", key, e); time.sleep(3)


def parse(p: Path) -> pd.DataFrame:
    wb = openpyxl.load_workbook(p, read_only=True)
    ws = wb.worksheets[0]
    rows, header = [], None
    for row in ws.iter_rows(values_only=True):
        if header is None:
            if row and row[0] and str(row[0]).strip().lower().startswith("lodgement"):
                header = row
            continue
        if row[0] is None:
            continue
        rows.append(row[:5])
    df = pd.DataFrame(rows, columns=["lodgement_date", "postcode", "dwelling_type", "bedrooms", "weekly_rent"])
    return df


def main(raw_dir: Path, out_dir: Path):
    raw_dir.mkdir(parents=True, exist_ok=True); out_dir.mkdir(parents=True, exist_ok=True)
    per_bond = out_dir / "bonds_city_of_sydney.csv"
    agg = out_dir / "bonds_postcode_bed_month.csv"
    if per_bond.exists() and agg.exists():
        print("bonds cached, skipping"); return
    links = find_links(raw_dir)
    print("monthly files found:", list(links))
    download(links, raw_dir)
    frames, dropped_late, total = [], 0, 0
    for p in sorted(raw_dir.glob("*.xlsx")):
        df = parse(p)
        total += len(df)
        df["lodgement_date"] = pd.to_datetime(df["lodgement_date"], errors="coerce")
        df["postcode"] = pd.to_numeric(df["postcode"], errors="coerce")
        df = df[df["postcode"].isin(POSTCODES)]
        df = df[df["dwelling_type"].astype(str).str.upper().str.strip() == "F"]
        late = df["lodgement_date"] > CUTOFF
        dropped_late += int(late.sum())
        df = df[~late & df["lodgement_date"].notna()]
        df["weekly_rent"] = pd.to_numeric(df["weekly_rent"], errors="coerce")
        df["bedrooms"] = pd.to_numeric(df["bedrooms"], errors="coerce")
        df = df.dropna(subset=["weekly_rent", "bedrooms"])
        df = df[(df["weekly_rent"] >= 100) & (df["weekly_rent"] <= 5000)]
        df["month"] = df["lodgement_date"].dt.strftime("%Y-%m")
        frames.append(df)
    out = pd.concat(frames, ignore_index=True)
    out["postcode"] = out["postcode"].astype(int); out["bedrooms"] = out["bedrooms"].astype(int)
    out["weekly_rent"] = out["weekly_rent"].astype(int)
    out["dwelling_type"] = "flat"
    out = out[["month", "postcode", "dwelling_type", "bedrooms", "weekly_rent"]].sort_values(["month", "postcode", "bedrooms"])
    out.to_csv(per_bond, index=False)
    g = out.groupby(["month", "postcode", "bedrooms"])["weekly_rent"]
    a = g.agg(n="size", median_rent="median", p25=lambda s: s.quantile(.25), p75=lambda s: s.quantile(.75)).reset_index()
    a.to_csv(agg, index=False)
    print(f"rows in raw files: {total}; City of Sydney flats kept: {len(out)}; dropped after cutoff: {dropped_late}")
    print("wrote", per_bond, len(out), "and", agg, len(a))


if __name__ == "__main__":
    raw = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pipeline/cache/raw/nsw_bonds")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("pipeline/cache")
    main(raw, out)
