/**
 * Export/Share Text Builders for the Adaptive Synthesis Report (Part A4/A5)
 *
 * Client-safe (no "server-only" import) — these are pure string builders
 * called directly from AdaptiveSynthesisReportView.tsx's export action row,
 * mirroring the legacy PanelSynthesisView.tsx's inline
 * handleGenerateLinkedIn/handleGenerateX/copyStructuredSynthesisMarkdown
 * pattern, adapted to the adaptive report's field names.
 */

import { ModelId } from "@/lib/types";
import { RunModelProvenanceFacts, runModelFamilyName, runModelLabels } from "@/lib/panel/runModelIdentity";
import { MemoInput } from "@/lib/verification/generateMemo";
import { AdaptiveSynthesisReport } from "./types";
import { dedupeTextList } from "./textSimilarity";
import { TEXT_DEDUP_THRESHOLDS, WHERE_MODELS_AGREE_MAX_ITEMS } from "./config";
import { CLAIM_LABEL, MODEL_CAVEAT_LABEL, PANEL_RESULT_LABEL, quoteClaim } from "./agreementNarrative";
import {
  AnswerClaimBlock,
  ClaimBlock,
  TextBlock,
  UnresolvedClaimBlock,
  answerLeadBlocks,
  blockText,
  claimLine,
  presentAgreeGroups,
  presentAgreeItems,
  presentCertainty,
  presentDisagreements,
  presentExecutiveSummary,
  presentUnifiedAnswer,
  AGREE_GROUP_HEADINGS,
  shortClaimWithResult,
  unresolvedClaimParts,
} from "./reportPresentation";
import { CAUTION_NOTICE, CAUTION_NOTICE_SHORT, GATE_CONFIDENCE_LABEL, GATE_LABEL, gateLabel, hasGatePresentation, legacyGateWord, readGateStatus } from "./gatePresentation";
import { escapeMarkdownInline, markdownQuote, plainTextQuote, singleLineText } from "./textSerialization";
import { ADAPTIVE_RESEARCH_REPORT_KIND } from "@/lib/verification/generateMemo";
import { POSITIONS_BY_SLOT_HEADING, PositionSafeInput, PresentedSlotPosition, biasWithheldNotice, coverageWithheldNotice, isPositionMarked, positionView, presentPositionSafeReport } from "./positionPresentation";

/**
 * Order 5 (Contract P): every builder below states positions only through the position-safe view. A report the caller
 * already presented (positionPresentation.presentPositionSafeReport) is used as is; a marked stored report reaching a
 * builder directly is presented here, from the rows and roster the caller holds — without them no position is derived.
 */
function shown(report: AdaptiveSynthesisReport, input?: PositionSafeInput): AdaptiveSynthesisReport {
  return isPositionMarked(report) ? presentPositionSafeReport(report, input ?? { rows: null, roster: [] }) : report;
}

/** A row's positions by slot as plain lines (never quoted as verbatim model text). */
function slotLines(slots: PresentedSlotPosition[], escape: (t: string) => string): string[] {
  return slots.map((s) => `${escape(s.label)}: ${escape(s.position)}${s.excerpt ? ` — ${escape(s.excerpt.text)} (${s.excerpt.note})` : ""}`);
}

const POSITIONS_UNAVAILABLE_IN_FORMAT = "Position details are unavailable in this format.";

// R5 presentation contract: a report that carries `presentation` is rendered through reportPresentation.ts, so
// every block keeps its source label (Panel result / Claim / Model-written explanation). A report persisted
// before it existed takes the original code path below, unchanged.
//
// R6-2 / R6-3: in Markdown, every model-written string is serialized through textSerialization.ts — claims and
// short model text escaped inline, model prose as an escaped blockquote under its label — so model text cannot
// become a report heading, list, link or HTML. Headings and computed lines are written here.

/** The computed "Verification gate: …" block (reportPresentation): written as one line wherever it appears. */
const isGateBlock = (b: TextBlock) => b.source === "computed" && b.label === GATE_LABEL;

const isModelText = (b: TextBlock) => b.source === "model_claim" || b.source === "model_explanation" || b.source === "model_bias";

