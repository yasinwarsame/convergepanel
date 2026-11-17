/**
 * Claim verification → governance characterisation for PR-1 (evidence doc 14 §8.2).
 *
 * PR-1 changes no governance policy and no verdict / score / confidence / evidence-quality computation. This spec runs
 * the real write-path functions (buildClaimModelEvidence → computeClaimVerdict → computeConsensusScoring → the
 * GovernanceInput shape built by app/api/verify-claim/route.ts → evaluateGovernance under the default policy) over
 * representative synthetic verdict mixes and pins the outcome:
 *  - WELL-FORMED mixes: every value is pinned to what origin/main cabbdbb produced (captured by running this same
 *    table on cabbdbb) — PR-1 must leave them byte-identical;
 *  - MALFORMED mixes (a model answered with a verdict outside the vocabulary, or none): the intended PR-1 change — the
 *    row is a `parse_error`, so it no longer dilutes the verdict, it lowers the score by the existing low-evidence
 *    penalty, and it counts in `modelHealth.failed` (the existing `reviewIfAnyModelFailed` rule). The cabbdbb values
 *    are recorded alongside as `before` for the PR body.
 * Synthetic connector results only; no provider, no Firestore.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { computeConsensusScoring } from "@/lib/verification/consensusScoring";
import { evaluateGovernance, getDefaultGovernancePolicy, type GovernanceInput } from "@/lib/governance/evaluateGovernance";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";
import type { ModelId, ModelResult } from "@/lib/types";

const SLOTS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const CLAIM = "The Eiffel Tower was completed in 1889.";

function connector(modelId: string, verdict: unknown): ModelResult {
  const body = { ...(verdict === undefined ? {} : { verdict }), confidence: "high", summary: "s", correctParts: [], incorrectParts: [], unverifiableParts: [], reasoning: "r" };
  return { modelId: modelId as ModelId, status: "ok", rawText: JSON.stringify(body), latencyMs: 1 } as unknown as ModelResult;
}

/** The same derivation as app/api/verify-claim/route.ts (verdict, scoring rows, governance input). */
function run(verdicts: unknown[]) {
  const evidence = buildClaimModelEvidence(verdicts.map((v, i) => connector(SLOTS[i], v)));
  const verdict = computeClaimVerdict(evidence.map((m) => ({ status: m.status, verdict: m.status === "ok" ? (m.verdict as ModelVerdict) : undefined })));
  const { consensusScore, confidenceLabel, summary } = computeConsensusScoring({
    mode: "verification",
    modelRows: evidence.map((m) => ({
      status: m.status as "ok" | "parse_error" | "failed",
      verdict: m.status === "ok" ? (m.verdict as ModelVerdict) : undefined,
      confidence: m.status === "ok" ? (m.confidence as "high" | "medium" | "low") : undefined,
    })),
    aggregateVerdict: verdict,
  });
  const input: GovernanceInput = {
    scoreFamily: "claim_verification_v1",
    consensusScore,
    evidenceQuality: summary.evidenceQuality,
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: evidence.filter((r) => r.status === "ok").length, substituted: 0, failed: evidence.filter((r) => r.status !== "ok").length },
    question: CLAIM,
    runType: "verification",
    verificationVerdict: verdict,
  };
  const g = evaluateGovernance(input, getDefaultGovernancePolicy());
  return {
    rows: evidence.map((m) => `${m.status}:${m.verdict}`).join(","),
    verdict,
    consensusScore,
    confidenceLabel,
    evidenceQuality: summary.evidenceQuality,
    failed: input.modelHealth.failed,
    governance: g.status,
    reasons: g.reasons,
  };
}

const A = "accurate", P = "partially_accurate", I = "inaccurate", U = "unverifiable";

const WELL_FORMED: Record<string, unknown[]> = {
  "5A": [A, A, A, A, A],
  "4A/1I": [A, A, A, A, I],
  "3A/2I": [A, A, A, I, I],
  "2A/1P/2I": [A, A, P, I, I],
  "0A/2P/3I": [P, P, I, I, I],
  "3I (unanimous inaccurate)": [I, I, I],
  "2I/1U": [I, I, U],
  "5U": [U, U, U, U, U],
  "1A (single model)": [A],
  "1I (single model)": [I],
};

