"""Load the three supplied files (data/ or fallback data_fixture/), map columns onto canonical names,
and hard-filter leases dated after the information cutoff (2026-07-31).

python pipeline/load.py   -> prints schema + head of each file, writes pipeline/out/schema.txt
"""
import re
import sys
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "pipeline" / "out"
CUTOFF = pd.Timestamp("2026-07-31")
FILES = {
    "flats": "rents-input-flats-city-of-sydney.csv",
    "leases": "rents-past-leases-city-of-sydney.csv",
    "blocks": "blocks-homes-and-people-2021-2026.csv",
}

# canonical -> exact synonyms (after normalisation: lowercase, non-alnum -> _)
SYNONYMS = {
    "gnaf_id": ["gnaf_id", "gnafid", "gnaf", "gnaf_pid", "gnafpid", "address_detail_pid", "gnaf_address_pid", "address_id"],
    "address": ["address", "full_address", "formatted_address", "address_text", "property_address", "street_address", "display_address", "address_label"],
    "suburb": ["suburb", "locality", "suburb_name", "locality_name"],
    "postcode": ["postcode", "post_code", "postal_code", "pc"],
    "mesh_block": ["mesh_block", "meshblock", "mb", "mb_code", "mb_code_2021", "mb_code21", "mesh_block_id", "meshblock_id", "mb_2021", "mb_id", "mesh_block_2021", "mb21", "meshblock_2021", "mesh_block_code"],
    "lat": ["lat", "latitude", "y"],
    "lng": ["lng", "lon", "long", "longitude", "x"],
    "unit_number": ["unit_number", "unit", "unit_no", "flat_number", "flat", "apartment", "apartment_number", "unit_num", "flat_no", "unit_id"],
    "bedrooms": ["bedrooms", "beds", "bed", "bedroom", "num_bedrooms", "n_bedrooms", "bedroom_count"],
    "bathrooms": ["bathrooms", "baths", "bath", "bathroom", "num_bathrooms", "n_bathrooms", "bathroom_count"],
    "car_spaces": ["car_spaces", "carspaces", "parking", "car_space", "carspace", "cars", "car", "parking_spaces", "garages", "garage", "car_parks", "carparks", "has_parking", "has_car_space", "n_car_spaces", "num_car_spaces", "car_park", "carpark", "car_parking", "parking_space", "car_space_count"],
    "flats_in_building": ["flats_in_building", "units_in_building", "flats_in_block", "dwellings_in_building", "n_flats", "num_flats", "building_flats", "flats_at_address", "units_at_address"],
    "date": ["date", "listed_date", "date_listed", "advert_date", "listing_date", "list_date", "first_listed", "date_first_listed", "ad_date", "advertised_date", "lease_date", "start_date", "date_advertised", "listed", "listed_on", "advert_date_first", "first_seen", "date_first_seen", "date_first_advertised"],
    "rent": ["rent", "weekly_rent", "rent_per_week", "asking_rent", "price", "rent_pw", "weekly_asking_rent", "rent_weekly", "amount", "rent_amount", "listed_rent", "advertised_rent", "rent_week", "weekly_price", "asking_price", "rent_per_week_aud"],
    "property_type": ["property_type", "type", "dwelling_type", "prop_type"],
    "floor_level": ["floor_level", "floor", "level", "storey"],
    "building_address": ["building_address", "building", "building_id"],
    "garage_spaces": ["garage_spaces", "garages", "garage"],
    "first_listed": ["first_ever_listed", "first_listed", "first_listed_date"],
    "street": ["street", "street_name", "road"],
    "street_number": ["street_number", "number_first", "house_number", "street_no"],
}
# substring fallbacks (applied only if nothing exact matched)
CONTAINS = {
    "gnaf_id": ["gnaf"], "mesh_block": ["mesh", "mb_code"], "lat": ["latitude"], "lng": ["longitude"],
    "unit_number": ["unit"], "bedrooms": ["bed"], "bathrooms": ["bath"], "car_spaces": ["car", "park", "garage"],
    "date": ["date", "listed", "advert", "time", "month"], "rent": ["rent", "price", "amount", "pw"], "suburb": ["suburb", "locality"], "address": ["address"],
    "flats_in_building": ["flats_in", "units_in"],
}


