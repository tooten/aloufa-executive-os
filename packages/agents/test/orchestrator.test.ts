// Test de bout en bout sur un Postgres local, avec un faux modèle qui joue un scénario écrit à l'avance.
// Aucun appel à l'API Claude. Lancer avec PGTEST_HOST pointant vers le dossier du socket Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { tick, type ModelClient } from "../src/index";

const HOST = process.env.PGTEST_HOST ?? "/var/tmp/pgtest";
const PORT = Number(process.env.PGTEST_PORT ?? 5499);
const DB = `agents_test_${process.pid}`;
const MIG = join(__dirname, "../../db");

let admin: Sql;
let sql: Sql;

beforeAll(async () => {
  admin = postgres({ host: HOST, port: PORT, user: "postgres", database: "postgres", onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${DB}`);
  await admin.unsafe(`create database ${DB}`);
  sql = postgres({ host: HOST, port: PORT, user: "postgres", database: DB, onnotice: () => {} });
  for (const f of ["tests/supabase_stubs.sql", "migrations/0001_core_schema.sql", "migrations/0002_kpis_and_executives.sql", "migrations/0003_load_dataset.sql", "migrations/0004_run_lifecycle.sql"]) {
    await sql.unsafe(readFileSync(join(MIG, f), "utf8"));
  }
});

afterAll(async () => {
  await sql?.end();
  await admin?.unsafe(`drop database if exists ${DB}`);
  await admin?.end();
});

// ---------------------------------------------------------------- faux modèle
let callId = 0;
const msg = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"] = "tool_use"): Anthropic.Message => ({
  id: `msg_${++callId}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } as Anthropic.Usage,
} as Anthropic.Message);
const use = (name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: "tool_use", id: `tu_${++callId}`, name, input } as Anthropic.ToolUseBlock);

const decision = (title: string) => ({
  title, rationale: "Le plan Standard porte la majorité du revenu sur la période.",
  options: [
    { key: "a", label: "Mettre le plan Standard en avant sur le site", impact: "Plus de commandes Standard", risk: "Cannibalise le Premium" },
    { key: "b", label: "Ne rien changer", impact: "Aucun", risk: "Aucun" },
  ],
  recommended_option: "a", finding_keys: ["f1"],
});
const report = (ref: string, decisions: unknown[]) => ({
  summary: "Le plan Standard domine le revenu de la période.",
  findings: [{ key: "f1", title: "Standard en tête", body: "Le plan Standard représente la plus grande part du revenu payé.", severity: "info", confidence: 0.8, evidence: [{ ref }], kpi_keys: [] }],
  decisions,
});
const review = (score: number, position: string) => ({
  scores: Object.fromEntries(["distinctiveness", "brand_fit", "feasibility", "measurability", "risk"].map((c) => [c, { score, why: "Justification de test." }])),
  position, comment: "Revue de test, assez longue.",
});

const textOf = (p: Anthropic.MessageCreateParamsNonStreaming) => JSON.stringify(p.messages);
const turns = (p: Anthropic.MessageCreateParamsNonStreaming) => p.messages.filter((m) => m.role === "assistant").length;
const systemOf = (p: Anthropic.MessageCreateParamsNonStreaming) => (p.system as { text: string }[])[0]!.text;

const calls: string[] = [];
const model: ModelClient = {
  async create(p) {
    const sys = systemOf(p);
    const txt = textOf(p);
    const t = turns(p);
    if (sys.includes("reviewing a decision")) {
      calls.push("review");
      return txt.includes("(révisé)") ? msg([use("submit_review", review(4, "support"))]) : msg([use("submit_review", review(2, "oppose"))]);
    }
    if (sys.includes("You are the CFO")) {
      if (txt.includes("reviewed negatively")) {
        calls.push(`cfo-revision-${t}`);
        if (t === 0) return msg([use("query_orders", { from: "2026-10-01", to: "2026-10-14", group_by: "plan" })]);
        return msg([use("submit_report", report("q1", [decision("Mettre en avant le plan Standard (révisé)")]))]);
      }
      if (txt.includes("Weekly review")) {
        calls.push(`cfo-weekly-${t}`);
        if (t === 0) return msg([use("query_kpis", { from: "2026-10-01", to: "2026-10-14" })]);
        return msg([use("submit_report", report("q1", []))]);
      }
      calls.push(`cfo-${t}`);
      if (t === 0) return msg([{ type: "text", text: "Je regarde les commandes." } as Anthropic.TextBlock, use("query_orders", { from: "2026-10-01", to: "2026-10-14", group_by: "plan" })]);
      if (t === 1) return msg([use("submit_report", report("q9", [decision("Mettre en avant le plan Standard")]))]); // preuve inventée
      return msg([use("submit_report", report("q1", [decision("Mettre en avant le plan Standard")]))]);
    }
    if (sys.includes("You are the CEO")) {
      calls.push(`ceo-${t}`);
      if (t === 0) return msg([use("query_findings", { since: "2026-10-01" })]);
      return msg([use("submit_report", { ...report("q1", []), summary: "Brief de la semaine : priorité au plan Standard." })]);
    }
    throw new Error(`appel inattendu : ${sys.slice(0, 80)}`);
  },
};

