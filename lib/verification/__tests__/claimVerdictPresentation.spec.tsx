/**
 * Claim-verification presentation correctness — PR-1 regression spec (evidence doc 14 W1, 2026-11-17; moved unchanged
 * from the local proposal branch proposal/claim-verdict-correctness @5d672d9, claimVerdictPresentation.proposal.spec.tsx).
 * W1 = presentation driven from the per-model counts, with NO vocabulary change and NO stored-data change.
 *
 * The fixtures model what is ALREADY STORED for a unanimous-inaccurate run: `verdict: "disputed"` (the
 * claimVerdict.ts fall-through), score 52 / Medium / weak, and per-model rows that each say "inaccurate". The reader
 * must be told what the stored per-model rows say — including for historical records — without rewriting the stored
 * label. [CONTROL] tests pin behaviour that must not change. Synthetic data only; no Firestore, no provider.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("server-only", () => ({}));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "pro", governanceAssignedReviewerEmail: null }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ClaimVerificationResultView, { buildClaimVerdictClipboardText } from "@/components/verification/ClaimVerificationResultView";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";

type Row = Record<string, unknown>;
const OWN_PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", gemini: "google", perplexity: "perplexity" };
const row = (modelId: string, verdict: string, incorrect: string[] = [], correct: string[] = []): Row => ({
  modelId,
  status: "ok",
  verdict,
  confidence: "high",
  summary: `${modelId} says ${verdict}`,
  correctParts: correct,
  incorrectParts: incorrect,
  unverifiableParts: [],
  provider: OWN_PROVIDER[modelId],
});

function storedDoc(modelResults: Row[], stored: { verdict: string; consensusScore: number; confidenceLabel: string; evidenceQuality: string }): ClaimVerificationFirestoreDoc {
  return {
    userId: "u",
    claim: "The Eiffel Tower was completed in 1901.",
    type: "claim_verification",
    ...stored,
    supportRatio: 0,
    modelResults,
    auditBundle: {
      version: "1",
      kind: "claim_verification",
      claimCharCount: 40,
      modelCount: modelResults.length,
      ...stored,
      perModel: modelResults.map((m) => ({ modelId: m.modelId, pipelineStatus: m.status, verdictLabel: m.verdict, confidence: "high", summaryLength: 5, counts: { correct: 0, incorrect: 1, unverifiable: 0 } })),
      generatedAt: "2026-11-01T00:00:00.000Z",
    },
    selectedModels: modelResults.map((m) => m.modelId as string),
    timestamp: { seconds: 1_800_000_000, nanoseconds: 0 },
  } as unknown as ClaimVerificationFirestoreDoc;
}

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

// What main stores for 3 x inaccurate (doc 08 §2: fall-through disputed, 52, Medium, weak).
const UNANIMOUS_INACCURATE = storedDoc(
  [
    row("chatgpt", "inaccurate", ["The tower was finished in 1889, not 1901 as the claim states"]),
    row("claude", "inaccurate", ["Construction concluded during March of eighteen eighty-nine"]),
    row("grok", "inaccurate", ["Completion date given is twelve years too late"]),
  ],
  { verdict: "disputed", consensusScore: 52, confidenceLabel: "Medium", evidenceQuality: "weak" }
);

// A genuine split that main also stores as disputed (rule :30-36).
const GENUINE_SPLIT = storedDoc(
  [row("chatgpt", "accurate", [], ["Completed in 1889"]), row("claude", "inaccurate", ["The year is wrong"]), row("grok", "inaccurate", ["Opened in a different year"])],
  { verdict: "disputed", consensusScore: 47, confidenceLabel: "Medium", evidenceQuality: "weak" }
);

// 4 accurate + 1 inaccurate (confirmed, 100, High on main).
const CONFIRMED_WITH_DISSENT = storedDoc(
  [row("chatgpt", "accurate"), row("claude", "accurate"), row("grok", "accurate"), row("gemini", "accurate"), row("perplexity", "inaccurate", ["The completion year is incorrect"])],
  { verdict: "confirmed", consensusScore: 100, confidenceLabel: "High", evidenceQuality: "strong" }
);

describe("D-2 W1 — a stored 'disputed' label over a unanimous-inaccurate panel", () => {
  const payload = mapStoredVerificationToClientPayload(UNANIMOUS_INACCURATE, "vcl-ui");

  it("[CONTROL] the fixture is an independent 3-model panel and the stored label is untouched", () => {
    expect(payload.modelIndependence).toBe("independent");
    expect(payload.verdict).toBe("disputed");
  });

  it("result banner does not say the models disagree", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: payload }));
    expect(out).not.toContain("Models disagree on this claim");
  });

  it("result banner states the per-model distribution (3 of 3 rated it inaccurate)", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: payload }));
    expect(out).toMatch(/3\s*(\/|of)\s*3[^<]*inaccurate/i);
  });

  it("disagreement panel lists no 'Conflicting assessments' between models that all said inaccurate", () => {
    // The reload mapper recomputes the digest (mapStoredVerificationToClientPayload.ts:44-50), so a digest fix is
    // retroactive for history.
    expect(payload.whereModelsDisagree).toEqual([]);
  });

  it("memo summary does not say the models diverged", () => {
    const memo = generateVerificationMemo({
      type: "claim",
      claim: payload.claim,
      verdict: payload.verdict,
      consensusScore: payload.consensusScore,
      confidenceLabel: payload.confidenceLabel,
      evidenceQuality: payload.evidenceQuality,
      modelEvidence: payload.modelEvidence,
      agreementPoints: payload.whereModelsAgree,
      disagreementPoints: payload.whereModelsDisagree.map((d) => d.point),
      claimModelIndependence: "independent",
      claimExecution: { independentModels: 3, answeredSlots: 3 },
    } as never);
    expect(memo).not.toContain("Models diverged on important aspects of this claim");
    expect(memo).not.toContain("WHERE MODELS DISAGREE");
  });

  it("copied verdict text states the distribution, not a bare 'disputed'", () => {
    const text = buildClaimVerdictClipboardText(payload);
    expect(text).not.toMatch(/^Aggregate verdict: disputed$/m);
  });
});

describe("[CONTROL] D-2 W1 — a genuine split keeps the disagreement wording", () => {
  const payload = mapStoredVerificationToClientPayload(GENUINE_SPLIT, "vcl-gs");
  it("banner still says the models disagree", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: payload }));
    expect(out).toContain("Models disagree on this claim");
  });
});

describe("D-4 — 'confirmed' over a panel with a dissenting model", () => {
  const payload = mapStoredVerificationToClientPayload(CONFIRMED_WITH_DISSENT, "vcl-cd");

  it("[CONTROL] the result banner already shows 4/5 (the dissent is visible there)", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: payload }));
    expect(out).toContain("supported by 4/5 models");
  });

  it("the Team claim list summary carries the per-model verdict counts (counted from auditBundle.perModel)", () => {
    // Today the Team list row shows only "Confirmed" + "100/100 consensus" + "High": the dissent is invisible there.
    const summary = toTeamClaimVerificationSummary({
      verificationId: "vcl-cd",
      data: { ...(CONFIRMED_WITH_DISSENT as unknown as Row), workspaceId: "w" },
      workspaceId: "w",
      projectId: null,
      project: null,
    });
    expect(summary).not.toBeNull();
    expect((summary as unknown as Row).modelVerdicts).toEqual({ accurate: 4, partially_accurate: 0, inaccurate: 1, unverifiable: 0, usable: 5 });
  });
});
