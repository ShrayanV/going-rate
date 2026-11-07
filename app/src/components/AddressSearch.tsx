"use client";
import { useEffect, useId, useMemo, useState } from "react";
import type { AddressMatch, SuburbListItem } from "@/lib/types";
import { shortName } from "@/lib/types";
import { useApi } from "@/lib/useApi";

/** One-click starts for the demo: verified to geocode to rows in the prediction set. */
const EXAMPLES: AddressMatch[] = [
  { id: "GANSW718495629", display_name: "UNIT 100/209 Harris Street, Pyrmont", sal: "Pyrmont", property_type: "unit" },
  { id: "GANSW719879697", display_name: "UNIT 1001/859 Bourke Street, Waterloo (NSW)", sal: "Waterloo (NSW)", property_type: "unit" },
  { id: "GANSW719361816", display_name: "UNIT 9/10-12 Macleay Street, Elizabeth Bay", sal: "Elizabeth Bay", property_type: "unit" },
];

type Coords = { lat: number; lng: number };
type FlatHit = { gnaf_id: string; address: string; suburb: string; lat: number; lng: number; bedrooms: number | null; rent: number };
type FlatSearch = { q: string; suburb?: string | null; beds?: number | null; beds_plus?: boolean; budget?: number | null; matched?: number; outside?: string; data: FlatHit[] };

