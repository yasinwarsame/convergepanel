/**
 * C-a adaptive legacy report rows (inventory v3.4 §12.2): A12 trust note, A13 / A14 / A15 ListView, A16 StepDiff,
 * A24 health cell, A26 model-written block labels (O3 (a)), A27 consensus map qualifier, J02 adaptive placeholder slot.
 * Every surface is rendered for real under the contexts ResultsDisplay provides; the wiring itself is proven through
 * the real ResultsDisplay (adaptive branch).
 *
 * Negatives: BI35 (S4 / S5 / S4f render byte-identically to the surface without the identity context), BIb (S8b: no
 * label, no note), MU14 (S2b is never treated as IND), N-D4′ (UV fixtures: "model independence unverified", no digit
 * next to "independent"; K equals the test-side reference).
 */
jest.mock("@react-pdf/renderer", () => {
  const React = jest.requireActual("react");
  const host = (name: string) => {
    const Host = (props: any) => React.createElement(name, props, props.children);
    Host.displayName = name;
    return Host;
  };
  return { Document: host("Document"), Page: host("Page"), Text: host("Text"), View: host("View"), Link: host("Link"), StyleSheet: { create: (s: any) => s }, Font: { register: () => undefined } };
});
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn(async () => ({ ok: false, json: async () => ({}) })) }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptiveSynthesisReportView, { TrustSummaryTable } from "@/components/adaptive/AdaptiveSynthesisReportView";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import ListView from "@/components/adaptive/ListView";
import StepDiffView from "@/components/adaptive/StepDiffView";
import ConsensusMapView from "@/components/adaptive/ConsensusMapView";
import ResultsDisplay from "@/components/ResultsDisplay";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { INVALID_PROVIDER_OUTPUT_NOTICE, modelWrittenBlockLabel, runExecutionIdentity, trustFiguresNote } from "@/lib/panel/executionIdentity";
import { renderUnderRun, textOf } from "@/components/adaptive/__tests__/caIdentityRender";
import { DIGIT_NEXT_TO_INDEPENDENT, failed, mock, ok, referenceK, rowsOf, sub, type SetName } from "@/lib/panel/__tests__/executionIdentityScenarios";
import type { ModelResult } from "@/lib/types";

const records = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const REC = records["generic-mixed"];
const QUESTION = "Does raising the minimum wage reduce employment?";
const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

/** 5-slot variants of the UV sets (the record has five slots). */
const UV5: Record<string, ModelResult[]> = {
  S3mn: [ok("chatgpt"), sub("claude", null), ok("grok"), ok("perplexity"), ok("gemini")],
  PRE62A: FIVE.map((m) => ok(m, null)),
  R_UV: [ok("chatgpt", null), sub("claude", null), ok("grok", null), ok("perplexity", null), ok("gemini", null)],
  UNKNOWN: [ok("chatgpt"), sub("claude", "unknown"), ok("grok"), ok("perplexity"), ok("gemini")],
  S3m: [ok("chatgpt"), { modelId: "claude", rawText: "x" } as any, ok("grok"), ok("perplexity"), ok("gemini")],
};
const S8b5 = [ok("chatgpt"), sub("claude"), ok("grok"), ok("perplexity"), ok("gemini")];

/** A pre-presentation (LEG) report: the same stored record without its presentation layer. */
const LEG = (() => {
  const { presentation: _p, ...rest } = REC.synthesisReport;
  return rest;
})();
const view = () =>
  createElement(AdaptiveSynthesisReportView, { report: LEG, gate: REC.gate, alignedClaims: REC.alignedClaims, trustSummary: REC.trustSummary, question: QUESTION, modelsUsed: FIVE as any, runId: "r" });
const trust = () => createElement(TrustSummaryTable, { trustSummary: REC.trustSummary });
const list = () => createElement(ListView as any, { schema: getResultSchema("generic" as any), results: REC.results, alignedClaims: REC.alignedClaims, gate: REC.gate, synthesisReport: REC.synthesisReport, trustSummary: REC.trustSummary });

