/**
 * Model-identity PR A — run/result/share/governance surfaces.
 *
 *  - Identity positions (a model's own answer card, the memo's model list)
 *    show the run's RECORDED requested model, or "model not recorded" when the
 *    surface holds a row that recorded none.
 *  - Slot references (chips, positions, supporters, governance rows, generated
 *    synthesis text) use the product FAMILY only — never a versioned product
 *    label — and never claim "not recorded" for a record they were not handed.
 *  - Product/marketing surfaces (the About page chip) keep the product label.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn() }));
// The adaptive renderer is replaced by a probe that prints exactly the
// provenance ResultsDisplay hands down through the context — this proves the
// WIRING (falsifiable by removing the Provider), not only the helper.
jest.mock("@/components/adaptive/AdaptivePanelResponse", () => {
  const { useRunModelProvenance } = require("@/components/adaptive/RunModelProvenanceContext");
  return {
    __esModule: true,
    default: function ProvenanceProbe() {
      return require("react").createElement("pre", { "data-testid": "provenance-probe" }, JSON.stringify(useRunModelProvenance()));
    },
  };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import ResultsDisplay from "@/components/ResultsDisplay";
import ModelChip from "@/components/ModelChip";
import ModelPicker from "@/components/ModelPicker";
import AboutPage from "@/app/about/page";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown } from "@/lib/adaptiveSchema/shareBuilders";
import { buildAdaptiveUnifiedAnswer } from "@/lib/adaptiveSchema/verdict";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { buildClaimVerdictClipboardText } from "@/components/verification/ClaimVerificationResultView";
import { PANEL_MODELS } from "@/lib/panelModels";
import { synthesizeReport } from "@/lib/consensus";
import type { AdaptiveSynthesisReport } from "@/lib/adaptiveSchema/types";

const PRODUCT_LABELS = ["GPT 5.2", "Claude Opus 4.5", "Grok 4", "Perplexity Pro", "Gemini 2.0 Flash", "Gemini 3 Pro", "GPT-4o"];
const expectNoProductLabel = (s: string) => {
  for (const label of PRODUCT_LABELS) expect(s).not.toContain(label);
};

const LIVE_ROWS = [
  { modelId: "chatgpt", status: "ok", provider: "openai", requestedModel: "gpt-4o-mini", actualModel: "gpt-4o-mini", rawTextFull: "Inflation will ease to about three percent next year because energy prices are falling. Central banks will likely hold rates steady through the summer.", rawText: "Inflation will ease to about three percent next year because energy prices are falling. Central banks will likely hold rates steady through the summer.", tokenUsage: { totalTokens: 3 }, latencyMs: 12 },
  { modelId: "claude", status: "substituted", provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", actualModel: "deepseek-chat", substitutedFrom: "anthropic:claude-haiku-4-5-20251001", substitutionReason: "timeout", rawTextFull: "Inflation will ease to about three percent next year as energy prices fall. Rate cuts are unlikely before the autumn according to most forecasts.", rawText: "Inflation will ease to about three percent next year as energy prices fall. Rate cuts are unlikely before the autumn according to most forecasts.", tokenUsage: { totalTokens: 3 }, latencyMs: 12 },
];
/** Saved before Step 6.2a: rows carry no provenance keys at all. */
const PRE_62A_ROWS = [
  { modelId: "chatgpt", status: "ok", rawTextFull: "Inflation will ease to about three percent next year because energy prices are falling. Central banks will likely hold rates steady through the summer.", rawText: "Inflation will ease to about three percent next year because energy prices are falling. Central banks will likely hold rates steady through the summer.", tokenUsage: { totalTokens: 3 }, latencyMs: 12 },
  { modelId: "gemini", status: "ok", rawTextFull: "Inflation should moderate next year while energy costs decline. Central banks will probably keep rates unchanged for several months.", rawText: "Inflation should moderate next year while energy costs decline. Central banks will probably keep rates unchanged for several months.", tokenUsage: { totalTokens: 3 }, latencyMs: 12 },
];

