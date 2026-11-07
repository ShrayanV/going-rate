"use client";
import { useMemo, useState } from "react";
import type { AddressMatch, Amenities, Basics, Comp, Da, MedianRent, MedianRentSeries, RentRow, Sale, Transport } from "@/lib/types";
import { addressLine, metres, money, shortName, titleCase } from "@/lib/types";
import { useApi, type ApiState } from "@/lib/useApi";

const prop = (gnaf: string, tail: string) => `/v1/properties/${encodeURIComponent(gnaf)}/${tail}`;
const sub = (name: string, tail: string) => `/v1/suburbs/${encodeURIComponent(name)}/${tail}`;

type Coords = { lat: number; lng: number } | null;
type Choose = (m: AddressMatch, coords: Coords) => void;

/**
 * Typical miss of our model on the held-out adverts (May-Jul 2026), by bedroom count:
 * half of real rents landed within this many dollars of the estimate.
 */
const TYPICAL_MISS: Record<number, number> = { 0: 38, 1: 33, 2: 73, 3: 92 };
const CUTOFF = new Date("2026-07-31");

function likelyRange(row: RentRow, price: number): [number, number] {
  const beds = Math.max(0, row.bedrooms ?? 1);
  let miss = beds >= 3 ? TYPICAL_MISS[3] * Math.sqrt(beds / 3) : TYPICAL_MISS[beds];
  // A recent advert of the flat's own pins the estimate down; no history widens it.
  const recent = row.last_rent && row.last_rent_date && (CUTOFF.getTime() - new Date(row.last_rent_date).getTime()) / 86400000 < 548;
  miss *= recent ? 0.8 : 1.15;
  const half = Math.max(20, Math.round(miss / 5) * 5);
  return [Math.round((price - half) / 5) * 5, Math.round((price + half) / 5) * 5];
}

