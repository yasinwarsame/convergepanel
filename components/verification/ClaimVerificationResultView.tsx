"use client";

/**
 * TEAM-VERIFICATION-PARITY-R2 — SHARED, READ-ONLY Claim verification result
 * presentation.
 *
 * Renders a stored Claim verification result only: disclaimer, aggregate
 * verdict banner, consensus metrics, claim text, agreement digest, per-model
 * evidence and the legal disclaimer. It owns NO auth, NO network, NO governance
 * lookup, NO export/download, NO execution and NO application navigation. The
 * only links are the static `/terms` legal links that are part of the
 * disclaimers.
 *
 * Everything caller-specific arrives through explicit slots; an absent slot
 * renders nothing (never a Personal fallback):
 *   - `noticeSurface`     between the disclaimer header and the verdict banner
 *   - `governanceSurface` at the end of the consensus card
 *   - `actionsSurface`    after the claim text
 *
 * `ClaimVerificationResult` (the Personal wrapper) supplies today's Personal
 * governance fetch/badge, create-response policy notice, actions, audit trail
 * and Verify Another. A future Team durable detail page supplies its own.
 */

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { HelpCircle, CheckCircle, AlertTriangle, AlertCircle } from "lucide-react";
import { runModelFamilyName } from "@/lib/panel/runModelIdentity";
import type { ModelId } from "@/lib/types";
import type {
  ClaimVerificationClientPayload,
  ClaimVerdictUi,
} from "@/lib/verification/claimVerificationClientPayload";
import { CLAIM_VERDICT_CLIPBOARD_DISCLAIMER } from "@/lib/legal/clipboardDisclaimers";
import {
  claimConsensusDisplay,
  claimVerdictQualifier,
  CLAIM_NOT_INDEPENDENT_AGREE_HEADING,
  CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING,
  CLAIM_SINGLE_MODEL_BANNER_SUBTITLE,
  CLAIM_UNVERIFIED_BANNER_SUBTITLE,
} from "@/lib/verification/claimConsensusPresentation";
import { claimPresentedIndependence, claimRowsExecutionIdentity } from "@/lib/panel/storedVerificationIndependence";
import {
  CLAIM_NO_SUPPORT_BANNER_SUBTITLE,
  claimNoSupportAnswerSentence,
  claimNoSupportStatement,
  claimPayloadSlotTally,
  claimProviderSides,
  claimSlotResponsesNote,
  type ClaimStatementBasis,
  claimRowExecutionLabel,
  claimProviderExecutionLabel,
  claimScoreNeedsSlotQualifier,
  CLAIM_SCORE_SLOT_BASIS_QUALIFIER,
  claimSlotTallyNote,
  CLAIM_SLOT_RESPONSES_DIFFER_SUBTITLE,
  CLAIM_SLOT_RESPONSES_DIFFER_TITLE,
  splitClaimDisagreementsByIdentity,
  claimConflictPointByModels,
  claimSplitVerdictsQualifier,
  formatClaimVerdictCounts,
  hasSplitVerdicts,
  isDisputedWithoutSupport,
} from "@/lib/verification/claimVerdictCounts";
import { claimPayloadStatementBasis } from "@/lib/verification/claimStatementBasisSources";
import {
  independentModelsAmong,
  runSlotStatement,
  type RunExecutionIdentity,
} from "@/lib/panel/executionIdentity";

function verdictBadgeClass(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v === "accurate") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (v === "inaccurate") return "bg-rose-50 text-rose-700 border-rose-200";
  if (v === "partially_accurate") return "bg-amber-50 text-amber-700 border-amber-200";
  if (v === "unverifiable" || v === "parse_error" || v === "failed") {
    return "bg-cp-raised text-cp-muted border-cp-border";
  }
  return "bg-cp-raised text-cp-muted border-cp-border";
}

function formatVerdictLabel(verdict: string): string {
  if (verdict === "partially_accurate") return "Partially accurate";
  if (verdict === "parse_error") return "Parse error";
  return verdict.charAt(0).toUpperCase() + verdict.slice(1);
}

function aggregateVerdictLabel(verdict: ClaimVerdictUi): string {
  switch (verdict) {
    case "confirmed":
      return "Confirmed";
    case "disputed":
      return "Disputed";
    case "partially_true":
      return "Partially true";
    default:
      return "Unverifiable";
  }
}

function aggregateVerdictTextClass(verdict: ClaimVerdictUi): string {
  switch (verdict) {
    case "confirmed":
      return "text-emerald-700 font-semibold";
    case "disputed":
      return "text-rose-700 font-semibold";
    case "partially_true":
      return "text-amber-700 font-semibold";
    default:
      return "text-cp-muted font-semibold";
  }
}

const AGGREGATE_VERDICT_ICONS: Record<ClaimVerdictUi, ReactNode> = {
  confirmed: <CheckCircle className="h-8 w-8 shrink-0 text-emerald-600" aria-hidden />,
  disputed: <AlertTriangle className="h-8 w-8 shrink-0 text-rose-600" aria-hidden />,
  partially_true: <AlertCircle className="h-8 w-8 shrink-0 text-amber-600" aria-hidden />,
  unverifiable: <HelpCircle className="h-8 w-8 shrink-0 text-cp-faint" aria-hidden />,
};