def norm(c):
    return re.sub(r"_+", "_", re.sub(r"[^0-9a-z]", "_", str(c).strip().lower())).strip("_")


def map_columns(df, wanted):
    """Return {canonical: original column} for the canonical names in `wanted`."""
    cols = {norm(c): c for c in df.columns}
    used, out = set(), {}
    for canon in wanted:
        for syn in SYNONYMS.get(canon, []):
            if syn in cols and cols[syn] not in used:
                out[canon] = cols[syn]
                used.add(cols[syn])
                break
    for canon in wanted:
        if canon in out:
            continue
        for tok in CONTAINS.get(canon, []):
            hits = [c for n, c in cols.items() if tok in n and c not in used and not (tok == "lat" and "flat" in n)]
            if hits:
                out[canon] = hits[0]
                used.add(hits[0])
                break
    return out


def norm_id(s):
    """Mesh-block / id columns: '17981170.0' -> '17981170'; NaN stays NA."""
    t = s.astype("string").str.strip().str.replace(r"\.0+$", "", regex=True)
    return t.mask(t.isin(["nan", "None", "", "<NA>"]))


def unit_from_address(addr):
    """'1203/50 Smith St' or 'Unit 1203, 50 Smith St' -> '1203'."""
    a = addr.astype("string")
    u = a.str.extract(r"^\s*(?:unit|apt|apartment|flat|suite|u)?\s*\.?\s*([A-Za-z]{0,2}\d+[A-Za-z]?)\s*[/,]", flags=re.I)[0]
    return u.str.strip()


def parse_number(s):
    """'$1,200 pw' -> 1200. Takes the first number in the string."""
    if pd.api.types.is_numeric_dtype(s):
        return pd.to_numeric(s, errors="coerce")
    ext = s.astype(str).str.replace(",", "", regex=False).str.extract(r"(\d+\.?\d*)")[0]
    return pd.to_numeric(ext, errors="coerce")


def parse_parking(s):
    """-> 1.0 / 0.0 / NaN (unknown)."""
    if pd.api.types.is_numeric_dtype(s):
        v = pd.to_numeric(s, errors="coerce")
        return (v > 0).astype(float).where(v.notna())
    t = s.astype(str).str.strip().str.lower()
    yes = t.isin(["yes", "y", "true", "t", "1", "with", "car space", "carspace"])
    no = t.isin(["no", "n", "false", "f", "0", "none", "without", "nil"])
    num = pd.to_numeric(t.str.extract(r"(\d+)")[0], errors="coerce")
    out = pd.Series(np.nan, index=s.index)
    out[num.notna()] = (num[num.notna()] > 0).astype(float)
    out[yes] = 1.0
    out[no] = 0.0
    return out


def parse_dates(s):
    if pd.api.types.is_datetime64_any_dtype(s):
        return s
    d = pd.to_datetime(s, errors="coerce", format="mixed")
    if d.isna().mean() > 0.5:
        d2 = pd.to_datetime(s, errors="coerce", dayfirst=True)
        if d2.notna().sum() > d.notna().sum():
            d = d2
    return d


def _data_dir():
    real = ROOT / "data"
    if all((real / f).exists() for f in FILES.values()):
        return real, "REAL data/"
    missing = [f for f in FILES.values() if not (real / f).exists()]
    fx = ROOT / "data_fixture"
    if not all((fx / f).exists() for f in FILES.values()):
        sys.path.insert(0, str(ROOT / "pipeline"))
        import fixture
        fixture.main()
    return fx, f"SYNTHETIC data_fixture/ (data/ missing: {missing})"


def _read_csv(p):
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(p, low_memory=False, encoding=enc)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(p, low_memory=False, encoding_errors="replace")


