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

import { AdaptiveSynthesisReport, PresentedAnswerClaim, PresentedClaim, PresentedUnresolvedClaim, ReportTextSource } from "./types";
import { CLAIM_LABEL, MODEL_CAVEAT_LABEL, PANEL_RESULT_LABEL, quoteClaim } from "./agreementNarrative";
import {
  DISPUTED_BY_LABEL,
  GATE_LABEL,
  GATE_STATUS_WORD,
  GateDisplayStatus,
  MODEL_PROSE_DOES_NOT_CHANGE_GATE,
  gateLabel,
  gateNotice,
  hasGatePresentation,
  readGateStatus,
  unresolvedLoadBearingHeading,
} from "./gatePresentation";
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

/** A load-bearing split claim in a caution answer (Order 4, D3): the claim, its computed result and the models on each side. */
export interface UnresolvedClaimBlock extends ClaimBlock {
  supporters: TextBlock | null;
  disputers: TextBlock | null;
}

/**
 * The Unified Answer (R6-1): a computed note, then each claim with its own result. Legacy: the stored string as one block.
 *
 * Order 4: a report with the gate presentation (and any report whose stored gate is unrecognized, D8) also carries
 * `gate` — "Verification gate: Caution", computed from the stored gate — and `notice`, the computed caution or
 * unrecognized notice (D2), both shown before the note and claims; a caution answer then discloses the gate's
 * load-bearing split claims under `unresolvedHeading` (D3). A historical report with a known gate has none of these
 * fields and renders exactly as before (D7).
 */
export interface UnifiedAnswerBlocks {
  gate?: TextBlock;
  notice?: TextBlock | null;
  note: TextBlock | null;
  /** "Unresolved claims" on a gate fail; null otherwise. */
  claimsHeading: string | null;
  claims: AnswerClaimBlock[];
  unresolvedHeading?: string | null;
  unresolved?: UnresolvedClaimBlock[];
  /**
   * F3: a computed note that stored load-bearing split entries could not be read (a corrupted record) — shown under
   * unresolvedHeading so a missing entry never reads as "no load-bearing split". Null when every entry was read.
   */
  unresolvedUnreadable?: TextBlock | null;
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

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isOptionalText = (v: unknown): boolean => v === undefined || isText(v);

/**
 * F3: a stored load-bearing split entry read without trusting it. It is used only when its claim and computed result
 * are text and every detail it carries (contested, supporters, disputers) is text — a corrupted detail would otherwise
 * be dropped and read as "none". Nothing is filled in: an unreadable entry is not shown, and is counted instead.
 */
function readUnresolvedClaim(value: unknown): PresentedUnresolvedClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isText(v.claim) || !isText(v.result) || !isOptionalText(v.contested) || !isOptionalText(v.supporters) || !isOptionalText(v.disputers)) return null;
  return {
    claim: v.claim,
    result: v.result,
    ...(v.contested !== undefined ? { contested: v.contested as string } : {}),
    ...(v.supporters !== undefined ? { supporters: v.supporters as string } : {}),
    ...(v.disputers !== undefined ? { disputers: v.disputers as string } : {}),
  };
}

export const UNRESOLVED_DETAILS_UNREADABLE = "The stored load-bearing claim details could not be read, so they are not shown.";

export function unreadableUnresolvedNotice(count: number): string {
  return count === 1
    ? "1 stored load-bearing claim could not be read, so it is not shown."
    : `${count} stored load-bearing claims could not be read, so they are not shown.`;
}

/** The stored load-bearing splits of a caution answer: the readable entries, and a note when any could not be read (F3). */
function readUnresolvedClaims(stored: unknown): { claims: PresentedUnresolvedClaim[]; unreadable: TextBlock | null; count: number } {
  if (!Array.isArray(stored)) return { claims: [], unreadable: { source: "computed", label: null, text: UNRESOLVED_DETAILS_UNREADABLE }, count: 1 };
  const claims = stored.map(readUnresolvedClaim).filter((c): c is PresentedUnresolvedClaim => c !== null);
  const dropped = stored.length - claims.length;
  return { claims, unreadable: dropped > 0 ? { source: "computed", label: null, text: unreadableUnresolvedNotice(dropped) } : null, count: stored.length };
}

