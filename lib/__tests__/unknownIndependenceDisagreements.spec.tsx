/**
 * Review of 0ca72b0, MINOR m2 / owner order B2 — UNKNOWN model independence is never described as repeated output from
 * one model. Four classifications stay distinct on the live gate (PSV gate card), the copied synthesis (share text, incl.
 * its Panel Verdict section) and the panel verdict:
 *  1. genuine independent-model disagreement;
 *  2. repeated output from the same executing model (NON_INDEPENDENT_DISAGREEMENTS_REASON);
 *  3. single-model contested / uncertain claims (SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON);
 *  4. unknown model independence (INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON / _UNCERTAIN_CLAIMS_REASON).
 * Gate status is unchanged (only the wording of non-genuine items moves), and runs with ≥ 2 independent models and no
 * collapsed slots are byte-identical to the gate before (also pinned by independentRecordsParity.spec.tsx).
 * Real components (react-test-renderer) and real builders; only I/O is mocked.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) }));
jest.mock("@/lib/client/fetchWithTimeout", () => ({
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })),
  FetchError: class FetchError extends Error {},
}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));
const mockCopied: string[] = [];
jest.mock("@/lib/ui/copyFormats", () => {
  const actual = jest.requireActual("@/lib/ui/copyFormats");
  return { ...actual, copyToClipboardWithFallback: async (text: string) => (mockCopied.push(text), true) };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import { VerificationActions } from "@/components/VerificationActions";
import {
  buildPanelVerdict,
  crossModelDisagreements,
  formatVerdictText,
  independenceUnverifiedDisagreements,
} from "@/lib/verificationGate/panelVerdict";
import {
  computeVerificationGate,
  INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON,
  INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_STEP,
  INDEPENDENCE_UNVERIFIED_UNCERTAIN_CLAIMS_REASON,
  NON_INDEPENDENT_DISAGREEMENTS_REASON,
  SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON,
  UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL,
  type VerificationGateInput,
} from "@/lib/verificationGate/verificationGate";
import { classifyStoredDisagreement, storedRunIndependenceContext } from "@/lib/panel/storedDisagreementIndependence";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";
const ok = (modelId: string) => ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5 }) as ModelResult;
const sub = (modelId: string) => ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, provider: "deepseek" }) as ModelResult;
/** ChatGPT and Claude both answered by the DeepSeek fallback, plus Grok: two independent executing models, collapsed. */
const COLLAPSED = [sub("chatgpt"), sub("claude"), ok("grok")];
const TWO_SUBS = [sub("chatgpt"), sub("claude")];
const DISTINCT = [ok("chatgpt"), ok("claude"), ok("grok")];
const SUMMARY = { modelsHealthy: 2, modelCount: 3, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

const SAME = { topic: "Founding year", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "Sources differ." };
const UNKNOWN = { topic: "Founder occupation", positionsByModel: { chatgpt: "merchant" }, whyTheyDiffer: "Only one position recorded." };
const GENUINE = { topic: "First location", positionsByModel: { chatgpt: "Lyon", grok: "Paris" }, whyTheyDiffer: "Archives differ." };

const report = (disagreements: unknown[], mixed = 0): StructuredSynthesis =>
  ({
    executiveSummary: "Founding details vary.",
    keyFindings: [
      { claim: "The company was founded in the eighteenth century.", confidence: "High", evidenceRefs: [], modelsSupporting: ["chatgpt", "grok"] },
      ...Array.from({ length: mixed }, (_, i) => ({ claim: `Mixed claim ${i}`, confidence: "Mixed", evidenceRefs: [], modelsSupporting: ["chatgpt"] })),
    ],
    disagreements,
    biasAndBlindSpots: [],
    openQuestions: [],
    methodology: "Cross-model comparison.",
  }) as unknown as StructuredSynthesis;

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function mount(results: ModelResult[], rep: StructuredSynthesis) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(PanelSynthesisView as never, { results, question: "When was the company founded and by whom?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: rep, preGeneratedConsensusSummary: SUMMARY } as never)
    );
  });
  mounted.push(r);
  return r;
}
async function copied(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockCopied.length = 0;
  await act(async () => {
    await r.root.findByType(VerificationActions).props.onCopy();
  });
  return mockCopied[0];
}
async function linkedIn(r: TestRenderer.ReactTestRenderer): Promise<string> {
  await act(async () => {
    r.root.findByType(VerificationActions).props.onGenerateLinkedIn();
  });
  return nodeText(r.root.findAll((n) => n.type === "pre")[0]);
}