def load(verbose=True):
    d, src = _data_dir()
    log = [f"source: {src}", f"cutoff: {CUTOFF.date()}"]
    raw = {k: _read_csv(d / f) for k, f in FILES.items()}
    for k, df in raw.items():
        log += [f"\n== {k}: {FILES[k]}  shape={df.shape}",
                "columns: " + ", ".join(f"{c} ({df[c].dtype})" for c in df.columns),
                df.head(5).to_string(max_cols=40, max_colwidth=40)]

    # ---- flats (input) ----
    f = raw["flats"]
    fm = map_columns(f, ["gnaf_id", "address", "suburb", "postcode", "mesh_block", "lat", "lng", "unit_number",
                         "bedrooms", "bathrooms", "car_spaces", "garage_spaces", "flats_in_building", "property_type", "street", "street_number",
                         "floor_level", "building_address", "first_listed"])
    log.append(f"\nflats column map: {fm}")
    flats = pd.DataFrame({k: f[v] for k, v in fm.items()})
    if "gnaf_id" not in flats:
        raise SystemExit(f"could not find gnaf_id in flats columns {list(f.columns)}")
    if "address" not in flats:  # build from parts
        parts = [flats[c].astype(str) for c in ["unit_number", "street_number", "street", "suburb"] if c in flats]
        flats["address"] = parts[0].str.cat(parts[1:], sep=" ") if parts else flats["gnaf_id"]
    for c in ["lat", "lng", "bedrooms", "bathrooms", "flats_in_building"]:
        if c in flats:
            flats[c] = parse_number(flats[c])
    flats["parking"] = parse_parking(flats["car_spaces"]) if "car_spaces" in flats else np.nan
    if "garage_spaces" in flats:
        flats["parking"] = np.fmax(flats["parking"], parse_parking(flats["garage_spaces"]))
    flats["floor_level"] = parse_number(flats["floor_level"]) if "floor_level" in flats else np.nan
    for c in ["building_address", "property_type"]:
        flats[c] = flats[c].astype("string").str.strip().str.lower() if c in flats else pd.NA
    flats["first_listed"] = parse_dates(flats["first_listed"]) if "first_listed" in flats else pd.NaT
    for c in ["suburb", "address", "unit_number", "mesh_block", "postcode"]:
        flats[c] = flats[c].astype("string").str.strip() if c in flats else pd.NA
    flats["mesh_block"] = norm_id(flats["mesh_block"])
    if flats["unit_number"].isna().all():
        flats["unit_number"] = unit_from_address(flats["address"])
        log.append(f"unit_number derived from address for {int(flats['unit_number'].notna().sum())} flats")
    for c in ["bedrooms", "bathrooms", "lat", "lng"]:
        if c not in flats:
            flats[c] = np.nan
    flats["gnaf_id"] = flats["gnaf_id"].astype(str).str.strip()
    dup = flats["gnaf_id"].duplicated().sum()
    if dup:
        log.append(f"WARNING: {dup} duplicate gnaf_ids in input; keeping first")
        flats = flats.drop_duplicates("gnaf_id")
    if flats["suburb"].isna().any():
        guess = flats["address"].astype(str).str.extract(r",\s*([A-Za-z' ]+?)\s+NSW", flags=re.I)[0].str.strip()
        flats["suburb"] = flats["suburb"].fillna(guess)
    flats["suburb"] = flats["suburb"].fillna("UNKNOWN").str.title()
    flats = flats.reset_index(drop=True)

    # ---- leases ----
    l = raw["leases"]
    lm = map_columns(l, ["gnaf_id", "address", "suburb", "postcode", "date", "rent", "bedrooms", "bathrooms",
                         "car_spaces", "garage_spaces", "lat", "lng", "unit_number", "property_type", "mesh_block", "building_address", "floor_level"])
    log.append(f"leases column map: {lm}")
    leases = pd.DataFrame({k: l[v] for k, v in lm.items()})
    for need in ["date", "rent"]:
        if need not in leases:
            raise SystemExit(f"could not find {need} in leases columns {list(l.columns)}")
    leases["date"] = parse_dates(leases["date"])
    leases["rent"] = parse_number(leases["rent"])
    med = leases["rent"].median()
    if med > 6000:
        log.append(f"WARNING: rent median {med} looks monthly/annual; dividing")
        leases["rent"] = leases["rent"] / (52 / 12 if med < 40000 else 52)
    for c in ["bedrooms", "bathrooms", "lat", "lng"]:
        leases[c] = parse_number(leases[c]) if c in leases else np.nan
    leases["parking"] = parse_parking(leases["car_spaces"]) if "car_spaces" in leases else np.nan
    if "garage_spaces" in leases:
        leases["parking"] = np.fmax(leases["parking"], parse_parking(leases["garage_spaces"]))
    leases["floor_level"] = parse_number(leases["floor_level"]) if "floor_level" in leases else np.nan
    for c in ["building_address", "property_type"]:
        leases[c] = leases[c].astype("string").str.strip().str.lower() if c in leases else pd.NA
    for c in ["suburb", "address", "unit_number", "gnaf_id", "mesh_block"]:
        leases[c] = leases[c].astype("string").str.strip() if c in leases else pd.NA
    leases["mesh_block"] = norm_id(leases["mesh_block"])
    if leases["unit_number"].isna().all():
        leases["unit_number"] = unit_from_address(leases["address"])
    n0 = len(leases)
    bad_date = leases["date"].isna().sum()
    after = (leases["date"] > CUTOFF).sum()
    leases = leases[leases["date"].notna() & (leases["date"] <= CUTOFF)].copy()
    bad_rent = (~leases["rent"].between(100, 10000)).sum()
    leases = leases[leases["rent"].between(100, 10000)].copy()
    log.append(f"leases: {n0} rows; dropped {after} dated after {CUTOFF.date()}, {bad_date} with unparseable date, "
               f"{bad_rent} with bad/missing rent -> {len(leases)} kept")
    if leases["gnaf_id"].notna().any():
        key = flats.drop_duplicates("gnaf_id").set_index("gnaf_id")
        for c in ["suburb", "lat", "lng", "bedrooms", "bathrooms", "address", "unit_number", "mesh_block", "building_address", "property_type", "floor_level", "first_listed"]:
            if c in key:
                mapped = leases["gnaf_id"].map(key[c])
                leases[c] = leases[c].where(leases[c].notna(), mapped) if c in leases else mapped
        log.append(f"leases matched to input gnaf_id: {leases['gnaf_id'].isin(key.index).mean():.1%}")
    leases["suburb"] = leases["suburb"].fillna("UNKNOWN").str.title()
    leases = leases.sort_values("date").reset_index(drop=True)

    # ---- blocks ----
    b = raw["blocks"]
    bm = map_columns(b, ["mesh_block"])
    blocks = None
    if "mesh_block" in bm:
        blocks = b.rename(columns={bm["mesh_block"]: "mesh_block"})
        blocks["mesh_block"] = norm_id(blocks["mesh_block"])
        ycol = [c for c in blocks.columns if norm(c) in ("year", "census_year", "period")]
        if ycol:  # long format -> wide
            num = [c for c in blocks.columns if c not in ycol + ["mesh_block"] and pd.api.types.is_numeric_dtype(blocks[c])]
            blocks = blocks.pivot_table(index="mesh_block", columns=ycol[0], values=num, aggfunc="first")
            blocks.columns = [f"{a}_{bb}" for a, bb in blocks.columns]
            blocks = blocks.reset_index()
        num = [c for c in blocks.columns if c != "mesh_block" and pd.api.types.is_numeric_dtype(blocks[c])]
        blocks = blocks[["mesh_block"] + num].drop_duplicates("mesh_block").copy()
        blocks.columns = ["mesh_block"] + ["mb_" + norm(c) for c in num]
        log.append(f"blocks: {len(blocks)} mesh blocks, numeric cols: {list(blocks.columns[1:])}")
        log.append(f"input flats with a matching mesh block: {flats['mesh_block'].isin(blocks['mesh_block']).mean():.1%}")
    else:
        log.append("blocks: no mesh_block column found; skipping")
    log.append(f"\nflats: {len(flats)} rows, {flats['suburb'].nunique()} suburbs; parking unknown {int(flats['parking'].isna().sum())}; "
               f"bedrooms null {int(flats['bedrooms'].isna().sum())}")
    log.append(f"leases date range: {leases['date'].min().date()} .. {leases['date'].max().date()}; "
               f"parking unknown {leases['parking'].isna().mean():.1%}")
    text = "\n".join(log)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "schema.txt").write_text(text, encoding="utf-8")
    if verbose:
        print(text)
    return flats, leases, blocks, src


if __name__ == "__main__":
    load()
