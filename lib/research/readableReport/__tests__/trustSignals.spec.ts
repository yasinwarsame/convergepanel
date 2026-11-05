/**
 * #290 Increment 1 — the four trust signals: stored values only, honest N/A, failed slots never counted as responses.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { CAUTION_NOTICE, GATE_STATUS_WORD, UNRECOGNIZED_GATE_NOTICE } from "@/lib/adaptiveSchema/gatePresentation";
import { GATE_THRESHOLDS } from "@/lib/adaptiveSchema/config";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import {
  behaviourSignal,
  buildTrustSignals,
  vacuousCitationCounts,
  claimsWithMultipleModels,
  coverageCounts,
  coverageSignal,
  gateSignal,
  namesASource,
  readableLegacyGateBannerLabels,
  sourcesSignal,
  storedGateConsistency,
} from "../trustSignals";
import { READABLE_GATE_COPY as G, READABLE_TRUST_COPY as C } from "../copy";

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
    expect(coverageCounts(m)).toEqual({ dispatched: 5, responded: 3, substituted: 1, notResponded: 2, unknown: 0 });
    expect(coverageSignal({ results: [], alignedClaims: [], slotStatuses: m }).value).toBe("Responded: 3 of 5 dispatched, including 1 answered by a substitute model");
  });

  it("review MINOR-2: substituted slots are never shown as the asked model responding (5 dispatched, 3 substituted)", () => {
    const m = new Map([
      ["chatgpt", "ok"],
      ["claude", "substituted"],
      ["grok", "substituted"],
      ["perplexity", "ok"],
      ["gemini", "substituted"],
    ]);
    const s = coverageSignal({ results: [], alignedClaims: [], slotStatuses: m });
    expect(s.value).toBe("Responded: 5 of 5 dispatched, including 3 answered by a substitute model");
    expect(s.value).not.toBe("Responded: 5 of 5 dispatched");
    expect(s.details).toContain(C.coverageSubstitutedDetail(3));
    const plain = coverageSignal({ results: [], alignedClaims: [], slotStatuses: new Map([["chatgpt", "ok"]]) });
    expect(plain.value).toBe("Responded: 1 of 1 dispatched");
    expect(plain.details.join(" ")).not.toMatch(/substitute/);
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
  it("review MINOR-4: legal_regulatory (which asks for keyAuthority) is never told it asks for no sources", () => {
    const schema = getResultSchema("legal_regulatory");
    expect(schema.fields.some((f) => f.key === "keyAuthority")).toBe(true);
    const s = sourcesSignal({ schema, results: [{ modelId: "chatgpt", ok: true, data: {} }] as any });
    const text = [s.value, ...s.details].join(" ");
    expect(text).not.toMatch(/does not ask models for sources|not requested/i);
    expect(text).toMatch(/no values that are scored for a named source/);
    expect(text).toMatch(/authorities or sources a model mentions in its text are not counted/);
  });

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

  it("review MINOR-3: a partial vacuous citation mark is disclosed (some parsed responses had no value to source)", () => {
    const schema = getResultSchema("financial_valuation");
    const key = schema.fields.find((f) => f.type === "metric[]")!.key;
    const results: any[] = [
      { modelId: "chatgpt", ok: true, data: { [key]: [{ label: "x", value: 1, unit: "u", asOf: "unknown", source: "SEC" }] } },
      { modelId: "claude", ok: true, data: {} },
      { modelId: "grok", ok: true, data: { [key]: [] } },
      { modelId: "gemini", ok: false, data: null },
    ];
    const s = behaviourSignal({ schema, results, trustSummary: { perModel: [], overallTrust: 0.8 } });
    expect(s.details).toEqual([C.behaviourCitationPartial(2, 3)]);
    expect(vacuousCitationCounts(schema, results)).toEqual({ parsed: 3, vacuous: 2 });
    // Every parsed response sourced something → no note.
    expect(behaviourSignal({ schema, results: [results[0]], trustSummary: { perModel: [], overallTrust: 0.8 } }).details).toEqual([]);
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

/**
 * Review of cb2febb (MINOR): a legacy record whose stored gate contradicts its recorded inputs. storedGateConsistency
 * re-states gate.ts's decision on the two recorded inputs; the differential below holds it to the REAL computeAdaptiveGate
 * (rows built so the real gate sees exactly the given certainty and load-bearing split count), so a drift in either
 * fails here.
 */
