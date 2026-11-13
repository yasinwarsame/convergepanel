/**
 * Review of 71b03e3 — MINOR-1 / MINOR-2 (owner order) and NIT-1 / NIT-2.
 *
 * MINOR-1: under UNKNOWN execution provenance (rows that do not record which model executed, while ≥ 2 slots answered)
 * no surface presents a multi-model consensus: no unqualified "Top consensus", no "Agreed by N models", no consensus score,
 * no "Where models agree", and no "No major disagreements detected." — on the Panel Verdict card, the copied synthesis,
 * the LinkedIn and X posts, the consensus summary box, the per-finding support line and the exported memo.
 * MINOR-2: in a run with ≥ 2 independent executing models whose only stored disagreements are repeated output from one
 * executing model, or of unknown independence, the verdict states each category (the gate's wording, with counts) instead
 * of "No major disagreements detected."; a genuine cross-model item is still the key disagreement, as before.
 * Unaffected rows (independent models, recorded identity; single-model runs) keep their presentation.
 * NIT-1: the unknown-independence disagreement step is never added under unknown provenance (mutant pin).
 * NIT-2: openHistoryItem only lets the latest selection commit after an await (source wiring; the page cannot be mounted).
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
const mockMemos: string[] = [];
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return { ...actual, downloadTextFile: (text: string) => void mockMemos.push(text) };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import { VerificationActions } from "@/components/VerificationActions";
import {
  buildCopyForXShort,
  buildCopyForXThread,
  buildPanelVerdict,
  formatVerdictText,
} from "@/lib/verificationGate/panelVerdict";
import {
  computeVerificationGate,
  INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON,
  INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_STEP,
  NON_INDEPENDENT_DISAGREEMENTS_REASON,
  UNVERIFIED_INDEPENDENT_COVERAGE_GATE_STEP,
} from "@/lib/verificationGate/verificationGate";
import type { ModelResult } from "@/lib/types";
import { RECORDED_DIFFERENCES_HEADING } from "@/lib/verificationGate/panelVerdict";
import { QUALIFIED_DISAGREEMENT_TEXT } from "@/lib/panel/storedDisagreementIndependence";
import { outsideRecordedDifferences } from "./recordedDifferencesText";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";
// C-a (corrected D-4 gate): a 6.2a+ ok row records its runtime provider; a provider-less ok row is a pre-6.2a row (UV).
// Order 33 (ruling B): the runtime provider is a registered canonical provider (was the placeholder `${modelId}-provider`).
const OWN_PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const ok = (modelId: string) => ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5, provider: OWN_PROVIDER[modelId] }) as ModelResult;
const sub = (modelId: string) => ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, provider: "deepseek" }) as ModelResult;
/** A failed row that records no model id: which models executed cannot be established (gate coverage "unverified"). */
const ANON_FAILED = { status: "failed", rawText: "", latencyMs: 5 } as unknown as ModelResult;
const UNKNOWN_PROVENANCE = [ok("chatgpt"), ok("claude"), ok("grok"), ANON_FAILED];
/** ChatGPT and Claude both answered by the DeepSeek fallback, plus Grok: two independent executing models, collapsed. */
const COLLAPSED = [sub("chatgpt"), sub("claude"), ok("grok")];
const TWO_SUBS = [sub("chatgpt"), sub("claude")];
const DISTINCT = [ok("chatgpt"), ok("claude"), ok("grok")];
const SUMMARY = { modelsHealthy: 3, modelCount: 3, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

const SAME = { topic: "Founding year", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "Sources differ." };
const UNKNOWN = { topic: "Founder occupation", positionsByModel: { chatgpt: "merchant" }, whyTheyDiffer: "Only one position recorded." };
const GENUINE = { topic: "First location", positionsByModel: { chatgpt: "Lyon", grok: "Paris" }, whyTheyDiffer: "Archives differ." };
const CROSS3 = { topic: "Seat of power", positionsByModel: { chatgpt: "Paris", claude: "Lyon", grok: "Marseille" }, whyTheyDiffer: "Archives differ." };

const report = (disagreements: unknown[]): StructuredSynthesis =>
  ({
    executiveSummary: "Founding details vary.",
    keyFindings: [
      {
        claim: "The company was founded in the eighteenth century.",
        confidence: "High",
        evidenceRefs: [],
        modelsSupporting: ["chatgpt", "claude", "grok"],
        support: { supportingModels: ["chatgpt", "claude", "grok"] },
        evidenceQuality: "strong",
      },
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
      createElement(PanelSynthesisView as never, {
        results,
        question: "When was the company founded and by whom?",
        runId: "run-1",
        preGeneratedStatus: "complete",
        preGeneratedReport: rep,
        preGeneratedConsensusSummary: SUMMARY,
      } as never)
    );
  });
  mounted.push(r);
  return r;
}
const actions = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(VerificationActions).props;
/** The Panel Verdict card: the element whose text starts the "Panel Verdict" header. */
function verdictCardText(r: TestRenderer.ReactTestRenderer): string {
  const h = r.root.findAll((n) => n.type === "h3" && nodeText(n) === "Panel Verdict")[0];
  let n: TestRenderer.ReactTestInstance | null = h;
  // Climb to the card's padded body (contains the question and both columns).
  while (n && !(typeof n.props.className === "string" && n.props.className.includes("space-y-5"))) n = n.parent;
  return nodeText(n!);
}
async function copied(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockCopied.length = 0;
  await act(async () => {
    await actions(r).onCopy();
  });
  return mockCopied[0];
}
async function post(r: TestRenderer.ReactTestRenderer, which: "onGenerateLinkedIn" | "onGenerateX"): Promise<string> {
  await act(async () => {
    actions(r)[which]();
  });
  return nodeText(r.root.findAll((n) => n.type === "pre")[0]);
}
async function memo(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockMemos.length = 0;
  await act(async () => {
    actions(r).onExportMemo();
  });
  return mockMemos[0];
}
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");