function aggregateVerdictBadgeClass(verdict: ClaimVerdictUi): string {
  switch (verdict) {
    case "confirmed":
      return "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700";
    case "disputed":
      return "inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700";
    case "partially_true":
      return "inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700";
    default:
      return "inline-flex items-center rounded-full border border-cp-border bg-cp-raised px-2.5 py-0.5 text-xs font-semibold text-cp-muted";
  }
}

function confidenceLabelTextClass(label: "High" | "Medium" | "Low"): string {
  if (label === "High") return "text-emerald-700 font-semibold";
  if (label === "Medium") return "text-amber-700 font-semibold";
  return "text-cp-faint font-semibold";
}

function evidenceQualityTextClass(q: "strong" | "mixed" | "weak"): string {
  if (q === "strong") return "text-emerald-700 font-semibold capitalize";
  if (q === "mixed") return "text-amber-700 font-semibold capitalize";
  return "text-cp-faint font-semibold capitalize";
}

function truncateRunId(id: string): string {
  const t = id.trim();
  if (t.length <= 12) return t;
  return `${t.slice(0, 12)}…`;
}

function truncateClaimForAudit(claim: string, maxLen = 100): string {
  const t = claim.trim();
  if (t.length <= maxLen) return `"${t}"`;
  return `"${t.slice(0, maxLen - 1).trimEnd()}…"`;
}

function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Semantic color for per-model verdict words in the audit list. */
function perModelAuditVerdictClass(verdictOrStatus: string): string {
  const v = verdictOrStatus.toLowerCase();
  if (v === "accurate") return "text-emerald-700";
  if (v === "inaccurate") return "text-rose-700";
  if (v === "partially_accurate") return "text-amber-700";
  if (v === "parse_error" || v === "failed") return "text-rose-700";
  return "text-cp-muted";
}

/**
 * The independence a claim view presents (C-b CB-06..CB-09): the server's `modelIndependence`, confirmed by the shared
 * gate over the payload's rows (`claimPresentedIndependence`), and the gate's identity of those rows.
 */
export function claimViewIndependence(data: Pick<ClaimVerificationClientPayload, "modelIndependence" | "modelEvidence">): {
  independence: ReturnType<typeof claimPresentedIndependence>;
  identity: RunExecutionIdentity;
} {
  return {
    independence: claimPresentedIndependence(data.modelIndependence, data.modelEvidence),
    identity: claimRowsExecutionIdentity(data.modelEvidence),
  };
}

/**
 * R4 (owner ruling 2026-11-18): the ONE basis for every statement this payload's surfaces make about models —
 * the distinct reliably identified executing models (lib/verification/claimVerdictCounts.ts claimStatementBasis) over
 * the gate's K for a record presented "independent". Read-time only; nothing is re-scored.
 */
export function claimStatementBasisOf(data: Pick<ClaimVerificationClientPayload, "modelIndependence" | "modelEvidence" | "auditBundle">): ClaimStatementBasis {
  // The one shared derivation (lib/verification/claimStatementBasisSources.ts) — the stored-record surfaces read its twin.
  return claimPayloadStatementBasis(data);
}

/** True when counts of the usable rows are counts of identified executing models (one identified model per slot). */
function slotCountsAreModelCounts(data: Parameters<typeof claimStatementBasisOf>[0]): boolean {
  return claimStatementBasisOf(data).oneModelPerSlot;
}

/**
 * True when the payload's rows may be listed as MODELS under their slot family names: one identified model per slot,
 * every answering slot its OWN model (not substituted, recording its family's own provider — R4 MINOR-3) and every row
 * answered (a failed or malformed slot is not a model's assessment).
 */
function rowsAreNamedModels(data: Parameters<typeof claimStatementBasisOf>[0]): boolean {
  const basis = claimStatementBasisOf(data);
  const tally = claimPayloadSlotTally(data);
  return basis.namedOwnModels && tally !== null && tally.usable === data.modelEvidence.length;
}

/**
 * R4 owner ruling: the qualifier a presented consensus score / confidence / support ratio carries when the answering
 * slots are not each a distinct identified executing model (null when the basis is valid). Stored values unchanged.
 */
export function claimScoreBasisQualifier(data: Parameters<typeof claimStatementBasisOf>[0]): string | null {
  return claimScoreNeedsSlotQualifier(claimStatementBasisOf(data)) ? CLAIM_SCORE_SLOT_BASIS_QUALIFIER : null;
}

/** The two executing models a between-models conflict point is between, named by their identified providers. */
function betweenModelsLabels(
  data: ClaimVerificationClientPayload,
  providersOf: (p: ClaimVerificationClientPayload["whereModelsDisagree"][number]) => [string, string] | null,
  point: ClaimVerificationClientPayload["whereModelsDisagree"][number]
): string[] {
  const pair = providersOf(point);
  return pair ? pair.map((p) => claimProviderExecutionLabel(p, data.modelEvidence)) : point.models;
}

/**
 * C-b CB-07: what the slot counts of a qualified claim are (stated once, after the counts). A number of independent
 * models is stated only when the identified providers establish it (R4: `basis.modelsIdentified`, or a verified single
 * key for "insufficient"); otherwise the note says the providers do not establish it.
 */
