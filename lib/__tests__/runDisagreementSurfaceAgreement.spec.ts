/**
 * Review of 262ef64, MINOR B3 — the governance queue (stored record: classifyStoredDisagreement) and the live panel /
 * gate / share / panel verdict (crossModelDisagreements over the same rows) classify the SAME record identically, for
 * every run-level scenario: one of three requested models responding; two responses from the same DeepSeek fallback;
 * two genuinely independent models; one independent model with contested claims; missing provenance; genuine
 * disagreement; legacy records; and a collapsed run that still has two independent models. With >= 2 independent
 * executing models and no collapsed slots every stored item is a cross-model disagreement (the established
 * classification); "same executing model" appears only where named slots actually collapsed.
 */
jest.mock("server-only", () => ({}));

import { classifyStoredDisagreement, storedRunIndependenceContext } from "@/lib/panel/storedDisagreementIndependence";
import { crossModelDisagreements, buildPanelVerdict } from "@/lib/verificationGate/panelVerdict";
import {
  computeVerificationGate,
  INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL,
  UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL,
} from "@/lib/verificationGate/verificationGate";
import { independentSynthesisResponders, rowsRecordExecutionIdentity } from "@/lib/panel/independentVoices";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

type PerModel = { modelId: string; status: string; provider?: string; rawTextTruncated?: string };
const ok = (modelId: string): PerModel => ({ modelId, status: "ok", rawTextTruncated: `${modelId} answer` });
const ds = (modelId: string): PerModel => ({ modelId, status: "substituted", provider: "deepseek", rawTextTruncated: `${modelId} via deepseek` });
const failed = (modelId: string): PerModel => ({ modelId, status: "failed", rawTextTruncated: "" });

const ITEMS = [
  { topic: "pair chatgpt/claude", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "Different archival sources cited for the founding date of the institution" },
  { topic: "pair chatgpt/grok", positionsByModel: { chatgpt: "a", grok: "b" }, whyTheyDiffer: "Disagree on scope" },
  { topic: "one slot", positionsByModel: { chatgpt: "a" }, whyTheyDiffer: "Internal tension" },
  { topic: "failed slot named", positionsByModel: { chatgpt: "a", gemini: "b" }, whyTheyDiffer: "Named a slot that did not answer" },
  { topic: "family names", positionsByModel: { ChatGPT: "a", Claude: "b" }, whyTheyDiffer: "Family-name keys" },
];

type Scenario = { label: string; perModel: PerModel[] | null; legacy?: boolean; genuine: string[]; gateLabel?: string };
const SCENARIOS: Scenario[] = [
  { label: "one of three requested models responding", perModel: [ok("chatgpt"), failed("claude"), failed("grok")], genuine: [], gateLabel: INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL },
  { label: "two responses from the same DeepSeek fallback", perModel: [ds("chatgpt"), ds("claude")], genuine: [], gateLabel: INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL },
  {
    label: "two genuinely independent models (gemini failed)",
    perModel: [ok("chatgpt"), ok("claude"), ok("grok"), failed("gemini")],
    genuine: ITEMS.map((i) => i.topic),
  },
  { label: "one independent model with contested claims", perModel: [ok("chatgpt"), failed("claude")], genuine: [], gateLabel: INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL },
  { label: "genuine disagreement (three independent models)", perModel: [ok("chatgpt"), ok("claude"), ok("grok"), ok("gemini")], genuine: ITEMS.map((i) => i.topic) },
  {
    label: "legacy record (resultsCompact rows without provider)",
    perModel: [ok("chatgpt"), ok("claude"), ok("grok"), failed("gemini")],
    legacy: true,
    genuine: ITEMS.map((i) => i.topic),
  },
  {
    label: "collapsed run with two independent models (DeepSeek x2 + Grok)",
    perModel: [ds("chatgpt"), ds("claude"), ok("grok"), failed("gemini")],
    genuine: ["pair chatgpt/grok", "failed slot named"],
  },
];

function runDoc(s: Scenario): Record<string, unknown> {
  if (!s.perModel) return {};
  return s.legacy ? { resultsCompact: { perModel: s.perModel } } : { runDocument: { perModel: s.perModel } };
}
/** The live rows a panel holds for the same run (ModelResult shape). */
function liveRows(s: Scenario) {
  return (s.perModel ?? []).map((p) => ({ modelId: p.modelId, status: p.status, provider: p.provider, rawText: p.rawTextTruncated }));
}
const report = { executiveSummary: "s", keyFindings: [{ claim: "Founded in 1789", modelsSupporting: ["chatgpt"], confidence: "Mixed", evidenceRefs: [] }], disagreements: ITEMS, biasAndBlindSpots: [], openQuestions: [] } as unknown as StructuredSynthesis;

