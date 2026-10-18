/**
 * Agreement narrative (D9, R3 correction — Option B)
 *
 * The one place that turns the structured Consensus Integrity result into
 * words. Every sentence that tells the reader how far the panel agrees —
 * consensus, majority, limited coverage, split, single source, contested, or
 * no consensus — is rendered here from already-scored rows, never written by
 * the synthesis model. The model's narrative is explanation around these
 * statements; it cannot replace or strengthen them (see narrativeIntegrity.ts
 * for how model sentences that try are removed).
 *
 * Nothing here classifies: status, cells and contested dimensions are read
 * as computed by scoreAgreement + applyConsensusIntegrity. The wording maps
 * are Records over AlignedClaimStatus, so a new status without wording fails
 * to compile; a status read from data that is not a known one is rendered as
 * unrecognised and never as agreement.
 *
 * Pure and client-safe: no "server-only", no I/O.
 */

import { ALIGNED_CLAIM_STATUSES, AdaptiveVerdictCard, AlignedClaim, AlignedClaimStatus } from "./types";
import { CONSENSUS_STATUS_RANK, assessedPositionCount, describeContested, isTopConsensusEligible } from "./consensusIntegrity";
import { singleLineText } from "./textSerialization";

/** The canonical no-core-finding text (panel verdict, verdict card, panel agreement statement). */
export const NO_CONSENSUS_IDENTIFIED = "No consensus identified.";

/** Why a limited_coverage row is not agreement — shared by every surface that explains it. */
export const LIMITED_COVERAGE_REASON = "half or fewer of the dispatched models took a position — too few to count as agreement";

function isKnownStatus(status: string): status is AlignedClaimStatus {
  return (ALIGNED_CLAIM_STATUSES as readonly string[]).includes(status);
}

// ─── One row ─────────────────────────────────────────────────────────────

/** The structured facts one row's agreement statement is rendered from. */
export interface RowAgreementFacts {
  claimId: string;
  claimText: string;
  /** As stored — possibly a value this version does not know. */
  status: string;
  /** Cells that agree or partially agree. */
  supporting: number;
  /** Cells that dispute. */
  disputing: number;
  /** Models that raised or were placed on the claim at all (non-null cells). */
  listed: number;
  /** Assessable positions (non-null, not "unclear") — the D3 coverage numerator. */
  assessed: number;
  /** Every model dispatched for the run — the D3 denominator. */
  dispatched: number;
  /** The canonical contested note (describeContested), or null. */
  contestedNote: string | null;
}

export function rowAgreementFacts(row: AlignedClaim, dispatchedPanelSize: number): RowAgreementFacts {
  const cells = row.cells.filter((c) => !!c);
  return {
    claimId: row.id,
    claimText: row.claimText,
    status: row.status,
    supporting: cells.filter((c) => c!.stance === "agrees" || c!.stance === "partial").length,
    disputing: cells.filter((c) => c!.stance === "disputes").length,
    listed: cells.length,
    assessed: assessedPositionCount(row),
    dispatched: dispatchedPanelSize,
    contestedNote: describeContested(row),
  };
}

const disputeVerb = (n: number) => (n === 1 ? "disputes" : "dispute");

export const ROW_AGREEMENT_WORDING: Readonly<Record<AlignedClaimStatus, (f: RowAgreementFacts) => string>> = {
  consensus: (f) =>
    f.supporting === f.dispatched
      ? `consensus: all ${f.dispatched} dispatched models support it`
      : `consensus: ${f.supporting} of ${f.dispatched} dispatched models support it`,
  majority: (f) =>
    `majority: ${f.supporting} of ${f.dispatched} dispatched models support it${f.disputing > 0 ? `, ${f.disputing} ${disputeVerb(f.disputing)} it` : ""}`,
  limited_coverage: (f) => `limited coverage: only ${f.assessed} of ${f.dispatched} dispatched models took a position — too few to count as agreement`,
  split: (f) => `split: ${f.supporting} of ${f.dispatched} dispatched models support it and ${f.disputing} ${disputeVerb(f.disputing)} it`,
  single_source: (f) => `single source: only ${f.listed} of ${f.dispatched} dispatched models raised it — not panel agreement`,
};

