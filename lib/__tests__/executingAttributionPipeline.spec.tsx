/**
 * Executing-model attribution + independent-model synthesis gate — end to end over the REAL panel runner.
 *
 * Owner rules (connector fail-closed pass, findings A1/A2):
 *  - the model that actually wrote a slot's text is authoritative: a DeepSeek response is shown as
 *    "DeepSeek (substituting ChatGPT)", never as ChatGPT/Claude agreement — on the Agreement Map, Trust Summary,
 *    Key Findings, Panel Verdict, synthesis endpoint inputs and exported/copied text;
 *  - two DeepSeek substitutions are ONE independent model; with fewer than two independent models there is no
 *    multi-model consensus, no cross-model corroboration and no consensus score presented as cross-model.
 *
 * Drives runPanel with the REAL ChatGPT/Claude connectors (only the OpenAI/Anthropic SDKs are doubles), then the
 * REAL consensus engine, synthesis input gate, consensus scoring, verdict builder, and renders the REAL
 * ResultsDisplay / PanelSynthesisView (react-test-renderer; @testing-library/react is not a dependency of this repo),
 * asserting on rendered text. No real provider call is made.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));

const mockOpenAICreate = jest.fn();
jest.mock("openai", () => ({
  __esModule: true,
  default: function OpenAI() {
    return { chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } };
  },
}));
const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: function Anthropic() {
    return { messages: { create: (...b: unknown[]) => mockAnthropicCreate(...b) } };
  },
}));
const mockCallGrok = jest.fn();
jest.mock("@/lib/connectors/grok", () => ({ callGrok: (...a: unknown[]) => mockCallGrok(...a) }));
const mockCallGemini = jest.fn();
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: (...a: unknown[]) => mockCallGemini(...a) }));
const mockCallDeepSeek = jest.fn();
jest.mock("@/lib/connectors/deepseek", () => ({ DEEPSEEK_MODEL: "deepseek-chat", callDeepSeek: (...a: unknown[]) => mockCallDeepSeek(...a) }));
let mockDeepSeekKey: string | undefined;
jest.mock("@/lib/env", () => {
  const actual = jest.requireActual("@/lib/env");
  return {
    ...actual,
    get DEEPSEEK_API_KEY() {
      return mockDeepSeekKey;
    },
  };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { runPanel } from "@/lib/panel";
import { synthesizeReport } from "@/lib/consensus";
import { authoritativeSynthesisInputs } from "@/lib/synthesis/authoritativeRunInputs";
import { computeSynthesisConsensusScoring } from "@/lib/verification/consensusScoring";
import { buildPanelVerdict } from "@/lib/verificationGate/panelVerdict";
import { buildLinkedInPost } from "@/lib/ui/socialCopy";
import { computeVerificationGate } from "@/lib/verificationGate/verificationGate";
import ResultsDisplay from "@/components/ResultsDisplay";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import type { ModelResult, ModelId } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const KEY = "sk-FAKE-test-key-never-real-0000";
const PANEL_TEXT =
  "Paris is the capital of France. The city has been the seat of the French government for centuries. " +
  "It is located on the Seine river in northern France. Paris is the most populous city in France.";

const ok = (modelId: string) => ({ modelId, status: "ok", rawText: PANEL_TEXT, latencyMs: 5 }) as ModelResult;
const serverError = () => Object.assign(new Error("500 Internal Server Error"), { status: 500 });
const unauthorized = () => Object.assign(new Error("Incorrect API key provided: sk-FAKE***0000"), { status: 401 });
function openAIText() {
  mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: PANEL_TEXT } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}
function anthropicText() {
  mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: PANEL_TEXT }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" });
}

type Scenario = { name: string; panel: ModelId[]; keys: Record<string, string | undefined>; setup: () => void; fallbackFor?: string };
const SCENARIOS: Record<string, Scenario> = {
  twoSubstitutions: {
    name: "two DeepSeek substitutions",
    panel: ["chatgpt", "claude"],
    keys: { chatgpt: KEY, claude: KEY },
    setup: () => {
      mockDeepSeekKey = "ds-FAKE";
      mockOpenAICreate.mockRejectedValue(serverError());
      mockAnthropicCreate.mockRejectedValue(serverError());
    },
  },
  twoSubstitutionsPlusGrok: {
    name: "two DeepSeek substitutions + Grok",
    panel: ["chatgpt", "claude", "grok"],
    keys: { chatgpt: KEY, claude: KEY, grok: KEY },
    setup: () => {
      mockDeepSeekKey = "ds-FAKE";
      mockOpenAICreate.mockRejectedValue(serverError());
      mockAnthropicCreate.mockRejectedValue(serverError());
    },
  },
  oneRealOneSubstitute: {
    name: "one real provider + one DeepSeek substitute",
    panel: ["chatgpt", "grok"],
    keys: { chatgpt: KEY, grok: KEY },
    setup: () => {
      mockDeepSeekKey = "ds-FAKE";
      mockOpenAICreate.mockRejectedValue(serverError());
    },
  },
  distinctReal: {
    name: "multiple distinct real providers",
    panel: ["chatgpt", "claude", "grok"],
    keys: { chatgpt: KEY, claude: KEY, grok: KEY },
    setup: () => {
      openAIText();
      anthropicText();
    },
  },
  missingKeys: {
    name: "missing ChatGPT/Claude keys (DeepSeek configured)",
    panel: ["chatgpt", "claude", "grok", "gemini"],
    keys: { chatgpt: undefined, claude: "  ", grok: KEY, gemini: KEY },
    setup: () => {
      mockDeepSeekKey = "ds-FAKE";
    },
  },
  rejectedCredentials: {
    name: "rejected credentials (401, DeepSeek configured)",
    panel: ["chatgpt", "claude", "grok", "gemini"],
    keys: { chatgpt: KEY, claude: KEY, grok: KEY, gemini: KEY },
    setup: () => {
      mockDeepSeekKey = "ds-FAKE";
      mockOpenAICreate.mockRejectedValue(unauthorized());
      mockAnthropicCreate.mockRejectedValue(unauthorized());
    },
  },
  fallbackDisabled: {
    name: "fallback disabled for openai/anthropic (PANEL_DEEPSEEK_FALLBACK_FOR=google)",
    panel: ["chatgpt", "claude", "grok", "gemini"],
    keys: { chatgpt: KEY, claude: KEY, grok: KEY, gemini: KEY },
    fallbackFor: "google",
    setup: () => {
      mockDeepSeekKey = "ds-FAKE";
      mockOpenAICreate.mockRejectedValue(serverError());
      mockAnthropicCreate.mockRejectedValue(serverError());
    },
  },
};

async function run(key: keyof typeof SCENARIOS): Promise<ModelResult[]> {
  const s = SCENARIOS[key];
  s.setup();
  if (s.fallbackFor) process.env.PANEL_DEEPSEEK_FALLBACK_FOR = s.fallbackFor;
  // The connectors' race timeouts are never cleared by production code; fake timers keep them from holding the
  // process open (same approach as substitutionIndependence.spec.ts).
  jest.useFakeTimers();
  try {
    return await runPanel("What is the capital of France?", s.panel, s.keys as never);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.PANEL_DEEPSEEK_FALLBACK_FOR;
  }
}

/** The run as /api/synthesize-panel reads it: persisted perModel rows (completeRun shape). */
const persistedRun = (results: ModelResult[]) => ({
  question: "What is the capital of France?",
  runDocument: {
    question: "What is the capital of France?",
    perModel: results.map((r) => ({ modelId: r.modelId, status: r.status, rawTextTruncated: r.rawText ?? "", ...(r.provider ? { provider: r.provider } : {}) })),
  },
});