const MALFORMED: Record<string, unknown[]> = {
  "formatting variant 'Partially-Accurate' x2 + 3A": ["Partially-Accurate", " partially accurate ", A, A, A],
  "3A + 2 unrecognised": [A, A, A, "correct-ish", "n/a"],
  "2I + 1 unrecognised": [I, I, "mostly false"],
  "4A + 1 missing verdict": [A, A, A, A, undefined],
  "1A + truncated-looking 'accur'": [A, "accur"],
};

// Captured on origin/main cabbdbb (same table, same functions). PR-1 must reproduce every WELL-FORMED row exactly.
const CABBDBB: Record<string, ReturnType<typeof run>> = {
  "5A": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,ok:accurate,ok:accurate",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "strong",
    "failed": 0,
    "governance": "approved",
    "reasons": []
  },
  "4A/1I": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,ok:accurate,ok:inaccurate",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "strong",
    "failed": 0,
    "governance": "approved",
    "reasons": []
  },
  "3A/2I": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,ok:inaccurate,ok:inaccurate",
    "verdict": "disputed",
    "consensusScore": 67,
    "confidenceLabel": "Medium",
    "evidenceQuality": "mixed",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Claim verification verdict: disputed",
      "Consensus 67 below 70"
    ]
  },
  "2A/1P/2I": {
    "rows": "ok:accurate,ok:accurate,ok:partially_accurate,ok:inaccurate,ok:inaccurate",
    "verdict": "disputed",
    "consensusScore": 63,
    "confidenceLabel": "Medium",
    "evidenceQuality": "mixed",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Claim verification verdict: disputed",
      "Consensus 63 below 70"
    ]
  },
  "0A/2P/3I": {
    "rows": "ok:partially_accurate,ok:partially_accurate,ok:inaccurate,ok:inaccurate,ok:inaccurate",
    "verdict": "partially_true",
    "consensusScore": 74,
    "confidenceLabel": "High",
    "evidenceQuality": "weak",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "Claim verification verdict: partially_true"
    ]
  },
  "3I (unanimous inaccurate)": {
    "rows": "ok:inaccurate,ok:inaccurate,ok:inaccurate",
    "verdict": "disputed",
    "consensusScore": 52,
    "confidenceLabel": "Medium",
    "evidenceQuality": "weak",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "Claim verification verdict: disputed",
      "Consensus 52 below 70"
    ]
  },
  "2I/1U": {
    "rows": "ok:inaccurate,ok:inaccurate,ok:unverifiable",
    "verdict": "disputed",
    "consensusScore": 52,
    "confidenceLabel": "Medium",
    "evidenceQuality": "weak",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "Claim verification verdict: disputed",
      "Consensus 52 below 70"
    ]
  },
  "5U": {
    "rows": "ok:unverifiable,ok:unverifiable,ok:unverifiable,ok:unverifiable,ok:unverifiable",
    "verdict": "unverifiable",
    "consensusScore": 45,
    "confidenceLabel": "Medium",
    "evidenceQuality": "weak",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "Claim verification verdict: unverifiable",
      "Consensus 45 below 70"
    ]
  },
  "1A (single model)": {
    "rows": "ok:accurate",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "strong",
    "failed": 0,
    "governance": "approved",
    "reasons": []
  },
  "1I (single model)": {
    "rows": "ok:inaccurate",
    "verdict": "disputed",
    "consensusScore": 52,
    "confidenceLabel": "Medium",
    "evidenceQuality": "weak",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "Claim verification verdict: disputed",
      "Consensus 52 below 70"
    ]
  }
};

describe("well-formed verdict mixes: governance input and decision unchanged by PR-1", () => {
  it.each(Object.keys(WELL_FORMED))("%s", (k) => {
    expect(run(WELL_FORMED[k])).toEqual(CABBDBB[k]);
  });
});

