/**
 * Track C-b (Order 32) — verification-family attribution through the ONE shared presentation gate
 * (lib/panel/executionIdentity.ts). Presentation only: stored records, decisions, the verification gate, certainty and
 * routing are untouched.
 *
 * Protected behaviour asserted here, on the real code (server mappers, real components rendered with react-dom/server,
 * the real memo generator, the real Team list parsers):
 *  1. only genuinely successful executing models with verified identity count toward verified independent agreement;
 *  2. failed / timed-out / parse_error slots never count as successful supporters;
 *  3. substituted responses never inherit the requested model's independence; a substitute model in several slots
 *     counts once;
 *  4. providerless video records stay independence-unverified on every video surface (PQ-2 (a) strict);
 *  5. historical / legacy records with unknown provider identity stay explicitly unverified;
 *  6. genuine independent agreement (≥ 2 verified independent successful models) stays visible.
 * Plus CB-21 (O14 render correction from `agreementSummary`, PQ-3) and CB-22 (no silent cap on qualified signals).
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("server-only", () => ({}));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "pro", governanceAssignedReviewerEmail: null }) }));
const mockedGenerateMemo = jest.fn((..._a: unknown[]) => "MEMO");
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return { ...actual, generateVerificationMemo: (...a: unknown[]) => mockedGenerateMemo(...a), downloadTextFile: jest.fn() };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import {
  claimIdentityRow,
  claimPresentedIndependence,
  claimRowsExecutionIdentity,
  storedVerificationConsensusIndependence,
  storedVerificationExecutionIdentity,
  storedVerificationIndependentAnswerCount,
  storedVideoConsensusIndependence,
} from "@/lib/panel/storedVerificationIndependence";
import ClaimVerificationResultView, {
  buildClaimVerdictClipboardText,
  ClaimVerificationAuditTrailDetails,
  claimSlotCountsNote,
  claimViewIndependence,
} from "@/components/verification/ClaimVerificationResultView";
import ClaimVerificationResult from "@/components/ClaimVerificationResult";
import VideoVerificationResultView, {
  buildVideoVerdictClipboardText,
  VideoVerificationAuditTrailDetails,
  videoConsensusView,
} from "@/components/verification/VideoVerificationResultView";
import VideoVerificationResult from "@/components/VideoVerificationResult";
import { VerificationActions } from "@/components/VerificationActions";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import { toTeamVideoVerificationSummary } from "@/lib/workspaces/teamVideoVerificationSummary";
import { parseTeamVideoListPageResponse } from "@/hooks/useTeamVideoVerificationList";
import { TeamVideoListRow } from "@/components/workspace/videos/TeamVideoListRow";
import { buildQueueVerificationAgreement } from "@/lib/governance/queueVerificationAgreement";
import { queueAgreementTally, queueRenderedDisagreementPoints, queueVerificationAgreementView } from "@/components/governance/GovernanceDashboard";
import {
  CLAIM_COVERAGE_UNVERIFIED_TEXT,
  CLAIM_NOT_INDEPENDENT_AGREE_HEADING,
  CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING,
  CLAIM_UNVERIFIED_BANNER_SUBTITLE,
  CONSENSUS_WITHHELD_TEXT,
} from "@/lib/verification/claimConsensusPresentation";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";

const { generateVerificationMemo: realMemo } = jest.requireActual("@/lib/verification/generateMemo");

const WITHHELD = CONSENSUS_WITHHELD_TEXT.independence_unverified;
const NO_CONSENSUS = CONSENSUS_WITHHELD_TEXT.insufficient_independent_models;
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", gemini: "google", perplexity: "perplexity" };
const FIVE = ["chatgpt", "claude", "grok", "gemini", "perplexity"];

type Row = Record<string, unknown>;
/** A stored claim row; `provider: true` records the slot's own provider (absent on every stored own-provider row, m-B). */
function crow(modelId: string, status: string, verdict = "accurate", opts: { provider?: boolean | string; substituted?: boolean } = {}): Row {
  const provider = opts.provider === true ? OWN[modelId] : typeof opts.provider === "string" ? opts.provider : undefined;
  return {
    modelId,
    status,
    verdict: status === "ok" ? verdict : status,
    confidence: "high",
    summary: `${modelId} summary`,
    correctParts: [],
    incorrectParts: [],
    unverifiableParts: [],
    ...(opts.substituted ? { substituted: true } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

function claimDoc(modelResults: Row[] | undefined, selectedModels?: string[], extra: Row = {}): ClaimVerificationFirestoreDoc {
  return {
    userId: "u",
    claim: "Water boils at 100 C at sea level.",
    type: "claim_verification",
    verdict: "confirmed",
    consensusScore: 92,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 1,
    ...(modelResults ? { modelResults } : {}),
    auditBundle: {
      version: "1",
      kind: "claim_verification",
      claimCharCount: 30,
      modelCount: modelResults?.length ?? 0,
      verdict: "confirmed",
      consensusScore: 92,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      perModel: (modelResults ?? []).map((m) => ({ modelId: m.modelId, pipelineStatus: m.status, verdictLabel: m.status === "ok" ? m.verdict : null, confidence: "high", summaryLength: 5, counts: { correct: 0, incorrect: 0, unverifiable: 0 } })),
      generatedAt: "not-a-date",
    },
    ...(selectedModels ? { selectedModels } : {}),
    timestamp: { seconds: 1_800_000_000, nanoseconds: 0 },
    ...extra,
  } as unknown as ClaimVerificationFirestoreDoc;
}

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const DS = { substituted: true, provider: "deepseek" } as const;

// ─── adversarial provenance fixtures (claims) ─────────────────────────────────────────────────────────────────────

const CLAIM_FIXTURES: Array<{ name: string; rows: Row[] | undefined; selected?: string[]; independence: "independent" | "insufficient" | "unverified"; k: number | null; m: number }> = [
  { name: "genuine 5/5 (every slot its own recorded executing model)", rows: FIVE.map((s) => crow(s, "ok", "accurate", { provider: true })), selected: FIVE, independence: "independent", k: 5, m: 5 },
  {
    name: "genuine 2+3 (DeepSeek substituted three slots, two own-provider answers)",
    rows: [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true }), crow("grok", "ok", "accurate", { ...DS }), crow("gemini", "ok", "accurate", { ...DS }), crow("perplexity", "ok", "accurate", { ...DS })],
    selected: FIVE,
    independence: "independent",
    k: 3,
    m: 5,
  },
  { name: "provider-less ok rows (every stored own-provider claim, m-B)", rows: [crow("chatgpt", "ok"), crow("claude", "ok"), crow("grok", "ok")], selected: ["chatgpt", "claude", "grok"], independence: "unverified", k: null, m: 3 },
  { name: "one substitute in two slots (recorded provider)", rows: [crow("chatgpt", "ok", "accurate", { ...DS }), crow("claude", "ok", "accurate", { ...DS })], selected: ["chatgpt", "claude"], independence: "insufficient", k: 1, m: 2 },
  { name: "a substitute without a recorded provider in two slots", rows: [crow("chatgpt", "ok", "accurate", { substituted: true }), crow("claude", "ok", "accurate", { substituted: true })], selected: ["chatgpt", "claude"], independence: "unverified", k: null, m: 2 },
  { name: "all slots failed / parse_error (all-timeout class)", rows: [crow("chatgpt", "failed"), crow("claude", "parse_error"), crow("grok", "failed")], selected: ["chatgpt", "claude", "grok"], independence: "unverified", k: null, m: 0 },
  {
    name: "one answer with stored count 5 (one recorded answer, four failed)",
    rows: [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "failed"), crow("grok", "failed"), crow("gemini", "parse_error"), crow("perplexity", "failed")],
    selected: FIVE,
    independence: "insufficient",
    k: 1,
    m: 1,
  },
  { name: "one provider-less answer with stored count 5", rows: [crow("chatgpt", "ok"), crow("claude", "failed"), crow("grok", "failed"), crow("gemini", "failed"), crow("perplexity", "failed")], selected: FIVE, independence: "unverified", k: null, m: 1 },
  { name: "unknown / legacy status literal (a recorded provider does not rescue it)", rows: [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "timeout", "accurate", { provider: true })], selected: ["chatgpt", "claude"], independence: "unverified", k: null, m: 0 },
  { name: "legacy record without rows", rows: undefined, independence: "unverified", k: null, m: 0 },
  { name: "provider recorded as 'unknown'", rows: [crow("chatgpt", "ok", "accurate", { provider: "unknown" }), crow("claude", "ok", "accurate", { provider: true })], independence: "unverified", k: null, m: 2 },
];

