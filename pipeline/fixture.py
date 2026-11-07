"""Generate a SYNTHETIC data_fixture/ set so the pipeline runs before real data arrives.

python pipeline/fixture.py
Writes data_fixture/{rents-input-flats-city-of-sydney.csv, rents-past-leases-city-of-sydney.csv,
blocks-homes-and-people-2021-2026.csv}
"""
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data_fixture"

SUBURBS = {  # name: (lat, lng, postcode, base 1-bed rent, trend %/yr)
    "Sydney": (-33.8688, 151.2093, 2000, 820, 6), "Pyrmont": (-33.8705, 151.1946, 2009, 780, 5),
    "Ultimo": (-33.8785, 151.1975, 2007, 700, 5), "Haymarket": (-33.8805, 151.2050, 2000, 760, 4),
    "Surry Hills": (-33.8860, 151.2115, 2010, 720, 6), "Darlinghurst": (-33.8780, 151.2190, 2010, 710, 5),
    "Potts Point": (-33.8705, 151.2235, 2011, 690, 4), "Elizabeth Bay": (-33.8715, 151.2275, 2011, 680, 4),
    "Woolloomooloo": (-33.8700, 151.2190, 2011, 700, 4), "Redfern": (-33.8930, 151.2040, 2016, 680, 7),
    "Waterloo": (-33.9000, 151.2080, 2017, 690, 6), "Zetland": (-33.9075, 151.2095, 2017, 720, 5),
    "Glebe": (-33.8795, 151.1860, 2037, 650, 4), "Chippendale": (-33.8870, 151.1990, 2008, 720, 5),
    "Alexandria": (-33.9050, 151.1950, 2015, 680, 6), "Erskineville": (-33.9030, 151.1860, 2043, 660, 5),
    "Newtown": (-33.8975, 151.1790, 2042, 640, 5), "Rosebery": (-33.9180, 151.2050, 2018, 660, 5),
    "Camperdown": (-33.8890, 151.1770, 2050, 650, 4), "Forest Lodge": (-33.8810, 151.1810, 2037, 640, 4),
    "Millers Point": (-33.8590, 151.2035, 2000, 760, 3), "Dawes Point": (-33.8560, 151.2065, 2000, 780, 3),
    "The Rocks": (-33.8595, 151.2085, 2000, 800, 3), "Barangaroo": (-33.8630, 151.2015, 2000, 950, 6),
    "Rushcutters Bay": (-33.8745, 151.2295, 2011, 700, 4), "Darlington": (-33.8905, 151.1950, 2008, 650, 5),
    "Eveleigh": (-33.8950, 151.1930, 2015, 680, 5), "Beaconsfield": (-33.9120, 151.2010, 2015, 650, 5),
    "Centennial Park": (-33.8960, 151.2330, 2021, 700, 3), "Moore Park": (-33.8900, 151.2220, 2021, 720, 3),
    "Paddington": (-33.8845, 151.2270, 2021, 720, 4), "Annandale": (-33.8830, 151.1715, 2038, 630, 4),
    "St Peters": (-33.9115, 151.1795, 2044, 600, 5),
}
STREETS = ["Harris St", "Bourke St", "Crown St", "Pitt St", "George St", "Elizabeth St", "Botany Rd", "Macleay St",
           "Kent St", "Sussex St", "Wattle St", "Regent St", "Abercrombie St", "Bay St", "Gibbons St", "Lachlan St"]
CUTOFF = pd.Timestamp("2026-07-31")