export function claimSlotCountsNote(view: ReturnType<typeof claimViewIndependence>, basis?: ClaimStatementBasis): string {
  // Never more than the presented independence states: an "unverified" claim states no K, whatever its rows hold.
  const statement =
    view.independence === "unverified"
      ? "model independence unverified"
      : !view.identity.verified
        ? "fewer than two independent models answered"
        : view.independence === "independent" && basis !== undefined && !basis.modelsIdentified
          ? "the recorded providers do not establish how many independent models answered"
          : runSlotStatement(view.identity);
  return `These counts are of panel slots (${statement}), not of agreeing models.`;
}

/**
 * When automatic phrase extraction finds nothing, explain counts from the stored verdicts. The counts are of models
 * only when every answering slot is its own verified executing model (C-b CB-07); otherwise they are stated as panel
 * slots, with what the shared gate establishes about them. Slots with no usable verdict are never counted as rating it.
 */
function agreementSectionFallbackCopy(data: ClaimVerificationClientPayload): string {
  const rows = data.modelEvidence;
  if (rows.length === 0) {
    return "No strong cross-model agreement phrases detected automatically.";
  }
  const view = claimViewIndependence(data);
  // R4: rows are named as models only when each is its own identified, non-substitute executing model and answered.
  const asModels = rowsAreNamedModels(data);
  const unit = (n: number) => (asModels ? `model${n === 1 ? "" : "s"}` : `panel slot${n === 1 ? "" : "s"}`);

  // Only an answered "unverifiable" verdict is a slot that could not verify the claim; a failed or malformed slot
  // returned no usable verdict (stated separately, never counted as having assessed the claim).
  const notVerified = rows.filter((m) => m.status === "ok" && m.verdict === "unverifiable");
  const noVerdict = rows.filter((m) => m.status !== "ok");
  const accurate = rows.filter((m) => m.status === "ok" && m.verdict === "accurate");
  const partial = rows.filter((m) => m.status === "ok" && m.verdict === "partially_accurate");
  const inaccurate = rows.filter((m) => m.status === "ok" && m.verdict === "inaccurate");

  const sentences: string[] = [];
  const total = rows.length;

  if (notVerified.length > 0) {
    sentences.push(
      `${notVerified.length} of ${total} ${unit(total)} could not verify this claim.`
    );
  }
  if (noVerdict.length > 0) {
    sentences.push(`${noVerdict.length} of ${total} ${unit(total)} returned no usable verdict.`);
  }

  const describeVerdictGroup = (
    models: typeof accurate,
    singularLabel: string,
    pluralLabel: string
  ) => {
    if (models.length === 0) return;
    const names = models.map((m) => runModelFamilyName(m.modelId as ModelId));
    const namePhrase =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    if (models.length === 1) {
      sentences.push(`1 ${unit(1)} (${namePhrase}) rated it as ${singularLabel}.`);
    } else {
      sentences.push(`${models.length} ${unit(models.length)} (${namePhrase}) rated it as ${pluralLabel}.`);
    }
  };

  describeVerdictGroup(accurate, "accurate", "accurate");
  describeVerdictGroup(partial, "partially accurate", "partially accurate");
  describeVerdictGroup(inaccurate, "inaccurate", "inaccurate");

  if (sentences.length === 0) {
    return "No strong cross-model agreement phrases detected automatically.";
  }
  if (!asModels) sentences.push(claimSlotCountsNote(view, claimStatementBasisOf(data)));
  return sentences.join(" ");
}

/**
 * The agreement / disagreement sections a claim surface shows (owner ruling 2026-11-18, R3). With a multi-model
 * consensus, "Where models agree" only when every answering slot is its own identified executing model (a shared point
 * cannot then come from one model's several slots), and "Where models disagree" only for pairs from two different
 * identified models; every other point is listed under the existing "points … across responses" headings. Without a
 * consensus everything is under those headings, as before.
 */
export function claimDigestSections(data: ClaimVerificationClientPayload): {
  agreeHeading: string;
  agree: string[];
  /**
   * One entry per pair of DISTINCT executing models (R4); `models` names the two executing models. `named` (R5): the
   * point re-worded to name those models when the stored slot ids would name models that did not run.
   */
  disagreeBetweenModels: Array<ClaimVerificationClientPayload["whereModelsDisagree"][number] & { named?: string }>;
  disagreeBetweenSlots: ClaimVerificationClientPayload["whereModelsDisagree"];
} {
  const view = claimViewIndependence(data);
  const consensus = claimConsensusDisplay(data.consensusScore, view.independence);
  if (consensus.kind !== "score") {
    return { agreeHeading: CLAIM_NOT_INDEPENDENT_AGREE_HEADING, agree: data.whereModelsAgree, disagreeBetweenModels: [], disagreeBetweenSlots: data.whereModelsDisagree };
  }
  const sides = claimProviderSides(data.modelEvidence);
  const split = splitClaimDisagreementsByIdentity(data.whereModelsDisagree, sides);
  return {
    agreeHeading: claimStatementBasisOf(data).oneModelPerSlot ? "Where models agree" : CLAIM_NOT_INDEPENDENT_AGREE_HEADING,
    agree: data.whereModelsAgree,
    disagreeBetweenModels: split.betweenModels.map((p) => {
      const models = betweenModelsLabels(data, split.providersOf, p);
      const named = split.providersOf(p) ? claimConflictPointByModels(p.point, p.models, models) : null;
      return { ...p, models, ...(named ? { named } : {}) };
    }),
    disagreeBetweenSlots: split.betweenSlots,
  };
}

