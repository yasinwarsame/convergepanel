/**
 * Order 29 (C-a closeout, owner Option (a)) — the exports' model independence over the version-2 frozen provenance
 * (lib/adaptiveSchema/exportRunProvenance.ts → runModelProvenanceFromExport → identityRowFromFacts → the shared gate).
 *
 * M-1 (MAJOR): a version-1 frozen `substituted: false` covered failed slots too, and the facts adapter read it as an
 * answered row ("ok") without a provider, so a PDF / DOCX of a run with one failed slot read "model independence
 * unverified". Now every frozen entry carries the slot's RECORDED outcome (exact persisted-status match) and the
 * adapter maps a recorded failure to its failure status: shown as failed, excluded from the voices, never "unverified"
 * by itself. A version-1 entry (no outcome), or any value that is not literally valid, is unknown → the gate fails
 * closed (owner-accepted: older frozen exports read as unverified rather than reconstructing history).
 * m-1: the exports apply the F-2 stored-placeholder rule (the D-5 class is frozen from the persisted row's text).
 * Finding "K=0 → IND": a run with no answered row is never a verified independent run on any surface.
 *
 * Every case runs the REAL export path: buildExportSnapshot (the real freeze) → AdaptiveResearchDocument (react-pdf
 * primitives mocked to string tags, text extracted as the PDF draws it) and the real DOCX renderer + packer (text read
 * from the real package).
 */
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { readFileSync } from "fs";
import { join } from "path";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { readFrozenRunExecutionProvenance, readFrozenRunProvenance } from "@/lib/adaptiveSchema/exportRunProvenance";
import { EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED, exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";
import { ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING, ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING, ADAPTIVE_PLACEHOLDER_TOP_HEADING, FAILED_SUPPORTERS_CLAUSE, FAILED_SUPPORTERS_RUN, NO_RESPONSES_RUN, TOO_FEW_ANSWERS_RUN, TOO_FEW_ANSWERS_STATEMENT, NO_SUCCESSFUL_MODEL_RESPONSES, placeholderSlotsClause } from "@/lib/adaptiveSchema/verdictIndependence";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";
import { identityRowFromFacts, runExecutionIdentity, executionIdentityVerified, STORED_PLACEHOLDER_LITERALS, type RunExecutionIdentity } from "@/lib/panel/executionIdentity";
import { runModelProvenanceFromExport } from "@/lib/panel/runModelIdentity";
import { withIndependentFrozenProvenance } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { DECISION_SUPPORT_SCHEMA_ID as EPV_DS_ID } from "@/lib/adaptiveSchema/exportPositionView";
import { DECISION_SUPPORT_SCHEMA_ID as DS_ID } from "@/lib/adaptiveSchema/dsLabelWording";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const QUESTION = "Does raising the minimum wage reduce employment?";
const PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

/** A persisted perModel row as lib/firestore/runs.ts writes it (status, provider, requestedModel, rawTextTruncated). */
type Row = { modelId: string; status?: unknown; provider?: string | null; requestedModel?: string; substitutedFrom?: string; rawText?: string | null };
const R = (modelId: string, over: Partial<Row> = {}): Row => ({ modelId, status: "ok", provider: PROVIDER[modelId], requestedModel: `${modelId}-model-1`, rawText: "Paris.", ...over });
const answered = (r: Row) => r.status === "ok" || r.status === "substituted";
/** A failed call as the live normalizer persists it: a failure status, no text, and no provider (or its "unknown" placeholder). */
const timedOut = (modelId: string, provider: string | null = null): Row => R(modelId, { status: "timeout", provider, rawText: null });
const errored = (modelId: string, provider: string | null = null): Row => R(modelId, { status: "error", provider, rawText: null });
const substitutedByDeepSeek = (modelId: string): Row => R(modelId, { status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: `${PROVIDER[modelId]}:${modelId}-model-1` });
const placeholder = (modelId: "chatgpt" | "claude"): Row => R(modelId, { rawText: STORED_PLACEHOLDER_LITERALS[modelId] });

function perModelRow(r: Row): Record<string, unknown> {
  return {
    modelId: r.modelId,
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.requestedModel ? { requestedModel: r.requestedModel } : {}),
    ...(r.substitutedFrom ? { substitutedFrom: r.substitutedFrom } : {}),
    rawTextTruncated: r.rawText ?? "",
  };
}

/** The real export snapshot of a legacy-family record over the run's persisted rows, in the AdaptiveResearchExportV1 envelope. */
function exportOf(rec: any, rows: Row[], format: "pdf" | "docx" = "pdf"): AdaptiveResearchExportV1 {
  const built = buildExportSnapshot({
    question: QUESTION,
    selectedModels: rows.map((r) => r.modelId) as never[],
    modelResultsOkByModelId: Object.fromEntries(rows.map((r) => [r.modelId, answered(r)])),
    runDocument: { perModel: rows.map(perModelRow) },
    legacy: { output: { version: 1, generatedAt: "2026-10-01T00:00:00.000Z", ...rec }, governanceStatus: "approved", governanceMeta: { policyVersion: 3 } },
  });
  return {
    version: 1,
    exportId: "exp-o29",
    runId: "run-o29",
    schemaId: rec.schemaId,
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: "uid-o29",
    format,
    artifactStatus: "ready",
    classification: built.classification,
    governanceStatusAtExport: built.governanceStatusAtExport,
    reportSnapshot: built.reportSnapshot,
    exportMetadata: { exportId: "exp-o29", runId: "run-o29", schemaVersion: 1, exportedSections: ["reportSnapshot"], createdAt: "2026-10-01T00:00:00.000Z", requestingUser: "uid-o29", finalReportVersion: 1 },
  } as AdaptiveResearchExportV1;
}

