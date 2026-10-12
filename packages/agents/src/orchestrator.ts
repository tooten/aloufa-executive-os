// Orchestrateur : appelé par la tâche planifiée et après chaque import.
// 1. route les événements en runs  2. déclenche le CEO quand le lundi est fini  3. exécute les jobs en file.
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { runAgent, RunError, type ModelClient, type TranscriptEntry, type Usage } from "./runner";
import { Report, Review, REPORT_JSON_SCHEMA, REVIEW_JSON_SCHEMA, type ReportT, type ReviewT, CRITERIA } from "./schemas";
import { systemPrompt, reviewerPrompt, type ExecKey } from "./roles";
import { toolsFor } from "./tools";

export interface TickOptions {
  modelId: string;
  /** Heure limite (ms epoch) : aucun nouveau job n'est pris après. */
  deadline: number;
  maxCostPerRunUsd: number;
  weeklyBudgetUsd: number;
  now?: () => Date;
}

export interface TickReport { routed: number; ceoBriefs: number; done: string[]; failed: { run: string; error: string }[]; skippedBudget: boolean; }

interface RunRow {
  id: string; executive: ExecKey; event_id: string | null; kind: "analysis" | "review" | "arbitration" | "answer" | "brief";
  locale: string; input: Record<string, unknown>; decision_id: string | null; parent_run_id: string | null;
}

const Arbitration = z.object({
  preferred_option: z.string().regex(/^[a-z]$/),
  rationale: z.string().min(10).max(1200),
  confidence: z.number().min(0).max(1),
});
const ARBITRATION_JSON_SCHEMA = {
  type: "object", required: ["preferred_option", "rationale", "confidence"],
  properties: { preferred_option: { type: "string" }, rationale: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 } },
};

const today = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export async function tick(sql: Sql, model: ModelClient, opts: TickOptions): Promise<TickReport> {
  const now = opts.now ?? (() => new Date());
  const report: TickReport = { routed: 0, ceoBriefs: 0, done: [], failed: [], skippedBudget: false };

  const routedRows = await sql<{ n: number }[]>`select route_pending_events() as n`;
  report.routed = routedRows[0]!.n;
  report.ceoBriefs = await enqueueCeoBriefs(sql);

  while (Date.now() < opts.deadline) {
    const spentRows = await sql<{ spent: string }[]>`select spend_last_7_days()::text as spent`;
    if (Number(spentRows[0]!.spent) >= opts.weeklyBudgetUsd) { report.skippedBudget = true; break; }
    const [job] = await sql<{ id: number | null; run_id: string | null; attempts: number; max_attempts: number }[]>`select (j).* from (select claim_job(900) as j) x`;
    if (!job?.id || !job.run_id) break;
    const [run] = await sql<RunRow[]>`
      update agent_runs set status = 'running', started_at = now(), attempt = ${job.attempts}
      where id = ${job.run_id} returning id, executive, event_id, kind, locale, input, decision_id, parent_run_id`;
    if (!run) continue;
    try {
      await execute(sql, model, run, opts, now());
      await sql`update jobs set status = 'done' where id = ${job.id}`;
      report.done.push(run.id);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const t = e instanceof RunError ? e : null;
      const retry = job.attempts < job.max_attempts;
      await sql`
        update agent_runs set status = ${retry ? "queued" : "failed"}, error = ${err}, finished_at = now(),
          transcript = ${sql.json((t?.transcript ?? []) as never)}, cost_usd = coalesce(cost_usd, 0) + ${t?.costUsd ?? 0}
        where id = ${run.id}`;
      await sql`update jobs set status = ${retry ? "queued" : "failed"}, lease_until = null where id = ${job.id}`;
      if (!retry) report.failed.push({ run: run.id, error: err });
    }
  }
  return report;
}

/** Le CEO écrit le brief quand tous les runs du lundi (analyses et revues) sont terminés. */
async function enqueueCeoBriefs(sql: Sql): Promise<number> {
  const events = await sql<{ id: string; payload: Record<string, unknown> }[]>`
    select e.id, e.payload from events e
    where e.type = 'weekly_tick' and e.status = 'routed'
      and exists (select 1 from executives where key = 'ceo' and status = 'active')
      and not exists (select 1 from agent_runs r where r.event_id = e.id and r.kind = 'brief')
      and not exists (
        select 1 from agent_runs r
        where (r.event_id = e.id or r.parent_run_id in (select id from agent_runs where event_id = e.id))
          and r.status in ('queued', 'running'))`;
  for (const e of events) {
    await sql`select enqueue_run('ceo', 'brief', ${e.id}, ${sql.json(e.payload as never)}, output_locale())`;
    await sql`update events set status = 'done' where id = ${e.id}`;
  }
  return events.length;
}