describe("CB-01: the stored claim helper is the shared gate", () => {
  it.each(CLAIM_FIXTURES)("$name", ({ rows, selected, independence, k }) => {
    const doc = claimDoc(rows, selected) as unknown as Record<string, unknown>;
    const before = JSON.stringify(doc);
    expect(storedVerificationConsensusIndependence(doc)).toBe(independence);
    expect(storedVerificationIndependentAnswerCount(doc)).toBe(k);
    const identity = storedVerificationExecutionIdentity(doc);
    expect([identity.verified, identity.independentModels]).toEqual([k !== null, k]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("the row adapter maps recorded facts only (failed / parse_error never answer; substitutes keyed by their own provider)", () => {
    expect(claimIdentityRow(crow("chatgpt", "ok"))).toEqual({ modelId: "chatgpt", status: "ok" });
    expect(claimIdentityRow(crow("chatgpt", "ok", "accurate", { provider: true }))).toEqual({ modelId: "chatgpt", status: "ok", provider: "openai" });
    expect(claimIdentityRow(crow("claude", "ok", "accurate", { ...DS }))).toEqual({ modelId: "claude", status: "substituted", provider: "deepseek" });
    expect(claimIdentityRow(crow("grok", "parse_error")).status).toBe("failed");
    expect(claimIdentityRow(crow("grok", "failed")).status).toBe("failed");
    // Not a stored claim status: no status is carried, so the gate fails closed (never a known failure).
    expect(claimIdentityRow(crow("grok", "timeout", "accurate", { provider: true }))).toEqual({ modelId: "grok", provider: "xai" });
    expect(claimIdentityRow({ modelId: "grok", status: "ok " })).toEqual({ modelId: "grok" });
    expect(claimRowsExecutionIdentity([crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "timeout")]).verified).toBe(false);
    expect(claimIdentityRow(null)).toEqual({});
  });

  it("a selected model without a row stays unverified even when every row is recorded", () => {
    const doc = claimDoc([crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true })], ["chatgpt", "claude", "grok"]);
    expect(storedVerificationConsensusIndependence(doc as never)).toBe("unverified");
  });

  it("a substitute model in several slots counts once, and never as the requested model", () => {
    const rows = [crow("chatgpt", "ok", "accurate", { ...DS }), crow("claude", "ok", "accurate", { ...DS }), crow("grok", "ok", "accurate", { ...DS })];
    const identity = claimRowsExecutionIdentity(rows);
    expect([identity.verified, identity.independentModels, identity.answeredSlots, identity.kind]).toEqual([true, 1, 3, "FC"]);
    expect(new Set(Object.values(identity.slotKeys))).toEqual(new Set(["substitute:deepseek"]));
  });

  it("the client confirms the server's 'independent' through the gate and never upgrades a value", () => {
    const providerless = [crow("chatgpt", "ok"), crow("claude", "ok")];
    const recorded = [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true })];
    expect(claimPresentedIndependence("independent", providerless)).toBe("unverified");
    expect(claimPresentedIndependence("independent", recorded)).toBe("independent");
    expect(claimPresentedIndependence("independent", [crow("chatgpt", "ok", "accurate", { ...DS }), crow("claude", "ok", "accurate", { ...DS })])).toBe("insufficient");
    expect(claimPresentedIndependence("insufficient", recorded)).toBe("insufficient");
    expect(claimPresentedIndependence("unverified", recorded)).toBe("unverified");
    expect(claimPresentedIndependence(undefined, recorded)).toBe("unverified");
    expect(claimPresentedIndependence("bogus", recorded)).toBe("unverified");
  });
});