/** One attributed block as Markdown: "**Label:**" on its own line, then the text — model prose as an escaped blockquote. The computed gate is one bold line. */
function markdownBlock(block: TextBlock, indent = ""): string[] {
  if (isGateBlock(block)) return [`${indent}**${blockText(block)}**`];
  const body = isModelText(block) ? markdownQuote(block.text, indent) : [`${indent}${block.text}`];
  return block.label ? [`${indent}**${block.label}:**`, ...body] : body;
}

/** A claim block as one Markdown line: the claim's text is model-written, so it is escaped. */
function markdownClaim(item: ClaimBlock | AnswerClaimBlock): string {
  const parts = [item.claim, item.result, item.contested, "supporters" in item ? item.supporters : null];
  return parts
    .filter((b): b is TextBlock => !!b)
    .map((b) => `**${b.label}:** ${b.source === "model_claim" ? escapeMarkdownInline(b.text) : b.text}`)
    .join(" — ");
}

/** A model-written block for plain text (memo): "Label:" on its own line, then every line quoted. */
function plainTextBlock(block: TextBlock, indent = ""): string {
  if (!isModelText(block) || block.source === "model_claim") return `${indent}${blockText(block)}`;
  return [`${indent}${block.label}:`, ...plainTextQuote(block.text, indent)].join("\n");
}

/** The panel verdict for Markdown: the computed figures, and the top claim with its own result (R6-1, R6-3). */
function markdownPanelVerdict(report: AdaptiveSynthesisReport): string[] {
  const card = report.verdictCard;
  if (!card.topConsensusAgreement) return [`**Panel verdict:** ${escapeMarkdownInline(report.panelVerdict)}`];
  // Order 5 (Contract P, m-6): on a marked report the top row is labelled and headed by what it is.
  const verdict = positionView(report)?.verdict;
  const parts = [
    `**${verdict ? verdict.topLabel : CLAIM_LABEL}:** ${escapeMarkdownInline(quoteClaim(card.topConsensus))}`,
    `**${PANEL_RESULT_LABEL}:** ${card.topConsensusAgreement}`,
    ...(card.topConsensusContested ? [`**Contested:** ${card.topConsensusContested}`] : []),
  ];
  return [`**Panel verdict:** certainty ${Math.round(report.runCertainty * 100)}%; ${markdownGate(report)}. ${verdict ? verdict.topHeading : "Top claim"}:`, parts.join(" — ")];
}

/** The gate inside a Markdown line: "Verification gate: Caution" on reports with the Order 4 presentation, else "gate: caution" as before. */
function markdownGate(report: AdaptiveSynthesisReport): string {
  return hasGatePresentation(report) ? gateLabel(readGateStatus(report.gate)) : `gate: ${legacyGateWord(report.gate)}`;
}

/** An unresolved load-bearing claim as one Markdown line: the claim's text is model-written, so it is escaped. */
function markdownUnresolvedClaim(item: UnresolvedClaimBlock): string {
  return unresolvedClaimParts(item)
    .map((b) => `**${b.label}:** ${b.source === "model_claim" ? escapeMarkdownInline(b.text) : b.text}`)
    .join(" — ");
}

/** An unresolved load-bearing claim as one plain-text line (memo). */
function plainUnresolvedClaim(item: UnresolvedClaimBlock): string {
  return unresolvedClaimParts(item).map(blockText).join(" — ");
}

/** The Unified Answer's computed lead (gate, notice) as one line of plain text: "Verification gate: Caution. This result …". */
function leadText(blocks: TextBlock[]): string {
  return blocks.map(blockText).join(". ");
}

/** The Unified Answer for Markdown: the computed gate and notice, its computed note, each claim with its own result, then (caution) the load-bearing splits. */
function markdownUnifiedAnswer(report: AdaptiveSynthesisReport): string[] {
  const answer = presentUnifiedAnswer(report);
  const out: string[] = [];
  answerLeadBlocks(answer).forEach((b) => out.push(...markdownBlock(b)));
  if (answer.note) out.push(answer.note.text);
  if (answer.claimsHeading) out.push(`${answer.claimsHeading}:`);
  answer.claims.forEach((c) => out.push(`- ${markdownClaim(c)}`));
  if (answer.unresolvedHeading && answer.unresolved) {
    out.push(`${answer.unresolvedHeading}:`);
    answer.unresolved.forEach((c) => out.push(`- ${markdownUnresolvedClaim(c)}`));
    if (answer.unresolvedUnreadable) out.push(answer.unresolvedUnreadable.text);
  }
  return out;
}