function presentUnresolvedClaim(c: PresentedUnresolvedClaim): UnresolvedClaimBlock {
  return {
    ...presentClaim(c),
    supporters: c.supporters ? { source: "computed", label: SUPPORTED_BY_LABEL, text: c.supporters } : null,
    disputers: c.disputers ? { source: "computed", label: DISPUTED_BY_LABEL, text: c.disputers } : null,
  };
}

/** The stored gate as a computed block: "Verification gate: Caution" (blockText). */
function gateBlock(status: GateDisplayStatus): TextBlock {
  return { source: "computed", label: GATE_LABEL, text: GATE_STATUS_WORD[status] };
}

function noticeBlock(status: GateDisplayStatus): TextBlock | null {
  const notice = gateNotice(status);
  return notice ? { source: "computed", label: null, text: notice } : null;
}

/**
 * Whether the report shows the Order 4 gate presentation: it carries it (new reports), or its stored gate is
 * unrecognized (D8 — error handling, on every report). Null: render as before.
 */
function shownGate(report: AdaptiveSynthesisReport): GateDisplayStatus | null {
  const status = readGateStatus(report.gate);
  return hasGatePresentation(report) || status === "unrecognized" ? status : null;
}

/** D8 on a historical surface: the unrecognized gate and its notice, as computed blocks; empty for a known gate. */
function unrecognizedGateBlocks(report: AdaptiveSynthesisReport): TextBlock[] {
  return readGateStatus(report.gate) === "unrecognized" ? [gateBlock("unrecognized"), noticeBlock("unrecognized")!] : [];
}

/**
 * The Unified Answer: its computed note (gate fail, nothing to answer with), then each claim it rests on with
 * that claim's own computed result — never the claims run together as one computed paragraph. Legacy: the
 * stored string, unlabelled, as it always rendered.
 *
 * Order 4: led by the computed gate and notice, and on caution followed by the load-bearing split claims — see
 * UnifiedAnswerBlocks.
 */
export function presentUnifiedAnswer(report: AdaptiveSynthesisReport): UnifiedAnswerBlocks {
  const answer = report.presentation?.answer;
  const { gated, disclosure } = answerGateParts(report);
  // Without presentation.answer the stored answer string is shown, and it carries the split disclosure itself.
  if (!answer) return { ...gated, note: legacy(report.unifiedAnswer), claimsHeading: null, claims: [] };
  return {
    ...gated,
    note: answer.note ? { source: "computed", label: null, text: answer.note } : null,
    claimsHeading: report.gate === "fail" && answer.claims.length > 0 ? UNRESOLVED_CLAIMS_HEADING : null,
    claims: answer.claims.map(presentAnswerClaim),
    ...disclosure,
  };
}

/** The gate part of the Unified Answer (Order 4): the computed gate and notice, and a caution answer's load-bearing split disclosure. */
export type AnswerGateBlocks = Pick<UnifiedAnswerBlocks, "gate" | "notice" | "unresolvedHeading" | "unresolved" | "unresolvedUnreadable">;

function answerGateParts(report: AdaptiveSynthesisReport): { gated: Pick<AnswerGateBlocks, "gate" | "notice">; disclosure: Omit<AnswerGateBlocks, "gate" | "notice"> } {
  const status = shownGate(report);
  if (!status) return { gated: {}, disclosure: {} };
  const gated = { gate: gateBlock(status), notice: noticeBlock(status) };
  // F3: the stored entries are read without trusting them; a report without the Order 4 presentation stores none.
  // m-1: read whether or not presentation.answer is stored — presentUnifiedAnswer omits the disclosure without one
  // (its stored answer string carries it), but a page that shows its own answer has no other place to show it.
  const stored =
    status === "caution" && hasGatePresentation(report)
      ? readUnresolvedClaims((report.presentation?.verificationGate as { unresolvedLoadBearing?: unknown } | undefined)?.unresolvedLoadBearing)
      : { claims: [], unreadable: null, count: 0 };
  return {
    gated,
    disclosure: {
      unresolvedHeading: stored.count > 0 ? unresolvedLoadBearingHeading(stored.count) : null,
      unresolved: stored.claims.map(presentUnresolvedClaim),
      unresolvedUnreadable: stored.unreadable,
    },
  };
}

