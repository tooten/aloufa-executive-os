// Outils de lecture des dirigeants. Requêtes paramétrées uniquement : le modèle ne rédige jamais de SQL.
// Chaque appel reçoit une référence (q1, q2…) que les constats doivent citer comme preuve.
import type { Sql } from "postgres";
import { z } from "zod";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_ROWS = 400;

interface ToolDef<I extends z.ZodTypeAny> {
  description: string;
  input: I;
  jsonSchema: Record<string, unknown>;
  run: (sql: Sql, input: z.infer<I>) => PromiseLike<readonly unknown[]>;
}

const def = <I extends z.ZodTypeAny>(d: ToolDef<I>) => d;

const range = { from: { type: "string", description: "YYYY-MM-DD inclus" }, to: { type: "string", description: "YYYY-MM-DD inclus" } };

export const TOOLS = {
  query_kpis: def({
    description: "Read precomputed daily KPIs (7-day rolling windows, America/New_York days). Omit keys to list every KPI available in the range.",
    input: z.object({ from: DateStr, to: DateStr, keys: z.array(z.string()).max(30).optional() }),
    jsonSchema: { type: "object", required: ["from", "to"], properties: { ...range, keys: { type: "array", items: { type: "string" } } } },
    run: (sql, i) => sql`
      select day::text, kpi_key, round(value, 4)::float8 as value, source::text
      from kpi_daily where day between ${i.from} and ${i.to}
      ${i.keys?.length ? sql`and kpi_key = any(${i.keys})` : sql``}
      order by kpi_key, day limit ${MAX_ROWS}`,
  }),

  query_orders: def({
    description: "Aggregate paid orders (completed or processing) over a date range. Never returns customer identities.",
    input: z.object({ from: DateStr, to: DateStr, group_by: z.enum(["day", "week", "plan", "status", "coupon", "utm_source"]) }),
    jsonSchema: { type: "object", required: ["from", "to", "group_by"], properties: { ...range, group_by: { type: "string", enum: ["day", "week", "plan", "status", "coupon", "utm_source"] } } },
    run: (sql, i) => {
      const key = {
        day: sql`local_day(ordered_at)::text`,
        week: sql`date_trunc('week', local_day(ordered_at))::date::text`,
        plan: sql`coalesce(plan, 'unknown')`,
        status: sql`status`,
        coupon: sql`coalesce(coupon, '(none)')`,
        utm_source: sql`coalesce(utm_source, '(none)')`,
      }[i.group_by];
      const paidOnly = i.group_by === "status" ? sql`` : sql`and is_paid_status(status)`;
      return sql`
        select ${key} as bucket, count(*)::int as orders, round(sum(total), 2)::float8 as revenue,
               count(distinct customer_hash)::int as customers
        from orders where local_day(ordered_at) between ${i.from} and ${i.to} ${paidOnly}
        group by 1 order by 1 limit ${MAX_ROWS}`;
    },
  }),

  query_content: def({
    description: "Instagram posts published in a date range, with their latest metrics snapshot. Rates are computed on reach.",
    input: z.object({ from: DateStr, to: DateStr }),
    jsonSchema: { type: "object", required: ["from", "to"], properties: range },
    run: (sql, i) => sql`
      select c.ig_media_id, c.format::text, local_day(c.published_at)::text as published_day, c.pillar, c.hook_type, c.language::text,
             m.views, m.reach, m.saved, m.shares, m.comments, m.likes, m.follows,
             m.avg_watch_time_s::float8, m.skip_rate::float8,
             round(m.saved::numeric / nullif(m.reach, 0), 4)::float8 as save_rate,
             round(m.shares::numeric / nullif(m.reach, 0), 4)::float8 as share_rate,
             m.captured_at::text
      from content_items c
      join lateral (select * from content_metrics where content_id = c.id order by captured_at desc limit 1) m on true
      where local_day(c.published_at) between ${i.from} and ${i.to}
      order by c.published_at limit ${MAX_ROWS}`,
  }),

  query_findings: def({
    description: "Recent findings written by executives (used by the CEO).",
    input: z.object({ since: DateStr, executive: z.enum(["ceo", "cmo", "creative_director", "cfo", "coo", "cto"]).optional() }),
    jsonSchema: { type: "object", required: ["since"], properties: { since: { type: "string" }, executive: { type: "string" } } },
    run: (sql, i) => sql`
      select id, executive::text, title, body, severity::text, confidence::float8, created_at::text
      from findings where created_at >= ${i.since}::date
      ${i.executive ? sql`and executive = ${i.executive}` : sql``}
      order by created_at desc limit 60`,
  }),

  query_decisions: def({
    description: "Decisions and their status, reviews and outcome (used by the CEO).",
    input: z.object({ since: DateStr }),
    jsonSchema: { type: "object", required: ["since"], properties: { since: { type: "string" } } },
    run: (sql, i) => sql`
      select id, proposed_by::text, title, status::text, recommended_option, chosen_option, reviews, arbitration, decision_note, created_at::text
      from decisions where created_at >= ${i.since}::date order by created_at desc limit 40`,
  }),

  query_datasets: def({
    description: "What data has been imported, for which period, how fresh, and how many rows were rejected.",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    run: (sql) => sql`
      select type::text, status::text, period_start::text, period_end::text, row_count, rejected_count, loaded_at::text
      from datasets order by created_at desc limit 30`,
  }),
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/** Outils de lecture accordés par défaut à chaque dirigeant, en plus de la liste autorisée en base. */
export const DEFAULT_TOOLS: Record<string, ToolName[]> = {
  ceo: ["query_kpis", "query_findings", "query_decisions", "query_datasets"],
  cfo: ["query_kpis", "query_orders", "query_datasets"],
  cmo: ["query_kpis", "query_content", "query_datasets"],
  creative_director: ["query_kpis", "query_content", "query_datasets"],
  coo: ["query_kpis", "query_datasets"],
  cto: ["query_kpis", "query_datasets"],
};

/** Outils effectivement donnés : ceux du rôle, restreints à ceux que la base autorise (allowed_tools). */
export function toolsFor(exec: string, allowedInDb: string[]): ToolName[] {
  const base = DEFAULT_TOOLS[exec] ?? [];
  return base.filter((t) => allowedInDb.includes(t) || t === "query_datasets");
}