/** Same merge pass the Synthesis Report view applies to "Where models agree" (Bias & Blind Spots Tiers fix, Part 4) — keeps exported markdown/memo/social copy free of the same near-duplicate paraphrases. */
function dedupedAgreementItems(report: AdaptiveSynthesisReport): string[] {
  return dedupeTextList(report.whereModelsAgree, { ...TEXT_DEDUP_THRESHOLDS, cap: WHERE_MODELS_AGREE_MAX_ITEMS });
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function buildAdaptiveSynthesisMarkdown(question: string, storedReport: AdaptiveSynthesisReport, positionInput?: PositionSafeInput): string {
  const report = shown(storedReport, positionInput);
  if (report.presentation) return buildPresentedMarkdown(question, report);
  const lines: string[] = [];
  lines.push("# Synthesis Report");
  lines.push("");
  lines.push(`**Question:** ${question}`);
  lines.push("");
  lines.push(`**Panel verdict:** ${report.panelVerdict}`);
  lines.push("");
  lines.push("## Unified Answer");
  // D8: an unrecognized stored gate is stated before the stored answer; a known gate exports exactly as before.
  answerLeadBlocks(presentUnifiedAnswer(report)).forEach((b) => lines.push(...markdownBlock(b)));
  lines.push(report.unifiedAnswer);
  lines.push("");
  lines.push("## Executive Summary");
  lines.push(report.executiveSummary);
  lines.push("");

  const agreementItems = dedupedAgreementItems(report);
  if (agreementItems.length > 0) {
    lines.push("## Where models agree");
    agreementItems.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (report.disagreements.length > 0) {
    lines.push("## Where models disagree");
    report.disagreements.forEach((d) => {
      lines.push(`- **${d.topic}** — ${d.whyTheyDiffer}`);
      d.positions.forEach((p) => lines.push(`  - ${runModelFamilyName(p.modelId)}: ${p.position}`));
    });
    lines.push("");
  }

  if (report.biasAndBlindSpots.length > 0) {
    lines.push("## Bias & blind spots");
    report.biasAndBlindSpots.forEach((b) => {
      lines.push(`- **${b.biasType}** — ${b.description}`);
    });
    lines.push("");
  }

  lines.push("## Certainty");
  lines.push(`${Math.round(report.runCertainty * 100)}% (gate: ${legacyGateWord(report.gate)}) — ${report.certaintyAssessment}`);
  lines.push("");
  lines.push("Source: convergepanel.com");

  return lines.join("\n");
}

function buildPresentedMarkdown(question: string, report: AdaptiveSynthesisReport): string {
  const lines: string[] = [];
  lines.push("# Synthesis Report");
  lines.push("");
  lines.push(`**Question:** ${question}`);
  lines.push("");
  lines.push(...markdownPanelVerdict(report));
  lines.push("");
  lines.push("## Unified Answer");
  lines.push(...markdownUnifiedAnswer(report));
  lines.push("");
  lines.push("## Executive Summary");
  for (const block of presentExecutiveSummary(report)) {
    lines.push(...markdownBlock(block));
    lines.push("");
  }

  const view = positionView(report);
  const agreeGroups = presentAgreeGroups(report);
  if (agreeGroups) {
    // Order 5 (Contract P, F-1): claims, value comparisons and rows not joined, each under its own heading.
    agreeGroups.forEach((g) => {
      lines.push(`## ${g.heading}`);
      g.items.forEach((a) => lines.push(`- ${markdownClaim(a)}`));
      lines.push("");
    });
  } else {
    const agreeItems = presentAgreeItems(report);
    if (agreeItems.length > 0) {
      lines.push("## Where models agree");
      agreeItems.forEach((a) => lines.push(`- ${markdownClaim(a)}`));
      lines.push("");
    }
  }

  const disagreements = presentDisagreements(report);
  if (disagreements.length > 0 && view) {
    // Order 5 (Contract P): each split row's computed statement and its positions by slot; no explanation.
    lines.push("## Unresolved claims and value differences");
    disagreements.forEach((d, i) => {
      lines.push(`- ${markdownClaim(d)}`);
      const rv = view.disagreements[i];
      if (!rv) lines.push(`  - ${POSITIONS_UNAVAILABLE_IN_FORMAT}`);
      else {
        lines.push(`  - **${POSITIONS_BY_SLOT_HEADING}:**`);
        slotLines(rv.slots, escapeMarkdownInline).forEach((l) => lines.push(`    - ${l}`));
      }
    });
    lines.push("");
  } else if (disagreements.length > 0) {
    lines.push("## Where models disagree");
    disagreements.forEach((d, i) => {
      lines.push(`- ${markdownClaim(d)}`);
      if (!d.why) return;
      if (isModelText(d.why)) {
        lines.push(`  - **${d.why.label}:**`);
        lines.push("");
        lines.push(...markdownQuote(d.why.text, "    "));
        lines.push("");
      } else {
        lines.push(`  - ${d.why.text}`);
      }
      report.disagreements[i].positions.forEach((p) => lines.push(`  - ${runModelFamilyName(p.modelId)}: ${escapeMarkdownInline(p.position)}`));
    });
    lines.push("");
  }

  const withheld = view ? [view.biasFindingsWithheld > 0 ? biasWithheldNotice(view.biasFindingsWithheld) : "", view.coverageGapsWithheld > 0 ? coverageWithheldNotice(view.coverageGapsWithheld) : ""].filter(Boolean) : [];
  if (withheld.length > 0) {
    lines.push("## Bias & blind spots");
    withheld.forEach((w) => lines.push(w));
    lines.push("");
  }
  if (report.biasAndBlindSpots.length > 0) {
    lines.push("## Bias & blind spots");
    lines.push(`**${MODEL_CAVEAT_LABEL}:**`);
    report.biasAndBlindSpots.forEach((b) => {
      lines.push(`- ${escapeMarkdownInline(b.biasType)} — ${escapeMarkdownInline(b.description)}`);
    });
    lines.push("");
  }

  lines.push("## Certainty");
  const [certaintyLine, ...certaintyRest] = presentCertainty(report);
  lines.push(`${Math.round(report.runCertainty * 100)}% (${markdownGate(report)}) — ${certaintyLine.text}`);
  for (const block of certaintyRest) {
    lines.push("");
    lines.push(...markdownBlock(block));
  }
  lines.push("");
  lines.push("Source: convergepanel.com");

  return lines.join("\n");
}

export function buildAdaptiveMemoInput(
  question: string,
  storedReport: AdaptiveSynthesisReport,
  modelsUsed: ModelId[],
  verificationId: string,
  /**
   * The run's per-slot provenance (live or saved result rows), when the caller
   * holds it: each model is then named with its recorded requested model.
   * Without it, models are named by family only — never by a product label.
   */
  modelProvenance?: readonly RunModelProvenanceFacts[] | null,
  positionRows?: readonly unknown[] | null
): MemoInput {
  const report = shown(storedReport, { rows: positionRows ?? null, roster: modelsUsed, provenance: modelProvenance });
  const confidenceLabel = GATE_CONFIDENCE_LABEL[readGateStatus(report.gate)];
  const view = positionView(report);
  if (view) {
    // Order 5 (Contract P): a marked adaptive report's memo — validated report type and marker, positions by slot from
    // the joined rows, no model-written explanation. The shared generator takes its adaptive-only path for it.
    const agree = presentAgreeItems(report).map(claimLine);
    const agreeGroups = (presentAgreeGroups(report) ?? []).map((g) => ({ heading: g.heading, items: g.items.map(claimLine) }));
    const summary = presentExecutiveSummary(report).map((b) => plainTextBlock(b)).join("\n\n");
    const answer = presentUnifiedAnswer(report);
    const lead = answerLeadBlocks(answer);
    const gateFindings = lead.length > 0 ? [leadText(lead), ...(answer.unresolved ?? []).map(plainUnresolvedClaim), ...(answer.unresolvedUnreadable ? [answer.unresolvedUnreadable.text] : [])] : [];
    const withheld = [view.biasFindingsWithheld > 0 ? biasWithheldNotice(view.biasFindingsWithheld) : "", view.coverageGapsWithheld > 0 ? coverageWithheldNotice(view.coverageGapsWithheld) : ""].filter(Boolean);
    return {
      type: "research",
      adaptivePositionPresentation: { reportKind: ADAPTIVE_RESEARCH_REPORT_KIND, disagreementPositionVersion: 1 },
      question,
      consensusScore: Math.round(report.runCertainty * 100),
      confidenceLabel,
      evidenceQuality: "mixed",
      keyFindings: [...gateFindings, ...agree.slice(0, 8)],
      synthesisAgreements: agree,
      adaptiveAgreeGroups: agreeGroups,
      synthesisDisagreements: presentDisagreements(report).map((d, i) => {
        const rv = view.disagreements[i];
        return [claimLine(d), ...(rv ? [`  ${POSITIONS_BY_SLOT_HEADING}:`, ...slotLines(rv.slots, (t) => t).map((l) => `    ${l}`)] : [`  ${POSITIONS_UNAVAILABLE_IN_FORMAT}`])].join("\n");
      }),
      confidenceAssessment: [summary || presentCertainty(report).map((b) => plainTextBlock(b)).join("\n\n"), ...withheld].filter(Boolean).join("\n\n"),
      modelsUsed: runModelLabels(modelsUsed, modelProvenance),
      verificationId,
    };
  }
  if (report.presentation) {
    const agree = presentAgreeItems(report).map(claimLine);
    const summary = presentExecutiveSummary(report).map((b) => plainTextBlock(b)).join("\n\n");
    // Order 4 (D5): the memo's findings lead with the computed gate (and on caution its notice and the load-bearing
    // splits) — mapped here, so the shared memo generator is unchanged. Historical reports: as before.
    const answer = presentUnifiedAnswer(report);
    const lead = answerLeadBlocks(answer);
    const gateFindings =
      lead.length > 0
        ? [leadText(lead), ...(answer.unresolved ?? []).map(plainUnresolvedClaim), ...(answer.unresolvedUnreadable ? [answer.unresolvedUnreadable.text] : [])]
        : [];
    return {
      type: "research",
      question,
      consensusScore: Math.round(report.runCertainty * 100),
      confidenceLabel,
      evidenceQuality: "mixed",
      keyFindings: [...gateFindings, ...agree.slice(0, 8)],
      synthesisAgreements: agree,
      synthesisDisagreements: presentDisagreements(report).map((d) =>
        !d.why ? claimLine(d) : isModelText(d.why) ? `${claimLine(d)}\n${plainTextBlock(d.why, "  ")}` : `${claimLine(d)} — ${blockText(d.why)}`
      ),
      confidenceAssessment: summary || presentCertainty(report).map((b) => plainTextBlock(b)).join("\n\n"),
      modelsUsed: runModelLabels(modelsUsed, modelProvenance),
      verificationId,
    };
  }
  return {
    type: "research",
    question,
    consensusScore: Math.round(report.runCertainty * 100),
    confidenceLabel,
    evidenceQuality: "mixed",
    keyFindings: [
      // D8: an unrecognized stored gate leads the findings; a known gate exports exactly as before.
      ...(readGateStatus(report.gate) === "unrecognized" ? [leadText(answerLeadBlocks(presentUnifiedAnswer(report)))] : []),
      ...dedupedAgreementItems(report).slice(0, 8),
    ],
    synthesisAgreements: dedupedAgreementItems(report),
    synthesisDisagreements: report.disagreements.map((d) => `${d.topic}: ${d.whyTheyDiffer}`),
    confidenceAssessment: report.executiveSummary || report.certaintyAssessment,
    modelsUsed: runModelLabels(modelsUsed, modelProvenance),
    verificationId,
  };
}

export function buildAdaptiveLinkedInPost(question: string, storedReport: AdaptiveSynthesisReport, positionInput?: PositionSafeInput): string {
  const report = shown(storedReport, positionInput);
  // Order 5 (Contract P): a compact format — no per-slot positions, no model names; rows are stated by their own result.
  const marked = !!positionView(report);
  const lines: string[] = [];
  lines.push(`I researched "${truncate(question, 120)}" across a multi-model AI panel using ConvergePanel.`);
  lines.push("");
  if (hasGatePresentation(report)) {
    // Order 4 (D5/D6): the gate in its neutral wording, the certainty as its own figure, and on caution the notice.
    const status = readGateStatus(report.gate);
    lines.push(`${gateLabel(status)} · Certainty: ${Math.round(report.runCertainty * 100)}%`);
    if (status === "caution") lines.push(CAUTION_NOTICE);
  } else {
    lines.push(`Certainty: ${Math.round(report.runCertainty * 100)}% (gate: ${legacyGateWord(report.gate)})`);
  }
  lines.push("");

  const presented = report.presentation;
  const agreementItems = presented ? [] : dedupedAgreementItems(report);
  const view = positionView(report);
  if (view && presented) {
    // Order 5 (Contract P, F-1): claims and value comparisons under their own headings, up to two of each.
    (["claim", "field", "other"] as const).forEach((kind) => {
      const entries = presented.agree.filter((_, i) => (view.agreeKinds[i] ?? "other") === kind);
      if (entries.length === 0) return;
      lines.push(`${AGREE_GROUP_HEADINGS[kind]}:`);
      entries.slice(0, 2).forEach((a) => lines.push(`→ ${shortClaimWithResult(a, 100)}`));
      lines.push("");
    });
  } else if (presented ? presented.agree.length > 0 : agreementItems.length > 0) {
    lines.push("Where models agree:");
    if (presented) presented.agree.slice(0, 2).forEach((a) => lines.push(`→ ${shortClaimWithResult(a, 100)}`));
    else agreementItems.slice(0, 2).forEach((a) => lines.push(`→ ${truncate(a, 140)}`));
    lines.push("");
  }

  if (report.disagreements.length > 0) {
    lines.push(marked ? "Unresolved claims and value differences:" : "Where models disagree:");
    if (presented) presented.disagree.slice(0, 2).forEach((d) => lines.push(`→ ${shortClaimWithResult(d, 100)}`));
    else report.disagreements.slice(0, 2).forEach((d) => lines.push(`→ ${truncate(d.topic, 140)}`));
    lines.push("");
  }

  if (!marked) {
    lines.push("The disagreements tell you more than any single answer.");
    lines.push("");
  }
  lines.push("→ convergepanel.com");

  return lines.join("\n");
}

export function buildAdaptiveXPost(question: string, storedReport: AdaptiveSynthesisReport, positionInput?: PositionSafeInput): string {
  const report = shown(storedReport, positionInput);
  if (positionView(report)) return buildMarkedXPost(question, report);
  const splitLabel = "Models split on: ";
  const parts: string[] = [];
  parts.push(`Asked a multi-model AI panel: "${truncate(question, 80)}"`);
  if (hasGatePresentation(report)) {
    const status = readGateStatus(report.gate);
    parts.push(`${gateLabel(status)}${status === "caution" ? ` (${CAUTION_NOTICE_SHORT})` : ""} · Certainty: ${Math.round(report.runCertainty * 100)}%`);
  } else {
    parts.push(`Certainty: ${Math.round(report.runCertainty * 100)}% (${legacyGateWord(report.gate)})`);
  }
  const split = report.presentation?.disagree[0];
  if (split) {
    // The post is capped at 280 characters: the claim gives way, the computed result never does.
    const fixed = [...parts, "via ConvergePanel"].join("\n\n").length + 2;
    const room = 280 - fixed - splitLabel.length - shortClaimWithResult({ ...split, claim: "" }, 0).length;
    parts.push(`${splitLabel}${shortClaimWithResult(split, Math.max(12, Math.min(60, room)))}`);
  } else if (report.disagreements.length > 0) {
    parts.push(`Models split on: ${truncate(report.disagreements[0].topic, 80)}`);
  }
  parts.push("via ConvergePanel");
  return truncate(parts.join("\n\n"), 280);
}

// ─── X (Order 5, Contract P, m-1) ───────────────────────────────────────────

export const X_POST_LIMIT = 280;
/** X counts every URL as this many characters, whatever its length (twitter-text v3 transformedURLLength). */
const X_URL_WEIGHT = 23;
/** twitter-text v3: code points in these ranges weigh 1; every other code point (CJK, emoji, …) weighs 2. */
const X_LIGHT_RANGES: readonly [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const X_URLISH = /(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/\S*)?/gu;

function xCodePointWeight(cp: number): number {
  return X_LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
}

function xRawWeight(text: string): number {
  let w = 0;
  let last = 0;
  for (const m of text.matchAll(X_URLISH)) {
    const at = m.index ?? 0;
    for (const ch of text.slice(last, at)) w += xCodePointWeight(ch.codePointAt(0)!);
    let own = 0;
    for (const ch of m[0]) own += xCodePointWeight(ch.codePointAt(0)!);
    w += Math.max(X_URL_WEIGHT, own);
    last = at + m[0].length;
  }
  for (const ch of text.slice(last)) w += xCodePointWeight(ch.codePointAt(0)!);
  return w;
}

/**
 * An upper bound on X's weighted length of `text` (twitter-text v3: NFC-normalized; light code points 1, others 2;
 * every URL 23). Conservative by construction: a URL-like token counts as at least 23 and as much as its own text,
 * every emoji code point counts 2, and the larger of the raw and NFC weights is taken — so a post within the limit
 * here is within it on X. Never `string.length`.
 */
export function xWeightedLength(text: string): number {
  return Math.max(xRawWeight(text), xRawWeight(text.normalize("NFC")));
}

function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (x) => x.segment) : Array.from(text);
}

/** `text` shortened to at most `budget` weighted characters, at a grapheme boundary, with "…" when shortened. */
export function xFit(text: string, budget: number): string {
  if (xWeightedLength(text) <= budget) return text;
  const g = graphemes(text);
  let n = g.length;
  while (n > 0 && xWeightedLength(`${g.slice(0, n).join("").trimEnd()}…`) > budget) n -= 1;
  return n > 0 ? `${g.slice(0, n).join("").trimEnd()}…` : "";
}

const X_BRAND = "via ConvergePanel";
const X_UNRESOLVED_LABEL = "Unresolved: ";

/**
 * A marked report's X post, within X's weighted 280-character limit. The computed parts — the gate, the certainty,
 * a row's computed result, the brand — are never cut: the model-written claim gives way first (down to a short
 * quote), then the question; if the row's computed result still cannot fit whole, the row is left out and the post
 * says how many unresolved rows the full report has. It names no panel slot.
 */
function buildMarkedXPost(question: string, report: AdaptiveSynthesisReport): string {
  const gateLine = hasGatePresentation(report)
    ? (() => {
        const status = readGateStatus(report.gate);
        return `${gateLabel(status)}${status === "caution" ? ` (${CAUTION_NOTICE_SHORT})` : ""} · Certainty: ${Math.round(report.runCertainty * 100)}%`;
      })()
    : `Certainty: ${Math.round(report.runCertainty * 100)}% (${legacyGateWord(report.gate)})`;
  const asked = (q: string) => `Asked a multi-model AI panel: "${q}"`;
  const post = (q: string, row: string | null) => [asked(q), gateLine, ...(row ? [row] : []), X_BRAND].join("\n\n");
  const split = report.presentation?.disagree[0];
  const rowLine = (claimBudget: number) => {
    if (!split) return null;
    const claim = xFit(singleLineText(split.claim), claimBudget);
    return claim ? `${X_UNRESOLVED_LABEL}${quoteClaim(claim)} — ${PANEL_RESULT_LABEL.toLowerCase()}: ${split.result}` : null;
  };
  const fits = (t: string) => xWeightedLength(t) <= X_POST_LIMIT;
  for (const qBudget of [80, 48, 24]) {
    const q = xFit(singleLineText(question), qBudget);
    for (const cBudget of [60, 40, 24, 12]) {
      const candidate = post(q, rowLine(cBudget));
      if (fits(candidate)) return candidate;
    }
    if (!split && fits(post(q, null))) return post(q, null);
  }
  const n = report.disagreements.length;
  const pointer = n > 0 ? `${n} unresolved row${n === 1 ? "" : "s"} — see the full report` : null;
  for (const qBudget of [80, 48, 24]) {
    const candidate = post(xFit(singleLineText(question), qBudget), pointer);
    if (fits(candidate)) return candidate;
  }
  return post(xFit(singleLineText(question), 24), null);
}