// ─── claim surfaces (CB-04 .. CB-11) ──────────────────────────────────────────────────────────────────────────────

function payloadOf(rows: Row[] | undefined, selected?: string[], extra: Row = {}): ClaimVerificationClientPayload {
  return { ...mapStoredVerificationToClientPayload(claimDoc(rows, selected), "vcl-cb"), whereModelsAgree: [], whereModelsDisagree: [], ...extra } as ClaimVerificationClientPayload;
}

async function exportedMemoInput(payload: ClaimVerificationClientPayload): Promise<Record<string, unknown>> {
  mockedGenerateMemo.mockClear();
  let tr!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tr = TestRenderer.create(createElement(ClaimVerificationResult, { data: payload, onVerifyAnother: () => {} }));
  });
  await act(async () => {
    tr.root.findByType(VerificationActions).props.onExportMemo();
  });
  tr.unmount();
  expect(mockedGenerateMemo).toHaveBeenCalledTimes(1);
  return mockedGenerateMemo.mock.calls[0][0] as Record<string, unknown>;
}

const memoOf = (input: Record<string, unknown>) => (realMemo(input) as string).split("\n").filter((l) => !l.startsWith("Generated:")).join("\n");

describe("CB-04: the saved claim payload carries each row's recorded execution facts, only when recorded", () => {
  it("provider / substituted pass through as stored; nothing is added to a row that records none", () => {
    const p = payloadOf([crow("chatgpt", "ok"), crow("claude", "ok", "accurate", { ...DS }), crow("grok", "ok", "accurate", { provider: true })]);
    expect(p.modelEvidence.map((m) => [m.modelId, "provider" in m ? m.provider : null, "substituted" in m ? m.substituted : null])).toEqual([
      ["chatgpt", null, null],
      ["claude", "deepseek", true],
      ["grok", "xai", null],
    ]);
    // Slot counts stay slot counts.
    expect([p.usableModelCount, p.aggregateSummary.totalModels]).toEqual([3, 3]);
  });
});

