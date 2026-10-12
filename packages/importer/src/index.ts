// Pipeline d'import : CSV brut, type détecté, mapping proposé, lignes validées et normalisées.
// Le chargement en base est fait par l'appelant (route serveur), jamais ici.
import Papa from "papaparse";
import { createHash } from "node:crypto";
import { SPECS, DATASET_TYPES, type DatasetType, type FieldSpec } from "./specs";
import {
  normHeader, parseNumber, parseInt0, parsePercent, parseDate, parseDateTime, parseEmail,
  detectDateOrder, normalizeOrderStatus, normalizePlan, normalizeFormat, type DateOrder, type Parsed,
} from "./normalize";

export * from "./specs";
export * from "./normalize";

export interface Table { headers: string[]; rows: string[][]; }

/** Lit un CSV : séparateur deviné (virgule, point-virgule, tabulation), BOM retiré, lignes vides ignorées. */
export function parseCsv(text: string): Table {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy", delimiter: "" });
  const [headers = [], ...rows] = res.data;
  return { headers: headers.map((h) => h.trim()), rows };
}

export type Mapping = Record<string, number | null>; // clé de champ → index de colonne

function headerScore(header: string, field: FieldSpec): number {
  const h = normHeader(header);
  let best = 0;
  for (const syn of field.synonyms) {
    const s = normHeader(syn);
    if (h === s) best = Math.max(best, 3);
    else if (s.length > 3 && (h.startsWith(s) || h.endsWith(s))) best = Math.max(best, 2);
    else if (s.length > 4 && h.includes(s)) best = Math.max(best, 1);
  }
  return best;
}

/** Propose un mapping : chaque champ prend la colonne au meilleur score, une colonne ne sert qu'une fois. */
export function suggestMapping(type: DatasetType, headers: string[]): Mapping {
  const spec = SPECS[type];
  const candidates: { field: string; col: number; score: number; req: number }[] = [];
  spec.fields.forEach((field) =>
    headers.forEach((h, col) => {
      const score = headerScore(h, field);
      if (score > 0) candidates.push({ field: field.key, col, score, req: field.required ? 1 : 0 });
    }),
  );
  candidates.sort((x, y) => y.score - x.score || y.req - x.req || x.col - y.col);
  const mapping: Mapping = Object.fromEntries(spec.fields.map((fd) => [fd.key, null]));
  const usedCols = new Set<number>();
  for (const c of candidates) {
    if (mapping[c.field] !== null || usedCols.has(c.col)) continue;
    mapping[c.field] = c.col;
    usedCols.add(c.col);
  }
  return mapping;
}

export interface Detection { type: DatasetType; confidence: number; mapping: Mapping; missingRequired: string[]; }

/** Classe les types possibles : part des champs obligatoires trouvés, puis nombre total de champs trouvés. */
export function detectType(headers: string[]): Detection[] {
  return DATASET_TYPES.map((type) => {
    const spec = SPECS[type];
    const mapping = suggestMapping(type, headers);
    const required = spec.fields.filter((fd) => fd.required);
    const missingRequired = required.filter((fd) => mapping[fd.key] === null).map((fd) => fd.key);
    for (const group of spec.oneOf ?? []) {
      if (group.every((k) => mapping[k] === null)) missingRequired.push(group.join("|"));
    }
    const found = spec.fields.filter((fd) => mapping[fd.key] !== null).length;
    const reqShare = (required.length - missingRequired.length) / Math.max(required.length, 1);
    const confidence = Math.max(0, Math.round((0.7 * reqShare + 0.3 * (found / spec.fields.length)) * 100) / 100);
    return { type, confidence, mapping, missingRequired };
  }).sort((a, b) => b.confidence - a.confidence);
}

export interface ProcessOptions {
  /** Ordre jour/mois si la colonne ne permet pas de trancher. */
  dateOrderFallback?: DateOrder;
  /** Fuseau des heures sans fuseau explicite (heure de la boutique). */
  timeZone?: string;
  /** Sel du hachage des e-mails clients, secret serveur. */
  hashSalt: string;
}

export interface Rejected { line: number; reasons: string[]; }

export interface ProcessResult {
  type: DatasetType;
  table: string;
  rows: Record<string, unknown>[];
  rejected: Rejected[];
  periodStart: string | null;
  periodEnd: string | null;
  mappingErrors: string[];
}