const OPTS = { modelId: "claude-sonnet-5-5", deadline: Date.now() + 120_000, maxCostPerRunUsd: 1, weeklyBudgetUsd: 50 };

describe("cycle complet d'un import", () => {
  it("analyse, refuse la preuve inventée, révise après une revue négative, puis passe au fondateur", async () => {
    await sql`insert into datasets (id, type, file_path, status) values ('f0000000-0000-0000-0000-000000000001', 'woocommerce_orders', 't.csv', 'validated')`;
    await sql`select load_dataset('f0000000-0000-0000-0000-000000000001', ${sql.json([
      { external_id: "1", ordered_at: "2026-10-05T16:00:00Z", status: "completed", plan: "Standard", total: 110, customer_hash: "a" },
      { external_id: "2", ordered_at: "2026-10-06T16:00:00Z", status: "completed", plan: "Light", total: 80, customer_hash: "b" },
    ] as never)})`;

    const r = await tick(sql, model, { ...OPTS, deadline: Date.now() + 120_000 });
    expect(r.routed).toBe(1);
    expect(r.failed).toEqual([]);
    expect(r.done).toHaveLength(4); // analyse CFO, revue CEO, révision CFO, revue CEO

    const runs = await sql`select executive::text, kind::text, status::text, transcript, cost_usd::float8 as cost from agent_runs order by created_at`;
    expect(runs.map((x) => `${x.executive}:${x.kind}:${x.status}`)).toEqual([
      "cfo:analysis:succeeded", "ceo:review:succeeded", "cfo:analysis:succeeded", "ceo:review:succeeded",
    ]);
    const first = runs[0]!;
    expect((first.transcript as { type: string }[]).some((e) => e.type === "submission_rejected")).toBe(true);
    expect(first.cost).toBeGreaterThan(0);

    const decisions = await sql`select title, status::text, supersedes, jsonb_array_length(reviews) as nreviews from decisions order by created_at`;
    expect(decisions.map((d) => [d.title, d.status, d.nreviews])).toEqual([
      ["Mettre en avant le plan Standard", "superseded", 1],
      ["Mettre en avant le plan Standard (révisé)", "proposed", 1],
    ]);
    expect(decisions[1]!.supersedes).not.toBeNull();

    const [f] = await sql`select evidence from findings order by created_at limit 1`;
    expect((f!.evidence as { tool: string; ref: string }[])[0]).toMatchObject({ ref: "q1", tool: "query_orders" });
  });

  it("le fondateur seul peut approuver la décision proposée", async () => {
    const [d] = await sql`select id from decisions where status = 'proposed'`;
    await expect(sql`update decisions set status = 'approved' where id = ${d!.id}`).rejects.toThrow(/seul le fondateur/);
  });
});

describe("boucle du lundi", () => {
  it("le CFO analyse la semaine, puis le CEO écrit le brief au tick suivant", async () => {
    const [{ id }] = await sql<{ id: string }[]>`select create_weekly_event() as id`;
    expect(id).toBeTruthy();
    const [{ again }] = await sql<{ again: string | null }[]>`select create_weekly_event() as again`;
    expect(again).toBeNull(); // pas de doublon si la tâche planifiée se déclenche deux fois

    const t1 = await tick(sql, model, { ...OPTS, deadline: Date.now() + 120_000 });
    expect(t1.done).toHaveLength(1);
    const t2 = await tick(sql, model, { ...OPTS, deadline: Date.now() + 120_000 });
    expect(t2.ceoBriefs).toBe(1);
    expect(t2.done).toHaveLength(1);
    const [brief] = await sql`select output->>'summary' as summary from agent_runs where kind = 'brief'`;
    expect(brief!.summary).toMatch(/Brief de la semaine/);
    const [ev] = await sql`select status::text from events where type = 'weekly_tick'`;
    expect(ev!.status).toBe("done");
  });
});

describe("garde-fous", () => {
  it("n'exécute rien quand le plafond hebdomadaire est atteint", async () => {
    await sql`select enqueue_run('cfo', 'answer', null, ${sql.json({ question: "Combien de commandes ?" } as never)})`;
    const r = await tick(sql, model, { ...OPTS, weeklyBudgetUsd: 0, deadline: Date.now() + 60_000 });
    expect(r.skippedBudget).toBe(true);
    expect(r.done).toEqual([]);
    await sql`delete from jobs where status = 'queued'`;
  });

  it("une panne du modèle est retentée une fois, puis le run est marqué en échec", async () => {
    await sql`select enqueue_run('cfo', 'answer', null, ${sql.json({ question: "Panne ?" } as never)})`;
    const broken: ModelClient = { create: async () => { throw new Error("API indisponible"); } };
    const r = await tick(sql, broken, { ...OPTS, deadline: Date.now() + 60_000 });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toMatch(/API indisponible/);
    const [run] = await sql`select status::text, attempt from agent_runs where id = ${r.failed[0]!.run}`;
    expect(run).toMatchObject({ status: "failed", attempt: 2 });
  });
});
