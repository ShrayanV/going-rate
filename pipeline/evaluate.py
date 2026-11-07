"""Held-out checks.

Nested (headline): tune every choice (external feature groups, LightGBM config/target, blend weight, trend
extrapolation, parking-gap mix, level shift) on 2026-02-01..2026-04-30 using adverts dated before 2026-02-01; freeze
those choices; train on adverts <= 2026-04-30 and score 2026-05-01..2026-07-31 (the Microburbs example split).
Also reported: the same choices re-tuned on the May-Jul window itself (optimistic, labelled as such).

python pipeline/evaluate.py
"""
import json
import sys
import time
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from load import load, CUTOFF  # noqa: E402
from features import FeatureBuilder, FEATURE_GROUPS  # noqa: E402
from model import Models, LGB_GRID  # noqa: E402

OUT = ROOT / "pipeline" / "out"
TRAIN_END = pd.Timestamp("2026-04-30")
INNER_END = pd.Timestamp("2026-01-31")
BENCHMARKS = {"Microburbs model": (86.0, 55.21, None), "Suburb-median baseline": (100.0, 56.39, None),
              "Example report (group median)": (100.0, 56.8, 0.645)}


def metrics(y, p):
    y = np.asarray(y, float); p = np.asarray(p, float)
    e = np.abs(y - p)
    ss = np.sum((y - y.mean()) ** 2)
    return {"n": int(len(y)), "median_abs_error": float(np.median(e)), "mean_abs_error": float(e.mean()),
            "within_50": float((e <= 50).mean() * 100), "within_100": float((e <= 100).mean() * 100),
            "within_200": float((e <= 200).mean() * 100), "r2": float(1 - np.sum((y - p) ** 2) / ss) if ss > 0 else float("nan"),
            "bias": float(np.median(p - y))}


def buckets(y, p):
    e = np.abs(np.asarray(y) - np.asarray(p))
    edges = [0, 25, 50, 100, 150, 200, 300, 500, np.inf]
    labels = [f"{edges[i]:.0f}-{edges[i+1]:.0f}" if np.isfinite(edges[i + 1]) else f"{edges[i]:.0f}+" for i in range(len(edges) - 1)]
    c = pd.cut(e, edges, labels=labels, right=True, include_lowest=True).value_counts().reindex(labels).fillna(0)
    return {k: int(v) for k, v in c.items()}


def _key(m):
    return (round(m["median_abs_error"], 2), -m["within_100"])


def _window(flats, leases, blocks, train_end, test_end):
    train = leases[leases["date"] <= train_end]
    test = leases[(leases["date"] > train_end) & (leases["date"] <= test_end)].reset_index(drop=True)
    fb = FeatureBuilder(train, flats, blocks, train_end)
    Xt = fb.transform(fb.hist, training=True)
    Xs = fb.transform(test)
    months_ahead = ((test["date"].dt.to_period("M") - fb.cut_m).apply(lambda d: d.n)).values.astype(float)
    return dict(fb=fb, Xt=Xt, Xs=Xs, test=test, y=test["rent"].values, pk=test["parking"].values.astype(float),
                months_ahead=months_ahead, n_train=int(len(train)), n_test=int(len(test)))


def _final_preds(m, W, chosen):
    """with/without -> prediction matching each test advert's own parking (midpoint when unknown)."""
    Xs, pk, ma = W["Xs"], W["pk"], W["months_ahead"]
    m.blend_w, m.extrapolate = chosen["blend_w"], chosen["extrapolate"]
    w1 = m.predict_blend(Xs, np.ones(len(Xs)), ma); w0 = m.predict_blend(Xs, np.zeros(len(Xs)), ma)
    hi, lo = m.mix_gap(w1, w0, Xs, chosen["gap_mix"])
    hi, lo = m.finalize(hi + chosen["bias_correction"], lo + chosen["bias_correction"], Xs)
    known = ~np.isnan(pk)
    p = np.where(known, np.where(pk == 1, hi, lo), (hi + lo) / 2)
    return p, hi, lo


