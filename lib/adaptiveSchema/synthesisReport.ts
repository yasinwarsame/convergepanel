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
 * Spots is a THREE-TIER system (see the Bias & Blind Spots Tiers fix): Tier 1
 * is the original per-model attributed-bias call (biasDetection.ts, needs
 * each model's full raw response); Tier 2 is a separate panel-level coverage
 * audit (coverageAudit.ts, one call over the aligned claims, asking what NO
 * model addressed); Tier 3 is deterministic diagnostics (diagnostics.ts, no
 * model call at all). All three render independently — Tier 1 being empty
 * doesn't hide Tier 2/3, and vice versa. Every model call degrades to a
 * deterministic template/empty-array on failure/timeout — never a crash,
 * never a blank section, never a silently-confident guess.
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
import { auditPanelCoverage } from "./coverageAudit";
import { computeAdaptiveDiagnostics } from "./diagnostics";
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
  // Query-routing redesign additions (Milestone 1): not reachable by the
  // live pipeline yet (active graceful_limitation never has claims to
  // synthesize; disabled/handoff entries have no fields at all). Mapped to
  // the generic hint purely for Record<QueryType, ...> exhaustiveness.
  graceful_limitation: "Standard synthesis narrative, no special framing required.",
  claim_verification: "Standard synthesis narrative, no special framing required.",
  media_authenticity_review: "Standard synthesis narrative, no special framing required.",
  document_qa: "Standard synthesis narrative, no special framing required.",
  document_comparison: "Standard synthesis narrative, no special framing required.",
  data_analysis: "Standard synthesis narrative, no special framing required.",
  current_live_information: "Standard synthesis narrative, no special framing required.",
  definition_explanation: "Standard synthesis narrative, no special framing required.",
  causal_explanation: "Standard synthesis narrative, no special framing required.",
  ranked_enumeration: "Standard synthesis narrative, no special framing required.",
  checklist_taxonomy: "Standard synthesis narrative, no special framing required.",
  comparison_matrix: "Standard synthesis narrative, no special framing required.",
  deep_research: "Standard synthesis narrative, no special framing required.",
  evidence_review: "Standard synthesis narrative, no special framing required.",
  bias_blindspot_audit: "Standard synthesis narrative, no special framing required.",
  decision_support: "Standard synthesis narrative, no special framing required.",
  scenario_analysis: "Standard synthesis narrative, no special framing required.",
  step_by_step_plan: "Standard synthesis narrative, no special framing required.",
  transformation: "Standard synthesis narrative, no special framing required.",
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

// ─── Narrative quality validators (Synthesis Report Polish, markdown-leak /
// metric-tuple-leak fixes) ──────────────────────────────────────────────
// Same regenerate-once-then-sanitize pattern as the pre-existing model-name
// hallucination guard, extended to cover two more failure modes seen in
// production: raw markdown syntax leaking into prose, and internal
// agreement/certainty scores leaking into sentences as bare numbers. All
// three checks share one regenerate call (never three separate ones) and
// run over every narrative text field, not just the executive summary.

/** Raw markdown bold syntax leaking into prose (e.g. "**strongly** agree"). */
const MARKDOWN_LEAK_PATTERN = /\*\*/;
/** An internal agreement/certainty score leaking into a sentence as a bare number, e.g. "(consensus, agreement 1.00, certainty 0.92)". */
const METRIC_TUPLE_PATTERN = /\bagreement\b[\s:=]*\d|\bcertainty\b[\s:=]*\d/i;

interface NormalizedNarrative {
  executiveSummary: string;
  whereModelsAgreeNarrative: string[];
  whyModelsDisagree: string[];
  disagreementStakes: AdaptiveStakes[];
  certaintyAssessment: string;
  narrativeSections: { title: string; body: string }[];
}

/** Pads/repairs whyModelsDisagree + disagreementStakes to disagreementTopics.length, same fallback as before this refactor. */
function normalizeNarrative(
  parsed: z.infer<typeof NarrativeResponseSchema>,
  disagreementTopics: string[]
): NormalizedNarrative {
  const whyModelsDisagree =
    parsed.whyModelsDisagree.length === disagreementTopics.length
      ? parsed.whyModelsDisagree
      : disagreementTopics.map(() => DEFAULT_DISAGREEMENT_EXPLANATION);
  const disagreementStakes =
    parsed.disagreementStakes.length === disagreementTopics.length
      ? parsed.disagreementStakes
      : disagreementTopics.map(() => "important" as AdaptiveStakes);

  return {
    executiveSummary: parsed.executiveSummary,
    whereModelsAgreeNarrative: parsed.whereModelsAgreeNarrative,
    whyModelsDisagree,
    disagreementStakes,
    certaintyAssessment: parsed.certaintyAssessment,
    narrativeSections: parsed.narrativeSections,
  };
}

/** Every free-text field the model generated, flattened — the full surface both leak checks and the model-name check run over. */
function collectNarrativeTexts(n: NormalizedNarrative): string[] {
  return [
    n.executiveSummary,
    n.certaintyAssessment,
    ...n.whereModelsAgreeNarrative,
    ...n.whyModelsDisagree,
    ...n.narrativeSections.flatMap((s) => [s.title, s.body]),
  ];
}

interface NarrativeIssues {
  hallucinatedNames: string[];
  hasMarkdownLeak: boolean;
  hasMetricLeak: boolean;
}

function detectNarrativeIssues(texts: string[], modelRoster: ModelId[]): NarrativeIssues {
  return {
    hallucinatedNames: texts.flatMap((t) => findUnrecognizedModelNames(t, modelRoster)),
    hasMarkdownLeak: texts.some((t) => MARKDOWN_LEAK_PATTERN.test(t)),
    hasMetricLeak: texts.some((t) => METRIC_TUPLE_PATTERN.test(t)),
  };
}

function hasNarrativeIssues(issues: NarrativeIssues): boolean {
  return issues.hallucinatedNames.length > 0 || issues.hasMarkdownLeak || issues.hasMetricLeak;
}

/** Strips literal ** markers, keeping the wrapped text — last-resort safety net for the markdown-leak fix. */
function stripMarkdownArtifacts(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*\*/g, "");
}

