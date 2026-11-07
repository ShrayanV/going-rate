"use client";

const FLOORS = 18;

/**
 * Full-screen ink veil shown while the opening map view loads. A slim tower
 * outline lights up floor by floor from the bottom as tiles arrive.
 */
export function LoadingScreen({ progress, done }: { progress: number; done: boolean }) {
  const lit = Math.round(Math.min(1, Math.max(0, progress)) * FLOORS);
  // Tower geometry (viewBox 120 x 320): a stepped silhouette, floors 12 px tall.
  const floorH = 12;
  const baseY = 300;
  return (
    <div className={`loader ${done ? "loader--done" : ""}`} role="status" aria-live="polite" aria-label="Loading the map">
      <svg className="loader__tower" viewBox="0 0 120 320" width="120" height="320" aria-hidden>
        {Array.from({ length: FLOORS }).map((_, i) => {
          // Narrower floors at the top so it reads as a tower, not a bar.
          const w = i >= 15 ? 28 : i >= 10 ? 40 : 52;
          const x = 60 - w / 2;
          const y = baseY - (i + 1) * floorH;
          const on = i < lit;
          return <rect key={i} x={x} y={y + 2} width={w} height={floorH - 3} rx="1.5" className={on ? "is-lit" : ""} style={{ transitionDelay: on ? `${i * 18}ms` : "0ms" }} />;
        })}
        <rect x="59" y={baseY - FLOORS * floorH - 22} width="2" height="22" className="loader__spire" />
        <line x1="10" y1={baseY + 4} x2="110" y2={baseY + 4} className="loader__ground" />
      </svg>
      <h1 className="loader__title">Going Rate</h1>
      <p className="loader__sub">What will this flat rent for? A fair weekly rent for any City of Sydney flat, and the evidence behind it.</p>
      <span className="badge loader__badge">matcha cake</span>
    </div>
  );
}
