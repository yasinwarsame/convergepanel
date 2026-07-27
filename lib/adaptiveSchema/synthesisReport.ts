/**
 * Adaptive Synthesis Report (R1e, extended by Synthesis Report Polish Part A)
 *
 * Sections always present: Unified Answer, Executive Summary, Disagreements,
 * Bias & Blind Spots, Where Models Agree, Certainty Assessment, Panel
 * Verdict, Verdict Card. Unified Answer, Panel Verdict, the Verdict Card,
 * and each Disagreement's `positions` (real AlignedClaimCell excerpts) are
 * deterministic — never model-generated, since the gate-fail rule must be
 * code-enforced and quoted positions must never be invented. The narrative
 * elaboration (executive summary prose, why each disagreement exists,
 * schema-adaptive framing) comes from one synthesis-model call; Bias & Blind
 * Spots comes from a SEPARATE dedicated call (biasDetection.ts) since it
 * needs each model's full raw response, not just its aligned claims. Every
 * model call degrades to a deterministic template on failure/timeout — never
 * a crash, never a blank section, never a silently-confident guess.
 */

import "server-only";
import { z } from "zod";
import { ModelId, ModelResult } from "@/lib/types";
import {
  AdaptiveDisagreement,
  AdaptiveStakes,
  AdaptiveSynthesisReport,
  AlignedClaim,
  AlignedClaimCell,
  QueryType,
} from "./types";
import { callGemini } from "@/lib/connectors/gemini";
import { GEMINI_API_KEY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { stripJsonFences, withTimeout } from "./util";
import { computeRunCertainty } from "./scoring";
import { computeAdaptiveGate } from "./gate";
import { buildAdaptiveVerdict, buildAdaptiveUnifiedAnswer } from "./verdict";
import { buildAdaptiveVerdictCard } from "./verdictCard";
import { detectAdaptiveBiases } from "./biasDetection";
import { findUnrecognizedModelNames, stripUnrecognizedModelNames } from "./modelNameValidator";

const SYNTHESIS_CALL_TIMEOUT_MS = 10000;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 2200;
const DEFAULT_DISAGREEMENT_EXPLANATION = "Models take different positions on this point — see each model's excerpt below.";

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

const StakesEnum = z.enum(["low", "important", "decision-critical"]);

const NarrativeResponseSchema = z.object({
  executiveSummary: z.string(),
  whereModelsAgreeNarrative: z.array(z.string()),
  /** One explanation per deterministic disagreement topic, same order/length as the topics list sent in the prompt. */
  whyModelsDisagree: z.array(z.string()),
  /** One stakes tag per deterministic disagreement topic, same order/length. */
  disagreementStakes: z.array(StakesEnum),
  certaintyAssessment: z.string(),
  narrativeSections: z.array(z.object({ title: z.string(), body: z.string() })),
});

/** One disagreement row per split claim, with real quoted per-model excerpts — never model-invented text. */
function buildDeterministicDisagreements(disagreeRows: AlignedClaim[]): Omit<AdaptiveDisagreement, "whyTheyDiffer" | "stakes">[] {
  return disagreeRows.map((row) => ({
    topic: row.claimText,
    positions: row.cells
      .filter((c): c is AlignedClaimCell => !!c)
      .map((c) => ({ modelId: c.modelId, position: c.excerpt })),
  }));
}

function buildTemplateExecutiveSummary(unifiedAnswer: string, agreeCount: number, disagreeCount: number, gate: string): string {
  if (gate === "fail") return unifiedAnswer;
  const parts = [unifiedAnswer];
  if (agreeCount > 0 || disagreeCount > 0) {
    parts.push(
      `The panel reached consensus or majority agreement on ${agreeCount} claim${agreeCount === 1 ? "" : "s"} and split on ${disagreeCount} claim${disagreeCount === 1 ? "" : "s"}.`
    );
  }
  return parts.join(" ");
}

/**
 * Validates executive-summary/disagreement-explanation text against the
 * model roster, regenerating the narrative call once if a hallucinated name
 * is found, then falling back to stripping the offending token(s). Returns
 * cleaned text; never throws.
 */
async function validateAndCleanNarrativeText(
  texts: string[],
  modelRoster: ModelId[],
  regenerate: () => Promise<string[] | null>
): Promise<string[]> {
  const offending = texts.flatMap((t) => findUnrecognizedModelNames(t, modelRoster));
  if (offending.length === 0) return texts;

  logger.info("[adaptiveSchema] Synthesis narrative used an unrecognized model name, regenerating once", {
    offending,
  });

  let regenerated: string[] | null = null;
  try {
    regenerated = await regenerate();
  } catch (err: any) {
    // A failed/thrown regenerate must degrade to stripping the ORIGINAL
    // first-attempt text, not propagate up and lose the whole narrative
    // call's otherwise-good output (whyModelsDisagree, narrativeSections, etc).
    logger.warn("[adaptiveSchema] Regenerate call threw/timed out, stripping original text instead", {
      error: err?.message,
    });
  }

  if (regenerated) {
    const stillOffending = regenerated.flatMap((t) => findUnrecognizedModelNames(t, modelRoster));
    if (stillOffending.length === 0) return regenerated;
    logger.warn("[adaptiveSchema] Regenerated synthesis narrative still used an unrecognized model name, stripping", {
      stillOffending,
    });
    return regenerated.map((t) => stripUnrecognizedModelNames(t, modelRoster));
  }

  return texts.map((t) => stripUnrecognizedModelNames(t, modelRoster));
}

function buildNarrativePrompt(schemaId: QueryType, modelRoster: ModelId[], disagreementTopics: string[]): string {
  const rosterList = modelRoster.join(", ");
  return `You are writing the narrative portion of a multi-LLM research panel's Synthesis Report. The scoring (agreement, certainty, status) is ALREADY computed and the disagreement topics/positions are ALREADY determined — your job is only to narrate, not to re-judge the claims.

Only refer to models by these exact IDs, verbatim: ${rosterList}. Never invent, alter, or guess a model name or version.

${SCHEMA_NARRATIVE_HINTS[schemaId] ?? SCHEMA_NARRATIVE_HINTS.generic}

For "executiveSummary": answer the user's question in the first sentence, then 2-3 paragraphs total covering where models converge, where they diverge and why, and an overall confidence statement. Write prose, not stitched claims — do not append a parenthetical model-name list after every sentence.

For "whyModelsDisagree" and "disagreementStakes": you will be given a list of disagreement topics, in order. Return exactly one explanation and exactly one stakes tag per topic, in the SAME order. "whyModelsDisagree[i]" is one sentence on WHY models diverge on topic i (evidence base, framing, jurisdiction — whatever applies). "disagreementStakes[i]" is one of "low" | "important" | "decision-critical" — would topic i's resolution change a decision the asker is likely making?

Disagreement topics, in order:
${disagreementTopics.length > 0 ? disagreementTopics.map((t, i) => `${i + 1}. ${t}`).join("\n") : "(none — the panel had no split claims this run)"}

Return ONLY JSON in this exact shape:
{
  "executiveSummary": "...",
  "whereModelsAgreeNarrative": ["one short sentence per consensus/majority claim, in your own words"],
  "whyModelsDisagree": ${disagreementTopics.length > 0 ? `["exactly ${disagreementTopics.length} entries, same order as the topics above"]` : "[]"},
  "disagreementStakes": ${disagreementTopics.length > 0 ? `["exactly ${disagreementTopics.length} entries: low|important|decision-critical, same order as the topics above"]` : "[]"},
  "certaintyAssessment": "2-3 sentences on how much to trust this run and why, given the certainty score and gate",
  "narrativeSections": [{ "title": "...", "body": "..." }]
}
No markdown fences, no commentary outside the JSON.`;
}

/**
 * Build the full Synthesis Report for one adaptive panel run. Never throws;
 * degrades to a deterministic template (still complete, just without prose
 * elaboration) on any model-call failure.
 */
export async function buildAdaptiveSynthesisReport(
  question: string,
  schemaId: QueryType,
  rows: AlignedClaim[],
  rawResults: ModelResult[]
): Promise<AdaptiveSynthesisReport> {
  const totalModelCount = rawResults.length;
  const modelRoster = rawResults.map((r) => r.modelId);

  const runCertainty = computeRunCertainty(rows, schemaId);
  const gate = computeAdaptiveGate(rows, runCertainty, schemaId);
  const verdict = buildAdaptiveVerdict(rows, gate, totalModelCount);
  const unifiedAnswer = buildAdaptiveUnifiedAnswer(rows, gate);

  const agreeRows = rows.filter((r) => r.status === "consensus" || r.status === "majority");
  const disagreeRows = rows.filter((r) => r.status === "split");
  const deterministicDisagreements = buildDeterministicDisagreements(disagreeRows);

  // Independent of the narrative call below — needs full raw responses, not aligned rows.
  const bias = await detectAdaptiveBiases(question, schemaId, rawResults, modelRoster);
  const verdictCard = buildAdaptiveVerdictCard(question, rows, gate, bias);

  const templateDisagreements: AdaptiveDisagreement[] = deterministicDisagreements.map((d) => ({
    ...d,
    whyTheyDiffer: DEFAULT_DISAGREEMENT_EXPLANATION,
    stakes: "important" as AdaptiveStakes,
  }));

  const baseReport: AdaptiveSynthesisReport = {
    unifiedAnswer,
    panelVerdict: verdict.summary,
    gate: gate.status,
    runCertainty,
    whereModelsAgree: agreeRows.map((r) => r.claimText),
    whereModelsDisagree: disagreeRows.map((r) => r.claimText),
    certaintyAssessment: `Run certainty ${Math.round(runCertainty * 100)}% (gate: ${gate.status}). ${agreeRows.length} claim(s) at consensus/majority, ${disagreeRows.length} split.`,
    narrativeSections: [],
    executiveSummary: buildTemplateExecutiveSummary(unifiedAnswer, agreeRows.length, disagreeRows.length, gate.status),
    disagreements: templateDisagreements,
    biasAndBlindSpots: bias,
    verdictCard,
    degraded: true,
  };

  if (rows.length === 0) {
    return baseReport;
  }

  const disagreementTopics = deterministicDisagreements.map((d) => d.topic);
  const systemPrompt = buildNarrativePrompt(schemaId, modelRoster, disagreementTopics);
  const userMessage = `Question: "${question}"

Schema type: ${schemaId}

Scored claims (already aligned and scored across models — do not re-score, just narrate):
${rows
  .map(
    (r) =>
      `- "${r.claimText}" — status: ${r.status}, agreement: ${r.agreementScore.toFixed(2)}, certainty: ${r.certaintyScore.toFixed(2)}${r.disagreementType ? `, flagged: ${r.disagreementType}` : ""}`
  )
  .join("\n")}

Panel verdict: ${verdict.summary}
Run certainty: ${(runCertainty * 100).toFixed(0)}%
Gate: ${gate.status}`;

  async function callNarrative(): Promise<z.infer<typeof NarrativeResponseSchema> | null> {
    const result = await withTimeout(
      callGemini(userMessage, null, GEMINI_API_KEY, {
        systemPromptOverride: systemPrompt,
        maxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
      }),
      SYNTHESIS_CALL_TIMEOUT_MS,
      "synthesis_timeout"
    );

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Synthesis narrative call failed", { status: result.status });
      return null;
    }

    const parsedJson = JSON.parse(stripJsonFences(result.rawText));
    const parsed = NarrativeResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Synthesis narrative response failed validation");
      return null;
    }
    return parsed.data;
  }

  try {
    const parsed = await callNarrative();
    if (!parsed) return baseReport;

    const whyList =
      parsed.whyModelsDisagree.length === disagreementTopics.length
        ? parsed.whyModelsDisagree
        : disagreementTopics.map(() => DEFAULT_DISAGREEMENT_EXPLANATION);
    const stakesList =
      parsed.disagreementStakes.length === disagreementTopics.length
        ? parsed.disagreementStakes
        : disagreementTopics.map(() => "important" as AdaptiveStakes);

    const [cleanedExecutiveSummary, ...cleanedWhyList] = await validateAndCleanNarrativeText(
      [parsed.executiveSummary, ...whyList],
      modelRoster,
      async () => {
        const retry = await callNarrative();
        if (!retry) return null;
        const retryWhy =
          retry.whyModelsDisagree.length === disagreementTopics.length
            ? retry.whyModelsDisagree
            : disagreementTopics.map(() => DEFAULT_DISAGREEMENT_EXPLANATION);
        return [retry.executiveSummary, ...retryWhy];
      }
    );

    const disagreements: AdaptiveDisagreement[] = deterministicDisagreements.map((d, i) => ({
      ...d,
      whyTheyDiffer: cleanedWhyList[i] ?? DEFAULT_DISAGREEMENT_EXPLANATION,
      stakes: stakesList[i] ?? "important",
    }));

    return {
      // Unified Answer + Panel Verdict + Verdict Card + gate/certainty stay
      // deterministic — never overwritten by the model's narrative call.
      unifiedAnswer,
      panelVerdict: verdict.summary,
      gate: gate.status,
      runCertainty,
      whereModelsAgree: parsed.whereModelsAgreeNarrative.length > 0 ? parsed.whereModelsAgreeNarrative : baseReport.whereModelsAgree,
      whereModelsDisagree: baseReport.whereModelsDisagree,
      certaintyAssessment: parsed.certaintyAssessment || baseReport.certaintyAssessment,
      narrativeSections: parsed.narrativeSections,
      // On gate "fail", never let the model's prose read as confident — same
      // rule as buildAdaptiveUnifiedAnswer's deterministic override.
      executiveSummary: gate.status === "fail" ? baseReport.executiveSummary : cleanedExecutiveSummary || baseReport.executiveSummary,
      disagreements,
      biasAndBlindSpots: bias,
      verdictCard,
      degraded: false,
    };
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Synthesis narrative call threw/timed out, using template report", {
      error: err?.message,
    });
    return baseReport;
  }
}