/** Removes a leaked "agreement 1.00" / "certainty: 0.92" style fragment, parenthetical or bare — last-resort safety net for the metric-tuple-leak fix. */
function stripMetricTuples(text: string): string {
  return text
    .replace(/\(\s*[^)]*\b(agreement|certainty)\b[^)]*\)/gi, "")
    .replace(/\b(agreement|certainty)\b\s*[:=]?\s*[\d.]+%?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .trim();
}

function sanitizeNarrativeText(text: string, modelRoster: ModelId[]): string {
  return stripUnrecognizedModelNames(stripMetricTuples(stripMarkdownArtifacts(text)), modelRoster);
}

/** Last-resort fallback after a failed/still-bad regenerate: strip whatever issues remain from every field. */
function sanitizeNarrative(n: NormalizedNarrative, modelRoster: ModelId[]): NormalizedNarrative {
  return {
    executiveSummary: sanitizeNarrativeText(n.executiveSummary, modelRoster),
    whereModelsAgreeNarrative: n.whereModelsAgreeNarrative.map((t) => sanitizeNarrativeText(t, modelRoster)),
    whyModelsDisagree: n.whyModelsDisagree.map((t) => sanitizeNarrativeText(t, modelRoster)),
    disagreementStakes: n.disagreementStakes,
    certaintyAssessment: sanitizeNarrativeText(n.certaintyAssessment, modelRoster),
    narrativeSections: n.narrativeSections.map((s) => ({
      title: sanitizeNarrativeText(s.title, modelRoster),
      body: sanitizeNarrativeText(s.body, modelRoster),
    })),
  };
}

