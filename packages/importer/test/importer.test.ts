import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCsv, detectType, processRows, parseNumber, parsePercent, parseDateTime, normalizeOrderStatus, normalizePlan,
  hashCustomer,
} from "../src/index";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const OPTS = { hashSalt: "test-salt" };

describe("lecture des valeurs", () => {
  it("lit les nombres français et américains", () => {
    expect(parseNumber("1 234,56")).toEqual({ ok: true, value: 1234.56 });
    expect(parseNumber("1,234.56")).toEqual({ ok: true, value: 1234.56 });
    expect(parseNumber("$110.00")).toEqual({ ok: true, value: 110 });
    expect(parseNumber("60,00")).toEqual({ ok: true, value: 60 });
    expect(parseNumber("1,150")).toEqual({ ok: true, value: 1150 });
    expect(parseNumber("(45.5)")).toEqual({ ok: true, value: -45.5 });
    expect(parseNumber("")).toEqual({ ok: true, value: null });
    expect(parseNumber("abc").ok).toBe(false);
  });
  it("ramène les pourcentages à une fraction", () => {
    expect(parsePercent("41,2 %")).toEqual({ ok: true, value: 0.412 });
    expect(parsePercent("0.4")).toEqual({ ok: true, value: 0.4 });
  });
  it("convertit l'heure de Washington en UTC, été comme hiver", () => {
    expect(parseDateTime("2026-10-02 12:15:00", "MDY", "America/New_York")).toEqual({ ok: true, value: "2026-10-02T16:15:00.000Z" });
    expect(parseDateTime("2026-12-02 12:15:00", "MDY", "America/New_York")).toEqual({ ok: true, value: "2026-12-02T17:15:00.000Z" });
    expect(parseDateTime("2026-10-02T12:15:00+02:00", "MDY", "America/New_York")).toEqual({ ok: true, value: "2026-10-02T10:15:00.000Z" });
  });
  it("refuse une date impossible au lieu de la corriger", () => {
    expect(parseDateTime("31/02/2026", "DMY", "America/New_York").ok).toBe(false);
  });
  it("normalise statuts et plans", () => {
    expect(normalizeOrderStatus("wc-completed")).toBe("completed");
    expect(normalizeOrderStatus("Annulée")).toBe("cancelled");
    expect(normalizePlan("Aloufa Standard Plan - 4 meals")).toBe("Standard");
    expect(normalizePlan("Gift card")).toBe("Gift card");
  });
});

describe("export WooCommerce (plugin, anglais)", () => {
  const table = parseCsv(fixture("woo-plugin-en.csv"));
  const [best] = detectType(table.headers);

  it("reconnaît le type et toutes les colonnes", () => {
    expect(best!.type).toBe("woocommerce_orders");
    expect(best!.missingRequired).toEqual([]);
    expect(best!.mapping).toMatchObject({ external_id: 0, ordered_at: 1, status: 2, total: 3, currency: 4, customer_email: 5, plan: 6, coupon: 7, utm_source: 8 });
  });

  const res = processRows("woocommerce_orders", table, best!.mapping, OPTS);

  it("rejette les lignes fautives avec leur raison, sans les corriger", () => {
    expect(res.rejected.map((r) => r.line)).toEqual([6, 7, 8]);
    expect(res.rejected[0]!.reasons[0]).toMatch(/total : nombre illisible/);
    expect(res.rejected[1]!.reasons[0]).toMatch(/client/);
    expect(res.rejected[2]!.reasons[0]).toMatch(/doublon/);
  });

  it("normalise les lignes valides et ne garde aucune donnée personnelle", () => {
    expect(res.rows).toHaveLength(4);
    const first = res.rows[0]!;
    expect(first).toMatchObject({ external_id: "1001", status: "completed", total: 110, plan: "Standard", currency: "USD", ordered_at: "2026-10-02T16:15:00.000Z" });
    expect(first).not.toHaveProperty("customer_email");
    expect(first.customer_hash).toBe(hashCustomer("ana@example.com", "test-salt"));
    expect(res.rows[2]!.customer_hash).toBe(first.customer_hash); // même cliente, casse différente
    expect(res.rows[2]).toMatchObject({ total: 1150, coupon: "IG10", utm_source: "instagram" });
  });

  it("calcule la période en heure de Washington", () => {
    expect(res.periodStart).toBe("2026-10-02");
    expect(res.periodEnd).toBe("2026-10-10"); // 23 h 30 le 10 à Washington, déjà le 11 en UTC
  });
});

describe("export Instagram compte (français, point-virgule, BOM)", () => {
  const table = parseCsv(fixture("ig-account-fr.csv"));
  const [best] = detectType(table.headers);
  const res = processRows(best!.type, table, best!.mapping, OPTS);

  it("reconnaît le type et l'ordre jour/mois", () => {
    expect(best!.type).toBe("instagram_account");
    expect(res.rows[0]).toEqual({ day: "2026-10-13", reach: 1204, views: 3410, profile_visits: 87, follows: 12, unfollows: 3, profile_links_taps: 9 });
  });
  it("garde une valeur vide comme absente, pas comme zéro", () => {
    expect(res.rows[2]!.reach).toBeNull();
    expect(res.rejected).toEqual([]);
  });
});

describe("export Instagram publications (anglais)", () => {
  const table = parseCsv(fixture("ig-media-en.csv"));
  const [best] = detectType(table.headers);
  const res = processRows(best!.type, table, best!.mapping, OPTS);

  it("lit les formats, le pourcentage et l'ordre mois/jour américain", () => {
    expect(best!.type).toBe("instagram_media");
    expect(res.rows[0]).toMatchObject({ ig_media_id: "1789", format: "reel", skip_rate: 0.412, avg_watch_time_s: 7.5, published_at: "2026-10-09T14:00:00.000Z" });
    expect(res.rows[1]).toMatchObject({ format: "carousel" });
  });
  it("rejette un format inconnu", () => {
    expect(res.rejected).toEqual([{ line: 4, reasons: ["format inconnu « Hologram »"] }]);
  });
});

describe("export Meta Ads (français)", () => {
  const table = parseCsv(fixture("meta-ads-fr.csv"));
  const [best] = detectType(table.headers);
  it("reconnaît le type et lit les montants à virgule", () => {
    expect(best!.type).toBe("meta_ads");
    const res = processRows(best!.type, table, best!.mapping, OPTS);
    expect(res.rows).toEqual([
      { campaign: "Lancement Premium", day: "2026-10-12", spend: 60, impressions: 4200, results: 3 },
      { campaign: "Lancement Premium", day: "2026-10-13", spend: 45.5, impressions: 3100, results: 1 },
    ]);
  });
});

describe("mapping incomplet", () => {
  it("bloque l'import et dit quelle colonne manque", () => {
    const table = parseCsv("Order Date,Order Total\n2026-10-02,10\n");
    const res = processRows("woocommerce_orders", table, { ordered_at: 0, total: 1 }, OPTS);
    expect(res.rows).toEqual([]);
    expect(res.mappingErrors).toContain("colonne manquante : external_id");
  });
});