describe("storedGateConsistency (legacy records only; read-only)", () => {
  const cell = (m: string) => ({ modelId: m, stance: "agrees" });
  /** n claims raised by 3 models, the first `splits` of them split (all equally raised, so the real gate keeps stored order). */
  const rows = (n: number, splits: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `c${i}`, claimText: `c${i}`, status: i < splits ? "split" : "consensus", cells: ["a", "b", "c"].map(cell) }));
  const legacyOf = (gate: any, reportGate: unknown = gate.status) => ({ gate, synthesisReport: { gate: reportGate }, schemaId: "generic" });

  const CERTAINTIES = [0, GATE_THRESHOLDS.cautionMin - 0.01, GATE_THRESHOLDS.cautionMin, 0.6, GATE_THRESHOLDS.passMin - 0.001, GATE_THRESHOLDS.passMin, 0.9, 1];
  const GRID = CERTAINTIES.flatMap((c) => [0, 1, 2, 3].map((s) => [c, s] as const));

  it.each(GRID)("certainty %p, %p load-bearing splits: the real gate's status is consistent; every other stored status is inconsistent", (certainty, splits) => {
    const real = JSON.parse(JSON.stringify(computeAdaptiveGate(rows(4, splits), certainty, "generic")));
    expect(real.loadBearingSplitCount).toBe(Math.min(splits, GATE_THRESHOLDS.loadBearingTopN));
    expect(storedGateConsistency(legacyOf(real))).toBe("consistent");
    expect(readableLegacyGateBannerLabels(legacyOf(real))).toBe(G.legacyBanner);
    for (const other of ["pass", "caution", "fail"].filter((s) => s !== real.status)) {
      const g = { ...real, status: other };
      expect([other, storedGateConsistency(legacyOf(g))]).toEqual([other, "inconsistent"]);
      expect(readableLegacyGateBannerLabels(legacyOf(g))).toEqual({ pass: G.inconsistentBanner, caution: G.inconsistentBanner, fail: G.inconsistentBanner });
    }
  });

  it("factual_lookup: a stored caution where the inputs alone give pass is consistent (gate.ts's row cap); the reverse is not", () => {
    const g = { status: "caution", runCertainty: 0.95, loadBearingSplitCount: 0, loadBearingClaims: [] };
    expect(storedGateConsistency({ gate: g, synthesisReport: { gate: "caution" }, schemaId: "factual_lookup" })).toBe("consistent");
    expect(storedGateConsistency({ gate: g, synthesisReport: { gate: "caution" }, schemaId: "generic" })).toBe("inconsistent");
    const f = { status: "pass", runCertainty: 0.6, loadBearingSplitCount: 0, loadBearingClaims: [] };
    expect(storedGateConsistency({ gate: f, synthesisReport: { gate: "pass" }, schemaId: "factual_lookup" })).toBe("inconsistent");
  });

  it("two stored results that differ are inconsistent, even without inputs", () => {
    expect(storedGateConsistency({ gate: { status: "pass" } as any, synthesisReport: { gate: "fail" } })).toBe("inconsistent");
    expect(storedGateConsistency({ gate: { status: "fail" } as any, synthesisReport: { gate: "pass" } })).toBe("inconsistent");
    expect(storedGateConsistency({ gate: { status: "pass" } as any, synthesisReport: { gate: "pass" } })).toBe("inputs_not_recorded");
  });

  it("a recorded split count that disagrees with the recorded load-bearing claims is inconsistent", () => {
    const real = JSON.parse(JSON.stringify(computeAdaptiveGate(rows(3, 1), 0.9, "generic")));
    expect(storedGateConsistency(legacyOf(real))).toBe("consistent");
    expect(storedGateConsistency(legacyOf({ ...real, loadBearingSplitCount: 0, status: "pass" }))).toBe("inconsistent");
    // Without the claims list, the count alone is checked against the status.
    const { loadBearingClaims: _drop, ...noList } = real;
    expect(storedGateConsistency(legacyOf(noList))).toBe("consistent");
  });

  it.each([
    ["certainty missing", { runCertainty: undefined }],
    ["certainty not a number", { runCertainty: "0.9" }],
    ["certainty NaN", { runCertainty: NaN }],
    ["split count missing", { loadBearingSplitCount: undefined }],
    ["split count fractional", { loadBearingSplitCount: 0.5 }],
    ["split count negative", { loadBearingSplitCount: -1 }],
  ])("missing or malformed inputs (%s) are not inconsistent — nothing to check against", (_n, patch) => {
    const g = { status: "fail", runCertainty: 0.99, loadBearingSplitCount: 0, loadBearingClaims: [], ...patch };
    expect(storedGateConsistency(legacyOf(g))).toBe("inputs_not_recorded");
    expect(readableLegacyGateBannerLabels(legacyOf(g))).toBe(G.legacyBanner);
  });

  it("not applicable: an Order 4 report (its wording is unchanged), an unrecognized stored value, no gate at all", () => {
    const wrong = { status: "pass", runCertainty: 0.1, loadBearingSplitCount: 3, loadBearingClaims: [] };
    expect(storedGateConsistency({ gate: wrong, synthesisReport: { gate: "pass", presentation: { verificationGate: { status: "pass" } } as any } })).toBe("not_applicable");
    expect(storedGateConsistency({ gate: { ...wrong, status: "verified-ish" }, synthesisReport: { gate: "verified-ish" } })).toBe("not_applicable");
    expect(storedGateConsistency({})).toBe("not_applicable");
  });

  it("gateSignal on an inconsistent legacy record: Unavailable, inputs still shown, no notice; Order 4 copy unchanged", () => {
    const r = rec("generic-mixed");
    expect(r.gate.status).toBe("caution");
    r.gate.status = "pass";
    r.synthesisReport.gate = "pass";
    const order4 = gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport });
    expect([order4.value, order4.state]).toEqual(["Pass", "pass"]);
    delete r.synthesisReport.presentation;
    const s = gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport, schemaId: r.schemaId });
    expect([s.value, s.state]).toEqual(["Unavailable", "inconsistent"]);
    expect(s.details[0]).toContain(C.gateInputsHeading);
    expect(s.details).toContain("The stored result is inconsistent with its recorded inputs, so no gate result is shown.");
    expect(s.details.join(" ")).not.toContain(CAUTION_NOTICE);
    expect(JSON.stringify(r.gate.status)).toBe('"pass"'); // stored data untouched
  });

  it("gateSignal on an inconsistent stored caution: no caution notice beside Unavailable", () => {
    const r = rec("generic-consensus");
    expect(r.gate.status).toBe("pass");
    r.gate.status = "caution";
    r.synthesisReport.gate = "caution";
    delete r.synthesisReport.presentation;
    const s = gateSignal({ gate: r.gate, synthesisReport: r.synthesisReport, schemaId: r.schemaId });
    expect([s.value, s.state]).toEqual(["Unavailable", "inconsistent"]);
    expect(s.details).not.toContain(CAUTION_NOTICE);
  });
});