describe("CB-06 / CB-07 / CB-09: the claim result view", () => {
  it("genuine 5/5: the established banner, score and model-count copy (no false negative)", () => {
    const p = payloadOf(FIVE.map((s) => crow(s, "ok", "accurate", { provider: true })), FIVE);
    expect(p.modelIndependence).toBe("independent");
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).toContain("This claim is supported by 5/5 models");
    expect(out).toContain(">92</p>");
    expect(out).toContain("5 models (ChatGPT, Claude, Grok, Gemini, and Perplexity) rated it as accurate.");
    expect(out).not.toContain("panel slot");
    expect(html(createElement(ClaimVerificationAuditTrailDetails, { data: p }))).toContain("Models (5)");
  });

  it("genuine 2+3: the banner counts independent executing models (a substitute in three slots counts once)", () => {
    const p = payloadOf(CLAIM_FIXTURES[1].rows, FIVE);
    expect(p.modelIndependence).toBe("independent");
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).toContain("This claim is supported by 3/3 models");
    expect(out).not.toContain("supported by 5/5");
    // The fallback counts are panel slots, with what the gate establishes about them.
    expect(out).toContain("5 panel slots (ChatGPT, Claude, Grok, Gemini, and Perplexity) rated it as accurate.");
    expect(out).toContain("These counts are of panel slots (3 independent executing models answered 5 panel slots), not of agreeing models.");
    const audit = html(createElement(ClaimVerificationAuditTrailDetails, { data: p }));
    expect(audit).toContain("Panel slots (5)");
    expect(audit).not.toContain("Models (5)");
  });

  it("failed slots never count as supporters: 3 answers + 2 failed → 3/3, the failed slots are stated as not verifying", () => {
    const rows = [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true }), crow("grok", "ok", "accurate", { provider: true }), crow("gemini", "failed"), crow("perplexity", "parse_error")];
    const p = payloadOf(rows, FIVE);
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).toContain("This claim is supported by 3/3 models");
    expect(out).not.toMatch(/supported by \d+\/5/);
    expect(out).toContain("2 of 5 models could not verify this claim.");
    expect(out).toContain("3 models (ChatGPT, Claude, and Grok) rated it as accurate.");
  });

  it("a split IND claim: supporters are counted among independent models only", () => {
    const rows = [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "inaccurate", { provider: true }), crow("grok", "ok", "accurate", { provider: true })];
    const p = { ...payloadOf(rows, ["chatgpt", "claude", "grok"]), verdict: "confirmed" as const };
    expect(html(createElement(ClaimVerificationResultView, { data: p }))).toContain("This claim is supported by 2/3 models");
  });

  it.each(CLAIM_FIXTURES.filter((f) => f.independence === "unverified" && f.rows))("unverified ($name): no score, no model counts, the unverified wording family", ({ rows, selected }) => {
    const p = payloadOf(rows, selected);
    expect(p.modelIndependence).toBe("unverified");
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).not.toContain(">92</p>");
    expect(out).not.toMatch(/supported by \d+\/\d+ models/);
    expect(out).toContain(WITHHELD);
    expect(out).toContain(CLAIM_COVERAGE_UNVERIFIED_TEXT);
    expect(out).toContain(CLAIM_UNVERIFIED_BANNER_SUBTITLE);
    expect(out).not.toMatch(/\d+ models? \(/);
    expect(out).toContain("model independence unverified), not of agreeing models.");
    const audit = html(createElement(ClaimVerificationAuditTrailDetails, { data: p }));
    expect(audit).toContain(WITHHELD);
    expect(audit).not.toMatch(/>Models \(/);
    const clip = buildClaimVerdictClipboardText(p);
    expect(clip).toContain(`Consensus score: ${WITHHELD}`);
    expect(clip).not.toContain("Consensus score: 92");
  });

  it("server 'independent' with rows that do not verify (a payload cached before the rows carried providers) is presented unverified", () => {
    const p = { ...payloadOf([crow("chatgpt", "ok"), crow("claude", "ok")], ["chatgpt", "claude"]), modelIndependence: "independent" as const };
    expect(claimViewIndependence(p).independence).toBe("unverified");
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).toContain(WITHHELD);
    expect(out).not.toMatch(/supported by \d+\/\d+ models/);
    expect(buildClaimVerdictClipboardText(p)).toContain(`Consensus score: ${WITHHELD}`);
    expect(html(createElement(ClaimVerificationAuditTrailDetails, { data: p }))).toContain(WITHHELD);
  });

  it("insufficient (one recorded answer of five): the one-model wording, counts as panel slots", () => {
    const p = payloadOf(CLAIM_FIXTURES[6].rows, FIVE);
    expect(p.modelIndependence).toBe("insufficient");
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).toContain(NO_CONSENSUS);
    expect(out).toContain("4 of 5 panel slots could not verify this claim.");
    expect(out).toContain("1 panel slot (ChatGPT) rated it as accurate.");
    expect(out).toContain("These counts are of panel slots (1 independent executing model answered 1 panel slot), not of agreeing models.");
  });

  it("the slot note never states a K for an unverified claim, even when the client rows verify", () => {
    const verified = claimRowsExecutionIdentity([crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true })]);
    expect(verified.verified).toBe(true);
    expect(claimSlotCountsNote({ independence: "unverified", identity: verified })).toBe("These counts are of panel slots (model independence unverified), not of agreeing models.");
  });

  it("the slot note states 'fewer than two' when the server says insufficient but the client rows do not verify", () => {
    expect(claimSlotCountsNote({ independence: "insufficient", identity: claimRowsExecutionIdentity([crow("chatgpt", "ok")]) })).toBe(
      "These counts are of panel slots (fewer than two independent models answered), not of agreeing models."
    );
  });
});