describe("A12 TrustSummaryTable: one computed note when the run is not IND; values unchanged", () => {
  it.each(["S1", "S1n", "S2", "S2n", "S2b", "S7", "S8a"] as SetName[])("%s: the note states K and M", (name) => {
    const rows = rowsOf(name);
    const out = renderUnderRun(trust(), rows);
    const id = runExecutionIdentity(rows);
    expect(out).toContain(trustFiguresNote(id));
    expect(out).toContain(`${referenceK(rows)} independent executing model`);
    // Values are the stored ones.
    expect(out.replace(/<p[^>]*data-testid="trust-figures-note"[^>]*>[^<]*<\/p>/, "")).toBe(renderUnderRun(trust(), rows, "none"));
  });
  it.each(["S3", "S3m"] as SetName[])("%s (UV): 'model independence unverified', no digit next to 'independent'", (name) => {
    const out = textOf(renderUnderRun(trust(), rowsOf(name)));
    expect(out).toContain("Trust figures are per panel slot: model independence unverified.");
    expect(out).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
  });
  it.each(Object.keys(UV5))("%s (UV, 5 slots): unverified note", (name) => {
    expect(textOf(renderUnderRun(trust(), UV5[name]))).toContain("Trust figures are per panel slot: model independence unverified.");
  });
  it.each(["S4", "S5", "S4f", "S8b"] as SetName[])("%s: BI35 / BIb — byte-identical to the surface without the identity context", (name) => {
    expect(renderUnderRun(trust(), rowsOf(name))).toBe(renderUnderRun(trust(), rowsOf(name), "none"));
  });
  it("MU14: S2b (2 executing models, 5 slots) is never rendered as IND", () => {
    expect(renderUnderRun(trust(), rowsOf("S2b"))).toContain('data-testid="trust-figures-note"');
  });
});

describe("A24: no 'not counted' derivation; a failed repeated-substitute slot reads 'failed'", () => {
  const ts = (perModel: Array<[string, "ok" | "failed"]>) => ({
    perModel: perModel.map(([modelId, parseHealth]) => ({ modelId, claimsContributed: 1, majorityAlignment: 1, citationScore: 1, contradictionCount: 0, parseHealth, trustScore: parseHealth === "ok" ? 0.9 : 0, capped: parseHealth !== "ok" })),
    overallTrust: 0.9,
  });
  it("S1 with the second DeepSeek slot failed: 'failed', never 'not counted'", () => {
    const out = renderUnderRun(createElement(TrustSummaryTable, { trustSummary: ts([["chatgpt", "ok"], ["claude", "failed"], ["grok", "ok"]]) as any }), [sub("chatgpt"), sub("claude"), ok("grok")]);
    expect(out).not.toContain("not counted");
    expect(out.match(/>failed</g)).toHaveLength(1);
  });
});

describe("A13 / A14 / A15 ListView", () => {
  it("A15: a substituted slot's chip names its executing model (S2, S8b), never the requested model alone", () => {
    for (const rows of [rowsOf("S2").concat([]), S8b5]) {
      const out = textOf(renderUnderRun(list(), rows.length === 5 ? rows : rows));
      expect(out).toContain("DeepSeek (substituting Claude)");
    }
  });
  it("A15: S4 (no substitution) — chips exactly as before", () => {
    expect(renderUnderRun(list(), rowsOf("S4"))).toBe(renderUnderRun(list(), rowsOf("S4"), "none"));
  });
  it("A13: a slot whose executing model also answered other slots says so (S1: 4 other slots; S2: 1 other slot)", () => {
    const s1 = textOf(renderUnderRun(list(), rowsOf("S1")));
    expect(s1.match(/\(also answered 4 other slots\)/g)).toHaveLength(5);
    const s2 = textOf(renderUnderRun(list(), rowsOf("S2")));
    expect(s2.match(/\(also answered 1 other slot\)/g)).toHaveLength(2);
  });
  it("A13 UV: the list's alignment figures carry the unverified note; no 'also answered' count", () => {
    for (const rows of Object.values(UV5)) {
      const out = textOf(renderUnderRun(list(), rows));
      expect(out).toContain("Alignment figures are per panel slot: model independence unverified.");
      expect(out).not.toContain("also answered");
      expect(out).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
    }
  });
  it("A14 FC: 'recorded difference(s)', never 'split'; the run's K / M stated", () => {
    const out = textOf(renderUnderRun(list(), rowsOf("S1")));
    expect(out).toMatch(/\d+ recorded differences?/);
    expect(out).toContain("Recorded differences");
    expect(out).not.toMatch(/\b\d+ split\b/);
    expect(out).not.toContain("Split claims");
    expect(out).toContain("1 independent executing model answered 5 panel slots");
  });
  it("A14 PC: split counted across panel slots", () => {
    const out = textOf(renderUnderRun(list(), rowsOf("S2")));
    expect(out).toMatch(/\d+ split across panel slots/);
    expect(out).toContain("Split claims (counted by panel slot)");
  });
  it("A14 S5-variant / BI35: IND renders exactly as before", () => {
    for (const name of ["S4", "S4f"] as SetName[]) expect(renderUnderRun(list(), rowsOf(name))).toBe(renderUnderRun(list(), rowsOf(name), "none"));
  });
});

