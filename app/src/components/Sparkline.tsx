import type { Point } from "@/lib/types";

/** Tiny inline line chart for a monthly series; last point marked. */
export function Sparkline({ points, width = 220, height = 48 }: { points: Point[]; width?: number; height?: number }) {
  const pts = points.filter((p) => Number.isFinite(p.value)).slice(-60);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * (width - 6) + 3;
  const y = (v: number) => height - 4 - ((v - min) / span) * (height - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="spark" role="img" aria-label="Median unit rent over time">
      <path d={`${d} L${x(pts.length - 1)},${height} L3,${height} Z`} className="spark__fill" />
      <path d={d} className="spark__line" />
      <circle cx={x(pts.length - 1)} cy={y(last.value)} r="3" className="spark__dot" />
    </svg>
  );
}