async function execute(sql: Sql, model: ModelClient, run: RunRow, opts: TickOptions, now: Date) {
  const [exec] = await sql<{ allowed_tools: string[]; reviewer: ExecKey | null }[]>`select allowed_tools, reviewer from executives where key = ${run.executive}`;
  if (!exec) throw new Error(`dirigeant ${run.executive} introuvable`);
  const tools = toolsFor(run.executive, exec.allowed_tools);
  const base = { sql, model, modelId: opts.modelId, tools, maxCostUsd: opts.maxCostPerRunUsd };

  if (run.kind === "review") {
    const ctx = await decisionContext(sql, run.decision_id!);
    const res = await runAgent<ReviewT>({
      ...base, system: reviewerPrompt(run.executive, run.locale), userContent: ctx,
      submit: { name: "submit_review", description: "Submit your review of the proposed decision.", jsonSchema: REVIEW_JSON_SCHEMA, schema: Review },
    });
    await sql.begin(async (tx) => {
      await tx`select set_config('app.actor', ${`worker:${run.executive}`}, true)`;
      await finishRun(tx, run.id, res.output, res.transcript, res.usage, res.costUsd, opts.modelId);
      await recordReview(tx, run, res.output);
    });
    return;
  }

  if (run.kind === "arbitration") {
    const ctx = await decisionContext(sql, run.decision_id!, true);
    const res = await runAgent<z.infer<typeof Arbitration>>({
      ...base,
      system: systemPrompt("ceo", run.locale, today(now)) + "\nYou are arbitrating a disagreement between two executives. Pick the option you would recommend to the founder.",
      userContent: ctx,
      submit: { name: "submit_arbitration", description: "Submit your arbitration.", jsonSchema: ARBITRATION_JSON_SCHEMA, schema: Arbitration },
    });
    await sql.begin(async (tx) => {
      await tx`select set_config('app.actor', 'worker:ceo', true)`;
      await finishRun(tx, run.id, res.output, res.transcript, res.usage, res.costUsd, opts.modelId);
      await tx`update decisions set arbitration = ${tx.json({ ...res.output, run_id: run.id } as never)}, status = 'proposed' where id = ${run.decision_id}`;
    });
    return;
  }

  const res = await runAgent<ReportT>({
    ...base,
    system: systemPrompt(run.executive, run.locale, today(now)),
    userContent: await taskFor(sql, run),
    submit: {
      name: "submit_report",
      description: "Submit your findings, proposed decisions and missing data. Call once, at the end.",
      jsonSchema: REPORT_JSON_SCHEMA as never, schema: Report,
      check: (r, refs) => r.findings.flatMap((f) => f.evidence.filter((e) => !refs.has(e.ref)).map((e) => `${f.key} cite ${e.ref}, qui n'est pas une requête de ce run`)),
    },
  });
  await sql.begin(async (tx) => {
    await tx`select set_config('app.actor', ${`worker:${run.executive}`}, true)`;
    await finishRun(tx, run.id, res.output, res.transcript, res.usage, res.costUsd, opts.modelId);
    await recordReport(tx, run, exec.reviewer, res.output, res.transcript);
  });
}

async function finishRun(tx: TransactionSql, runId: string, output: unknown, transcript: TranscriptEntry[], u: Usage, cost: number, modelId: string) {
  await tx`
    update agent_runs set status = 'succeeded', finished_at = now(), output = ${tx.json(output as never)},
      transcript = ${tx.json(transcript as never)}, model = ${modelId}, error = null,
      input_tokens = ${u.input + u.cacheRead + u.cacheWrite}, output_tokens = ${u.output},
      cost_usd = coalesce(cost_usd, 0) + ${cost}
    where id = ${runId}`;
}

/** Écrit constats et décisions. Chaque preuve est reliée à la requête du run qui l'a produite. */
async function recordReport(tx: TransactionSql, run: RunRow, reviewer: ExecKey | null, r: ReportT, transcript: TranscriptEntry[]) {
  const byRef = new Map(transcript.filter((t) => t.ref).map((t) => [t.ref!, t]));
  const idByKey = new Map<string, string>();
  for (const f of r.findings) {
    const evidence = f.evidence.map((e) => {
      const t = byRef.get(e.ref)!;
      return { ref: e.ref, note: e.note ?? null, run_id: run.id, tool: t.tool, input: t.input, row_count: t.rowCount };
    });
    const [row] = await tx<{ id: string }[]>`
      insert into findings (run_id, executive, title, body, severity, confidence, evidence, kpi_keys)
      values (${run.id}, ${run.executive}, ${f.title}, ${f.body}, ${f.severity}, ${f.confidence}, ${tx.json(evidence as never)}, ${f.kpi_keys})
      returning id`;
    idByKey.set(f.key, row!.id);
  }
  const revising = typeof run.input.revise_decision_id === "string" ? (run.input.revise_decision_id as string) : null;
  for (const d of r.decisions) {
    const status = reviewer && reviewer !== run.executive ? "in_review" : "proposed";
    const [row] = await tx<{ id: string }[]>`
      insert into decisions (proposed_by, run_id, title, rationale, options, recommended_option, finding_ids, status, supersedes)
      values (${run.executive}, ${run.id}, ${d.title}, ${d.rationale}, ${tx.json(d.options as never)}, ${d.recommended_option},
              ${d.finding_keys.map((k) => idByKey.get(k)!)}, ${status}, ${revising})
      returning id`;
    if (status === "in_review") {
      await tx`select enqueue_run(${reviewer}, 'review', ${run.event_id}, '{}'::jsonb, ${run.locale}::ui_locale, ${run.id}, ${row!.id})`;
    }
  }
  if (revising) {
    // la version révisée remplace l'originale ; sans nouvelle version, l'originale part au fondateur avec la revue négative
    await tx`update decisions set status = ${r.decisions.length ? "superseded" : "proposed"} where id = ${revising} and status = 'in_review'`;
  }
}

