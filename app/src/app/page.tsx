"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddressSearch } from "@/components/AddressSearch";
import { Finder } from "@/components/Finder";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Map3D, type HeatData, type Hover, type MapApi, type Target } from "@/components/Map3D";
import { Panel } from "@/components/Panel";
import type { AddressMatch, RentRow, Transport } from "@/lib/types";
import { addressLine, money, shortName } from "@/lib/types";
import { useApi } from "@/lib/useApi";

type Tab = "search" | "find";
const MIN_LOADER_MS = 1200;
const LOADER_FADE_MS = 500;
const BEDS = [
  ["any", "any"],
  ["0", "studio"],
  ["1", "1 bed"],
  ["2", "2 bed"],
  ["3", "3+"],
];
/** predictions.csv spells suburbs "Waterloo (Nsw)"; the API wants "Waterloo (NSW)". */
const apiSuburb = (s: string) => s.replace(/Nsw\)/g, "NSW)");

export default function Home() {
  const [tab, setTab] = useState<Tab>("search");
  const [pick, setPick] = useState<AddressMatch | null>(null);
  // Finder hits and map dots carry their own coordinates; address picks get theirs from transport/nearby.
  const [pickCoords, setPickCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [showHeat, setShowHeat] = useState(false);
  const [heatBeds, setHeatBeds] = useState("any");
  const [heat, setHeat] = useState<HeatData>(null);
  const [tiers, setTiers] = useState<number[]>([0, 1, 2]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [hover, setHover] = useState<Hover>(null);
  const [hoverRow, setHoverRow] = useState<RentRow | null>(null);
  const rowCache = useRef(new Map<string, RentRow | null>());
  const mapApi = useRef<MapApi | null>(null);

  /* ---------------------------------------------------- loading screen */
  const [progress, setProgress] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [loaderDone, setLoaderDone] = useState(false); // fading out
  // Never hold the loading screen more than a few seconds for the rent data.
  const [heatTimedOut, setHeatTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHeatTimedOut(true), 6000);
    return () => clearTimeout(t);
  }, []);
  const [loaderGone, setLoaderGone] = useState(false); // unmounted
  const mountedAt = useRef<number | null>(null);
  useEffect(() => {
    mountedAt.current ??= Date.now();
  }, []);
  const onProgress = useCallback((p: number) => setProgress(p), []);
  const onReady = useCallback(() => setMapReady(true), []);
  const onApi = useCallback((api: MapApi) => {
    mapApi.current = api;
  }, []);
  const [bearing, setBearing] = useState(-20);
  const [orbiting, setOrbiting] = useState(false);
  const onBearing = useCallback((b: number) => setBearing(b), []);
  const onOrbit = useCallback((on: boolean) => setOrbiting(on), []);
  useEffect(() => {
    if (!mapReady || (!heat && !heatTimedOut)) return;
    const wait = Math.max(0, MIN_LOADER_MS - (Date.now() - (mountedAt.current ?? Date.now())));
    const t1 = setTimeout(() => setLoaderDone(true), wait);
    const t2 = setTimeout(() => setLoaderGone(true), wait + LOADER_FADE_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [mapReady, heat, heatTimedOut]);

  /* --------------------------------------------- keyboard: "/" and Esc */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setTab("search");
        setLeftOpen(true);
        requestAnimationFrame(() => document.getElementById("address-q")?.focus());
      } else if (e.key === "Escape") {
        if (typing) (t as HTMLElement).blur();
        else setRightOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ------------------------------------------------------- picking */
  const choose = useCallback((m: AddressMatch, coords: { lat: number; lng: number } | null) => {
    setPickCoords(coords);
    setPick(m);
    setRightOpen(true);
  }, []);
  const onPickPoint = useCallback(
    async (gnaf: string, lng: number, lat: number) => {
      let row = rowCache.current.get(gnaf);
      if (row === undefined) {
        row = (await fetch(`/api/rent?gnaf=${encodeURIComponent(gnaf)}`).then((r) => r.json()).catch(() => ({ data: null }))).data as RentRow | null;
        rowCache.current.set(gnaf, row);
      }
      choose({ id: gnaf, display_name: row?.address ?? gnaf, sal: row ? apiSuburb(row.suburb) : null, property_type: "unit" }, { lat, lng });
    },
    [choose],
  );
  const onHover = useCallback((h: Hover) => setHover(h), []);
  useEffect(() => {
    if (!hover) return;
    const cached = rowCache.current.get(hover.gnaf);
    if (cached !== undefined) {
      setHoverRow(cached);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      fetch(`/api/rent?gnaf=${encodeURIComponent(hover.gnaf)}`)
        .then((r) => r.json())
        .then((j: { data: RentRow | null }) => {
          rowCache.current.set(hover.gnaf, j.data);
          if (alive) setHoverRow(j.data);
        })
        .catch(() => alive && setHoverRow(null));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [hover]);

  const transport = useApi<Transport>(pick ? `/v1/properties/${encodeURIComponent(pick.id)}/transport/nearby` : null);

  const target = useMemo<Target>(() => {
    if (!pick) return null;
    if (pickCoords) return { ...pickCoords, label: pick.display_name };
    const t = transport.data;
    if (!t || typeof t.center_lat !== "number") return null;
    return { lat: t.center_lat, lng: t.center_lng, label: pick.display_name };
  }, [pick, pickCoords, transport.data]);

  /* ------------------------------------------------------- rent map */
  // Preloaded from the start (behind the loading screen) so the rent map switches on instantly.
  useEffect(() => {
    let alive = true;
    fetch(`/api/rent/points?beds=${heatBeds}`)
      .then((r) => r.json())
      .then((j: { points: (number | string)[][]; cuts: number[] }) => alive && setHeat({ points: j.points, cuts: j.cuts }))
      .catch(() => alive && setHeat(null));
    return () => {
      alive = false;
    };
  }, [heatBeds]);

  const [heatTried, setHeatTried] = useState(false);
  const toggleHeat = () => {
    setHeatTried(true);
    setShowHeat((on) => {
      const next = !on;
      // With nothing selected, get the card out of the heatmap's way.
      if (next && !pick) setLeftOpen(false);
      if (!next) setLeftOpen(true);
      return next;
    });
  };
  const toggleTier = (t: number) => setTiers((ts) => (ts.includes(t) ? (ts.length > 1 ? ts.filter((x) => x !== t) : ts) : [...ts, t].sort()));

  const compact = !!pick && tab === "search";
  const hoverLabel = hoverRow ? `${addressLine(hoverRow.address, hoverRow.suburb)}, ${shortName(hoverRow.suburb)}` : hover ? "Loading…" : "";

  return (
    <main className="stage">
      <div className={`map-wrap ${loaderDone || loaderGone ? "is-visible" : ""}`}>
        <Map3D target={target} heat={heat} heatVisible={showHeat} tiers={tiers} onProgress={onProgress} onReady={onReady} onHover={onHover} onPickPoint={onPickPoint} onApi={onApi} onBearing={onBearing} onOrbit={onOrbit} />
      </div>
      <div className="vignette" aria-hidden />

      {hover && (
        <div className="tip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip">
          <span className="tip__addr">{hoverLabel}</span>
          <span className="tip__meta">
            {hoverRow ? `${hoverRow.bedrooms === 0 ? "studio" : `${hoverRow.bedrooms ?? "?"} bed`} · ${money(hoverRow.rent_without_car_space)} a week without a car space` : `${money(hover.value)} a week per bedroom`}
          </span>
        </div>
      )}

      {/* ------------------------------------------------- left card */}
      <div className={`left ${compact ? "left--compact" : ""} ${loaderGone ? "" : "is-hidden"} ${leftOpen ? "" : "left--closed"}`}>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "is-on" : ""} onClick={() => setTab("search")}>
            This flat
          </button>
          <button type="button" role="tab" aria-selected={tab === "find"} className={tab === "find" ? "is-on" : ""} onClick={() => setTab("find")}>
            Where can I afford
          </button>
          <button type="button" className={`toggle ${showHeat ? "is-on" : ""} ${heatTried ? "" : "is-new"}`} aria-pressed={showHeat} onClick={toggleHeat} title="See every flat's rent across the city in 3D">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <rect x="1" y="8" width="3" height="7" rx="0.6" fill="currentColor" opacity="0.7" />
              <rect x="6" y="3" width="3" height="12" rx="0.6" fill="currentColor" />
              <rect x="11" y="6" width="3" height="9" rx="0.6" fill="currentColor" opacity="0.85" />
            </svg>
            Rent map
          </button>
          <button type="button" className="collapse" aria-label="Collapse search" title="Collapse" onClick={() => setLeftOpen(false)}>
            <Chevron dir="left" />
          </button>
        </div>
        {tab === "search" ? (
          <>
            <AddressSearch compact={compact} onPick={(m, c) => choose(m, c ?? null)} />
            {pick && !pickCoords && transport.error && <p className="left__err">Could not place this address: {transport.error}</p>}
          </>
        ) : (
          <Finder onPick={(h) => choose({ id: h.gnaf_id, display_name: h.address, sal: apiSuburb(h.suburb), property_type: "unit" }, { lat: h.lat, lng: h.lng })} />
        )}
      </div>
      {!leftOpen && loaderGone && (
        <button type="button" className="edge edge--left" onClick={() => setLeftOpen(true)} aria-label="Open search">
          <SearchIcon />
          <span>Search</span>
        </button>
      )}

      {/* ------------------------------------------------ right panel */}
      {pick && rightOpen && (
        <div className="right" key={pick.id}>
          <Panel pick={pick} transport={transport} coords={pickCoords} onCollapse={() => setRightOpen(false)} onChoose={choose} />
        </div>
      )}
      {pick && !rightOpen && (
        <button type="button" className="edge edge--right" onClick={() => setRightOpen(true)} aria-label="Open details">
          <InfoIcon />
          <span>{addressLine(pick.display_name, pick.sal)}{pick.sal ? `, ${shortName(pick.sal)}` : ""}</span>
        </button>
      )}

      {/* ------------------------------------------- rent map controls */}
      {showHeat && heat && loaderGone && (
        <div className={`legend ${pick && rightOpen ? "legend--shifted" : ""}`}>
          <span className="legend__title">Rent per bedroom, a week</span>
          <div className="legend__tiers" role="group" aria-label="Show tiers">
            {[
              [0, `under ${money(heat.cuts[0])}`],
              [1, `${money(heat.cuts[0])} to ${money(heat.cuts[1])}`],
              [2, `over ${money(heat.cuts[1])}`],
            ].map(([t, label]) => (
              <button key={t} type="button" aria-pressed={tiers.includes(t as number)} className={tiers.includes(t as number) ? "is-on" : ""} onClick={() => toggleTier(t as number)}>
                <i className={`t${t}`} />
                <b className="tier">{"$".repeat((t as number) + 1)}</b> {label}
              </button>
            ))}
          </div>
          <div className="seg seg--small" role="radiogroup" aria-label="Bedrooms on the rent map">
            {BEDS.map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={heatBeds === v} className={heatBeds === v ? "is-on" : ""} onClick={() => setHeatBeds(v)}>
                {l}
              </button>
            ))}
          </div>
          <span className="legend__hint">Zoom in for flats. Click a dot to open it.</span>
        </div>
      )}

      <footer className={`foot ${loaderGone ? "" : "is-hidden"}`}>
        <span className="badge">matcha cake</span>
        <span className="foot__right">
          <span className="rotate" role="group" aria-label="Rotate the map">
            <button type="button" className="reset" onClick={() => mapApi.current?.rotateBy(-45)} aria-label="Rotate left" title="Rotate left (Q)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /></svg>
            </button>
            <button type="button" className="reset compass" onClick={() => mapApi.current?.resetNorth()} aria-label="Face north" title="Face north">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden style={{ transform: `rotate(${-bearing}deg)` }}>
                <path d="M12 2 L16 12 L12 10.5 L8 12 Z" fill="var(--matcha)" />
                <path d="M12 22 L8 12 L12 13.5 L16 12 Z" fill="currentColor" opacity="0.5" />
              </svg>
            </button>
            <button type="button" className="reset" onClick={() => mapApi.current?.rotateBy(45)} aria-label="Rotate right" title="Rotate right (E)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
            </button>
            <button type="button" className={`reset orbit ${orbiting ? "is-on" : ""}`} aria-pressed={orbiting} onClick={() => mapApi.current?.toggleOrbit()} aria-label={orbiting ? "Stop orbit" : "Orbit"} title={orbiting ? "Stop orbit" : "Orbit slowly around this view"}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><ellipse cx="12" cy="12" rx="10" ry="4.5" /><circle cx="12" cy="12" r="2.2" fill="currentColor" /></svg>
              <span>{orbiting ? "Stop" : "Orbit"}</span>
            </button>
          </span>
          <button type="button" className="reset" onClick={() => mapApi.current?.resetView()} aria-label="Back to the city view" title="Back to the city view">
            <HomeIcon />
          </button>
          <span className="attr">
            © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · Data: Microburbs Hackathon API
          </span>
        </span>
      </footer>

      {!loaderGone && <LoadingScreen progress={progress} done={loaderDone} />}
    </main>
  );
}


function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d={dir === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m10.5 10.5 3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7v4.5M8 4.8v.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 7.5 8 3l5.5 4.5V13a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
