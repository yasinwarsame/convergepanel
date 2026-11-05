/**
 * #290 Increment 1 — the four trust signals: stored values only, honest N/A, failed slots never counted as responses.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { CAUTION_NOTICE, GATE_STATUS_WORD, UNRECOGNIZED_GATE_NOTICE } from "@/lib/adaptiveSchema/gatePresentation";
import { behaviourSignal, buildTrustSignals, claimsWithMultipleModels, coverageCounts, coverageSignal, gateSignal, namesASource, sourcesSignal } from "../trustSignals";
import { READABLE_TRUST_COPY as C } from "../copy";

const RECORDS: Record<string, any> = JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json"), "utf8"));
const rec = (name: string) => JSON.parse(JSON.stringify(RECORDS[name]));
const STRENGTH: Record<string, number> = { pass: 3, caution: 2, fail: 1, unrecognized: 0, not_recorded: 0 };

describe("verification gate signal", () => {
  it.each([
    ["pass", "pass"],
    ["caution", "caution"],
    ["fail", "fail"],
    ["passed", "unrecognized"],
    ["PASS", "unrecognized"],
    [null, "unrecognized"],
    [42, "unrecognized"],
  ])("stored %p → state %s, worded with the frozen D6 word, never stronger than stored", (stored, expected) => {
    const r = rec("generic-mixed");
    r.synthesisReport.gate = stored;
    r.gate.status = stored;
    const s = gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport });
    expect(s.state).toBe(expected);
    expect(s.value).toBe(GATE_STATUS_WORD[expected as keyof typeof GATE_STATUS_WORD]);
    expect(STRENGTH[s.state]).toBeLessThanOrEqual(STRENGTH[typeof stored === "string" && stored in STRENGTH ? stored : "unrecognized"]);
    const text = [s.value, ...s.details, s.definition].join(" ");
    expect(text).not.toMatch(/consensus|agree|verified/i);
    if (expected !== "pass") expect(text).not.toMatch(/\bPass\b/);
  });

  it("the page's stored value wins (report copy over gate object copy, F4)", () => {
    const r = rec("generic-mixed");
    r.gate.status = "pass";
    r.synthesisReport.gate = "fail";
    expect(gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport }).value).toBe("Fail");
  });

  it("gate inputs equal stored gate.runCertainty / loadBearingSplitCount (no recomputation)", () => {
    const r = rec("generic-mixed");
    r.gate.runCertainty = 0.4237;
    r.gate.loadBearingSplitCount = 2; // deliberately inconsistent with the claims: shown as stored, not recounted
    const s = gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport });
    expect(s.details[0]).toBe(`${C.gateInputsHeading}: ${C.gateCertainty(42)}; ${C.gateSplitTop(2, r.gate.loadBearingClaims.length)}`);
    expect(s.details.join(" ")).not.toMatch(/because|due to|since/i);
  });

  it("unrecognized stored gate → neutral wording (D8 preserved): no inputs, the frozen notice", () => {
    const r = rec("generic-mixed");
    r.synthesisReport.gate = "maybe";
    const s = gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport });
    expect(s.value).toBe("Unrecognized");
    expect(s.details).toEqual([UNRECOGNIZED_GATE_NOTICE]);
  });

  it("caution carries the frozen caution notice", () => {
    const r = rec("generic-mixed");
    expect(gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport }).details).toContain(CAUTION_NOTICE);
  });

  it("no gate and no report → Not recorded", () => {
    const s = gateSignal({ gate: undefined, synthesisReport: undefined });
    expect([s.state, s.value]).toEqual(["not_recorded", C.gateNotRecorded]);
  });

  it("a report without the gate object → stored status, inputs stated as unavailable", () => {
    const r = rec("generic-consensus");
    const s = gateSignal({ gate: undefined, synthesisReport: r.synthesisReport });
    expect(s.value).toBe("Pass");
    expect(s.details).toEqual([C.gateInputsNotRecorded]);
  });
});

describe("panel coverage signal", () => {
  it("failed slot counted in dispatched, not in responded", () => {
    const m = new Map([
      ["chatgpt", "ok"],
      ["claude", "substituted"],
      ["grok", "error"],
      ["perplexity", "ok"],
      ["gemini", "timeout"],
    ]);
    expect(coverageCounts(m)).toEqual({ dispatched: 5, responded: 3, notResponded: 2, unknown: 0 });
    expect(coverageSignal({ results: [], alignedClaims: [], slotStatuses: m }).value).toBe("Responded: 3 of 5 dispatched");
  });

  it("a blank status is unknown, never counted as a response", () => {
    const m = new Map([
      ["chatgpt", "ok"],
      ["claude", ""],
    ]);
    const s = coverageSignal({ results: [], alignedClaims: [], slotStatuses: m });
    expect(s.value).toBe("Responded: 1 of 2 dispatched");
    expect(s.details).toContain(C.coverageUnknownStatus(1, 2));
  });

  it("no recorded statuses → says so; does not infer responses from parsed results", () => {
    const r = rec("generic-substituted-and-failed");
    const s = coverageSignal({ results: r.results, alignedClaims: r.alignedClaims, slotStatuses: null });
    expect(s.value).toBe(C.coverageNoStatus);
    expect(s.details[0]).toBe(C.coverageModelsInReport(r.results.length));
  });

  it("claims with positions from 2+ distinct models, counted from the stored cells", () => {
    const cell = (modelId: string) => ({ modelId, stance: "agrees" });
    const claims: any[] = [
      { id: "a", cells: [cell("chatgpt"), cell("claude"), null] },
      { id: "b", cells: [cell("chatgpt"), null, null] },
      { id: "c", cells: [cell("grok"), cell("grok")] },
      { id: "d", cells: [null, null] },
    ];
    expect(claimsWithMultipleModels(claims)).toEqual({ multi: 1, total: 4 });
    expect(claimsWithMultipleModels(undefined)).toEqual({ multi: 0, total: 0 });
  });
});

describe("sources signal", () => {
  it.each(["generic", "procedural", "forecast_speculative", "legal_regulatory", "creative_generative"])('%s schema → sources "N/A" and never "100%"', (schemaId) => {
    const schema = getResultSchema(schemaId as any);
    const results = [{ modelId: "chatgpt", schemaId, ok: true, data: {} }] as any;
    const s = sourcesSignal({ schema, results });
    expect([s.state, s.value]).toEqual(["not_requested", C.sourcesNotRequested]);
    expect([s.value, ...s.details].join(" ")).not.toMatch(/%/);
  });

  it("financial_valuation: named / total over parsed responses' metric sources, same rule as isRealSource", () => {
    const schema = getResultSchema("financial_valuation");
    const metricKey = schema.fields.find((f) => f.type === "metric[]")!.key;
    const m = (source: string) => ({ label: "x", value: 1, unit: "u", asOf: "unknown", source });
    const results: any[] = [
      { modelId: "chatgpt", ok: true, data: { [metricKey]: [m("SEC 10-K"), m("unknown"), m(" N/A ")] } },
      { modelId: "claude", ok: true, data: { [metricKey]: [m("Bloomberg"), m("")] } },
      { modelId: "grok", ok: false, data: { [metricKey]: [m("Ignored: failed parse")] } },
    ];
    const s = sourcesSignal({ schema, results });
    expect([s.state, s.value]).toEqual(["named", "Named: 2 of 5 values"]);
    expect(s.details).toEqual([C.sourcesNamedDetail]);
  });

  it("a schema that asks for sources but got none named → None recorded, not a percentage", () => {
    const schema = getResultSchema("factual_lookup");
    const s = sourcesSignal({ schema, results: [{ modelId: "chatgpt", ok: true, data: { answer: "Paris", source: "unknown" } }] as any });
    expect([s.state, s.value]).toEqual(["none_recorded", C.sourcesNone(1)]);
  });

  it("namesASource mirrors trustSummary.isRealSource", () => {
    for (const v of ["", "  ", "unknown", "UNKNOWN", "none", "n/a", " N/A ", null, undefined, 5]) expect(namesASource(v)).toBe(false);
    expect(namesASource("Atlas")).toBe(true);
    // The server rule, read from its source text, is the same four exclusions.
    const server = readFileSync(join(process.cwd(), "lib/adaptiveSchema/trustSummary.ts"), "utf8");
    expect(server).toContain('return normalized.length > 0 && normalized !== "unknown" && normalized !== "none" && normalized !== "n/a";');
  });
});

describe("model behaviour score signal", () => {
  it("shows the stored overallTrust, rounded, labelled as stored; flags the vacuous citation part on a no-source schema", () => {
    const r = rec("generic-mixed");
    const s = behaviourSignal({ schema: getResultSchema("generic"), results: r.results, trustSummary: r.trustSummary });
    expect(s.value).toBe(`${Math.round(r.trustSummary.overallTrust * 100)}% (stored score)`);
    expect(s.details).toEqual([C.behaviourCitationNotApplicable]);
    expect(s.name).not.toMatch(/trust|reliab|accura|grounding/i);
  });

  it.each([undefined, null, { perModel: [] }, { overallTrust: NaN }, { overallTrust: "0.9" }])("unscored stays unscored: %p", (ts) => {
    const s = behaviourSignal({ schema: getResultSchema("generic"), results: [], trustSummary: ts as any });
    expect([s.state, s.value]).toEqual(["not_scored", C.behaviourNotScored]);
  });

  it("a source-requesting schema with no values gives a different, still honest note", () => {
    const s = behaviourSignal({ schema: getResultSchema("financial_valuation"), results: [{ modelId: "chatgpt", ok: true, data: {} }] as any, trustSummary: { perModel: [], overallTrust: 0.5 } });
    expect(s.details).toEqual([C.behaviourCitationNoValues]);
  });
});

describe("buildTrustSignals", () => {
  it("four separately labelled signals, fixed order, distinct names and definitions", () => {
    const r = rec("generic-mixed");
    const signals = buildTrustSignals({ schema: getResultSchema("generic"), results: r.results, alignedClaims: r.alignedClaims, gate: r.gate, synthesisReport: r.synthesisReport, trustSummary: r.trustSummary, slotStatuses: null });
    expect(signals.map((s) => s.id)).toEqual(["gate", "coverage", "sources", "behaviour"]);
    expect(new Set(signals.map((s) => s.name)).size).toBe(4);
    expect(new Set(signals.map((s) => s.definition)).size).toBe(4);
    for (const s of signals) expect(s.value.length).toBeGreaterThan(0);
  });

  it("the copy never calls the gate consensus, never says verified, and states sources are not checked", () => {
    const all = JSON.stringify(C, (_k, v) => (typeof v === "function" ? v(1, 2) : v));
    expect(all).not.toMatch(/consensus|verified|majority/i);
    expect(C.sourcesDefinition).toMatch(/not checked/);
    expect(C.behaviourDefinition).toMatch(/not whether the answer is correct/);
  });
});