def main(n_flats=3000, n_leases=2000, seed=7):
    rng = np.random.default_rng(seed)
    OUT.mkdir(exist_ok=True)
    names = list(SUBURBS)
    # buildings
    n_bld = max(50, n_flats // 10)
    bld = []
    for b in range(n_bld):
        s = names[rng.integers(len(names))]
        lat, lng, pc, base, trend = SUBURBS[s]
        floors = int(rng.choice([1, 2, 3, 4, 6, 8, 12, 20, 30], p=[.1, .15, .2, .15, .12, .1, .08, .06, .04]))
        bld.append(dict(bid=b, suburb=s, postcode=pc, street=f"{int(rng.integers(1, 400))} {STREETS[rng.integers(len(STREETS))]}",
                        lat=lat + rng.normal(0, 0.004), lng=lng + rng.normal(0, 0.004), floors=floors,
                        quality=rng.normal(0, 40), mesh_block=f"1{rng.integers(1000000, 9999999)}"))
    bld = pd.DataFrame(bld)
    # flats
    rows = []
    gid = 710000000
    for _, b in bld.iterrows():
        per_floor = int(rng.integers(2, 9)) if b.floors > 1 else int(rng.integers(1, 6))
        for f in range(b.floors):
            for k in range(per_floor):
                if b.floors == 1:
                    unit = str(k + 1)
                elif f == 0:
                    unit = rng.choice([f"G{k+1:02d}", f"{k+1}", f"{k+1:02d}"])
                else:
                    unit = f"{f}{k+1:02d}"
                beds = int(rng.choice([0, 1, 2, 3, 4], p=[.08, .38, .40, .12, .02]))
                baths = max(1, beds - rng.integers(0, 2))
                car = rng.choice([0, 1, 2, np.nan], p=[.35, .45, .1, .1])
                gid += 1
                rows.append(dict(gnaf_id=f"GANSW{gid}", address=f"{unit}/{b.street}, {b.suburb} NSW {b.postcode}",
                                 suburb=b.suburb, postcode=b.postcode, mesh_block=b.mesh_block,
                                 latitude=b.lat + rng.normal(0, 0.00005), longitude=b.lng + rng.normal(0, 0.00005),
                                 unit_number=unit, bedrooms=beds, bathrooms=baths, car_spaces=car,
                                 _floor=f, _bid=b.bid, _q=b.quality))
                if len(rows) >= n_flats:
                    break
            if len(rows) >= n_flats:
                break
        if len(rows) >= n_flats:
            break
    flats = pd.DataFrame(rows)
    # ~5% missing from block file
    miss = rng.random(len(flats)) < 0.05
    flats.loc[miss, "mesh_block"] = np.nan

    def true_rent(r, date, parking):
        lat, lng, pc, base, trend = SUBURBS[r.suburb]
        years = (date - pd.Timestamp("2025-01-01")).days / 365.25
        bedf = {0: 0.78, 1: 1.0, 2: 1.38, 3: 1.85, 4: 2.3}[int(r.bedrooms)]
        rent = base * bedf * (1 + trend / 100) ** years
        rent += r._q + 6 * min(r._floor, 25) + (25 if r._floor >= 20 else 0)
        rent += (55 + 15 * (r.bedrooms >= 2)) * parking
        return rent

    # leases
    idx = rng.integers(0, len(flats), n_leases)
    dates = pd.Timestamp("2024-01-01") + pd.to_timedelta(rng.integers(0, 1020, n_leases), "D")  # up to ~Oct 2026
    leases = []
    for i, d in zip(idx, dates):
        r = flats.iloc[i]
        parking = r.car_spaces if not np.isnan(r.car_spaces) else rng.choice([0, 1])
        parking = int(parking > 0)
        rent = true_rent(r, d, parking) + rng.normal(0, 60)
        rent = max(300, round(rent / 5) * 5)
        leases.append(dict(gnaf_id=r.gnaf_id, address=r.address, suburb=r.suburb, date_listed=d.date().isoformat(),
                           weekly_rent=rent, bedrooms=r.bedrooms, bathrooms=r.bathrooms,
                           car_spaces=parking if rng.random() > 0.08 else np.nan,
                           latitude=r.latitude, longitude=r.longitude, property_type="Apartment"))
    leases = pd.DataFrame(leases).sort_values("date_listed")
    flats = flats.drop(columns=["_floor", "_bid", "_q"])
    # blocks
    mbs = bld.mesh_block.unique()
    blocks = pd.DataFrame(dict(mesh_block=mbs, dwellings_2021=rng.integers(20, 400, len(mbs)),
                               people_2021=rng.integers(30, 800, len(mbs))))
    blocks["dwellings_2026"] = (blocks.dwellings_2021 * rng.uniform(1.0, 1.3, len(mbs))).astype(int)
    blocks["people_2026"] = (blocks.people_2021 * rng.uniform(1.0, 1.3, len(mbs))).astype(int)
    blocks["median_age_2021"] = rng.integers(25, 45, len(mbs))
    flats.to_csv(OUT / "rents-input-flats-city-of-sydney.csv", index=False)
    leases.to_csv(OUT / "rents-past-leases-city-of-sydney.csv", index=False)
    blocks.to_csv(OUT / "blocks-homes-and-people-2021-2026.csv", index=False)
    print(f"fixture: {len(flats)} flats, {len(leases)} leases ({(pd.to_datetime(leases.date_listed) > CUTOFF).sum()} after cutoff), {len(blocks)} blocks -> {OUT}")


if __name__ == "__main__":
    main()