/** The memo's `claimCrossModel` input for this payload (R3/R4): the shared statement basis and the digest split. */
export function claimMemoCrossModel(data: ClaimVerificationClientPayload): ClaimStatementBasis & {
  disagreementPointsBetweenModels: string[];
  disagreementPointsBetweenSlots: string[];
  disagreementModelsByPoint: Record<string, string[]>;
  disagreementTextByPoint: Record<string, string>;
  scoreBasisQualifier: string | null;
} {
  const digest = claimDigestSections(data);
  return {
    ...claimStatementBasisOf(data),
    disagreementPointsBetweenModels: digest.disagreeBetweenModels.map((d) => d.point),
    disagreementPointsBetweenSlots: digest.disagreeBetweenSlots.map((d) => d.point),
    disagreementModelsByPoint: Object.fromEntries(digest.disagreeBetweenModels.map((d) => [d.point, d.models])),
    disagreementTextByPoint: Object.fromEntries(digest.disagreeBetweenModels.flatMap((d) => (d.named ? [[d.point, d.named]] : []))),
    scoreBasisQualifier: claimScoreBasisQualifier(data),
  };
}

/**
 * The claim memo's input for this payload — what the Personal wrapper exports (components/ClaimVerificationResult.tsx).
 * C-b (CB-10): the independence the view presents (server value confirmed by the shared gate over the rows) and, for an
 * independent claim, the gate's counts — never the number of rows; R4: the shared statement basis.
 */
// The return type is structural (lib/verification/generateMemo.ts MemoInput): this shared view imports no export module.
export function claimMemoInput(data: ClaimVerificationClientPayload) {
  const view = claimViewIndependence(data);
  const evidenceQ = data.evidenceQuality ?? data.auditBundle.evidenceQuality;
  const claimExecution =
    view.independence === "independent" && view.identity.verified && view.identity.independentModels !== null
      ? { independentModels: view.identity.independentModels, answeredSlots: view.identity.answeredSlots }
      : undefined;
  return {
    type: "claim" as const,
    claim: data.claim,
    verdict: data.verdict,
    consensusScore: data.consensusScore,
    confidenceLabel: data.confidenceLabel,
    evidenceQuality: typeof evidenceQ === "string" ? evidenceQ : "mixed",
    modelEvidence: data.modelEvidence.map((m) => ({
      modelId: m.modelId,
      // R4: the row's validated executing identity (MODEL VERDICTS); the slot family stays the row's `modelId`.
      executionLabel: claimRowExecutionLabel(m),
      status: m.status,
      verdict: m.verdict,
      confidence: m.confidence,
      summary: m.summary,
      correctParts: m.correctParts,
      incorrectParts: m.incorrectParts,
      unverifiableParts: m.unverifiableParts,
    })),
    agreementPoints: data.whereModelsAgree,
    disagreementPoints: data.whereModelsDisagree.map((d) => d.point),
    verificationId: data.verificationId ?? "",
    // Fail closed: a payload without recorded independence is "unverified" (no consensus score in the memo).
    claimModelIndependence: view.independence,
    ...(claimExecution ? { claimExecution } : {}),
    claimCrossModel: claimMemoCrossModel(data),
  };
}

/** Pure text for "Copy verdict". Formatting only — the caller decides whether and how to write it anywhere. */
export function buildClaimVerdictClipboardText(data: ClaimVerificationClientPayload): string {
  const lines: string[] = [];
  lines.push(`ConvergePanel — Claim result`);
  lines.push(`Claim: ${data.claim}`);
  // Doc 14 W1: the stored label is copied as stored; over answers none of which supported the claim it is followed by
  // the distribution, so a bare "disputed" is never read as disagreement between models.
  const clipTally = claimPayloadSlotTally(data);
  const counts = clipTally?.verdicts ?? null;
  lines.push(
    isDisputedWithoutSupport(data.verdict, counts)
      ? `Aggregate verdict: ${data.verdict} (${claimNoSupportAnswerSentence(counts)})`
      : `Aggregate verdict: ${data.verdict}`
  );
  // A multi-model consensus score only with >= 2 independent executing models (claimConsensusPresentation), confirmed
  // by the shared gate over the payload's rows (C-b CB-08).
  const { independence } = claimViewIndependence(data);
  const consensus = claimConsensusDisplay(data.consensusScore, independence);
  const qualifier = claimVerdictQualifier(independence);
  if (consensus.kind === "score") {
    // A confidence label over split answers is copied with the split (doc 14 D-3/D-4 presentation; stored label kept).
    const split = hasSplitVerdicts(counts) ? `; ${claimSplitVerdictsQualifier(counts)}` : "";
    // R4: not presented as independent corroboration without one distinct identified model per answering slot.
    const basisQ = claimScoreBasisQualifier(data);
    lines.push(`Consensus score: ${consensus.score} (${data.confidenceLabel} confidence${split}${basisQ ? `; ${basisQ}` : ""})`);
    const note = clipTally ? claimSlotTallyNote(clipTally) : null;
    if (note) lines.push(`Panel slots: ${note}`);
  } else {
    lines.push(`Verdict basis: ${qualifier}`);
    lines.push(`Consensus score: ${consensus.text}`);
  }
  lines.push("");
  lines.push("Per model:");
  for (const m of data.modelEvidence) {
    lines.push(`- ${claimRowExecutionLabel(m)}: ${formatVerdictLabel(m.verdict)} — ${m.summary}`);
  }
  const digest = claimDigestSections(data);
  if (digest.agree.length) {
    lines.push("");
    lines.push(`${digest.agreeHeading}:`);
    digest.agree.forEach((x) => lines.push(`• ${x}`));
  }
  if (digest.disagreeBetweenModels.length) {
    lines.push("");
    lines.push("Where models disagree:");
    digest.disagreeBetweenModels.forEach((x) => lines.push(x.named ? `• ${x.named}` : `• ${x.point} [${x.models.join(", ")}]`));
  }
  if (digest.disagreeBetweenSlots.length) {
    lines.push("");
    lines.push(`${CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING}:`);
    digest.disagreeBetweenSlots.forEach((x) => lines.push(`• ${x.point} [${x.models.join(", ")}]`));
  }
  lines.push(CLAIM_VERDICT_CLIPBOARD_DISCLAIMER.trimEnd());
  return lines.join("\n");
}