/** Prediction suburb names ("Waterloo (Nsw)") to the API's ("Waterloo (NSW)"), as in page.tsx. */
const apiSuburb = (s: string) => s.replace(/Nsw\)/g, "NSW)");
const bedsLabel = (b: number | null | undefined, plus?: boolean) => (b === null || b === undefined ? "" : b === 0 ? "Studio" : `${b}${plus ? "+" : ""} bed`);
const tidyAddress = (a: string) => a.replace(/\s+\d{4}$/, "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Natural-language flat search (/api/rent/search) runs alongside the address
 * geocode; its hits are listed first. Debounced geocode (nationwide) filtered to City of Sydney suburbs, which we
 * learn once from /v1/suburbs/list.
 */
export function AddressSearch({ onPick, compact }: { onPick: (m: AddressMatch, coords?: Coords | null) => void; compact: boolean }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const suburbs = useApi<SuburbListItem[]>("/v1/suburbs/list");
  const allowed = useMemo(() => new Set((suburbs.data ?? []).map((s) => s.suburb)), [suburbs.data]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 280);
    return () => clearTimeout(t);
  }, [text]);

  const search = useApi<AddressMatch[]>(query.length >= 4 ? `/v1/geocode/address?address=${encodeURIComponent(query)}` : null);
  const matches = useMemo(() => {
    const all = search.data ?? [];
    if (allowed.size === 0) return all;
    const inCity = all.filter((m) => m.sal && allowed.has(m.sal));
    return inCity.length ? inCity : all;
  }, [search.data, allowed]);

  const [flats, setFlats] = useState<FlatSearch | null>(null);
  useEffect(() => {
    if (query.length < 3) return;
    let alive = true;
    fetch(`/api/rent/search?q=${encodeURIComponent(query)}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => alive && setFlats({ ...(j as Omit<FlatSearch, "q">), data: (j as FlatSearch).data ?? [], q: query }))
      .catch(() => alive && setFlats({ q: query, data: [] }));
    return () => {
      alive = false;
    };
  }, [query]);
  const flatRes = flats && flats.q === query && query.length >= 3 ? flats : null;
  const flatHits = flatRes?.data ?? [];
  const flatsLoading = query.length >= 3 && !flatRes;
  const total = flatHits.length + matches.length;
  const flatsFilters = flatRes
    ? [bedsLabel(flatRes.beds, flatRes.beds_plus), flatRes.budget ? `under $${flatRes.budget.toLocaleString("en-AU")}` : "", `${(flatRes.matched ?? 0).toLocaleString("en-AU")} match`]
        .filter(Boolean)
        .join(" · ")
    : "";

  function chooseFlat(h: FlatHit) {
    choose({ id: h.gnaf_id, display_name: h.address, sal: apiSuburb(h.suburb), property_type: "unit" }, { lat: h.lat, lng: h.lng });
  }
  function chooseIndex(i: number) {
    if (i < flatHits.length) chooseFlat(flatHits[i]);
    else if (matches[i - flatHits.length]) choose(matches[i - flatHits.length]);
  }

  function choose(m: AddressMatch, coords?: Coords | null) {
    onPick(m, coords ?? null);
    setText(m.display_name);
    setQuery(m.display_name);
    setOpen(false);
  }

  return (
    <div className={`search ${compact ? "search--compact" : ""}`}>
      {!compact && (
        <>
          <p className="search__brand">Going Rate</p>
          <p className="search__kicker">Just got a renewal notice? See what is fair.</p>
          <h1 className="search__title">What will this flat rent for?</h1>
          <p className="search__lede">Type the address on your lease. We fly to the building and show the fair weekly rent, with and without the car space, and the adverts behind it.</p>
        </>
      )}
      <div className="search__field">
        <input
          id="address-q"
          role="combobox"
          aria-expanded={open && total > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={text}
          placeholder="Address, suburb, or '2 bed in Surry Hills'"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.max(0, Math.min(a + 1, total - 1)));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter" && active < total) chooseIndex(active);
            else if (e.key === "Escape") setOpen(false);
            else return;
            e.preventDefault();
          }}
        />
        {(search.loading || flatsLoading) && <span className="search__spinner" aria-hidden />}
        {!search.loading && !flatsLoading && <kbd className="search__kbd" aria-hidden>/</kbd>}
        {open && query.length >= 3 && !flatsLoading && (flatHits.length > 0 || !!flatRes?.outside || (query.length >= 4 && !search.loading)) && (
          <ul id={listId} role="listbox" className="search__list">
            {flatRes?.outside && (
              <li className="search__empty search__outside">
                Going Rate covers City of Sydney suburbs only, so {flatRes.outside} is not included yet.
              </li>
            )}
            {flatHits.length > 0 && (
              <li className="search__group" role="presentation">
                <span>{flatRes?.suburb ? `Flats in ${flatRes.suburb}` : "Flats in the City of Sydney"}</span>
                <small>{flatsFilters}</small>
              </li>
            )}
            {flatHits.map((h, i) => (
              <li
                key={`flat-${h.gnaf_id}`}
                role="option"
                aria-selected={i === active}
                className={`search__flat ${i === active ? "is-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseFlat(h);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{tidyAddress(h.address)}</span>
                <small>
                  {bedsLabel(h.bedrooms) || "Flat"} · <b>${h.rent.toLocaleString("en-AU")} / wk</b>
                </small>
              </li>
            ))}
            {flatHits.length > 0 && matches.length > 0 && (
              <li className="search__group" role="presentation">
                <span>Addresses</span>
              </li>
            )}
            {matches.map((m, j) => {
              const i = j + flatHits.length;
              return (
              <li
                key={m.id}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{m.display_name}</span>
                <small>{m.sal ? shortName(m.sal) : (m.property_type ?? "")}</small>
              </li>
              );
            })}
            {query.length >= 4 && search.loading && flatHits.length > 0 && <li className="search__empty">Searching addresses…</li>}
            {query.length >= 4 && !search.loading && !matches.length && !flatHits.length && !flatRes?.outside && <li className="search__empty">{search.error ? `Could not search: ${search.error}` : "No City of Sydney address matches that. Try adding the suburb."}</li>}
          </ul>
        )}
      </div>
      {!compact && (
        <div className="examples">
          <span className="examples__label">Or start with one of these</span>
          <div className="examples__row">
            {EXAMPLES.map((m) => (
              <button key={m.id} type="button" className="chip" onClick={() => choose(m)}>
                {m.display_name.replace(/^UNIT /, "Unit ").replace(/,\s*[^,]+$/, "")}, {shortName(m.sal ?? "")}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="search__hint">Press / to search from anywhere.</p>
    </div>
  );
}