const pdfText = (r: AdaptiveResearchExportV1) => extractPdfElementText(AdaptiveResearchDocument({ record: r }));
const docxText = async (r: AdaptiveResearchExportV1) => extractDocxText((await renderAdaptiveResearchDocxV1({ ...r, format: "docx" })).bytes);
const bothTexts = async (r: AdaptiveResearchExportV1): Promise<[string, string][]> => [["pdf", pdfText(r)], ["docx", await docxText(r)]];

/** The export's per-slot facts exactly as exportPositionView builds them, counted by the shared rule (never by a renderer). */
function exportIdentity(r: AdaptiveResearchExportV1): RunExecutionIdentity {
  const frozen = readFrozenRunExecutionProvenance(r.reportSnapshot.runProvenance);
  const roster = (r.reportSnapshot.models ?? []).map((m) => m.modelId as string);
  return runExecutionIdentity(roster.map((id) => identityRowFromFacts(runModelProvenanceFromExport(frozen, id))));
}
const frozenEntry = (r: AdaptiveResearchExportV1, modelId: string) => readFrozenRunExecutionProvenance(r.reportSnapshot.runProvenance)!.models.find((m) => m.modelId === modelId)!;

const UNVERIFIED_WORDS = /model independence unverified|independence unverified/i;
const UNQUALIFIED_TOP = /Top consensus(?! \()/;
/** A legacy export record as stored before Order 29: the identity facts only (no outcome, no version marker). */
function asVersionOne(r: AdaptiveResearchExportV1): AdaptiveResearchExportV1 {
  const out = clone(r);
  (out.reportSnapshot as any).runProvenance = readFrozenRunProvenance(r.reportSnapshot.runProvenance);
  return out;
}

describe("Order 29 — exports judge model independence from the frozen per-slot outcome", () => {
  const CONS = () => clone(records["generic-consensus"]);
  const SUBF = () => clone(records["generic-substituted-and-failed"]);

  it("case 1: 5 answered, 5 distinct verified identities → 5 independent models; nothing qualified in the PDF or DOCX", async () => {
    const rec = exportOf(CONS(), FIVE.map((m) => R(m)));
    expect(rec.reportSnapshot.runProvenance).toMatchObject({ provenanceVersion: 2 });
    for (const m of FIVE) expect(frozenEntry(rec, m)).toMatchObject({ outcome: "answered", outcomeSource: "recorded", provider: PROVIDER[m], substituted: false });
    expect(exportIdentity(rec)).toMatchObject({ kind: "IND", verified: true, independentModels: 5, answeredSlots: 5, panelSlots: 5, qualified: false });
    expect(exportRunIndependence(rec)).toBeNull();
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, UNVERIFIED_WORDS.test(text)]).toEqual([k, false]);
      expect([k, text.includes("placeholder")]).toEqual([k, false]);
      expect([k, text.includes("substituting")]).toEqual([k, false]);
      expect([k, text.includes("(failed)")]).toEqual([k, false]);
    }
  });

  it.each([
    ["a recorded timeout with no provider", timedOut("grok")],
    ["a recorded error with the normalizer's 'unknown' provider", errored("grok", "unknown")],
    ["a recorded timeout that still carries its provider", timedOut("grok", "xai")],
  ])("case 2 (the M-1 regression): 4 answered + %s → 4 independent, the slot shown as failed, never 'unverified'", async (_label, failedRow) => {
    const rows = [R("chatgpt"), substitutedByDeepSeek("claude"), failedRow, R("perplexity"), R("gemini")];
    const rec = exportOf(SUBF(), rows);
    expect(frozenEntry(rec, "grok")).toMatchObject({ outcome: failedRow.status === "timeout" ? "timeout" : "failed", outcomeSource: "recorded", substituted: false });
    expect(frozenEntry(rec, "grok").provider).toBe(failedRow.provider ?? undefined);
    // The facts the export judges: the failed slot has its recorded failure status and no vote; the run is verified over the 4 answered slots.
    // "error" freezes as the "failed" outcome (PERSISTED_STATUS_OUTCOMES) and reads back as the "failed" status.
    expect(runModelProvenanceFromExport(readFrozenRunExecutionProvenance(rec.reportSnapshot.runProvenance), "grok")).toMatchObject({ modelId: "grok", status: failedRow.status === "error" ? "failed" : failedRow.status });
    expect(exportIdentity(rec)).toMatchObject({ kind: "IND", verified: true, independentModels: 4, answeredSlots: 4, panelSlots: 5 });
    expect(exportRunIndependence(rec)).toBeNull();
    expect(exportPositionSafeReport(rec).independence).toBeNull();
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, UNVERIFIED_WORDS.test(text)]).toEqual([k, false]);
      expect([k, /Grok · requested: grok-model-1\s+\(failed\)/.test(text)]).toEqual([k, true]);
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, false]);
    }
    // The identity-only read-back (labels, JSON) is the version-1 shape: the failed slot's `substituted: false` without a provider, as before.
    expect(readFrozenRunProvenance(rec.reportSnapshot.runProvenance)!.models.find((m) => m.modelId === "grok")).toEqual({ modelId: "grok", requestedModel: "grok-model-1", substituted: false, ...(failedRow.provider ? { provider: failedRow.provider } : {}) });
  });

  it("case 2, marked record: the same run under the Contract P position view is not 'unverified' either", async () => {
    const marked = SUBF();
    marked.synthesisReport.presentation.disagreementPositionVersion = 1;
    const rec = exportOf(marked, [R("chatgpt"), substitutedByDeepSeek("claude"), timedOut("grok"), R("perplexity"), R("gemini")]);
    const { view } = exportPositionSafeReport(rec);
    expect(view).not.toBeNull();
    expect(view!.verdict.topIndependence).toBeUndefined();
    for (const [k, text] of await bothTexts(rec)) expect([k, UNVERIFIED_WORDS.test(text)]).toEqual([k, false]);
  });

  it("case 3: one executing model filling 2 slots → counted once; the substitution is disclosed in the PDF and DOCX", async () => {
    const rec = exportOf(CONS(), [substitutedByDeepSeek("chatgpt"), substitutedByDeepSeek("claude"), R("grok"), R("perplexity"), R("gemini")]);
    expect(frozenEntry(rec, "chatgpt")).toMatchObject({ outcome: "answered", outcomeSource: "recorded", substituted: true, provider: "deepseek", substitutedFrom: "openai:chatgpt-model-1" });
    expect(exportIdentity(rec)).toMatchObject({ kind: "PC", verified: true, independentModels: 4, answeredSlots: 5, panelSlots: 5 });
    expect(exportRunIndependence(rec)).toMatchObject({ kind: "repeated_substitute", scope: "run", repeated: ["DeepSeek (substituting ChatGPT, Claude)"] });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes("Top consensus (4 independent models; a substitute model that answered several slots counted once)")]).toEqual([k, true]);
      expect([k, text.includes("DeepSeek (substituting ChatGPT, Claude)")]).toEqual([k, true]);
      expect([k, UNQUALIFIED_TOP.test(text)]).toEqual([k, false]);
      expect([k, /agreed by \d+ model/.test(text)]).toEqual([k, false]);
      expect([k, text.includes("5 independent model")]).toEqual([k, false]);
      expect([k, UNVERIFIED_WORDS.test(text)]).toEqual([k, false]);
    }
  });

  it("case 4 (m-1): a stored placeholder row is frozen as such and never counted as an independent model in the PDF or DOCX", async () => {
    const rec = exportOf(CONS(), [placeholder("chatgpt"), R("claude"), R("grok"), R("perplexity"), R("gemini")]);
    expect(frozenEntry(rec, "chatgpt")).toMatchObject({ outcome: "answered", outcomeSource: "recorded", provider: "openai", invalidProviderOutput: true });
    expect("validityUnknown" in frozenEntry(rec, "chatgpt")).toBe(false);
    expect(exportIdentity(rec)).toMatchObject({ kind: "IND", verified: true, independentModels: 4, answeredSlots: 4, panelSlots: 5, placeholderSlots: ["chatgpt"], qualified: true });
    expect(exportRunIndependence(rec)).toEqual({ kind: "placeholder", scope: "run", voices: ["Claude", "Grok", "Perplexity", "Gemini"], placeholders: ["chatgpt"] });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes("Top consensus (4 independent models; stored placeholder text set aside)")]).toEqual([k, true]);
      expect([k, text.includes(placeholderSlotsClause(1))]).toEqual([k, true]);
      expect([k, UNQUALIFIED_TOP.test(text)]).toEqual([k, false]);
      expect([k, /agreed by \d+ model/.test(text)]).toEqual([k, false]);
      expect([k, text.includes("5 independent model")]).toEqual([k, false]);
      expect([k, UNVERIFIED_WORDS.test(text)]).toEqual([k, false]);
    }
    // The identity-only read-back (labels, JSON) never carries the D-5 fact: the JSON export's provenance.run is unchanged.
    expect("invalidProviderOutput" in readFrozenRunProvenance(rec.reportSnapshot.runProvenance)!.models[0]).toBe(false);
  });

  it("case 4: a near-miss placeholder (validity unknown) makes the export unverified; a sentinel row outside the roster is never frozen or counted", async () => {
    const near = exportOf(CONS(), [R("chatgpt", { rawText: `${STORED_PLACEHOLDER_LITERALS.chatgpt} — edited` }), R("claude"), R("grok"), R("perplexity"), R("gemini")]);
    expect(frozenEntry(near, "chatgpt")).toMatchObject({ validityUnknown: true });
    expect(exportIdentity(near)).toMatchObject({ kind: "UV", verified: false, independentModels: null });
    expect(exportRunIndependence(near)).toEqual({ kind: "unverified", scope: "run" });
    // Rows for slots the run never selected ("unknown", "missing", "unresolved") are not roster slots: no frozen entry, no vote.
    const rows = FIVE.map((m) => R(m));
    const built = buildExportSnapshot({
      question: QUESTION,
      selectedModels: FIVE as never[],
      modelResultsOkByModelId: Object.fromEntries(FIVE.map((m) => [m, true])),
      runDocument: { perModel: [...rows.map(perModelRow), ...["unknown", "missing", "unresolved"].map((id) => perModelRow(R(id, { provider: "openai", requestedModel: "x" })))] },
      legacy: { output: { version: 1, generatedAt: "2026-10-01T00:00:00.000Z", ...CONS() }, governanceStatus: "approved", governanceMeta: { policyVersion: 3 } },
    });
    expect(built.reportSnapshot.runProvenance!.models.map((m) => m.modelId)).toEqual(FIVE);
  });

  it("case 5: a legacy (version-1) frozen export — no outcome recorded — reads 'model independence unverified' in the PDF and DOCX; nothing is reconstructed", async () => {
    const v2 = exportOf(CONS(), FIVE.map((m) => R(m)));
    const rec = asVersionOne(v2);
    expect(JSON.stringify(rec.reportSnapshot.runProvenance)).not.toMatch(/outcome|provenanceVersion/);
    for (const m of FIVE) expect(frozenEntry(rec, m)).toMatchObject({ outcome: "unknown", outcomeSource: "absent", provider: PROVIDER[m], substituted: false });
    expect(runModelProvenanceFromExport(readFrozenRunExecutionProvenance(rec.reportSnapshot.runProvenance), "chatgpt")).not.toHaveProperty("status");
    expect(exportIdentity(rec)).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0 });
    expect(exportRunIndependence(rec)).toEqual({ kind: "unverified", scope: "run" });
    expect(exportPositionSafeReport(rec).independence).toEqual({ sectionHeading: EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED, topHeading: ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, text.includes(EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED)]).toEqual([k, true]);
      expect([k, UNQUALIFIED_TOP.test(text)]).toEqual([k, false]);
      expect([k, /agreed by \d+ model/.test(text)]).toEqual([k, false]);
      expect([k, /\d+ independent model/.test(text)]).toEqual([k, false]);
    }
    // The same version-1 value still labels every model exactly as before (identity facts are untouched).
    expect(pdfText(rec)).toContain("ChatGPT · requested: chatgpt-model-1");
  });

  it.each([
    ["one version-1 entry (no outcome) beside four recorded", (p: any) => { delete p.models[2].outcome; delete p.models[2].outcomeSource; }],
    ["one entry whose outcome is 'answered' but whose source is 'absent'", (p: any) => { p.models[2].outcomeSource = "absent"; }],
    ["one entry whose outcome is the fail-closed word 'unknown' with source 'recorded'", (p: any) => { p.models[2].outcome = "unknown"; }],
    ["one entry whose outcome is a crafted literal ('Answered')", (p: any) => { p.models[2].outcome = "Answered"; }],
    ["one entry whose outcome is non-string", (p: any) => { p.models[2].outcome = 1; }],
    ["one entry whose outcome is a Firestore null", (p: any) => { p.models[2].outcome = null; p.models[2].outcomeSource = null; }],
  ])("case 6: mixed legacy-unknown + recorded (%s) → unverified; never upgraded by the recorded slots or the provider", async (_label, edit) => {
    const rec = exportOf(CONS(), FIVE.map((m) => R(m)));
    edit(rec.reportSnapshot.runProvenance);
    expect(frozenEntry(rec, "grok")).toMatchObject({ outcome: "unknown", outcomeSource: "absent", provider: "xai" });
    expect(exportIdentity(rec)).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 4 });
    expect(exportRunIndependence(rec)).toEqual({ kind: "unverified", scope: "run" });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, UNQUALIFIED_TOP.test(text)]).toEqual([k, false]);
      expect([k, /\d+ independent model/.test(text)]).toEqual([k, false]);
    }
  });

  it("case 7 (finding K=0 → IND): a run whose every slot failed is never a verified independent run — the gate fails and no agreement is claimed", async () => {
    const rows = [timedOut("chatgpt"), errored("claude", "unknown"), R("grok", { status: "refused", rawText: null, provider: null }), R("perplexity", { status: "rate_limited", rawText: null, provider: null }), R("gemini", { status: "failed", rawText: null, provider: null })];
    // (a) the real all-failed record (no synthesis was produced): no consensus or agreement claim anywhere in the export.
    const real = exportOf({ ...clone(records["generic-all-failed"]), alignedClaims: [] }, rows);
    for (const m of FIVE) expect(frozenEntry(real, m)).toMatchObject({ outcomeSource: "recorded" });
    expect(frozenEntry(real, "chatgpt").outcome).toBe("timeout");
    const facts = FIVE.map((id) => identityRowFromFacts(runModelProvenanceFromExport(readFrozenRunExecutionProvenance(real.reportSnapshot.runProvenance), id)));
    expect(facts.every((f) => typeof f.status === "string")).toBe(true);
    expect(executionIdentityVerified(facts)).toBe(false);
    expect(exportIdentity(real)).toEqual({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0, panelSlots: 5, placeholderSlots: [], slotKeys: {}, qualified: true });
    for (const [k, text] of await bothTexts(real)) {
      expect([k, /Top consensus|agreed by|Models agree|\d+ independent model|consensus of \d+/i.test(text)]).toEqual([k, false]);
      expect([k, (text.match(/\(failed\)/g) ?? []).length]).toEqual([k, 5]);
    }
    // (b) a stored report that claims a consensus over slots that are all recorded as failed: the joined claim's supporters
    // all failed → never rendered as an independent consensus (supporters scope). The run scope itself renders as before
    // (owner option (b)); the gate still reads the run as unverified.
    const crafted = exportOf(CONS(), rows);
    expect(exportIdentity(crafted)).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0 });
    // Order 30 A1 (owner option (i)): a stored synthesis over a run with no successful response — the summary is the gate.
    expect(exportRunIndependence(crafted)).toBe(NO_RESPONSES_RUN);
    expect(exportPositionSafeReport(crafted).independence?.topHeading).toBe(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING);
    for (const [k, text] of await bothTexts(crafted)) {
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, UNQUALIFIED_TOP.test(text)]).toEqual([k, false]);
      expect([k, /agreed by \d+ model|\d+ independent model/.test(text)]).toEqual([k, false]);
    }
  });

  it.each([["OK "], ["Ok"], ["answered"], [""], ["TIMEOUT"], ["Substituted"]])("case 8: a crafted persisted status %p freezes as unknown and makes the export unverified", async (status) => {
    const rec = exportOf(CONS(), [R("chatgpt", { status }), R("claude"), R("grok"), R("perplexity"), R("gemini")]);
    expect(frozenEntry(rec, "chatgpt")).toMatchObject({ outcome: "unknown", outcomeSource: "absent", provider: "openai" });
    expect("substituted" in frozenEntry(rec, "chatgpt")).toBe(false);
    expect(exportIdentity(rec)).toMatchObject({ kind: "UV", verified: false, independentModels: null });
    expect(exportRunIndependence(rec)).toEqual({ kind: "unverified", scope: "run" });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, /\d+ independent model/.test(text)]).toEqual([k, false]);
    }
  });

  it("the run-scope placeholder heading (m-2) is the run-scope wording in the exports; the supporters wording is kept for a joined row", async () => {
    // Without joinable rows (alignedClaims empty) the export judges the run: run-scope heading.
    const runScope = exportOf({ ...CONS(), alignedClaims: [] }, [placeholder("chatgpt"), R("claude"), R("grok"), R("perplexity"), R("gemini")]);
    expect(exportPositionSafeReport(runScope).independence?.topHeading).toBe(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING);
    for (const [k, text] of await bothTexts(runScope)) {
      expect([k, text.includes(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING)]).toEqual([k, true]);
      expect([k, text.includes("among the supporting slots")]).toEqual([k, false]);
      // The exports print the heading; a run-scope statement never reads "Supporting slots" (the statement wording is pinned in verifiedIdentityIndependence.spec.tsx).
      expect([k, text.includes("Supporting slots answered by")]).toEqual([k, false]);
    }
    expect(ADAPTIVE_PLACEHOLDER_TOP_HEADING).toContain("among the supporting slots");
    expect(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING).not.toContain("supporting");
  });

  it("stored values are never rewritten by the export path", () => {
    const rec = CONS();
    const before = JSON.stringify(rec);
    const rows = [timedOut("chatgpt"), R("claude"), R("grok"), R("perplexity"), R("gemini")];
    const out = exportOf(rec, rows);
    pdfText(out);
    expect(JSON.stringify(rec)).toBe(before);
    expect(JSON.stringify(rows)).toContain('"status":"timeout"');
    expect(out.reportSnapshot.legacy!.synthesisReport!.verdictCard.consensusModelCount).toBe(5);
  });
});