describe("CB-10 / CB-11: the claim memo states K independent models, never slot or row counts", () => {
  it("genuine 3 answers + 2 failed: '3 AI models', names only the answering slots", async () => {
    const rows = [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true }), crow("grok", "ok", "accurate", { provider: true }), crow("gemini", "failed"), crow("perplexity", "failed")];
    const input = await exportedMemoInput(payloadOf(rows, FIVE));
    expect([input.claimModelIndependence, input.claimExecution]).toEqual(["independent", { independentModels: 3, answeredSlots: 3 }]);
    const memo = memoOf(input);
    expect(memo).toContain("CONSENSUS SCORE: 92/100 (High confidence)");
    expect(memo).toContain("3 AI models evaluated this claim independently.");
    expect(memo).not.toContain("5 AI models evaluated");
    expect(memo).toContain("This claim was independently evaluated by 3 large language models (ChatGPT, Claude, Grok) via ConvergePanel.");
  });

  it("genuine 2+3: the memo states answering slots and independent executing models", async () => {
    const input = await exportedMemoInput(payloadOf(CLAIM_FIXTURES[1].rows, FIVE));
    expect(input.claimExecution).toEqual({ independentModels: 3, answeredSlots: 5 });
    const memo = memoOf(input);
    expect(memo).toContain("5 panel slots answered this claim; 3 independent executing models wrote those answers.");
    expect(memo).toContain("written by 3 independent executing models (a model that answered several slots counts once)");
    expect(memo).not.toMatch(/\b5 AI models\b|\b5 large language models\b/);
  });

  it("genuine 5/5: byte-identical to the memo without gate counts (K = M = rows)", async () => {
    const input = await exportedMemoInput(payloadOf(CLAIM_FIXTURES[0].rows, FIVE));
    const { claimExecution: _drop, ...legacy } = input;
    void _drop;
    expect(memoOf(input)).toBe(memoOf(legacy));
  });

  it.each(CLAIM_FIXTURES.filter((f) => f.independence === "unverified" && f.rows))("unverified ($name): no score, no claimExecution", async ({ rows, selected }) => {
    const input = await exportedMemoInput(payloadOf(rows, selected));
    expect([input.claimModelIndependence, "claimExecution" in input]).toEqual(["unverified", false]);
    const memo = memoOf(input);
    expect(memo).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
    expect(memo).not.toMatch(/AI models evaluated this claim independently/);
  });

  it("the memo ignores malformed gate counts (falls back to the established memo)", () => {
    const base = { type: "claim", claim: "c", verdict: "confirmed", consensusScore: 50, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "v", claimModelIndependence: "independent", modelEvidence: [{ modelId: "chatgpt", status: "ok", verdict: "accurate", confidence: "high" }, { modelId: "claude", status: "failed", verdict: "failed", confidence: "low" }] };
    for (const claimExecution of [{ independentModels: 0, answeredSlots: 0 }, { independentModels: 3, answeredSlots: 2 }, { independentModels: 1.5, answeredSlots: 2 }]) {
      expect(memoOf({ ...base, claimExecution })).toBe(memoOf(base));
    }
    expect(memoOf({ ...base, claimModelIndependence: "unverified", claimExecution: { independentModels: 2, answeredSlots: 2 } })).toBe(memoOf({ ...base, claimModelIndependence: "unverified" }));
  });
});

// ─── video (PQ-2 (a) strict; CB-12 .. CB-18) ─────────────────────────────────────────────────────────────────────

