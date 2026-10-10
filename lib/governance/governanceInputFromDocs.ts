/**
 * Build GovernanceInput from stored run / verification documents (queue backfill + evaluation).
 */

import type { GovernanceInput } from "./evaluateGovernance";
import { deriveSynthesisEvidenceQuality } from "@/lib/verification/consensusScoring";

function modelHealthFromPerModel(perModel: unknown): GovernanceInput["modelHealth"] {
  let ok = 0;
  let substituted = 0;
  let failed = 0;
  if (!Array.isArray(perModel)) return { ok, substituted, failed };
  for (const row of perModel) {
    const st = String((row as { status?: string })?.status ?? "").toLowerCase();
    if (st === "ok") ok++;
    else if (st === "substituted") substituted++;
    else failed++;
  }
  return { ok, substituted, failed };
}

function modelHealthFromRunData(data: Record<string, unknown>): GovernanceInput["modelHealth"] {
  const rd = data.runDocument as { perModel?: unknown } | undefined;
  const rc = data.resultsCompact as { perModel?: unknown } | undefined;
  const candidates: unknown[] = [
    data.results,
    data.modelResults,
    data.panelResults,
    rd?.perModel,
    rc?.perModel,
  ];
  for (const c of candidates) {
    const h = modelHealthFromPerModel(c);
    if (h.ok + h.substituted + h.failed > 0) return h;
  }
  return { ok: 0, substituted: 0, failed: 0 };
}