beforeEach(() => {
  for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

describe("MINOR-1: unknown execution provenance (3 answering slots + a row with no model id)", () => {
  it("Panel Verdict card: qualified heading, no 'Agreed by', the stored disagreement stated as of unknown independence", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    const card = verdictCardText(r);
    expect(card).toContain("Top finding (model independence unverified; not confirmed as a consensus)");
    expect(card).not.toContain("Top consensus");
    expect(card).not.toMatch(/Agreed by \d+ model/);
    expect(card).not.toContain("No major disagreements detected.");
    // MINOR-B (review of 1ee4982): the stored item is kept as evidence under its own heading, not as a key disagreement.
    expect(card).toContain(RECORDED_DIFFERENCES_HEADING);
    expect(card).not.toContain("Key disagreement");
    expect(nodeText(byTestId(r, "verdict-recorded-differences")[0])).toContain(`${CROSS3.topic}${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
    expect(card).not.toMatch(/\d+ models? split/);
  });

  it("Panel Verdict card with no stored disagreement: no absence-of-disagreement claim", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([]));
    const card = verdictCardText(r);
    expect(card).not.toContain("No major disagreements detected.");
    expect(card).toContain("No disagreements recorded, but model independence is unverified: this is not evidence of agreement between models.");
  });

  it("consensus summary box and per-finding support: score withheld, no independent-model counts", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    const all = nodeText(r.root);
    expect(all).not.toContain("Consensus summary");
    expect(all).not.toContain("90/100");
    expect(byTestId(r, "consensus-independence-unverified")).toHaveLength(1);
    expect(byTestId(r, "consensus-insufficient-independent-models")).toHaveLength(0);
    expect(all).not.toMatch(/Supported by \d+\/\d+ models/);
    expect(all).not.toMatch(/\b3 models: /);
    expect(all).toContain("Supporting slots (model independence unverified): ");
  });

  it("copied synthesis: no 'Top consensus:', the differing positions stated by category", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    const text = await copied(r);
    expect(text).not.toContain("Top consensus:");
    expect(text).toContain("Top finding (model independence unverified; not confirmed as a consensus):");
    expect(text).not.toContain("No major disagreements detected.");
    expect(text).not.toContain("Key disagreement:");
    expect(text).toContain(`${RECORDED_DIFFERENCES_HEADING}:\n- ${CROSS3.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
  });

  it("LinkedIn post: no consensus score, no 'Where models agree', no model-count claim", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    const text = await post(r, "onGenerateLinkedIn");
    expect(text).not.toContain("Consensus score: 90/100");
    expect(text).not.toMatch(/Consensus score: \d/);
    expect(text).not.toContain("Where models agree");
    expect(text).not.toMatch(/across \d+ models/);
    expect(text).not.toContain("The disagreements tell you more than any single answer.");
    expect(text).toContain("Consensus score withheld: which models actually answered could not be established (model independence unverified).");
    expect(text).toContain(`${RECORDED_DIFFERENCES_HEADING}:\n→ ${CROSS3.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
    expect(text).not.toContain("Where models disagree");
  });

  it("X post: no consensus score, no 'Asked N models'", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    const text = await post(r, "onGenerateX");
    expect(text).not.toMatch(/Consensus: \d+\/100/);
    expect(text).not.toMatch(/Asked \d+ models/);
    expect(text).not.toContain("Five give you the shape of the problem.");
    expect(text).toContain("Asked a model panel (model independence unverified)");
  });

  it("exported memo: consensus score withheld, no 'where models agree'", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    const text = await memo(r);
    expect(text).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
    expect(text).not.toContain("CONSENSUS SCORE: 90/100");
    expect(text).not.toContain("WHERE MODELS AGREE");
    expect(text).not.toMatch(/\d+ AI models researched this question independently/);
  });

  it("verdict builders: the share texts carry the qualified prefix and the category, never 'Consensus:'", () => {
    const rep = report([CROSS3]);
    const gate = computeVerificationGate({ keyFindings: rep.keyFindings as never, disagreements: [CROSS3], executionProvenanceUnverified: true });
    const v = buildPanelVerdict("Q?", rep, gate, UNKNOWN_PROVENANCE, { crossModel: true });
    expect(v.independenceUnverified).toBe(true);
    expect(v.topDisagreement).toBeNull();
    expect(v.recordedDifferences?.map((d) => [d.topic, d.basis])).toEqual([[CROSS3.topic, "independence_unverified"]]);
    for (const text of [formatVerdictText(v, "linkedin"), buildCopyForXShort(v), buildCopyForXThread(v).join("\n")]) {
      expect(text).not.toMatch(/(^|\n)(\d+\/\d+ )?Consensus:/);
      expect(text).toContain("Finding (model independence unverified; not confirmed as a consensus):");
    }
    // The long forms keep the item in full; the single tweet keeps it while it fits (see the MINOR-B X block).
    expect(formatVerdictText(v, "linkedin")).toContain(`- ${CROSS3.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
    expect(buildCopyForXThread(v).join(" ")).toContain(QUALIFIED_DISAGREEMENT_TEXT.independence_unverified);
  });
});

describe("MINOR-2: collapsed run (DeepSeek serves ChatGPT and Claude, plus Grok) — non-genuine items are stated, not erased", () => {
  it("only a same-executing-model difference: stated as repeated output, never 'No major disagreements detected.'", async () => {
    const r = await mount(COLLAPSED, report([SAME]));
    const card = verdictCardText(r);
    expect(card).not.toContain("No major disagreements detected.");
    expect(nodeText(byTestId(r, "verdict-recorded-differences")[0])).toContain(`${SAME.topic}${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}`);
    // ≥ 2 independent models with recorded identity: the consensus presentation itself is unchanged.
    expect(card).toContain("Top consensus");
    const text = await copied(r);
    expect(text).toContain("Top consensus:");
    expect(text).toContain(`${RECORDED_DIFFERENCES_HEADING}:\n- ${SAME.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}`);
  });

  it("only an unattributable (unknown-independence) difference: stated as such", async () => {
    const r = await mount(COLLAPSED, report([UNKNOWN]));
    const card = verdictCardText(r);
    expect(card).not.toContain("No major disagreements detected.");
    expect(nodeText(byTestId(r, "verdict-recorded-differences")[0])).toContain(`${UNKNOWN.topic}${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
    expect(await copied(r)).toContain(`- ${UNKNOWN.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
  });

  it("both categories: every item kept, each with its own reason, in stored order", async () => {
    const r = await mount(COLLAPSED, report([SAME, UNKNOWN, SAME]));
    const list = byTestId(r, "verdict-recorded-differences")[0];
    expect(list.children.filter((c) => typeof c !== "string" && c.type === "li").map((li) => nodeText(li as never).split(":")[0])).toEqual([
      `${SAME.topic}${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}${SAME.whyTheyDiffer}DeepSeek (substituting ChatGPT)`,
      `${UNKNOWN.topic}${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}${UNKNOWN.whyTheyDiffer}DeepSeek (substituting ChatGPT)`,
      `${SAME.topic}${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}${SAME.whyTheyDiffer}DeepSeek (substituting ChatGPT)`,
    ]);
  });

  it("a genuine cross-model item: it is the key disagreement (as before); the others are kept in their own block", async () => {
    const r = await mount(COLLAPSED, report([SAME, GENUINE, UNKNOWN]));
    const card = verdictCardText(r);
    expect(card).toContain("Key disagreement");
    expect(card).toContain("First location");
    // C-a E01 (PC: 2 independent executing models over 3 slots): the count carries its unit.
    expect(card).toContain("2 independent executing models split");
    const block = byTestId(r, "verdict-recorded-differences");
    expect(block).toHaveLength(1);
    expect(nodeText(block[0])).toContain(SAME.topic);
    expect(nodeText(block[0])).toContain(UNKNOWN.topic);
    expect(nodeText(block[0])).not.toContain(GENUINE.topic);
    const v = buildPanelVerdict("Q?", report([SAME, GENUINE, UNKNOWN]), computeVerificationGate({}), COLLAPSED, { crossModel: true });
    expect(v.topDisagreement).toBe(GENUINE.topic);
    expect(v.recordedDifferences?.map((d) => d.topic)).toEqual([SAME.topic, UNKNOWN.topic]);
    expect(Object.keys(v)).not.toContain("independenceUnverified");
    const md = await copied(r);
    expect(md).toContain(`Key disagreement:\n- Topic: ${GENUINE.topic}`);
    expect(outsideRecordedDifferences(md)).not.toContain(SAME.topic);
  });
});

describe("unaffected rows keep their presentation", () => {
  it("independent models, recorded identity, no disagreement: 'Top consensus', 'Agreed by 3 models', 'No major disagreements detected.'", async () => {
    const r = await mount(DISTINCT, report([]));
    const card = verdictCardText(r);
    expect(card).toContain("Top consensus");
    expect(card).toContain("Agreed by 3 models");
    expect(card).toContain("No major disagreements detected.");
    expect(nodeText(r.root)).toContain("Consensus summary");
    expect(await post(r, "onGenerateLinkedIn")).toContain("Consensus score: 90/100");
    const v = buildPanelVerdict("Q?", report([CROSS3]), computeVerificationGate({}), DISTINCT, { crossModel: true });
    expect(Object.keys(v).sort()).toEqual(
      ["question", "crossModel", "topConsensus", "consensusModelCount", "topDisagreement", "disagreementDetail", "disagreementModelCount", "gateLabel", "gateStatus", "keyBlindSpot", "grounding", "recommendedNextSteps"].sort()
    );
  });

  it("single independent model (two DeepSeek-served slots): the single-model wording, unchanged; stored item kept as evidence", async () => {
    const r = await mount(TWO_SUBS, report([SAME]));
    const card = verdictCardText(r);
    expect(card).toContain("Top finding (one independent model; not a consensus)");
    expect(card).toContain("No cross-model comparison: fewer than two independent models responded.");
    expect(card).not.toContain("model independence unverified");
    // MINOR-B: the one model's stored differing positions are kept as evidence, labelled as one independent model.
    expect(nodeText(byTestId(r, "verdict-recorded-differences")[0])).toContain(`${SAME.topic}${QUALIFIED_DISAGREEMENT_TEXT.single_independent_model}`);
    expect(card).not.toContain("Key disagreement");
    expect(byTestId(r, "consensus-insufficient-independent-models")).toHaveLength(1);
    expect(byTestId(r, "consensus-independence-unverified")).toHaveLength(0);
  });
});

describe("NIT-1: under unknown provenance the coverage step stands alone (no duplicate unknown-independence step)", () => {
  it("items of unknown independence add their reason, not INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_STEP", () => {
    const g = computeVerificationGate({ disagreements: [CROSS3, SAME], executionProvenanceUnverified: true, independentModelCount: 3 });
    expect(g.reasons).toContain(`${INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_REASON} (2)`);
    expect(g.recommendedNextSteps).toContain(UNVERIFIED_INDEPENDENT_COVERAGE_GATE_STEP);
    expect(g.recommendedNextSteps).not.toContain(INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_STEP);
  });
  it("control: with ≥ 2 independent models the unknown-independence step IS added", () => {
    const g = computeVerificationGate({
      disagreements: [UNKNOWN],
      independentDisagreements: [],
      independenceUnverifiedDisagreements: [UNKNOWN],
      independentModelCount: 2,
    });
    expect(g.recommendedNextSteps).toContain(INDEPENDENCE_UNVERIFIED_DISAGREEMENTS_STEP);
  });
});

describe("NIT-2: openHistoryItem commits only the latest selection (app/page.tsx wiring)", () => {
  // Superseded by MINOR-A of the 1ee4982 review: the sequence guard and the loading indicator now live in
  // lib/client/historyDetailOpen.ts, tested behaviourally (quick switch, slow/cached/rejected reads, stale completions)
  // in lib/__tests__/historyDetailOpen.spec.ts, which also pins this page wiring.
  const src = readFileSync(join(__dirname, "..", "..", "app", "page.tsx"), "utf8");
  const open = src.slice(src.indexOf("const openHistoryItem = async"), src.indexOf("openHistoryItemRef.current = openHistoryItem;"));
  it("both reads go through the coordinator; no ad-hoc sequence remains", () => {
    expect(open).toContain("await openSavedClaimVerification(opens, item, lookup, {");
    expect(open).toContain("await openSavedVideoVerification(opens, item.id, read, {");
    expect(src).not.toContain("historyOpenSeq");
  });
});