const synthesis = (modelsSupporting: string[]): StructuredSynthesis =>
  ({
    executiveSummary: "Paris is the capital.",
    keyFindings: [{ claim: "Paris is the capital of France.", confidence: "High", evidenceRefs: ["r1"], modelsSupporting }],
    disagreements: [],
    biasAndBlindSpots: [],
    openQuestions: [],
    methodology: "Cross-model comparison.",
  }) as unknown as StructuredSynthesis;

function texts(node: any, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else for (const ch of node.children ?? []) texts(ch, out);
  return out;
}
const textOf = (r: TestRenderer.ReactTestRenderer) => texts(r.toJSON()).join("");
const nodeText = (n: TestRenderer.ReactTestInstance): string =>
  n.children.map((c) => (typeof c === "string" ? c : nodeText(c))).join("");

const mounted: TestRenderer.ReactTestRenderer[] = [];
async function mount(el: any): Promise<TestRenderer.ReactTestRenderer> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  mounted.push(r);
  return r;
}

async function mountResults(results: ModelResult[], synthesizedReport: any) {
  const r = await mount(
    createElement(ResultsDisplay as never, {
      results,
      synthesizedReport,
      onRerun: () => {},
      onAddModel: () => {},
      question: "What is the capital of France?",
      runId: "run-1",
      synthesisStatus: "idle",
      synthesisReport: null,
      adaptive: null,
      allowSynthesisGeneration: false,
    } as never)
  );
  const toggle = r.root.findAll((n) => n.type === "button" && nodeText(n).includes("Agreement / Disagreement Map"))[0];
  await act(async () => {
    toggle.props.onClick();
  });
  return r;
}

