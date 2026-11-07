"""Write the scored CSV and the app predictions file (per CONTRACT.md), plus insight tables.

Fixture mode (data/ absent): pipeline/out/rents_matcha-cake_fixture.csv and pipeline/out/predictions_fixture.csv only.
Real mode: rents_matcha-cake.csv (repo root), app/private/predictions.csv, pipeline/out/predictions.csv.
"""
import json
import shutil
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.neighbors import BallTree

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "pipeline" / "out"
TEAM = "matcha-cake"
FLOOR_BANDS = [(-1, 0, "ground/low"), (0, 2, "1-2"), (2, 5, "3-5"), (5, 10, "6-10"), (10, 20, "11-20"), (20, 99, "21+")]


def round_half(x):
    return np.round(np.asarray(x, float) * 2) / 2


def validate(scored, n_expected):
    assert list(scored.columns) == ["gnaf_id", "rent_with_car_space", "rent_without_car_space"], scored.columns
    assert len(scored) == n_expected, (len(scored), n_expected)
    assert scored["gnaf_id"].is_unique, "duplicate gnaf_id"
    assert not scored.isna().any().any(), "NaN in output"
    assert (scored["rent_with_car_space"] >= scored["rent_without_car_space"]).all(), "with < without"
    assert (scored["rent_without_car_space"] > 50).all() and (scored["rent_with_car_space"] < 20000).all(), "implausible rent"


def whatif_drivers(m, Xp, with_, without, months_ahead):
    """Signed $ contributions via what-if re-predictions (parking=0 base)."""
    n = len(Xp)
    base = without
    d = {}
    # floor -> 0
    Xf = Xp.copy(); Xf["floor"] = 0.0; Xf["unit_digits"] = np.where(Xp["floor"].values > 0, Xp["unit_digits"].values % 100, Xp["unit_digits"].values)
    d["floor"] = np.where(Xp["floor"].values > 0, base - m.predict_blend(Xf, np.zeros(n), months_ahead), 0.0)
    # own rent history removed
    Xl = Xp.copy()
    for c in ["last_rent_indexed", "months_since_last_rent", "last_parking", "last_rel_suburb"]:
        Xl[c] = np.nan
    Xl["n_prev_adverts"] = 0.0
    d["last_rent"] = np.where(~np.isnan(Xp["last_rent_indexed"].values), base - m.predict_blend(Xl, np.zeros(n), months_ahead), 0.0)
    # building history removed
    Xb = Xp.copy()
    for c in ["bld_bed_median", "bld_ratio"]:
        Xb[c] = np.nan
    Xb["bld_bed_n"] = 0.0; Xb["bld_n"] = 0.0
    d["building"] = np.where(Xp["bld_n"].values > 0, base - m.predict_blend(Xb, np.zeros(n), months_ahead), 0.0)
    d["parking"] = with_ - without
    # location vs suburb median (residual not explained by the above)
    d["location_suburb"] = base - Xp["suburb_bed_median"].values - d["floor"] - d["last_rent"] - d["building"]
    return d


def drivers_json(d, Xp, i):
    items = []
    fl = int(Xp["floor"].values[i])
    cand = [(f"Floor {fl}" if fl > 0 else "Floor", d["floor"][i]), ("Own rent history", d["last_rent"][i]),
            ("Building track record", d["building"][i]), ("Car space", d["parking"][i]),
            ("Location vs suburb median", d["location_suburb"][i])]
    for label, v in cand:
        if np.isfinite(v) and abs(v) >= 1:
            items.append({"label": label, "delta_per_week": round(float(v), 1)})
    items.sort(key=lambda x: -abs(x["delta_per_week"]))
    return json.dumps(items[:5])


