# Data contract between pipeline and app

Team: matcha cake. Scored file: `rents_matcha-cake.csv` (repo root).

## pipeline -> app: `app/private/predictions.csv` (also copied to `pipeline/out/predictions.csv`)

One row per gnaf_id (65,777 rows in the real run; a dozen in the fake fixture).

| column | type | notes |
|---|---|---|
| gnaf_id | str | G-NAF address id, e.g. GANSW710352293 |
| address | str | display address |
| suburb | str | |
| lat, lng | float | |
| bedrooms | int | |
| rent_with_car_space | float | weekly AUD, may end in .50 |
| rent_without_car_space | float | weekly AUD |
| parking_premium | float | with - without |
| floor | int or blank | parsed from unit number |
| flats_in_building | int or blank | |
| dist_train_m | float or blank | |
| last_rent | float or blank | this flat's own last advertised rent on/before 2026-07-31 |
| last_rent_date | date or blank | |
| suburb_median_rent | float | same-bedroom median in suburb at cutoff |
| drivers_json | json str | list of {label, delta_per_week} e.g. [{"label":"Floor 12","delta_per_week":+35}] |
| comps_json | json str | up to 5 {address, bedrooms, parking, rent, date, dist_m} used as evidence |

## Scored output: `rents_matcha-cake.csv`
Columns exactly: `gnaf_id,rent_with_car_space,rent_without_car_space`. Every input gnaf_id once, no blanks.

## Hard rules
- Training/tuning uses only adverts dated <= 2026-07-31. Enforced in `pipeline/load.py`.
- Held-out check: train on adverts <= 2026-04-30, test on 2026-05-01..2026-07-31 (same split as the Microburbs example report).
- Metric: median absolute error in $/week (primary), share within $100 (tie-break).
- Never commit anything under data/. Never commit the API key.
