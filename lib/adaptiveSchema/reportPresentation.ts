/**
 * Report presentation (R5: Consensus Integrity trust boundary)
 *
 * The one place that decides how report text is attributed. Every renderer —
 * the report view, the Answer strip, the Markdown / memo / LinkedIn / X
 * builders, DOCX and PDF — reads report text through these functions, so the
 * same text carries the same authority on every surface:
 *
 *   computed            the application's result from structured data
 *                       ("Panel result: majority: 4 of 5 …", the panel
 *                       agreement statement, the certainty line)
 *   model_claim         a claim the panel assessed, written by a model —
 *                       verbatim, quoted, labelled "Claim"
 *   model_explanation   the narrative model's explanation — labelled
 *                       "Model-written explanation (not a verified finding)"
 *   model_bias          the bias check's observation — labelled as such
 *
 * Model-written text is never promoted to a computed block, and computed text
 * never comes from a model. A report persisted before `presentation` existed
 * returns its stored text as "legacy" blocks with no label, so it renders
 * exactly as it always did. Pure and client-safe; formats apply their own
 * escaping (Markdown and plain text: textSerialization.ts).
 *
 * Coverage: the report view's summary, certainty, Unified Answer, Where
 * Models Agree, Disagreements and narrative sections; the Answer strip's
 * answer; Markdown, memo, LinkedIn and X; the DOCX/PDF Unified Answer. The
 * verdict card and its strip / DOCX / PDF agreement lines use
 * agreementNarrative.presentVerdictClaim / presentVerdictCaveat; the view's
 * single-model insights, load-bearing claims and bias section label their own
 * model text. Not every surface goes through this module.
 */

import { AdaptiveSynthesisReport, PresentedAnswerClaim, PresentedClaim, ReportTextSource } from "./types";
import { CLAIM_LABEL, MODEL_CAVEAT_LABEL, PANEL_RESULT_LABEL, quoteClaim } from "./agreementNarrative";
import { dedupeTextList } from "./textSimilarity";
import { TEXT_DEDUP_THRESHOLDS, WHERE_MODELS_AGREE_MAX_ITEMS } from "./config";

export const MODEL_EXPLANATION_LABEL = "Model-written explanation (not a verified finding)";

/** The label every surface shows for a block of each source; computed blocks are labelled only where they sit beside model text. */
export const SOURCE_LABEL: Readonly<Record<ReportTextSource, string>> = {
  computed: PANEL_RESULT_LABEL,
  model_claim: CLAIM_LABEL,
  model_explanation: MODEL_EXPLANATION_LABEL,
  model_bias: MODEL_CAVEAT_LABEL,
};

export interface TextBlock {
  /** "legacy": stored text of a report persisted before the presentation contract — shown as-is, unlabelled. */
  source: ReportTextSource | "legacy";
  /** The label to show with the text, or null (legacy text, or a computed block that needs none). */
  label: string | null;
  text: string;
}

/** A claim with its computed result, as one unit. */
export interface ClaimBlock {
  /** Quoted model-written claim text (quoteClaim), or the stored legacy line. */
  claim: TextBlock;
  /** "majority: 4 of 5 …" — computed; null on legacy reports. */
  result: TextBlock | null;
  /** The canonical contested note — computed; null when none or legacy. */
  contested: TextBlock | null;
}

export interface DisagreementBlock extends ClaimBlock {
  why: TextBlock;
}

/** A Unified Answer claim: the claim with its own computed result, and the models backing it (computed). */
export interface AnswerClaimBlock extends ClaimBlock {
  supporters: TextBlock | null;
}

/** The Unified Answer (R6-1): a computed note, then each claim with its own result. Legacy: the stored string as one block. */
export interface UnifiedAnswerBlocks {
  note: TextBlock | null;
  /** "Unresolved claims" on a gate fail; null otherwise. */
  claimsHeading: string | null;
  claims: AnswerClaimBlock[];
}

export const SUPPORTED_BY_LABEL = "Supported by";
export const UNRESOLVED_CLAIMS_HEADING = "Unresolved claims";

const legacy = (text: string): TextBlock => ({ source: "legacy", label: null, text });

function presentClaim(c: PresentedClaim): ClaimBlock {
  return {
    claim: { source: "model_claim", label: CLAIM_LABEL, text: quoteClaim(c.claim) },
    result: { source: "computed", label: PANEL_RESULT_LABEL, text: c.result },
    contested: c.contested ? { source: "computed", label: "Contested", text: c.contested } : null,
  };
}

function presentAnswerClaim(c: PresentedAnswerClaim): AnswerClaimBlock {
  return {
    ...presentClaim(c),
    supporters: c.supporters ? { source: "computed", label: SUPPORTED_BY_LABEL, text: c.supporters } : null,
  };
}

/**
 * The Unified Answer: its computed note (gate fail, nothing to answer with), then each claim it rests on with
 * that claim's own computed result — never the claims run together as one computed paragraph. Legacy: the
 * stored string, unlabelled, as it always rendered.
 */
