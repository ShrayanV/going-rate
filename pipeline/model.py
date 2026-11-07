"""Models: Baseline A (group medians, mirrors the Microburbs example), Baseline B (own last rent indexed forward),
Model C (LightGBM, L1 objective) and a blend of C with B for flats with a recent own advert."""
import numpy as np
import pandas as pd
import lightgbm as lgb

from features import feature_cols, bed_group

LGB_PARAMS = dict(objective="l1", n_estimators=900, learning_rate=0.03, num_leaves=31, min_child_samples=20,
                  subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, n_jobs=4)
LGB_GRID = {
    "base": {},
    "deep": dict(num_leaves=63, min_child_samples=10, n_estimators=1200),
}
TRAIN_WINDOW_MONTHS = 48  # LightGBM rows: adverts within this many months of the cutoff (history features still use everything)
RECENT_MONTHS = 18


class Models:
    def __init__(self, fb, blend_w=0.5, extrapolate=False, gap_mix=1.0, lgb_cfg="base", target="raw", exclude=None, clip=True, half_life=None):
        self.fb = fb
        self.half_life = half_life  # months; recency weight 0.5 ** (age / half_life); None = unweighted
        self.clip = clip
        self.exclude = exclude  # external feature-group prefixes to drop (None = read pipeline/out/feature_groups.json)
        self.lgb_cfg = lgb_cfg
        self.target = target  # raw or log
        self.blend_w = blend_w  # weight on Model C when blending with B
        self.extrapolate = extrapolate  # False | "growth" | "seasonal" | "both"
        self.gap_mix = gap_mix  # 1 = model's own with-without gap, 0 = observed building/suburb premium
        self.cols = None
        self.cats = None

    # ---------------- Baseline A: suburb x bedrooms x parking medians, last 12 months, min 10 adverts
    def _fit_baseline_a(self):
        h = self.fb.hist
        h = h[h["date"] > self.fb.cutoff - pd.DateOffset(months=12)].copy()
        h["pk"] = h["parking"].fillna(-1)
        def tbl(keys):
            g = h.groupby(keys)["rent"].agg(["median", "size"])
            return g[g["size"] >= 10]["median"]
        self.a_sbp = tbl(["suburb", "bg", "pk"]); self.a_sb = tbl(["suburb", "bg"]); self.a_bp = tbl(["bg", "pk"])
        self.a_b = h.groupby("bg")["rent"].median(); self.a_all = float(h["rent"].median())
        # plausibility bounds from the same 12 months
        self.city_p1 = h.groupby("bg")["rent"].quantile(0.01)
        self.sub_bed_med = h.groupby(["suburb", "bg"])["rent"].median()
        self.sub_bed_p99 = h.groupby(["suburb", "bg"])["rent"].quantile(0.99)
        self.bed_p99 = h.groupby("bg")["rent"].quantile(0.99)
        self.clip_counts = {"floor": 0, "ceiling": 0}

    def bounds(self, X):
        bg = X["_bg"].values; sub = X["suburb"].values
        mi = pd.MultiIndex.from_arrays([sub, bg])
        p1 = pd.Series(pd.Index(bg).map(self.city_p1).values, index=X.index, dtype=float).fillna(0)
        med = pd.Series(mi.map(self.sub_bed_med).values, index=X.index, dtype=float)
        p99 = pd.Series(mi.map(self.sub_bed_p99).values, index=X.index, dtype=float)
        p99 = p99.fillna(pd.Series(pd.Index(bg).map(self.bed_p99).values, index=X.index, dtype=float))
        lo = p1.values  # citywide 1st percentile for the bedroom count (gentle floor)
        hi = np.where(np.isnan(p99.values), np.inf, 1.3 * p99.values)
        return lo, hi

    def finalize(self, with_, without, X):
        """Clip both predictions to plausible bounds and enforce with >= without."""
        lo, hi = self.bounds(X)
        self.clip_counts = {"floor": int((without < lo).sum() + (with_ < lo).sum()), "ceiling": int((with_ > hi).sum() + (without > hi).sum())}
        if self.clip:
            without = np.clip(without, lo, hi); with_ = np.clip(with_, lo, hi)
        else:
            self.clip_counts = {"floor": 0, "ceiling": 0, "disabled": True}
        with_ = np.maximum(with_, without)
        return with_, without

    def predict_a(self, X, parking):
        bg = X["_bg"].values; sub = X["suburb"].values
        pk = pd.Series(parking, index=X.index).fillna(-1).values
        p = pd.Series(pd.MultiIndex.from_arrays([sub, bg, pk]).map(self.a_sbp).values, index=X.index, dtype=float)
        p = p.fillna(pd.Series(pd.MultiIndex.from_arrays([sub, bg]).map(self.a_sb).values, index=X.index, dtype=float))
        p = p.fillna(pd.Series(pd.MultiIndex.from_arrays([bg, pk]).map(self.a_bp).values, index=X.index, dtype=float))
        p = p.fillna(pd.Series(pd.Index(bg).map(self.a_b).values, index=X.index, dtype=float)).fillna(self.a_all)
        return p.values

    def _factor(self, months_ahead):
        """forward adjustment from the cutoff price level to the target month."""
        ma = np.atleast_1d(np.asarray(months_ahead, float))
        f = np.ones_like(ma)
        if self.extrapolate in ("growth", "both", True):
            f = f * (1 + self.fb.growth) ** (ma / 12)
        if self.extrapolate in ("seasonal", "both"):
            f = f * self.fb.season_mult(ma)
        return f

    # ---------------- Baseline B: own last rent indexed forward (+ parking adjustment), else A
    def predict_b(self, X, parking, months_ahead=0):
        lr = X["last_rent_indexed"].values.copy()
        lp = X["last_parking"].values
        pk = np.asarray(parking, float)
        adj = np.where(np.isnan(lp) | np.isnan(pk), 0.0, (pk - lp) * X["_parking_premium"].values)
        b = (lr + adj) * self._factor(months_ahead)
        a = self.predict_a(X, parking)
        return np.where(np.isnan(b), a, b)

    # ---------------- Model C: LightGBM
    def fit(self, Xt):
        self._fit_baseline_a()
        self.cols = feature_cols(Xt, exclude=self.exclude)
        y = Xt["_y"].values
        # train on rent indexed to the cutoff month so the model learns price levels at the cutoff
        y_idx = self.fb.hist["rent_idx"].reindex(Xt.index).values
        Xm = self._matrix(Xt, fit=True)
        ok = ~np.isnan(y_idx) & (Xt["months_before_cutoff"].values <= TRAIN_WINDOW_MONTHS)
        self.model = lgb.LGBMRegressor(**{**LGB_PARAMS, **LGB_GRID.get(self.lgb_cfg, {})})
        yy = np.log(y_idx[ok]) if self.target == "log" else y_idx[ok]
        sw = 0.5 ** (Xt["months_before_cutoff"].values[ok] / self.half_life) if self.half_life else None
        self.model.fit(Xm[ok], yy, sample_weight=sw, categorical_feature=["suburb"])
        return self

    def refit_lgb(self, Xt, lgb_cfg, target, half_life=None):
        self.lgb_cfg, self.target, self.half_life = lgb_cfg, target, half_life
        return self.fit(Xt)

    def _matrix(self, X, fit=False):
        M = X[self.cols].copy()
        if fit:
            self.cats = pd.CategoricalDtype(sorted(M["suburb"].astype(str).unique()))
        M["suburb"] = M["suburb"].astype(str).astype(self.cats)
        M = M.drop(columns=["months_before_cutoff"], errors="ignore")
        for c in M.columns:
            if c != "suburb":
                M[c] = pd.to_numeric(M[c], errors="coerce").astype(float)
        return M

    def predict_c(self, X, parking, months_ahead=0):
        Xp = X.copy()
        Xp["parking"] = np.asarray(parking, float)
        p = self.model.predict(self._matrix(Xp))
        if self.target == "log":
            p = np.exp(p)
        return p * self._factor(months_ahead)

    # ---------------- blend
    def predict_blend(self, X, parking, months_ahead=0, w=None):
        w = self.blend_w if w is None else w
        c = self.predict_c(X, parking, months_ahead)
        b = self.predict_b(X, parking, months_ahead)
        age = X["months_since_last_rent"].values
        has = ~np.isnan(X["last_rent_indexed"].values) & ~np.isnan(age)
        if w == "decay":  # weight on the flat's own last rent falls with its age
            wb = np.select([age <= 6, age <= 18, age <= 36], [0.75, 0.5, 0.25], 0.0)
            return np.where(has, (1 - wb) * c + wb * b, c)
        recent = (age <= RECENT_MONTHS) & has
        return np.where(recent, w * c + (1 - w) * b, c)

    def predict_pair(self, X, months_ahead=0):
        """(with, without) for every row with the monotonic constraint enforced."""
        n = len(X)
        with_ = self.predict_blend(X, np.ones(n), months_ahead)
        without = self.predict_blend(X, np.zeros(n), months_ahead)
        with_, without = self.mix_gap(with_, without, X, self.gap_mix)
        return self.finalize(with_, without, X)

    @staticmethod
    def mix_gap(with_, without, X, lam):
        """Keep the midpoint, replace the gap with lam*model_gap + (1-lam)*observed premium; enforce with >= without."""
        prem = np.nan_to_num(X["_parking_premium"].values, nan=0.0)
        mid = (with_ + without) / 2
        gap = lam * (with_ - without) + (1 - lam) * prem
        gap = np.where(gap < 0, np.maximum(0, prem), gap)
        return mid + gap / 2, mid - gap / 2

    def importance(self):
        names = [c for c in self.cols if c != "months_before_cutoff"]
        return pd.Series(self.model.feature_importances_, index=names).sort_values(ascending=False)
