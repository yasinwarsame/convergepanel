/**
 * Fewer than two independent executing models → no consensus anywhere the panel synthesis is shared
 * (connector fail-closed correction pass, findings A–C).
 *
 *  A. PanelSynthesisView share / copy / memo text and the Panel Verdict card mirror the on-screen "No consensus score"
 *     treatment: a history run whose two slots were both answered by DeepSeek, with a stored consensus summary of 90,
 *     publishes no consensus score, no "Where models agree" / "Top consensus" and no "agreed by" count.
 *  B. Panel Verdict disagreement counts and Key Finding severity count independent executing models, not slots.
 *  C. The client synthesis gates (app/page.tsx pre-flight and history auto-synthesis, PanelSynthesisView) and the server
 *     gate (authoritativeSynthesisInputs) agree on the same row sets.
 * Real components (react-test-renderer), real verdict / memo / markdown builders; only I/O is mocked.
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
const mockDownloads: Array<[string, string]> = [];
const mockMemoInputs: any[] = [];
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return {
    ...actual,
    downloadTextFile: (content: string, name: string) => mockDownloads.push([content, name]),
    generateVerificationMemo: (input: any) => (mockMemoInputs.push(input), actual.generateVerificationMemo(input)),
  };
});
const mockCopied: string[] = [];
jest.mock("@/lib/ui/copyFormats", () => {
  const actual = jest.requireActual("@/lib/ui/copyFormats");
  return { ...actual, copyToClipboardWithFallback: async (text: string) => (mockCopied.push(text), true) };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import { readFileSync } from "fs";
import { join } from "path";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import { VerificationActions } from "@/components/VerificationActions";
import { buildPanelVerdict, formatVerdictText, buildCopyForXShort, NO_CONSENSUS_SCORE_SHARE_LINE, PANEL_VERDICT_SINGLE_MODEL_HEADING, SINGLE_MODEL_SHARE_TAGLINE } from "@/lib/verificationGate/panelVerdict";
import { computeVerificationGate } from "@/lib/verificationGate/verificationGate";
import { buildLinkedInPost } from "@/lib/ui/socialCopy";
import { authoritativeSynthesisInputs } from "@/lib/synthesis/authoritativeRunInputs";
import { meetsIndependentSynthesisMinimum } from "@/lib/panel/independentVoices";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";
const ok = (modelId: string, provider?: string) => ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5, ...(provider ? { provider } : {}) }) as ModelResult;
const sub = (modelId: string, provider: string | undefined = "deepseek") => ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, ...(provider ? { provider } : {}) }) as ModelResult;
const failed = (modelId: string) => ({ modelId, status: "failed", rawText: null, latencyMs: 5 }) as unknown as ModelResult;

const TWO_SUBS = [sub("chatgpt"), sub("claude")];
const TWO_SUBS_PLUS_GROK = [sub("chatgpt"), sub("claude"), ok("grok", "xai")];
const DISTINCT_REAL = [ok("chatgpt", "openai"), ok("claude", "anthropic"), ok("grok", "xai")];
const SUMMARY = { modelsHealthy: 2, modelCount: 2, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

const report = (modelsSupporting: string[], extra: Partial<StructuredSynthesis> = {}): StructuredSynthesis =>
  ({
    executiveSummary: "Paris is the capital.",
    keyFindings: [{ claim: "Paris is the capital of France.", confidence: "High", evidenceRefs: ["r1"], modelsSupporting }],
    disagreements: [{ topic: "Founding date", positionsByModel: Object.fromEntries(modelsSupporting.map((m, i) => [m, `Position ${i}`])), whyTheyDiffer: "Sources differ." }],
    biasAndBlindSpots: [],
    openQuestions: [],
    methodology: "Cross-model comparison.",
    ...extra,
  }) as unknown as StructuredSynthesis;

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function mountSynthesis(results: ModelResult[], rep: StructuredSynthesis, summary: any = SUMMARY) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(PanelSynthesisView as never, { results, question: "What is the capital of France?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: rep, preGeneratedConsensusSummary: summary } as never)
    );
  });
  mounted.push(r);
  return r;
}
const actions = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(VerificationActions).props;
async function generatedPost(r: TestRenderer.ReactTestRenderer, which: "onGenerateLinkedIn" | "onGenerateX"): Promise<string> {
  await act(async () => {
    actions(r)[which]();
  });
  return nodeText(r.root.findAll((n) => n.type === "pre")[0]);
}
async function memo(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockDownloads.length = 0;
  mockMemoInputs.length = 0;
  await act(async () => {
    actions(r).onExportMemo();
  });
  expect(mockDownloads).toHaveLength(1);
  return mockDownloads[0][0];
}
async function copied(r: TestRenderer.ReactTestRenderer): Promise<string> {
  mockCopied.length = 0;
  await act(async () => {
    await actions(r).onCopy();
  });
  expect(mockCopied).toHaveLength(1);
  return mockCopied[0];
}
const verdictCardText = (r: TestRenderer.ReactTestRenderer) => nodeText(r.root.findAll((n) => n.type === "h3" && nodeText(n) === "Panel Verdict")[0].parent!.parent!.parent!);

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

// ─── A: share / copy / memo / verdict card ──────────────────────────────────

describe("A. two slots answered by DeepSeek (one independent model), stored consensus summary 90", () => {
  it("LinkedIn post: no consensus score, no 'Where models agree', model count is 1", async () => {
    const r = await mountSynthesis(TWO_SUBS, report(["chatgpt", "claude"]));
    const post = await generatedPost(r, "onGenerateLinkedIn");
    expect(post).not.toContain("90/100");
    expect(post).not.toMatch(/Consensus score/);
    expect(post).not.toContain("Where models agree");
    expect(post).toContain(NO_CONSENSUS_SCORE_SHARE_LINE);
    expect(post).toContain("only 1 model responded independently");
    expect(post).not.toContain("simultaneously");
    expect(post).not.toContain("5 AI models");
    expect(post).not.toContain("The disagreements tell you more");
    expect(post).toContain(SINGLE_MODEL_SHARE_TAGLINE);
  });

  it("X post: no consensus score, model count is 1", async () => {
    const r = await mountSynthesis(TWO_SUBS, report(["chatgpt", "claude"]));
    const post = await generatedPost(r, "onGenerateX");
    expect(post).not.toContain("90/100");
    expect(post).not.toMatch(/^Consensus:/m);
    expect(post).toContain(NO_CONSENSUS_SCORE_SHARE_LINE);
    expect(post).toMatch(/^Asked a model panel \(1 model responded independently\): /);
    expect(post).not.toContain("Five give you the shape");
    expect(post).toContain(SINGLE_MODEL_SHARE_TAGLINE);
  });

  it("memo: no consensus score, no 'WHERE MODELS AGREE', not '2 AI models researched'", async () => {
    const r = await mountSynthesis(TWO_SUBS, report(["chatgpt", "claude"]));
    const text = await memo(r);
    expect(text).not.toContain("90/100");
    expect(text).toContain("CONSENSUS SCORE: none (fewer than two independent models responded");
    expect(text).not.toContain("WHERE MODELS AGREE");
    expect(text).not.toMatch(/\d+ AI models researched this question independently/);
    // Each layer holds on its own: the view passes no agreements and the independent count…
    expect(mockMemoInputs).toHaveLength(1);
    expect([mockMemoInputs[0].synthesisAgreements, mockMemoInputs[0].independentModelCount]).toEqual([[], 1]);
  });

  it("memo generator alone: independentModelCount < 2 suppresses the score and 'WHERE MODELS AGREE' even when agreements are supplied", () => {
    const { generateVerificationMemo } = jest.requireActual("@/lib/verification/generateMemo");
    const base = { type: "research", question: "q", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", verificationId: "r", keyFindings: ["F"], synthesisAgreements: ["A"], modelsUsed: ["x", "y"] };
    const one = generateVerificationMemo({ ...base, independentModelCount: 1 });
    expect(one).not.toContain("WHERE MODELS AGREE");
    expect(one).not.toContain("90/100");
    const two = generateVerificationMemo({ ...base, independentModelCount: 2 });
    expect(two).toContain("WHERE MODELS AGREE");
    expect(two).toContain("CONSENSUS SCORE: 90/100");
    // Absent → the memo exactly as before this field existed.
    expect(generateVerificationMemo(base)).toBe(generateVerificationMemo({ ...base, independentModelCount: undefined }));
    expect(generateVerificationMemo(base)).toContain("2 AI models researched this question independently.");
  });

  it("copied synthesis markdown: no 'Top consensus'", async () => {
    const r = await mountSynthesis(TWO_SUBS, report(["chatgpt", "claude"]));
    const md = await copied(r);
    expect(md).not.toContain("Top consensus");
    expect(md).toContain(`${PANEL_VERDICT_SINGLE_MODEL_HEADING}:`);
  });

  it("Panel Verdict card: no 'Top consensus', no 'Agreed by', no 'models split'", async () => {
    const r = await mountSynthesis(TWO_SUBS, report(["chatgpt", "claude"]));
    const card = verdictCardText(r);
    expect(card).not.toContain("Top consensus");
    expect(card).toContain(PANEL_VERDICT_SINGLE_MODEL_HEADING);
    expect(card).not.toMatch(/Agreed by \d/);
    expect(card).not.toMatch(/\d models? split/);
    expect(nodeText(r.root)).toContain("No consensus score: fewer than two independent models responded.");
  });
});

describe("A (controls): at least two independent executing models keep the consensus text", () => {
  it.each([
    ["two substitutions + Grok", 2, TWO_SUBS_PLUS_GROK],
    ["distinct real providers", 3, DISTINCT_REAL],
  ] as const)("%s: score, 'Where models agree', 'Top consensus', model count %i", async (_n, n, rows) => {
    const r = await mountSynthesis([...rows], report(rows.map((x) => x.modelId)), { ...SUMMARY, modelsHealthy: n, modelCount: rows.length });
    const li = await generatedPost(r, "onGenerateLinkedIn");
    expect(li).toContain("Consensus score: 90/100");
    expect(li).toContain("Where models agree:");
    expect(li).toContain(`across ${n} models simultaneously`);
    expect(li).not.toContain(NO_CONSENSUS_SCORE_SHARE_LINE);
    const x = await generatedPost(r, "onGenerateX");
    expect(x).toContain("Consensus: 90/100");
    expect(x).toMatch(new RegExp(`^Asked ${n} models: `));
    const m = await memo(r);
    expect(m).toContain("CONSENSUS SCORE: 90/100");
    expect(m).toContain("WHERE MODELS AGREE");
    // C-a E11 / E01: a PC run (TWO_SUBS_PLUS_GROK, 3 slots, 2 independent models) states its counts in units; an IND
    // run (DISTINCT_REAL) keeps the 35933c8 wording.
    const pc = rows.length > n;
    expect(m).toContain(pc ? `${rows.length} panel slots answered this question; ${n} independent executing models wrote those answers.` : `${n} AI models researched this question independently.`);
    expect(await copied(r)).toContain("Top consensus:");
    const card = verdictCardText(r);
    expect(card).toContain("Top consensus");
    expect(card).toContain(pc ? `Agreed by ${n} independent executing models` : `Agreed by ${n} models`);
    expect(card).toContain(pc ? `${n} independent executing models split` : `${n} models split`);
  });
});

describe("A: verdict text builders and the social LinkedIn builder respect crossModel", () => {
  const gate = computeVerificationGate({ keyFindings: [], disagreements: [], biasAndBlindSpots: [], openQuestions: [], sourceBacked: true, questionLength: 30 } as never);
  it("crossModel false: no 'Consensus:' line and no 'Agreed by'", () => {
    const v = buildPanelVerdict("q", report(["chatgpt", "claude"]), gate, TWO_SUBS, { crossModel: false });
    expect(v.crossModel).toBe(false);
    for (const t of [formatVerdictText(v, "linkedin"), buildCopyForXShort(v), buildLinkedInPost({ question: "q", gate, verdict: v, modelHealth: { total: 2, responded: 2, substituted: 2, failed: 0 } } as never)]) {
      expect(t).not.toMatch(/^Consensus:/m);
      expect(t).not.toMatch(/Agreed by/);
      expect(t).toContain("Finding (one independent model; not a consensus):");
    }
  });
  it("crossModel omitted: unchanged ('Consensus:' and 'Agreed by')", () => {
    const v = buildPanelVerdict("q", report(["chatgpt", "grok"]), gate, DISTINCT_REAL);
    expect(buildLinkedInPost({ question: "q", gate, verdict: v, modelHealth: { total: 3, responded: 3, substituted: 0, failed: 0 } } as never)).toMatch(/Consensus: .* Agreed by 2 models\./);
  });
});

// ─── B: counts of independent executing models ──────────────────────────────

describe("B. disagreement count and severity count independent executing models", () => {
  const gate = computeVerificationGate({ keyFindings: [], disagreements: [], biasAndBlindSpots: [], openQuestions: [], sourceBacked: true, questionLength: 30 } as never);
  it("rows chatgpt(DeepSeek), claude(DeepSeek), grok: consensusModelCount 2 AND disagreementModelCount 2 (not 3)", () => {
    const v = buildPanelVerdict("q", report(["chatgpt", "claude", "grok"]), gate, TWO_SUBS_PLUS_GROK);
    expect([v.consensusModelCount, v.disagreementModelCount]).toEqual([2, 2]);
  });
  it("control: distinct real providers → 3 and 3", () => {
    const v = buildPanelVerdict("q", report(["chatgpt", "claude", "grok"]), gate, DISTINCT_REAL);
    expect([v.consensusModelCount, v.disagreementModelCount]).toEqual([3, 3]);
  });
  // Phase 0 (L14): Key Findings severity counts the stored supporting SLOTS (35933c8), so 3 slots are 'Low stakes'; the
  // verdict card's "2 models split" is presentation and keeps counting executing models.
  it("rendered: '2 models split'; a Mixed-confidence finding backed by 3 slots is 'Low stakes' (35933c8 severity)", async () => {
    const rep = report(["chatgpt", "claude", "grok"]);
    (rep.keyFindings[0] as any).confidence = "Mixed";
    const r = await mountSynthesis(TWO_SUBS_PLUS_GROK, rep, { ...SUMMARY, modelsHealthy: 2, modelCount: 3 });
    // C-a E01: the PC count carries its unit (independent executing models), still 2, never the 3 slots.
    expect(verdictCardText(r)).toContain("2 independent executing models split");
    expect(verdictCardText(r)).not.toMatch(/3 (independent executing )?models split/);
    // The Key Finding's severity badge (the first; the disagreement card's own badge follows).
    const findingBadge = (x: TestRenderer.ReactTestRenderer) => nodeText(x.root.findAll((n) => n.type === "span" && typeof n.props.title === "string" && /decisions|interpretation|low-impact/.test(n.props.title))[0]).trim();
    expect(findingBadge(r)).toBe("Low stakes");
    // Control: three real models → 'Low stakes'.
    const r2 = await mountSynthesis(DISTINCT_REAL, rep, { ...SUMMARY, modelsHealthy: 3, modelCount: 3 });
    expect(findingBadge(r2)).toBe("Low stakes");
  });
  it("NIT: 'Model health' is labelled as independent models / responses and never shows more independent models than the rows prove", async () => {
    // A summary stored before the independent-voice rule: modelsHealthy counted 3 slots.
    const r = await mountSynthesis(TWO_SUBS_PLUS_GROK, report(["chatgpt", "claude", "grok"]), { ...SUMMARY, modelsHealthy: 3, modelCount: 3 });
    const text = nodeText(r.root);
    expect(text).toContain("2/3Model health (independent models / responses)");
    expect(text).not.toContain("3/3Model health");
  });
});

// ─── C: client and server synthesis gates agree ─────────────────────────────

describe("C. client synthesis gate ≡ server synthesis gate on the same rows", () => {
  const persisted = (rows: ModelResult[]) => ({
    question: "q",
    runDocument: { question: "q", perModel: rows.map((r) => ({ modelId: r.modelId, status: r.status, rawTextTruncated: r.rawText ?? "", ...(r.provider ? { provider: r.provider } : {}) })) },
  });
  // Phase 0 (L03; owner Option C): every synthesis gate — server and client — counts usable SLOTS (35933c8), so two
  // answered slots are admitted whoever executed them. `meetsIndependentSynthesisMinimum` is now a presentation helper
  // only (ResultsDisplay unified-answer guard), never a gate; its value is pinned separately below.
  const CASES: Array<[string, ModelResult[], boolean]> = [
    ["two substitutes (same DeepSeek)", TWO_SUBS, true],
    ["two substitutes, provider not recorded", [sub("chatgpt", undefined), sub("claude", undefined)], true],
    ["real + substitute", [ok("grok", "xai"), sub("chatgpt")], true],
    ["two real", [ok("chatgpt", "openai"), ok("grok", "xai")], true],
    ["one real", [ok("chatgpt", "openai")], false],
    ["one real + one failed", [ok("chatgpt", "openai"), failed("claude")], false],
    ["two substitutes + one real", TWO_SUBS_PLUS_GROK, true],
    ["one real + one empty-text", [ok("chatgpt", "openai"), { ...ok("grok", "xai"), rawText: "   " } as ModelResult], false],
  ];
  it.each(CASES)("%s → %s", (_n, rows, expected) => {
    const server = authoritativeSynthesisInputs(persisted(rows));
    expect(server.ok).toBe(expected);
  });
  it("the presentation helper still counts executing models (two substitutes → false; real + substitute → true)", () => {
    expect(meetsIndependentSynthesisMinimum(TWO_SUBS)).toBe(false);
    expect(meetsIndependentSynthesisMinimum([sub("chatgpt", undefined), sub("claude", undefined)])).toBe(false);
    expect(meetsIndependentSynthesisMinimum([ok("grok", "xai"), sub("chatgpt")])).toBe(true);
  });

  // Phase 0 (L03 sites 7–8): the empty state is the 35933c8 condition `results.filter(isUsableResult).length >= 2`,
  // which does not read the row text — so "one real + one empty-text" is offered (the pre-flight then refuses it, as
  // at 35933c8). Every other case matches the server gate.
  const PSV_OFFER_35933C8: Record<string, boolean> = { "one real + one empty-text": true };
  it("PanelSynthesisView offers synthesis when the server gate would accept the rows (35933c8 empty-state rule)", async () => {
    for (const [name, rows, serverExpected] of CASES) {
      const expected = PSV_OFFER_35933C8[name] ?? serverExpected;
      let r!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        r = TestRenderer.create(createElement(PanelSynthesisView as never, { results: rows, question: "q", runId: "run-1", preGeneratedStatus: "error", preGeneratedError: null } as never));
      });
      mounted.push(r);
      const offered = r.root.findAll((n) => n.type === "button" && nodeText(n).includes("Generate Synthesis")).length > 0;
      expect([name, offered]).toEqual([name, expected]);
    }
  });

  // Phase 0 (L03 sites 3–4): app/page.tsx is restored to the 35933c8 slot rule at both sites (re-pinned in
  // dsProvenanceUiBoundaries.spec.ts). The behaviour is proven on the mounted page in phase0ClientGateCallers.spec.tsx.
  describe("app/page.tsx uses the 35933c8 slot rule (Phase 0 restoration of the pinned page)", () => {
    const PAGE = readFileSync(join(process.cwd(), "app/page.tsx"), "utf8");
    it("does not import the executing-model predicate", () => {
      expect(PAGE).not.toContain("meetsIndependentSynthesisMinimum");
      expect(PAGE).not.toMatch(/independentSynthesisResponders\(|independentVoices\(/);
    });
    it("synthesis pre-flight refuses fewer than 2 usable slots (35933c8)", () => {
      expect(PAGE).toMatch(/if \(okResults\.length < 2\) \{\s*throw new Error\("Synthesis requires at least 2 successful model responses\."\);/);
    });
    it("history auto-synthesis requires 2 usable slots (35933c8)", () => {
      expect(PAGE).toMatch(/data\.runId &&\s*\(data\.results as ModelResult\[\]\)\.filter\(\(r\) => isUsableResult\(r\)\)\.length >= 2 &&\s*\(data\.adaptive\?\.status === "absent" \|\| !data\.adaptive\)/);
    });
  });
});