describe("A16 StepDiffView 'Only in N of M'", () => {
  const P = records["procedural"];
  const step = () => createElement(StepDiffView as any, { results: P.results });
  const four = (f: (m: string) => ModelResult) => ["chatgpt", "claude", "grok", "perplexity"].map(f);
  it("S1-like (FC): panel slots and 1 independent model", () => {
    const out = textOf(renderUnderRun(step(), four((m) => sub(m))));
    expect(out).toMatch(/Only in \d of 4 panel slots \(1 independent model\)/);
    expect(out).not.toMatch(/Only in \d of 4 models/);
  });
  it("S2-like (PC): 3 independent models", () => {
    expect(textOf(renderUnderRun(step(), [sub("chatgpt"), sub("claude"), ok("grok"), ok("perplexity")]))).toMatch(/panel slots \(3 independent models\)/);
  });
  it("UV: no digit next to 'independent'", () => {
    const out = textOf(renderUnderRun(step(), four((m) => ok(m, null))));
    expect(out).toMatch(/panel slots \(model independence unverified\)/);
    expect(out).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
  });
  it("S4-like BI35: unchanged", () => {
    expect(renderUnderRun(step(), four((m) => ok(m)))).toBe(renderUnderRun(step(), four((m) => ok(m)), "none"));
  });
});

describe("A27 ConsensusMapView: heading unchanged; the run-level qualifier under it when not IND", () => {
  const C = records["contested-empirical"];
  const map = () => createElement(ConsensusMapView as any, { results: C.results, alignedClaims: C.alignedClaims });
  const four = ["chatgpt", "claude", "grok", "perplexity"];
  it("S1 (FC) / S2 (PC) / S3 (UV)", () => {
    const fc = textOf(renderUnderRun(map(), four.map((m) => sub(m))));
    expect(fc).toContain("Where the models land");
    expect(fc).toContain("1 independent executing model answered 4 panel slots.");
    expect(textOf(renderUnderRun(map(), [sub("chatgpt"), sub("claude"), ok("grok"), ok("perplexity")]))).toContain("3 independent executing models answered 4 panel slots.");
    const uv = textOf(renderUnderRun(map(), four.map((m) => ok(m, null))));
    expect(uv).toContain("Columns are panel slots: model independence unverified.");
    expect(uv).not.toMatch(DIGIT_NEXT_TO_INDEPENDENT);
  });
  it("S4 BI35: unchanged", () => {
    const rows = four.map((m) => ok(m));
    expect(renderUnderRun(map(), rows)).toBe(renderUnderRun(map(), rows, "none"));
  });
});

describe("A26 model-written legacy block groups (O3 (a))", () => {
  it.each(["S1", "S2", "S2b", "S7"] as SetName[])("%s: one label per model-written block group, with K and M", (name) => {
    const out = renderUnderRun(view(), rowsOf(name));
    const label = modelWrittenBlockLabel(runExecutionIdentity(rowsOf(name)));
    const groups = [LEG.unifiedAnswer, LEG.executiveSummary, LEG.certaintyAssessment, (LEG.whereModelsAgree ?? []).length > 0, LEG.disagreements.length > 0, LEG.narrativeSections.length > 0].filter(Boolean).length;
    expect(groups).toBeGreaterThanOrEqual(5);
    expect(out.split(label).length - 1).toBe(groups);
    expect(label).toContain(`${referenceK(rowsOf(name))} independent model`);
  });
  it.each(["S3mn", "PRE62A", "R_UV", "UNKNOWN"])("%s (UV): the UV form of the label, no count", (name) => {
    const out = textOf(renderUnderRun(view(), UV5[name]));
    expect(out).toContain("Statements in it about agreement between models are not verified: model independence unverified.");
    expect(out.match(/Model-written text saved with this run\. Statements in it about agreement between models are not verified: \d/g)).toBeNull();
  });
  it("S6 (no rows): label only in its unverified form, never a count", () => {
    const out = textOf(renderUnderRun(view(), []));
    expect(out).toContain("model independence unverified.");
    expect(out).not.toMatch(/not verified: \d/);
  });
  it.each(["S4", "S5", "S4f", "S8b"] as SetName[])("%s: BI35 / BIb — no label, byte-identical", (name) => {
    expect(renderUnderRun(view(), rowsOf(name))).toBe(renderUnderRun(view(), rowsOf(name), "none"));
  });
  it("a presented (Order 4) report keeps its own attribution: no O3 label", () => {
    const presented = createElement(AdaptiveSynthesisReportView, { report: REC.synthesisReport, gate: REC.gate, alignedClaims: REC.alignedClaims, trustSummary: REC.trustSummary, question: QUESTION, modelsUsed: FIVE as any, runId: "r" });
    expect(renderUnderRun(presented, rowsOf("S1"))).not.toContain('data-testid="model-written-label"');
  });
  it("S9 (stored placeholders, MOCK): labelled even though the remaining slots are independent", () => {
    expect(renderUnderRun(view(), rowsOf("S9"))).toContain('data-testid="model-written-label"');
  });
});