describe.each(SCENARIOS)("run-level surfaces agree — $label", (s) => {
  const ctx = storedRunIndependenceContext(runDoc(s));
  const queueGenuine = ITEMS.filter((i) => classifyStoredDisagreement(i, ctx) === "cross_model").map((i) => i.topic);
  const rows = liveRows(s);
  const crossModel = independentSynthesisResponders(rows).length >= 2;
  const liveGenuine = crossModelDisagreements(ITEMS, rows, crossModel);

  it("queue classification equals the expected genuine set", () => {
    expect(queueGenuine).toEqual(s.genuine);
  });

  it("live panel / share (crossModelDisagreements) equals the queue", () => {
    expect(liveGenuine.map((i) => i.topic)).toEqual(queueGenuine);
  });

  it("gate presents only the shared genuine set; label for reduced coverage; panel verdict's top disagreement is the first genuine", () => {
    const gate = computeVerificationGate({
      keyFindings: report.keyFindings,
      disagreements: ITEMS,
      independentDisagreements: liveGenuine,
      independentModelCount: independentSynthesisResponders(rows).length,
      trustSummary: { strongConsensus: 0, contestedAreas: 1, uncertainPoints: 1 },
    });
    expect(gate.metrics.disagreementsCount).toBe(s.genuine.length);
    if (s.gateLabel) expect(gate.label).toBe(s.gateLabel);
    const verdict = buildPanelVerdict("q", report, gate, rows, { crossModel });
    expect(verdict.topDisagreement).toBe(s.genuine[0] ?? null);
  });

  it("'same executing model' only where the named slots actually collapsed", () => {
    for (const i of ITEMS) {
      if (classifyStoredDisagreement(i, ctx) !== "same_executing_model") continue;
      const named = Object.keys(i.positionsByModel).map((k) => k.toLowerCase());
      const providers = named.map((n) => (s.perModel ?? []).find((p) => p.modelId === n)?.provider);
      expect(providers.every((p) => p === "deepseek")).toBe(true);
    }
  });
});

describe("missing provenance", () => {
  it("queue: every item independence_unverified; live rows without execution identity → gate coverage unverified", () => {
    const ctx = storedRunIndependenceContext({});
    expect(ITEMS.map((i) => classifyStoredDisagreement(i, ctx))).toEqual(ITEMS.map(() => "independence_unverified"));
    const rows = [{ modelId: "chatgpt", rawText: "a" }, { modelId: "claude", rawText: "b" }];
    expect(rowsRecordExecutionIdentity(rows)).toBe(false);
    expect(crossModelDisagreements(ITEMS, rows as never, independentSynthesisResponders(rows as never).length >= 2)).toEqual([]);
    const gate = computeVerificationGate({ keyFindings: [], disagreements: ITEMS, independentDisagreements: [], executionProvenanceUnverified: !rowsRecordExecutionIdentity(rows) });
    expect(gate.label).toBe(UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL);
    expect(gate.independentCoverage).toBe("unverified");
  });

  it("PanelSynthesisView wires executionProvenanceUnverified from its rows", () => {
    const src = require("fs").readFileSync(require("path").join(process.cwd(), "components/PanelSynthesisView.tsx"), "utf8");
    expect(src).toContain("...(rowsRecordExecutionIdentity(results) ? {} : { executionProvenanceUnverified: true }),");
  });
});

describe("one slot named twice (slot id + family name) is that slot's own positions on every surface", () => {
  it("queue and live both refuse it as a cross-model disagreement (the live panel's established raw-key rule)", () => {
    const perModel = [ok("chatgpt"), ok("claude"), failed("grok")];
    const item = { topic: "alias", positionsByModel: { chatgpt: "1789", ChatGPT: "1792" }, whyTheyDiffer: "same slot twice" };
    const ctx = storedRunIndependenceContext({ runDocument: { perModel } });
    expect([ctx.independence, ctx.collapsed]).toEqual(["independent", false]);
    expect(classifyStoredDisagreement(item, ctx)).toBe("same_executing_model");
    const rows = perModel.map((p) => ({ modelId: p.modelId, status: p.status, rawText: p.rawTextTruncated }));
    expect(crossModelDisagreements([item], rows, true)).toEqual([]);
  });
});
