"use client";
import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
// maplibre's stylesheet is served from /public (linked in layout.tsx) because
// Turbopack + Tailwind v4 fail to evaluate CSS imported from node_modules here.
import { CITY_CENTRE } from "@/lib/types";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const FALLBACK_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const ACCENT = "#8BBF6A";
const BUILDING_OPACITY = 0.92;
/** The opening shot. The map is created slightly zoomed out so the surrounding ring of tiles is cached. */
export const START = { center: [151.2062, -33.8778] as [number, number], zoom: 14.05, pitch: 58, bearing: -24 };

export type Target = { lng: number; lat: number; label: string } | null;
/** From /api/rent/points: [lng, lat, value, tier, gnaf] and the tercile cut-offs. */
export type HeatData = { points: (number | string)[][]; cuts: number[] } | null;
export type Hover = { x: number; y: number; gnaf: string; value: number; tier: number } | null;
export type MapApi = {
  resetView: () => void;
  /** Smoothly turn the camera by `deg` degrees around the screen centre. */
  rotateBy: (deg: number) => void;
  /** Face north (bearing 0). */
  resetNorth: () => void;
  /** Start or stop a slow cinematic orbit; returns the new state. */
  toggleOrbit: () => boolean;
};

const TIER_COLOURS = ["#3fb0a0", "#a5d46a", "#f2784b"];

/** Base-map wash: dims roads, water and land so labels and data read clearly. */
const DIM_IDLE = 0.42;
const DIM_HEAT = 0.68;
function setDim(map: maplibregl.Map, v: number) {
  if (map.getLayer("mc-dim")) map.setPaintProperty("mc-dim", "fill-opacity", v);
}

const COLS_OPACITY: maplibregl.ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 11, 0.95, 13.6, 0.9, 14.6, 0];
const DOTS_OPACITY: maplibregl.ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 14, 0, 14.8, 0.9];

/** ~110 m grid cell size in degrees at Sydney's latitude. */
const CELL_LAT = 0.001;
const CELL_LNG = 0.0012;

