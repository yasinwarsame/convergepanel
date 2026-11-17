/**
 * PR-1 (evidence doc 14) — every claim surface states the per-model verdict distribution truthfully, from stored rows,
 * with the stored label / score / confidence untouched: result view (banner, consensus card), clipboard, memo, Team
 * list (summary DTO, window builder, client parser, row) and the Personal history item. Synthetic data only.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) => require("react").createElement("a", { href, className, ...rest }, children as never),
}));
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamClaimFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamClaimFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamClaimFakeFirestore");
    return makeFakeDb(mockState);
  },
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ClaimVerificationResultView, { buildClaimVerdictClipboardText } from "@/components/verification/ClaimVerificationResultView";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { buildClaimVerificationAuditBundle } from "@/lib/verification/auditBundle";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { listTeamClaimVerifications } from "@/lib/workspaces/listTeamClaimVerifications";
import { parseTeamClaimListPageResponse, type TeamClaimListItem } from "@/hooks/useTeamClaimVerificationList";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import { createFakeState, teamClaimDoc, TEAM_W } from "@/lib/workspaces/__tests__/teamClaimFakeFirestore";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";

type Row = { modelId: string; status: "ok" | "parse_error" | "failed"; verdict: string; confidence: string; summary: string; correctParts: string[]; incorrectParts: string[]; unverifiableParts: string[]; provider?: string };
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", gemini: "google", perplexity: "perplexity" };
const row = (modelId: string, verdict: string, incorrect: string[] = []): Row =>
  verdict === "parse_error" || verdict === "failed"
    ? { modelId, status: verdict, verdict, confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] }
    : { modelId, status: "ok", verdict, confidence: "high", summary: `${modelId} ${verdict}`, correctParts: [], incorrectParts: incorrect, unverifiableParts: [], provider: OWN[modelId] };

function doc(rows: Row[], stored: { verdict: string; consensusScore: number; confidenceLabel: "High" | "Medium" | "Low"; evidenceQuality: "strong" | "mixed" | "weak" }) {
  const auditBundle = buildClaimVerificationAuditBundle({ claimLength: 10, modelEvidence: rows, verdict: stored.verdict as never, consensusScore: stored.consensusScore, confidenceLabel: stored.confidenceLabel, evidenceQuality: stored.evidenceQuality });
  return {
    userId: "u",
    claim: "Synthetic claim.",
    type: "claim_verification",
    ...stored,
    supportRatio: 0,
    modelResults: rows,
    auditBundle,
    selectedModels: rows.map((r) => r.modelId),
    timestamp: { seconds: 1_800_000_000, nanoseconds: 0 },
  } as unknown as ClaimVerificationFirestoreDoc;
}
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const memoOf = (p: ReturnType<typeof mapStoredVerificationToClientPayload>) =>
  generateVerificationMemo({
    type: "claim",
    claim: p.claim,
    verdict: p.verdict,
    consensusScore: p.consensusScore,
    confidenceLabel: p.confidenceLabel,
    evidenceQuality: p.evidenceQuality ?? "mixed",
    modelEvidence: p.modelEvidence,
    agreementPoints: p.whereModelsAgree,
    disagreementPoints: p.whereModelsDisagree.map((d) => d.point),
    verificationId: "v",
    claimModelIndependence: p.modelIndependence,
    claimExecution: { independentModels: p.modelEvidence.filter((m) => m.status === "ok").length, answeredSlots: p.modelEvidence.filter((m) => m.status === "ok").length },
  });

// Stored as main writes them (labels from computeClaimVerdict; scores illustrative of the stored record).
const NO_SUPPORT_WITH_U = doc([row("chatgpt", "inaccurate"), row("claude", "inaccurate"), row("grok", "inaccurate"), row("gemini", "unverifiable")], { verdict: "disputed", consensusScore: 50, confidenceLabel: "Medium", evidenceQuality: "weak" });
const NO_SUPPORT_WITH_PARSE_ERROR = doc([row("chatgpt", "inaccurate"), row("claude", "inaccurate"), row("grok", "parse_error")], { verdict: "disputed", consensusScore: 47, confidenceLabel: "Medium", evidenceQuality: "weak" });
const PARTIAL_VS_INACCURATE_HIGH = doc([row("chatgpt", "partially_accurate"), row("claude", "partially_accurate"), row("grok", "inaccurate"), row("gemini", "inaccurate"), row("perplexity", "inaccurate")], { verdict: "partially_true", consensusScore: 74, confidenceLabel: "High", evidenceQuality: "mixed" });
const CONFIRMED_WITH_DISSENT = doc([row("chatgpt", "accurate"), row("claude", "accurate"), row("grok", "accurate"), row("gemini", "accurate"), row("perplexity", "inaccurate")], { verdict: "confirmed", consensusScore: 100, confidenceLabel: "High", evidenceQuality: "strong" });
const UNANIMOUS_ACCURATE = doc([row("chatgpt", "accurate"), row("claude", "accurate"), row("grok", "accurate")], { verdict: "confirmed", consensusScore: 100, confidenceLabel: "High", evidenceQuality: "strong" });
const GENUINE_SPLIT = doc([row("chatgpt", "accurate"), row("claude", "inaccurate", ["The year is wrong in this statement"]), row("grok", "inaccurate", ["Opened in a different year entirely"])], { verdict: "disputed", consensusScore: 47, confidenceLabel: "Medium", evidenceQuality: "weak" });
const SINGLE_INACCURATE = doc([row("chatgpt", "inaccurate")], { verdict: "disputed", consensusScore: 40, confidenceLabel: "Low", evidenceQuality: "weak" });

describe("result view banner", () => {
  it("no support + an unverifiable answer: states both counts, not disagreement; stored label untouched", () => {
    const p = mapStoredVerificationToClientPayload(NO_SUPPORT_WITH_U, "v1");
    const out = html(createElement(ClaimVerificationResultView, { data: p }));
    expect(out).toContain("3 of 4 models rated this claim inaccurate; 1 could not verify it");
    expect(out).toContain("The recorded verdict is Disputed; it does not mean the models disagreed.");
    expect(out).not.toContain("Models disagree on this claim");
    expect(p.verdict).toBe("disputed");
    expect(p.consensusScore).toBe(50);
  });

  it("a parse_error row is not an answer: 2 of 2 models rated it inaccurate", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: mapStoredVerificationToClientPayload(NO_SUPPORT_WITH_PARSE_ERROR, "v2") }));
    expect(out).toContain("2 of 2 models rated this claim inaccurate<");
  });

  it("[CONTROL] a genuine split and a single-model record keep their wording", () => {
    expect(html(createElement(ClaimVerificationResultView, { data: mapStoredVerificationToClientPayload(GENUINE_SPLIT, "v3") }))).toContain("Models disagree on this claim");
    const single = html(createElement(ClaimVerificationResultView, { data: mapStoredVerificationToClientPayload(SINGLE_INACCURATE, "v4") }));
    expect(single).toContain("Disputed — One independent model's assessment — not agreement between models");
    expect(single).not.toContain("rated this claim inaccurate");
  });
});

describe("confidence over split answers is never shown bare", () => {
  it("result view: High is qualified with the split, and the counts are shown", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: mapStoredVerificationToClientPayload(PARTIAL_VS_INACCURATE_HIGH, "v5") }));
    expect(out).toContain(">High<");
    expect(out).toContain("(verdicts split: 2 partially accurate, 3 inaccurate)");
    expect(out).toMatch(/data-testid="claim-verdict-counts"><p[^>]*>2 partially accurate, 3 inaccurate<\/p><p[^>]*>Model verdicts</);
  });

  it("result view: 4A/1I (stored 100/100 High) shows the dissent next to the label", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: mapStoredVerificationToClientPayload(CONFIRMED_WITH_DISSENT, "v6") }));
    expect(out).toContain("(verdicts split: 4 accurate, 1 inaccurate)");
  });

  it("[CONTROL] unanimous answers carry no split qualifier", () => {
    const out = html(createElement(ClaimVerificationResultView, { data: mapStoredVerificationToClientPayload(UNANIMOUS_ACCURATE, "v7") }));
    expect(out).not.toContain("verdicts split");
    expect(out).toContain("3 accurate");
  });

  it("clipboard: the consensus line carries the split; the label line is unchanged", () => {
    const t = buildClaimVerdictClipboardText(mapStoredVerificationToClientPayload(PARTIAL_VS_INACCURATE_HIGH, "v8"));
    expect(t).toContain("Aggregate verdict: partially_true\n");
    expect(t).toContain("Consensus score: 74 (High confidence; verdicts split: 2 partially accurate, 3 inaccurate)");
  });

  it("clipboard: no-support disputed carries the distribution; a genuine split stays bare", () => {
    expect(buildClaimVerdictClipboardText(mapStoredVerificationToClientPayload(NO_SUPPORT_WITH_U, "v9"))).toContain(
      "Aggregate verdict: disputed (No answer supported the claim: 3 of 4 rated it inaccurate and 1 could not verify it.)"
    );
    expect(buildClaimVerdictClipboardText(mapStoredVerificationToClientPayload(GENUINE_SPLIT, "v10"))).toMatch(/^Aggregate verdict: disputed$/m);
  });

  it("memo: CONSENSUS SCORE carries the split; VERDICT stays the stored label", () => {
    const m = memoOf(mapStoredVerificationToClientPayload(PARTIAL_VS_INACCURATE_HIGH, "v11"));
    expect(m).toContain("VERDICT: Partially True\n");
    expect(m).toContain("CONSENSUS SCORE: 74/100 (High confidence; verdicts split: 2 partially accurate, 3 inaccurate)");
  });

  it("memo: no-support disputed is stated from the answers; genuine split still 'diverged'", () => {
    const m = memoOf(mapStoredVerificationToClientPayload(NO_SUPPORT_WITH_U, "v12"));
    expect(m).toContain("VERDICT: Disputed\n");
    expect(m).toContain("No answer supported the claim: 3 of 4 rated it inaccurate and 1 could not verify it. The recorded verdict label is Disputed; it does not indicate a split between models.");
    expect(m).not.toContain("Models diverged");
    expect(memoOf(mapStoredVerificationToClientPayload(GENUINE_SPLIT, "v13"))).toContain("Models diverged on important aspects of this claim; treat conclusions as contested.");
  });
});

describe("Team list: per-model counts never break a row or a window", () => {
  const summaryOf = (d: ClaimVerificationFirestoreDoc) =>
    toTeamClaimVerificationSummary({ verificationId: "v", data: { ...(d as unknown as Record<string, unknown>), workspaceId: "w" }, workspaceId: "w", projectId: null, project: null });

  it("parse_error / failed rows are excluded from the counts; the summary is built", () => {
    const s = summaryOf(doc([row("chatgpt", "accurate"), row("claude", "accurate"), row("grok", "parse_error"), row("gemini", "failed")], { verdict: "confirmed", consensusScore: 80, confidenceLabel: "High", evidenceQuality: "mixed" }));
    expect(s?.modelVerdicts).toEqual({ accurate: 2, partially_accurate: 0, inaccurate: 0, unverifiable: 0, usable: 2 });
  });

  it("every row a parse_error: verdict unverifiable, usable 0, summary still built", () => {
    const s = summaryOf(doc([row("chatgpt", "parse_error"), row("claude", "parse_error")], { verdict: "unverifiable", consensusScore: 20, confidenceLabel: "Low", evidenceQuality: "weak" }));
    expect(s).not.toBeNull();
    expect(s?.modelVerdicts).toEqual({ accurate: 0, partially_accurate: 0, inaccurate: 0, unverifiable: 0, usable: 0 });
  });

  it.each([
    ["no audit bundle", { auditBundle: undefined }],
    ["malformed perModel", { auditBundle: { perModel: [{ pipelineStatus: "weird" }] } }],
    ["ok row with an unknown label", { auditBundle: { perModel: [{ pipelineStatus: "ok", verdictLabel: "mostly" }] } }],
  ])("%s: the summary is built WITHOUT counts (never null, never a whole-window failure)", (_l, over) => {
    const s = toTeamClaimVerificationSummary({ verificationId: "v", data: { ...(CONFIRMED_WITH_DISSENT as unknown as Record<string, unknown>), ...over, workspaceId: "w" }, workspaceId: "w", projectId: null, project: null });
    expect(s).not.toBeNull();
    expect(s && "modelVerdicts" in s).toBe(false);
  });

  it("listTeamClaimVerifications: a window holding parse_error rows and an uncountable bundle lists every row", async () => {
    mockState = createFakeState();
    const pe = doc([row("chatgpt", "parse_error"), row("claude", "inaccurate"), row("grok", "inaccurate")], { verdict: "disputed", consensusScore: 47, confidenceLabel: "Medium", evidenceQuality: "weak" });
    const { timestamp: _ts, ...peData } = pe as unknown as Record<string, unknown>;
    mockState.collections.verifications = [
      teamClaimDoc("pe", peData, 1_700_000_003_000),
      teamClaimDoc("allpe", { modelResults: [row("chatgpt", "parse_error")], auditBundle: { perModel: [{ modelId: "chatgpt", pipelineStatus: "parse_error", verdictLabel: null }] }, verdict: "unverifiable" }, 1_700_000_002_000),
      teamClaimDoc("nobundle", { auditBundle: { perModel: "broken" } }, 1_700_000_001_000),
    ];
    const r = await listTeamClaimVerifications({ workspaceId: TEAM_W, scope: { kind: "all" }, limit: 20, cursorRaw: null });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items.map((i) => i.verificationId)).toEqual(["pe", "allpe", "nobundle"]);
    expect(r.items[0].modelVerdicts).toEqual({ accurate: 0, partially_accurate: 0, inaccurate: 2, unverifiable: 0, usable: 2 });
    expect(r.items[1].modelVerdicts).toEqual({ accurate: 0, partially_accurate: 0, inaccurate: 0, unverifiable: 0, usable: 0 });
    expect("modelVerdicts" in r.items[2]).toBe(false);
  });
});

describe("Team list client parser and row", () => {
  const ALL = { kind: "workspace" as const, workspaceId: "ws-1", scope: "all" as const };
  const base = { verificationId: "vcl-1", claim: "c", verdict: "disputed", consensusScore: 52, confidenceLabel: "Medium", evidenceQuality: "weak", createdAt: "2026-09-10T10:00:00.000Z", workspaceId: "ws-1", projectId: null, project: null };
  const parse = (items: unknown[]) => parseTeamClaimListPageResponse({ ok: true, status: 200, body: { ok: true, items, hasMore: false, scope: "all" }, address: ALL });
  const counts = { accurate: 0, partially_accurate: 0, inaccurate: 3, unverifiable: 0, usable: 3 };

  it("absent modelVerdicts (older server) is accepted and stays absent", () => {
    const r = parse([base]);
    expect(r.ok).toBe(true);
    expect(r.ok && "modelVerdicts" in r.page.items[0]).toBe(false);
  });

  it("valid modelVerdicts is carried; usable 0 (all parse_error) is valid", () => {
    const r = parse([{ ...base, modelVerdicts: counts }, { ...base, verificationId: "vcl-2", verdict: "unverifiable", modelVerdicts: { accurate: 0, partially_accurate: 0, inaccurate: 0, unverifiable: 0, usable: 0 } }]);
    expect(r.ok && r.page.items.map((i) => i.modelVerdicts)).toEqual([counts, { accurate: 0, partially_accurate: 0, inaccurate: 0, unverifiable: 0, usable: 0 }]);
  });

  it.each([
    ["usable mismatch", { ...counts, usable: 2 }],
    ["extra key", { ...counts, parse_error: 1 }],
    ["missing key", { accurate: 0, partially_accurate: 0, inaccurate: 3, usable: 3 }],
    ["negative", { ...counts, accurate: -1, usable: 2 }],
    ["string count", { ...counts, inaccurate: "3" }],
    ["null", null],
  ])("present but malformed (%s) -> the page is malformed_response (strict when present)", (_l, mv) => {
    expect(parse([{ ...base, modelVerdicts: mv }])).toEqual({ ok: false, errorCode: "malformed_response" });
  });

  const render = (item: TeamClaimListItem) => html(createElement(TeamClaimListRow, { workspaceId: "ws-1", item, showProject: false }));

  it("row: the answers are shown next to the label; a split qualifies the confidence", () => {
    const out = render({ ...(base as unknown as TeamClaimListItem), modelVerdicts: counts });
    expect(out).toContain(">Disputed<");
    expect(out).toContain("Answers: 3 inaccurate");
    expect(out).not.toContain("verdicts split");
    const split = render({ ...(base as unknown as TeamClaimListItem), verdict: "confirmed", consensusScore: 100, confidenceLabel: "High", modelVerdicts: { accurate: 4, partially_accurate: 0, inaccurate: 1, unverifiable: 0, usable: 5 } });
    expect(split).toContain("High confidence (verdicts split)");
    expect(split).toContain("Answers: 4 accurate, 1 inaccurate");
  });

  it("[CONTROL] row without counts, or with a withheld score, renders as before", () => {
    const plain = render(base as unknown as TeamClaimListItem);
    expect(plain).not.toContain("Answers:");
    expect(plain).toContain(">Medium confidence<");
    const withheld = render({ ...(base as unknown as TeamClaimListItem), consensusScore: null, consensusWithheld: "insufficient_independent_models", modelVerdicts: counts });
    expect(withheld).not.toContain("Answers:");
  });
});
