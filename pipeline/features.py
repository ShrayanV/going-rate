"""Feature engineering. Everything is computed from `hist` = leases dated <= the cutoff passed in,
so the same code serves the held-out check (cutoff 2026-04-30) and the final refit (cutoff 2026-07-31).

python pipeline/features.py   -> smoke test on the loaded data
"""
import json
import re
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "pipeline" / "cache"
CBD = (-33.8732, 151.2069)  # Town Hall
STALE_MONTHS = 60
BBOX = (-33.93, 151.16, -33.85, 151.24)

# Fallback stops (approximate coordinates) if Overpass is unreachable.
FALLBACK_STOPS = [
    ("Central", -33.8832, 151.2069, "train"), ("Town Hall", -33.8734, 151.2068, "train"),
    ("Wynyard", -33.8658, 151.2057, "train"), ("Circular Quay", -33.8613, 151.2109, "train"),
    ("St James", -33.8700, 151.2112, "train"), ("Museum", -33.8763, 151.2102, "train"),
    ("Martin Place", -33.8677, 151.2103, "train"), ("Kings Cross", -33.8740, 151.2224, "train"),
    ("Redfern", -33.8918, 151.1987, "train"), ("Green Square", -33.9064, 151.2034, "train"),
    ("Erskineville", -33.9002, 151.1864, "train"), ("Macdonaldtown", -33.8970, 151.1865, "train"),
    ("Newtown", -33.8975, 151.1794, "train"), ("Waterloo metro", -33.8990, 151.2068, "train"),
    ("Gadigal metro", -33.8753, 151.2089, "train"), ("Barangaroo metro", -33.8627, 151.2026, "train"),
    ("Edgecliff", -33.8790, 151.2365, "train"), ("Sydenham", -33.9165, 151.1672, "train"),
    ("Pyrmont Bay LR", -33.8679, 151.1962, "lr"), ("Fish Market LR", -33.8723, 151.1927, "lr"),
    ("Wentworth Park LR", -33.8764, 151.1922, "lr"), ("Glebe LR", -33.8793, 151.1860, "lr"),
    ("Jubilee Park LR", -33.8762, 151.1796, "lr"), ("Surry Hills LR", -33.8860, 151.2110, "lr"),
    ("Moore Park LR", -33.8905, 151.2195, "lr"), ("Haymarket LR", -33.8808, 151.2048, "lr"),
    ("Chinatown LR", -33.8787, 151.2047, "lr"), ("Exhibition Centre LR", -33.8766, 151.2003, "lr"),
    ("Convention LR", -33.8731, 151.1990, "lr"), ("Capitol Square LR", -33.8795, 151.2068, "lr"),
    ("Paddy's Markets LR", -33.8800, 151.2040, "lr"), ("The Star LR", -33.8690, 151.1950, "lr"),
    ("Rozelle Bay LR", -33.8735, 151.1760, "lr"), ("Ward Park LR", -33.8835, 151.2130, "lr"),
    ("Royal Randwick LR", -33.9015, 151.2325, "lr"), ("Bridge St LR", -33.8640, 151.2090, "lr"),
    ("QVB LR", -33.8720, 151.2065, "lr"), ("Rawson Place LR", -33.8835, 151.2055, "lr"),
]


# ---------------------------------------------------------------- stops
def fetch_stops():
    CACHE.mkdir(parents=True, exist_ok=True)
    cache = CACHE / "stops.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    s, w, n, e = BBOX
    q = f"""[out:json][timeout:25];
(
  node["railway"="station"]({s},{w},{n},{e});
  node["railway"="halt"]({s},{w},{n},{e});
  node["railway"="tram_stop"]({s},{w},{n},{e});
  node["station"="light_rail"]({s},{w},{n},{e});
  node["public_transport"="station"]({s},{w},{n},{e});
);
out body;"""
    stops = []
    try:
        import requests
        data = None
        for ep in ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"):
            try:
                r = requests.post(ep, data={"data": q}, timeout=40, headers={"User-Agent": "hackathon-rent-model/0.1"})
                r.raise_for_status()
                data = r.json()
                break
            except Exception as ex:  # noqa
                print(f"Overpass {ep} failed: {ex}")
        if data is None:
            raise RuntimeError("all Overpass endpoints failed")
        for el in data.get("elements", []):
            t = el.get("tags", {})
            if t.get("railway") == "subway_entrance" or t.get("bus") == "yes" and t.get("railway") is None and t.get("station") is None:
                continue
            kind = "lr" if (t.get("railway") == "tram_stop" or t.get("station") == "light_rail" or t.get("light_rail") == "yes") else "train"
            if t.get("railway") not in ("station", "halt", "tram_stop") and t.get("station") not in ("light_rail", "subway", "train"):
                continue
            stops.append((t.get("name", "?"), el["lat"], el["lon"], kind))
        src = "osm"
    except Exception as ex:  # noqa
        print(f"Overpass failed ({ex}); using hard-coded stops")
        stops = []
    if len(stops) < 10:
        stops, src = FALLBACK_STOPS, "fallback"
    out = {"source": src, "stops": [list(x) for x in stops]}
    cache.write_text(json.dumps(out), encoding="utf-8")
    print(f"stops: {len(stops)} from {src}")
    return out


