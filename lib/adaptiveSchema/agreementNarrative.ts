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

import { ALIGNED_CLAIM_STATUSES, AlignedClaim, AlignedClaimStatus } from "./types";
import { CONSENSUS_STATUS_RANK, assessedPositionCount, describeContested, isTopConsensusEligible } from "./consensusIntegrity";

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

export const ROW_AGREEMENT_WORDING: Readonly<Record<AlignedClaimStatus, (f: RowAgreementFacts) => string>> = {
  consensus: (f) =>
    f.supporting === f.dispatched
      ? `consensus: all ${f.dispatched} dispatched models support it`
      : `consensus: ${f.supporting} of ${f.dispatched} dispatched models support it`,
  majority: (f) =>
    `majority: ${f.supporting} of ${f.dispatched} dispatched models support it${f.disputing > 0 ? `, ${f.disputing} dispute it` : ""}`,
  limited_coverage: (f) => `limited coverage: only ${f.assessed} of ${f.dispatched} dispatched models took a position — too few to count as agreement`,
  split: (f) => `split: ${f.supporting} of ${f.dispatched} dispatched models support it and ${f.disputing} dispute it`,
  single_source: (f) => `single source: only ${f.listed} of ${f.dispatched} dispatched models raised it — not panel agreement`,
};

/** The authoritative agreement statement for one row, e.g. "majority: 3 of 5 dispatched models support it, 1 disputes it". */
export function renderRowAgreement(f: RowAgreementFacts): string {
  const base = isKnownStatus(f.status)
    ? ROW_AGREEMENT_WORDING[f.status](f)
    : `unrecognised status "${f.status}" — not presented as agreement`;
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