/**
 * O-1: exactly the gate part presentUnifiedAnswer leads with, for a page that shows its own answer instead of the
 * Unified Answer (the factual_lookup card). It reads no answer claims, so it adds no new way for a stored answer to
 * fail. Empty for a report presentUnifiedAnswer would show no gate for (D7: a historical report with a known gate).
 */
export function presentAnswerGate(report: AdaptiveSynthesisReport): AnswerGateBlocks {
  const { gated, disclosure } = answerGateParts(report);
  return { ...gated, ...disclosure };
}

/**
 * The executive summary: the computed panel statement, then the model's summary (labelled). Without model prose
 * (template, all filtered, gate fail) the stored summary is the Unified Answer, which carries claim text: it is
 * not repeated here as computed text — the summary is the panel statement and the answer's computed note only,
 * and the claims appear in the Unified Answer with their own results (R6-1).
 */
export function presentExecutiveSummary(report: AdaptiveSynthesisReport): TextBlock[] {
  const p = report.presentation;
  if (!p) return [...unrecognizedGateBlocks(report), legacy(report.executiveSummary)];
  const blocks: TextBlock[] = [];
  // Order 4 (D4): on caution, fail or an unrecognized gate, the computed gate (and notice) comes before any model
  // prose, so no narrative can stand in for it. A pass summary is unchanged.
  const status = shownGate(report);
  if (status && status !== "pass") {
    blocks.push(gateBlock(status));
    const notice = noticeBlock(status);
    if (notice) blocks.push(notice);
  }
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
  if (!p) return [legacy(report.certaintyAssessment), ...unrecognizedGateBlocks(report)];
  const blocks: TextBlock[] = [{ source: "computed", label: null, text: report.certaintyAssessment }];
  const status = shownGate(report);
  if (status === "unrecognized" && !p.certaintyExplanation) blocks.push(...unrecognizedGateBlocks(report));
  if (p.certaintyExplanation) {
    // Order 4 (D4): model certainty prose on caution / fail / unrecognized follows a computed statement that it
    // does not change the gate.
    if (status && status !== "pass") blocks.push({ source: "computed", label: null, text: `${gateLabel(status)}. ${MODEL_PROSE_DOES_NOT_CHANGE_GATE}` });
    blocks.push({ source: "model_explanation", label: MODEL_EXPLANATION_LABEL, text: p.certaintyExplanation });
  }
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

/**
 * Narrative sections: model-written on new reports (labelled); stored text on legacy ones. The title is model-written
 * too: on a report with the Order 4 gate presentation it is marked so (titleSource), and renderers show it inside the
 * attributed block rather than as an application heading (D4) — a title such as "Verification gate: Pass" cannot
 * read as the application's result.
 */
export function presentNarrativeSections(report: AdaptiveSynthesisReport): { title: string; titleSource: "model_explanation" | "heading"; body: TextBlock }[] {
  const modelWritten = !!report.presentation;
  const titleSource = hasGatePresentation(report) ? ("model_explanation" as const) : ("heading" as const);
  return report.narrativeSections.map((s) => ({
    title: s.title,
    titleSource,
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

/** An unresolved load-bearing claim's blocks, in display order: the claim, its computed result, contested note, supporters, disputers. */
export function unresolvedClaimParts(item: UnresolvedClaimBlock): TextBlock[] {
  return [item.claim, item.result, item.contested, item.supporters, item.disputers].filter((b): b is TextBlock => !!b);
}

/**
 * The caution answer's load-bearing split disclosure as groups, in display order: each readable claim's parts, then
 * (F3) the computed note that stored entries could not be read. Empty when the answer has no disclosure.
 */
export function unresolvedGroups(answer: UnifiedAnswerBlocks): TextBlock[][] {
  if (!answer.unresolvedHeading) return [];
  return [...(answer.unresolved ?? []).map(unresolvedClaimParts), ...(answer.unresolvedUnreadable ? [[answer.unresolvedUnreadable]] : [])];
}

/** The Unified Answer's computed lead — gate, then notice — as blocks; empty when the report shows neither (D7). */
export function answerLeadBlocks(answer: Pick<UnifiedAnswerBlocks, "gate" | "notice">): TextBlock[] {
  return [answer.gate, answer.notice].filter((b): b is TextBlock => !!b);
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