function buildNarrativePrompt(schemaId: QueryType, modelRoster: ModelId[], disagreementTopics: string[]): string {
  const rosterList = modelRoster.join(", ");
  return `You are writing the narrative portion of a multi-LLM research panel's Synthesis Report. The scoring (agreement, certainty, status) is ALREADY computed and the disagreement topics/positions are ALREADY determined — your job is only to narrate, not to re-judge the claims.

Only refer to models by these exact IDs, verbatim: ${rosterList}. Never invent, alter, or guess a model name or version.

Write PLAIN TEXT ONLY — no markdown syntax at all (no **bold**, no _italic_, no # headings, no bullet dashes). Every field below is prose or a plain sentence, not formatted text.

Never include a numeric agreement/certainty value in any sentence (e.g. never write "agreement 1.00" or "certainty 0.85" in prose). Those scores are already shown elsewhere with labeled context — express support in words instead: "all five models", "most models", "a minority", "one model".

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

  // Bias & Blind Spots' three tiers — all independent of the narrative call
  // below. Tier 1 needs full raw responses (not aligned rows); Tier 2 needs
  // the aligned rows (not raw responses); Tier 3 is pure and needs only the
  // aligned rows. Run sequentially (same style as the pre-existing Tier 1
  // call) rather than in parallel, to keep call ordering simple to reason
  // about and to test.
  const biasResult = await detectAdaptiveBiases(question, schemaId, rawResults, modelRoster);
  const bias = biasResult.findings;
  const coverageGaps = await auditPanelCoverage(question, schemaId, rows.map((r) => r.claimText));
  const diagnostics = computeAdaptiveDiagnostics(rows);

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
    biasEmptyReason: biasResult.emptyReason,
    panelCoverageGaps: coverageGaps,
    diagnostics,
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

    let narrative = normalizeNarrative(parsed, disagreementTopics);
    const issues = detectNarrativeIssues(collectNarrativeTexts(narrative), modelRoster);

    if (hasNarrativeIssues(issues)) {
      logger.info("[adaptiveSchema] Synthesis narrative had leak issues, regenerating once", {
        hallucinatedNames: issues.hallucinatedNames,
        hasMarkdownLeak: issues.hasMarkdownLeak,
        hasMetricLeak: issues.hasMetricLeak,
      });

      let regeneratedRaw: z.infer<typeof NarrativeResponseSchema> | null = null;
      try {
        regeneratedRaw = await callNarrative();
      } catch (err: any) {
        // A failed/thrown regenerate must degrade to sanitizing the ORIGINAL
        // first-attempt text, not propagate up and lose the whole narrative
        // call's otherwise-good output (whyModelsDisagree, narrativeSections, etc).
        logger.warn("[adaptiveSchema] Regenerate call threw/timed out, sanitizing original text instead", {
          error: err?.message,
        });
      }

      if (regeneratedRaw) {
        const regenerated = normalizeNarrative(regeneratedRaw, disagreementTopics);
        const regenIssues = detectNarrativeIssues(collectNarrativeTexts(regenerated), modelRoster);
        if (!hasNarrativeIssues(regenIssues)) {
          narrative = regenerated;
        } else {
          logger.warn("[adaptiveSchema] Regenerated synthesis narrative still had leak issues, sanitizing", {
            hallucinatedNames: regenIssues.hallucinatedNames,
            hasMarkdownLeak: regenIssues.hasMarkdownLeak,
            hasMetricLeak: regenIssues.hasMetricLeak,
          });
          narrative = sanitizeNarrative(regenerated, modelRoster);
        }
      } else {
        narrative = sanitizeNarrative(narrative, modelRoster);
      }
    }

    const disagreements: AdaptiveDisagreement[] = deterministicDisagreements.map((d, i) => ({
      ...d,
      whyTheyDiffer: narrative.whyModelsDisagree[i] ?? DEFAULT_DISAGREEMENT_EXPLANATION,
      stakes: narrative.disagreementStakes[i] ?? "important",
    }));

    return {
      // Unified Answer + Panel Verdict + Verdict Card + gate/certainty stay
      // deterministic — never overwritten by the model's narrative call.
      unifiedAnswer,
      panelVerdict: verdict.summary,
      gate: gate.status,
      runCertainty,
      whereModelsAgree:
        narrative.whereModelsAgreeNarrative.length > 0 ? narrative.whereModelsAgreeNarrative : baseReport.whereModelsAgree,
      whereModelsDisagree: baseReport.whereModelsDisagree,
      certaintyAssessment: narrative.certaintyAssessment || baseReport.certaintyAssessment,
      narrativeSections: narrative.narrativeSections,
      // On gate "fail", never let the model's prose read as confident — same
      // rule as buildAdaptiveUnifiedAnswer's deterministic override.
      executiveSummary: gate.status === "fail" ? baseReport.executiveSummary : narrative.executiveSummary || baseReport.executiveSummary,
      disagreements,
      biasAndBlindSpots: bias,
      biasEmptyReason: biasResult.emptyReason,
      panelCoverageGaps: coverageGaps,
      diagnostics,
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