def _models(W, chosen):
    return Models(W["fb"], blend_w=chosen["blend_w"], extrapolate=chosen["extrapolate"], gap_mix=chosen["gap_mix"],
                  lgb_cfg=chosen["lgb_cfg"], target=chosen["target"], exclude=tuple(chosen["exclude_groups"]), clip=chosen.get("clip", True),
                  half_life=chosen.get("half_life")).fit(W["Xt"])


def tune(W, label):
    """Choose every knob on window W. Returns (chosen, results table, fitted models)."""
    fb, Xt, Xs, y, pk, ma = W["fb"], W["Xt"], W["Xs"], W["y"], W["pk"], W["months_ahead"]
    res = {}
    m = Models(fb, exclude=()).fit(Xt)
    res["A_group_median"] = metrics(y, m.predict_a(Xs, pk))
    # 1. external feature groups: drop a group if the model is better without it (greedy, one pass)
    base_cfg = ("deep", "raw")
    m.refit_lgb(Xt, *base_cfg); m.extrapolate = False
    cur = metrics(y, m.predict_c(Xs, pk, ma)); exclude = []
    res["C_all_feature_groups"] = cur
    for g in FEATURE_GROUPS:
        if not any(c.startswith(g) for c in Xt.columns):
            continue
        m.exclude = tuple(exclude + [g]); m.refit_lgb(Xt, *base_cfg)
        r = metrics(y, m.predict_c(Xs, pk, ma)); res[f"C_without_{g.rstrip('_')}"] = r
        if _key(r) < _key(cur):
            exclude.append(g); cur = r
    m.exclude = tuple(exclude)
    # 2. LightGBM config / target
    grid = {}
    for cfg in LGB_GRID:
        for target in ("raw", "log"):
            m.refit_lgb(Xt, cfg, target)
            grid[(cfg, target)] = metrics(y, m.predict_c(Xs, pk, ma)); res[f"C_{cfg}_{target}"] = grid[(cfg, target)]
    best_cfg = min(grid, key=lambda k: _key(grid[k]))
    m.refit_lgb(Xt, *best_cfg)
    # 2b. recency weighting of training adverts
    hl_scores = {None: grid[best_cfg]}
    for hl in (18, 36):
        m.refit_lgb(Xt, *best_cfg, half_life=hl)
        hl_scores[hl] = metrics(y, m.predict_c(Xs, pk, ma)); res[f"C_halflife_{hl}m"] = hl_scores[hl]
    half_life = min(hl_scores, key=lambda k: _key(hl_scores[k]))
    m.refit_lgb(Xt, *best_cfg, half_life=half_life)
    # 3. blend weight x extrapolation
    cands = {}
    res["B_last_rent"] = metrics(y, m.predict_b(Xs, pk, ma))
    for extrap in (False, "growth", "seasonal", "both"):
        m.extrapolate = extrap
        for w in (0.25, 0.5, 0.75, 1.0, "decay"):
            r = metrics(y, m.predict_blend(Xs, pk, ma, w=w)); cands[(w, extrap)] = r
            res[f"blend_w{w}_{extrap or 'none'}"] = r
    (w, extrap) = min(cands, key=lambda k: _key(cands[k]))
    m.extrapolate = extrap
    # 4. parking gap mix
    w1 = m.predict_blend(Xs, np.ones(len(Xs)), ma, w=w); w0 = m.predict_blend(Xs, np.zeros(len(Xs)), ma, w=w)
    known = ~np.isnan(pk); gaps = {}
    for lam in (0.0, 0.25, 0.5, 0.75, 1.0):
        hi, lo = m.mix_gap(w1, w0, Xs, lam)
        gaps[lam] = metrics(y, np.where(known, np.where(pk == 1, hi, lo), (hi + lo) / 2)); res[f"gap_mix_{lam}"] = gaps[lam]
    lam = min(gaps, key=lambda k: _key(gaps[k]))
    hi, lo = m.mix_gap(w1, w0, Xs, lam)
    pb = np.where(known, np.where(pk == 1, hi, lo), (hi + lo) / 2)
    # 5. level shift
    shifts = {sh: metrics(y, pb + sh) for sh in np.arange(-60, 61, 5.0)}
    bias = float(min(shifts, key=lambda k: (_key(shifts[k]), abs(k))))
    chosen = {"tuned_on": label, "exclude_groups": exclude, "lgb_cfg": best_cfg[0], "target": best_cfg[1], "half_life": half_life, "blend_w": w,
              "extrapolate": extrap, "gap_mix": lam, "bias_correction": bias, "growth_per_year": fb.growth}
    res["chosen_before_shift"] = metrics(y, pb)
    res["chosen_with_shift"] = metrics(y, pb + bias)
    m.clip = True
    hic, loc = m.finalize(hi + bias, lo + bias, Xs)
    res["chosen_with_shift_and_clipping"] = metrics(y, np.where(known, np.where(pk == 1, hic, loc), (hic + loc) / 2))
    chosen["clip"] = bool(_key(res["chosen_with_shift_and_clipping"]) <= _key(res["chosen_with_shift"]))
    chosen["clip_counts_tune_window"] = dict(m.clip_counts)
    chosen["seasonal_factors"] = {int(k): round(float(v), 4) for k, v in fb.season.items()}
    print(f"[{label}] chosen: {chosen}")
    return chosen, res, m


