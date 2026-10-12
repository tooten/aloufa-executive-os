// Conversions de valeurs brutes de CSV, en français ou en anglais.
// Règle : une valeur qu'on ne sait pas lire renvoie null avec une raison, jamais une supposition.

export type Parsed<T> = { ok: true; value: T | null } | { ok: false; reason: string };

const EMPTY = new Set(["", "-", "--", "n/a", "na", "null", "—"]);
const isEmpty = (raw: string) => EMPTY.has(raw.trim().toLowerCase());

/** Normalise un en-tête pour la comparaison : minuscules, sans accents ni ponctuation superflue. */
export function normHeader(h: string): string {
  return h
    .replace(/^﻿/, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_\s]+/g, " ")
    .replace(/[^a-z0-9#()' %/-]/g, "")
    .trim();
}

/**
 * Lit un nombre écrit à la française ou à l'américaine :
 * "1 234,56", "1,234.56", "$110.00", "110 $", "1.234,5".
 */
export function parseNumber(raw: string): Parsed<number> {
  if (isEmpty(raw)) return { ok: true, value: null };
  let s = raw.replace(/[\s  ]/g, "").replace(/[$€£]|usd|eur/gi, "");
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()+-]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // le dernier séparateur rencontré est le séparateur décimal
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    const commas = (s.match(/,/g) ?? []).length;
    s = commas === 1 && decimals !== 3 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1) {
    const dots = (s.match(/\./g) ?? []).length;
    if (dots > 1) s = s.replace(/\./g, "");
  }
  if (!/^\d*\.?\d+$/.test(s)) return { ok: false, reason: `nombre illisible « ${raw} »` };
  const n = Number(s);
  return { ok: true, value: neg ? -n : n };
}

export function parseInt0(raw: string): Parsed<number> {
  const r = parseNumber(raw);
  if (!r.ok || r.value === null) return r;
  if (!Number.isInteger(r.value)) return { ok: false, reason: `entier attendu, reçu « ${raw} »` };
  return r;
}

/** "12,4 %" ou "12.4%" donne 0.124 ; "0.124" sans signe % est gardé tel quel. */
export function parsePercent(raw: string): Parsed<number> {
  if (isEmpty(raw)) return { ok: true, value: null };
  const hasSign = raw.includes("%");
  const r = parseNumber(raw.replace("%", ""));
  if (!r.ok || r.value === null) return r;
  const frac = hasSign || r.value > 1 ? r.value / 100 : r.value;
  return { ok: true, value: Math.round(frac * 1e6) / 1e6 };
}

export type DateOrder = "DMY" | "MDY";

interface DateParts { y: number; m: number; d: number; hh: number; mi: number; ss: number; }

const MONTHS: Record<string, number> = {
  jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, fev: 2, fevr: 2, fevrier: 2, february: 2,
  mar: 3, mars: 3, march: 3, apr: 4, avr: 4, avril: 4, april: 4, may: 5, mai: 5,
  jun: 6, juin: 6, june: 6, jul: 7, juil: 7, juillet: 7, july: 7, aug: 8, aou: 8, aout: 8, august: 8,
  sep: 9, sept: 9, septembre: 9, september: 9, oct: 10, octobre: 10, october: 10,
  nov: 11, novembre: 11, november: 11, dec: 12, decembre: 12, december: 12,
};

/** Découpe une date sans décider de l'ordre jour/mois quand il est ambigu. */
export function splitDate(raw: string): { a: number; b: number; y: number; time: [number, number, number]; iso: boolean } | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return { a: +m[2]!, b: +m[3]!, y: +m[1]!, time: [+(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)], iso: true };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (m) {
    let hh = +(m[4] ?? 0);
    const ampm = m[7]?.toLowerCase();
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return { a: +m[1]!, b: +m[2]!, y, time: [hh, +(m[5] ?? 0), +(m[6] ?? 0)], iso: false };
  }
  // "Oct 12, 2026" ou "12 octobre 2026"
  const norm = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\./g, "");
  m = norm.match(/^([a-z]+) (\d{1,2}),? (\d{4})/);
  if (m && MONTHS[m[1]!]) return { a: MONTHS[m[1]!]!, b: +m[2]!, y: +m[3]!, time: [0, 0, 0], iso: true };
  m = norm.match(/^(\d{1,2}) ([a-z]+) (\d{4})/);
  if (m && MONTHS[m[2]!]) return { a: MONTHS[m[2]!]!, b: +m[1]!, y: +m[3]!, time: [0, 0, 0], iso: true };
  return null;
}

