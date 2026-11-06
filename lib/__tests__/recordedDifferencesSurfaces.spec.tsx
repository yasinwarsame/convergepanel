/**
 * Review of 1ee4982 — MINOR-B (owner order C) and NITs N1–N4.
 *
 * MINOR-B: a stored disagreement that is NOT a disagreement between independent executing models (repeated output from
 * one executing model, one independent model, or unknown model independence) keeps its topic and every recorded
 * position, named by the EXECUTING model, in its own clearly labelled section ("Recorded differences not counted as
 * model disagreements") on every surface: the on-screen view, the Panel Verdict card, the copied synthesis, the
 * exported memo, the LinkedIn post and the X post (within its limit). It never appears under "Disagreements" / "Key
 * disagreement" / "Where models disagree", and is never reduced to a count. A genuine independent-model disagreement is
 * unchanged, and a run whose items are all genuine carries no such section anywhere.
 * N1: the card heading over non-genuine items is the recorded-differences heading, not "Key disagreement".
 * N2: the production X post carries the recorded difference when there is no genuine disagreement.
 * N3: lib/ui/socialCopy.buildLinkedInPost states unverified independence and the recorded differences.
 * N4: the single-tweet fallbacks and the memo's precedence are pinned.
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

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import { VerificationActions } from "@/components/VerificationActions";
import {
  buildCopyForXShort,
  buildCopyForXThread,
  buildPanelVerdict,
  formatVerdictText,
  RECORDED_DIFFERENCES_HEADING,
  recordedDifferences,
  type PanelVerdict,
} from "@/lib/verificationGate/panelVerdict";
import { computeVerificationGate } from "@/lib/verificationGate/verificationGate";
import { QUALIFIED_DISAGREEMENT_TEXT } from "@/lib/panel/storedDisagreementIndependence";
import { QUALIFIED_DISAGREEMENTS_HEADING } from "@/components/governance/GovernanceDashboard";
import { buildLinkedInPost } from "@/lib/ui/socialCopy";
import { buildSynthesisMarkdown } from "@/lib/ui/copyFormats";
import { outsideRecordedDifferences, recordedDifferenceSections } from "./recordedDifferencesText";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";
const ok = (modelId: string) => ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5 }) as ModelResult;
const sub = (modelId: string) => ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, provider: "deepseek" }) as ModelResult;
const ANON_FAILED = { status: "failed", rawText: "", latencyMs: 5 } as unknown as ModelResult;
/** Three answering slots plus a row with no model id: which models executed cannot be established. */
const UNKNOWN_PROVENANCE = [ok("chatgpt"), ok("claude"), ok("grok"), ANON_FAILED];
/** ChatGPT and Claude both answered by DeepSeek, plus Grok. */
const COLLAPSED = [sub("chatgpt"), sub("claude"), ok("grok")];
const DISTINCT = [ok("chatgpt"), ok("claude"), ok("grok")];
const SUMMARY = { modelsHealthy: 3, modelCount: 3, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

const SAME = { topic: "Founding year", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "Sources differ." };
const UNATTRIBUTED = { topic: "Founder occupation", positionsByModel: { chatgpt: "merchant" }, whyTheyDiffer: "Only one position recorded." };
const GENUINE = { topic: "First location", positionsByModel: { chatgpt: "Lyon", grok: "Paris" }, whyTheyDiffer: "Archives differ." };
const CROSS3 = { topic: "Seat of power", positionsByModel: { chatgpt: "Paris", claude: "Lyon", grok: "Marseille" }, whyTheyDiffer: "Archives disagree." };

const report = (disagreements: unknown[]): StructuredSynthesis =>
  ({
    executiveSummary: "Founding details vary.",
    keyFindings: [{ claim: "The company was founded in the eighteenth century.", confidence: "High", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude", "grok"], support: { supportingModels: ["chatgpt", "claude", "grok"] }, evidenceQuality: "strong" }],
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
const actions = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(VerificationActions).props;
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");
function card(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  let n: TestRenderer.ReactTestInstance | null = r.root.findAll((x) => x.type === "h3" && nodeText(x) === "Panel Verdict")[0];
  while (n && !(typeof n.props.className === "string" && n.props.className.includes("space-y-5"))) n = n.parent;
  return n!;
}
async function surfaces(r: TestRenderer.ReactTestRenderer) {
  mockCopied.length = 0;
  mockMemos.length = 0;
  await act(async () => {
    await actions(r).onCopy();
    actions(r).onExportMemo();
  });
  const posts: Record<string, string> = {};
  for (const which of ["onGenerateLinkedIn", "onGenerateX"] as const) {
    await act(async () => {
      actions(r)[which]();
    });
    posts[which] = nodeText(r.root.findAll((n) => n.type === "pre")[0]);
  }
  return { markdown: mockCopied[0], memo: mockMemos[0], linkedIn: posts.onGenerateLinkedIn, x: posts.onGenerateX };
}
/** The on-screen "Disagreements" section (orange cards), or null. */
const disagreementsSection = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "h2" && nodeText(n) === "Disagreements")[0]?.parent ?? null;

beforeEach(() => {
  for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

it("the heading is the governance queue's wording", () => {
  expect(RECORDED_DIFFERENCES_HEADING).toBe(QUALIFIED_DISAGREEMENTS_HEADING);
});

describe("MINOR-B: collapsed DeepSeek×2 + Grok — a same-executing-model and an unattributable item, no genuine one", () => {
  const rep = () => report([SAME, UNATTRIBUTED]);

  it("on-screen view: its own section (not under 'Disagreements'), topic, reason, why, positions by EXECUTING model", async () => {
    const r = await mount(COLLAPSED, rep());
    expect(disagreementsSection(r)).toBeNull();
    const section = byTestId(r, "recorded-differences");
    expect(section).toHaveLength(1);
    const t = nodeText(section[0]);
    expect(section[0].findAll((n) => n.type === "h2").map(nodeText)).toEqual([RECORDED_DIFFERENCES_HEADING]);
    for (const s of [SAME.topic, SAME.whyTheyDiffer, QUALIFIED_DISAGREEMENT_TEXT.same_executing_model, "DeepSeek (substituting ChatGPT):1789", "DeepSeek (substituting Claude):1792"]) expect(t).toContain(s);
    for (const s of [UNATTRIBUTED.topic, QUALIFIED_DISAGREEMENT_TEXT.independence_unverified, "DeepSeek (substituting ChatGPT):merchant"]) expect(t).toContain(s);
    // Never named as the requested model.
    expect(t).not.toMatch(/(^|[^(])ChatGPT:/);
    expect(t).not.toMatch(/\d+ models? split|disagreed/i);
  });

  it("verdict card (N1): the column is headed by the recorded-differences heading, never 'Key disagreement', and lists both items", async () => {
    const r = await mount(COLLAPSED, rep());
    const c = nodeText(card(r));
    expect(c).not.toContain("Key disagreement");
    expect(c).toContain(RECORDED_DIFFERENCES_HEADING);
    expect(c).not.toContain("No major disagreements detected.");
    const list = nodeText(byTestId(r, "verdict-recorded-differences")[0]);
    expect(list).toContain(`${SAME.topic}${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}`);
    expect(list).toContain("DeepSeek (substituting Claude): 1792");
    expect(list).toContain(`${UNATTRIBUTED.topic}${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
  });

  it("copied synthesis, memo, LinkedIn: the full section; nothing outside it; never under a disagreement heading", async () => {
    const r = await mount(COLLAPSED, rep());
    const s = await surfaces(r);
    for (const [where, text] of [["markdown", s.markdown], ["memo", s.memo], ["linkedIn", s.linkedIn]] as const) {
      const inside = recordedDifferenceSections(text);
      for (const needle of [SAME.topic, UNATTRIBUTED.topic, "DeepSeek (substituting ChatGPT): 1789", "DeepSeek (substituting Claude): 1792", "DeepSeek (substituting ChatGPT): merchant", QUALIFIED_DISAGREEMENT_TEXT.same_executing_model, QUALIFIED_DISAGREEMENT_TEXT.independence_unverified, SAME.whyTheyDiffer]) {
        expect([where, needle, inside.includes(needle)]).toEqual([where, needle, true]);
      }
      const outside = outsideRecordedDifferences(text);
      for (const needle of [SAME.topic, UNATTRIBUTED.topic, "1789", "merchant"]) expect([where, needle, outside.includes(needle)]).toEqual([where, needle, false]);
      expect([where, /Key disagreement|Where models disagree|WHERE MODELS DISAGREE/.test(text)]).toEqual([where, false]);
    }
    expect(s.memo).toContain("RECORDED DIFFERENCES NOT COUNTED AS MODEL DISAGREEMENTS");
  });

  it("X post (N2): the first recorded difference with its reason and executing-model positions, never 'Models disagreed on'", async () => {
    const r = await mount(COLLAPSED, rep());
    const { x } = await surfaces(r);
    expect(x).not.toContain("Models disagreed on");
    expect(x).toContain(`Recorded difference (${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}): ${SAME.topic} (DeepSeek (substituting ChatGPT): 1789; DeepSeek`);
    expect(outsideRecordedDifferences(x)).not.toContain(SAME.topic);
  });
});

describe("MINOR-B: unknown provenance (rows do not record which model executed)", () => {
  it("every stored item is kept, labelled 'Model independence unverified', positions named from the stored rows only", async () => {
    const r = await mount(UNKNOWN_PROVENANCE, report([CROSS3]));
    expect(disagreementsSection(r)).toBeNull();
    const view = nodeText(byTestId(r, "recorded-differences")[0]);
    expect(view).toContain(`${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}${CROSS3.topic}`);
    for (const p of ["ChatGPT:Paris", "Claude:Lyon", "Grok:Marseille"]) expect(view).toContain(p);
    // No substitution is invented: no row says substituted.
    expect(view).not.toContain("substituting");
    const s = await surfaces(r);
    for (const text of [s.markdown, s.memo, s.linkedIn]) {
      expect(recordedDifferenceSections(text)).toContain(`${CROSS3.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
      expect(recordedDifferenceSections(text)).toContain("Grok: Marseille");
      expect(outsideRecordedDifferences(text)).not.toContain(CROSS3.topic);
    }
    expect(s.x).toContain(`Recorded difference (${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}): ${CROSS3.topic}`);
    expect(nodeText(card(r))).not.toContain("Key disagreement");
  });
});

describe("genuine independent-model disagreement is unchanged", () => {
  it("collapsed run with a genuine item: it stays the key disagreement and the only orange card; the others are separate", async () => {
    const r = await mount(COLLAPSED, report([SAME, GENUINE, UNATTRIBUTED]));
    const dis = disagreementsSection(r)!;
    expect(dis.findAll((n) => n.type === "h3").map(nodeText)).toEqual([GENUINE.topic]);
    expect(nodeText(byTestId(r, "recorded-differences")[0])).not.toContain(GENUINE.topic);
    const c = nodeText(card(r));
    expect(c).toContain("Key disagreement");
    expect(c).toContain("2 models split");
    const s = await surfaces(r);
    expect(s.linkedIn).toContain(`Where models disagree:\n→ ${GENUINE.topic}: ${GENUINE.whyTheyDiffer}`);
    expect(s.x).toContain(`Models disagreed on: ${GENUINE.topic}`);
    expect(s.x).not.toContain("Recorded difference");
    expect(s.memo).toContain(`WHERE MODELS DISAGREE\n- ${GENUINE.topic}: ${GENUINE.whyTheyDiffer}`);
    expect(s.markdown).toContain(`Key disagreement:\n- Topic: ${GENUINE.topic}`);
    for (const text of [s.linkedIn, s.memo, s.markdown]) expect(recordedDifferenceSections(text)).not.toContain(GENUINE.topic);
  });

  it("independent models, all items genuine: no recorded-differences section anywhere, no new verdict key", async () => {
    const r = await mount(DISTINCT, report([SAME, CROSS3]));
    expect(byTestId(r, "recorded-differences")).toHaveLength(0);
    expect(byTestId(r, "verdict-recorded-differences")).toHaveLength(0);
    const s = await surfaces(r);
    for (const text of [...Object.values(s), nodeText(r.root)]) {
      expect(text).not.toContain(RECORDED_DIFFERENCES_HEADING);
      expect(text).not.toContain("RECORDED DIFFERENCES");
      expect(text).not.toContain("Recorded difference");
    }
    const v = buildPanelVerdict("Q?", report([SAME, CROSS3]), computeVerificationGate({}), DISTINCT, { crossModel: true });
    expect(Object.keys(v)).not.toContain("recordedDifferences");
    expect(recordedDifferences([SAME, CROSS3], DISTINCT, true)).toEqual([]);
    expect(recordedDifferences([SAME, CROSS3], null, true)).toEqual([]);
  });
});

describe("recordedDifferences is the exact complement of crossModelDisagreements", () => {
  it("bases: below two models / unknown provenance / collapsed", () => {
    expect(recordedDifferences([SAME, GENUINE], COLLAPSED, false).map((d) => d.basis)).toEqual(["single_independent_model", "single_independent_model"]);
    expect(recordedDifferences([SAME, GENUINE], UNKNOWN_PROVENANCE, true).map((d) => d.basis)).toEqual(["independence_unverified", "independence_unverified"]);
    expect(recordedDifferences([SAME, GENUINE, UNATTRIBUTED], COLLAPSED, true).map((d) => [d.topic, d.basis])).toEqual([
      [SAME.topic, "same_executing_model"],
      [UNATTRIBUTED.topic, "independence_unverified"],
    ]);
    expect(recordedDifferences(null, COLLAPSED, true)).toEqual([]);
  });
  it("stored text is never rewritten; non-string positions are skipped", () => {
    const item = { topic: "T", positionsByModel: { chatgpt: "a", claude: 7 as unknown as string }, whyTheyDiffer: " " };
    const before = JSON.stringify(item);
    expect(recordedDifferences([item], COLLAPSED, false)).toEqual([
      { topic: "T", whyTheyDiffer: null, basis: "single_independent_model", basisText: QUALIFIED_DISAGREEMENT_TEXT.single_independent_model, positions: [{ voice: "DeepSeek (substituting ChatGPT)", position: "a" }] },
    ]);
    expect(JSON.stringify(item)).toBe(before);
  });
});

describe("builders on their own (N3, N4)", () => {
  const gate = computeVerificationGate({});
  const collapsedVerdict = (q = "Q?", consensus = "Yes."): PanelVerdict => ({ ...buildPanelVerdict(q, report([SAME]), gate, COLLAPSED, { crossModel: true }), keyBlindSpot: null, topConsensus: consensus });

  it("buildSynthesisMarkdown / formatVerdictText / X thread carry the full section", () => {
    const v = collapsedVerdict();
    const md = buildSynthesisMarkdown("Q?", gate, v, { total: 3, responded: 3, substitutedCount: 2, failedCount: 0 });
    const expected = `${RECORDED_DIFFERENCES_HEADING}:\n- ${SAME.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}\n  ${SAME.whyTheyDiffer}\n  DeepSeek (substituting ChatGPT): 1789\n  DeepSeek (substituting Claude): 1792`;
    expect(md).toContain(expected);
    expect(formatVerdictText(v, "linkedin")).toContain(expected);
    expect(buildCopyForXThread(v).join(" ")).toContain(QUALIFIED_DISAGREEMENT_TEXT.same_executing_model);
  });

  it("N3 socialCopy.buildLinkedInPost: unverified independence states no consensus / count; recorded differences in full", () => {
    const health = { total: 4, responded: 3, substituted: 0, failed: 1 };
    const unverified = buildPanelVerdict("Q?", report([CROSS3]), gate, UNKNOWN_PROVENANCE, { crossModel: true });
    const post = buildLinkedInPost({ question: "Q?", gate, verdict: unverified, modelHealth: health });
    expect(post).toContain("Finding (model independence unverified; not confirmed as a consensus): ");
    expect(post).not.toMatch(/(^|\n)Consensus:/);
    expect(post).not.toMatch(/Agreed by \d+ model/);
    expect(post).not.toContain("highlights consensus, disagreements");
    expect(post).toContain("Model independence is unverified, so this is not presented as a cross-model comparison.");
    expect(recordedDifferenceSections(post)).toContain(`• ${CROSS3.topic} — ${QUALIFIED_DISAGREEMENT_TEXT.independence_unverified}`);
    expect(outsideRecordedDifferences(post)).not.toContain(CROSS3.topic);
    // Control: independent models keep "Consensus: … Agreed by N models." and the product tagline.
    const distinct = buildPanelVerdict("Q?", report([]), gate, DISTINCT, { crossModel: true });
    const ctl = buildLinkedInPost({ question: "Q?", gate, verdict: distinct, modelHealth: { total: 3, responded: 3, substituted: 0, failed: 0 } });
    expect(ctl).toMatch(/\nConsensus: .* Agreed by 3 models\./);
    expect(ctl).toContain("highlights consensus, disagreements, and blind spots.");
  });

  it("N4 buildCopyForXShort: full line when it fits; without positions when only that fits; dropped when nothing fits", () => {
    const head = `Recorded difference (${QUALIFIED_DISAGREEMENT_TEXT.same_executing_model}): ${SAME.topic}`;
    const short = buildCopyForXShort(collapsedVerdict());
    expect(short).toContain(`${head} — DeepSeek (substituting ChatGPT): 1789; DeepSeek (substituting Claude): 1792`);
    expect(short.length).toBeLessThanOrEqual(280);
    // A question that leaves room for the head but not the positions.
    const mid = buildCopyForXShort(collapsedVerdict("Q".repeat(60) + "?"));
    expect(mid).toContain(`${head}\n`);
    expect(mid).not.toContain("1789");
    expect(mid.length).toBeLessThanOrEqual(280);
    // No room at all: the line goes before anything else; never an absence claim in its place.
    const none = buildCopyForXShort(collapsedVerdict("Q".repeat(119) + "?", "A".repeat(100) + "."));
    expect(none).not.toContain("Recorded difference");
    expect(none).not.toContain("No major disagreements");
  });

  it("N4 memo precedence: one independent model wins over an (inconsistent) unverified flag", () => {
    const { generateVerificationMemo } = jest.requireActual("@/lib/verification/generateMemo");
    const memo = generateVerificationMemo({ type: "research", question: "Q?", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "r", independentModelCount: 1, researchIndependenceUnverified: true });
    expect(memo).toContain("CONSENSUS SCORE: none (fewer than two independent models responded");
    expect(memo).not.toContain("withheld");
    const unv = generateVerificationMemo({ type: "research", question: "Q?", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "r", independentModelCount: 3, researchIndependenceUnverified: true });
    expect(unv).toContain("CONSENSUS SCORE: withheld");
  });
});
