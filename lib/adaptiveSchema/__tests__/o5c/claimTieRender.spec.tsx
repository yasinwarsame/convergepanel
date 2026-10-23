/**
 * Order 5 Contract C1 (claim-tie attribution) — presentation: the trust note is selected by the summary's own
 * attributionRule (never the Contract P marker); exports pass the field through and show only the grounding level they
 * already showed; and on a degraded slot whose cap stops binding, the cap indicators go with the cap while the
 * parse-health disclosures stay.
 */
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildAdaptiveTrustSummary } from "@/lib/adaptiveSchema/trustSummary";
import { CLAIM_TIE_ATTRIBUTION_RULE } from "@/lib/adaptiveSchema/types";
import { TRUST_SCORE_CAP_REASON } from "@/lib/adaptiveSchema/config";
import ListView from "@/components/adaptive/ListView";
import { TRUST_INPUTS_NOTE, TRUST_INPUTS_NOTE_CLAIM_TIE, trustInputsNoteFor } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { CLASSIFICATION_BASE, DEFAULT_MODE, SCENARIOS, geminiMockImpl } from "../o5p/o5pScenarios";
import { QUESTION, renderRecord } from "../o5p/o5pRender";
import { htmlText } from "../o5p/htmlText";
import { legacyTrust } from "./claimTieOracle";
import { claimRow, degradedResult, okResult } from "./claimTieFixtures";

const gem = callGemini as unknown as jest.Mock;
const esc = (s: string) => renderToStaticMarkup(createElement("i", null, s)).slice(3, -4);

async function build(name: string): Promise<{ record: Record<string, any>; input: any[] }> {
  const s = SCENARIOS.find((x) => x.name === name)!;
  gem.mockReset();
  gem.mockImplementation(geminiMockImpl({ ...DEFAULT_MODE, ...(s.mode ?? {}) }));
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  const input = s.results();
  const classification = { ...CLASSIFICATION_BASE, queryType: s.schemaId, answerShape: getResultSchema(s.schemaId as any).renderHint } as any;
  const r: any = await finalizeAdaptiveRun(getResultSchema(s.schemaId as any), input, QUESTION, undefined, classification);
  const record = r.persistedLegacyOutput
    ? JSON.parse(JSON.stringify({ ...r.persistedLegacyOutput, generatedAt: undefined }))
    : JSON.parse(JSON.stringify({ schemaId: r.schemaId, classification, results: r.adaptiveResults, alignedClaims: r.alignedClaims, gate: r.gate, synthesisReport: r.synthesisReport, trustSummary: r.trustSummary }));
  return { record, input };
}

/** The record with its trust summary replaced by the frozen legacy oracle's (what 625773767 stored). */
function withLegacyTrust(record: Record<string, any>) {
  return { ...record, trustSummary: JSON.parse(JSON.stringify(legacyTrust(getResultSchema(record.schemaId) as any, record.results, record.alignedClaims))) };
}

describe("trust note selection", () => {
  it("is keyed on attributionRule, never on the presentation marker", () => {
    expect(trustInputsNoteFor({ perModel: [], overallTrust: 0 })).toBe(TRUST_INPUTS_NOTE);
    expect(trustInputsNoteFor({ perModel: [], overallTrust: 0, attributionRule: CLAIM_TIE_ATTRIBUTION_RULE })).toBe(TRUST_INPUTS_NOTE_CLAIM_TIE);
    expect(trustInputsNoteFor({ perModel: [], overallTrust: 0, attributionRule: "something_else" as any })).toBe(TRUST_INPUTS_NOTE);
  });

  it("the claim-tie note states both rules: claim ties credit nobody, every other tie is slot order; disputes on tied claim rows count", () => {
    expect(TRUST_INPUTS_NOTE_CLAIM_TIE).toContain("On a claim row where two or more stances tie for most common, no slot is credited");
    expect(TRUST_INPUTS_NOTE_CLAIM_TIE).toContain("any other tie, including on a value, metric, scenario or step comparison, is decided by slot order");
    expect(TRUST_INPUTS_NOTE_CLAIM_TIE).toContain("Contradictions: split rows where the slot disputes and is not credited, so on a tied claim row every slot that disputes");
    // It never claims every tie was corrected, and never mentions verification.
    expect(TRUST_INPUTS_NOTE_CLAIM_TIE).not.toMatch(/every tie|all ties|verified|improved/i);
    // The parts of the note that do not concern ties are the shipped note's, word for word.
    const shared = (n: string) => [n.split(" Stance match:")[0], n.slice(n.indexOf(" Items contributed:"))];
    expect(shared(TRUST_INPUTS_NOTE_CLAIM_TIE)).toEqual(shared(TRUST_INPUTS_NOTE));
  });

  it("a marked pipeline record with a claim tie renders the claim-tie note; the same record without the field renders the shipped note", async () => {
    const { record, input } = await build("generic-mixed");
    expect(record.trustSummary.attributionRule).toBe(CLAIM_TIE_ATTRIBUTION_RULE);
    expect(record.synthesisReport.presentation.disagreementPositionVersion).toBe(1);
    const tied = (await renderRecord(record as any, input))["ui.synthesisView"]!;
    expect(tied).toContain(esc(TRUST_INPUTS_NOTE_CLAIM_TIE));
    expect(tied).not.toContain(esc(TRUST_INPUTS_NOTE));
    const { attributionRule: _r, ...noRule } = record.trustSummary;
    const legacyNote = (await renderRecord({ ...record, trustSummary: noRule } as any, input))["ui.synthesisView"]!;
    expect(legacyNote).toContain(esc(TRUST_INPUTS_NOTE));
    expect(legacyNote).not.toContain(esc(TRUST_INPUTS_NOTE_CLAIM_TIE));
  });

  it("an unmarked record shows no note at all, with or without the field (marker still gates display only)", async () => {
    const { record, input } = await build("generic-mixed");
    const presentation = { ...record.synthesisReport.presentation };
    delete presentation.disagreementPositionVersion;
    const unmarked = { ...record, synthesisReport: { ...record.synthesisReport, presentation } };
    const html = (await renderRecord(unmarked as any, input))["ui.synthesisView"]!;
    expect(html).not.toContain(esc(TRUST_INPUTS_NOTE_CLAIM_TIE));
    expect(html).not.toContain(esc(TRUST_INPUTS_NOTE));
  });
});