/** Bin flats into grid cells; each cell becomes a column whose height and colour are its median rent per bedroom. */
function buildColumns(heat: NonNullable<HeatData>): GeoJSON.FeatureCollection {
  const cells = new Map<string, { i: number; j: number; v: number[] }>();
  for (const [lng, lat, value] of heat.points) {
    const i = Math.floor((lng as number) / CELL_LNG);
    const j = Math.floor((lat as number) / CELL_LAT);
    const k = `${i}:${j}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { i, j, v: [] }));
    c.v.push(value as number);
  }
  const [lo, hi] = heat.cuts;
  const inset = 0.12;
  const features: GeoJSON.Feature[] = [];
  for (const c of cells.values()) {
    if (c.v.length < 3) continue; // a lone flat is noise, not a neighbourhood
    c.v.sort((a, b) => a - b);
    const med = c.v[Math.floor(c.v.length / 2)];
    const x0 = (c.i + inset) * CELL_LNG, x1 = (c.i + 1 - inset) * CELL_LNG;
    const y0 = (c.j + inset) * CELL_LAT, y1 = (c.j + 1 - inset) * CELL_LAT;
    features.push({
      type: "Feature",
      properties: { value: med, n: c.v.length, tier: med < lo ? 0 : med < hi ? 1 : 2 },
      geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Show or hide the (preloaded) rent layers. The data is added while the loading screen
 * is up, so switching the rent map on is instant: no download, no re-tiling.
 */
function setHeatVisibility(map: maplibregl.Map, on: boolean, animate = true) {
  const m = map as maplibregl.Map & { __heatOn?: boolean; __skylineShown?: boolean };
  m.__heatOn = on;
  // Layers stay "visible" so their tiles are built in advance; we fade opacity instead.
  if (map.getLayer("mc-cols")) map.setPaintProperty("mc-cols", "fill-extrusion-opacity", on ? COLS_OPACITY : 0);
  if (map.getLayer("mc-heat-circle")) {
    map.setPaintProperty("mc-heat-circle", "circle-opacity", on ? DOTS_OPACITY : 0);
    map.setPaintProperty("mc-heat-circle", "circle-stroke-opacity", on ? DOTS_OPACITY : 0);
  }
  setDim(map, on ? DIM_HEAT : DIM_IDLE);
  // First time on: swing to a low, dramatic angle on the skyline unless already down at street level.
  if (on && animate && !m.__skylineShown && map.getLayer("mc-cols") && map.getZoom() < 14 && !map.isMoving()) {
    m.__skylineShown = true;
    map.easeTo({ zoom: 13.1, pitch: 54, bearing: -32, duration: 1800 });
  }
}

function applyHeat(map: maplibregl.Map, heat: HeatData) {
  const src = map.getSource("mc-heat") as maplibregl.GeoJSONSource | undefined;
  if (!heat) {
    for (const id of ["mc-heat-circle", "mc-cols"]) if (map.getLayer(id)) map.removeLayer(id);
    if (src) map.removeSource("mc-heat");
    if (map.getSource("mc-cols")) map.removeSource("mc-cols");
    return;
  }
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: heat.points.map(([lng, lat, value, tier, gnaf]) => ({
      type: "Feature",
      properties: { value, tier, gnaf },
      geometry: { type: "Point", coordinates: [lng as number, lat as number] },
    })),
  };
  const cols = buildColumns(heat);
  if (src) {
    src.setData(data);
    (map.getSource("mc-cols") as maplibregl.GeoJSONSource | undefined)?.setData(cols);
    return;
  }
  map.addSource("mc-heat", { type: "geojson", data, promoteId: "gnaf" });
  map.addSource("mc-cols", { type: "geojson", data: cols });
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  const [lo, hi] = heat.cuts;
  map.addLayer(
    {
      id: "mc-cols",
      type: "fill-extrusion",
      source: "mc-cols",
      maxzoom: 14.7,
      paint: {
        // A rent skyline: taller and hotter where a bedroom costs more.
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["get", "value"],
          lo * 0.7, "#1f6f86",
          lo, "#3fb0a0",
          (lo + hi) / 2, "#a5d46a",
          hi, "#f5c94c",
          hi * 1.3, "#f2784b",
          hi * 1.7, "#ff4f7b",
        ],
        // Full height over the city; shrinks as you zoom in so the clickable flats take over.
        "fill-extrusion-height": [
          "interpolate", ["linear"], ["zoom"],
          12, ["*", ["max", 30, ["-", ["get", "value"], lo * 0.6]], 2.2],
          13.5, ["*", ["max", 30, ["-", ["get", "value"], lo * 0.6]], 1.1],
          14.6, ["*", ["max", 30, ["-", ["get", "value"], lo * 0.6]], 0.15],
        ],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0,
        "fill-extrusion-opacity-transition": { duration: 700, delay: 0 },
        "fill-extrusion-vertical-gradient": true,
      },
    },
    firstSymbol,
  );
  setHeatVisibility(map, (map as maplibregl.Map & { __heatOn?: boolean }).__heatOn ?? false, false);
  map.addLayer(
    {
      id: "mc-heat-circle",
      type: "circle",
      source: "mc-heat",
      minzoom: 14,
      paint: {
        // Zoom interpolation must be the outermost expression; hover adds 4 px at each stop.
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          ["case", ["boolean", ["feature-state", "hover"], false], 7, 3],
          17,
          ["case", ["boolean", ["feature-state", "hover"], false], 11, 7],
        ],
        "circle-color": ["match", ["get", "tier"], 0, TIER_COLOURS[0], 1, TIER_COLOURS[1], TIER_COLOURS[2]],
        "circle-opacity": 0,
        "circle-opacity-transition": { duration: 500, delay: 0 },
        "circle-stroke-opacity": 0,
        "circle-stroke-opacity-transition": { duration: 500, delay: 0 },
        "circle-stroke-color": ["case", ["boolean", ["feature-state", "hover"], false], "#ffffff", "#0e1310"],
        "circle-stroke-width": ["case", ["boolean", ["feature-state", "hover"], false], 2, 1],
        "circle-pitch-alignment": "map",
      },
    },
    firstSymbol,
  );
}

type Props = {
  target: Target;
  heat: HeatData;
  /** Which tiers (0,1,2) the circle layer shows. */
  tiers: number[];
  /** 0..1 while the opening view loads. */
  onProgress?: (p: number) => void;
  /** Fired once the opening view is fully rendered: safe to reveal the map. */
  onReady?: () => void;
  onHover?: (h: Hover) => void;
  onPickPoint?: (gnaf: string, lng: number, lat: number) => void;
  onApi?: (api: MapApi) => void;
  /** Camera heading in degrees, throttled to one update per frame. */
  onBearing?: (deg: number) => void;
  /** Fires when the orbit starts or stops (including when the user interrupts it). */
  onOrbit?: (on: boolean) => void;
  /** Whether the rent layers are shown. Data in `heat` is loaded (hidden) ahead of time. */
  heatVisible?: boolean;
};

/**
 * Full-bleed 3D basemap. Buildings are extruded from OpenFreeMap's `building`
 * source-layer; the selected building is lit in the accent colour after the
 * fly-in. The map stays hidden (page-level opacity) until onReady fires, so no
 * tile pop-in is ever visible.
 */
export function Map3D({ target, heat, heatVisible = false, tiers, onProgress, onReady, onHover, onPickPoint, onApi, onBearing, onOrbit }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const readyRef = useRef(false);
  const revealedRef = useRef(false);
  const targetRef = useRef<Target>(null);
  const heatRef = useRef<HeatData>(null);
  const heatVisibleRef = useRef(heatVisible);
  const tiersRef = useRef<number[]>(tiers);
  const cbRef = useRef({ onProgress, onReady, onHover, onPickPoint, onApi, onBearing, onOrbit });
  useEffect(() => {
    cbRef.current = { onProgress, onReady, onHover, onPickPoint, onApi, onBearing, onOrbit };
  }, [onProgress, onReady, onHover, onPickPoint, onApi, onBearing, onOrbit]);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  useEffect(() => {
    heatRef.current = heat;
    const map = mapRef.current;
    if (map && readyRef.current) {
      applyHeat(map, heat);
      applyTiers(map, tiersRef.current);
      setHeatVisibility(map, heatVisibleRef.current);
    }
  }, [heat]);
  useEffect(() => {
    heatVisibleRef.current = heatVisible;
    const map = mapRef.current;
    if (map && readyRef.current) setHeatVisibility(map, heatVisible);
  }, [heatVisible]);
  useEffect(() => {
    tiersRef.current = tiers;
    const map = mapRef.current;
    if (map && readyRef.current) applyTiers(map, tiers);
  }, [tiers]);

  useEffect(() => {
    if (!el.current || mapRef.current) return;
    // Turbopack cannot serve maplibre's bundled worker; use the static copy in /public.
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      ...START,
      zoom: START.zoom, // building tiles only exist from zoom 13: preload exactly the opening view
      attributionControl: false,
      fadeDuration: 500,
      maxPitch: 62,
      // Left-drag pans only. Right-drag or ctrl-drag orbits: sideways rotates, up/down tilts (clamped).
      pitchWithRotate: true,
      minPitch: 20,
      touchPitch: false,
    });
    mapRef.current = map;
    (window as unknown as { __map?: maplibregl.Map }).__map = map; // handy in devtools
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "Data: Microburbs Hackathon API" }), "bottom-right");

    let fellBack = false;
    map.on("error", (e) => {
      // Tiles or style failed: swap to a key-less fallback (no buildings).
      if (!fellBack && /style|tiles\.openfreemap/i.test(String(e?.error?.message ?? ""))) {
        fellBack = true;
        map.setStyle(FALLBACK_STYLE);
      }
    });

    /* ---------------------------------------------------- loading progress */
    let progress = 0;
    const bump = (to: number) => {
      if (to <= progress) return;
      progress = to;
      cbRef.current.onProgress?.(progress);
    };
    // Ease toward 90% on every data event; snap to 100% when the view is fully rendered.
    map.on("data", () => bump(Math.min(0.9, progress + (0.9 - progress) * 0.14)));
    map.on("style.load", () => bump(0.3));

    const addBuildings = () => {
      const style = map.getStyle();
      if (!style?.sources) return;
      const srcId = Object.keys(style.sources).find((k) => (style.sources[k] as { type?: string }).type === "vector");
      if (!srcId || map.getLayer("mc-buildings")) return;
      // Hide the style's own building fills and extrusions so only ours (dim + highlight) render.
      // Also hide shop/transit icons: at street level they bury the target building.
      for (const l of style.layers) {
        if (l.type === "symbol" && /poi|transit|aerialway|ferry|airport/i.test(l.id)) {
          map.setLayoutProperty(l.id, "visibility", "none");
          continue;
        }
        const isBuilding = "source-layer" in l && l["source-layer"] === "building";
        if ((l.type === "fill" && isBuilding) || l.type === "fill-extrusion") {
          map.setLayoutProperty(l.id, "visibility", "none");
        }
      }
      const firstSymbol = style.layers.find((l) => l.type === "symbol")?.id;
      // Dark wash over the base map (below all our layers and every label).
      map.addSource("mc-dim", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } },
      });
      map.addLayer({ id: "mc-dim", type: "fill", source: "mc-dim", paint: { "fill-color": "#070a08", "fill-opacity": heatVisibleRef.current ? DIM_HEAT : DIM_IDLE, "fill-opacity-transition": { duration: 800, delay: 0 } } }, firstSymbol);
      // Crisp labels: light text with a solid dark halo; drop house numbers.
      for (const l of style.layers) {
        if (l.type !== "symbol" || map.getLayoutProperty(l.id, "visibility") === "none") continue;
        if (/housenumber/i.test(l.id)) {
          map.setLayoutProperty(l.id, "visibility", "none");
          continue;
        }
        if (!map.getLayoutProperty(l.id, "text-field")) continue;
        const major = /place|water_name|country|state|city|town|suburb/i.test(l.id);
        map.setPaintProperty(l.id, "text-color", major ? "#f4f1e8" : "#c9cfc6");
        map.setPaintProperty(l.id, "text-halo-color", "rgba(7,10,8,0.92)");
        map.setPaintProperty(l.id, "text-halo-width", major ? 2 : 1.4);
        map.setPaintProperty(l.id, "text-halo-blur", 0.3);
      }
      // Building heights only exist in zoom-14 tiles, so the opening view sits at zoom 14.
      map.addLayer(
        {
          id: "mc-buildings",
          type: "fill-extrusion",
          source: srcId,
          "source-layer": "building",
          minzoom: 13,
          paint: {
            "fill-extrusion-color": ["case", ["boolean", ["feature-state", "hit"], false], ACCENT, "#3b4541"],
            "fill-extrusion-height": ["max", ["coalesce", ["get", "render_height"], 10], 6],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            // Starts invisible; faded up once the opening view (or a fly-in) has settled.
            "fill-extrusion-opacity": 0,
            "fill-extrusion-opacity-transition": { duration: 900, delay: 0 },
            "fill-extrusion-vertical-gradient": true,
          },
        },
        firstSymbol,
      );
      for (const l of style.layers) {
        if (l.type === "background") map.setPaintProperty(l.id, "background-color", "#0e1310");
      }
    };

    map.on("style.load", () => {
      readyRef.current = true;
      addBuildings();
      if (heatRef.current) {
        applyHeat(map, heatRef.current);
        applyTiers(map, tiersRef.current);
        setHeatVisibility(map, heatVisibleRef.current, false);
      }
      if (revealedRef.current) setBuildingOpacity(map, BUILDING_OPACITY);
    });

    /* --------------------------------------------- dots: hover + click */
    let hovered: string | null = null;
    const clearHover = () => {
      if (hovered !== null) map.setFeatureState({ source: "mc-heat", id: hovered }, { hover: false });
      hovered = null;
      map.getCanvas().style.cursor = "";
      cbRef.current.onHover?.(null);
    };
    let pending: Hover = null;
    let hoverRaf = 0;
    map.on("mousemove", "mc-heat-circle", (e) => {
      // Rent map off, mid-drag (button held) or mid-animation: no hover work at all.
      if (!heatVisibleRef.current || (e.originalEvent as MouseEvent).buttons || map.isMoving()) {
        if (hovered !== null) clearHover();
        return;
      }
      const f = e.features?.[0];
      if (!f) return;
      const gnaf = String(f.properties?.gnaf ?? f.id);
      if (hovered !== gnaf) {
        if (hovered !== null) map.setFeatureState({ source: "mc-heat", id: hovered }, { hover: false });
        hovered = gnaf;
        map.setFeatureState({ source: "mc-heat", id: gnaf }, { hover: true });
      }
      map.getCanvas().style.cursor = "pointer";
      pending = { x: e.point.x, y: e.point.y, gnaf, value: Number(f.properties?.value), tier: Number(f.properties?.tier) };
      if (!hoverRaf)
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          if (pending && hovered === pending.gnaf) cbRef.current.onHover?.(pending);
        });
    });
    map.on("mouseleave", "mc-heat-circle", clearHover);
    map.on("click", "mc-heat-circle", (e) => {
      if (!heatVisibleRef.current) return;
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const [lng, lat] = f.geometry.coordinates;
      clearHover();
      cbRef.current.onPickPoint?.(String(f.properties?.gnaf ?? f.id), lng, lat);
    });

    /* ----------------------------------------------------------- reveal */
    let raf = 0;
    let interacted = false;
    const spin = () => {
      if (!mapRef.current || targetRef.current || heatVisibleRef.current || interacted) return;
      map.setBearing(map.getBearing() + 0.008);
      raf = requestAnimationFrame(spin);
    };
    // The first touch of the map ends the idle rotation for good and cancels any fly-in.
    const stopSpin = () => {
      interacted = true;
      cancelAnimationFrame(raf);
    };
    // NB: never call map.stop() here. It also cancels the drag gesture that just started,
    // which made drags die after a few pixels. MapLibre already interrupts fly-ins on drag.
    map.on("dragstart", () => {
      stopSpin();
      clearHover();
    });
    // Grabbing the map mid fly-in hands control to the user: stop the camera animation
    // only (allowGestures = true), so the drag that is starting keeps working.
    const grab = () => {
      // maplibre 6 keeps the camera on an internal object; guard so this can never throw.
      const cam = (map as unknown as { _camera?: { isEasing?: () => boolean; stop?: (allowGestures?: boolean) => void } })._camera;
      try {
        if (cam?.isEasing?.()) cam.stop?.(true);
      } catch {
        /* ignore: never block a drag */
      }
    };
    map.on("mousedown", grab);
    map.on("touchstart", grab);
    map.on("wheel", stopSpin);
    map.on("touchstart", stopSpin);

    /* --------------------------------------------- rotation: orbit + heading */
    let orbitRaf = 0;
    let orbiting = false;
    const stopOrbit = () => {
      if (!orbiting) return;
      orbiting = false;
      cancelAnimationFrame(orbitRaf);
      cbRef.current.onOrbit?.(false);
    };
    let orbitLast = 0;
    const orbitStep = (now: number) => {
      if (!orbiting || !mapRef.current) return;
      const dt = orbitLast ? Math.min(now - orbitLast, 50) : 16;
      orbitLast = now;
      map.setBearing(map.getBearing() + dt * 0.006); // 6 degrees a second on any screen refresh rate
      orbitRaf = requestAnimationFrame(orbitStep);
    };
    const startOrbit = () => {
      stopSpin();
      map.stop();
      orbiting = true;
      orbitLast = 0;
      cbRef.current.onOrbit?.(true);
      orbitRaf = requestAnimationFrame(orbitStep);
    };
    // Any hands-on input ends the orbit.
    for (const ev of ["mousedown", "touchstart", "wheel", "dragstart"] as const) map.on(ev, stopOrbit);
    let bearingRaf = 0;
    map.on("rotate", () => {
      if (bearingRaf) return;
      bearingRaf = requestAnimationFrame(() => {
        bearingRaf = 0;
        cbRef.current.onBearing?.(map.getBearing());
      });
    });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "q" || k === "e") {
        stopSpin();
        stopOrbit();
        map.easeTo({ bearing: map.getBearing() + (k === "q" ? -45 : 45), duration: 600 });
      }
    };
    window.addEventListener("keydown", onKey);
    map.on("mousedown", stopSpin);

    const reveal = () => {
      if (revealedRef.current || !mapRef.current) return;
      revealedRef.current = true;
      map.jumpTo(START);
      const finish = () => {
        if (!mapRef.current) return;
        setBuildingOpacity(map, BUILDING_OPACITY);
        bump(1);
        cbRef.current.onReady?.();
        raf = requestAnimationFrame(spin);
      };
      // The exact start camera uses the tiles already cached, so idle follows at once.
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        finish();
      };
      map.once("idle", once);
      setTimeout(once, 700);
    };
    const waitForTiles = () => {
      if (!mapRef.current) return;
      if (map.loaded() && map.areTilesLoaded()) reveal();
      else map.once("idle", waitForTiles);
    };
    map.once("load", () => map.once("idle", waitForTiles));
    const safety = setTimeout(reveal, 10000); // never leave the loading screen up forever

    cbRef.current.onApi?.({
      resetView: () => {
        if (!mapRef.current) return;
        stopSpin();
        stopOrbit();
        map.flyTo({ ...START, speed: 0.8, curve: 1.4, essential: true, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      },
      rotateBy: (deg) => {
        if (!mapRef.current) return;
        stopSpin();
        stopOrbit();
        map.easeTo({ bearing: map.getBearing() + deg, duration: 600 });
      },
      resetNorth: () => {
        if (!mapRef.current) return;
        stopSpin();
        stopOrbit();
        map.easeTo({ bearing: 0, duration: 700 });
      },
      toggleOrbit: () => {
        if (!mapRef.current) return false;
        if (orbiting) stopOrbit();
        else startOrbit();
        return orbiting;
      },
    });

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(orbitRaf);
      window.removeEventListener("keydown", onKey);
      clearTimeout(safety);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------------ fly-in */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !target) return;
    const go = () => {
      markerRef.current?.remove();
      const dot = document.createElement("div");
      dot.className = "mc-marker";
      markerRef.current = new maplibregl.Marker({ element: dot, anchor: "center" }).setLngLat([target.lng, target.lat]).addTo(map);

      // Buildings stay faint during the flight (new tiles arriving at 0.2 opacity do not
      // read as pop-in), then fade up together once the camera has settled.
      setBuildingOpacity(map, 0.2, 250);
      // On phones the details sit in a bottom sheet (62% of the height): frame the
      // building in the strip above it instead of the middle of the screen.
      const phone = typeof window !== "undefined" && window.innerWidth <= 760;
      map.flyTo({
        center: [target.lng, target.lat],
        zoom: phone ? 16.9 : 17.4,
        pitch: phone ? 55 : 60,
        bearing: -24,
        speed: 0.5,
        curve: 1.6,
        essential: true,
        padding: phone ? { top: 150, bottom: Math.round(window.innerHeight * 0.62), left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 },
      });
      map.once("moveend", () => {
        if (targetRef.current !== target) return;
        setBuildingOpacity(map, BUILDING_OPACITY, 900);
        // Tiles at the destination zoom may not be rendered at moveend yet; retry briefly.
        let tries = 0;
        const attempt = () => {
          if (targetRef.current !== target || !mapRef.current) return;
          if (highlight(map, target) === 0 && tries++ < 12) setTimeout(attempt, 350);
        };
        attempt();
      });
    };
    if (readyRef.current) go();
    else map.once("style.load", go);
  }, [target]);

  return <div ref={el} className="map" style={{ position: "absolute", inset: 0 }} aria-label="Map" />;
}

function setBuildingOpacity(map: maplibregl.Map, opacity: number, duration = 900) {
  for (const id of ["mc-buildings", "mc-buildings-far"]) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, "fill-extrusion-opacity-transition", { duration, delay: 0 });
    map.setPaintProperty(id, "fill-extrusion-opacity", opacity);
  }
}

function applyTiers(map: maplibregl.Map, tiers: number[]) {
  if (!map.getLayer("mc-heat-circle")) return;
  const f = tiers.length >= 3 ? null : (["in", ["get", "tier"], ["literal", tiers]] as maplibregl.FilterSpecification);
  map.setFilter("mc-heat-circle", f);
  if (map.getLayer("mc-cols")) map.setFilter("mc-cols", f);
}

/** Feature-state keys lit on the previous pick, cleared before the next one. */
const litKeys: { source: string; sourceLayer?: string; id: string | number }[] = [];

/**
 * Paint the building under the target in the accent colour. Tile features with
 * ids are lit through feature-state on the main building layer; id-less ones
 * fall back to a copy of their geometry extruded on top. Returns the hit count.
 */
function highlight(map: maplibregl.Map, target: NonNullable<Target>): number {
  if (!map.getLayer("mc-buildings")) return 0;
  for (const k of litKeys) map.setFeatureState(k, { hit: false });
  litKeys.length = 0;

  const p = map.project([target.lng, target.lat]);
  const query = (pad: number) =>
    map.queryRenderedFeatures(
      [
        [p.x - pad, p.y - pad],
        [p.x + pad, p.y + pad],
      ],
      { layers: ["mc-buildings"] },
    );
  // One feature only (an id can cover every part of a building relation). Prefer the
  // smallest footprint that actually contains the point; a tall neighbour in front can
  // otherwise win the pixel test in a pitched view.
  const pickOne = (fs: maplibregl.MapGeoJSONFeature[]) => {
    const scored = fs.map((f) => ({ f, box: bbox(f.geometry) })).filter((x) => x.box);
    const inside = scored.filter(({ box }) => box![0] <= target.lng && target.lng <= box![2] && box![1] <= target.lat && target.lat <= box![3]);
    const pool = inside.length ? inside : scored;
    pool.sort((a, b) => (a.box![2] - a.box![0]) * (a.box![3] - a.box![1]) - (b.box![2] - b.box![0]) * (b.box![3] - b.box![1]));
    return pool.length ? [pool[0].f] : [];
  };
  let feats = pickOne(query(10));
  if (!feats.length) feats = pickOne(query(40));

  const copies: GeoJSON.Feature[] = [];
  for (const f of feats) {
    if (f.id !== undefined && f.id !== null) {
      const key = { source: f.source, sourceLayer: f.sourceLayer, id: f.id };
      map.setFeatureState(key, { hit: true });
      litKeys.push(key);
    } else {
      copies.push({ type: "Feature", properties: f.properties, geometry: f.geometry });
    }
  }

  const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: copies };
  const src = map.getSource("mc-hit") as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return feats.length;
  }
  map.addSource("mc-hit", { type: "geojson", data });
  map.addLayer({
    id: "mc-hit",
    type: "fill-extrusion",
    source: "mc-hit",
    paint: {
      "fill-extrusion-color": ACCENT,
      "fill-extrusion-height": ["max", ["coalesce", ["get", "render_height"], 10], 6],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.95,
    },
  });
  return feats.length;
}

/** [minLng, minLat, maxLng, maxLat] of any polygon geometry, or null. */
function bbox(g: GeoJSON.Geometry): [number, number, number, number] | null {
  let box: [number, number, number, number] | null = null;
  const visit = (c: unknown) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const [x, y] = c as number[];
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
    } else for (const k of c) visit(k);
  };
  if (g.type === "Polygon" || g.type === "MultiPolygon") visit(g.coordinates);
  return box;
}