/** The row's status statement alone, e.g. "majority: 3 of 5 dispatched models support it, 1 disputes it". */
export function renderRowStatus(f: RowAgreementFacts): string {
  return isKnownStatus(f.status)
    ? ROW_AGREEMENT_WORDING[f.status](f)
    : `unrecognised status "${f.status}" — not presented as agreement`;
}

/** The authoritative agreement statement for one row: its status statement plus the canonical contested note. */
export function renderRowAgreement(f: RowAgreementFacts): string {
  const base = renderRowStatus(f);
  return f.contestedNote ? `${base}; ${f.contestedNote}` : base;
}

// ─── The whole panel ─────────────────────────────────────────────────────

export interface PanelAgreementFacts {
  dispatched: number;
  claims: number;
  byStatus: Readonly<Record<AlignedClaimStatus, number>>;
  /** Rows whose status this version does not know — never counted as agreement. */
  unrecognised: number;
  /** consensus + majority rows (TOP_CONSENSUS_ELIGIBLE). */
  eligible: number;
}

export function panelAgreementFacts(rows: AlignedClaim[], dispatchedPanelSize: number): PanelAgreementFacts {
  const byStatus = Object.fromEntries(ALIGNED_CLAIM_STATUSES.map((s) => [s, 0])) as Record<AlignedClaimStatus, number>;
  let unrecognised = 0;
  for (const r of rows) {
    if (isKnownStatus(r.status)) byStatus[r.status] += 1;
    else unrecognised += 1;
  }
  return {
    dispatched: dispatchedPanelSize,
    claims: rows.length,
    byStatus,
    unrecognised,
    eligible: rows.filter((r) => isTopConsensusEligible(r.status)).length,
  };
}

/** Panel-statement phrase per status, strongest first. Exhaustive by type. */
export const PANEL_STATUS_PHRASE: Readonly<Record<AlignedClaimStatus, (n: number) => string>> = {
  consensus: (n) => `consensus on ${n}`,
  majority: (n) => `majority agreement on ${n}`,
  limited_coverage: (n) => `limited coverage on ${n} (${LIMITED_COVERAGE_REASON})`,
  split: (n) => `a split on ${n}`,
  single_source: (n) => `a single source only on ${n}`,
};

/** Every known status, strongest agreement first — from the exhaustive rank map, never a hand-kept list. */
const PANEL_STATUS_ORDER: readonly AlignedClaimStatus[] = [...ALIGNED_CLAIM_STATUSES].sort((a, b) => CONSENSUS_STATUS_RANK[a] - CONSENSUS_STATUS_RANK[b]);

/**
 * The authoritative panel-level agreement statement, e.g.
 * "Of 3 scored claims across 5 dispatched models: consensus on 1; a split on 2."
 * Prefixed with "No consensus identified." when no row is consensus or
 * majority. Empty for a run with no scored claims.
 */
export function renderPanelAgreement(f: PanelAgreementFacts): string {
  if (f.claims === 0) return "";
  const parts = PANEL_STATUS_ORDER.filter((s) => f.byStatus[s] > 0).map((s) => PANEL_STATUS_PHRASE[s](f.byStatus[s]));
  if (f.unrecognised > 0) parts.push(`an unrecognised status on ${f.unrecognised} (not counted as agreement)`);
  const statement = `Of ${f.claims} scored claim${f.claims === 1 ? "" : "s"} across ${f.dispatched} dispatched model${f.dispatched === 1 ? "" : "s"}: ${parts.join("; ")}.`;
  return f.eligible === 0 ? `${NO_CONSENSUS_IDENTIFIED} ${statement}` : statement;
}

// ─── Claim text and model commentary in deterministic surfaces (R4-1) ────

