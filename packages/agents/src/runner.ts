// Boucle d'un dirigeant : le modèle appelle des outils de lecture, puis soumet une sortie validée.
// Bornes dures : nombre de tours, tokens par appel, coût maximum par run.
import type Anthropic from "@anthropic-ai/sdk";
import type { Sql } from "postgres";
import type { ZodTypeAny } from "zod";
import { TOOLS, type ToolName } from "./tools";

/** Prix par million de tokens, en USD, relevés sur la page tarifs de l'API Claude le 12 octobre 2026. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
// cacheWrite : 1,25 fois le prix d'entrée, hypothèse à confirmer sur la facture réelle

export interface ModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; }

export interface TranscriptEntry {
  ref?: string;
  turn: number;
  type: "tool_call" | "tool_error" | "submission_rejected" | "model_text";
  tool?: string;
  input?: unknown;
  rowCount?: number;
  rows?: unknown[];
  error?: string;
  text?: string;
}

export interface RunSpec<T> {
  sql: Sql;
  model: ModelClient;
  modelId: string;
  system: string;
  userContent: string;
  tools: ToolName[];
  submit: { name: string; description: string; jsonSchema: Record<string, unknown>; schema: ZodTypeAny; check?: (value: T, refs: Set<string>) => string[] };
  maxTurns?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface RunResult<T> { output: T; transcript: TranscriptEntry[]; usage: Usage; costUsd: number; turns: number; }

export class RunError extends Error {
  constructor(message: string, public transcript: TranscriptEntry[], public usage: Usage, public costUsd: number) { super(message); }
}

export function costOf(modelId: string, u: Usage): number {
  const p = PRICES[modelId];
  if (!p) return 0;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

export async function runAgent<T>(spec: RunSpec<T>): Promise<RunResult<T>> {
  const maxTurns = spec.maxTurns ?? 10;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const transcript: TranscriptEntry[] = [];
  const refs = new Set<string>();
  let q = 0;
  let rejections = 0;

  const tools: Anthropic.Tool[] = [
    ...spec.tools.map((name) => ({ name, description: TOOLS[name].description, input_schema: TOOLS[name].jsonSchema as Anthropic.Tool.InputSchema })),
    { name: spec.submit.name, description: spec.submit.description, input_schema: spec.submit.jsonSchema as Anthropic.Tool.InputSchema },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: spec.userContent }];
  const fail = (msg: string) => new RunError(msg, transcript, usage, costOf(spec.modelId, usage));

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await spec.model.create({
      model: spec.modelId,
      max_tokens: spec.maxTokens ?? 4096,
      system: [{ type: "text", text: spec.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    if (spec.maxCostUsd && costOf(spec.modelId, usage) > spec.maxCostUsd) throw fail(`plafond de coût du run dépassé (${spec.maxCostUsd} $)`);

    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) transcript.push({ turn, type: "model_text", text: b.text.slice(0, 2000) });

    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      messages.push({ role: "user", content: `Finish by calling ${spec.submit.name}.` });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      if (call.name === spec.submit.name) {
        const parsed = spec.submit.schema.safeParse(call.input);
        const problems = parsed.success
          ? (spec.submit.check?.(parsed.data as T, refs) ?? [])
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        if (!problems.length) return { output: parsed.data as T, transcript, usage, costUsd: costOf(spec.modelId, usage), turns: turn };
        rejections++;
        transcript.push({ turn, type: "submission_rejected", error: problems.join(" | ") });
        if (rejections >= 3) throw fail(`sortie refusée trois fois : ${problems.join(" | ")}`);
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Rejected. Fix and resubmit: ${problems.join(" | ")}` });
        continue;
      }
      if (!spec.tools.includes(call.name as ToolName)) {
        transcript.push({ turn, type: "tool_error", tool: call.name, error: "outil non autorisé" });
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Tool ${call.name} is not available to you.` });
        continue;
      }
      const tool = TOOLS[call.name as ToolName];
      const input = tool.input.safeParse(call.input);
      if (!input.success) {
        transcript.push({ turn, type: "tool_error", tool: call.name, input: call.input, error: input.error.message });
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid input: ${input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        continue;
      }
      try {
        const rows = await tool.run(spec.sql, input.data as never);
        const ref = `q${++q}`;
        refs.add(ref);
        transcript.push({ turn, type: "tool_call", ref, tool: call.name, input: input.data, rowCount: rows.length, rows: [...rows.slice(0, 50)] });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ ref, row_count: rows.length, rows }) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        transcript.push({ turn, type: "tool_error", tool: call.name, input: input.data, error: msg });
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Query failed: ${msg}` });
      }
    }
    messages.push({ role: "user", content: results });
  }
  throw fail(`aucune sortie soumise après ${maxTurns} tours`);
}