function props(results: unknown[], extra: Record<string, unknown> = {}) {
  // A completed run: the real consensus engine's report over the same rows.
  const synthesizedReport = synthesizeReport(results as never);
  return { results, synthesizedReport, onRerun: jest.fn(), onAddModel: jest.fn(), question: "Q?", runId: "run-1", synthesisStatus: "idle", synthesisReport: null, adaptive: null, ...extra };
}
async function mount(p: Record<string, unknown>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(ResultsDisplay as never, p as never));
  });
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  // The per-model answer cards live behind the collapsed "Panel Responses" accordion.
  const heading = r.root.findAll((n) => n.type === "h2" && n.children.length === 1 && n.children[0] === "Panel Responses");
  if (heading.length > 0 && heading[0].parent?.type === "button") {
    await act(async () => {
      heading[0].parent!.props.onClick();
    });
  }
  return r;
}
const identityDetails = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props?.["data-testid"] === "run-model-identity-detail" && typeof n.type === "string").map((n) => (n.children as string[]).join(""));
const textOf = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("ResultsDisplay answer cards", () => {
  it("live rows: each card shows its own recorded requested model and recorded substitution — no product label anywhere", async () => {
    const r = await mount(props(LIVE_ROWS));
    const details = identityDetails(r);
    expect(details.length).toBeGreaterThanOrEqual(2);
    expect(details).toContain("requested: gpt-4o-mini");
    expect(details).toContain("requested: claude-haiku-4-5-20251001 · substituted, answered by: DeepSeek");
    expectNoProductLabel(textOf(r));
    expect(textOf(r)).toContain("ChatGPT");
  });

  it("saved pre-6.2a rows: 'model not recorded' — never the current configured model or product label", async () => {
    const r = await mount(props(PRE_62A_ROWS));
    const details = identityDetails(r);
    expect(details.length).toBeGreaterThanOrEqual(2);
    for (const d of details) expect(d).toBe("model not recorded");
    const t = textOf(r);
    expectNoProductLabel(t);
    expect(t).not.toMatch(/gpt-4o-mini|gemini-2\.0-flash|requested: /);
  });

  it("a renamed product label does not reach a completed-run card", async () => {
    const saved = PANEL_MODELS.map((m) => m.label);
    try {
      PANEL_MODELS.forEach((m) => {
        (m as { label: string }).label = `RENAMED-${m.id}-9.9`;
      });
      const r = await mount(props(LIVE_ROWS));
      expect(textOf(r)).not.toContain("RENAMED");
      expect(identityDetails(r)).toContain("requested: gpt-4o-mini");
    } finally {
      PANEL_MODELS.forEach((m, i) => {
        (m as { label: string }).label = saved[i];
      });
    }
  });
});

describe("ResultsDisplay single-response view (raw response heading + failed list)", () => {
  const headings = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "h4").map((n) => n.children.join(""));
  const failedItems = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => n.type === "li" && n.props.className === "text-red-800").map((n) => n.children.join(""));
  const FAILED = { modelId: "claude", status: "failed", provider: "anthropic", requestedModel: "claude-haiku-4-5-20251001", rawTextFull: "", rawText: "", tokenUsage: { totalTokens: 0 }, latencyMs: 1 };

  it("live: the heading and the failed entry carry each slot's recorded requested model", async () => {
    const r = await mount(props([LIVE_ROWS[0], FAILED]));
    expect(headings(r)).toContain("ChatGPT · requested: gpt-4o-mini");
    expect(failedItems(r)).toEqual(["Claude · requested: claude-haiku-4-5-20251001: failed"]);
    expectNoProductLabel(textOf(r));
  });

  it("saved pre-6.2a: 'model not recorded' in both positions", async () => {
    const r = await mount(props([PRE_62A_ROWS[0], { modelId: "claude", status: "failed", rawTextFull: "", rawText: "", tokenUsage: { totalTokens: 0 }, latencyMs: 1 }]));
    expect(headings(r)).toContain("ChatGPT · model not recorded");
    expect(failedItems(r)).toEqual(["Claude · model not recorded: failed"]);
    expectNoProductLabel(textOf(r));
  });
});

describe("ResultsDisplay compare view", () => {
  const OK_PAIR = [
    LIVE_ROWS[0],
    { ...LIVE_ROWS[0], modelId: "gemini", provider: "google", requestedModel: "gemini-2.0-flash", actualModel: "gemini-2.0-flash", rawTextFull: PRE_62A_ROWS[1].rawTextFull, rawText: PRE_62A_ROWS[1].rawText },
  ];
  async function openCompare(rows: unknown[]) {
    const r = await mount(props(rows));
    const tab = r.root.findAll((n) => n.type === "button" && n.children.includes("Compare view"));
    expect(tab).toHaveLength(1);
    await act(async () => {
      tab[0].props.onClick();
    });
    const heading = r.root.findAll((n) => n.type === "h3" && n.children.length === 1 && n.children[0] === "Compare View");
    expect(heading).toHaveLength(1);
    await act(async () => {
      heading[0].parent!.props.onClick();
    });
    return r;
  }
  it("each compare card shows its own recorded requested model", async () => {
    const r = await openCompare(OK_PAIR);
    expect(identityDetails(r)).toEqual(expect.arrayContaining(["requested: gpt-4o-mini", "requested: gemini-2.0-flash"]));
    expectNoProductLabel(textOf(r));
  });
  it("pre-6.2a compare cards say 'model not recorded'", async () => {
    const r = await openCompare(PRE_62A_ROWS);
    const details = identityDetails(r);
    expect(details.length).toBeGreaterThanOrEqual(2);
    for (const d of details) expect(d).toBe("model not recorded");
  });
});