// ─── Order 30 (final C-a round): the standing attribution default in the exports ──────────────────────────────────

/** Every agreement / consensus / support-count claim an export could make. */
const AGREEMENT_CLAIM = /Strong consensus|Moderate consensus|Top consensus(?! \()|agreed by \d+|Models agree|\d+ independent model|consensus of \d+|all \d+ dispatched models support it|\d+ of \d+ (?:dispatched )?models/;
/** The summary note the composers print when the summary level is the verification gate (MARKED_GATE_LEVEL_NOTE). */
const GATE_NOTE = "The verification gate reflects computed checks on the scored rows";
const claimsIn = (text: string) => (text.match(new RegExp(AGREEMENT_CLAIM.source, "g")) ?? []);

describe("Order 30 A1 / A2 — exports: no successful response, or failed supporters → no agreement claim, the shared wording", () => {
  const CONS = () => clone(records["generic-consensus"]);
  const SUBF = () => clone(records["generic-substituted-and-failed"]);
  const UNJOINED = () => ({ ...CONS(), alignedClaims: [] });
  const fiveTimeouts = () => FIVE.map((m) => timedOut(m));
  const fiveFailures = () => [errored("chatgpt"), R("claude", { status: "failed", rawText: null, provider: null }), errored("grok", "unknown"), R("perplexity", { status: "failed", rawText: null, provider: null }), errored("gemini")];
  const mixedZero = () => [timedOut("chatgpt"), errored("claude", "unknown"), R("grok", { status: "refused", rawText: null, provider: null }), R("perplexity", { status: "rate_limited", rawText: null, provider: null }), R("gemini", { status: "failed", rawText: null, provider: null })];

  async function expectNoResponses(rec: AdaptiveResearchExportV1) {
    expect(exportIdentity(rec)).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0 });
    expect(exportRunIndependence(rec)).toBe(NO_RESPONSES_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, true]);
      expect([k, (text.match(/\(failed\)/g) ?? []).length]).toEqual([k, 5]);
      // the summary level is the verification gate, never a consensus tier
      expect([k, text.includes(GATE_NOTE)]).toEqual([k, true]);
      expect([k, /Consensus\s*(?:\|\s*)?Strong/.test(text)]).toEqual([k, false]);
    }
  }

  it.each([
    ["five timeouts + stored strong consensus (joined rows)", () => exportOf(CONS(), fiveTimeouts())],
    ["five timeouts + stored strong consensus, no joinable rows (review D-P3)", () => exportOf(UNJOINED(), fiveTimeouts())],
    ["five failures + stored consensus (joined)", () => exportOf(CONS(), fiveFailures())],
    ["five failures + stored consensus (unjoined)", () => exportOf(UNJOINED(), fiveFailures())],
    ["mixed failure / timeout / refused / rate_limited, zero answered (joined)", () => exportOf(CONS(), mixedZero())],
    ["mixed failure / timeout / refused / rate_limited, zero answered (unjoined)", () => exportOf(UNJOINED(), mixedZero())],
  ])("A1: %s → NO_SUCCESSFUL_MODEL_RESPONSES in the PDF and DOCX, no agreement claim", async (_label, make) => {
    await expectNoResponses(make());
  });

  it("A1: a marked (Contract P) report over five timeouts states the constant and no agreement claim either", async () => {
    const marked = CONS();
    marked.synthesisReport.presentation.disagreementPositionVersion = 1;
    const rec = exportOf(marked, fiveTimeouts());
    expect(exportRunIndependence(rec)).toBe(NO_RESPONSES_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, true]);
      expect([k, /Supported by: ChatGPT slot/.test(text)]).toEqual([k, false]);
    }
  });

  it.each([["unmarked", false], ["marked (Contract P)", true]])("A1: an %s export with a stored synthesis and an empty roster (no model dispatched) has no successful response either", async (_label, isMarked) => {
    const src = CONS();
    if (isMarked) src.synthesisReport.presentation.disagreementPositionVersion = 1;
    const rec = exportOf(src, []);
    expect(rec.reportSnapshot.models).toEqual([]);
    expect(exportRunIndependence(rec)).toBe(NO_RESPONSES_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, true]);
    }
  });

  it("n-3: the layout fixture freezes a failed slot as a recorded failure (no provider), an answered slot as answered", () => {
    const rec = withIndependentFrozenProvenance({ reportSnapshot: { models: [{ modelId: "chatgpt", ok: true }, { modelId: "grok", ok: false }] } as any });
    expect(rec.reportSnapshot.runProvenance).toEqual({
      provenanceVersion: 2,
      models: [
        { modelId: "chatgpt", substituted: false, provider: "openai", outcome: "answered", outcomeSource: "recorded" },
        { modelId: "grok", substituted: false, outcome: "failed", outcomeSource: "recorded" },
      ],
    });
  });

  it("A1 controls: the real all-failed record (no synthesis) is unchanged — no constant, no gate relabel, run scope as before", async () => {
    const real = exportOf({ ...clone(records["generic-all-failed"]), alignedClaims: [] }, fiveTimeouts());
    expect(exportRunIndependence(real)).toBeNull();
    expect(exportPositionSafeReport(real).independence).toBeNull();
    for (const [k, text] of await bothTexts(real)) {
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
      expect([k, text.includes("Not scored")]).toEqual([k, true]);
      expect([k, text.includes(GATE_NOTE)]).toEqual([k, false]);
    }
  });

  it("A2: one genuine answer + 4 failed slots that the stored claim names as supporters → no support count; the reason is stated", async () => {
    const rec = exportOf(CONS(), [R("chatgpt"), timedOut("claude"), timedOut("grok"), errored("perplexity"), timedOut("gemini")]);
    expect(exportIdentity(rec)).toMatchObject({ kind: "IND", verified: true, independentModels: 1, answeredSlots: 1 });
    // Order 30 round 2 (m-B): one answering model under a stored agreement is TOO_FEW_ANSWERS_RUN (was FAILED_SUPPORTERS_RUN,
    // the row-scan result; both gate the summary).
    expect(exportRunIndependence(rec)).toBe(TOO_FEW_ANSWERS_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      // Order 31 R-1: over fewer than two answering models a joined consensus row states the too-few statement (it
      // replaces the failed-supporters clause, which still applies when two or more models answered — next test).
      expect([k, text.includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, true]);
      expect([k, text.includes(FAILED_SUPPORTERS_CLAUSE)]).toEqual([k, false]);
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
    }
  });

  it("A2: 4 answered + 1 failed slot named as a supporter (inconsistent stored record) → no '5' count; vs case 2's consistent record, unchanged", async () => {
    const rec = exportOf(CONS(), [R("chatgpt"), R("claude"), R("grok"), R("perplexity"), timedOut("gemini")]);
    expect(exportRunIndependence(rec)).toBe(FAILED_SUPPORTERS_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      expect([k, text.includes(FAILED_SUPPORTERS_CLAUSE)]).toEqual([k, true]);
    }
    // the real record (the failed slot is no supporter) keeps its stored statements and no qualification
    const consistent = exportOf(SUBF(), [R("chatgpt"), substitutedByDeepSeek("claude"), timedOut("grok"), R("perplexity"), R("gemini")]);
    expect(exportRunIndependence(consistent)).toBeNull();
    for (const [, text] of await bothTexts(consistent)) expect(text.includes(FAILED_SUPPORTERS_CLAUSE)).toBe(false);
  });

  it("genuine multi-model independent agreement: 5 distinct verified identities → still 5 independent; stored statements unchanged", async () => {
    const rec = exportOf(CONS(), FIVE.map((m) => R(m)));
    expect(exportIdentity(rec)).toMatchObject({ kind: "IND", verified: true, independentModels: 5, answeredSlots: 5, qualified: false });
    expect(exportRunIndependence(rec)).toBeNull();
    expect(exportPositionSafeReport(rec).report).toBe(rec.reportSnapshot.legacy!.synthesisReport);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes("consensus: all 5 dispatched models support it")]).toEqual([k, true]);
      expect([k, text.includes("Strong consensus")]).toEqual([k, true]);
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
      expect([k, UNVERIFIED_WORDS.test(text)]).toEqual([k, false]);
    }
  });

  it("unknown historical execution status (version-1 frozen) over five timeouts → unverified, never the 'no successful responses' fact, no agreement claim", async () => {
    const rec = asVersionOne(exportOf(CONS(), fiveTimeouts()));
    expect(exportRunIndependence(rec)).toEqual({ kind: "unverified", scope: "run" });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, /Strong consensus|\d+ independent model|all \d+ dispatched models support it/.test(text)]).toEqual([k, false]);
    }
  });

  it("substituted models: one executing model in 2 slots is counted once; with failed slots among the stored supporters, no count at all", async () => {
    const counted = exportOf(CONS(), [substitutedByDeepSeek("chatgpt"), substitutedByDeepSeek("claude"), R("grok"), R("perplexity"), R("gemini")]);
    expect(exportIdentity(counted)).toMatchObject({ kind: "PC", independentModels: 4, answeredSlots: 5 });
    for (const [k, text] of await bothTexts(counted)) {
      expect([k, text.includes("4 independent models")]).toEqual([k, true]);
      expect([k, text.includes("5 independent model")]).toEqual([k, false]);
    }
    const withFailed = exportOf(CONS(), [substitutedByDeepSeek("chatgpt"), substitutedByDeepSeek("claude"), timedOut("grok"), timedOut("perplexity"), timedOut("gemini")]);
    expect(exportIdentity(withFailed)).toMatchObject({ kind: "FC", independentModels: 1, answeredSlots: 2 });
    for (const [k, text] of await bothTexts(withFailed)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      expect([k, /\b2 independent model/.test(text)]).toEqual([k, false]);
    }
  });

  it.each([
    ["wrong version (1) on recorded outcomes", (p: any) => (p.provenanceVersion = 1)],
    ["wrong version ('2' string)", (p: any) => (p.provenanceVersion = "2")],
    ["version removed", (p: any) => delete p.provenanceVersion],
    ["outcome is a prototype key", (p: any) => p.models.forEach((m: any) => (m.outcome = "toString"))],
    ["outcome '__proto__'", (p: any) => p.models.forEach((m: any) => (m.outcome = "__proto__"))],
    ["outcome 'constructor'", (p: any) => p.models.forEach((m: any) => (m.outcome = "constructor"))],
    ["entries are arrays", (p: any) => (p.models = p.models.map((m: any) => [m]))],
    ["models is an object", (p: any) => (p.models = { ...p.models })],
  ])("malformed / unsupported provenance (%s) over five timeouts → unverified, never the recorded-failure fact, no agreement claim", async (_label, edit) => {
    const rec = exportOf(CONS(), fiveTimeouts());
    edit(rec.reportSnapshot.runProvenance);
    expect(exportRunIndependence(rec)).toMatchObject({ kind: "unverified", scope: "run" });
    expect(exportRunIndependence(rec)).not.toBe(NO_RESPONSES_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
      expect([k, /Strong consensus|\d+ independent model|all \d+ dispatched models support it/.test(text)]).toEqual([k, false]);
    }
  });

  it.each([["a string", "x"], ["a number", 7], ["an array", [{ modelId: "chatgpt", outcome: "timeout", outcomeSource: "recorded" }]]])("non-object provenance (%s) → read as a pre-6.2b export: unverified, no agreement claim", async (_label, raw) => {
    const rec = exportOf(CONS(), fiveTimeouts());
    (rec.reportSnapshot as any).runProvenance = raw;
    expect(exportRunIndependence(rec)).toEqual({ kind: "unverified", scope: "run" });
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes(NO_SUCCESSFUL_MODEL_RESPONSES)]).toEqual([k, false]);
      expect([k, /Strong consensus|\d+ independent model|all \d+ dispatched models support it/.test(text)]).toEqual([k, false]);
    }
  });

  it("inconsistent stored record: a claim naming slots that do not exist in the run → unverified, no count", async () => {
    const rec = CONS();
    for (const row of rec.alignedClaims) row.cells = [...row.cells, { ...row.cells[0], modelId: "ghost" }, { ...row.cells[0], modelId: "phantom" }];
    const out = exportOf(rec, FIVE.map((m) => R(m)));
    for (const [k, text] of await bothTexts(out)) {
      expect([k, text.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, /\d+ independent model|Top consensus(?! \()/.test(text)]).toEqual([k, false]);
    }
  });
});

