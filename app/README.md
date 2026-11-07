# What will this flat rent for? (matcha cake)

Renter-side rent fairness for City of Sydney flats. Type an address, the map flies
to the building in 3D, and beside it: fair weekly rent with and without a car space,
what drives it, the comparable adverts behind it, and facts about the building and
street. Enter the rent you are being asked and you get a verdict.

## Run

```
cd app
cp ../.env .env.local        # MICROBURBS_API_KEY and MICROBURBS_API_BASE
npm install
npm run dev                  # http://localhost:3000
```

`npm run build` type-checks and builds for production.

## Env vars (`app/.env.local`, never committed)

| var | purpose |
|---|---|
| `MICROBURBS_API_KEY` | Bearer token, used only server-side in `src/app/api/mb/[...path]/route.ts` |
| `MICROBURBS_API_BASE` | defaults to `https://api-ht.microburbs.com.au` |

## Fixture vs real

`public/predictions.csv` is written by the pipeline (65,777 rows, ~74 MB; see
`../CONTRACT.md`) and is git-ignored. If it is missing, `node scripts/make-fixture.mjs`
writes a small FIXTURE in the same columns: 12 real City of Sydney flats (real GNAF ids
and coordinates from the API, invented rents, drivers and comps) plus ~5,000 synthetic
rows (`FAKE000001...`) jittered around suburb centroids. The app reads only the contract
columns, so either file works.

Addresses verified to geocode straight to a row in the real prediction set (type these to demo):

- Unit 100, 209 Harris Street, Pyrmont
- Unit 9, 10-12 Macleay Street, Elizabeth Bay
- Unit 11, 1 Danks Street, Waterloo
- Unit 1001, 859 Bourke Street, Waterloo
- Unit 1003, 5 O'Dea Avenue, Zetland
- Unit 4, 84-86 Wentworth Park Road, Glebe
- Unit 101, 82-84 Abercrombie Street, Chippendale

Everything else on the panel is live from the Microburbs Hackathon API: geocoding,
property basics, transport, amenities, recent sales, rent history, public housing
overlay, suburb median rent and series, development applications. An address that is
not in `predictions.csv` still shows all of that, with the rent card reading
"estimate pending" and the suburb median unit rent as the fallback number.

## Routes

- `GET /api/mb/v1/...` proxies to the Microburbs API with the key added server-side.
- `GET /api/rent?gnaf=GANSW...` one row of `predictions.csv` (parsed once, cached in memory).
- `GET /api/rent/points?beds=` compact points for the rent heatmap with citywide tier cut-offs.
- `GET /api/rent/find?budget=&beds=&parking=&near_train=` top 30 flats under a budget.

Notes on the build: the app was scaffolded with Tailwind, but the Tailwind v4 Turbopack
loader failed to evaluate CSS on Windows (an ESM `magic-string` require), so it is not
wired in and all styling is plain CSS in `src/app/globals.css`. maplibre's stylesheet and
web worker are served as static copies from `public/` for the same Turbopack reason.

Map tiles: OpenFreeMap "liberty" style (© OpenMapTiles © OpenStreetMap contributors),
falling back to Carto Positron if unreachable.