describe("exports", () => {
  it("JSON passes attributionRule through; PDF, DOCX, Markdown and posts are identical to the legacy-trust record when the grounding level is the same", async () => {
    const { record, input } = await build("generic-mixed");
    const legacy = withLegacyTrust(record);
    const a = await renderRecord(record as any, input);
    const b = await renderRecord(legacy as any, input);
    expect(a["export.json"]).toMatch(new RegExp(`"attributionRule": ?"${CLAIM_TIE_ATTRIBUTION_RULE}"`));
    expect(b["export.json"]).not.toContain("attributionRule");
    const tier = (t: number) => (t >= 0.6 ? "strong" : t >= 0.35 ? "moderate" : "weak");
    expect(record.trustSummary.overallTrust).toBeLessThanOrEqual(legacy.trustSummary.overallTrust);
    expect(tier(record.trustSummary.overallTrust)).toBe(tier(legacy.trustSummary.overallTrust));
    for (const k of ["export.pdfTree", "export.docxXml", "text.markdown", "text.linkedin", "text.x", "text.memo", "text.memoInput"]) expect([k, a[k]]).toEqual([k, b[k]]);
  });
});

describe("degraded slot whose cap stops binding (O-B)", () => {
  const schema = getResultSchema("generic" as any);
  const results = [degradedResult("chatgpt"), okResult("claude")];
  const rows = [claimRow("r", "split", ["agrees", "disputes"])];
  const legacyTs = JSON.parse(JSON.stringify(legacyTrust(schema as any, results as any, rows as any)));
  const candTs = buildAdaptiveTrustSummary(schema, results, rows);

  function listView(trustSummary: any): string {
    const gate = { status: "caution", reasons: [], runCertainty: 0.5 } as any;
    const synthesisReport = { presentation: undefined } as any;
    return renderToStaticMarkup(createElement(ListView as any, { schema, results, alignedClaims: rows, gate, synthesisReport, trustSummary }));
  }

  it("numbers: raw 1.0 capped to 0.75 → raw 0.65 below the cap; effective trust falls 0.75 → 0.65; parseHealth unchanged", () => {
    expect(legacyTs.perModel[0]).toMatchObject({ trustScore: 0.75, capped: true, parseHealth: "degraded", majorityAlignment: 1 });
    expect(candTs.perModel[0]).toMatchObject({ capped: false, parseHealth: "degraded", majorityAlignment: 0 });
    expect(candTs.perModel[0].trustScore).toBeCloseTo(0.65, 12);
  });

  it("the cap badge and cap tooltip go with the cap; the degraded health dot stays; no favourable message appears", () => {
    const before = listView(legacyTs);
    const after = listView(candTs);
    expect(before).toContain("degraded · trust capped");
    expect(before).toContain(esc(TRUST_SCORE_CAP_REASON.degraded!));
    expect(after).not.toContain("degraded · trust capped");
    expect(after).not.toContain(esc(TRUST_SCORE_CAP_REASON.degraded!));
    expect(before).toContain('title="Parse health: degraded"');
    expect(after).toContain('title="Parse health: degraded"');
    expect(htmlText(before)).toContain("trust 75%");
    expect(htmlText(after)).toContain("trust 65%");
    expect(after).not.toMatch(/improv|trust rose|trust increased|verified/i);
    // Exactly what the shipped code renders for any degraded slot below the cap: the same ListView, row for row,
    // as a legacy summary carrying these values.
    const shippedBelowCap = { ...legacyTs, perModel: legacyTs.perModel.map((m: any, i: number) => (i === 0 ? { ...m, ...candTs.perModel[0] } : m)) };
    expect(after).toBe(listView(shippedBelowCap));
  });
});