// The values PR-1 produces for malformed / formatting-variant output (intended change).
const PR1_MALFORMED: Record<string, ReturnType<typeof run>> = {
  "formatting variant 'Partially-Accurate' x2 + 3A": {
    "rows": "ok:partially_accurate,ok:partially_accurate,ok:accurate,ok:accurate,ok:accurate",
    "verdict": "partially_true",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "strong",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Claim verification verdict: partially_true"
    ]
  },
  "3A + 2 unrecognised": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,parse_error:parse_error,parse_error:parse_error",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "weak",
    "failed": 2,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "2 model(s) failed"
    ]
  },
  "2I + 1 unrecognised": {
    "rows": "ok:inaccurate,ok:inaccurate,parse_error:parse_error",
    "verdict": "disputed",
    "consensusScore": 40,
    "confidenceLabel": "Low",
    "evidenceQuality": "weak",
    "failed": 1,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "1 model(s) failed",
      "Claim verification verdict: disputed",
      "Consensus 40 below 70"
    ]
  },
  "4A + 1 missing verdict": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,ok:accurate,parse_error:parse_error",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "mixed",
    "failed": 1,
    "governance": "needs_review",
    "reasons": [
      "1 model(s) failed"
    ]
  },
  "1A + truncated-looking 'accur'": {
    "rows": "ok:accurate,parse_error:parse_error",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "Medium",
    "evidenceQuality": "weak",
    "failed": 1,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "1 model(s) failed"
    ]
  }
};

// The same rows on origin/main cabbdbb (recorded for the PR body's before/after; asserted to DIFFER, so this
// table cannot silently become a no-op).
const CABBDBB_MALFORMED: Record<string, ReturnType<typeof run>> = {
  "formatting variant 'Partially-Accurate' x2 + 3A": {
    "rows": "ok:unverifiable,ok:unverifiable,ok:accurate,ok:accurate,ok:accurate",
    "verdict": "partially_true",
    "consensusScore": 92,
    "confidenceLabel": "High",
    "evidenceQuality": "mixed",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Claim verification verdict: partially_true"
    ]
  },
  "3A + 2 unrecognised": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,ok:unverifiable,ok:unverifiable",
    "verdict": "partially_true",
    "consensusScore": 92,
    "confidenceLabel": "High",
    "evidenceQuality": "mixed",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Claim verification verdict: partially_true"
    ]
  },
  "2I + 1 unrecognised": {
    "rows": "ok:inaccurate,ok:inaccurate,ok:unverifiable",
    "verdict": "disputed",
    "consensusScore": 52,
    "confidenceLabel": "Medium",
    "evidenceQuality": "weak",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Evidence quality is weak",
      "Claim verification verdict: disputed",
      "Consensus 52 below 70"
    ]
  },
  "4A + 1 missing verdict": {
    "rows": "ok:accurate,ok:accurate,ok:accurate,ok:accurate,ok:unverifiable",
    "verdict": "confirmed",
    "consensusScore": 100,
    "confidenceLabel": "High",
    "evidenceQuality": "strong",
    "failed": 0,
    "governance": "approved",
    "reasons": []
  },
  "1A + truncated-looking 'accur'": {
    "rows": "ok:accurate,ok:unverifiable",
    "verdict": "unverifiable",
    "consensusScore": 68,
    "confidenceLabel": "Medium",
    "evidenceQuality": "mixed",
    "failed": 0,
    "governance": "needs_review",
    "reasons": [
      "Claim verification verdict: unverifiable",
      "Consensus 68 below 70"
    ]
  }
};

describe("malformed verdict mixes: the intended PR-1 change (parse_error rows)", () => {
  it.each(Object.keys(MALFORMED))("%s", (k) => {
    expect(run(MALFORMED[k])).toEqual(PR1_MALFORMED[k]);
    expect(run(MALFORMED[k])).not.toEqual(CABBDBB_MALFORMED[k]);
  });

  it("every table covers the same keys", () => {
    expect(Object.keys(CABBDBB).sort()).toEqual(Object.keys(WELL_FORMED).sort());
    expect(Object.keys(PR1_MALFORMED).sort()).toEqual(Object.keys(MALFORMED).sort());
    expect(Object.keys(CABBDBB_MALFORMED).sort()).toEqual(Object.keys(MALFORMED).sort());
  });
});