/** Exported for queue diagnostics / re-eval hints. */
export function researchConsensusScoreFromRunDoc(data: Record<string, unknown>): number | null {
  if (typeof data.consensusScore === "number" && !Number.isNaN(data.consensusScore)) {
    return data.consensusScore;
  }
  const blobs = [data.consensusSummary, data.synthesisConsensusSummary, data.policyConsensusSummary];
  for (const p of blobs) {
    if (p && typeof p === "object") {
      const v = (p as { overallConsensusScore?: unknown }).overallConsensusScore;
      if (typeof v === "number" && !Number.isNaN(v)) return v;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvidenceQuality(value: unknown): value is "strong" | "mixed" | "weak" {
  return value === "strong" || value === "mixed" || value === "weak";
}

/**
 * Research evidence quality for System A — the CANONICAL synthesis rule only
 * (`deriveSynthesisEvidenceQuality`, the same rule behind the Team policy
 * summary). Source precedence:
 *
 * A. `policyConsensusSummary.evidenceQuality` — persisted by
 *    /api/synthesize-panel from the very `computeSynthesisConsensusScoring()`
 *    call that produced the synthesis (runs synthesized after this change).
 * B. Otherwise, re-derive it with the same function from the persisted facts it
 *    was computed from: `synthesisConsensusSummary.lowEvidenceClaims` /
 *    `.aggregateSupportRatio` and the persisted report's key-finding count.
 *    Every run System A ever evaluated stores these (all three were introduced
 *    together with System A), so this reproduces the canonical value exactly.
 * C. Otherwise `null` — nothing is guessed.
 *
 * Deliberately NOT consulted: a top-level `consensusSummary.evidenceQuality`
 * (no writer has ever persisted one on a research run, so its semantics are
 * unknown) and the former model-count / high-confidence fallback, which
 * classified the same synthesis differently from the Team policy summary.
 */
export function researchEvidenceQualityFromRunDoc(data: Record<string, unknown>): GovernanceInput["evidenceQuality"] {
  const policy = data.policyConsensusSummary;
  if (isPlainObject(policy) && isEvidenceQuality(policy.evidenceQuality)) return policy.evidenceQuality;

  const detail = data.synthesisConsensusSummary;
  const report = data.synthesizedStructuredReport;
  if (!isPlainObject(detail) || !isPlainObject(report) || !Array.isArray(report.keyFindings)) return null;
  const low = detail.lowEvidenceClaims;
  const support = detail.aggregateSupportRatio;
  if (typeof low !== "number" || !Number.isInteger(low) || low < 0) return null;
  if (typeof support !== "number" || !Number.isFinite(support) || support < 0 || support > 1) return null;
  // The real writer counts lowEvidenceClaims over the very keyFindings array it
  // persists as the report, so a larger count is an impossible document: reject it.
  if (low > report.keyFindings.length) return null;
  return deriveSynthesisEvidenceQuality({ lowEvidenceClaims: low, aggregateSupportRatio: support }, report.keyFindings.length);
}

function sourceBackedAndMissingFromReport(report: unknown): { sourceBacked: boolean; missingSourcesCount: number } {
  if (!report || typeof report !== "object") return { sourceBacked: false, missingSourcesCount: 0 };
  const kf = (report as { keyFindings?: unknown }).keyFindings;
  if (!Array.isArray(kf) || kf.length === 0) return { sourceBacked: false, missingSourcesCount: 0 };
  let anyRefs = false;
  let missing = 0;
  for (const f of kf) {
    const refs = (f as { evidenceRefs?: unknown })?.evidenceRefs;
    const n = Array.isArray(refs) ? refs.length : 0;
    if (n > 0) anyRefs = true;
    else missing += 1;
  }
  return {
    sourceBacked: anyRefs,
    missingSourcesCount: anyRefs ? missing : 0,
  };
}

/** Research run document as returned by Firestore. */
export function governanceInputFromResearchRun(data: Record<string, unknown>): GovernanceInput {
  const consensusScore = researchConsensusScoreFromRunDoc(data);
  const report = data.synthesizedStructuredReport;

  let sourceBacked: boolean;
  let missingSourcesCount: number;
  if (typeof data.sourceBacked === "boolean") {
    sourceBacked = data.sourceBacked;
    missingSourcesCount =
      typeof data.missingSourcesCount === "number" && !Number.isNaN(data.missingSourcesCount)
        ? data.missingSourcesCount
        : sourceBackedAndMissingFromReport(report).missingSourcesCount;
  } else {
    const sm = sourceBackedAndMissingFromReport(report);
    sourceBacked = sm.sourceBacked;
    missingSourcesCount = sm.missingSourcesCount;
  }

  return {
    scoreFamily: "research_synthesis_v1",
    consensusScore,
    evidenceQuality: researchEvidenceQualityFromRunDoc(data),
    sourceBacked,
    missingSourcesCount,
    modelHealth: modelHealthFromRunData(data),
    question: String(data.question ?? ""),
    runType: "research",
  };
}

function modelHealthFromVerificationArrays(data: Record<string, unknown>): GovernanceInput["modelHealth"] {
  for (const key of ["modelResults", "results", "panelResults"] as const) {
    const h = modelHealthFromPerModel(data[key]);
    if (h.ok + h.substituted + h.failed > 0) return h;
  }
  return { ok: 0, substituted: 0, failed: 0 };
}

/**
 * CLAIM verification document as stored in the `verifications` collection.
 * Video verifications live in `videoVerifications` and are never built here,
 * which is why the score family is fixed to the claim formula.
 */
export function governanceInputFromVerificationDoc(data: Record<string, unknown>): GovernanceInput {
  const verdict = data.verdict as GovernanceInput["verificationVerdict"];
  const eq = data.evidenceQuality as GovernanceInput["evidenceQuality"];
  return {
    scoreFamily: "claim_verification_v1",
    consensusScore: typeof data.consensusScore === "number" ? data.consensusScore : null,
    evidenceQuality: eq === "strong" || eq === "mixed" || eq === "weak" ? eq : null,
    sourceBacked: typeof data.sourceBacked === "boolean" ? data.sourceBacked : false,
    missingSourcesCount:
      typeof data.missingSourcesCount === "number" && !Number.isNaN(data.missingSourcesCount)
        ? data.missingSourcesCount
        : 0,
    modelHealth: modelHealthFromVerificationArrays(data),
    verificationVerdict: verdict ?? null,
    question: String(data.claim ?? ""),
    runType: "verification",
  };
}