// ─── Order 30 round 2 (review of 22a7520: m-B, m-C, m-D) ──────────────────────────────────────────────────────────

describe("Order 30 round 2 — exports: m-B (unjoined stored claim over one answer) and m-C (Milestone-2 status summary)", () => {
  const CONS = () => clone(records["generic-consensus"]);
  const oneAnswer = () => [R("chatgpt"), timedOut("claude"), timedOut("grok"), errored("perplexity"), timedOut("gemini")];

  it("m-B: one genuine answer + 4 timeouts + a stored consensus with NO joined rows → no 'all 5 … support it', no 'Strong consensus'", async () => {
    const rec = exportOf({ ...CONS(), alignedClaims: [] }, oneAnswer());
    expect(exportIdentity(rec)).toMatchObject({ kind: "IND", verified: true, independentModels: 1 });
    expect(exportRunIndependence(rec)).toBe(TOO_FEW_ANSWERS_RUN);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, claimsIn(text)]).toEqual([k, []]);
      expect([k, text.includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, true]);
      expect([k, text.includes(GATE_NOTE)]).toEqual([k, true]);
      expect([k, /Supported by: ChatGPT, Claude, Grok, Perplexity, Gemini(?! \()/.test(text)]).toEqual([k, false]);
    }
  });

  it("m-B controls: two answering models (unjoined) keep the stored statements; one answer with a no-consensus report states nothing new", async () => {
    const two = exportOf({ ...CONS(), alignedClaims: [] }, [R("chatgpt"), R("claude"), timedOut("grok"), timedOut("perplexity"), timedOut("gemini")]);
    expect(exportRunIndependence(two)).toBeNull();
    for (const [k, text] of await bothTexts(two)) expect([k, text.includes(TOO_FEW_ANSWERS_STATEMENT)]).toEqual([k, false]);
    const single = exportOf(clone(records["factual-single"]), [R("chatgpt"), timedOut("claude")]);
    expect(exportRunIndependence(single)).toBeNull();
  });

  const FIVE_IDS = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
  function m2(runProvenance: unknown, schemaId = "comparison_matrix"): AdaptiveResearchExportV1 {
    return {
      version: 1, exportId: "e", runId: "r", schemaId, schemaFamily: "milestone2", schemaVersion: 1, reportVersion: 1, createdAt: "2026-10-08T00:00:00.000Z", createdBy: "u", format: "pdf", artifactStatus: "ready", classification: "internal",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
      reportSnapshot: { question: "Which?", models: FIVE_IDS.map((m) => ({ modelId: m })), reportTypeLabel: "Comparison Report", consensusLevel: "strong", sourceGroundingLevel: "strong", reportGeneratedAt: "2026-10-07T00:00:00.000Z", ...(runProvenance === undefined ? {} : { runProvenance }), milestone2: { schemaId, result: { subjects: [], attributes: [], cells: [] }, meta: {} } },
      exportMetadata: { exportId: "e", runId: "r", schemaVersion: 1, exportedSections: ["reportSnapshot.milestone2"], createdAt: "2026-10-08T00:00:00.000Z", requestingUser: "u", finalReportVersion: 1 },
    } as any;
  }
  const v2 = (entry: (m: string) => Record<string, unknown>) => ({ provenanceVersion: 2, policyVersion: 3, models: FIVE_IDS.map((m) => ({ modelId: m, requestedModel: `${m}-1`, substituted: false, ...entry(m) })) });

  it.each([
    ["every slot a recorded timeout", v2(() => ({ outcome: "timeout", outcomeSource: "recorded" })), NO_RESPONSES_RUN],
    ["every slot 'model not recorded' (pre-6.2b, no frozen provenance)", undefined, { kind: "unverified", scope: "run" }],
  ])("m-C: a Milestone-2 export whose %s never shows 'Strong consensus' in the PDF or DOCX status summary", async (_label, prov, expected) => {
    const rec = m2(prov);
    expect(exportRunIndependence(rec)).toEqual(expected);
    for (const [k, text] of await bothTexts(rec)) {
      expect([k, text.includes("Strong consensus")]).toEqual([k, false]);
      // Order 31 PROPOSAL (R-2): a Milestone-2 report has no verification gate — labelled by panel slot, never the gate.
      expect([k, text.includes(GATE_NOTE)]).toEqual([k, false]);
      expect([k, /Verification gate/i.test(text)]).toEqual([k, false]);
      expect([k, text.includes("Agreement by panel slot reflects stored agreement between panel slots")]).toEqual([k, true]);
    }
  });

  it("m-C + m-B: a Milestone-2 consensus tier over one verified answer and four recorded timeouts is TOO_FEW_ANSWERS_RUN (no 'Strong consensus')", async () => {
    const PROV: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
    const rec = m2(v2((m) => (m === "chatgpt" ? { provider: PROV[m], outcome: "answered", outcomeSource: "recorded" } : { outcome: "timeout", outcomeSource: "recorded" })));
    expect(exportRunIndependence(rec)).toBe(TOO_FEW_ANSWERS_RUN);
    for (const [k, text] of await bothTexts(rec)) expect([k, text.includes("Strong consensus")]).toEqual([k, false]);
  });

  it("m-C controls: 5 verified answered Milestone-2 slots keep 'Strong consensus'; a Decision Support export keeps its own summary (null)", async () => {
    const PROV: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
    const verified = m2(v2((m) => ({ provider: PROV[m], outcome: "answered", outcomeSource: "recorded" })));
    expect(exportRunIndependence(verified)).toBeNull();
    for (const [k, text] of await bothTexts(verified)) expect([k, text.includes("Strong consensus")]).toEqual([k, true]);
    expect(exportRunIndependence(m2(undefined, "decision_support"))).toBeNull();
    // a legacy record without a stored synthesis (the real all-failed record) is still null
    expect(exportRunIndependence(exportOf({ ...clone(records["generic-all-failed"]), alignedClaims: [] }, FIVE_IDS.map((m) => timedOut(m))))).toBeNull();
  });
});

describe("Order 30 round 2 — m-C tier boundary", () => {
  const FIVE_IDS = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
  const m2 = (consensusLevel: string, schemaFamily = "milestone2") =>
    ({ schemaId: "comparison_matrix", schemaFamily, format: "pdf", reportSnapshot: { models: FIVE_IDS.map((m) => ({ modelId: m })), consensusLevel } }) as any;
  it.each([["strong"], ["moderate"], ["weak"]])("a Milestone-2 '%s' tier over unrecorded slots is qualified", (lvl) => {
    expect(exportRunIndependence(m2(lvl))).toEqual({ kind: "unverified", scope: "run" });
  });
  it.each([["unscored"], ["split"], [undefined]])("a Milestone-2 level %p states no agreement → null (renders as before)", (lvl) => {
    expect(exportRunIndependence(m2(lvl as never))).toBeNull();
  });
  it("the Decision Support id is the S-E.2 module's", () => {
    expect(EPV_DS_ID).toBe(DS_ID);
  });
  it("a record that is neither legacy-with-synthesis nor Milestone-2 → null", () => {
    expect(exportRunIndependence(m2("strong", "legacy"))).toBeNull();
  });
});