describe("J02 adaptive placeholder slot (D-5)", () => {
  it("S9: the placeholder slot's card says it is not a model response; persisted values unchanged", () => {
    const results = REC.results.map((r: any) => (r.modelId === "chatgpt" || r.modelId === "claude" ? { ...r, ok: false, data: null, parseError: "Invalid JSON" } : r));
    const panel = createElement(AdaptivePanelResponse as any, { schema: getResultSchema("generic" as any), classification: REC.classification, results, alignedClaims: REC.alignedClaims, gate: REC.gate, synthesisReport: REC.synthesisReport, trustSummary: REC.trustSummary, question: QUESTION, runId: "r" });
    const before = JSON.stringify(results);
    const out = textOf(renderUnderRun(panel, rowsOf("S9")));
    expect(out).toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
    expect(JSON.stringify(results)).toBe(before);
    expect(textOf(renderUnderRun(panel, [ok("chatgpt"), ok("claude"), ok("grok"), ok("perplexity"), ok("gemini")]))).not.toContain(INVALID_PROVIDER_OUTPUT_NOTICE);
  });
});

describe("wiring: the real ResultsDisplay (adaptive branch) provides the identity from the run's rows", () => {
  const mount = (results: ModelResult[]) =>
    renderToStaticMarkup(
      createElement(ResultsDisplay as never, {
        results,
        synthesizedReport: null,
        onRerun: () => {},
        onAddModel: () => {},
        question: QUESTION,
        runId: "run-1",
        synthesisStatus: "idle",
        synthesisReport: null,
        allowSynthesisGeneration: false,
        adaptive: { schemaId: "generic", classification: REC.classification, results: REC.results, alignedClaims: REC.alignedClaims, gate: REC.gate, synthesisReport: LEG, trustSummary: REC.trustSummary },
      } as never)
    );
  it("S1: trust note and block labels appear; S4: none", () => {
    const fc = textOf(mount(rowsOf("S1")));
    expect(fc).toContain(trustFiguresNote(runExecutionIdentity(rowsOf("S1"))));
    expect(fc).toContain("Model-written text saved with this run.");
    const ind = textOf(mount(rowsOf("S4")));
    expect(ind).not.toContain("Trust figures are per panel slot");
    expect(ind).not.toContain("Model-written text saved with this run.");
  });
  it("a pre-6.2a run (no provider recorded) is unverified on the live page", () => {
    expect(textOf(mount(UV5.PRE62A))).toContain("Trust figures are per panel slot: model independence unverified.");
  });
  it("failed slots stay explicit failures (R2): S7 keeps its failure note", () => {
    const results = REC.results.map((r: any) => (r.modelId === "chatgpt" || r.modelId === "claude" ? { ...r, ok: false, data: null, parseError: "boom" } : r));
    const out = textOf(
      renderToStaticMarkup(
        createElement(ResultsDisplay as never, {
          results: [failed("chatgpt"), failed("claude"), sub("grok"), sub("perplexity"), ok("gemini")],
          synthesizedReport: null,
          onRerun: () => {},
          onAddModel: () => {},
          question: QUESTION,
          runId: "run-1",
          synthesisStatus: "idle",
          synthesisReport: null,
          allowSynthesisGeneration: false,
          adaptive: { schemaId: "generic", classification: REC.classification, results, alignedClaims: REC.alignedClaims, gate: REC.gate, synthesisReport: REC.synthesisReport, trustSummary: REC.trustSummary },
        } as never)
      )
    );
    expect(out).toMatch(/2 models couldn't be compared/);
    expect(out).toContain("2 independent executing models answered 3 slots");
  });
  it("mock rows of the live page carry the placeholder fact (J02 wiring)", () => {
    const out = textOf(mount([mock("chatgpt"), mock("claude"), ok("grok"), ok("perplexity"), ok("gemini")]));
    expect(out).toContain("Model-written text saved with this run.");
  });
});