export function hashCustomer(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value.trim().toLowerCase()}`).digest("hex");
}

/** Valide le mapping, puis convertit chaque ligne. Une ligne fautive est rejetée avec ses raisons, jamais corrigée. */
export function processRows(type: DatasetType, table: Table, mapping: Mapping, opts: ProcessOptions): ProcessResult {
  const spec = SPECS[type];
  const tz = opts.timeZone ?? "America/New_York";
  const result: ProcessResult = { type, table: spec.table, rows: [], rejected: [], periodStart: null, periodEnd: null, mappingErrors: [] };

  for (const fd of spec.fields) if (fd.required && mapping[fd.key] == null) result.mappingErrors.push(`colonne manquante : ${fd.key}`);
  for (const group of spec.oneOf ?? []) {
    if (group.every((k) => mapping[k] == null)) result.mappingErrors.push(`il faut au moins une colonne parmi : ${group.join(", ")}`);
  }
  if (result.mappingErrors.length) return result;

  const cell = (row: string[], key: string) => {
    const col = mapping[key];
    return col == null ? "" : (row[col] ?? "");
  };
  const dateOrders: Record<string, DateOrder> = {};
  for (const fd of spec.fields) {
    if (fd.kind === "date" || fd.kind === "datetime") {
      dateOrders[fd.key] = detectDateOrder(table.rows.map((r) => cell(r, fd.key)), opts.dateOrderFallback ?? "MDY");
    }
  }

  const seen = new Set<string>();
  table.rows.forEach((row, i) => {
    const line = i + 2; // ligne 1 = en-têtes
    const out: Record<string, unknown> = {};
    const reasons: string[] = [];
    for (const fd of spec.fields) {
      if (mapping[fd.key] == null) continue;
      const raw = cell(row, fd.key);
      let r: Parsed<unknown>;
      switch (fd.kind) {
        case "number": r = parseNumber(raw); break;
        case "int": r = parseInt0(raw); break;
        case "percent": r = parsePercent(raw); break;
        case "date": r = parseDate(raw, dateOrders[fd.key]!); break;
        case "datetime": r = parseDateTime(raw, dateOrders[fd.key]!, tz); break;
        case "email": r = parseEmail(raw); break;
        default: r = { ok: true, value: raw.trim() === "" ? null : raw.trim() };
      }
      if (!r.ok) reasons.push(`${fd.key} : ${r.reason}`);
      else if (r.value === null && fd.required) reasons.push(`${fd.key} : valeur vide`);
      else out[fd.key] = r.value;
    }

    if (!reasons.length) finalize(type, out, opts, reasons);
    if (!reasons.length) {
      const key = uniqueKey(type, out);
      if (seen.has(key)) reasons.push(`doublon dans le fichier (${key})`);
      seen.add(key);
    }
    if (reasons.length) { result.rejected.push({ line, reasons }); return; }

    result.rows.push(out);
    const day = periodDay(type, out, tz);
    if (day) {
      if (!result.periodStart || day < result.periodStart) result.periodStart = day;
      if (!result.periodEnd || day > result.periodEnd) result.periodEnd = day;
    }
  });
  return result;
}

function finalize(type: DatasetType, out: Record<string, unknown>, opts: ProcessOptions, reasons: string[]) {
  if (type === "woocommerce_orders") {
    out.status = normalizeOrderStatus(String(out.status));
    if (out.plan != null) out.plan = normalizePlan(String(out.plan));
    out.currency = out.currency ? String(out.currency).toUpperCase().slice(0, 3) : "USD";
    const who = (out.customer_email ?? out.customer_name) as string | undefined;
    if (!who) reasons.push("client : ni e-mail ni nom");
    else out.customer_hash = hashCustomer(who, opts.hashSalt);
    if (out.utm_source) out.utm_source = String(out.utm_source).toLowerCase();
    delete out.customer_email; // la donnée personnelle ne quitte pas l'import
    delete out.customer_name;
  }
  if (type === "instagram_media" && out.format != null) {
    const fmt = normalizeFormat(String(out.format));
    if (!fmt) reasons.push(`format inconnu « ${String(out.format)} »`);
    else out.format = fmt;
  }
}

function uniqueKey(type: DatasetType, out: Record<string, unknown>): string {
  switch (type) {
    case "woocommerce_orders": return String(out.external_id);
    case "instagram_account": return String(out.day);
    case "instagram_media": return String(out.ig_media_id);
    case "meta_ads": return `${out.day}|${out.campaign}`;
  }
}

function periodDay(type: DatasetType, out: Record<string, unknown>, tz: string): string | null {
  const v = (type === "woocommerce_orders" ? out.ordered_at : type === "instagram_media" ? out.published_at : out.day) as string | undefined;
  if (!v) return null;
  if (v.length === 10) return v;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
}
