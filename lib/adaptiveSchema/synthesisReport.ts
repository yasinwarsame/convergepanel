/**
 * Adaptive Synthesis Report (R1e)
 *
 * Sections always present: Unified Answer, Where Models Agree, Where Models
 * Disagree, Certainty Assessment, Panel Verdict. Unified Answer and Panel
 * Verdict are deterministic (verdict.ts) — never model-generated, since the
 * gate-fail rule must be code-enforced. The narrative elaboration (why the
 * agree/disagree lists look the way they do, schema-adaptive framing) comes
 * from one synthesis-model call with a schema-specific instruction; on any
 * failure/timeout it degrades to a plain template built straight from the
 * scored rows — never a crash, never a silently-confident guess.
 */

import "server-only";
import { z } from "zod";
import { AdaptiveSynthesisReport, AlignedClaim, QueryType } from "./types";
import { callGemini } from "@/lib/connectors/gemini";
import { GEMINI_API_KEY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { stripJsonFences, withTimeout } from "./util";
import { computeRunCertainty } from "./scoring";
import { computeAdaptiveGate } from "./gate";
import { buildAdaptiveVerdict, buildAdaptiveUnifiedAnswer } from "./verdict";

const SYNTHESIS_CALL_TIMEOUT_MS = 10000;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 1800;

export type { AdaptiveSynthesisReport };

const SCHEMA_NARRATIVE_HINTS: Record<QueryType, string> = {
  contested_empirical:
    "Lead with a short narrative of the disagreement map: describe the SHAPE of the expert dispute (which camps exist, how the panel split) before anything else.",
  legal_regulatory:
    "Lead with the applicable rule. If any claim has a jurisdiction mismatch, call it out explicitly and separately from ordinary legal disagreement — it's a scope mismatch, not a substantive dispute.",
  financial_valuation:
    "Lead with the metrics spread: which numbers cluster tightly across models and which are outliers, and what that implies about consensus on the valuation.",
  factual_lookup: "Keep the entire synthesis to one tight paragraph — this is a factual lookup, not an essay.",
  procedural:
    "Describe the step sequence at a high level and call out any point where models diverge on ordering or flatly contradict a step.",
  medical_health:
    "Organize the narrative by evidence tier, strongest evidence first (RCT/authoritative before observational before anecdotal), and flag any tier-based disagreement explicitly.",
  forecast_speculative:
    "Describe the scenario spread: where probability estimates cluster and where they diverge sharply.",
  creative_generative:
    "This is creative output, not a factual comparison — skip agreement/disagreement framing and briefly note stylistic differences instead.",
  generic: "Standard synthesis narrative, no special framing required.",
};

const NarrativeResponseSchema = z.object({
  whereModelsAgreeNarrative: z.array(z.string()),
  whereModelsDisagreeNarrative: z.array(z.string()),
  certaintyAssessment: z.string(),
  narrativeSections: z.array(z.object({ title: z.string(), body: z.string() })),
});

function buildTemplateReport(
  rows: AlignedClaim[],
  schemaId: QueryType,
  totalModelCount: number
): AdaptiveSynthesisReport {
  const runCertainty = computeRunCertainty(rows, schemaId);
  const gate = computeAdaptiveGate(rows, runCertainty, schemaId);
  const verdict = buildAdaptiveVerdict(rows, gate, totalModelCount);
  const unifiedAnswer = buildAdaptiveUnifiedAnswer(rows, gate);

  const agreeRows = rows.filter((r) => r.status === "consensus" || r.status === "majority");
  const disagreeRows = rows.filter((r) => r.status === "split");

  return {
    unifiedAnswer,
    panelVerdict: verdict.summary,
    gate: gate.status,
    runCertainty,
    whereModelsAgree: agreeRows.map((r) => r.claimText),
    whereModelsDisagree: disagreeRows.map((r) => r.claimText),
    certaintyAssessment: `Run certainty ${Math.round(runCertainty * 100)}% (gate: ${gate.status}). ${agreeRows.length} claim(s) at consensus/majority, ${disagreeRows.length} split.`,
    narrativeSections: [],
    degraded: true,
  };
}

/**
 * Build the full Synthesis Report for one adaptive panel run. Never throws;
 * degrades to buildTemplateReport (still complete, just without prose
 * elaboration) on any model-call failure.
 */
export async function buildAdaptiveSynthesisReport(
  question: string,
  schemaId: QueryType,
  rows: AlignedClaim[],
  totalModelCount: number
): Promise<AdaptiveSynthesisReport> {
  const template = buildTemplateReport(rows, schemaId, totalModelCount);

  if (rows.length === 0) {
    return template; // nothing to narrate
  }

  const rowsSummary = rows
    .map(
      (r) =>
        `- "${r.claimText}" — status: ${r.status}, agreement: ${r.agreementScore.toFixed(2)}, certainty: ${r.certaintyScore.toFixed(2)}${r.disagreementType ? `, flagged: ${r.disagreementType}` : ""}`
    )
    .join("\n");

  const userMessage = `Question: "${question}"

Schema type: ${schemaId}

Scored claims (already aligned and scored across models — do not re-score, just narrate):
${rowsSummary}

Panel verdict: ${template.panelVerdict}
Run certainty: ${(template.runCertainty * 100).toFixed(0)}%
Gate: ${template.gate}`;

  const systemPrompt = `You are writing the narrative portion of a multi-LLM research panel's Synthesis Report. The scoring (agreement, certainty, status) is ALREADY computed — your job is only to narrate it clearly, not to re-judge the claims.

${SCHEMA_NARRATIVE_HINTS[schemaId] ?? SCHEMA_NARRATIVE_HINTS.generic}

Return ONLY JSON in this exact shape:
{
  "whereModelsAgreeNarrative": ["one short sentence per consensus/majority claim, in your own words"],
  "whereModelsDisagreeNarrative": ["one short sentence per split claim explaining what's actually in dispute"],
  "certaintyAssessment": "2-3 sentences on how much to trust this run and why, given the certainty score and gate",
  "narrativeSections": [{ "title": "...", "body": "..." }]
}
Do not invent claims that aren't in the scored list above. No markdown fences, no commentary outside the JSON.`;

  try {
    const result = await withTimeout(
      callGemini(userMessage, null, GEMINI_API_KEY, {
        systemPromptOverride: systemPrompt,
        maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
      }),
      SYNTHESIS_CALL_TIMEOUT_MS,
      "synthesis_timeout"
    );

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Synthesis narrative call failed, using template report", { status: result.status });
      return template;
    }

    const parsedJson = JSON.parse(stripJsonFences(result.rawText));
    const parsed = NarrativeResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Synthesis narrative response failed validation, using template report");
      return template;
    }

    return {
      // Unified Answer + Panel Verdict + gate/certainty stay deterministic —
      // never overwritten by the model's narrative call.
      unifiedAnswer: template.unifiedAnswer,
      panelVerdict: template.panelVerdict,
      gate: template.gate,
      runCertainty: template.runCertainty,
      whereModelsAgree:
        parsed.data.whereModelsAgreeNarrative.length > 0 ? parsed.data.whereModelsAgreeNarrative : template.whereModelsAgree,
      whereModelsDisagree:
        parsed.data.whereModelsDisagreeNarrative.length > 0
          ? parsed.data.whereModelsDisagreeNarrative
          : template.whereModelsDisagree,
      certaintyAssessment: parsed.data.certaintyAssessment || template.certaintyAssessment,
      narrativeSections: parsed.data.narrativeSections,
      degraded: false,
    };
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Synthesis narrative call threw/timed out, using template report", {
      error: err?.message,
    });
    return template;
  }
}