def diagnostics(W, p, hi, lo):
    y, pk, Xs, test = W["y"], W["pk"], W["Xs"], W["test"]
    resid = p - y
    months = test["date"].dt.to_period("M").astype(str).values
    by_month = {mo: {"n": int((months == mo).sum()), "median_resid": float(np.median(resid[months == mo])),
                     "median_abs_error": float(np.median(np.abs(resid[months == mo])))} for mo in sorted(set(months))}
    by_parking = {}
    for k, mask in [("with", pk == 1), ("without", pk == 0), ("unknown", np.isnan(pk))]:
        if mask.sum():
            d = metrics(y[mask], p[mask]); d["median_resid"] = float(np.median(resid[mask])); by_parking[k] = d
    recent = (Xs["months_since_last_rent"].values <= 18) & ~np.isnan(Xs["last_rent_indexed"].values)
    return {"by_month": by_month, "by_parking": by_parking,
            "by_bedrooms": {str(int(b)): metrics(y[Xs["_bg"].values == b], p[Xs["_bg"].values == b]) for b in sorted(set(Xs["_bg"].values))},
            "has_recent_own_rent": {"yes": metrics(y[recent], p[recent]) if recent.sum() else None,
                                    "no": metrics(y[~recent], p[~recent]) if (~recent).sum() else None},
            "median_gap_predicted": float(np.median(hi - lo)), "error_buckets": buckets(y, p)}


