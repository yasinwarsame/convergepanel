/**
 * Bias & Blind Spots — Tier 3: deterministic diagnostics (Synthesis Report
 * Polish, Bias-Blind-Spots-Tiers fix).
 *
 * No model call — computed directly from already-scored AlignedClaim rows,
 * so it's always available whenever the run produced at least one claim.
 * Deliberately has NO "server-only" import: it's pure and cheap enough to be
 * safe to import from a client component too (mirrors textSimilarity.ts's
 * rationale), though today it's only called from synthesisReport.ts.
 */

import { AdaptiveDiagnostics, AlignedClaim, ClaimEvidenceType, Metric } from "./types";
import { HOMOGENEITY_AGREEMENT_THRESHOLD } from "./config";

function isRealSource(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "unknown" && normalized !== "none" && normalized !== "n/a";
}

/**
 * A row "cites a source" only when one of its cells carries a structured
 * Metric.source (the only per-claim citation data this pipeline has —
 * claim[]-derived rows have no citation field at all, see Claim in
 * types.ts). Schemas without metric fields will honestly show 0 cited
 * claims rather than a heuristic guess from prose.
 */
function claimCitesSource(row: AlignedClaim): boolean {
  return row.cells.some((c) => {
    const raw = c?.raw as Metric | undefined;
    return !!raw && typeof raw === "object" && "source" in raw && isRealSource(raw.source);
  });
}

/** Modal evidenceType among a row's cells (ties broken by first-seen order); null for rows with no cell carrying one (metric/step/scenario-derived rows). */
function dominantEvidenceType(row: AlignedClaim): ClaimEvidenceType | null {
  const counts = new Map<ClaimEvidenceType, number>();
  for (const c of row.cells) {
    if (!c?.evidenceType) continue;
    counts.set(c.evidenceType, (counts.get(c.evidenceType) ?? 0) + 1);
  }
  let best: ClaimEvidenceType | null = null;
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

export function computeAdaptiveDiagnostics(rows: AlignedClaim[]): AdaptiveDiagnostics {
  const totalClaimCount = rows.length;
  const citedClaimCount = rows.filter(claimCitesSource).length;

  const evidenceMix = { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 };
  for (const row of rows) {
    const type = dominantEvidenceType(row);
    if (type) evidenceMix[type] += 1;
  }

  const meanAgreement = totalClaimCount > 0 ? rows.reduce((sum, r) => sum + r.agreementScore, 0) / totalClaimCount : 0;
  const homogeneityFlag = totalClaimCount > 0 && meanAgreement > HOMOGENEITY_AGREEMENT_THRESHOLD;

  return { citedClaimCount, totalClaimCount, evidenceMix, homogeneityFlag, meanAgreement };
}
