"""One command: load -> features -> holdout evaluate -> refit on all adverts <= 2026-07-31 -> export -> report.

python pipeline/run.py
"""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from load import load  # noqa: E402
from evaluate import run_holdout, final_fit  # noqa: E402
from export import export  # noqa: E402


def main():
    t0 = time.time()
    flats, leases, blocks, src = load(verbose=False)
    is_real = src.startswith("REAL")
    print(f"[{time.time()-t0:5.1f}s] loaded ({src}): {len(flats)} flats, {len(leases)} adverts <= cutoff")
    hold = run_holdout(flats, leases, blocks)
    print(f"[{time.time()-t0:5.1f}s] holdout done")
    fb, m, Xp, with_, without = final_fit(flats, leases, blocks, hold.get("chosen_final", hold["chosen"]))
    print(f"[{time.time()-t0:5.1f}s] refit on all adverts <= {fb.cutoff.date()} (n={len(fb.hist)})")
    scored, pred, by_sub, floors = export(flats, fb, m, Xp, with_, without, is_real, fb.horizon)
    print(f"[{time.time()-t0:5.1f}s] exported {len(scored)} rows ({'REAL' if is_real else 'FIXTURE'} mode)")
    try:
        from report import build_report
        build_report(hold, scored, pred, by_sub, floors, fb, src, is_real)
        print(f"[{time.time()-t0:5.1f}s] report built")
    except ImportError:
        print("report.py not available yet")
    c = hold["chosen"]
    h = hold["headline_nested"]; hs = hold["headline_nested_seasonal"]; o = hold["optimistic_tuned_on_test_window"]["metrics"]
    print("\n=== HEADLINE ===")
    print(f"data: {src}")
    print(f"NESTED held-out ({hold['split']['test_start']}..{hold['split']['test_end']}, n={hold['split']['n_test']}, choices frozen on {hold['split']['inner_test']}): "
          f"median abs error ${h['median_abs_error']:.1f}, within $100 {h['within_100']:.1f}%, R2 {h['r2']:.3f}")
    print(f"NESTED + seasonal factor (submission config): ${hs['median_abs_error']:.1f}, {hs['within_100']:.1f}%, median resid {hs['bias']:+.1f}")
    print(f"tuned on the test window itself (optimistic): ${o['median_abs_error']:.1f}, {o['within_100']:.1f}% | frozen choices: {c}")
    print(f"benchmarks: Microburbs model $86 / 55.21%; suburb-median $100 / 56.39%; example report $100 / 56.8% / R2 0.645")
    print(f"predictions: median with ${scored['rent_with_car_space'].median():.0f}, without ${scored['rent_without_car_space'].median():.0f}, "
          f"median parking premium ${(scored['rent_with_car_space']-scored['rent_without_car_space']).median():.0f}")
    print(f"total {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
