# Going Rate: what will this flat rent for?

By team matcha cake. Microburbs Hackathon, 7 November 2026. Task 4: a weekly asking-rent estimate for every flat in the City of Sydney, with and without a car space.

**Live demo:** https://matcha-cake-rent.vercel.app

**Scored file:** `rents_matcha-cake.csv`, holding all 65,777 flats with no blanks, two columns of weekly rent.

## What we built

1. **A rent model for every flat.** It produces two estimates per flat, with and without a car space, and the gap between them is the parking premium.
2. **A renter-facing app.** You type the address on your lease and the map flies into your building in 3D. It shows the fair rent with and without parking and what drives it. It also shows the adverts behind the number and the facts about the building and street. If you enter what you are being asked, you get a verdict such as "About $163 a week above the fair range". A rent map colours every flat $, $$ or $$$, and a "Where can I afford" finder searches the whole city by budget.

## Who it helps

Renters facing a renewal or a new lease. The task is written from the landlord's side, while our app answers the renter's question: is this fair, and what can I push back on?

## Held-out accuracy

The model was trained on adverts up to 30 April 2026 and tested on 4,083 adverts from May to July 2026 that it never saw. Every modelling choice was frozen beforehand on an earlier window, with training up to January and tuning on February to April.

| | median error, $ a week | within $100 | R squared |
|---|---|---|---|
| Our model, nested holdout | 49.2 | 76.8% | 0.863 |
| Our model with calendar-month adjustment (submitted) | 43.0 | 79.7% | |
| Microburbs' own rental model (task page) | 86 | 55.2% | |
| Suburb x bedrooms x parking median (Microburbs example report) | 100 | 56.8% | 0.645 |

Our reproduction of the example report's group-median baseline lands on its published numbers, which confirms the split matches.

**What we tuned and on what.** LightGBM depth, the target transform, recency weighting, the blend weight on each flat's own last rent, and the parking-gap mix were all chosen on February to April 2026 only, then frozen and scored on May to July. Without any adjustment the model ran high month by month, by $18 in May, $23 in June and $27 in July, because winter adverts ask less. We added a calendar-month factor estimated only from adverts before the training cutoff. It was added after seeing that drift, and its values were not tuned on the test window. It removes the drift, with residuals near zero in each month, and it carries into the scored August and September window. Full tables are in `report.html` and `pipeline/out/holdout.md`.

## The key steps

- **Each flat's own history, indexed forward.** About three in four flats have been advertised before. Their last advertised rent, moved forward by the suburb's unit-rent trend, is the single strongest signal. Its blend weight decays with the age of that advert.
- **A median-objective model.** The task is scored on median dollar error, so the gradient-boosted model is trained with an L1 loss rather than squared error.
- **Parking from within the building.** The parking premium is anchored on flats in the same building with and without a car space, so it is not confounded with location.
- **Testing extra data rather than assuming it helps.** NSW bond lodgements and the Census block counts did not improve the holdout once each flat's own history was in, so we dropped them. OpenStreetMap distances and development applications were kept.

## Findings

- **Parking value depends on the neighbourhood.** A car space adds about $63 a week in Darlinghurst, Potts Point and Woolloomooloo, where old terraces have no garages. It adds $19 to $23 in Rosebery, Waterloo and Zetland, where new towers have basements. In Barangaroo it adds $166.
- **Height pays modestly.** The model's uplift for floors 21 and above is about $28 a week over ground level.

## Data

- **Supplied by Microburbs for the day.** The files are `rents-input-flats-city-of-sydney.csv`, `rents-past-leases-city-of-sydney.csv` and `blocks-homes-and-people-2021-2026.csv`. They are not included in this repo, per the rules.
- **Block figures.** The 2021 figures are ABS Census 2021 data, © Commonwealth of Australia, CC BY 4.0. The 2026 figures are Microburbs estimates.
- **Rental bond lodgements.** These come from NSW Fair Trading under CC BY 4.0. We used the monthly files from January 2024 to July 2026 and deliberately did not download the August and September 2026 files.
- **Suburb rent series and development applications.** These come from the Microburbs Hackathon API.
- **Transport stops, buildings, roads, parks, water and supermarkets.** These are © OpenStreetMap contributors under ODbL 1.0, fetched via the Overpass API.
- **App map tiles.** These are © OpenMapTiles © OpenStreetMap contributors, served by OpenFreeMap.
- **Cutoff.** All information is dated on or before 31 July 2026. The loader enforces this with a hard filter. Fetch scripts and licences are listed in `pipeline/external/SOURCES.md`.

## Files

| path | what |
|---|---|
| `rents_matcha-cake.csv` | scored output: `gnaf_id,rent_with_car_space,rent_without_car_space` |
| `report.html` | insights, held-out check, method, what worked and what did not |
| `pitch.mp4`, `demo.mp4` | videos |
| `pipeline/` | the model; `pipeline/external/` fetches the open datasets |
| `app/` | the demo app (Next.js, MapLibre) |

## How to run

```bash
# model: put the three supplied CSVs in data/ first
python -m pip install -r pipeline/requirements.txt
python pipeline/external/fetch_all.py   # optional open data, cached in pipeline/cache/
python pipeline/run.py                  # about 7 minutes; writes the CSV, report.html and app/private/predictions.csv

# app
cd app
cp ../.env.example .env.local           # add your team key as MICROBURBS_API_KEY
npm install
npm run dev                             # http://localhost:3000
```

The API key is read from the environment and is never committed. The app calls the Microburbs API only from its server routes.