function vrow(modelId: string, status: string, verdict = "authentic_captured", extra: Row = {}): Row {
  return { modelId, modelName: modelId, status, verdict, confidence: "high", contentType: "camera_footage", summary: `${modelId} s`, visualIndicators: [], metadataIndicators: [], manipulationSignals: [], authenticitySignals: [], productionSignals: [], deceptionIndicators: [], compressionNotes: [], limitations: [], ...extra };
}
function videoDoc(modelResults: Row[] | undefined): Record<string, unknown> {
  return {
    userId: "u",
    type: "video_verification",
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
    consensusScore: 100,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 100,
    metadata: { duration: 10, width: 640, height: 360, codec: "h264", frameRate: 30, fileSize: 1_000_000, format: "mp4", hasAudio: true },
    metadataAnalysis: { flags: [], summary: "s" },
    ...(modelResults ? { modelResults } : {}),
    agreementPoints: ["3/3 models identified camera footage"],
    disagreementPoints: ["Gemini flagged lighting"],
    frameCount: 8,
    warnings: [],
    timestamp: { seconds: 1_800_000_000, nanoseconds: 0 },
  };
}

const VIDEO_FIXTURES: Array<[string, Row[] | undefined]> = [
  ["3/3 ok rows (distinct modelIds, no provider)", [vrow("chatgpt", "ok"), vrow("claude", "ok"), vrow("gemini", "ok")]],
  ["2 ok + 1 refused", [vrow("chatgpt", "ok"), vrow("claude", "refused", "inconclusive"), vrow("gemini", "ok")]],
  ["all errored", [vrow("chatgpt", "error"), vrow("claude", "error"), vrow("gemini", "parse_error")]],
  ["one answer", [vrow("chatgpt", "ok"), vrow("claude", "error"), vrow("gemini", "error")]],
  ["legacy record without rows", undefined],
];

