/**
 * Build GovernanceInput from stored run / verification documents (queue backfill + evaluation).
 */

import type { GovernanceInput } from "./evaluateGovernance";

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

function researchConsensusScore(data: Record<string, unknown>): number | null {
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

function evidenceQualityFromSynthesisSummary(sum: Record<string, unknown> | undefined): GovernanceInput["evidenceQuality"] {
  if (!sum) return null;
  const low = Number(sum.lowEvidenceClaims ?? 0);
  const high = Number(sum.highConfidenceClaims ?? 0);
  const modelCount = Math.max(1, Number(sum.modelCount ?? 1));
  if (low >= modelCount * 0.5) return "weak";
  if (low === 0 && high > 0) return "strong";
  return "mixed";
}

function researchEvidenceQuality(
  data: Record<string, unknown>,
  synthesisSum: Record<string, unknown> | undefined
): GovernanceInput["evidenceQuality"] {
  const blobs = [data.consensusSummary, data.synthesisConsensusSummary, data.policyConsensusSummary];
  for (const p of blobs) {
    if (p && typeof p === "object") {
      const eq = (p as { evidenceQuality?: unknown }).evidenceQuality;
      if (eq === "strong" || eq === "mixed" || eq === "weak") return eq;
    }
  }
  return evidenceQualityFromSynthesisSummary(synthesisSum);
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
  const synthesisSum = data.synthesisConsensusSummary as Record<string, unknown> | undefined;
  const consensusScore = researchConsensusScore(data);
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
    consensusScore,
    evidenceQuality: researchEvidenceQuality(data, synthesisSum),
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

/** Verification document as stored in `verifications` collection. */
export function governanceInputFromVerificationDoc(data: Record<string, unknown>): GovernanceInput {
  const verdict = data.verdict as GovernanceInput["verificationVerdict"];
  const eq = data.evidenceQuality as GovernanceInput["evidenceQuality"];
  return {
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
