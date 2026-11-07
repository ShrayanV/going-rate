# pitch.mp4 — 45 seconds, ~110 words, text on screen for every number

Rule: the result and the clever step are readable with the sound off in the first 3 seconds.

| t | on screen | voice |
|---|---|---|
| 0–3s | Big text: "Median error $__ / week. Microburbs' own model: $86." Team badge "matcha cake". | "We beat the house model at predicting Sydney rents." |
| 3–10s | Phone-style renewal notice: "+$80 a week". | "Sarah just got a renewal notice. Eighty dollars more. No way to tell if that's fair." |
| 10–20s | App: type address, map flies into her building in 3D. | "So we built this. Type your address. That's your building." |
| 20–30s | Rent card: with / without car space, premium highlighted, verdict line "about $__ above the fair range". | "Fair rent with and without a car space, and what to push back on." |
| 30–38s | One chart: parking premium by suburb (or floor uplift). "The clever step: we measure parking from pairs of flats in the SAME building, and floor from the unit number." | "The trick: compare flats inside the same building, and read the floor off the unit number." |
| 38–45s | Held-out table: train to 30 Apr, test May–Jul, N adverts, median error, % within $100 vs benchmarks. | "Checked on three thousand adverts the model never saw. Every flat in the city. matcha cake." |

Record at 1920x1080, 30fps. Keep under 95 MB (ffmpeg -crf 23 is plenty).

# demo.mp4 — up to 3 minutes
1. (0:00) The renewal notice, the question.
2. (0:15) App walk-through on the real demo address: fly-in, rent card, verdict, drivers, evidence, building, street.
3. (1:30) A second address with no rent history: shows the fallback still gives a number.
4. (2:00) report.html: insights charts, then the held-out table with split dates and counts.
5. (2:40) The CSV: 65,777 rows, no blanks. Close on the benchmark comparison.