describe("consensus engine's unified answer (persisted synthesis HTML)", () => {
  it("names models by family at every naming site — never a product or stale label", () => {
    const mk = (modelId: string, t: string) => ({ modelId, status: "ok", rawTextFull: t, rawText: t, latencyMs: 1 });
    const html = synthesizeReport([
      mk("chatgpt", "Remote work increases productivity for most knowledge workers. Hybrid schedules reduce commuting costs significantly. Remote work does not harm collaboration."),
      mk("claude", "Remote work increases productivity for most knowledge workers. Hybrid schedules reduce commuting costs significantly. Remote work harms collaboration and mentoring."),
      mk("gemini", "Remote work decreases productivity for most knowledge workers. Hybrid schedules reduce commuting costs significantly. Remote work harms collaboration and mentoring."),
    ] as never)!.unifiedAnswer;
    expect(html).toContain("Agreed by 3 models (ChatGPT, Claude, Gemini)");
    expect(html).toContain("Different perspectives from: ChatGPT, Claude, Gemini");
    expect(html).toContain("3 models agree — ChatGPT, Claude, Gemini");
    expect(html).toContain("conflicting views: ChatGPT, Claude, Gemini");
    for (const name of ["ChatGPT", "Claude", "Gemini"]) expect(html).toContain(`<li class="mb-1"><strong>${name}:</strong>`);
    expectNoProductLabel(html);
  });
});

describe("ResultsDisplay → adaptive surfaces: the run's provenance is handed down", () => {
  const ADAPTIVE = { schemaId: "generic", classification: { queryType: "generic" }, results: [], alignedClaims: [] };

  it("provides exactly the run rows' recorded facts (live)", async () => {
    const r = await mount(props(LIVE_ROWS, { adaptive: ADAPTIVE }));
    const probe = r.root.find((n) => n.props?.["data-testid"] === "provenance-probe");
    expect(JSON.parse((probe.children as string[]).join(""))).toEqual([
      { modelId: "chatgpt", provider: "openai", requestedModel: "gpt-4o-mini", substituted: false },
      { modelId: "claude", provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substituted: true, substitutedFrom: "anthropic:claude-haiku-4-5-20251001" },
    ]);
  });

  it("pre-6.2a rows hand down slots with no invented facts", async () => {
    const r = await mount(props(PRE_62A_ROWS, { adaptive: ADAPTIVE }));
    const probe = r.root.find((n) => n.props?.["data-testid"] === "provenance-probe");
    expect(JSON.parse((probe.children as string[]).join(""))).toEqual([
      { modelId: "chatgpt", substituted: false },
      { modelId: "gemini", substituted: false },
    ]);
  });
});

describe("adaptive raw model output headers", () => {
  const schema = getResultSchema("generic");
  const results = [{ modelId: "chatgpt" as const, schemaId: schema.id, ok: true, data: { summary: "x" } }, { modelId: "gemini" as const, schemaId: schema.id, ok: true, data: { summary: "y" } }];
  const render = (provenance: unknown) =>
    renderToStaticMarkup(
      createElement(RunModelProvenanceContext.Provider, { value: provenance as never }, createElement(ModelResponsesSection, { schema, results: results as never }))
    );

  it("with the run's rows: recorded model or 'model not recorded', per slot", () => {
    const html = render([{ modelId: "chatgpt", requestedModel: "gpt-4o-mini", substituted: false }, { modelId: "gemini", substituted: false }]);
    expect(html).toContain("requested: gpt-4o-mini");
    expect(html).toContain("model not recorded");
    expectNoProductLabel(html);
  });

  it("without the run's rows: family only, and no claim that anything was not recorded", () => {
    const html = render(null);
    expect(html).toContain("ChatGPT");
    expect(html).not.toContain("model not recorded");
    expect(html).not.toContain("requested:");
    expectNoProductLabel(html);
  });
});

