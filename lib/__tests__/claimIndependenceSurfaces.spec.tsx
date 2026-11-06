/**
 * Review of 262ef64, MAJOR B1 — every claim-verification surface presents the stored consensus score as a multi-model
 * consensus ONLY when the stored rows prove >= 2 independent executing models with a usable answer
 * (storedVerificationConsensusIndependence). Below that: no consensus score and the verdict as one model's assessment;
 * with provenance missing / incomplete: the score withheld and coverage "unverified". Stored data is never modified.
 *
 * Surfaces (each asserted per scenario): claim detail view (live result, Personal detail, Team detail — all render
 * ClaimVerificationResultView from a payload built by the server mapper / verify response), the audit-trail details,
 * the copied verdict, the claim memo (through the Personal wrapper's export wiring), the Team claim list row (server
 * summary -> client parser -> row) and the Personal history line (server item -> client suffix).
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

import * as fs from "fs";
import * as path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import ClaimVerificationResultView, {
  buildClaimVerdictClipboardText,
  ClaimVerificationAuditTrailDetails,
} from "@/components/verification/ClaimVerificationResultView";
import ClaimVerificationResult from "@/components/ClaimVerificationResult";
import { VerificationActions } from "@/components/VerificationActions";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { parseTeamClaimListPageResponse } from "@/hooks/useTeamClaimVerificationList";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import { claimHistoryConsensusSuffix, claimModelIndependence } from "@/lib/verification/claimConsensusPresentation";
import { CONSENSUS_WITHHELD_TEXT } from "@/lib/panel/independentVoices";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";

const { generateVerificationMemo: realMemo } = jest.requireActual("@/lib/verification/generateMemo");

const NO_CONSENSUS = CONSENSUS_WITHHELD_TEXT.insufficient_independent_models; // "No consensus score (fewer than two independent models)"
const WITHHELD = CONSENSUS_WITHHELD_TEXT.independence_unverified;
const ONE_MODEL = "One independent model's assessment — not agreement between models";
const UNVERIFIED = "Independent-model coverage unverified";

type Row = Record<string, unknown>;
const r = (modelId: string, status: "ok" | "parse_error" | "failed", verdict: string, extra: Row = {}): Row => ({
  modelId,
  status,
  verdict: status === "ok" ? verdict : status,
  confidence: "high",
  summary: `${modelId} says ${verdict}`,
  correctParts: ["Built in 1889"],
  incorrectParts: [],
  unverifiableParts: [],
  ...extra,
});
const DS = { substituted: true, provider: "deepseek" };

function doc(modelResults: Row[] | undefined, selectedModels: string[] | undefined, verdict = "confirmed"): ClaimVerificationFirestoreDoc {
  return {
    userId: "u",
    claim: "The Eiffel Tower was completed in 1889.",
    type: "claim_verification",
    verdict,
    consensusScore: 93,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 1,
    ...(modelResults ? { modelResults } : {}),
    auditBundle: {
      version: "1",
      kind: "claim_verification",
      claimCharCount: 40,
      modelCount: modelResults?.length ?? 0,
      verdict,
      consensusScore: 93,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      perModel: (modelResults ?? []).map((m) => ({ modelId: m.modelId, pipelineStatus: m.status, verdictLabel: m.status === "ok" ? m.verdict : null, confidence: "high", summaryLength: 5, counts: { correct: 1, incorrect: 0, unverifiable: 0 } })),
      generatedAt: "2026-11-01T00:00:00.000Z",
    },
    ...(selectedModels ? { selectedModels } : {}),
    timestamp: { seconds: 1_800_000_000, nanoseconds: 0 },
  } as unknown as ClaimVerificationFirestoreDoc;
}

type Expect = "independent" | "insufficient" | "unverified";
const SCENARIOS: Array<[string, ClaimVerificationFirestoreDoc, Expect]> = [
  ["one of three requested models responded", doc([r("chatgpt", "ok", "accurate"), r("claude", "failed", ""), r("grok", "parse_error", "")], ["chatgpt", "claude", "grok"]), "insufficient"],
  ["two responses from the same DeepSeek fallback", doc([r("chatgpt", "ok", "accurate", DS), r("claude", "ok", "accurate", DS)], ["chatgpt", "claude"]), "insufficient"],
  ["two genuinely independent models", doc([r("chatgpt", "ok", "accurate"), r("claude", "ok", "accurate")], ["chatgpt", "claude"]), "independent"],
  [
    "one independent model with contested claims",
    doc([r("chatgpt", "ok", "partially_accurate", { incorrectParts: ["Completed in March, not May 1889 as claimed"] }), r("grok", "failed", "")], ["chatgpt", "grok"], "partially_true"),
    "insufficient",
  ],
  ["missing provenance (no per-model rows)", doc(undefined, ["chatgpt", "claude"]), "unverified"],
  ["incomplete provenance (a requested model without a row)", doc([r("chatgpt", "ok", "accurate"), r("claude", "ok", "accurate")], ["chatgpt", "claude", "grok"]), "unverified"],
  [
    "genuine disagreement between independent models",
    doc([r("chatgpt", "ok", "accurate"), r("claude", "ok", "inaccurate", { incorrectParts: ["The tower opened in 1890 according to records"] }), r("grok", "ok", "inaccurate", { incorrectParts: ["The completion year cited is wrong entirely"] })], ["chatgpt", "claude", "grok"], "disputed"),
    "independent",
  ],
  ["legacy record (rows without substitution fields, no selectedModels)", doc([r("chatgpt", "ok", "accurate"), r("gemini", "ok", "accurate")], undefined), "independent"],
];

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

describe.each(SCENARIOS)("claim surfaces — %s", (_label, stored, expected) => {
  const payload = mapStoredVerificationToClientPayload(stored, "vcl-1");

  it("server mapper carries the stored independence; the stored score is unchanged", () => {
    expect(payload.modelIndependence).toBe(expected);
    expect(payload.consensusScore).toBe(93);
    expect(payload.auditBundle.consensusScore).toBe(93);
  });

  it("detail view (live / Personal / Team): score only for independent", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: payload }));
    if (expected === "independent") {
      expect(out).toContain(">93</p>");
      expect(out).toContain("Consensus score");
      expect(out).not.toContain(NO_CONSENSUS);
      expect(out).not.toContain(WITHHELD);
    } else {
      expect(out).not.toContain(">93<");
      expect(out).not.toMatch(/>Consensus score</);
      expect(out).not.toContain("Majority agreement");
      expect(out).not.toMatch(/supported by \d+\/\d+ models/);
      expect(out).toContain(expected === "insufficient" ? NO_CONSENSUS : WITHHELD);
      expect(out).toContain(expected === "insufficient" ? ONE_MODEL : UNVERIFIED);
    }
  });

  it("audit-trail details: Consensus row", () => {
    const out = html(createElement(ClaimVerificationAuditTrailDetails, { data: payload }));
    if (expected === "independent") expect(out).toContain("93/100");
    else {
      expect(out).not.toContain("93/100");
      expect(out).toContain(expected === "insufficient" ? NO_CONSENSUS : WITHHELD);
    }
  });

  it("copied verdict", () => {
    const text = buildClaimVerdictClipboardText(payload);
    if (expected === "independent") expect(text).toContain("Consensus score: 93 (High confidence)");
    else {
      expect(text).not.toContain("Consensus score: 93");
      expect(text).toContain(`Consensus score: ${expected === "insufficient" ? NO_CONSENSUS : WITHHELD}`);
      expect(text).toContain(`Verdict basis: ${expected === "insufficient" ? ONE_MODEL : UNVERIFIED}`);
      expect(text).not.toContain("Where models agree:");
    }
  });

  it("claim memo (Personal wrapper export wiring -> generator)", async () => {
    mockedGenerateMemo.mockClear();
    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(createElement(ClaimVerificationResult, { data: payload, onVerifyAnother: () => {} }));
    });
    const actions = tr.root.findByType(VerificationActions);
    await act(async () => {
      actions.props.onExportMemo();
    });
    expect(mockedGenerateMemo).toHaveBeenCalledTimes(1);
    const input = mockedGenerateMemo.mock.calls[0][0] as Record<string, unknown>;
    expect(input.claimModelIndependence).toBe(expected);
    const memo: string = realMemo(input);
    if (expected === "independent") {
      expect(memo).toContain("CONSENSUS SCORE: 93/100 (High confidence)");
    } else {
      expect(memo).not.toContain("CONSENSUS SCORE: 93");
      expect(memo).toContain(expected === "insufficient" ? "CONSENSUS SCORE: none (fewer than two independent models answered" : "CONSENSUS SCORE: withheld (model independence not recorded)");
      expect(memo).not.toContain("WHERE MODELS AGREE");
      expect(memo).not.toMatch(/AI models evaluated this claim independently/);
      expect(memo).not.toContain("The consensus score reflects the degree of agreement across models");
    }
    tr.unmount();
  });

  it("Team claim list: server summary -> client parser -> row", () => {
    const summary = toTeamClaimVerificationSummary({ verificationId: "vcl-1", data: { ...(stored as unknown as Row), workspaceId: "w" }, workspaceId: "w", projectId: null, project: null });
    expect(summary).not.toBeNull();
    const parsed = parseTeamClaimListPageResponse({
      ok: true,
      status: 200,
      body: { ok: true, scope: "all", items: [summary], hasMore: false },
      address: { kind: "workspace", workspaceId: "w", scope: "all" },
    });
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.errorCode}`);
    const out = html(createElement("ul", null, createElement(TeamClaimListRow, { workspaceId: "w", item: parsed.page.items[0], showProject: false })));
    if (expected === "independent") expect(out).toContain("93/100 consensus");
    else {
      expect(summary!.consensusScore).toBeNull();
      expect(out).not.toContain("93");
      expect(out).not.toContain("High confidence");
      expect(out).toContain(expected === "insufficient" ? NO_CONSENSUS : WITHHELD);
    }
  });

  it("Personal history line (client suffix over the server item and over a live result)", () => {
    const serverItem = { consensusScore: expected === "independent" ? 93 : null, modelIndependence: expected };
    const live = { consensusScore: 93, modelIndependence: claimModelIndependence(payload.modelIndependence) };
    for (const item of [serverItem, live]) {
      const line = `Confirmed${claimHistoryConsensusSuffix(item)}`;
      if (expected === "independent") expect(line).toBe("Confirmed · 93 consensus");
      else expect(line).toBe(`Confirmed · ${expected === "insufficient" ? NO_CONSENSUS : WITHHELD}`);
    }
  });
});

describe("fail closed + wiring", () => {
  it("a payload / history row without recorded independence is unverified, never a consensus", () => {
    const p = mapStoredVerificationToClientPayload(SCENARIOS[2][1], "vcl-2");
    const { modelIndependence: _drop, ...noIndependence } = p;
    void _drop;
    expect(html(createElement(ClaimVerificationResultView, { data: noIndependence }))).toContain(WITHHELD);
    expect(buildClaimVerdictClipboardText(noIndependence)).toContain(`Consensus score: ${WITHHELD}`);
    expect(claimHistoryConsensusSuffix({ consensusScore: 93 })).toBe(` · ${WITHHELD}`);
  });

  it("app/page.tsx renders the claim history line through claimHistoryConsensusSuffix and carries the live independence", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/page.tsx"), "utf8");
    expect(src).toContain("{claimHistoryConsensusSuffix(item)}");
    expect(src.match(/modelIndependence: claimModelIndependence\(data\.modelIndependence\)/g)?.length).toBe(2);
    expect(src.match(/modelIndependence: payload\.modelIndependence/g)?.length).toBe(2);
    expect(src).toContain("modelIndependence: claimModelIndependence(row.modelIndependence)");
    // The claim branch no longer formats a bare stored score (video keeps its own line).
    const claimBranch = src.slice(src.indexOf("formatHistoryVerdictLabel(item.verdict)}`"), src.indexOf("<GovernanceChip status={item.governanceStatus} />"));
    expect(claimBranch).not.toContain("consensus`");
  });
});
