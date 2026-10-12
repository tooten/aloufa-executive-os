import "server-only";
import postgres, { type Sql } from "postgres";
import Anthropic from "@anthropic-ai/sdk";
import { tick, type TickReport } from "@aloufa/agents";
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(20),
  AGENT_MODEL: z.string().default("claude-sonnet-5-5"),
  WEEKLY_BUDGET_USD: z.coerce.number().positive().default(3),
  MAX_COST_PER_RUN_USD: z.coerce.number().positive().default(0.5),
});

let sql: Sql | null = null;

/** Connexion Postgres directe (pooler Supabase en mode transaction : pas de requêtes préparées). */
export function db(): Sql {
  if (!sql) sql = postgres(Env.shape.DATABASE_URL.parse(process.env.DATABASE_URL), { prepare: false, max: 3, idle_timeout: 20 });
  return sql;
}

/** Fait avancer la file des dirigeants jusqu'à la limite de temps donnée. */
export async function runTick(budgetMs: number): Promise<TickReport> {
  const env = Env.parse(process.env);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return tick(db(), { create: (p) => client.messages.create(p) }, {
    modelId: env.AGENT_MODEL,
    deadline: Date.now() + budgetMs,
    maxCostPerRunUsd: env.MAX_COST_PER_RUN_USD,
    weeklyBudgetUsd: env.WEEKLY_BUDGET_USD,
  });
}

/** Les tâches planifiées Vercel envoient « Authorization: Bearer CRON_SECRET ». */
export function isCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}