def haversine_m(lat1, lng1, lat2, lng2):
    lat1, lng1, lat2, lng2 = map(np.radians, (lat1, lng1, lat2, lng2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lng2 - lng1) / 2) ** 2
    return 6371000.0 * 2 * np.arcsin(np.sqrt(a))


def nearest_m(lat, lng, pts, return_index=False):
    """min haversine distance (m) from each (lat,lng) to any of pts [(lat,lng)...]; optionally the index of that point."""
    from sklearn.neighbors import BallTree
    lat = np.asarray(lat, float); lng = np.asarray(lng, float)
    out = np.full(len(lat), np.nan); idx = np.full(len(lat), -1)
    P = np.asarray(pts, float)
    ok = np.isfinite(lat) & np.isfinite(lng)
    if len(P) and ok.any():
        tree = BallTree(np.radians(P), metric="haversine")
        d, i = tree.query(np.radians(np.c_[lat[ok], lng[ok]]), k=1)
        out[ok] = d[:, 0] * 6371000.0; idx[ok] = i[:, 0]
    return (out, idx) if return_index else out


def count_within_m(lat, lng, pts, radius_m):
    from sklearn.neighbors import BallTree
    lat = np.asarray(lat, float); lng = np.asarray(lng, float)
    out = np.zeros(len(lat))
    P = np.asarray(pts, float)
    ok = np.isfinite(lat) & np.isfinite(lng)
    if len(P) and ok.any():
        tree = BallTree(np.radians(P), metric="haversine")
        out[ok] = tree.query_radius(np.radians(np.c_[lat[ok], lng[ok]]), r=radius_m / 6371000.0, count_only=True)
    return out