/**
 * A row's claimText is model-written (the clusterer's canonicalText, or a
 * model's own claim): data the panel was asked about, never the panel's
 * conclusion. Wherever deterministic text embeds it, it is quoted, so a claim
 * that itself says "all models agree" reads as a quoted claim beside the
 * computed status.
 *
 * The quote is the boundary, so the claim cannot close it (R5-4): double
 * quotes inside the claim are shown as single quotes (" → ', “ → ‘, ” → ’),
 * and it is one run of words (textSerialization.singleLineText): line breaks
 * — every one joinLines knows, a lone CR included (R7-1) — and runs of
 * whitespace (R9-1) are one space, so neither can push model words to the
 * start of a line. This is display only — the stored claimText, and every
 * identity or hash computed from it, are unchanged; the derived strings
 * built with it (unifiedAnswer, panelVerdict, whereModelsAgree) carry the
 * single-line form. Format-specific escaping (HTML, Markdown, JSON) happens
 * in each renderer, never here.
 */
export function quoteClaim(claimText: string): string {
  const inner = claimText.replace(/"/g, "'").replace(/“/g, "‘").replace(/”/g, "’");
  return `“${singleLineText(inner)}”`;
}

export const CLAIM_LABEL = "Claim";
export const PANEL_RESULT_LABEL = "Panel result";
/** How the verdict card's caveat is labelled when it came from the bias-detection model call. */
export const MODEL_CAVEAT_LABEL = "Model-flagged (bias check, not a verified finding)";

/** A label and its text, as the parts a renderer that styles them separately (the PDF) draws. */
export interface LabelledText {
  label: string;
  text: string;
}

/**
 * The verdict card's claim + computed status as parts: the quoted, model-written claim and the computed result,
 * each with its label. Null on cards persisted before topConsensusAgreement / keyDisagreementAgreement existed.
 */
export function verdictClaimParts(claim: string, agreement: string | undefined): { claim: LabelledText; result: LabelledText } | null {
  if (!agreement) return null;
  return { claim: { label: CLAIM_LABEL, text: quoteClaim(claim) }, result: { label: PANEL_RESULT_LABEL, text: agreement } };
}

/**
 * The verdict card's claim + computed status, as every renderer shows them.
 * Cards persisted before topConsensusAgreement / keyDisagreementAgreement
 * existed return the stored text alone, exactly as they always rendered.
 */
export function presentVerdictClaim(claim: string, agreement: string | undefined): { claim: string; result: string | null } {
  const parts = verdictClaimParts(claim, agreement);
  if (!parts) return { claim, result: null };
  return { claim: `${parts.claim.label}: ${parts.claim.text}`, result: `${parts.result.label}: ${parts.result.text}` };
}

/**
 * The verdict card's model-written caveat as parts: its label and its text as one run of words
 * (textSerialization.singleLineText — line breaks, R8-1, and whitespace runs, R9-2, are one space), so neither can
 * start a separate line that reads like a panel result where a renderer honours breaks or wraps by width (the PDF).
 * Display only: the stored caveat is unchanged. Null when the card has no caveat or was persisted before
 * caveatSource existed (that caveat is shown as stored — see presentVerdictCaveat).
 */
export function modelCaveatParts(card: Pick<AdaptiveVerdictCard, "caveat" | "caveatSource">): LabelledText | null {
  if (!card.caveat || card.caveatSource !== "model_bias_check") return null;
  return { label: MODEL_CAVEAT_LABEL, text: singleLineText(card.caveat) };
}

/**
 * The verdict card's caveat as every renderer shows it: a caveat from the bias-detection call is labelled and shown
 * as one run of words (modelCaveatParts). A card persisted before caveatSource existed returns the stored text alone.
 */
export function presentVerdictCaveat(card: Pick<AdaptiveVerdictCard, "caveat" | "caveatSource">): string | null {
  if (!card.caveat) return null;
  const parts = modelCaveatParts(card);
  return parts ? `${parts.label}: ${parts.text}` : card.caveat;
}