/** Devine l'ordre jour/mois sur toute une colonne : un premier nombre > 12 tranche pour DMY, un second > 12 pour MDY. */
export function detectDateOrder(values: string[], fallback: DateOrder): DateOrder {
  for (const v of values) {
    const p = splitDate(v);
    if (!p || p.iso) continue;
    if (p.a > 12) return "DMY";
    if (p.b > 12) return "MDY";
  }
  return fallback;
}

function toParts(raw: string, order: DateOrder): DateParts | null {
  const p = splitDate(raw);
  if (!p) return null;
  const [m, d] = p.iso ? [p.a, p.b] : order === "DMY" ? [p.b, p.a] : [p.a, p.b];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(p.y, m - 1, d));
  if (check.getUTCDate() !== d) return null;
  return { y: p.y, m, d, hh: p.time[0], mi: p.time[1], ss: p.time[2] };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function parseDate(raw: string, order: DateOrder): Parsed<string> {
  if (isEmpty(raw)) return { ok: true, value: null };
  const p = toParts(raw, order);
  if (!p) return { ok: false, reason: `date illisible « ${raw} »` };
  return { ok: true, value: `${p.y}-${pad(p.m)}-${pad(p.d)}` };
}

/** Décalage en minutes d'un fuseau IANA à un instant donné (ex. -240 pour New York en été). */
function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * Lit une date-heure. Si la valeur porte un fuseau (Z ou +hh:mm), il est respecté.
 * Sinon elle est lue comme heure locale du fuseau de la boutique (America/New_York par défaut).
 * Renvoie un ISO UTC.
 */
export function parseDateTime(raw: string, order: DateOrder, timeZone: string): Parsed<string> {
  if (isEmpty(raw)) return { ok: true, value: null };
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return { ok: false, reason: `date illisible « ${raw} »` };
    return { ok: true, value: new Date(t).toISOString() };
  }
  const p = toParts(s, order);
  if (!p) return { ok: false, reason: `date illisible « ${raw} »` };
  const naive = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss);
  let utc = naive - tzOffsetMinutes(naive, timeZone) * 60000;
  utc = naive - tzOffsetMinutes(utc, timeZone) * 60000; // second passage pour les changements d'heure
  return { ok: true, value: new Date(utc).toISOString() };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseEmail(raw: string): Parsed<string> {
  if (isEmpty(raw)) return { ok: true, value: null };
  const e = raw.trim().toLowerCase();
  return EMAIL.test(e) ? { ok: true, value: e } : { ok: false, reason: `e-mail invalide « ${raw} »` };
}

/** Statuts WooCommerce en anglais ou en français, avec ou sans préfixe wc-. */
export function normalizeOrderStatus(raw: string): string {
  const s = raw.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^wc-/, "");
  const map: Record<string, string> = {
    completed: "completed", complete: "completed", terminee: "completed", terminée: "completed",
    processing: "processing", "en cours": "processing", "en cours de traitement": "processing",
    "on-hold": "on-hold", "on hold": "on-hold", "en attente": "on-hold",
    pending: "pending", "attente paiement": "pending", "en attente de paiement": "pending",
    cancelled: "cancelled", canceled: "cancelled", annulee: "cancelled",
    refunded: "refunded", remboursee: "refunded",
    failed: "failed", echouee: "failed",
  };
  return map[s] ?? s;
}

/** Ramène un nom de produit au plan Aloufa : Light, Standard ou Premium. */
export function normalizePlan(raw: string): string | null {
  const s = raw.toLowerCase();
  const found = ["premium", "standard", "light"].filter((p) => s.includes(p));
  if (found.length === 1) return found[0]!.charAt(0).toUpperCase() + found[0]!.slice(1);
  return raw.trim() === "" ? null : raw.trim();
}

export function normalizeFormat(raw: string): "reel" | "post" | "carousel" | "story" | null {
  const s = raw.toLowerCase();
  if (/reel|clip/.test(s)) return "reel";
  if (/carou|album/.test(s)) return "carousel";
  if (/stor/.test(s)) return "story";
  if (/post|image|photo|video|publication/.test(s)) return "post";
  return null;
}