# ---------------------------------------------------------------- parsing
def parse_floor(unit):
    """-> (floor, floor_known, penthouse). Conservative: unit >= 100 -> floor = unit // 100, else 0 / unknown."""
    if unit is None or (isinstance(unit, float) and np.isnan(unit)) or unit is pd.NA:
        return 0, 0, 0
    u = str(unit).strip().upper()
    if not u or u in ("NAN", "<NA>", "NONE"):
        return 0, 0, 0
    if u.startswith("PH") or u.startswith("P") and not u[1:2].isdigit() is False and "PH" in u:
        return 0, 0, 1
    if re.match(r"^(G|LG|UG|B|BG|GF|GROUND)", u) and not re.match(r"^G\d{3,}", u):
        return 0, 1, 0
    m = re.search(r"(\d+)", u)
    if not m:
        return 0, 0, 0
    n = int(m.group(1))
    if n >= 100:
        return min(n // 100, 80), 1, 0
    return 0, 0, 0


def floor_features(unit_series):
    vals = [parse_floor(u) for u in unit_series.tolist()]
    arr = np.array(vals, dtype=float).reshape(-1, 3) if vals else np.zeros((0, 3))
    return pd.DataFrame({"floor": arr[:, 0], "floor_known": arr[:, 1], "penthouse": arr[:, 2]}, index=unit_series.index)


_UNIT_PREFIX = re.compile(r"^\s*(unit|apt|apartment|flat|suite|shop|level|lvl|u|villa|townhouse|th)\s*\.?\s*[\w-]+\s*[,/]\s*", re.I)
_SLASH = re.compile(r"^\s*[\w-]+\s*/\s*")


def building_key(address, lat=None, lng=None):
    a = "" if address is None or address is pd.NA or (isinstance(address, float) and np.isnan(address)) else str(address)
    a = _UNIT_PREFIX.sub("", a)
    a = _SLASH.sub("", a)
    a = re.sub(r"[^a-z0-9 ]", " ", a.lower())
    a = re.sub(r"\s+", " ", a).strip()
    if not a:
        if lat is not None and not np.isnan(lat):
            return f"ll:{lat:.5f},{lng:.5f}"
        return "unknown"
    return a


def building_keys(df):
    """building_address + suburb when supplied, else parsed from the address."""
    lat = pd.to_numeric(df["lat"], errors="coerce"); lng = pd.to_numeric(df["lng"], errors="coerce")
    parsed = pd.Series([building_key(a, la, lo) for a, la, lo in zip(df["address"], lat, lng)], index=df.index)
    if "building_address" in df and df["building_address"].notna().any():
        ba = (df["building_address"].astype("string").str.lower() + " " + df["suburb"].astype("string").str.lower())
        ba = ba.str.replace(r"[^a-z0-9 ]", " ", regex=True).str.replace(r"\s+", " ", regex=True).str.strip()
        return ba.where(df["building_address"].notna(), parsed).astype(str)
    return parsed


def flat_key(df):
    """Identity of a flat for 'own last rent': gnaf_id when available, else the normalised full address."""
    g = df["gnaf_id"].astype("string") if "gnaf_id" in df else pd.Series(pd.NA, index=df.index, dtype="string")
    addr = (df["address"].astype("string").str.lower()
            .str.replace(r"^\s*(unit|apt|apartment|flat|suite|u)\s*\.?\s*", "", regex=True)
            .str.replace(r"\s*,?\s*nsw\s*\d{4}\s*$", "", regex=True)
            .str.replace(r"[^a-z0-9]", "", regex=True))
    return g.where(g.notna() & (g != "") & (g != "nan"), "addr:" + addr.fillna("")).astype(str)


def unit_digits(unit_series):
    return pd.to_numeric(unit_series.astype("string").str.extract(r"(\d+)")[0], errors="coerce")


# ---------------------------------------------------------------- monthly index
def bed_group(b):
    return pd.to_numeric(b, errors="coerce").fillna(1).clip(0, 3).astype(int)


def monthly_index(hist, cutoff):
    """citywide monthly rolling-median rent per bedroom group -> DataFrame[bed x month] of index levels."""
    h = hist.copy()
    h["m"] = h["date"].dt.to_period("M")
    h["bg"] = bed_group(h["bedrooms"])
    months = pd.period_range(h["m"].min(), pd.Period(cutoff, "M"), freq="M")
    tbl = h.groupby(["bg", "m"])["rent"].median().unstack("m").reindex(columns=months)
    tbl = tbl.T.ffill().bfill().rolling(3, min_periods=1).median().T  # trailing 3-month median, no look-ahead
    # fall back to pooled index if a bedroom group is thin
    cnt = h.groupby(["bg", "m"]).size().unstack("m").reindex(columns=months).fillna(0)
    pooled = h.groupby("m")["rent"].median().reindex(months).ffill().bfill().rolling(3, min_periods=1).median()
    for bg in tbl.index:
        if (cnt.loc[bg] < 15).mean() > 0.5:
            tbl.loc[bg] = pooled.values * (tbl.loc[bg].mean() / pooled.mean())
    return tbl


def index_ratio(tbl, bg, from_month, to_month):
    """multiplier to move a rent observed in from_month to to_month, per row. Clipped."""
    bg = np.asarray(bg); fm = pd.PeriodIndex(from_month); tm = pd.PeriodIndex(to_month)
    cols = tbl.columns
    lo, hi = cols[0], cols[-1]
    fm = fm.where(fm >= lo, lo).where(fm <= hi, hi)
    tm = tm.where(tm >= lo, lo).where(tm <= hi, hi)
    arr = tbl.values
    rowi = pd.Index(tbl.index).get_indexer(bg)
    rowi = np.where(rowi < 0, 0, rowi)
    ci = cols.get_indexer(fm); cj = cols.get_indexer(tm)
    r = arr[rowi, cj] / arr[rowi, ci]
    return np.clip(np.nan_to_num(r, nan=1.0), 0.6, 1.7)


def seasonal_factors(h, since_year=2019):
    """Calendar-month factors (geometric mean 1) from history: per bedroom group, log monthly median rent minus a centred
    13-month rolling mean; averaged over bedroom groups, then averaged by calendar month across years. Clipped to +-3.5%."""
    hh = h[h["date"].dt.year >= since_year]
    g = hh.groupby(["bg", "m"])["rent"].median().unstack("m").T.ffill().bfill()
    lg = np.log(g)
    dev = (lg - lg.rolling(13, center=True, min_periods=9).mean()).mean(axis=1).dropna()
    s = dev.groupby(dev.index.month).mean().reindex(range(1, 13)).fillna(0.0)
    s = s - s.mean()
    return np.exp(s.clip(-0.035, 0.035))


def annual_growth(tbl):
    """median yoy growth of the index over its final 12 months (for a small forward extrapolation)."""
    if tbl.shape[1] < 13:
        return 0.0
    g = (tbl.iloc[:, -1] / tbl.iloc[:, -13] - 1).median()
    return float(np.clip(g, -0.05, 0.12))


# ---------------------------------------------------------------- NSW rental bond lodgements (optional, team cache)
def load_bonds(cut_m):
    """postcode x bedroom-group price level from NSW Fair Trading bond lodgements, using only months <= cutoff."""
    f = CACHE / "bonds_postcode_bed_month.csv"
    if not f.exists():
        return None
    try:
        b = pd.read_csv(f)
        b["m"] = pd.PeriodIndex(b["month"].astype(str), freq="M")
        b = b[b["m"] <= cut_m]
        b["bg"] = bed_group(b["bedrooms"]); b["postcode"] = b["postcode"].astype(str).str.strip()
        b = b.groupby(["postcode", "bg", "m"]).apply(lambda g: pd.Series({"n": g["n"].sum(), "med": np.average(g["median_rent"], weights=g["n"])}), include_groups=False).reset_index()
        last3 = b[b["m"] > cut_m - 3]
        now = last3.groupby(["postcode", "bg"]).apply(lambda g: np.average(g["med"], weights=g["n"]), include_groups=False).rename("bond_median")
        prev = b[(b["m"] > cut_m - 15) & (b["m"] <= cut_m - 12)].groupby(["postcode", "bg"]).apply(lambda g: np.average(g["med"], weights=g["n"]), include_groups=False)
        out = now.to_frame()
        out["bond_yoy"] = (now / prev - 1).reindex(out.index)
        print(f"bonds: {len(out)} postcode x bedroom cells <= {cut_m}")
        return out
    except Exception as ex:  # noqa
        print(f"bonds table unusable: {ex}")
        return None


def load_external(cut_m, cutoff):
    """Team-cached external tables (see pipeline/external/SOURCES.md). Everything dated after the cutoff is dropped."""
    ext = {}
    f = CACHE / "suburb_unit_rent_series.csv"
    if f.exists():
        try:
            s = pd.read_csv(f); s["date"] = pd.to_datetime(s["date"], errors="coerce"); s = s[s["date"] <= cutoff]
            s["suburb"] = s["suburb"].astype(str).str.replace(r"\s*\(NSW\)\s*$", "", regex=True).str.strip().str.title()
            s = s.sort_values("date")
            last = s.groupby("suburb").tail(1).set_index("suburb")["unit_median_rent"]
            prev = s[s["date"] <= cutoff - pd.DateOffset(months=12)].groupby("suburb").tail(1).set_index("suburb")["unit_median_rent"]
            ext["sr"] = pd.DataFrame({"sr_level": last, "sr_yoy": last / prev.reindex(last.index) - 1})
        except Exception as ex:  # noqa
            print("suburb series unusable:", ex)
    f = CACHE / "das_city_of_sydney.csv"
    if f.exists():
        try:
            d = pd.read_csv(f); d["date"] = pd.to_datetime(d["date"], errors="coerce")
            d = d[(d["date"] <= cutoff) & (d["date"] > cutoff - pd.DateOffset(months=24))].dropna(subset=["lat", "lng"])
            ext["da"] = d[["lat", "lng"]].values
        except Exception as ex:  # noqa
            print("DA table unusable:", ex)
    osm = {}
    for name, cols in [("osm_supermarkets", None), ("osm_buildings", None), ("osm_green_water_nodes", None), ("osm_major_roads_nodes", None)]:
        f = CACHE / f"{name}.csv"
        if f.exists():
            try:
                osm[name] = pd.read_csv(f).dropna(subset=["lat", "lng"])
            except Exception as ex:  # noqa
                print(name, "unusable:", ex)
    if osm:
        ext["osm"] = osm
    print("external groups:", sorted(ext))
    return ext


def postcode_of(t):
    pc = t["postcode"].astype("string").str.extract(r"(\d{4})")[0] if "postcode" in t and t["postcode"].notna().any() else pd.Series(pd.NA, index=t.index, dtype="string")
    guess = t["address"].astype("string").str.extract(r"(\d{4})\s*$")[0]
    return pc.fillna(guess)


# ---------------------------------------------------------------- LOO helpers
def _loo_median(v):
    """median of the other elements, for each element (O(n log n))."""
    v = np.asarray(v, float); n = len(v)
    if n < 2:
        return np.full(n, np.nan)
    order = np.argsort(v, kind="stable"); s = v[order]
    rank = np.empty(n, int); rank[order] = np.arange(n)
    m = n - 1
    if m % 2 == 1:
        k = m // 2
        out = np.where(rank <= k, s[np.minimum(k + 1, n - 1)], s[k])
    else:
        k = m // 2
        i1 = (k - 1) + ((k - 1) >= rank); i2 = k + (k >= rank)
        out = (s[i1] + s[i2]) / 2
    return out


def loo_group_median(df, keys, col):
    """median of `col` within group excluding the row itself (NaN if alone)."""
    out = pd.Series(np.nan, index=df.index)
    for _, idx in df.groupby(keys, sort=False, dropna=False).indices.items():
        if len(idx) >= 2:
            out.iloc[idx] = _loo_median(df[col].values[idx])
    return out


# ---------------------------------------------------------------- main builder
class FeatureBuilder:
    """Fit on history (leases <= cutoff) + input flats, then transform any target frame."""

    def __init__(self, hist, flats, blocks, cutoff, horizon_months=2):
        self.cutoff = pd.Timestamp(cutoff)
        self.cut_m = pd.Period(self.cutoff, "M")
        self.horizon = horizon_months
        self.blocks = blocks
        self.stops = fetch_stops()
        st = self.stops["stops"]
        self.train_pts = [(s[1], s[2]) for s in st if s[3] == "train"]
        self.lr_pts = [(s[1], s[2]) for s in st if s[3] == "lr"]
        h = hist[hist["date"] <= self.cutoff].copy()
        h["bg"] = bed_group(h["bedrooms"])
        h["m"] = h["date"].dt.to_period("M")
        self.bonds = load_bonds(self.cut_m)
        self.ext = load_external(self.cut_m, self.cutoff)
        self.idx = monthly_index(h, self.cutoff)
        self.growth = annual_growth(self.idx)
        self.season = seasonal_factors(h)
        base_months = [(self.cut_m - k).month for k in range(3)]  # the trailing window the cutoff index averages over
        self.season_base = float(self.season.reindex(base_months).mean())
        # suburb -> most common postcode in the input (for files whose address lacks a postcode)
        pc = postcode_of(flats)
        self.suburb_postcode = pc.groupby(flats["suburb"].values).agg(lambda x: x.mode().iloc[0] if x.notna().any() else pd.NA)
        # rent indexed to cutoff month
        h["rent_idx"] = h["rent"] * index_ratio(self.idx, h["bg"], h["m"], np.full(len(h), self.cut_m))
        h["bkey"] = building_keys(h).values
        h["fkey"] = flat_key(h)
        self.hist = h
        # flats per building from the input
        fk = building_keys(flats)
        self.flats_per_bld = fk.value_counts()
        if "flats_in_building" in flats and flats["flats_in_building"].notna().any():
            self.flats_in_bld_col = pd.Series(flats["flats_in_building"].values, index=fk.values).groupby(level=0).max()
        else:
            self.flats_in_bld_col = None
        # suburb x bed medians (indexed)
        self.sub_bed_med = h.groupby(["suburb", "bg"])["rent_idx"].median()
        self.sub_bed_n = h.groupby(["suburb", "bg"]).size()
        self.bed_med = h.groupby("bg")["rent_idx"].median()
        # parking premium tables
        self.premium_bld, self.premium_sub, self.premium_bed, self.premium_city = self._parking_premiums(h)
        # per-building medians (all history, used for prediction rows)
        self.bld_bed_med = h.groupby(["bkey", "bg"])["rent_idx"].median()
        self.bld_bed_n = h.groupby(["bkey", "bg"]).size()
        h["sub_bed_ref"] = pd.MultiIndex.from_arrays([h["suburb"], h["bg"]]).map(self.sub_bed_med).values
        h["sub_bed_ref"] = h["sub_bed_ref"].fillna(h["bg"].map(self.bed_med))
        h["ratio"] = h["rent_idx"] / h["sub_bed_ref"]
        self.bld_ratio = h.groupby("bkey")["ratio"].median()
        self.bld_n = h.groupby("bkey").size()
        # neighbour trees per bedroom group (local market level)
        from sklearn.neighbors import BallTree
        self.nb = {}
        hv = h[h["lat"].notna() & h["lng"].notna()]
        for bg, grp in hv.groupby("bg"):
            self.nb[bg] = (BallTree(np.radians(grp[["lat", "lng"]].values), metric="haversine"),
                           grp.index.values, grp["ratio"].values, grp["bkey"].values)
        # last advert per flat
        last = h.sort_values("date").groupby("fkey").tail(1).set_index("fkey")
        self.last_rent = last["rent"]; self.last_date = last["date"]; self.last_bg = last["bg"]; self.last_parking = last["parking"]
        self.n_adverts = h.groupby("fkey").size()

    def season_mult(self, months_ahead):
        """multiplier to move a cutoff-level prediction to the calendar month `months_ahead` later."""
        ma = np.atleast_1d(np.asarray(months_ahead, float))
        tgt = [(self.cut_m + int(round(x))).month for x in ma]
        return self.season.reindex(tgt).values / self.season_base

    def _parking_premiums(self, h):
        p = h[h["parking"].notna()]
        g = p.groupby(["bkey", "bg", "parking"])["rent_idx"].agg(["median", "size"]).unstack("parking")
        bld = pd.Series(np.nan, index=g.index)
        if g.shape[1] >= 4:
            ok = (g[("size", 0.0)] >= 1) & (g[("size", 1.0)] >= 1)
            bld[ok] = (g[("median", 1.0)] - g[("median", 0.0)])[ok]
        bld = bld.dropna().clip(-50, 250)
        g2 = p.groupby(["suburb", "bg", "parking"])["rent_idx"].agg(["median", "size"]).unstack("parking")
        sub = pd.Series(np.nan, index=g2.index)
        if g2.shape[1] >= 4:
            ok = (g2[("size", 0.0)] >= 10) & (g2[("size", 1.0)] >= 10)
            sub[ok] = (g2[("median", 1.0)] - g2[("median", 0.0)])[ok]
        sub = sub.dropna().clip(0, 250)
        g3 = p.groupby(["bg", "parking"])["rent_idx"].median().unstack("parking")
        bed = (g3[1.0] - g3[0.0]).clip(0, 250) if g3.shape[1] >= 2 else pd.Series(dtype=float)
        city = float(np.clip(p[p.parking == 1].rent_idx.median() - p[p.parking == 0].rent_idx.median(), 0, 250)) if p.parking.nunique() == 2 else 50.0
        return bld, sub, bed, city

    def parking_premium(self, bkey, suburb, bg):
        mi = pd.MultiIndex.from_arrays([bkey, bg])
        v = pd.Series(mi.map(self.premium_bld).values, dtype=float)
        v2 = pd.Series(pd.MultiIndex.from_arrays([suburb, bg]).map(self.premium_sub).values, dtype=float)
        v3 = pd.Series(pd.Index(bg).map(self.premium_bed).values, dtype=float)
        src = np.where(v.notna(), "building", np.where(v2.notna(), "suburb", np.where(v3.notna(), "bedrooms", "city")))
        # building-level estimates are noisy: shrink halfway toward the suburb/bed value
        v2 = v2.fillna(v3).fillna(self.premium_city)
        v = (0.5 * v + 0.5 * v2).where(v.notna(), v2)
        return v.values, src

    def transform(self, t, training=False):
        """t: frame with address, suburb, lat, lng, unit_number, bedrooms, bathrooms, parking, gnaf_id (+ date, rent when training).
        Returns a feature DataFrame (same index) plus a few helper columns prefixed '_'."""
        t = t.copy()
        X = pd.DataFrame(index=t.index)
        bg = bed_group(t["bedrooms"])
        X["bedrooms"] = pd.to_numeric(t["bedrooms"], errors="coerce")
        X["bathrooms"] = pd.to_numeric(t["bathrooms"], errors="coerce")
        X["parking"] = pd.to_numeric(t["parking"], errors="coerce")
        ff = floor_features(t["unit_number"])
        X["floor"] = ff["floor"]; X["floor_known"] = ff["floor_known"]; X["penthouse"] = ff["penthouse"]
        if "floor_level" in t:
            fl = pd.to_numeric(t["floor_level"], errors="coerce")
            ok = (fl.notna() & (fl >= 0) & (fl <= 80)).values
            X.loc[ok, "floor"] = fl.values[ok]; X.loc[ok, "floor_known"] = 1.0
        pt = t["property_type"].astype("string").str.lower() if "property_type" in t else pd.Series(pd.NA, index=t.index, dtype="string")
        X["is_studio"] = pt.str.contains("studio", na=False).astype(float).where(pt.notna())
        X["is_unit"] = pt.str.contains("unit|flat", na=False).astype(float).where(pt.notna())
        if "first_listed" in t:
            fd = pd.to_datetime(t["first_listed"], errors="coerce")
            X["years_since_first_listed"] = ((self.cutoff - fd).dt.days / 365.25).values
        else:
            X["years_since_first_listed"] = np.nan
        X["unit_digits"] = unit_digits(t["unit_number"])
        X["lat"] = pd.to_numeric(t["lat"], errors="coerce"); X["lng"] = pd.to_numeric(t["lng"], errors="coerce")
        X["suburb"] = t["suburb"].astype(str)
        bkey = building_keys(t)
        X["flats_per_building"] = bkey.map(self.flats_per_bld).astype(float)
        if self.flats_in_bld_col is not None:
            X["flats_per_building"] = X["flats_per_building"].fillna(bkey.map(self.flats_in_bld_col).astype(float))
        # distances
        X["dist_cbd_m"] = haversine_m(X["lat"].values, X["lng"].values, CBD[0], CBD[1])
        X["dist_train_m"] = nearest_m(X["lat"].values, X["lng"].values, self.train_pts)
        X["dist_lr_m"] = nearest_m(X["lat"].values, X["lng"].values, self.lr_pts)
        # suburb x bed reference
        sb = pd.MultiIndex.from_arrays([X["suburb"], bg])
        X["suburb_bed_median"] = pd.Series(sb.map(self.sub_bed_med).values, index=t.index, dtype=float)
        X["suburb_bed_median"] = X["suburb_bed_median"].fillna(pd.Series(bg.map(self.bed_med).values, index=t.index))
        # target month for indexing
        if training:
            tm = t["date"].dt.to_period("M")
        else:
            tm = pd.Series(np.full(len(t), self.cut_m), index=t.index)
        X["months_before_cutoff"] = (self.cut_m - tm).apply(lambda d: d.n if hasattr(d, "n") else d).astype(float)
        # building median rent per bed + building premium ratio (LOO when training)
        if training:
            h = self.hist
            X["bld_bed_median"] = loo_group_median(h, ["bkey", "bg"], "rent_idx").values
            X["bld_bed_n"] = (h.groupby(["bkey", "bg"])["rent_idx"].transform("size") - 1).values
            X["bld_ratio"] = loo_group_median(h, ["bkey"], "ratio").values
            X["bld_n"] = (h.groupby("bkey")["ratio"].transform("size") - 1).values
        else:
            bb = pd.MultiIndex.from_arrays([bkey, bg])
            X["bld_bed_median"] = pd.Series(bb.map(self.bld_bed_med).values, index=t.index, dtype=float)
            X["bld_bed_n"] = pd.Series(bb.map(self.bld_bed_n).values, index=t.index, dtype=float).fillna(0)
            X["bld_ratio"] = pd.Series(pd.Index(bkey).map(self.bld_ratio).values, index=t.index, dtype=float)
            X["bld_n"] = pd.Series(pd.Index(bkey).map(self.bld_n).values, index=t.index, dtype=float).fillna(0)
        # neighbours: median ratio (rent / suburb x bed median) of nearest same-bedroom adverts within 400 m
        X["nb_ratio"] = np.nan; X["nb_ratio_other_bld"] = np.nan; X["nb_n"] = 0.0; X["nb_dist_m"] = np.nan
        for g, (tree, hidx, ratio, hbk) in self.nb.items():
            rows = np.where((bg.values == g) & X["lat"].notna().values & X["lng"].notna().values)[0]
            if len(rows) == 0:
                continue
            k = min(17, len(hidx))
            dist, ind = tree.query(np.radians(np.c_[X["lat"].values[rows], X["lng"].values[rows]]), k=k)
            dist = dist * 6371000.0
            r = ratio[ind]; nbk = hbk[ind]
            valid = dist <= 400
            if training:
                valid &= hidx[ind] != t.index.values[rows][:, None]
            r = np.where(valid, r, np.nan)
            with np.errstate(all="ignore"):
                X.iloc[rows, X.columns.get_loc("nb_ratio")] = np.nanmedian(r, axis=1)
                other = np.where(nbk != bkey.values[rows][:, None], r, np.nan)
                X.iloc[rows, X.columns.get_loc("nb_ratio_other_bld")] = np.nanmedian(other, axis=1)
            X.iloc[rows, X.columns.get_loc("nb_n")] = valid.sum(axis=1)
            X.iloc[rows, X.columns.get_loc("nb_dist_m")] = np.where(valid.any(axis=1), np.where(valid, dist, np.inf).min(axis=1), np.nan)
        X["nb_level"] = X["nb_ratio"] * X["suburb_bed_median"]
        # last own rent (strictly earlier advert when training)
        fkey = flat_key(t)
        if training:
            h = self.hist.sort_values(["fkey", "date"])
            prev_rent = h.groupby("fkey")["rent"].shift(1)
            prev_date = h.groupby("fkey")["date"].shift(1)
            prev_park = h.groupby("fkey")["parking"].shift(1)
            n_prev = h.groupby("fkey").cumcount()
            prev = pd.DataFrame({"r": prev_rent, "d": prev_date, "p": prev_park, "n": n_prev}).reindex(t.index)
            last_rent, last_date, last_park, n_adv = prev["r"], prev["d"], prev["p"], prev["n"]
        else:
            last_rent = fkey.map(self.last_rent).astype(float)
            last_date = pd.to_datetime(fkey.map(self.last_date))
            last_park = fkey.map(self.last_parking).astype(float)
            n_adv = fkey.map(self.n_adverts).astype(float).fillna(0)
        X["_last_rent"] = last_rent.values
        X["_last_date"] = last_date.values
        lm = pd.PeriodIndex(last_date.dt.to_period("M").fillna(self.cut_m))
        ratio = index_ratio(self.idx, bg.values, lm, pd.PeriodIndex(tm))
        X["last_rent_indexed"] = last_rent.values * ratio
        X["months_since_last_rent"] = ((pd.PeriodIndex(tm) - lm)).map(lambda d: d.n).astype(float)
        X.loc[last_rent.isna().values, "months_since_last_rent"] = np.nan
        X["last_parking"] = last_park.values
        X["n_prev_adverts"] = n_adv.values
        stale = X["months_since_last_rent"].values > STALE_MONTHS  # a rent from >5 years ago is not evidence of today's rent
        X.loc[stale, ["last_rent_indexed", "last_parking"]] = np.nan
        X["last_rel_suburb"] = X["last_rent_indexed"] / X["suburb_bed_median"]
        # parking premium fallback
        prem, src = self.parking_premium(bkey.values, X["suburb"].values, bg.values)
        X["_parking_premium"] = prem
        X["_parking_premium_src"] = src
        # bonds (postcode x bedroom group)
        if self.bonds is not None:
            pc = postcode_of(t)
            pc = pc.fillna(pd.Series(t["suburb"].map(self.suburb_postcode).values, index=t.index, dtype="string"))
            key = pd.MultiIndex.from_arrays([pc.astype(object).where(pc.notna(), "?"), bg])
            X["bond_median"] = pd.Series(key.map(self.bonds["bond_median"]).values, index=t.index, dtype=float)
            X["bond_yoy"] = pd.Series(key.map(self.bonds["bond_yoy"]).values, index=t.index, dtype=float)
            X["bond_rel_suburb"] = X["bond_median"] / X["suburb_bed_median"]
        # external: suburb series, DAs, OSM
        if "sr" in self.ext:
            sr = self.ext["sr"].reindex(X["suburb"].values)
            X["sr_level"] = sr["sr_level"].values; X["sr_yoy"] = sr["sr_yoy"].values
            X["sr_rel"] = X["sr_level"] / X["suburb_bed_median"]
        if "da" in self.ext:
            X["da_count_300m"] = count_within_m(X["lat"].values, X["lng"].values, self.ext["da"], 300)
        if "osm" in self.ext:
            o = self.ext["osm"]
            if "osm_supermarkets" in o:
                X["osm_dist_supermarket_m"] = nearest_m(X["lat"].values, X["lng"].values, o["osm_supermarkets"][["lat", "lng"]].values)
            if "osm_buildings" in o:
                b = o["osm_buildings"]
                d, i = nearest_m(X["lat"].values, X["lng"].values, b[["lat", "lng"]].values, return_index=True)
                near = d <= 40
                lv = pd.to_numeric(b["levels"], errors="coerce").values if "levels" in b else np.full(len(b), np.nan)
                ht = pd.to_numeric(b["height_m"], errors="coerce").values if "height_m" in b else np.full(len(b), np.nan)
                X["osm_levels"] = np.where(near, lv[np.maximum(i, 0)], np.nan)
                X["osm_height_m"] = np.where(near, ht[np.maximum(i, 0)], np.nan)
            if "osm_green_water_nodes" in o:
                g = o["osm_green_water_nodes"]
                for kind, col in [("park", "osm_dist_park_m"), ("water", "osm_dist_water_m"), ("coast", "osm_dist_coast_m")]:
                    pts = g[g["kind"] == kind][["lat", "lng"]].values if "kind" in g else np.zeros((0, 2))
                    if len(pts):
                        X[col] = nearest_m(X["lat"].values, X["lng"].values, pts)
            if "osm_major_roads_nodes" in o:
                X["osm_dist_major_road_m"] = nearest_m(X["lat"].values, X["lng"].values, o["osm_major_roads_nodes"][["lat", "lng"]].values)
        # census
        if self.blocks is not None and "mesh_block" in t:
            mb = t["mesh_block"].astype("string")
            cen = self.blocks.set_index("mesh_block").reindex(mb.values)
            for c in cen.columns:
                X[c] = cen[c].values.astype(float)
        X["_bkey"] = bkey.values
        X["_fkey"] = fkey.values
        X["_bg"] = bg.values
        if training:
            X["_target_month"] = tm.values
            X["_y"] = pd.to_numeric(t["rent"], errors="coerce").values
            # target expressed at the row's own month; keep raw rent as target (index enters via features)
        return X


FEATURE_COLS_BASE = ["bedrooms", "bathrooms", "parking", "floor", "floor_known", "penthouse", "unit_digits", "lat", "lng",
                     "flats_per_building", "dist_cbd_m", "dist_train_m", "dist_lr_m", "suburb_bed_median", "months_before_cutoff",
                     "bld_bed_median", "bld_bed_n", "bld_ratio", "bld_n", "last_rent_indexed", "months_since_last_rent",
                     "last_parking", "n_prev_adverts", "last_rel_suburb", "suburb",
                     "nb_ratio", "nb_ratio_other_bld", "nb_n", "nb_dist_m", "nb_level", "is_studio", "is_unit", "years_since_first_listed"]


FEATURE_GROUPS = ("mb_", "bond_", "sr_", "da_", "osm_")


def excluded_groups():
    f = ROOT / "pipeline" / "out" / "feature_groups.json"
    if f.exists():
        try:
            return tuple(json.loads(f.read_text(encoding="utf-8")).get("exclude", []))
        except Exception:  # noqa
            return ()
    return ()


def feature_cols(X, exclude=None):
    exclude = excluded_groups() if exclude is None else tuple(exclude)
    keep = [g for g in FEATURE_GROUPS if g not in exclude]
    return [c for c in FEATURE_COLS_BASE if c in X.columns] + [c for c in X.columns if any(c.startswith(g) for g in keep)]


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(ROOT / "pipeline"))
    from load import load
    flats, leases, blocks, src = load(verbose=False)
    fb = FeatureBuilder(leases, flats, blocks, "2026-04-30")
    Xt = fb.transform(fb.hist, training=True)
    Xp = fb.transform(flats.head(500))
    print("growth/yr", fb.growth)
    print(Xt[feature_cols(Xt)].describe().T[["count", "mean", "min", "max"]])
    print(Xp[["floor", "floor_known", "flats_per_building", "dist_train_m", "last_rent_indexed", "_parking_premium"]].head(10))
    print(Xp["_parking_premium_src"].value_counts())
