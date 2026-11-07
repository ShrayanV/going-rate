"use client";
import { useEffect, useRef, useState } from "react";
import type { FindHit, SortKey } from "@/app/api/rent/find/route";
import { metres, money, shortName, titleCase } from "@/lib/types";

type FindResult = { data: FindHit[]; matched: number; error?: string };

const SORT_LABEL: Record<SortKey, string> = {
  city: "Closest to the city",
  cheapest: "Cheapest first",
  value: "Best value for the area",
  train: "Closest to a train",
  priciest: "Most expensive first",
};

/** "Where can I afford": budget, bedrooms, car space, near a train, sort. Server does the filtering. */
export function Finder({ onPick }: { onPick: (hit: FindHit) => void }) {
  const [budget, setBudget] = useState(850);
  const [beds, setBeds] = useState("any");
  const [parking, setParking] = useState(false);
  const [nearTrain, setNearTrain] = useState(false);
  const [sort, setSort] = useState<SortKey>("city");
  const [res, setRes] = useState<FindResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    // Every change starts a new request and cancels the previous one; only the latest
    // request's answer is ever shown, so late filter changes are never lost.
    const id = ++reqId.current;
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      const q = new URLSearchParams({ budget: String(budget), beds, parking: parking ? "yes" : "any", near_train: nearTrain ? "1" : "0", sort });
      fetch(`/api/rent/find?${q}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((j: FindResult) => {
          if (id !== reqId.current) return;
          setRes(j);
          setLoading(false);
        })
        .catch((e) => {
          if (ctrl.signal.aborted || id !== reqId.current) return;
          setRes({ data: [], matched: 0, error: String(e) });
          setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [budget, beds, parking, nearTrain, sort]);

  const count = res && !res.error ? res.matched : null;

  return (
    <div className="finder">
      <label className="finder__budget">
        <span>
          Up to <strong>{money(budget)}</strong> a week
        </span>
        <input type="range" min={400} max={1600} step={10} value={budget} onChange={(e) => setBudget(Number(e.target.value))} aria-label="Weekly budget" />
      </label>
      <div className="finder__row">
        <div className="seg" role="radiogroup" aria-label="Bedrooms">
          {[
            ["any", "Any"],
            ["0", "Studio"],
            ["1", "1 bed"],
            ["2", "2 bed"],
            ["3", "3+"],
          ].map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={beds === v} className={beds === v ? "is-on" : ""} onClick={() => setBeds(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="finder__row">
        <button type="button" className={`chip ${parking ? "is-on" : ""}`} aria-pressed={parking} onClick={() => setParking((p) => !p)}>
          {parking ? "✓ " : ""}Car space
        </button>
        <button type="button" className={`chip ${nearTrain ? "is-on" : ""}`} aria-pressed={nearTrain} onClick={() => setNearTrain((p) => !p)}>
          {nearTrain ? "✓ " : ""}Near a train
        </button>
      </div>

      <div className="finder__bar">
        <p className="finder__count" aria-live="polite">
          {res === null ? (
            "Looking…"
          ) : res.error ? (
            `Could not search: ${res.error}`
          ) : count === 0 ? (
            "No flats fit. Nudge the budget up."
          ) : (
            <>
              <strong>{count!.toLocaleString("en-AU")}</strong> flats fit
            </>
          )}
          {loading && res !== null && <span className="finder__busy"> · updating…</span>}
        </p>
        <label className="finder__sort">
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {res && res.data.length > 0 && (
        <ul className={`finder__list ${loading ? "is-loading" : ""}`}>
          {res.data.map((h) => {
            const unit = /^(UNIT|FLAT|APARTMENT)\s+(\S+),\s*/i.exec(h.address);
            const street = titleCase(h.address.replace(/^(UNIT|FLAT|APARTMENT|LEVEL)\s+\S+,\s*/i, "").replace(/\s+\d{4}$/, "")).replace(
              new RegExp(`\\s+${shortName(h.suburb)}$`, "i"),
              "",
            );
            const facts = [
              h.bedrooms === 0 ? "Studio" : h.bedrooms != null ? `${h.bedrooms} bed` : null,
              h.bathrooms ? `${h.bathrooms} bath` : null,
              h.car_space === 1 ? "Car space" : null,
              h.floor ? `Floor ${h.floor}` : null,
            ].filter(Boolean);
            return (
              <li key={h.gnaf_id} className={active === h.gnaf_id ? "is-active" : ""}>
                <button
                  type="button"
                  onClick={() => {
                    setActive(h.gnaf_id);
                    onPick(h);
                  }}
                >
                  <span className="fl__main">
                    <span className="fl__addr">
                      {unit ? <span className="fl__unit">Unit {unit[2].replace(/,$/, "")}</span> : null}
                      {street}
                    </span>
                    <span className="fl__sub">{shortName(h.suburb)}</span>
                    <span className="fl__facts">
                      {facts.map((f) => (
                        <i key={f as string}>{f}</i>
                      ))}
                      {h.dist_train_m != null && h.dist_train_m <= 800 && <i className="fl__train">{metres(h.dist_train_m)} to train</i>}
                    </span>
                  </span>
                  <span className="fl__price">
                    <strong>{money(h.rent)}</strong>
                    <small>/ week</small>
                    {h.vs_suburb != null && Math.abs(h.vs_suburb) >= 15 && Math.abs(h.vs_suburb) <= 0.35 * (h.rent - h.vs_suburb) && (
                      <em className={h.vs_suburb < 0 ? "good" : "bad"}>
                        {money(Math.abs(h.vs_suburb))} {h.vs_suburb < 0 ? "below" : "above"} area
                      </em>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