describe("share text and memos", () => {
  const report = {
    panelVerdict: "v",
    unifiedAnswer: "u",
    executiveSummary: "e",
    whereModelsAgree: [],
    whereModelsDisagree: [],
    disagreements: [{ topic: "T", whyTheyDiffer: "W", positions: [{ modelId: "chatgpt", position: "P1" }, { modelId: "gemini", position: "P2" }] }],
    biasAndBlindSpots: [],
    runCertainty: 0.5,
    gate: "caution",
    certaintyAssessment: "c",
  } as unknown as AdaptiveSynthesisReport;

  it("memo with the run's provenance lists each model by its frozen requested model", () => {
    const memoInput = buildAdaptiveMemoInput("Q?", report, ["chatgpt", "gemini"], "run-1", [
      { modelId: "chatgpt", requestedModel: "gpt-4o-mini", substituted: false },
      { modelId: "gemini", substituted: false },
    ]);
    expect(memoInput.modelsUsed).toEqual(["ChatGPT · requested: gpt-4o-mini", "Gemini · model not recorded"]);
    const memo = generateVerificationMemo(memoInput);
    expect(memo).toContain("ChatGPT · requested: gpt-4o-mini");
    expectNoProductLabel(memo);
  });

  it("memo without provenance names families only — never a product label, never 'not recorded'", () => {
    const memoInput = buildAdaptiveMemoInput("Q?", report, ["chatgpt", "gemini"], "run-1");
    expect(memoInput.modelsUsed).toEqual(["ChatGPT", "Gemini"]);
    expectNoProductLabel(generateVerificationMemo(memoInput));
  });

  it("copied synthesis markdown names positions by family", () => {
    const md = buildAdaptiveSynthesisMarkdown("Q?", report);
    expect(md).toContain("  - ChatGPT: P1");
    expect(md).toContain("  - Gemini: P2");
    expectNoProductLabel(md);
  });

  it("claim verdict clipboard text names models by family", () => {
    const text = buildClaimVerdictClipboardText({
      claim: "C",
      verdict: "accurate",
      consensusScore: 80,
      confidenceLabel: "High",
      modelEvidence: [{ modelId: "chatgpt", verdict: "accurate", summary: "S" }, { modelId: "perplexity", verdict: "accurate", summary: "S2" }],
      whereModelsAgree: [],
      whereModelsDisagree: [],
    } as never);
    expect(text).toContain("- ChatGPT: ");
    expect(text).toContain("- Perplexity: ");
    expectNoProductLabel(text);
  });

  it("claim memo with no supplied model name falls back to the family — not a guessed version", () => {
    const memo = generateVerificationMemo({ type: "claim", claim: "C", verdict: "accurate", consensusScore: 80, confidenceLabel: "High", modelEvidence: [{ modelId: "chatgpt", verdict: "accurate", summary: "S" }] } as never);
    expect(memo).toContain("ChatGPT");
    expectNoProductLabel(memo);
  });
});

describe("generated synthesis text persisted with the run", () => {
  it("the deterministic unified answer cites supporting models by family", () => {
    const rows = [
      {
        claimText: "Claim X",
        status: "consensus",
        cells: [{ modelId: "chatgpt", stance: "agrees" }, { modelId: "claude", stance: "agrees" }, { modelId: "gemini", stance: "partial" }],
      },
    ];
    const answer = buildAdaptiveUnifiedAnswer(rows as never, { status: "pass", runCertainty: 0.9 } as never);
    expect(answer).toContain("(ChatGPT, Claude, Gemini)");
    expectNoProductLabel(answer);
  });
});

describe("ModelChip", () => {
  it("names the slot by family on run surfaces (default)", () => {
    const html = renderToStaticMarkup(createElement(ModelChip, { modelId: "chatgpt" }));
    expect(html).toContain("ChatGPT");
    expectNoProductLabel(html);
  });
  it("keeps the product label only where a product surface opts in", () => {
    expect(renderToStaticMarkup(createElement(ModelChip, { modelId: "chatgpt", labelKind: "product" }))).toContain(PANEL_MODELS[0].label);
  });
});

describe("product / selection surfaces keep the product labels (out of PR A scope, must not regress)", () => {
  it("the About page lists every product label", () => {
    const html = renderToStaticMarkup(createElement(AboutPage));
    for (const m of PANEL_MODELS) expect(html).toContain(m.label);
  });
  it("the model picker's selection buttons show every product label", () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, { selectedModels: ["chatgpt"], onSelectionChange: () => {}, plan: "full" }));
    for (const m of PANEL_MODELS) expect(html).toContain(m.label);
  });
});