describe("PQ-2 (a) strict: every providerless video record is independence-unverified on every surface", () => {
  it.each(VIDEO_FIXTURES)("%s", async (_label, rows) => {
    const doc = videoDoc(rows);
    const before = JSON.stringify(doc);
    expect(storedVideoConsensusIndependence(doc.modelResults)).toBe("unverified");

    // CB-16: saved payload.
    const p = mapStoredVideoVerificationToClientPayload("vid-cb", doc);
    expect(p.modelIndependence).toBe("unverified");
    expect(p.consensusScore).toBe(100);
    expect(p.agreementPoints).toEqual(["3/3 models identified camera footage"]);

    // CB-13: result view, audit details, clipboard.
    const out = html(createElement(VideoVerificationResultView, { data: p }));
    expect(out).toContain(WITHHELD);
    expect(out).toContain(CLAIM_COVERAGE_UNVERIFIED_TEXT);
    expect(out).not.toMatch(/>100<\/p>/);
    expect(out).not.toContain("Consensus score<");
    expect(out).not.toContain("Where models agree");
    expect(out).not.toContain("Where models disagree");
    expect(out).toContain(CLAIM_NOT_INDEPENDENT_AGREE_HEADING);
    expect(out).toContain(CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING);
    expect(out).toContain("3/3 models identified camera footage"); // stored text, shown as recorded
    const audit = html(createElement(VideoVerificationAuditTrailDetails, { data: p }));
    expect(audit).toContain(WITHHELD);
    expect(audit).not.toContain("100/100");
    expect(audit).not.toMatch(/>Models \(/);
    const clip = buildVideoVerdictClipboardText(p);
    expect(clip).toContain(`Consensus: ${WITHHELD}`);
    expect(clip).toContain(`Verdict basis: ${CLAIM_COVERAGE_UNVERIFIED_TEXT}`);
    expect(clip).not.toContain("Consensus: 100/100");
    expect(clip).not.toMatch(/^Models:$/m);

    // CB-14 / CB-12: memo through the Personal wrapper's export wiring.
    mockedGenerateMemo.mockClear();
    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(createElement(VideoVerificationResult, { data: p, onVerifyAnother: () => {} }));
    });
    await act(async () => {
      tr.root.findByType(VerificationActions).props.onExportMemo();
    });
    tr.unmount();
    const input = mockedGenerateMemo.mock.calls[0][0] as Record<string, unknown>;
    expect(input.videoModelIndependence).toBe("unverified");
    const memo = memoOf(input);
    expect(memo).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
    expect(memo).toContain("EVIDENCE QUALITY: not assessed (model independence not recorded)");
    expect(memo).toContain("(independent-model coverage unverified)");
    expect(memo).not.toContain("CONSENSUS SCORE: 100");
    expect(memo).not.toMatch(/vision-capable AI models independently analyzed/);
    expect(memo).not.toContain("Each model independently analyzed");
    expect(memo).not.toContain("WHERE MODELS AGREE");
    expect(memo).toContain("POINTS REPEATED ACROSS RESPONSES (NOT AGREEMENT BETWEEN INDEPENDENT MODELS)");
    expect(memo).toContain("- 3/3 models identified camera footage");

    // CB-18: Team list summary → client parser → row.
    const summary = toTeamVideoVerificationSummary({ verificationId: "vid-cb", data: doc, workspaceId: "w", projectId: null, project: null });
    expect(summary).not.toBeNull();
    expect([summary!.consensusScore, summary!.consensusWithheld]).toEqual([null, "independence_unverified"]);
    const parsed = parseTeamVideoListPageResponse({ ok: true, status: 200, body: { ok: true, scope: "all", items: [summary], hasMore: false }, address: { kind: "workspace", workspaceId: "w", scope: "all" } } as never);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.errorCode}`);
    const row = html(createElement("ul", null, createElement(TeamVideoListRow, { workspaceId: "w", item: parsed.page.items[0], showProject: false })));
    expect(row).toContain(WITHHELD);
    expect(row).not.toContain("100/100 consensus");
    expect(row).not.toContain("High confidence");

    expect(JSON.stringify(doc)).toBe(before); // rendering never mutates the record
  });

  it("the Team list parser fails closed on an inconsistent withheld row", () => {
    const summary = toTeamVideoVerificationSummary({ verificationId: "vid-x", data: videoDoc([vrow("chatgpt", "ok")]), workspaceId: "w", projectId: null, project: null })!;
    const parse = (item: unknown) => parseTeamVideoListPageResponse({ ok: true, status: 200, body: { ok: true, scope: "all", items: [item], hasMore: false }, address: { kind: "workspace", workspaceId: "w", scope: "all" } } as never);
    expect(parse(summary).ok).toBe(true);
    expect(parse({ ...summary, consensusScore: 100 }).ok).toBe(false); // a score with a reason
    expect(parse({ ...summary, consensusWithheld: "bogus" }).ok).toBe(false);
    const { consensusWithheld: _w, ...noReason } = summary;
    void _w;
    expect(parse(noReason).ok).toBe(false); // neither a score nor a reason
    expect(parse({ ...noReason, consensusScore: 100 }).ok).toBe(true); // an unwithheld stored score still parses
  });

  it("a payload without modelIndependence is unverified (fail closed); the established view is kept only for 'independent'", () => {
    const p = mapStoredVideoVerificationToClientPayload("vid-cb", videoDoc([vrow("chatgpt", "ok"), vrow("claude", "ok")]));
    const { modelIndependence: _m, ...absent } = p;
    void _m;
    expect(videoConsensusView(absent).consensus.kind).toBe("withheld");
    const shown = html(createElement(VideoVerificationResultView, { data: { ...p, modelIndependence: "independent" } }));
    expect(shown).toContain(">100</p>");
    expect(shown).toContain("Where models agree");
    expect(shown).not.toContain(CLAIM_COVERAGE_UNVERIFIED_TEXT);
  });

  it("the video rule IS the shared gate (no modelId rule): rows that recorded providers would verify", () => {
    // Not a recorded shape today — video rows carry no provider. It shows the judgement is the gate, not a constant.
    expect(storedVideoConsensusIndependence([vrow("chatgpt", "ok", "x", { provider: "openai" }), vrow("claude", "ok", "x", { provider: "anthropic" })])).toBe("independent");
    expect(storedVideoConsensusIndependence([vrow("chatgpt", "ok", "x", { provider: "openai" }), vrow("claude", "error")])).toBe("insufficient");
    expect(storedVideoConsensusIndependence([vrow("chatgpt", "ok", "x", { provider: "openai" }), vrow("claude", "parse_error")])).toBe("insufficient");
    expect(storedVideoConsensusIndependence([vrow("chatgpt", "ok", "x", { provider: "openai" }), vrow("claude", "ok")])).toBe("unverified");
  });
});

// ─── CB-21 (O14 render correction, PQ-3) ─────────────────────────────────────────────────────────────────────────

describe("CB-21: '(others disagree)' is dropped at render only when the tally is unanimous", () => {
  it("parses the 35933c8 tally exactly", () => {
    expect(queueAgreementTally("2/2 models say accurate")).toEqual({ k: 2, n: 2, verdict: "accurate" });
    expect(queueAgreementTally("1/3 models say partially accurate")).toEqual({ k: 1, n: 3, verdict: "partially accurate" });
    for (const bad of [undefined, "", "2/2 models say ", "2/2 models say  ", "3/2 models say x", "0/2 models say x", "2/0 models say x", "x 2/2 models say y", "2/2 responses say accurate"]) {
      expect([bad, queueAgreementTally(bad)]).toEqual([bad, null]);
    }
  });

  it("unanimous (k = n): every '(others disagree)' line is dropped, other lines kept; the DTO object is not mutated", () => {
    const row = { agreementSummary: "2/2 models say accurate", disagreementPoints: ["ChatGPT, Claude rated as accurate (others disagree)", "a stored line"] };
    const before = JSON.stringify(row);
    expect(queueRenderedDisagreementPoints(row)).toEqual(["a stored line"]);
    expect(JSON.stringify(row)).toBe(before);
    expect(queueRenderedDisagreementPoints({ agreementSummary: "1/1 models say accurate", disagreementPoints: ["ChatGPT rated as accurate (others disagree)"] })).toEqual([]);
  });

  it("another answer differed (k < n), or no readable tally: lines kept exactly as before", () => {
    const lines = ["ChatGPT rated as accurate (others disagree)", "Claude, Grok rated as inaccurate (others disagree)"];
    expect(queueRenderedDisagreementPoints({ agreementSummary: "2/3 models say inaccurate", disagreementPoints: lines })).toEqual(lines);
    expect(queueRenderedDisagreementPoints({ disagreementPoints: lines })).toEqual(lines);
    expect(queueRenderedDisagreementPoints({ agreementSummary: "2/2 models say ", disagreementPoints: lines })).toEqual(lines);
    expect(queueRenderedDisagreementPoints({ agreementSummary: "2/2 models say accurate" })).toEqual([]);
  });

  it("the expanded view: unanimous row → no disagree line and no dissent fallback; split row → unchanged", () => {
    const unanimous = queueVerificationAgreementView({ agreementSummary: "2/2 models say accurate", disagreementPoints: ["ChatGPT, Claude rated as accurate (others disagree)"] });
    expect([unanimous.agreeLines, unanimous.disagreeLines]).toEqual([["2/2 models say accurate"], []]);
    const split = queueVerificationAgreementView({ agreementSummary: "2/3 models say inaccurate", dissentSummary: "Dissent: ChatGPT: Accurate", disagreementPoints: ["ChatGPT rated as accurate (others disagree)"], disagreements: ["Conflicting assessments: (claude) vs (grok)"] });
    expect(split.disagreeLines).toEqual(["ChatGPT rated as accurate (others disagree)", "Conflicting assessments: (claude) vs (grok)"]);
    const dissentOnly = queueVerificationAgreementView({ agreementSummary: "2/3 models say inaccurate", dissentSummary: "Dissent: ChatGPT: Accurate" });
    expect(dissentOnly.disagreeLines).toEqual(["Dissent: ChatGPT: Accurate"]);
  });
});

// ─── CB-22 (no silent cap) ───────────────────────────────────────────────────────────────────────────────────────

describe("CB-22: every recorded qualified signal is listed", () => {
  it("a record with seven digest points lists all of them (and its tally); exact duplicates once", () => {
    const digest = Array.from({ length: 7 }, (_x, i) => ({ point: `Conflicting assessments ${i}: (chatgpt) vs (claude)`, models: ["chatgpt", "claude"] }));
    digest.push({ point: "Conflicting assessments 0: (chatgpt) vs (claude)", models: ["chatgpt", "claude"] });
    const a = buildQueueVerificationAgreement({ modelResults: [crow("chatgpt", "ok"), crow("claude", "ok", "inaccurate")] }, { kind: "verification", humanize: (v) => v, digest });
    expect(a.modelIndependence).toBe("unverified");
    expect(a.qualifiedDisagreements).toHaveLength(8);
    expect(a.qualifiedDisagreements.map((q) => q.text)).toEqual(["1/2 responses say accurate — model independence unverified, not confirmed as agreement between models", ...digest.slice(0, 7).map((d) => d.point)]);
  });

  it("a verified record's same-executing-model points beyond the fifth are listed, never dropped", () => {
    const digest = Array.from({ length: 6 }, (_x, i) => ({ point: `same model point ${i}`, models: ["grok", "gemini"] }));
    const rows = [crow("chatgpt", "ok", "accurate", { provider: true }), crow("claude", "ok", "accurate", { provider: true }), crow("grok", "ok", "accurate", { ...DS }), crow("gemini", "ok", "accurate", { ...DS })];
    const a = buildQueueVerificationAgreement({ modelResults: rows }, { kind: "verification", humanize: (v) => v, digest });
    expect(a.modelIndependence).toBe("independent");
    expect(a.qualifiedDisagreements.map((q) => [q.text, q.basis])).toEqual(digest.map((d) => [d.point, "same_executing_model"]));
  });
});
