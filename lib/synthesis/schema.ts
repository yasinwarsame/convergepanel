import { z } from "zod";

/**
 * Synthesis Report V2 Schema
 * 
 * Structured JSON format for research-worthy synthesis reports.
 * This is the canonical format - no HTML, no legacy strings.
 */
export const SynthesisReportV2Schema = z.object({
  version: z.literal(2),
  title: z.string(),
  executiveSummary: z.string(),
  keyFindings: z.array(z.object({
    claim: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    consensus: z.object({
      count: z.number().int().nonnegative(),
      models: z.array(z.string()).min(1),
    }),
    evidenceNotes: z.array(z.string()).optional(),
  })),
  disagreements: z.array(z.object({
    topic: z.string(),
    whyContested: z.string(),
    positions: z.array(z.object({
      model: z.string(),
      position: z.string(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
    })).min(2),
  })).default([]),
  singleModelInsights: z.array(z.object({
    model: z.string(),
    insight: z.string(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  })).default([]),
  biasAndBlindSpots: z.array(z.object({
    area: z.string(),
    note: z.string(),
    modelsMentioning: z.array(z.string()).optional(),
  })).default([]),
  suggestedFollowUps: z.array(z.string()).default([]),
  citations: z.array(z.object({
    id: z.string(),
    source: z.string(),
    url: z.string().optional(),
  })).default([]),
});

export type SynthesisReportV2 = z.infer<typeof SynthesisReportV2Schema>;

