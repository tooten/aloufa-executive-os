// Formats de sortie imposés aux dirigeants. Toute sortie est validée ici avant d'être écrite en base.
import { z } from "zod";

export const EvidenceRef = z.object({
  ref: z.string().regex(/^q\d+$/, "une preuve cite une requête de ce run, par exemple q2"),
  note: z.string().max(300).optional(),
});

export const Finding = z.object({
  key: z.string().regex(/^f\d+$/).describe("Identifiant local du constat, f1, f2…"),
  title: z.string().min(3).max(140),
  body: z.string().min(10).max(1500),
  severity: z.enum(["info", "watch", "alert"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRef).min(1, "un constat sans preuve est refusé"),
  kpi_keys: z.array(z.string()).default([]),
});

export const DecisionOption = z.object({
  key: z.string().regex(/^[a-z]$/),
  label: z.string().min(3).max(200),
  impact: z.string().max(400),
  risk: z.string().max(400),
});

export const ProposedDecision = z.object({
  title: z.string().min(3).max(140),
  rationale: z.string().min(10).max(1500),
  options: z.array(DecisionOption).min(2).max(4),
  recommended_option: z.string().regex(/^[a-z]$/),
  finding_keys: z.array(z.string().regex(/^f\d+$/)).min(1, "une décision s'appuie sur au moins un constat"),
}).refine((d) => d.options.some((o) => o.key === d.recommended_option), "l'option recommandée doit être l'une des options");

export const Report = z.object({
  summary: z.string().min(10).max(800),
  findings: z.array(Finding).max(8),
  decisions: z.array(ProposedDecision).max(3),
  missing_data: z.array(z.object({ what: z.string().max(200), why: z.string().max(300) })).max(6).default([]),
}).superRefine((r, ctx) => {
  const keys = new Set(r.findings.map((f) => f.key));
  r.decisions.forEach((d, i) => d.finding_keys.forEach((k) => {
    if (!keys.has(k)) ctx.addIssue({ code: "custom", path: ["decisions", i, "finding_keys"], message: `constat ${k} inexistant` });
  }));
});

export const CRITERIA = ["distinctiveness", "brand_fit", "feasibility", "measurability", "risk"] as const;

export const Review = z.object({
  scores: z.object(Object.fromEntries(CRITERIA.map((c) => [c, z.object({ score: z.number().int().min(1).max(5), why: z.string().min(5).max(300) })])) as Record<(typeof CRITERIA)[number], z.ZodObject<{ score: z.ZodNumber; why: z.ZodString }>>),
  position: z.enum(["support", "support_with_changes", "oppose"]),
  preferred_option: z.string().regex(/^[a-z]$/).optional(),
  comment: z.string().min(10).max(800),
});

export type ReportT = z.infer<typeof Report>;
export type ReviewT = z.infer<typeof Review>;

/** Schémas JSON transmis au modèle comme paramètres des outils de soumission. */
export const REPORT_JSON_SCHEMA = {
  type: "object",
  required: ["summary", "findings", "decisions"],
  properties: {
    summary: { type: "string", description: "3 phrases maximum : ce qui a changé et ce qui compte" },
    findings: {
      type: "array", maxItems: 8,
      items: {
        type: "object", required: ["key", "title", "body", "severity", "confidence", "evidence"],
        properties: {
          key: { type: "string", description: "f1, f2…" },
          title: { type: "string" }, body: { type: "string" },
          severity: { type: "string", enum: ["info", "watch", "alert"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", minItems: 1, items: { type: "object", required: ["ref"], properties: { ref: { type: "string", description: "q1, q2… : la requête de ce run qui prouve le constat" }, note: { type: "string" } } } },
          kpi_keys: { type: "array", items: { type: "string" } },
        },
      },
    },
    decisions: {
      type: "array", maxItems: 3,
      items: {
        type: "object", required: ["title", "rationale", "options", "recommended_option", "finding_keys"],
        properties: {
          title: { type: "string" }, rationale: { type: "string" },
          options: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", required: ["key", "label", "impact", "risk"], properties: { key: { type: "string", description: "a, b, c…" }, label: { type: "string" }, impact: { type: "string" }, risk: { type: "string" } } } },
          recommended_option: { type: "string" },
          finding_keys: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    missing_data: { type: "array", items: { type: "object", required: ["what", "why"], properties: { what: { type: "string" }, why: { type: "string" } } } },
  },
} as const;

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  required: ["scores", "position", "comment"],
  properties: {
    scores: {
      type: "object", required: [...CRITERIA],
      properties: Object.fromEntries(CRITERIA.map((c) => [c, { type: "object", required: ["score", "why"], properties: { score: { type: "integer", minimum: 1, maximum: 5 }, why: { type: "string" } } }])),
    },
    position: { type: "string", enum: ["support", "support_with_changes", "oppose"] },
    preferred_option: { type: "string" },
    comment: { type: "string" },
  },
} as const;