/**
 * Intrinsic audit-trail DETAILS derived from the stored audit bundle (run id,
 * timestamp, verdict, consensus, per-model pipeline status). Presentation only:
 * the surrounding panel, its toggle and any JSON copy/download stay with the
 * caller.
 */
export function ClaimVerificationAuditTrailDetails({ data }: { data: ClaimVerificationClientPayload }) {
  const bundle = data.auditBundle;
  const evidenceQ = data.evidenceQuality ?? bundle.evidenceQuality;
  // The stored bundle is shown as recorded, except that its cross-model figures (consensus, and the confidence and
  // evidence quality derived with it) are not presented as a consensus below two independent models.
  const view = claimViewIndependence(data);
  const consensus = claimConsensusDisplay(bundle.consensusScore, view.independence);
  return (
    <>
      <h3 className="text-sm font-semibold text-cp-text tracking-tight">Audit trail</h3>
      <dl className="mt-4 space-y-2.5 text-sm">
        <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 items-baseline">
          <dt className="text-cp-faint shrink-0">Run ID</dt>
          <dd className="text-cp-text font-mono text-xs break-all">
            {data.verificationId ? truncateRunId(data.verificationId) : "—"}
          </dd>
          <dt className="text-cp-faint shrink-0">Timestamp</dt>
          <dd className="text-cp-text">{formatAuditTimestamp(bundle.generatedAt)}</dd>
          <dt className="text-cp-faint shrink-0">Claim</dt>
          <dd className="text-cp-text leading-snug">{truncateClaimForAudit(data.claim)}</dd>
          <dt className="text-cp-faint shrink-0">Verdict</dt>
          <dd>
            <span className={aggregateVerdictBadgeClass(data.verdict)}>
              {aggregateVerdictLabel(data.verdict)}
            </span>
          </dd>
          <dt className="text-cp-faint shrink-0">Consensus</dt>
          {consensus.kind === "score" ? (
            <dd className="text-cp-text font-semibold tabular-nums">{consensus.score}/100</dd>
          ) : (
            <dd className="text-cp-muted" data-testid="claim-audit-consensus-withheld">{consensus.text}</dd>
          )}
          {consensus.kind === "score" ? (
            <>
              <dt className="text-cp-faint shrink-0">Confidence</dt>
              <dd className={confidenceLabelTextClass(bundle.confidenceLabel)}>{bundle.confidenceLabel}</dd>
              <dt className="text-cp-faint shrink-0">Evidence</dt>
              <dd className={evidenceQualityTextClass(evidenceQ)}>{evidenceQ}</dd>
            </>
          ) : null}
        </div>
      </dl>

      <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-cp-faint">
        {/* C-b CB-09: the stored bundle's rows are panel slots; they are model counts only for a verified run in which
            every answering slot is its own executing model. The bundle itself is shown as recorded. */}
        {rowsAreNamedModels(data) && bundle.perModel.length === data.modelEvidence.length ? "Models" : "Panel slots"} ({bundle.perModel.length})
      </p>
      <ul className="mt-2 space-y-1.5 text-sm">
        {bundle.perModel.map((row) => {
          const ok = row.pipelineStatus === "ok";
          const icon = ok ? "✓" : "✗";
          // R4: the validated executing identity of the slot (the payload row it records), never a bare family name.
          const evidenceRow = data.modelEvidence.find((m) => m.modelId === row.modelId);
          const name = evidenceRow ? claimRowExecutionLabel(evidenceRow) : runModelFamilyName(row.modelId as ModelId);
          let verdictKey: string;
          let verdictDisplay: string;
          if (ok && row.verdictLabel) {
            verdictKey = row.verdictLabel;
            verdictDisplay = formatVerdictLabel(row.verdictLabel);
          } else if (row.pipelineStatus === "parse_error") {
            verdictKey = "parse_error";
            verdictDisplay = "Parse error";
          } else {
            verdictKey = "failed";
            verdictDisplay = "Failed";
          }
          return (
            <li key={row.modelId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className={`w-4 shrink-0 text-center font-mono ${ok ? "text-emerald-600" : "text-rose-600"}`}
                aria-hidden
              >
                {icon}
              </span>
              <span className="text-cp-text font-medium">{name}</span>
              <span className="text-cp-faint">—</span>
              <span className={perModelAuditVerdictClass(verdictKey)}>{verdictDisplay}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** What the verdict banner says. Pure: from the payload only (exported for the exhaustive truthfulness spec). */
export function claimVerdictBanner(data: ClaimVerificationClientPayload): {
  className: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
} {
  // C-b CB-06: the server's independence confirmed by the shared gate over the rows; counts come from the gate.
  const view = claimViewIndependence(data);
  const independence = view.independence;
  // The recorded slot responses (doc 14 W1; owner ruling 2026-11-18): usable / failed / malformed / substituted.
  const tally = claimPayloadSlotTally(data);
  const v: ClaimVerdictUi =
    data.verdict === "confirmed" ||
    data.verdict === "disputed" ||
    data.verdict === "partially_true" ||
    data.verdict === "unverifiable"
      ? data.verdict
      : "unverifiable";
  if (independence !== "independent") {
    // Fewer than two independent executing models (or unknown execution): the verdict is not agreement between models.
    const tone = {
      confirmed: "bg-emerald-50 border-emerald-200 text-emerald-900",
      disputed: "bg-rose-50 border-rose-200 text-rose-900",
      partially_true: "bg-amber-50 border-amber-200 text-amber-900",
      unverifiable: "bg-cp-raised border-cp-border text-cp-text",
    }[v];
    return {
      className: tone,
      icon: AGGREGATE_VERDICT_ICONS[v],
      title: `${aggregateVerdictLabel(v)} — ${claimVerdictQualifier(independence)}`,
      subtitle: independence === "insufficient" ? CLAIM_SINGLE_MODEL_BANNER_SUBTITLE : CLAIM_UNVERIFIED_BANNER_SUBTITLE,
    };
  }
  // Owner ruling 2026-11-18 (R3): statements about MODELS rest on reliably identified executing providers; everything
  // else is stated as panel slot responses. Fail closed: rows that cannot be counted get the unverified banner.
  if (tally === null) {
    return {
      className: "bg-cp-raised border-cp-border text-cp-text",
      icon: AGGREGATE_VERDICT_ICONS[v],
      title: `${aggregateVerdictLabel(v)} — ${claimVerdictQualifier("unverified")}`,
      subtitle: CLAIM_UNVERIFIED_BANNER_SUBTITLE,
    };
  }
  // R4 (owner ruling 2026-11-18): one statement basis for every sentence — distinct identified executing models and,
  // for any claim of support, a majority of at least two of them; otherwise the recorded slot responses are stated.
  const basis = claimStatementBasisOf(data);
  const sides = claimProviderSides(data.modelEvidence);
  const slotNote = claimSlotResponsesNote(tally);
  const c = tally.verdicts;
  const tone = {
    confirmed: "bg-emerald-50 border-emerald-200 text-emerald-900",
    disputed: "bg-rose-50 border-rose-200 text-rose-900",
    partially_true: "bg-amber-50 border-amber-200 text-amber-900",
    unverifiable: "bg-cp-raised border-cp-border text-cp-text",
  }[v];
  // A stored label the recorded answers do not bear out (e.g. a historical record scored by older rules) is named as
  // recorded and followed by the answers — never re-scored, never described beyond what the answers show.
  const recorded = {
    className: tone,
    icon: AGGREGATE_VERDICT_ICONS[v],
    title: `Recorded verdict: ${aggregateVerdictLabel(v)}`,
    subtitle: `Panel slot responses: ${formatClaimVerdictCounts(c)}. ${slotNote}`,
  };
  const support = c.accurate + c.partially_accurate;
  switch (v) {
    case "confirmed":
      // C-b CB-06 "a/u models" (a substitute in several slots counts once) — only while the identified models answered
      // consistently and a majority of at least two identified models rated it accurate; otherwise slot responses.
      if (basis.supportMajority) {
        return {
          className: tone,
          icon: AGGREGATE_VERDICT_ICONS.confirmed,
          title: `This claim is supported by ${sides.accurateProviders}/${sides.providers} models`,
          subtitle: "Majority agreement: accurate",
        };
      }
      if (c.accurate === 0) return recorded;
      return {
        className: tone,
        icon: AGGREGATE_VERDICT_ICONS.confirmed,
        title: `This claim is supported by ${c.accurate} of ${c.usable} answers`,
        subtitle: `Recorded verdict: Confirmed. ${slotNote}`,
      };
    case "disputed": {
      // Doc 14 W1: `disputed` is also what the stored vocabulary records when NO answer supported the claim
      // (claimVerdict.ts fall-through). That is not a disagreement: state the recorded responses instead, with one
      // denominator; "models" only when every answering slot is its own identified executing model.
      if (isDisputedWithoutSupport(data.verdict, c)) {
        return {
          className: tone,
          icon: AGGREGATE_VERDICT_ICONS.disputed,
          title: claimNoSupportStatement({
            inaccurate: c.inaccurate,
            unverifiable: c.unverifiable,
            total: c.usable,
            unit: (k) => (basis.oneModelPerSlot ? `model${k === 1 ? "" : "s"}` : `answer${k === 1 ? "" : "s"}`),
          }),
          subtitle: basis.oneModelPerSlot ? CLAIM_NO_SUPPORT_BANNER_SUBTITLE : `${CLAIM_NO_SUPPORT_BANNER_SUBTITLE} ${slotNote}`,
        };
      }
      // "Models disagree" only when a supporting and an inaccurate answer come from two DIFFERENT identified models.
      // One substitute that answered both sides produced differing slot responses, not a disagreement between models.
      if (basis.disagreement) {
        return {
          className: tone,
          icon: AGGREGATE_VERDICT_ICONS.disputed,
          title: "Models disagree on this claim",
          subtitle: "Review per-model evidence below",
        };
      }
      if (!hasSplitVerdicts(c)) return recorded;
      return {
        className: tone,
        icon: AGGREGATE_VERDICT_ICONS.disputed,
        title: CLAIM_SLOT_RESPONSES_DIFFER_TITLE,
        subtitle: `${CLAIM_SLOT_RESPONSES_DIFFER_SUBTITLE} ${slotNote}`,
      };
    }
    case "partially_true":
      if (support === 0) return recorded;
      return {
        className: tone,
        icon: AGGREGATE_VERDICT_ICONS.partially_true,
        title: "Core claim may hold — details need correction",
        // "Partial agreement across models" needs a majority of at least two distinct identified supporting models.
        subtitle: basis.partialSupportMajority ? "Partial agreement across models" : `Partial support in the panel slot responses. ${slotNote}`,
      };
    case "unverifiable":
    default:
      // "Models cannot verify" needs a majority of at least two distinct identified models rating it unverifiable.
      if (basis.unverifiableMajority) {
        return {
          className: tone,
          icon: AGGREGATE_VERDICT_ICONS.unverifiable,
          title: "Models cannot verify this claim with sufficient confidence",
          subtitle: "Majority of models: unverifiable",
        };
      }
      if (c.unverifiable === 0) return recorded;
      return {
        className: tone,
        icon: AGGREGATE_VERDICT_ICONS.unverifiable,
        title: `${c.unverifiable} of ${c.usable} answers rated this claim unverifiable`,
        subtitle: `Recorded verdict: Unverifiable. ${slotNote}`,
      };
  }
}

export type ClaimVerificationResultViewProps = {
  data: ClaimVerificationClientPayload;
  noticeSurface?: ReactNode;
  governanceSurface?: ReactNode;
  actionsSurface?: ReactNode;
};

export default function ClaimVerificationResultView({
  data,
  noticeSurface,
  governanceSurface,
  actionsSurface,
}: ClaimVerificationResultViewProps) {
  const [openModels, setOpenModels] = useState<Record<string, boolean>>({});

  // C-b CB-06: the server's independence confirmed by the shared gate over the rows; counts come from the gate.
  const view = useMemo(() => claimViewIndependence(data), [data]);
  const independence = view.independence;
  const consensus = claimConsensusDisplay(data.consensusScore, independence);
  // The recorded slot responses and their per-verdict counts (doc 14 W1; owner ruling 2026-11-18).
  const tally = useMemo(() => claimPayloadSlotTally(data), [data]);
  const verdictCounts = tally?.verdicts ?? null;
  const tallyNote = tally ? claimSlotTallyNote(tally) : null;
  const digest = useMemo(() => claimDigestSections(data), [data]);
  const scoreBasisQualifier = useMemo(() => claimScoreBasisQualifier(data), [data]);

  const banner = useMemo(() => claimVerdictBanner(data), [data]);

  return (
    <div className="rounded-2xl border border-cp-border bg-cp-surface text-cp-text shadow-sm overflow-hidden">
      <div className="border-b border-cp-border bg-cp-primary-tint px-4 py-2.5 md:px-8">
        <p className="text-center text-[11px] leading-relaxed text-cp-muted md:text-left">
          <span className="mr-1" aria-hidden>
            ℹ️
          </span>
          ConvergePanel is an AI-assisted verification tool, not a forensic service. Results inform judgment —
          they don&apos;t replace it.{" "}
          <Link href="/terms" className="font-medium text-cp-accent underline-offset-2 hover:underline">
            Terms
          </Link>
        </p>
      </div>
      {noticeSurface}
      <div className={`border-b px-5 py-6 md:px-8 md:py-8 ${banner.className}`}>
        <div className="flex items-start gap-3">
          <span className="flex shrink-0 items-center justify-center pt-0.5">{banner.icon}</span>
          <div>
            <h2 className="text-xl md:text-2xl font-semibold tracking-tight">{banner.title}</h2>
            <p className="mt-1 text-sm opacity-90">{banner.subtitle}</p>
          </div>
        </div>
      </div>

      <div className="px-5 py-5 md:px-8 space-y-6 border-b border-cp-border-soft">
        <div className="rounded-xl border border-cp-border bg-cp-raised p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-cp-faint">Consensus</p>
          {consensus.kind === "withheld" ? (
            <div className="mt-2" data-testid="claim-consensus-withheld">
              <p className="text-base font-semibold text-cp-text">{consensus.text}</p>
              <p className="mt-1 text-xs text-cp-faint">{claimVerdictQualifier(independence)}</p>
            </div>
          ) : (
          <div className="mt-2 flex flex-wrap items-end gap-4">
            <div>
              <p className="text-3xl font-bold text-cp-text">{consensus.score}</p>
              <p className="text-xs text-cp-faint">Consensus score</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-cp-accent">{data.confidenceLabel}</p>
              <p className="text-xs text-cp-faint">
                Confidence
                {/* Doc 14: the stored label is shown as stored, never over split answers without the split. */}
                {hasSplitVerdicts(verdictCounts) ? (
                  <span data-testid="claim-confidence-split"> ({claimSplitVerdictsQualifier(verdictCounts)})</span>
                ) : null}
              </p>
            </div>
            {verdictCounts !== null && verdictCounts.usable > 0 && (
              <div data-testid="claim-verdict-counts">
                <p className="text-lg font-semibold text-cp-text">{formatClaimVerdictCounts(verdictCounts)}</p>
                <p className="text-xs text-cp-faint">{slotCountsAreModelCounts(data) ? "Model verdicts" : "Panel slot verdicts"}</p>
                {tallyNote ? (
                  <p className="mt-0.5 text-xs text-cp-faint" data-testid="claim-slot-tally-note">
                    {tallyNote}
                  </p>
                ) : null}
              </div>
            )}
            {data.evidenceQuality && (
              <div>
                <p className="text-lg font-semibold text-cp-text capitalize">{data.evidenceQuality}</p>
                <p className="text-xs text-cp-faint">Evidence quality</p>
              </div>
            )}
            {data.supportRatio != null && (
              <div>
                <p className="text-lg font-semibold text-cp-text">{Math.round(data.supportRatio * 100)}%</p>
                <p className="text-xs text-cp-faint">Support ratio</p>
              </div>
            )}
          </div>
          )}
          {consensus.kind === "score" && scoreBasisQualifier ? (
            <p className="mt-2 text-xs text-cp-muted" data-testid="claim-consensus-basis">
              Score, confidence and support ratio are {scoreBasisQualifier}.
            </p>
          ) : null}
          {governanceSurface}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-cp-faint mb-1">Claim</p>
          <p className="text-sm md:text-base text-cp-text leading-relaxed whitespace-pre-wrap">{data.claim}</p>
        </div>

        {actionsSurface}
      </div>

      <div className="px-5 py-5 md:px-8 space-y-4 border-b border-cp-border-soft">
        <h3 className="text-sm font-semibold text-cp-text">Agreement &amp; disagreement</h3>
        {digest.agree.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-emerald-700 mb-2">{digest.agreeHeading}</p>
            <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
              {digest.agree.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-cp-muted leading-relaxed">{agreementSectionFallbackCopy(data)}</p>
        )}
        {(
          [
            ["Where models disagree", digest.disagreeBetweenModels],
            [CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING, digest.disagreeBetweenSlots],
          ] as const
        ).map(([heading, points]) =>
          points.length > 0 ? (
            <div key={heading}>
              <p className="text-xs font-medium text-rose-700 mb-2">{heading}</p>
              <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
                {points.map((x: (typeof points)[number] & { named?: string }, i) => (
                  <li key={i}>
                    {x.named ?? x.point}
                    {!x.named && x.models?.length ? <span className="text-cp-faint"> — {x.models.join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null
        )}
      </div>

      <div className="px-5 py-5 md:px-8">
        <h3 className="text-sm font-semibold text-cp-text mb-3">Per-model evidence</h3>
        <div className="space-y-3">
          {data.modelEvidence.map((m) => {
            const open = openModels[m.modelId] ?? false;
            return (
              <div key={m.modelId} className="rounded-xl border border-cp-border bg-cp-surface overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenModels((s) => ({ ...s, [m.modelId]: !open }))}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-cp-raised transition-colors"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-medium text-cp-text truncate">
                      {claimRowExecutionLabel(m)}
                    </span>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${verdictBadgeClass(m.verdict)}`}
                    >
                      {formatVerdictLabel(m.verdict)}
                    </span>
                    {m.status && m.status !== "ok" && (
                      <span className="text-xs text-cp-faint">({m.status})</span>
                    )}
                  </div>
                  <span className="text-cp-faint text-sm">{open ? "▲" : "▼"}</span>
                </button>
                {open && (
                  <div className="px-4 pb-4 pt-0 space-y-3 border-t border-cp-border-soft">
                    <p className="text-sm text-cp-text mt-3">{m.summary}</p>
                    {m.correctParts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-emerald-700 mb-1">Correct parts</p>
                        <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
                          {m.correctParts.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {m.incorrectParts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-rose-700 mb-1">Incorrect / misleading</p>
                        <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
                          {m.incorrectParts.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {m.unverifiableParts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-cp-faint mb-1">Unverifiable</p>
                        <ul className="list-disc pl-5 text-sm text-cp-muted space-y-1">
                          {m.unverifiableParts.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-cp-border-soft px-5 py-5 md:px-8">
        <div className="space-y-2 rounded-lg border border-cp-border bg-cp-raised p-4 text-xs text-cp-muted">
          <p className="font-semibold text-cp-text">Disclaimer</p>
          <p>
            Claim verification results are generated by AI language models and reflect their training data
            and reasoning capabilities at the time of the query. Results do not constitute fact-checking by human
            experts, journalistic verification, or legal determination of truth. AI models may hallucinate, reason
            incorrectly, or lack access to current information.
          </p>
          <p>
            Do not use these results as the sole basis for publishing claims, making business decisions, or taking
            legal action. Always verify important claims through authoritative primary sources.
          </p>
          <p>
            <Link href="/terms" className="text-cp-accent underline-offset-2 hover:underline">
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