/**
 * Text of every rendered agreement chip: the Agreement Map's ModelChips (`uppercase={false}`). The per-slot response
 * cards' chips (default uppercase, next to their own "Substituted: DeepSeek" badge) are not agreement chips.
 */
function chipTexts(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root
    .findAll(
      (n) =>
        n.type === "span" &&
        typeof n.props.className === "string" &&
        n.props.className.includes("inline-flex items-center gap-1.5") &&
        !n.props.className.includes("uppercase")
    )
    .map((n) => nodeText(n).trim());
}

async function mountSynthesis(results: ModelResult[], report: StructuredSynthesis, summary: any) {
  return mount(
    createElement(PanelSynthesisView as never, {
      results,
      question: "What is the capital of France?",
      runId: "run-1",
      preGeneratedStatus: "complete",
      preGeneratedReport: report,
      preGeneratedConsensusSummary: summary,
    } as never)
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeepSeekKey = undefined;
  mockedAuthedFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
  mockCallGrok.mockResolvedValue(ok("grok"));
  mockCallGemini.mockResolvedValue(ok("gemini"));
  mockCallDeepSeek.mockResolvedValue({ ok: true, text: PANEL_TEXT, latencyMs: 3, actualModel: "deepseek-chat" });
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

// ─── A2: the synthesis gate counts independent executing models ─────────────

describe("synthesis endpoint input gate (authoritativeSynthesisInputs)", () => {
  it("NEGATIVE: two answered slots, one independent model (two DeepSeek substitutions) → insufficient_results", async () => {
    const results = await run("twoSubstitutions");
    expect(results.map((r) => [r.modelId, r.status, r.provider])).toEqual([
      ["chatgpt", "substituted", "deepseek"],
      ["claude", "substituted", "deepseek"],
    ]);
    expect(authoritativeSynthesisInputs(persistedRun(results))).toEqual({ ok: false, reason: "insufficient_results" });
    // No multi-model consensus either.
    expect(synthesizeReport(results)).toBeNull();
  });

  it.each([
    ["twoSubstitutionsPlusGrok", 3],
    ["oneRealOneSubstitute", 2],
    ["distinctReal", 3],
    ["missingKeys", 2],
    ["rejectedCredentials", 2],
    ["fallbackDisabled", 2],
  ] as const)("%s → synthesizable; rows are every usable slot (%i)", async (key, rows) => {
    const results = await run(key);
    const inputs = authoritativeSynthesisInputs(persistedRun(results));
    expect(inputs.ok).toBe(true);
    if (inputs.ok) expect(inputs.value.rows).toHaveLength(rows);
  });

  it("missing keys / 401 / fallback disabled never produce a substituted slot", async () => {
    for (const key of ["missingKeys", "rejectedCredentials", "fallbackDisabled"] as const) {
      const results = await run(key);
      const byId = Object.fromEntries(results.map((r) => [r.modelId, r]));
      expect([key, byId.chatgpt.status, byId.claude.status]).toEqual([key, "failed", "failed"]);
    }
    expect(mockCallDeepSeek).not.toHaveBeenCalled();
  });
});

// ─── consensus scoring: modelsHealthy = independent models, modelCount = successful responses ────

describe("synthesis consensus scoring counts", () => {
  it("two substitutions + Grok: 2 independent models of 3 successful responses", async () => {
    const results = await run("twoSubstitutionsPlusGrok");
    const inputs = authoritativeSynthesisInputs(persistedRun(results));
    if (!inputs.ok) throw new Error("expected synthesizable");
    const out = computeSynthesisConsensusScoring({
      synthesis: synthesis(["chatgpt", "claude", "grok"]),
      results: inputs.value.rows.map((r) => ({ modelId: r.modelId, status: r.status, rawText: r.text, provider: r.provenance.provider })),
      sourceBacked: true,
      runId: "run-1",
    });
    expect(out.consensusSummary.modelsHealthy).toBe(2);
    expect(out.consensusSummary.modelCount).toBe(3);
    expect(out.enrichedSynthesis.keyFindings[0].support!.supportingModels).toEqual(["chatgpt", "grok"]);
  });

  it("missing keys: modelCount is the successful responses (2), not the dispatched panel (4)", async () => {
    const results = await run("missingKeys");
    const inputs = authoritativeSynthesisInputs(persistedRun(results));
    if (!inputs.ok) throw new Error("expected synthesizable");
    const out = computeSynthesisConsensusScoring({
      synthesis: synthesis(["grok", "gemini"]),
      results: inputs.value.rows.map((r) => ({ modelId: r.modelId, status: r.status, rawText: r.text, provider: r.provenance.provider })),
      sourceBacked: true,
      runId: "run-1",
    });
    expect([out.consensusSummary.modelCount, out.consensusSummary.modelsHealthy]).toEqual([2, 2]);
  });
});

// ─── A1: Panel Verdict / copied share text ───────────────────────────────────

describe("Panel Verdict 'Agreed by N models' (and the copied share text)", () => {
  const verdictFor = (results: ModelResult[], supporting: string[]) => {
    const report = synthesis(supporting);
    const gate = computeVerificationGate({ keyFindings: report.keyFindings, disagreements: [], biasAndBlindSpots: [], openQuestions: [], sourceBacked: true, questionLength: 30 } as never);
    return { verdict: buildPanelVerdict("q", report, gate, results), gate };
  };

  it("two substitutions + Grok supporting: 2 independent models, not 3", async () => {
    const results = await run("twoSubstitutionsPlusGrok");
    const { verdict, gate } = verdictFor(results, ["chatgpt", "claude", "grok"]);
    expect(verdict.consensusModelCount).toBe(2);
    const post = buildLinkedInPost({ question: "q", gate, verdict, modelHealth: { total: 3, responded: 3, substituted: 2, failed: 0 } } as never);
    expect(post).toContain("Agreed by 2 models.");
    expect(post).not.toContain("Agreed by 3 models.");
  });

  it("distinct real providers: 3", async () => {
    const results = await run("distinctReal");
    expect(verdictFor(results, ["chatgpt", "claude", "grok"]).verdict.consensusModelCount).toBe(3);
  });
});

// ─── A1: ResultsDisplay — Agreement Map chips, wordings, Trust Summary ───────

describe("ResultsDisplay attribution (rendered)", () => {
  it("two substitutions + Grok: chips and Trust Summary name DeepSeek, never ChatGPT/Claude as agreeing", async () => {
    const results = await run("twoSubstitutionsPlusGrok");
    const report = synthesizeReport(results)!;
    const r = await mountResults(results, report);
    const chips = chipTexts(r);
    expect(chips).toContain("DeepSeek (substituting ChatGPT)");
    expect(chips).toContain("Grok");
    expect(chips).not.toContain("ChatGPT");
    expect(chips).not.toContain("Claude");
    const text = textOf(r);
    expect(text).toMatch(/Agreed by 2 models:/);
    expect(text).not.toMatch(/Agreed by 3 models/);
  });

  it("one real + one substitute: the substitute chip reads DeepSeek (substituting ChatGPT)", async () => {
    const results = await run("oneRealOneSubstitute");
    const r = await mountResults(results, synthesizeReport(results)!);
    const chips = chipTexts(r);
    expect(chips).toContain("DeepSeek (substituting ChatGPT)");
    expect(chips).not.toContain("ChatGPT");
    expect(textOf(r)).toMatch(/Agreed by 2 models:/);
  });

  it("control: distinct real providers keep their family-name chips", async () => {
    const results = await run("distinctReal");
    const r = await mountResults(results, synthesizeReport(results)!);
    const chips = chipTexts(r);
    expect(chips).toEqual(expect.arrayContaining(["ChatGPT", "Claude", "Grok"]));
    expect(chips.join("|")).not.toContain("substituting");
  });

  it("NEGATIVE (stored pre-rule analysis): a consensus cluster of two DeepSeek-substituted slots is ONE model — no strong consensus, a single-model insight", async () => {
    const results = await run("twoSubstitutions");
    const stored = {
      unifiedAnswer: "<p>Stored analysis.</p>",
      consensusAnalysis: {
        agreementClusters: [
          {
            id: "c1",
            label: "consensus",
            representativeText: "Paris is the capital of France.",
            modelIds: ["chatgpt", "claude"],
            claims: [
              { id: "a", modelId: "chatgpt", text: "Paris is the capital of France." },
              { id: "b", modelId: "claude", text: "Paris is the capital of France." },
            ],
          },
        ],
        trustSummary: { strongConsensus: 1, contestedAreas: 0, uncertainPoints: 0 },
      },
    };
    const r = await mountResults(results, stored);
    const text = textOf(r);
    expect(text).not.toMatch(/Agreed by \d+ models?/);
    expect(text).toContain("Single-model insight");
    expect(chipTexts(r)).toEqual(["DeepSeek (substituting ChatGPT, Claude)"]);
  });
});

// ─── A1/A2: PanelSynthesisView — Key Findings, consensus score ───────────────

describe("PanelSynthesisView (rendered)", () => {
  const SUMMARY = { modelsHealthy: 2, modelCount: 2, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 0, overallConsensusScore: 90, aggregateSupportRatio: 1 };

  it("NEGATIVE: two answered slots, one independent model — no consensus score, no cross-model support line, one model named", async () => {
    const results = await run("twoSubstitutions");
    const report = synthesis(["chatgpt", "claude"]);
    (report.keyFindings[0] as any).support = { supportingModels: ["chatgpt", "claude"], dissentingModels: [], unknownModels: [], supportRatio: 1, confidenceLabel: "High" };
    (report.keyFindings[0] as any).evidenceQuality = "strong";
    const r = await mountSynthesis(results, report, SUMMARY);
    const text = textOf(r);
    expect(text).toContain("1 model: DeepSeek (substituting ChatGPT, Claude)");
    expect(text).not.toContain("2 models:");
    expect(text).toContain("No consensus score: fewer than two independent models responded.");
    expect(text).not.toContain("90/100");
    expect(text).not.toContain("strong evidence");
    expect(text).not.toMatch(/Supported by \d/);
    expect(text).not.toMatch(/Agreed by 2 models/);
  });

  it("two substitutions + Grok: Key Findings name DeepSeek once, count 2 models; score shown", async () => {
    const results = await run("twoSubstitutionsPlusGrok");
    const report = synthesis(["chatgpt", "claude", "grok"]);
    (report.keyFindings[0] as any).support = { supportingModels: ["chatgpt", "claude", "grok"], dissentingModels: [], unknownModels: [], supportRatio: 1, confidenceLabel: "High" };
    (report.keyFindings[0] as any).evidenceQuality = "strong";
    const r = await mountSynthesis(results, report, { ...SUMMARY, modelsHealthy: 2, modelCount: 3 });
    const text = textOf(r);
    expect(text).toContain("2 models: DeepSeek (substituting ChatGPT, Claude), Grok");
    expect(text).toMatch(/Supported by 2\/\s*2 models/);
    expect(text).toContain("90/100");
    expect(text).toContain("Agreed by 2 models");
    expect(text).not.toContain("No consensus score");
  });

  it("disagreement positions are attributed to the executing model", async () => {
    const results = await run("oneRealOneSubstitute");
    const report = { ...synthesis(["grok"]), disagreements: [{ topic: "Size", positionsByModel: { chatgpt: "Large", grok: "Small" }, whyTheyDiffer: "Sources differ." }] } as unknown as StructuredSynthesis;
    const r = await mountSynthesis(results, report, SUMMARY);
    const text = textOf(r);
    expect(text).toContain("DeepSeek (substituting ChatGPT):");
    expect(text).toContain("Grok:");
    expect(text).not.toMatch(/(^|[^(g ])ChatGPT:/);
  });

  it("control: distinct real providers — family names, score shown", async () => {
    const results = await run("distinctReal");
    const r = await mountSynthesis(results, synthesis(["chatgpt", "claude", "grok"]), { ...SUMMARY, modelsHealthy: 3, modelCount: 3 });
    const text = textOf(r);
    expect(text).toContain("3 models: ChatGPT, Claude, Grok");
    expect(text).toContain("90/100");
  });

  it("empty state: two substituted slots are not offered synthesis", async () => {
    const results = await run("twoSubstitutions");
    const r = await mount(createElement(PanelSynthesisView as never, { results, question: "q", runId: "run-1", preGeneratedStatus: "error", preGeneratedError: null } as never));
    const text = textOf(r);
    expect(text).toContain("Responses from at least 2 independent models are required for synthesis.");
    expect(r.root.findAll((n) => n.type === "button" && nodeText(n).includes("Generate Synthesis"))).toHaveLength(0);
  });
});
