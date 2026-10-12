import { NextResponse } from "next/server";
import { parseCsv, detectType, SPECS } from "@aloufa/importer";
import { requireOperator, readCsv, fail } from "@/lib/api";

/** Analyse sans rien écrire : type détecté, mapping proposé, aperçu des premières lignes. */
export async function POST(request: Request) {
  const viewer = await requireOperator();
  if (viewer instanceof NextResponse) return viewer;
  const file = await readCsv(await request.formData());
  if (file instanceof NextResponse) return file;

  const table = parseCsv(file.text);
  if (!table.rows.length) return fail("empty", 400);
  const detections = detectType(table.headers);
  return NextResponse.json({
    fileName: file.name,
    headers: table.headers,
    rowCount: table.rows.length,
    sample: table.rows.slice(0, 5),
    detections,
    specs: Object.fromEntries(Object.entries(SPECS).map(([k, s]) => [k, { fields: s.fields.map(({ key, required }) => ({ key, required })), oneOf: s.oneOf ?? [] }])),
  });
}
