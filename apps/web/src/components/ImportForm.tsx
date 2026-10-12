"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";

type FieldInfo = { key: string; required: boolean };
type Detection = { type: string; confidence: number; mapping: Record<string, number | null>; missingRequired: string[] };
type Preview = {
  fileName: string; headers: string[]; rowCount: number; sample: string[][];
  detections: Detection[]; specs: Record<string, { fields: FieldInfo[]; oneOf: string[][] }>;
};
type Rejected = { line: number; reasons: string[] };
type CommitOk = { loaded: number; rejected: Rejected[]; periodStart: string | null; periodEnd: string | null; routedTo: string[] };

/** Import en deux temps : analyse (rien n'est écrit), puis chargement après vérification du mapping. */
export function ImportForm() {
  const t = useTranslations("dataRoom");
  const tErr = useTranslations("errors");
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [type, setType] = useState<string>("");
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<"analyze" | "load" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CommitOk | null>(null);
  const [rejected, setRejected] = useState<Rejected[]>([]);

  const errorText = (code: string, detail?: string) =>
    tErr.has(code as "server") ? (code === "server" ? tErr("server", { message: detail ?? "" }) : tErr(code as "empty")) : detail ?? code;

  async function analyze() {
    if (!file) return;
    setBusy("analyze"); setError(null); setDone(null); setRejected([]);
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/imports/preview", { method: "POST", body: fd });
    const json = await res.json();
    setBusy(null);
    if (!res.ok) { setError(errorText(json.error, json.detail)); return; }
    setPreview(json);
    const best = (json as Preview).detections[0]!;
    setType(best.type); setMapping(best.mapping);
  }

  function changeType(next: string) {
    setType(next);
    const d = preview?.detections.find((x) => x.type === next);
    setMapping(d ? d.mapping : {});
  }

  async function load() {
    if (!file || !type) return;
    setBusy("load"); setError(null);
    const fd = new FormData();
    fd.append("file", file); fd.append("type", type); fd.append("mapping", JSON.stringify(mapping));
    const res = await fetch("/api/imports/commit", { method: "POST", body: fd });
    const json = await res.json();
    setBusy(null);
    setRejected(json.rejected ?? []);
    if (!res.ok) { setError(errorText(json.error, json.detail)); return; }
    setDone(json); setPreview(null); setFile(null);
    router.refresh();
  }

  const spec = preview && type ? preview.specs[type] : null;
  const missing = spec ? spec.fields.filter((f) => f.required && mapping[f.key] == null).map((f) => f.key) : [];
  const best = preview?.detections[0];

  return (
    <section aria-live="polite">
      <form onSubmit={(e) => { e.preventDefault(); void analyze(); }}>
        <label htmlFor="csv">{t("file")}</label>
        <input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
        <button type="submit" disabled={!file || busy !== null}>{busy === "analyze" ? t("analyzing") : t("analyze")}</button>
      </form>

      {error && <p role="alert" className="error">{error}</p>}

      {preview && best && spec && (
        <fieldset>
          <p>{t("detected", { type: t(`types.${best.type}` as "types.meta_ads"), confidence: Math.round(best.confidence * 100) })}</p>
          <label htmlFor="type">{t("typeLabel")}</label>
          <select id="type" value={type} onChange={(e) => changeType(e.target.value)}>
            {preview.detections.map((d) => <option key={d.type} value={d.type}>{t(`types.${d.type}` as "types.meta_ads")}</option>)}
          </select>

          <h3>{t("mappingTitle")}</h3>
          <div className="scroll">
            <table>
              <thead><tr><th>{t("field")}</th><th>{t("column")}</th></tr></thead>
              <tbody>
                {spec.fields.map((f) => (
                  <tr key={f.key}>
                    <td><code>{f.key}</code>{f.required ? ` (${t("required")})` : ""}</td>
                    <td>
                      <select
                        id={`map-${f.key}`}
                        aria-label={f.key}
                        value={mapping[f.key] ?? ""}
                        onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === "" ? null : Number(e.target.value) })}
                      >
                        <option value="">{t("notMapped")}</option>
                        {preview.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missing.length > 0 && <p className="error">{t("missing", { fields: missing.join(", ") })}</p>}

          <h3>{t("sample")}</h3>
          <div className="scroll">
            <table>
              <thead><tr>{preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{preview.sample.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>

          <button type="button" onClick={() => void load()} disabled={missing.length > 0 || busy !== null}>
            {busy === "load" ? t("loading") : t("load", { count: preview.rowCount })}
          </button>
        </fieldset>
      )}

      {done && (
        <p role="status">
          {t("loaded", {
            rows: done.loaded, start: done.periodStart ?? "", end: done.periodEnd ?? "",
            routed: done.routedTo.length ? done.routedTo.join(", ") : t("nobody"),
          })}
        </p>
      )}

      {rejected.length > 0 && (
        <details open>
          <summary>{t("rejectedTitle", { count: rejected.length })}</summary>
          <ul>{rejected.slice(0, 100).map((r) => <li key={r.line}>{t("line", { line: r.line })} : {r.reasons.join(" ; ")}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