def build_comps(fb, Xp, flats, k=5, radius_m=500):
    """Up to k comparable adverts (<= cutoff, same bedroom group): same building first (most recent), then nearest within radius."""
    h = fb.hist
    def rec(r, dm):
        return {"address": str(r[0]), "bedrooms": int(r[1]), "parking": (None if pd.isna(r[2]) else int(r[2])),
                "rent": float(r[3]), "date": str(r[4])[:10], "dist_m": int(dm)}
    hv = h[["address", "bg", "parking", "rent", "date", "bkey"]].copy()
    hv["date"] = hv["date"].dt.strftime("%Y-%m-%d")
    hv = hv.sort_values("date", ascending=False)
    bld_groups = {key: list(zip(*[grp[c].values for c in ["address", "bg", "parking", "rent", "date"]]))[:k]
                  for key, grp in hv.groupby(["bkey", "bg"], sort=False)}
    lat = Xp["lat"].values.astype(float); lng = Xp["lng"].values.astype(float); bgs = Xp["_bg"].values; bks = Xp["_bkey"].values
    near = [None] * len(Xp)
    hl = h[h["lat"].notna() & h["lng"].notna()]
    for bg, grp in hl.groupby("bg"):
        rows = np.where((bgs == bg) & np.isfinite(lat) & np.isfinite(lng))[0]
        if len(rows) == 0:
            continue
        tree = BallTree(np.radians(grp[["lat", "lng"]].values), metric="haversine")
        kk = min(k * 2, len(grp))
        dist, ind = tree.query(np.radians(np.c_[lat[rows], lng[rows]]), k=kk)
        recs = list(zip(grp["address"].astype(str).values, grp["bg"].values, grp["parking"].values, grp["rent"].values,
                        grp["date"].dt.strftime("%Y-%m-%d").values, grp["bkey"].values))
        for ri, d, ix in zip(rows, dist, ind):
            near[ri] = [(recs[j], dd * 6371000.0) for dd, j in zip(d, ix) if dd * 6371000.0 <= radius_m]
    out = []
    for i in range(len(Xp)):
        comps = [rec(r, 0) for r in bld_groups.get((bks[i], bgs[i]), [])]
        if len(comps) < k and near[i]:
            for r, dm in near[i]:
                if r[5] == bks[i]:
                    continue
                comps.append(rec(r, round(dm)))
                if len(comps) >= k:
                    break
        out.append(json.dumps(comps))
    return out


