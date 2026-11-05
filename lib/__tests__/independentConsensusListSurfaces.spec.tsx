/**
 * M2 — list surfaces never publish a stored synthesis consensus score as multi-model agreement unless the run's
 * persisted rows prove at least two independent executing models (`storedRunConsensusIndependence`). Legacy data that
 * records no execution identity is withheld ("independence_unverified") or explicitly qualified — independence is never
 * inferred from response slots. Stored documents are never modified.
 *
 * Covered here: the shared summariser (`toRunSummaryBase` → workspace runs, project runs, Team runs), the Workspace /
 * History status line, and the legacy Team review row. The History route and the governance queue have their own
 * route-level specs (app/api/user/panel-history/__tests__, app/api/governance/queue/__tests__).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONSENSUS_WITHHELD_TEXT,
  consensusScoreWithheldReason,
  storedRunConsensusIndependence,
} from "@/lib/panel/independentVoices";
import { toRunSummaryBase } from "@/lib/runs/runSummary";
import { toProjectRunSummary } from "@/lib/projects/projectRunSummary";
import { toTeamRunSummary } from "@/lib/workspaces/teamRunSummary";
import { workspaceRunStatusLine } from "@/components/workspace/WorkspaceRunCard";
import LegacyReviewListItem, { legacyConsensusText } from "@/components/teamGovernance/LegacyReviewListItem";

const row = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...extra });

const PERSISTED: Record<string, unknown[] | undefined> = {
  twoDeepSeekSubs: [row("chatgpt", "substituted", { provider: "deepseek" }), row("claude", "substituted", { provider: "deepseek" })],
  oneIndependent: [row("chatgpt", "ok", { provider: "openai" }), row("claude", "failed", { rawTextTruncated: "" })],
  missingCredentials: [row("chatgpt", "failed", { rawTextTruncated: "" }), row("claude", "failed", { rawTextTruncated: "" }), row("grok", "ok", { provider: "xai" })],
  unrecordedSubs: [row("chatgpt", "substituted"), row("claude", "substituted")],
  twoIndependent: [row("chatgpt", "ok", { provider: "openai" }), row("grok", "ok", { provider: "xai" })],
  subsPlusGrok: [row("chatgpt", "substituted", { provider: "deepseek" }), row("claude", "substituted", { provider: "deepseek" }), row("grok", "ok", { provider: "xai" })],
  realPlusUnrecordedSub: [row("grok", "ok"), row("chatgpt", "substituted")],
  okButEmptyText: [row("chatgpt", "ok"), row("grok", "ok", { rawTextTruncated: "   " })],
};

const doc = (perModel: unknown, extra: Record<string, unknown> = {}) => ({
  question: "Q",
  selectedModels: ["chatgpt", "claude"],
  createdAt: { toMillis: () => 1 },
  synthesisConsensusSummary: { overallConsensusScore: 90 },
  ...(perModel === undefined ? {} : { runDocument: { perModel } }),
  ...extra,
});

describe("storedRunConsensusIndependence", () => {
  it.each([
    ["twoDeepSeekSubs", "insufficient"],
    ["oneIndependent", "insufficient"],
    ["missingCredentials", "insufficient"],
    ["unrecordedSubs", "insufficient"],
    ["okButEmptyText", "insufficient"],
    ["twoIndependent", "independent"],
    ["subsPlusGrok", "independent"],
    ["realPlusUnrecordedSub", "independent"],
  ])("%s → %s", (k, expected) => {
    expect(storedRunConsensusIndependence(doc(PERSISTED[k]))).toBe(expected);
  });

  it("legacy / unidentifiable stored data → unverified (never inferred from slots)", () => {
    expect(storedRunConsensusIndependence(doc(undefined))).toBe("unverified");
    expect(storedRunConsensusIndependence(doc([]))).toBe("unverified");
    // Rows without a recorded status: execution identity cannot be established.
    expect(storedRunConsensusIndependence(doc([{ modelId: "chatgpt", rawTextTruncated: "a" }, { modelId: "grok", rawTextTruncated: "b" }]))).toBe("unverified");
    expect(storedRunConsensusIndependence(doc([row("chatgpt", "ok"), { status: "ok", rawTextTruncated: "b" }]))).toBe("unverified");
    expect(storedRunConsensusIndependence(doc([row("chatgpt", "ok"), null]))).toBe("unverified");
    expect(storedRunConsensusIndependence(doc([row("chatgpt", "ok"), "grok"]))).toBe("unverified");
    expect(storedRunConsensusIndependence(doc(undefined, { selectedModels: ["chatgpt", "claude", "grok"] }))).toBe("unverified");
    expect(storedRunConsensusIndependence(null)).toBe("unverified");
  });

  it("resultsCompact.perModel is read when runDocument has none; runDocument wins when present", () => {
    expect(storedRunConsensusIndependence({ resultsCompact: { perModel: PERSISTED.twoIndependent } })).toBe("independent");
    expect(storedRunConsensusIndependence({ runDocument: { perModel: PERSISTED.twoDeepSeekSubs }, resultsCompact: { perModel: PERSISTED.twoIndependent } })).toBe("insufficient");
  });

  it("never mutates the stored document", () => {
    const d = doc(PERSISTED.twoDeepSeekSubs);
    const before = JSON.stringify(d);
    storedRunConsensusIndependence(d);
    toRunSummaryBase("r", d);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("reason mapping", () => {
    expect([consensusScoreWithheldReason("independent"), consensusScoreWithheldReason("insufficient"), consensusScoreWithheldReason("unverified")]).toEqual([
      undefined,
      "insufficient_independent_models",
      "independence_unverified",
    ]);
  });
});

describe("Workspace / project / Team run summaries and the status line", () => {
  const BELOW: Array<[string, unknown, string]> = [
    ["two DeepSeek substitutions", PERSISTED.twoDeepSeekSubs, "insufficient_independent_models"],
    ["one independent model", PERSISTED.oneIndependent, "insufficient_independent_models"],
    ["missing provider credentials", PERSISTED.missingCredentials, "insufficient_independent_models"],
    ["legacy doc without perModel", undefined, "independence_unverified"],
  ];
  it.each(BELOW)("%s: score withheld with reason, status line has no 'Synthesis 90/100'", (_n, perModel, reason) => {
    const d = doc(perModel);
    for (const s of [toRunSummaryBase("r", d), toProjectRunSummary("r", d, "p"), toTeamRunSummary("r", d, "u", "w", null)]) {
      expect(s.synthesisConsensusScore).toBeUndefined();
      expect(s.synthesisConsensusWithheld).toBe(reason);
      expect(workspaceRunStatusLine(s)).not.toMatch(/Synthesis \d+\/100/);
    }
  });

  it("two independent models: the stored score is listed, no withheld field", () => {
    const s = toRunSummaryBase("r", doc(PERSISTED.twoIndependent));
    expect(s.synthesisConsensusScore).toBe(90);
    expect("synthesisConsensusWithheld" in s).toBe(false);
    expect(workspaceRunStatusLine(s)).toBe("2/2 model responses · Synthesis 90/100");
  });

  it("no stored score: nothing withheld (no reason invented)", () => {
    const s = toRunSummaryBase("r", { ...doc(PERSISTED.twoDeepSeekSubs), synthesisConsensusSummary: undefined });
    expect(s.synthesisConsensusScore).toBeUndefined();
    expect("synthesisConsensusWithheld" in s).toBe(false);
  });
});

describe("legacy Team review row: the route decides independence; the item shows the score or the reason", () => {
  const item = (extra: Record<string, unknown>) =>
    ({ kind: "legacy", teamRunId: "t1", createdAt: "2026-07-28T00:00:00.000Z", querySummary: "q", policyFlags: [], blockedByPolicy: false, governanceReviewRequired: false, ...extra }) as never;
  it("a shown score (independence proven by the route) is plain — no blanket qualifier", () => {
    const html = renderToStaticMarkup(createElement(LegacyReviewListItem, { item: item({ runId: "r1", consensusScore: 72.4 }) }));
    expect(html).toContain("<span>Consensus 72/100</span>");
    expect(html).not.toContain("independence");
  });
  it("a withheld score shows its reason and no number", () => {
    for (const reason of ["insufficient_independent_models", "independence_unverified"] as const) {
      const html = renderToStaticMarkup(createElement(LegacyReviewListItem, { item: item({ runId: "r1", consensusScore: null, consensusWithheld: reason }) }));
      expect(html).toContain(CONSENSUS_WITHHELD_TEXT[reason]);
      expect(html).not.toMatch(/Consensus \d+\/100/);
    }
  });
  it("no score → 'No consensus score'", () => {
    expect(legacyConsensusText({ consensusScore: null })).toBe("No consensus score");
    expect(legacyConsensusText({ consensusScore: Number.NaN })).toBe("No consensus score");
  });
});

describe("withheld display text", () => {
  it("is explicit about the reason and carries no number", () => {
    expect(CONSENSUS_WITHHELD_TEXT.insufficient_independent_models).toBe("No consensus score (fewer than two independent models)");
    expect(CONSENSUS_WITHHELD_TEXT.independence_unverified).toBe("Consensus score withheld (model independence not recorded)");
  });
});
