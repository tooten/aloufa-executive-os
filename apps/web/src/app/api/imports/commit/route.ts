import { NextResponse } from "next/server";
import { z } from "zod";
import { parseCsv, processRows, DATASET_TYPES, type DatasetType } from "@aloufa/importer";
import { requireOperator, readCsv, fail } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";

const Body = z.object({
  type: z.enum(DATASET_TYPES as [DatasetType, ...DatasetType[]]),
  mapping: z.record(z.string(), z.number().int().nonnegative().nullable()),
});

/**
 * Valide, enregistre le fichier, puis charge en une seule transaction (load_dataset).
 * Les lignes rejetées sont renvoyées avec leur raison ; les lignes valides sont chargées.
 */
export async function POST(request: Request) {
  const viewer = await requireOperator();
  if (viewer instanceof NextResponse) return viewer;
  const form = await request.formData();
  const file = await readCsv(form);
  if (file instanceof NextResponse) return file;
  const body = Body.safeParse({ type: form.get("type"), mapping: JSON.parse(String(form.get("mapping") ?? "{}")) });
  if (!body.success) return fail("badRequest", 400, body.error.message);

  const env = serverEnv();
  const table = parseCsv(file.text);
  const result = processRows(body.data.type, table, body.data.mapping, { hashSalt: env.IMPORT_HASH_SALT, timeZone: env.STORE_TIME_ZONE });
  if (result.mappingErrors.length) return fail("mapping", 400, result.mappingErrors.join(" ; "));

  const admin = supabaseAdmin();
  const qualityReport = { total: table.rows.length, valid: result.rows.length, rejected: result.rejected.slice(0, 500) };
  const status = result.rows.length ? "validated" : "rejected";
  const { data: ds, error: dsErr } = await admin.from("datasets").insert({
    type: body.data.type, file_path: "pending", column_mapping: body.data.mapping, quality_report: qualityReport,
    rejected_count: result.rejected.length, status, uploaded_by: viewer.id,
    period_start: result.periodStart, period_end: result.periodEnd,
  }).select("id").single();
  if (dsErr || !ds) return fail("server", 500, dsErr?.message);

  // Le fichier original est conservé dans le stockage privé, même rejeté
  const path = `${body.data.type}/${ds.id}/${file.name.replace(/[^\w.-]+/g, "_")}`;
  const up = await admin.storage.from("imports").upload(path, file.bytes, { contentType: "text/csv", upsert: false });
  await admin.from("datasets").update({ file_path: up.error ? `upload-failed:${up.error.message}` : path }).eq("id", ds.id);

  if (!result.rows.length) return NextResponse.json({ error: "allRejected", rejected: result.rejected }, { status: 422 });

  const { data: eventId, error: loadErr } = await admin.rpc("load_dataset", { p_dataset_id: ds.id, p_rows: result.rows });
  if (loadErr) {
    await admin.from("datasets").update({ status: "rejected", quality_report: { ...qualityReport, loadError: loadErr.message } }).eq("id", ds.id);
    return fail("server", 500, loadErr.message);
  }
  const { data: event } = await admin.from("events").select("routed_to, payload").eq("id", eventId).single();

  return NextResponse.json({
    datasetId: ds.id,
    loaded: result.rows.length,
    rejected: result.rejected,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    routedTo: event?.routed_to ?? [],
  });
}