def export(flats, fb, m, Xp, with_, without, is_real, months_ahead):
    OUT.mkdir(parents=True, exist_ok=True)
    with_ = round_half(with_); without = round_half(without)
    with_ = np.maximum(with_, without)
    scored = pd.DataFrame({"gnaf_id": flats["gnaf_id"].values, "rent_with_car_space": with_, "rent_without_car_space": without})
    validate(scored, len(flats))
    print("computing drivers ...")
    d = whatif_drivers(m, Xp, with_, without, months_ahead)
    print("computing comps ...")
    comps = build_comps(fb, Xp, flats)
    pred = pd.DataFrame({
        "gnaf_id": flats["gnaf_id"].values, "address": flats["address"].values, "suburb": flats["suburb"].values,
        "lat": Xp["lat"].values, "lng": Xp["lng"].values, "bedrooms": pd.to_numeric(flats["bedrooms"], errors="coerce").fillna(0).astype(int).values,
        "rent_with_car_space": with_, "rent_without_car_space": without, "parking_premium": with_ - without,
        "floor": np.where(Xp["floor_known"].values == 1, Xp["floor"].values, np.nan),
        "flats_in_building": Xp["flats_per_building"].values, "dist_train_m": np.round(Xp["dist_train_m"].values),
        "last_rent": Xp["_last_rent"].values, "last_rent_date": pd.to_datetime(Xp["_last_date"].values).strftime("%Y-%m-%d").where(pd.notna(Xp["_last_date"].values), ""),
        "suburb_median_rent": round_half(Xp["suburb_bed_median"].values),
        "drivers_json": [drivers_json(d, Xp, i) for i in range(len(Xp))], "comps_json": comps,
        "dist_cbd_m": np.round(Xp["dist_cbd_m"].values), "rent_per_bed": np.round(without / np.maximum(pred_beds(flats), 1), 1),
    })
    for c in ["floor", "flats_in_building"]:
        pred[c] = pred[c].astype("Int64")
    if is_real:
        scored.to_csv(ROOT / f"rents_{TEAM}.csv", index=False)
        pred.to_csv(OUT / "predictions.csv", index=False)
        (ROOT / "app" / "private").mkdir(parents=True, exist_ok=True)
        shutil.copy(OUT / "predictions.csv", ROOT / "app" / "private" / "predictions.csv")
        paths = [ROOT / f"rents_{TEAM}.csv", OUT / "predictions.csv", ROOT / "app" / "private" / "predictions.csv"]
    else:
        scored.to_csv(OUT / f"rents_{TEAM}_fixture.csv", index=False)
        pred.to_csv(OUT / "predictions_fixture.csv", index=False)
        paths = [OUT / f"rents_{TEAM}_fixture.csv", OUT / "predictions_fixture.csv"]
    # insight tables
    prem = pd.DataFrame({"suburb": flats["suburb"].values, "bedrooms": Xp["_bg"].values, "premium": with_ - without})
    by_sub = prem.groupby("suburb").agg(n_flats=("premium", "size"), model_premium_median=("premium", "median")).reset_index()
    h = fb.hist[fb.hist["parking"].notna()]
    obs = h.groupby(["suburb", "bg", "parking"])["rent_idx"].agg(["median", "size"]).unstack("parking")
    if obs.shape[1] == 4:
        ok = (obs[("size", 0.0)] >= 5) & (obs[("size", 1.0)] >= 5)
        diff = (obs[("median", 1.0)] - obs[("median", 0.0)])[ok]
        wts = (obs[("size", 0.0)] + obs[("size", 1.0)])[ok]
        obs_sub = (diff * wts).groupby(level="suburb").sum() / wts.groupby(level="suburb").sum()
        by_sub = by_sub.merge(obs_sub.rename("observed_lease_premium").round(1).reset_index(), on="suburb", how="left")
    by_sub = by_sub.merge(h.groupby("suburb").size().rename("n_leases_with_parking_known").reset_index(), on="suburb", how="left")
    by_sub["median_rent_without"] = prem.assign(w=without).groupby("suburb")["w"].median().reindex(by_sub["suburb"]).values
    by_sub["premium_pct_of_rent"] = (100 * by_sub["model_premium_median"] / by_sub["median_rent_without"]).round(1)
    by_sub = by_sub.sort_values("model_premium_median", ascending=False)
    by_sub.to_csv(OUT / "parking_premium_by_suburb.csv", index=False)
    # floor premium: observed (leases, indexed, relative to suburb x bed median) and model what-if
    fl = fb.hist.copy()
    from features import floor_features
    ff = floor_features(fl["unit_number"])
    fl["floor"] = ff["floor"].values; fl["known"] = ff["floor_known"].values
    fl = fl[fl["known"] == 1]
    fl["rel"] = fl["ratio"]
    rows = []
    base_rel = fl.loc[fl["floor"] == 0, "rel"].median() if (fl["floor"] == 0).any() else 1.0
    mod = pd.DataFrame({"floor": Xp["floor"].values, "known": Xp["floor_known"].values, "delta": d["floor"], "rent": without})
    for lo, hi, name in FLOOR_BANDS:
        o = fl[(fl["floor"] > lo) & (fl["floor"] <= hi)]
        mm = mod[(mod["floor"] > lo) & (mod["floor"] <= hi) & (mod["known"] == 1)]
        rows.append({"floor_band": name, "n_leases": int(len(o)), "observed_uplift_pct_vs_ground": round(100 * (o["rel"].median() / base_rel - 1), 1) if len(o) else np.nan,
                     "n_flats": int(len(mm)), "model_uplift_per_week": round(float(mm["delta"].median()), 1) if len(mm) else np.nan,
                     "model_median_rent_without": round(float(mm["rent"].median()), 1) if len(mm) else np.nan})
    pd.DataFrame(rows).to_csv(OUT / "floor_premium.csv", index=False)
    for p in paths:
        print("wrote", p)
    return scored, pred, by_sub, pd.DataFrame(rows)


def pred_beds(flats):
    return pd.to_numeric(flats["bedrooms"], errors="coerce").fillna(1).values