export function presentUnifiedAnswer(report: AdaptiveSynthesisReport): UnifiedAnswerBlocks {
  const answer = report.presentation?.answer;
  if (!answer) return { note: legacy(report.unifiedAnswer), claimsHeading: null, claims: [] };
  return {
    note: answer.note ? { source: "computed", label: null, text: answer.note } : null,
    claimsHeading: report.gate === "fail" && answer.claims.length > 0 ? UNRESOLVED_CLAIMS_HEADING : null,
    claims: answer.claims.map(presentAnswerClaim),
  };
}

/**
 * The executive summary: the computed panel statement, then the model's summary (labelled). Without model prose
 * (template, all filtered, gate fail) the stored summary is the Unified Answer, which carries claim text: it is
 * not repeated here as computed text — the summary is the panel statement and the answer's computed note only,
 * and the claims appear in the Unified Answer with their own results (R6-1).
 */
export function presentExecutiveSummary(report: AdaptiveSynthesisReport): TextBlock[] {
  const p = report.presentation;
  if (!p) return [legacy(report.executiveSummary)];
  const blocks: TextBlock[] = [];
  if (p.panelAgreement) blocks.push({ source: "computed", label: PANEL_RESULT_LABEL, text: p.panelAgreement });
  if (p.executiveSummarySource === "model_explanation") {
    if (report.executiveSummary) blocks.push({ source: "model_explanation", label: MODEL_EXPLANATION_LABEL, text: report.executiveSummary });
  } else if (p.answer?.note) {
    blocks.push({ source: "computed", label: null, text: p.answer.note });
  }
  return blocks;
}

/** The certainty assessment: the computed certainty line, then the model's explanation (labelled) if any. */
export function presentCertainty(report: AdaptiveSynthesisReport): TextBlock[] {
  const p = report.presentation;
  if (!p) return [legacy(report.certaintyAssessment)];
  const blocks: TextBlock[] = [{ source: "computed", label: null, text: report.certaintyAssessment }];
  if (p.certaintyExplanation) blocks.push({ source: "model_explanation", label: MODEL_EXPLANATION_LABEL, text: p.certaintyExplanation });
  return blocks;
}

/** Where Models Agree: each claim quoted with its computed result. Legacy reports: the stored lines, near-duplicates merged as before. */
export function presentAgreeItems(report: AdaptiveSynthesisReport): ClaimBlock[] {
  const p = report.presentation;
  if (!p) {
    return dedupeTextList(report.whereModelsAgree, { ...TEXT_DEDUP_THRESHOLDS, cap: WHERE_MODELS_AGREE_MAX_ITEMS }).map((line) => ({
      claim: legacy(line),
      result: null,
      contested: null,
    }));
  }
  return p.agree.slice(0, WHERE_MODELS_AGREE_MAX_ITEMS).map(presentClaim);
}

/** Disagreements: each claim quoted with its computed result, and its explanation attributed to its source. */
export function presentDisagreements(report: AdaptiveSynthesisReport): DisagreementBlock[] {
  const p = report.presentation;
  return report.disagreements.map((d, i) => {
    const presented = p?.disagree[i];
    if (!presented) return { claim: legacy(d.topic), result: null, contested: null, why: legacy(d.whyTheyDiffer) };
    return {
      ...presentClaim(presented),
      why:
        presented.whySource === "model_explanation"
          ? { source: "model_explanation", label: MODEL_EXPLANATION_LABEL, text: d.whyTheyDiffer }
          : { source: "computed", label: null, text: d.whyTheyDiffer },
    };
  });
}

/** Narrative sections: model-written on new reports (labelled); stored text on legacy ones. */
export function presentNarrativeSections(report: AdaptiveSynthesisReport): { title: string; body: TextBlock }[] {
  const modelWritten = !!report.presentation;
  return report.narrativeSections.map((s) => ({
    title: s.title,
    body: modelWritten ? { source: "model_explanation", label: MODEL_EXPLANATION_LABEL, text: s.body } : legacy(s.body),
  }));
}

/** One block as plain text, "Label: text" when labelled — for the text surfaces (memo, social posts). */
export function blockText(block: TextBlock): string {
  return block.label ? `${block.label}: ${block.text}` : block.text;
}

/** A Unified Answer claim as plain-text lines (DOCX / PDF): the claim, then its computed result, contested note and supporters. */
export function answerClaimLines(item: AnswerClaimBlock): string[] {
  return [item.claim, item.result, item.contested, item.supporters].filter((b): b is TextBlock => !!b).map(blockText);
}

/** A claim block as one line of plain text: `Claim: “…” — Panel result: … — Contested: …`; legacy: the stored line. */
export function claimLine(block: ClaimBlock): string {
  return [block.claim, block.result, block.contested]
    .filter((b): b is TextBlock => !!b)
    .map(blockText)
    .join(" — ");
}

/** A claim and its computed result for length-limited text (social posts): the claim is shortened before quoting, the result never. */
export function shortClaimWithResult(item: PresentedClaim, maxClaimChars: number): string {
  const raw = item.claim.trim();
  const short = raw.length <= maxClaimChars ? raw : `${raw.slice(0, maxClaimChars - 1).trimEnd()}…`;
  return `${quoteClaim(short)} — ${PANEL_RESULT_LABEL.toLowerCase()}: ${item.result}`;
}