def run_holdout(flats, leases, blocks):
    t0 = time.time()
    Wi = _window(flats, leases, blocks, INNER_END, TRAIN_END)
    print(f"inner: train {Wi['n_train']} adverts <= {INNER_END.date()}, tune on {Wi['n_test']} adverts to {TRAIN_END.date()}")
    chosen, res_inner, mi = tune(Wi, f"{INNER_END.date()}..{TRAIN_END.date()}")
    inner_diag = diagnostics(Wi, *_final_preds(mi, Wi, chosen))
    Wo = _window(flats, leases, blocks, TRAIN_END, CUTOFF)
    print(f"outer: train {Wo['n_train']} adverts <= {TRAIN_END.date()}, test {Wo['n_test']} adverts to {CUTOFF.date()}")
    m = _models(Wo, chosen)
    p, hi, lo = _final_preds(m, Wo, chosen)
    nested = metrics(Wo["y"], p)
    nested_no_shift = metrics(Wo["y"], p - chosen["bias_correction"])
    diag = diagnostics(Wo, p, hi, lo)
    # submission variant (added after the drift check): same frozen choices + the calendar-month factor from 2019-2026 history
    chosen_final = {**chosen, "extrapolate": "seasonal", "bias_correction": 0.0, "clip": True,
                    "note": "frozen inner-window choices; forward adjustment = seasonal factor estimated from 2019-2026 history (not tuned)"}
    m.extrapolate = "seasonal"
    ps, his, los = _final_preds(m, Wo, chosen_final)
    nested_seasonal = metrics(Wo["y"], ps)
    diag_seasonal = diagnostics(Wo, ps, his, los)
    m.extrapolate = chosen["extrapolate"]
    chosen_opt, res_outer, _ = tune(Wo, f"{TRAIN_END.date()}..{CUTOFF.date()} (test window itself)")
    imp = m.importance().head(25).to_dict()
    out = {"split": {"inner_train_end": str(INNER_END.date()), "inner_test": f"{(INNER_END + pd.Timedelta(days=1)).date()}..{TRAIN_END.date()}",
                     "inner_n_train": Wi["n_train"], "inner_n_test": Wi["n_test"],
                     "train_end": str(TRAIN_END.date()), "test_start": str((TRAIN_END + pd.Timedelta(days=1)).date()), "test_end": str(CUTOFF.date()),
                     "n_train": Wo["n_train"], "n_test": Wo["n_test"]},
           "headline_nested": nested, "headline_nested_without_shift": nested_no_shift, "chosen": chosen,
           "headline_nested_seasonal": nested_seasonal, "chosen_final": chosen_final, "breakdown_seasonal_by_month": diag_seasonal["by_month"],
           "inner_seasonal": res_inner.get(f"blend_w{chosen['blend_w']}_seasonal"),
           "optimistic_tuned_on_test_window": {"chosen": chosen_opt, "metrics": res_outer["chosen_with_shift"]},
           "results_inner_window": res_inner, "results_outer_window_tuned_on_itself": res_outer,
           "breakdown": diag, "inner_breakdown_by_month": inner_diag["by_month"], "inner_breakdown_by_parking": inner_diag["by_parking"],
           "feature_importance": {k: int(v) for k, v in imp.items()},
           "benchmarks": {k: {"median_abs_error": v[0], "within_100": v[1], "r2": v[2]} for k, v in BENCHMARKS.items()},
           "stops_source": Wo["fb"].stops["source"], "seconds": round(time.time() - t0, 1)}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "holdout.json").write_text(json.dumps(out, indent=2, default=float), encoding="utf-8")
    (OUT / "feature_groups.json").write_text(json.dumps({"exclude": chosen["exclude_groups"]}), encoding="utf-8")
    (OUT / "holdout.md").write_text(holdout_md(out), encoding="utf-8")
    print(holdout_md(out))
    return out


def _row(k, v):
    return f"| {k} | {v['median_abs_error']:.1f} | {v['mean_abs_error']:.1f} | {v['within_50']:.1f}% | {v['within_100']:.1f}% | {v['within_200']:.1f}% | {v['r2']:.3f} | {v['bias']:+.1f} |"


HDR = ["| model | median abs err $ | mean abs err $ | within $50 | within $100 | within $200 | R2 | median(pred-actual) $ |", "|---|---|---|---|---|---|---|---|"]