export function Panel({
  pick,
  transport,
  coords,
  onCollapse,
  onChoose,
}: {
  pick: AddressMatch;
  transport: ApiState<Transport>;
  coords: Coords;
  onCollapse?: () => void;
  onChoose: Choose;
}) {
  const gnaf = pick.id;
  const suburb = pick.sal ?? "";
  const rent = useApi<RentRow>(`/api/rent?gnaf=${encodeURIComponent(gnaf)}`);
  const median = useApi<MedianRent>(suburb ? sub(suburb, "market/median-rent") : null);
  const basics = useApi<Basics>(prop(gnaf, "basics/all"));
  const where: Coords =
    coords ??
    (rent.data?.lat != null && rent.data?.lng != null ? { lat: rent.data.lat, lng: rent.data.lng } : null) ??
    (transport.data ? { lat: transport.data.center_lat, lng: transport.data.center_lng } : null);

  return (
    <aside className="panel" aria-live="polite">
      <header className="panel__head">
        <div className="panel__title">
          <h2>{addressLine(pick.display_name, suburb)}</h2>
          <p>{suburb ? shortName(suburb) : "City of Sydney"}</p>
        </div>
        {onCollapse && (
          <button type="button" className="collapse" onClick={onCollapse} aria-label="Collapse details" title="Collapse (Esc)">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </header>

      <FlatFacts row={rent.data} basics={basics.data} loading={rent.loading && basics.loading} />
      <Photo where={where} />
      <RentCard rent={rent} median={median} />
      <Drivers rent={rent} suburb={suburb} />
      <Evidence suburb={suburb} rent={rent} median={median} onChoose={onChoose} />
      <Around gnaf={gnaf} suburb={suburb} transport={transport} onChoose={onChoose} />
    </aside>
  );
}

/* ------------------------------------------------------- flat facts */

function FlatFacts({ row, basics, loading }: { row: RentRow | null; basics: Basics | null; loading: boolean }) {
  if (loading) return <div className="chips chips--skel" aria-busy><i /><i /><i /><i /></div>;
  const beds = row?.bedrooms ?? basics?.bed_count ?? null;
  const baths = row?.bathrooms ?? basics?.bath_count ?? null;
  const car = row?.car_space ?? (basics?.parking_count != null ? (basics.parking_count > 0 ? 1 : 0) : null);
  const chips: { k: string; v: string; strong?: boolean }[] = [];
  if (beds != null) chips.push({ k: "beds", v: beds === 0 ? "Studio" : `${beds} bed`, strong: true });
  if (baths != null && baths > 0) chips.push({ k: "baths", v: `${baths} bath`, strong: true });
  if (car != null) chips.push({ k: "car", v: car > 0 ? "Car space" : "No car space", strong: true });
  if (row?.floor != null) chips.push({ k: "floor", v: row.floor === 0 ? "Ground floor" : `Floor ${row.floor}` });
  if (row?.flats_in_building) chips.push({ k: "flats", v: `${row.flats_in_building} flats in building` });
  if (!chips.length) return null;
  return (
    <ul className="chips" aria-label="About this flat">
      {chips.map((c) => (
        <li key={c.k} className={c.strong ? "is-strong" : ""}>
          {c.v}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ photo */

function Photo({ where }: { where: Coords }) {
  const photo = useApi<{ url: string; captured_at: string | null; id: string }>(
    where ? `/api/photo?lat=${where.lat.toFixed(6)}&lng=${where.lng.toFixed(6)}` : null,
  );
  if (!where) return null;
  const sv = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${where.lat.toFixed(6)},${where.lng.toFixed(6)}`;
  return (
    <div className="photo">
      {photo.data?.url && (
        <a className="photo__img" href={`https://www.mapillary.com/app/?pKey=${photo.data.id}`} target="_blank" rel="noreferrer" title="Open in Mapillary">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.data.url} alt="Street-level photo near this building" loading="lazy" />
          <span className="photo__credit">Street outside · Mapillary{photo.data.captured_at ? ` · ${photo.data.captured_at.slice(0, 7)}` : ""}</span>
        </a>
      )}
      <a className="btn-link" href={sv} target="_blank" rel="noreferrer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="7" r="3" />
          <path d="M12 10v7M8 21h8M6 14c-2 .8-3 1.8-3 3 0 2.2 4 4 9 4s9-1.8 9-4c0-1.2-1-2.2-3-3" />
        </svg>
        See the building in Street View
      </a>
    </div>
  );
}

/* ------------------------------------------------------------- rent */

function RentCard({ rent, median }: { rent: ApiState<RentRow>; median: ApiState<MedianRent> }) {
  const [asked, setAsked] = useState("");
  const askedN = Number(asked.replace(/[^0-9.]/g, ""));
  const row = rent.data;

  // Lead with the price that matches the flat's actual parking; unknown parking leads with "without".
  const hasCar = row?.car_space === 1;
  const main = row ? (hasCar ? row.rent_with_car_space : row.rent_without_car_space) : 0;
  const other = row ? (hasCar ? row.rent_without_car_space : row.rent_with_car_space) : 0;
  const range = row ? likelyRange(row, main) : null;
  const premium = row?.parking_premium ?? 0;

  const verdict = useMemo(() => {
    if (!row || !range || !askedN) return null;
    const [lo, hi] = range;
    if (askedN > hi) return { tone: "over", text: `${money(askedN - hi)} a week above the likely range.`, sub: `That is ${money((askedN - hi) * 52)} a year more than flats like this tend to ask.` };
    if (askedN < lo) return { tone: "under", text: `${money(lo - askedN)} a week below the likely range.`, sub: "A good deal for this flat." };
    return { tone: "fair", text: "Inside the likely range for this flat.", sub: askedN > main ? `Towards the top: ${money(askedN - main)} above our estimate.` : "At or below our estimate." };
  }, [row, range, askedN, main]);

  if (rent.loading)
    return (
      <Section title="Fair weekly rent">
        <div className="skel skel--rent" aria-busy>
          <i className="skel__tall" />
          <i style={{ width: "60%" }} />
          <i style={{ width: "40%", height: 48 }} />
        </div>
      </Section>
    );

  if (!row) {
    const fallback = median.data?.unit ?? null;
    return (
      <Section title="Fair weekly rent">
        <div className="rent">
          <div className="rent__num">
            <span className="rent__big">{median.loading ? "…" : fallback ? money(fallback) : "–"}</span>
            <span className="rent__label">suburb median for units</span>
          </div>
        </div>
        <p className="muted">This address is not one of the 65,777 flats we priced, so the suburb median is the best guide.</p>
      </Section>
    );
  }

  return (
    <Section title="Fair weekly rent">
      <div className="rent rent--hero">
        <span className="rent__big">{money(main)}</span>
        <span className="rent__per">/ week</span>
      </div>
      {range && (
        <div className="range" aria-label={`Likely range ${money(range[0])} to ${money(range[1])} a week`}>
          <div className="range__bar">
            <i style={{ left: "0%", right: "0%" }} />
            <b style={{ left: "50%" }} />
          </div>
          <div className="range__labels">
            <span>{money(range[0])}</span>
            <span className="range__mid">likely range</span>
            <span>{money(range[1])}</span>
          </div>
          <p className="range__note">Half of similar flats in our held-out test rented within this range.</p>
        </div>
      )}
      <div className="alt">
        <span>
          {hasCar ? "Without the car space" : row.car_space === 0 ? "If it had a car space" : "With a car space"}
        </span>
        <strong>{money(other)}</strong>
      </div>
      {premium >= 10 && hasCar && <p className="premium">Do not need the car space? It is worth about <strong>{money(premium)} a week</strong> here, so it is worth asking to rent without it.</p>}
      {premium >= 10 && !hasCar && <p className="premium">A car space adds about <strong>{money(premium)} a week</strong> in this building.</p>}

      <label className="asked">
        <span>What are you being asked?</span>
        <div className="asked__row">
          <span className="asked__dollar">$</span>
          <input
            inputMode="numeric"
            placeholder={String(Math.round(main / 10) * 10 + 60)}
            value={asked}
            onChange={(e) => setAsked(e.target.value)}
            aria-label="Rent you are being asked, per week"
          />
          <span className="asked__unit">/ week</span>
        </div>
      </label>
      {verdict && (
        <div className={`verdict verdict--${verdict.tone}`}>
          <p>{verdict.text}</p>
          <small>{verdict.sub}</small>
        </div>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- drivers */

/** Plain-English reason for each adjustment, phrased for the sign of the effect. */
function explain(label: string, delta: number, suburb: string, floor: number | null): { title: string; why: string } {
  const up = delta >= 0;
  const where = suburb ? shortName(suburb) : "the suburb";
  if (label === "Location vs suburb median")
    return { title: "Its exact spot", why: up ? `Flats on this block ask more than the ${where} average.` : `Flats on this block ask less than the ${where} average.` };
  if (label === "Building track record")
    return { title: "This building", why: up ? "Past adverts here came in above similar flats nearby." : "Past adverts here came in below similar flats nearby." };
  if (label === "Own rent history")
    return { title: "This flat's own past adverts", why: up ? "It has advertised for more than flats like it." : "It has advertised for less than flats like it." };
  if (label === "Car space") return { title: "Car space", why: "Flats with a car space ask more." };
  if (label.startsWith("Floor"))
    return { title: floor ? `Floor ${floor}` : "Floor", why: up ? "Higher floors ask more." : "Lower floors ask a little less." };
  return { title: label, why: "" };
}

function Drivers({ rent, suburb }: { rent: ApiState<RentRow>; suburb: string }) {
  if (rent.loading) return <Section title="How we got to this number"><Skeleton lines={4} /></Section>;
  const row = rent.data;
  if (!row || row.suburb_median_rent == null) return null;
  const hasCar = row.car_space === 1;
  const estimate = hasCar ? row.rent_with_car_space : row.rent_without_car_space;
  const base = row.suburb_median_rent;
  // The car-space effect only applies to the headline when this flat has one.
  const steps = (row.drivers ?? []).filter((x) => (x.label === "Car space" ? hasCar : true)).filter((x) => Math.abs(x.delta_per_week) >= 5);
  const explained = steps.reduce((a, x) => a + x.delta_per_week, 0);
  const rest = estimate - base - explained;
  if (Math.abs(rest) >= 5) steps.push({ label: "Other details", delta_per_week: rest });
  const max = Math.max(...steps.map((x) => Math.abs(x.delta_per_week)), 1);
  const beds = row.bedrooms === 0 ? "studio" : row.bedrooms ? `${row.bedrooms}-bed` : "flat";

  return (
    <Section title="How we got to this number">
      <ol className="build">
        <li className="build__base">
          <span className="build__title">
            A typical {beds} in {suburb ? shortName(suburb) : "the suburb"}
            <small>median asking rent before looking at this flat</small>
          </span>
          <span className="build__amt">{money(base)}</span>
        </li>
        {steps.map((x, i) => {
          const e = x.label === "Other details" ? { title: "Everything else", why: "Size, bathrooms, age of the building and recent market moves." } : explain(x.label, x.delta_per_week, suburb, row.floor);
          const up = x.delta_per_week >= 0;
          return (
            <li key={i}>
              <span className="build__title">
                {e.title}
                <small>{e.why}</small>
              </span>
              <span className="build__bar" aria-hidden>
                <i className={up ? "pos" : "neg"} style={{ width: `${(Math.abs(x.delta_per_week) / max) * 100}%` }} />
              </span>
              <span className={`build__amt ${up ? "pos" : "neg"}`}>
                {up ? "+" : "−"}
                {money(Math.abs(x.delta_per_week))}
              </span>
            </li>
          );
        })}
        <li className="build__total">
          <span className="build__title">Our estimate for this flat</span>
          <span className="build__amt">{money(estimate)}</span>
        </li>
      </ol>
    </Section>
  );
}

/* --------------------------------------------------------- evidence */

function Evidence({ suburb, rent, median, onChoose }: { suburb: string; rent: ApiState<RentRow>; median: ApiState<MedianRent>; onChoose: Choose }) {
  const series = useApi<MedianRentSeries>(suburb ? sub(suburb, "market/median-rent-series") : null);
  const row = rent.data;
  const comps = (row?.comps ?? []).slice(0, 5);
  const [busy, setBusy] = useState<number | null>(null);

  const trend = useMemo(() => {
    const u = series.data?.unit;
    if (!u || u.length < 13) return null;
    const last = u[u.length - 1].value;
    const yearAgo = u[u.length - 13].value;
    return { change: ((last - yearAgo) / yearAgo) * 100 };
  }, [series.data]);

  const openComp = async (c: Comp, i: number) => {
    setBusy(i);
    try {
      const q = `${c.address}, ${shortName(suburb)}`;
      const j = (await fetch(`/api/mb/v1/geocode/address?address=${encodeURIComponent(q)}`).then((r) => r.json())) as { data?: AddressMatch[] };
      const m = (j.data ?? []).find((x) => !suburb || (x.sal ?? "").toLowerCase().startsWith(shortName(suburb).toLowerCase())) ?? j.data?.[0];
      if (m) onChoose(m, null);
    } finally {
      setBusy(null);
    }
  };

  if (rent.loading) return <Section title="The evidence"><Skeleton lines={4} /></Section>;
  if (!row) return null;

  return (
    <Section title="The evidence">
      {row.last_rent ? (
        <div className="fact fact--lead">
          <span className="fact__label">This flat was last advertised at</span>
          <span className="fact__value">
            <strong>{money(row.last_rent)}</strong> / week {row.last_rent_date && <small>in {fmtMonth(row.last_rent_date)}</small>}
          </span>
        </div>
      ) : null}

      {comps.length > 0 && (
        <>
          <h4>Recent adverts like it</h4>
          <ul className="rows" role="list">
            {comps.map((c, i) => (
              <li key={i}>
                <button type="button" className="row" onClick={() => openComp(c, i)} disabled={busy !== null} title="Open this flat">
                  <span className="row__main">
                    {shortUnit(c.address)}
                    <small>
                      {c.bedrooms != null ? (c.bedrooms === 0 ? "studio" : `${c.bedrooms} bed`) : ""}
                      {c.parking != null ? ` · ${c.parking ? "car space" : "no car space"}` : ""}
                      {c.date ? ` · ${fmtMonth(c.date)}` : ""}
                    </small>
                  </span>
                  <span className="row__right">
                    {money(c.rent)}
                    <small>{c.dist_m != null && c.dist_m < 15 ? "same building" : c.dist_m != null ? metres(c.dist_m) : ""}</small>
                  </span>
                  <span className="row__go" aria-hidden>{busy === i ? "…" : "›"}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="fact">
        <span className="fact__label">{suburb ? shortName(suburb) : "Suburb"} median for units</span>
        <span className="fact__value">
          {median.loading ? "…" : median.data?.unit ? <strong>{money(median.data.unit)}</strong> : "–"} / week
          {trend && Math.abs(trend.change) >= 0.5 && (
            <small className={trend.change >= 0 ? "up" : "down"}>
              {" "}
              {trend.change >= 0 ? "up" : "down"} {Math.abs(trend.change).toFixed(1)}% on a year ago
            </small>
          )}
          {trend && Math.abs(trend.change) < 0.5 && <small> · flat on a year ago</small>}
        </span>
      </div>
    </Section>
  );
}

/* ----------------------------------------------------------- around */

function Around({ gnaf, suburb, transport, onChoose }: { gnaf: string; suburb: string; transport: ApiState<Transport>; onChoose: Choose }) {
  const amen = useApi<Amenities>(prop(gnaf, "amenities/nearby"));
  const sales = useApi<Sale[]>(prop(gnaf, "comparables/recent-sales-nearby"));
  const das = useApi<Da[]>(suburb ? sub(suburb, "development/da-list") : null);
  const t = transport.data;
  const seen = new Set<string>();
  const unitSales = (sales.data ?? [])
    .filter((s) => !s.property_type || /unit|apart|flat/i.test(s.property_type))
    .filter((s) => {
      const k = `${s.price}|${s.date_sold}|${s.bedrooms ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);
  const recentDas = [...(das.data ?? [])].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, 4);
  const stops = t ? (["train", "tram", "bus", "ferry"] as const).map((k) => [k, t.nearest?.[k]] as const).filter(([, s]) => s && s.distance_m <= 1500) : [];

  return (
    <Section title="Around the building">
      {transport.loading ? (
        <Skeleton lines={2} />
      ) : stops.length ? (
        <ul className="stops">
          {stops.map(([k, s]) => (
            <li key={k}>
              <span className={`stops__mode stops__mode--${k}`}>{k}</span>
              <span className="stops__name">{s!.name && !/^(train station|bus stop|tram stop|ferry wharf|light rail stop)$/i.test(s!.name) ? s!.name : ""}</span>
              <span className="stops__dist">
                {metres(s!.distance_m)} <small>· {Math.max(1, Math.round(s!.distance_m / 80))} min walk</small>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {amen.data && (
        <ul className="mini">
          <li>
            <strong>{amen.data.counts.supermarket ?? 0}</strong> supermarkets
          </li>
          <li>
            <strong>{amen.data.counts.green_spaces ?? 0}</strong> parks
          </li>
          <li>
            <strong>{amen.data.counts.restaurant ?? 0}</strong> places to eat
          </li>
          <li className="mini__note">within 1 km</li>
        </ul>
      )}

      {unitSales.length > 0 && (
        <>
          <h4>Recent unit sales nearby</h4>
          <ul className="rows" role="list">
            {unitSales.map((s, i) => {
              const can = !!(s.gnaf_pid && s.latitude != null && s.longitude != null);
              const body = (
                <>
                  <span className="row__main">
                    {shortUnit(s.address)}
                    <small>
                      {s.bedrooms ? `${s.bedrooms} bed · ` : ""}
                      {fmtMonth(s.date_sold)}
                    </small>
                  </span>
                  <span className="row__right">
                    {moneyShort(s.price)}
                    <small>{metres(s.dist_km * 1000)}</small>
                  </span>
                  {can && <span className="row__go" aria-hidden>›</span>}
                </>
              );
              return (
                <li key={i}>
                  {can ? (
                    <button
                      type="button"
                      className="row"
                      title="Open this flat"
                      onClick={() => onChoose({ id: s.gnaf_pid!, display_name: `${titleCase(s.address)}, ${shortName(suburb)}`, sal: suburb, property_type: "unit" }, { lat: s.latitude!, lng: s.longitude! })}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="row row--static">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {recentDas.length > 0 && (
        <details className="das">
          <summary>
            Development in {shortName(suburb)} <span>{recentDas.length} recent applications</span>
          </summary>
          <ul className="list list--das">
            {recentDas.map((d, i) => (
              <li key={i}>
                <span>
                  {d.area_name.replace(/,?\s*NSW.*$/, "")}
                  <small>
                    {fmtMonth(d.date)} · {d.category ?? "DA"}
                  </small>
                  <em>{truncate(d.description.replace(/\s*-\s*City of Sydney.*$/, ""), 120)}</em>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------- bits */

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="sec">
      <h3>
        {title}
        {note && <small>{note}</small>}
      </h3>
      {children}
    </section>
  );
}
function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="skel" aria-busy>
      {Array.from({ length: lines }).map((_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtMonth(d: string) {
  const m = /^(\d{4})-(\d{2})/.exec(d);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : d;
}
const moneyShort = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}m` : `$${Math.round(n / 1000)}k`);
/** "UNIT 306, 123-129 WYNDHAM STREET" -> "Unit 306, 123-129 Wyndham St" */
const shortUnit = (s: string) =>
  titleCase(s)
    .replace(/\bStreet\b/, "St")
    .replace(/\bRoad\b/, "Rd")
    .replace(/\bAvenue\b/, "Ave")
    .replace(/\bParade\b/, "Pde");
