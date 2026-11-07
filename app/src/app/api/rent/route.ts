import { getPredictions } from "@/lib/predictions";

/** GET /api/rent?gnaf=GANSW...  -> one row from public/predictions.csv (see CONTRACT.md) */
export async function GET(req: Request) {
  const gnaf = new URL(req.url).searchParams.get("gnaf");
  if (!gnaf) return Response.json({ data: null, error: "gnaf query param required" }, { status: 400 });
  try {
    const map = await getPredictions();
    const row = map.get(gnaf) ?? null;
    return Response.json({ data: row, available: row !== null, rows: map.size });
  } catch (e) {
    return Response.json({ data: null, available: false, error: String(e) }, { status: 500 });
  }
}