def holdout_md(out):
    sp = out["split"]; h = out["headline_nested"]; c = out["chosen"]; o = out["optimistic_tuned_on_test_window"]
    L = ["# Held-out check (nested)",
         f"Headline: train on adverts <= {sp['train_end']} (n={sp['n_train']:,}), test {sp['test_start']}..{sp['test_end']} (n={sp['n_test']:,}). "
         f"All modelling choices were frozen on an earlier window (train <= {sp['inner_train_end']}, tune on {sp['inner_test']}, n={sp['inner_n_test']:,}).", "",
         f"**Nested held-out: median abs error ${h['median_abs_error']:.1f}, {h['within_100']:.1f}% within $100, R2 {h['r2']:.3f}** "
         f"(without the frozen level shift of {c['bias_correction']:+.0f}: ${out['headline_nested_without_shift']['median_abs_error']:.1f}, "
         f"{out['headline_nested_without_shift']['within_100']:.1f}%).",
         f"Tuned on the test window itself (optimistic, for reference only): ${o['metrics']['median_abs_error']:.1f}, {o['metrics']['within_100']:.1f}%.", "",
         f"Submission variant = frozen choices + calendar-month factor (estimated from 2019-2026 adverts before the training cutoff; added after seeing the month-by-month drift, factors not tuned: "
         f"${out['headline_nested_seasonal']['median_abs_error']:.1f}, {out['headline_nested_seasonal']['within_100']:.1f}% within $100, "
         f"median(pred-actual) {out['headline_nested_seasonal']['bias']:+.1f} on May-Jul; on the Feb-Apr tuning window the same factor gives "
         + (f"${out['inner_seasonal']['median_abs_error']:.1f}, {out['inner_seasonal']['within_100']:.1f}%." if out.get('inner_seasonal') else "n/a."), "",
         f"Frozen choices: `{json.dumps(c)}`", "",
         "## Inner window (choices made here)", *HDR]
    for k, v in out["results_inner_window"].items():
        L.append(_row(k, v))
    ro = out["results_outer_window_tuned_on_itself"]
    L += ["", "## Outer window: headline (frozen choices) and reference rows", *HDR,
          _row("A_group_median (example-report baseline)", ro["A_group_median"]), _row("B_last_rent", ro["B_last_rent"]),
          _row("NESTED headline (frozen choices)", h), _row("NESTED + seasonal factor (submission config)", out["headline_nested_seasonal"]),
          _row("tuned on test window itself (optimistic)", o["metrics"])]
    for k, v in out["benchmarks"].items():
        L.append(f"| benchmark: {k} | {v['median_abs_error']:.0f} | | | {v['within_100']:.2f}% | | {v['r2'] if v['r2'] else ''} | |")
    L += ["", "## Residual diagnostics (nested headline predictions)", "median(pred - actual) by month, outer window:"]
    for mo, d in out["breakdown"]["by_month"].items():
        L.append(f"- {mo}: n={d['n']} median resid {d['median_resid']:+.1f}, median abs err {d['median_abs_error']:.1f}")
    L.append("same, with the seasonal factor (submission config):")
    for mo, d in out["breakdown_seasonal_by_month"].items():
        L.append(f"- {mo}: n={d['n']} median resid {d['median_resid']:+.1f}, median abs err {d['median_abs_error']:.1f}")
    L.append("inner window by month (same frozen choices):")
    for mo, d in out["inner_breakdown_by_month"].items():
        L.append(f"- {mo}: n={d['n']} median resid {d['median_resid']:+.1f}, median abs err {d['median_abs_error']:.1f}")
    L.append("by parking (outer):")
    for k, d in out["breakdown"]["by_parking"].items():
        L.append(f"- {k}: n={d['n']} median resid {d['median_resid']:+.1f}, median abs err {d['median_abs_error']:.1f}, within100 {d['within_100']:.1f}%")
    L.append(f"median predicted parking gap: {out['breakdown']['median_gap_predicted']:.1f}")
    for grp in ("by_bedrooms", "has_recent_own_rent"):
        for k, v in out["breakdown"][grp].items():
            if v:
                L.append(f"- {grp}={k}: n={v['n']} median={v['median_abs_error']:.1f} within100={v['within_100']:.1f}%")
    L.append(f"- error buckets: {out['breakdown']['error_buckets']}")
    L += ["", "## Feature importance (splits)", ", ".join(f"{k}:{v}" for k, v in out["feature_importance"].items())]
    return "\n".join(L)


def final_fit(flats, leases, blocks, chosen):
    """Refit on all adverts <= cutoff with the frozen choices and predict with/without for every input flat."""
    fb = FeatureBuilder(leases, flats, blocks, CUTOFF)
    Xt = fb.transform(fb.hist, training=True)
    Xp = fb.transform(flats)
    m = Models(fb, blend_w=chosen["blend_w"], extrapolate=chosen["extrapolate"], gap_mix=chosen.get("gap_mix", 1.0),
               lgb_cfg=chosen.get("lgb_cfg", "base"), target=chosen.get("target", "raw"), exclude=tuple(chosen.get("exclude_groups", [])),
               clip=chosen.get("clip", True), half_life=chosen.get("half_life")).fit(Xt)
    b = chosen.get("bias_correction", 0.0)
    n = len(Xp)
    with_ = m.predict_blend(Xp, np.ones(n), fb.horizon) + b
    without = m.predict_blend(Xp, np.zeros(n), fb.horizon) + b
    with_, without = m.finalize(*m.mix_gap(with_, without, Xp, m.gap_mix), Xp)
    print(f"final predictions: horizon {fb.horizon} months, forward factor {float(np.atleast_1d(m._factor(fb.horizon))[0]):.4f}, clipped {m.clip_counts}")
    return fb, m, Xp, with_, without


if __name__ == "__main__":
    flats, leases, blocks, src = load(verbose=False)
    print("source:", src)
    run_holdout(flats, leases, blocks)