beforeEach(() => {
  for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

describe("classification: the live split matches the governance queue's stored classification", () => {
  it("collapsed run: SAME → same executing model, UNKNOWN → independence unverified, GENUINE → cross-model", () => {
    const items = [SAME, UNKNOWN, GENUINE];
    expect(crossModelDisagreements(items, COLLAPSED, true)).toEqual([GENUINE]);
    expect(independenceUnverifiedDisagreements(items, COLLAPSED, true)).toEqual([UNKNOWN]);
    const ctx = storedRunIndependenceContext({
      runDocument: { perModel: COLLAPSED.map((r) => ({ modelId: r.modelId, status: r.status, provider: (r as any).provider, rawTextTruncated: TEXT })) },
    });
    expect(items.map((d) => classifyStoredDisagreement(d, ctx))).toEqual(["same_executing_model", "independence_unverified", "cross_model"]);
  });

  it("below two independent models, without rows, or with no collapse: nothing is 'unknown independence'", () => {
    expect(independenceUnverifiedDisagreements([SAME, UNKNOWN], TWO_SUBS, false)).toEqual([]);
    expect(independenceUnverifiedDisagreements([SAME, UNKNOWN], null, true)).toEqual([]);
    expect(independenceUnverifiedDisagreements([SAME, UNKNOWN, GENUINE], DISTINCT, true)).toEqual([]);
  });
});

describe("live gate: unknown independence vs repeated execution (≥ 2 independent models, collapsed slots)", () => {
  const input = (d: any[], withUnknown: boolean): VerificationGateInput => ({
    keyFindings: report([]).keyFindings,
    disagreements: d,
    independentDisagreements: crossModelDisagreements(d, COLLAPSED, true),
    ...(withUnknown ? { independenceUnverifiedDisagreements: independenceUnverifiedDisagreements(d, COLLAPSED, true) } : {}),
    independentModelCount: 2,
    questionLength: 200,
  });

  it("each non-genuine item is counted under its own reason — never 'one independent model (2)'", () => {
    const g = computeVerificationGate(input([SAME, UNKNOWN], true));
    expect(g.metrics.nonIndependentDisagreementsCount).toBe(1);
    expect(g.metrics.independenceUnverifiedDisagreementsCount).toBe(1);
    expect(g.reasons).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
    expect(g.reasons).toContain(`${INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON} (1)`);
    expect(g.reasons).not.toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (2)`);
    expect(g.recommendedNextSteps).toContain(INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_STEP);
  });

  it("only unknown-independence items: no 'one independent model' wording at all", () => {
    const g = computeVerificationGate(input([UNKNOWN], true));
    expect(g.reasons).toContain(`${INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON} (1)`);
    expect(g.reasons.join("\n")).not.toContain(NON_INDEPENDENT_DISAGREEMENTS_REASON);
  });

  it("gate status and label are unchanged by the split (stricter-only floor untouched)", () => {
    for (const d of [[SAME, UNKNOWN], [UNKNOWN], [SAME, UNKNOWN, GENUINE], [UNKNOWN, UNKNOWN, UNKNOWN]]) {
      const split = computeVerificationGate(input(d, true));
      const unsplit = computeVerificationGate(input(d, false));
      expect([split.status, split.label]).toEqual([unsplit.status, unsplit.label]);
      expect({ ...split.metrics, nonIndependentDisagreementsCount: 0, independenceUnverifiedDisagreementsCount: 0 }).toEqual({
        ...unsplit.metrics,
        nonIndependentDisagreementsCount: 0,
        independenceUnverifiedDisagreementsCount: 0,
      });
    }
  });
});

describe("live gate: unknown execution provenance is not 'one independent model'", () => {
  it("disagreements and 'Mixed' findings are stated as of unknown independence", () => {
    const g = computeVerificationGate({
      keyFindings: report([], 2).keyFindings,
      disagreements: [SAME, UNKNOWN],
      executionProvenanceUnverified: true,
      independentModelCount: 2,
      questionLength: 200,
    });
    expect(g.label).toBe(UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL);
    expect(g.metrics.independenceUnverifiedDisagreementsCount).toBe(2);
    expect(g.metrics.nonIndependentDisagreementsCount).toBe(0);
    expect(g.metrics.independenceUnverifiedContestedCount).toBe(2);
    expect(g.metrics.singleModelContestedCount).toBeUndefined();
    expect(g.reasons).toContain(`${INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON} (2)`);
    expect(g.reasons).toContain(`${INDEPENDENCE_UNVERIFIED_UNCERTAIN_CLAIMS_REASON} (2)`);
    expect(g.reasons.join("\n")).not.toMatch(/one independent model/i);
  });

  it("control: fewer than two independent models keeps the one-model wording (repeated output / single-model uncertainty)", () => {
    const g = computeVerificationGate({
      keyFindings: report([], 2).keyFindings,
      disagreements: [SAME, UNKNOWN],
      independentModelCount: 1,
      questionLength: 200,
    });
    expect(g.reasons).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (2)`);
    expect(g.reasons).toContain(`${SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON} (2)`);
    expect(g.reasons.join("\n")).not.toContain(INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON);
    expect(g.metrics.independenceUnverifiedDisagreementsCount).toBeUndefined();
  });
});

describe("PSV end to end: gate card, verdict and copied synthesis (share text)", () => {
  it("collapsed run (DeepSeek×2 + Grok): repeated execution and unknown independence are separate on every surface", async () => {
    const r = await mount(COLLAPSED, report([SAME, UNKNOWN, GENUINE]));
    const screen = nodeText(r.root);
    const md = await copied(r);
    for (const text of [screen, md]) {
      expect(text).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
      expect(text).toContain(`${INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON} (1)`);
      expect(text).not.toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (2)`);
    }
    // The verdict / share present only the genuine item as a disagreement between models.
    const verdict = buildPanelVerdict("q", report([SAME, UNKNOWN, GENUINE]), computeVerificationGate({ keyFindings: [] }), COLLAPSED, { crossModel: true });
    expect(verdict.topDisagreement).toBe(GENUINE.topic);
    expect(formatVerdictText(verdict, "linkedin")).not.toContain(UNKNOWN.topic);
    const post = await linkedIn(r);
    expect(post).not.toContain(UNKNOWN.topic);
    expect(post).not.toContain(SAME.topic);
    expect(md).not.toContain(UNKNOWN.topic + ":");
  });

  it("DeepSeek×2 only (one executing model for both slots): still one model's repeated output — unchanged", async () => {
    const r = await mount(TWO_SUBS, report([SAME]));
    const md = await copied(r);
    expect(md).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
    expect(md).not.toContain(INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON);
  });

  it("two genuinely independent models: nothing relabelled, no unknown-independence wording (unchanged)", async () => {
    const r = await mount(DISTINCT, report([SAME, UNKNOWN, GENUINE]));
    const md = await copied(r);
    expect(md).not.toContain(NON_INDEPENDENT_DISAGREEMENTS_REASON);
    expect(md).not.toContain(INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON);
    const plain = computeVerificationGate({ keyFindings: report([]).keyFindings, disagreements: [SAME, UNKNOWN, GENUINE] as any, questionLength: 41 });
    for (const reason of plain.reasons) expect(md).toContain(reason);
  });
});

describe("NIT n4: unknown execution provenance through PanelSynthesisView (behavioural wiring)", () => {
  it("rows that do not record execution identity: gate 'unverified', disagreements stated as of unknown independence", async () => {
    // Three answering rows plus one row with no model id: which models executed cannot be established.
    const rows = [ok("chatgpt"), ok("claude"), ok("grok"), { status: "failed", rawText: "", latencyMs: 5 } as unknown as ModelResult];
    const r = await mount(rows, report([SAME, GENUINE], 2));
    const md = await copied(r);
    const gateSection = md.slice(md.indexOf("## Verification Gate"), md.indexOf("## Panel Verdict"));
    for (const text of [nodeText(r.root), gateSection]) {
      expect(text).toContain(UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL);
      expect(text).toContain(`${INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON} (2)`);
      expect(text).toContain(`${INDEPENDENCE_UNVERIFIED_UNCERTAIN_CLAIMS_REASON} (2)`);
      expect(text).not.toContain(NON_INDEPENDENT_DISAGREEMENTS_REASON);
      expect(text).not.toContain(SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON);
    }
    // No item is presented as a disagreement between models (the queue's rule for a run without persisted identity).
    expect(crossModelDisagreements([SAME, GENUINE], rows, true)).toEqual([]);
    expect(independenceUnverifiedDisagreements([SAME, GENUINE], rows, true)).toEqual([SAME, GENUINE]);
    const verdictSection = md.slice(md.indexOf("## Panel Verdict"));
    expect(verdictSection).not.toContain("Key disagreement");
    expect(nodeText(r.root)).not.toMatch(/models split/);
  });

  it("rowsRecordExecutionIdentity: empty / missing rows record nothing", () => {
    const { rowsRecordExecutionIdentity } = jest.requireActual("@/lib/panel/independentVoices");
    expect(rowsRecordExecutionIdentity([])).toBe(false);
    expect(rowsRecordExecutionIdentity(null)).toBe(false);
    expect(rowsRecordExecutionIdentity([{ modelId: "chatgpt", status: "ok" }])).toBe(true);
  });
});