/** Revue : passe au fondateur si elle est positive ; sinon une révision, puis arbitrage du CEO. */
async function recordReview(tx: TransactionSql, run: RunRow, review: ReviewT) {
  const entry = { reviewer: run.executive, run_id: run.id, ...review };
  const [d] = await tx<{ id: string; proposed_by: ExecKey; supersedes: string | null; run_id: string }[]>`
    update decisions set reviews = reviews || ${tx.json([entry] as never)} where id = ${run.decision_id}
    returning id, proposed_by, supersedes, run_id`;
  if (!d) return;
  const passes = review.position !== "oppose" && CRITERIA.every((c) => review.scores[c].score >= 3);
  if (passes) {
    await tx`update decisions set status = 'proposed' where id = ${d.id}`;
  } else if (!d.supersedes) {
    const feedback = { revise_decision_id: d.id, reviewer: run.executive, review };
    await tx`select enqueue_run(${d.proposed_by}, 'analysis', ${run.event_id}, ${tx.json(feedback as never)}, ${run.locale}::ui_locale, ${run.id}, null)`;
  } else {
    const ceoActive = (await tx`select 1 from executives where key = 'ceo' and status = 'active'`).length > 0;
    if (ceoActive && d.proposed_by !== "ceo" && run.executive !== "ceo") {
      await tx`select enqueue_run('ceo', 'arbitration', ${run.event_id}, '{}'::jsonb, ${run.locale}::ui_locale, ${run.id}, ${d.id})`;
    } else {
      await tx`update decisions set status = 'proposed' where id = ${d.id}`;
    }
  }
}

/** Ce que voit un relecteur : la proposition et le résumé des preuves, pas le raisonnement de l'auteur. */
async function decisionContext(sql: Sql, decisionId: string, withReviews = false): Promise<string> {
  const [d] = await sql<{ title: string; options: unknown; recommended_option: string; finding_ids: string[]; reviews: unknown; rationale: string; proposed_by: string }[]>`
    select title, options, recommended_option, finding_ids, reviews, rationale, proposed_by::text from decisions where id = ${decisionId}`;
  if (!d) throw new Error(`décision ${decisionId} introuvable`);
  const findings = await sql`select title, body, severity::text, confidence::float8, evidence from findings where id = any(${d.finding_ids})`;
  const payload: Record<string, unknown> = {
    decision: { title: d.title, options: d.options, recommended_option: d.recommended_option, proposed_by: d.proposed_by },
    supporting_findings: findings.map((f) => ({ title: f.title, body: f.body, severity: f.severity, confidence: f.confidence, evidence_queries: (f.evidence as { tool: string; input: unknown; row_count: number }[]).map(({ tool, input, row_count }) => ({ tool, input, row_count })) })),
  };
  if (withReviews) { payload.author_rationale = d.rationale; payload.reviews = d.reviews; }
  return `Review this proposal. You may run your own queries to check its claims.\n\n${JSON.stringify(payload, null, 2)}`;
}

/** Consigne de travail selon l'événement qui a déclenché le run. */
async function taskFor(sql: Sql, run: RunRow): Promise<string> {
  const i = run.input;
  if (typeof i.revise_decision_id === "string") {
    const ctx = await decisionContext(sql, i.revise_decision_id, true);
    return `Your decision was reviewed negatively. Revise it: either submit an improved decision addressing the review, or submit no decision if the critique is right. Re-check the data with your tools.\n\n${ctx}`;
  }
  if (run.kind === "brief") {
    return `Write the weekly brief for the week ${i.from} to ${i.to}. Read this week's findings and decisions (query_findings and query_decisions since ${i.from}), check headline KPIs, then submit: summary = the brief in 3 sentences, findings = the 3 priorities of the week with evidence, decisions = only if an executive-level choice is missing.`;
  }
  if (run.kind === "answer") return `The founder asks: ${String(i.question ?? "")}\nAnswer within your remit using your tools. If the question is outside your remit, say which executive should answer, in summary, with no findings.`;
  if (i.dataset_type) return `New data was imported: ${i.dataset_type}, ${i.rows} rows, from ${i.period_start} to ${i.period_end}. Analyze what changed in your remit. Compare with the previous period when data allows.`;
  return `Weekly review for ${i.from} to ${i.to}. Analyze your KPIs for this week against the previous week. Report what matters, propose decisions only where the data supports one.`;
}
