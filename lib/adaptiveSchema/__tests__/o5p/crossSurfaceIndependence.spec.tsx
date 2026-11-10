/**
 * c16 (review of 48f3739): one cross-surface oracle for every agreement statement a historical adaptive report makes.
 * Core rule (owner): every claim about model agreement uses the actual EXECUTING-model identity, never the dispatched /
 * requested slot count. One executing model answering several slots is never "strong consensus", "5/5 models
 * converge", "5 of 5 agree" or "raised by 5 models"; partial collapse distinguishes slots from independent executing
 * models; unknown provenance (incl. pre-6.2b exports with no frozen provenance) states model independence as
 * unverified; genuinely independent runs render exactly as before (historicalParity.spec.tsx, the 2c17feee oracle).
 *
 * Records: every 2c17feee historical record × 3 stored shapes (r5 / legacy / marked) × {with rows, without rows},
 * through every consumer o5pRender renders (report view, panel response incl. summary bar / generic sections / list
 * view, strip, panel evidence (map + matrix), governance, Markdown, LinkedIn, X, memo, PDF tree, DOCX XML) plus the
 * PDF / DOCX of the same record exported WITHOUT frozen provenance (pre-6.2b). The JSON export keeps the stored report
 * verbatim (data, not presentation) and is not a presentation surface here.
 *
 * Inventory: scratchpad c16-inventory.md (paths × oracle). Each describe names the paths it covers.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCENARIOS } from "./o5pScenarios";
import { QUESTION, docxDocumentXml, provenanceOf, renderRecord, serializeElementTree } from "./o5pRender";
import { htmlText } from "./htmlText";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import GenericSectionsView from "@/components/adaptive/GenericSectionsView";
import TopSummaryBar from "@/components/adaptive/TopSummaryBar";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { buildAdaptiveSynthesisMarkdown } from "@/lib/adaptiveSchema/shareBuilders";
import { gateBannerText } from "@/lib/adaptiveSchema/gatePresentation";
import { rowView } from "@/lib/adaptiveSchema/positionPresentation";
import {
  QUALIFIED_TOP_NEXT_STEP,
  STORED_TOP_CONSENSUS_NEXT_STEP,
  presentIndependenceQualifiedReport,
  qualifiedPanelVerdict,
  rowIndependence,
  type QualifiedIndependence,
} from "@/lib/adaptiveSchema/verdictIndependence";
import type { ModelResult } from "@/lib/types";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const scenarioRows = (name: string) => SCENARIOS.find((s) => s.name === name)!.results();
const sub = (r: ModelResult) => ({ ...r, status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: `${r.provider}:${r.modelId}-model-1` }) as ModelResult;
const subOnly = (ids: string[]) => (rows: ModelResult[]) => rows.map((r) => (ids.includes(r.modelId) ? sub(r) : r));
const VARIANTS = {
  independent: (rows: ModelResult[]) => rows,
  allDeepSeek: subOnly(["chatgpt", "claude", "grok", "perplexity", "gemini"]),
  partial: subOnly(["chatgpt", "claude"]),
  unverified: (rows: ModelResult[]) => rows.map((r) => (r.modelId === "grok" ? ({ ...r, status: undefined } as unknown as ModelResult) : r)),
  splitNonSupp: subOnly(["claude", "perplexity"]),
};
type Variant = keyof typeof VARIANTS;
type Shape = "r5" | "legacy" | "marked";
const SHAPES: Shape[] = ["r5", "legacy", "marked"];
const NAMES = Object.keys(records).filter((n) => records[n].synthesisReport);

function shaped(name: string, shape: Shape, withRows: boolean) {
  const rec = clone(records[name]);
  if (shape === "legacy") delete rec.synthesisReport.presentation;
  if (shape === "marked" && rec.synthesisReport.presentation) rec.synthesisReport.presentation.disagreementPositionVersion = 1;
  if (!withRows) delete rec.alignedClaims;
  return rec;
}

/** The PDF / DOCX of a pre-6.2b export: the same record, its snapshot without frozen runProvenance. */
async function preProvenanceExports(rec: any, rows: ModelResult[]) {
  const built = buildExportSnapshot({
    question: QUESTION,
    selectedModels: rows.map((r) => r.modelId),
    modelResultsOkByModelId: Object.fromEntries(rows.map((r) => [r.modelId, r.status === "ok" || r.status === "substituted"])),
    runDocument: { perModel: rows.map((r) => ({ modelId: r.modelId, status: r.status, provider: r.provider, requestedModel: r.requestedModel })) },
    legacy: { output: { version: 1, generatedAt: "2026-10-01T00:00:00.000Z", ...rec }, governanceStatus: "approved", governanceMeta: { policyVersion: 3 } },
  } as any);
  const reportSnapshot: any = { ...built.reportSnapshot };
  delete reportSnapshot.runProvenance;
  const record = (format: string) => ({ version: 1, exportId: "exp-c16", runId: "run-c16", schemaId: rec.schemaId, schemaFamily: "legacy", schemaVersion: 1, reportVersion: 1, createdAt: "2026-10-01T00:00:00.000Z", createdBy: "uid-c16", format, artifactStatus: "ready", classification: built.classification, governanceStatusAtExport: built.governanceStatusAtExport, reportSnapshot, exportMetadata: { exportId: "exp-c16", runId: "run-c16", schemaVersion: 1, exportedSections: ["reportSnapshot"], createdAt: "2026-10-01T00:00:00.000Z", requestingUser: "uid-c16", finalReportVersion: 1 } }) as any;
  return { "export.pdfTree.preProvenance": JSON.stringify(serializeElementTree(AdaptiveResearchDocument({ record: record("pdf") }))), "export.docxXml.preProvenance": await docxDocumentXml(record("docx")) };
}

function textOf(key: string, v: string): string {
  if (key.startsWith("export.pdfTree")) {
    const out: string[] = [];
    JSON.parse(v, (k, val) => {
      if (typeof val === "string" && k !== "t") out.push(val);
      return val;
    });
    return out.join(" ");
  }
  if (key.startsWith("ui.") || key.startsWith("export.docxXml")) return htmlText(v);
  return v;
}

/** Presentation surfaces (the JSON export, memo input and the no-provenance render are not: see the header). */
const SURFACES = ["ui.synthesisView", "ui.panelResponse", "ui.listView", "ui.primaryStrip", "ui.panelEvidence", "ui.claimMatrix", "ui.governance", "text.markdown", "text.linkedin", "text.x", "text.memo", "export.pdfTree", "export.docxXml"];

const cache = new Map<string, Promise<Record<string, string>>>();
function render(name: string, shape: Shape, variant: Variant, withRows: boolean): Promise<Record<string, string>> {
  const k = `${name}|${shape}|${variant}|${withRows}`;
  if (!cache.has(k)) {
    cache.set(
      k,
      (async () => {
        const rows = VARIANTS[variant](scenarioRows(name));
        const rec = shaped(name, shape, withRows);
        const raw: Record<string, string | null> = { ...(await renderRecord(rec, rows)), ...(await preProvenanceExports(rec, rows)) };
        return Object.fromEntries(Object.entries(raw).filter(([key, v]) => v != null && (SURFACES.includes(key) || key.endsWith(".preProvenance"))).map(([key, v]) => [key, textOf(key, v!)]));
      })()
    );
  }
  return cache.get(k)!;
}

/**
 * Agreement vocabulary that must never stand unqualified when every answering slot was one executing model
 * (allDeepSeek), or when no slot's execution is recorded (pre-6.2b exports). Each entry: name, pattern, and the
 * qualification that may immediately follow a match (within its clause).
 */
const STRICT: { name: string; re: RegExp; qualifiedBy?: RegExp }[] = [
  { name: "N/M models converge", re: /\b\d+\/\d+ models converge\b/g },
  { name: "consensus tier", re: /\b(Strong|Moderate|Weak) consensus\b/g },
  { name: "legacy banner", re: /Verified — panel converges|Caution — partial convergence|Could not verify — panel split/g },
  { name: "raised by N models", re: /\braised by \d+ models\b/g },
  { name: "N of M agree", re: /\b\d+ of \d+ agree\b/g },
  { name: "multi-model", re: /multi-model/g },
  { name: "uniform agreement", re: /Unusually uniform agreement/g },
  { name: "top consensus next step", re: /spot-check the top consensus claim/g },
  { name: "consensus pulse", re: /Consensus claims \d/g },
  { name: "agreed by N models", re: /\bagreed by \d+ models?\b/g },
  // "Top consensus — No consensus identified." states that there is none (PDF text interleaves its style strings).
  { name: "Top consensus", re: /\bTop consensus\b(?! \(|( #[0-9A-F]{6}| Helvetica[\w-]*)* No consensus identified)/g },
  { name: "Where models agree", re: /\bWhere models agree\b(?! \(| \/ disagree \()/g },
  { name: "Models agree heading", re: /\bModels agree\b(?! No consensus identified)/g },
  { name: "panel agreement note", re: /Consensus reflects panel agreement/g },
  // A slot count of two or more, or with disputing slots, presented as models: only with its panel-slot qualification
  // in the same clause, or (a legacy answer string) followed by its model-independence note.
  {
    name: "N dispatched models support it",
    re: /\b(all )?([2-9]|\d{2,}) (of \d+ )?dispatched models? supports? it|\b\d+ of \d+ dispatched models? supports? it(,| and) \d+ disputes? it/g,
    qualifiedBy: /^[^—\n]{0,60}\(counted by panel slot|^[\s\S]{0,400}Model independence: The models named and counted here are panel slots/,
  },
  { name: "listed this claim (models)", re: /\b\d+ models that listed this claim\b/g, qualifiedBy: /^[^—\n(]{0,40}\(counted by panel slot|^[\s\S]{0,400}(Panel result|Model independence)/ },
  { name: "slot names as supporters", re: /\b(Supported|Disputed) by:?\**:? (ChatGPT|Claude|Grok|Perplexity|Gemini)(, (ChatGPT|Claude|Grok|Perplexity|Gemini))+(?![,\w])/g, qualifiedBy: /^ \(panel slots\)/ },
];

function unqualified(text: string): string[] {
  const out: string[] = [];
  for (const { name, re, qualifiedBy } of STRICT) {
    for (const m of text.matchAll(re)) {
      const after = text.slice((m.index ?? 0) + m[0].length);
      if (qualifiedBy && qualifiedBy.test(after)) continue;
      out.push(`${name}: …${text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + m[0].length + 40)}…`);
    }
  }
  return out;
}

const ROWS = [true, false];

describe("every slot answered by one executing model (DeepSeek): no surface states slot counts as model agreement", () => {
  for (const name of NAMES) {
    it.each(SHAPES.flatMap((shape) => ROWS.map((withRows) => [shape, withRows] as const)))(`${name} %s shape (rows held: %s)`, async (shape, withRows) => {
      const out = await render(name, shape, "allDeepSeek", withRows);
      for (const key of [...SURFACES, "export.pdfTree.preProvenance", "export.docxXml.preProvenance"]) {
        if (out[key] === undefined) continue;
        expect([key, unqualified(out[key])]).toEqual([key, []]);
      }
    });
  }
});

describe("pre-6.2b exports (no frozen provenance): model independence unverified, nothing manufactured (MINOR-3)", () => {
  for (const name of NAMES) {
    it.each(SHAPES)(`${name} %s shape, independent rows at the time of the run`, async (shape) => {
      const out = await render(name, shape, "independent", true);
      for (const key of ["export.pdfTree.preProvenance", "export.docxXml.preProvenance"]) {
        const text = out[key];
        expect([key, unqualified(text)]).toEqual([key, []]);
        // Nothing is inferred about who executed a slot: no substitution is invented.
        expect([key, text.includes("substituting")]).toEqual([key, false]);
        // The level is the gate's (never a consensus tier).
        expect([key, /verification gate/i.test(text) && text.includes("The verification gate reflects computed checks on the scored rows")]).toEqual([key, true]);
      }
    });
  }

  it("the top claim and its result state unverified independence (generic-consensus, r5 and legacy)", async () => {
    for (const shape of ["r5", "legacy"] as Shape[]) {
      const out = await render("generic-consensus", shape, "independent", true);
      for (const key of ["export.pdfTree.preProvenance", "export.docxXml.preProvenance"]) {
        expect([shape, key, out[key].includes("Top finding (model independence unverified; not confirmed as a consensus)")]).toEqual([shape, key, true]);
        expect([shape, key, out[key].includes("recorded as consensus of 5 panel slots; model independence unverified — which models answered the supporting slots is not recorded")]).toEqual([shape, key, true]);
        expect([shape, key, out[key].includes("Where models agree / disagree (model independence unverified)")]).toEqual([shape, key, true]);
      }
      // The same record exported WITH its frozen provenance (independent): exactly as before — unqualified.
      expect(out["export.pdfTree"]).toContain("Where models agree / disagree #");
      expect(out["export.pdfTree"]).not.toMatch(/model independence unverified/i);
    }
  });
});

describe("MAJOR-1: the copied Markdown's panel verdict", () => {
  it.each(["r5", "legacy"] as Shape[])("%s shape: no 'N/M models converge' beside the executing-model statement", async (shape) => {
    const ad = (await render("generic-consensus", shape, "allDeepSeek", true))["text.markdown"];
    const pa = (await render("generic-consensus", shape, "partial", true))["text.markdown"];
    if (shape === "legacy") {
      expect(ad).toContain(
        "**Panel verdict:** Top finding “Raising the minimum wage reduces employment” — not an independent consensus: the 5 panel slots supporting it were all answered by one model, DeepSeek (substituting ChatGPT, Claude, Grok, Perplexity, Gemini); certainty 100%; gate: pass."
      );
      expect(pa).toContain(
        "**Panel verdict:** Top finding “Raising the minimum wage reduces employment” — recorded as consensus of 5 panel slots; those slots were answered by 4 independent models (DeepSeek (substituting ChatGPT, Claude); Grok; Perplexity; Gemini) — a substitute model that answered several slots counts once; certainty 100%; gate: pass."
      );
    }
    for (const md of [ad, pa]) expect(md).not.toMatch(/\d+\/\d+ models converge/);
    // An independent run: the stored verdict, verbatim.
    const ind = (await render("generic-consensus", shape, "independent", true))["text.markdown"];
    if (shape === "legacy") expect(ind).toContain("**Panel verdict:** 5/5 models converge on “Raising the minimum wage reduces employment”; certainty 100%; gate: pass.");
  });

  it("the r5 fallback (a card without its result line) prints the qualified verdict too", () => {
    const rec = clone(records["generic-consensus"]);
    delete rec.synthesisReport.verdictCard.topConsensusAgreement;
    const prov = provenanceOf(VARIANTS.allDeepSeek(scenarioRows("generic-consensus")));
    const md = buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, { rows: rec.alignedClaims, roster: rec.results.map((r: any) => r.modelId), provenance: prov });
    expect(md).toContain("**Panel verdict:** Top finding “Raising the minimum wage reduces employment” — not an independent consensus");
    expect(md).not.toMatch(/\d+\/\d+ models converge/);
  });

  it("an unjoined top claim: the verdict is restated by panel slot with the run's statement; other formats are followed by it", () => {
    const run: QualifiedIndependence = { kind: "repeated_substitute", scope: "run", voices: ["DeepSeek (substituting ChatGPT, Claude)"], repeated: ["DeepSeek (substituting ChatGPT, Claude)"] };
    expect(qualifiedPanelVerdict("5/5 models converge on “X”; certainty 90%; gate: pass.", "counted by panel slot; …", false, run)).toBe("5/5 panel slots converge on “X” (counted by panel slot; …); certainty 90%; gate: pass.");
    expect(qualifiedPanelVerdict("Something else.", "r", false, run)).toBe(
      "Something else. (counted by panel slot; in this run DeepSeek (substituting ChatGPT, Claude) answered several slots, so this is not a count of independent models)"
    );
    expect(qualifiedPanelVerdict("Something else.", "r", false, null)).toBe("Something else.");
  });
});

describe("MAJOR-2: the consensus tier (summary bar, PDF and DOCX report status summary)", () => {
  it.each(["r5", "legacy"] as Shape[])("%s shape: one executing model and partial collapse show the verification gate, never a consensus tier", async (shape) => {
    for (const variant of ["allDeepSeek", "partial", "unverified"] as Variant[]) {
      const out = await render("generic-consensus", shape, variant, true);
      for (const key of ["ui.panelResponse", "export.pdfTree", "export.docxXml"]) {
        expect([variant, key, /\b(Strong|Moderate|Weak) consensus\b/.test(out[key])]).toEqual([variant, key, false]);
        // The level is labelled as the gate (PDF text interleaves style strings; DOCX upper-cases field labels).
        expect([variant, key, /verification gate/i.test(out[key]) && /\bPass\b/.test(out[key])]).toEqual([variant, key, true]);
      }
      for (const key of ["export.pdfTree", "export.docxXml"]) {
        expect([variant, key, out[key].includes("Consensus reflects panel agreement")]).toEqual([variant, key, false]);
        expect([variant, key, out[key].includes("The verification gate reflects computed checks on the scored rows")]).toEqual([variant, key, true]);
      }
    }
    // Genuinely independent: as before.
    const ind = await render("generic-consensus", shape, "independent", true);
    for (const key of ["ui.panelResponse", "export.pdfTree", "export.docxXml"]) expect([key, ind[key].includes("Strong consensus")]).toEqual([key, true]);
  });

  it("a schema-derived level in a run whose slots are not independent: agreement by panel slot (never 'Strong consensus')", () => {
    const rows = VARIANTS.allDeepSeek(scenarioRows("generic-consensus"));
    const results = rows.map((r) => ({ modelId: r.modelId, ok: true }));
    const props: any = { schemaId: "causal_explanation", results, causalExplanation: { factors: [], totalModels: 5 } };
    const bar = (prov: unknown) => htmlText(renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: prov as any }, createElement(TopSummaryBar as any, props))));
    const collapsed = bar(provenanceOf(rows));
    const independent = bar(provenanceOf(scenarioRows("generic-consensus")));
    expect(collapsed).toContain("Agreement by panel slot");
    expect(collapsed).not.toMatch(/\b(Strong|Moderate|Weak) consensus\b/);
    expect(independent).not.toContain("Agreement by panel slot");
  });
});

describe("MINOR-1: slot counts on unmarked collapsed reports", () => {
  it.each(["r5", "legacy"] as Shape[])("%s shape: the map, generic sections, list pulse and banner say panel slots", async (shape) => {
    const out = await render("generic-mixed", shape, "allDeepSeek", true);
    for (const key of ["ui.synthesisView", "ui.panelEvidence", "ui.governance", "ui.panelResponse"]) {
      expect([key, /\d+ of \d+ agree\b/.test(out[key])]).toEqual([key, false]);
      expect([key, /\d+ of \d+ panel slots agree · .*1 independent model/.test(out[key])]).toEqual([key, true]);
    }
    expect(out["ui.panelResponse"]).toContain("(raised by 5 panel slots, answered by 1 independent model: DeepSeek (substituting ChatGPT, Claude, Grok, Perplexity, Gemini))");
    expect(out["ui.listView"]).toContain("Consensus claims (counted by panel slot)");
    expect(out["ui.synthesisView"]).toContain("Verification gate: Caution");
    expect(out["ui.synthesisView"]).not.toContain("Caution — partial convergence");
  });

  it("the banner and generic sections of an independent run: exactly as before", async () => {
    const out = await render("generic-mixed", "legacy", "independent", true);
    expect(out["ui.synthesisView"]).toContain("Caution — partial convergence");
    expect(out["ui.panelResponse"]).toContain("(raised by 5 models)");
    expect(gateBannerText(undefined, "pass")).toBe("Verified — panel converges");
    expect(gateBannerText(undefined, "pass", { slotsNotIndependent: true })).toBe("Verification gate: Pass");
  });

  it("generic sections: an item raised by independent slots keeps its count; unrecorded execution is stated", () => {
    const base = scenarioRows("generic-mixed");
    const results = base.map((r: any) => ({ ...r, ok: true, data: { summary: "S", uncertainties: ["U."], followUps: [] } }));
    const view = (rows: ModelResult[]) => htmlText(renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: provenanceOf(rows) }, createElement(GenericSectionsView as any, { results, alignedClaims: [] }))));
    expect(view(base)).toContain("U. (raised by 5 models)");
    expect(view(VARIANTS.unverified(base))).toContain("U. (raised by 5 panel slots; model independence unverified)");
    expect(view(VARIANTS.partial(base))).toContain("U. (raised by 5 panel slots, answered by 4 independent models: DeepSeek (substituting ChatGPT, Claude); Grok; Perplexity; Gemini)");
  });
});

describe("MINOR-2: non-consensus rows are stated by executing model on both sides", () => {
  const SPLIT_CLAIM = "“Housing prices will cool”";
  it.each(["r5", "legacy", "marked"] as Shape[])("generic-splits, %s shape, all DeepSeek: the split is not a disagreement between independent models", async (shape) => {
    const out = await render("generic-splits", shape, "allDeepSeek", true);
    for (const key of ["ui.synthesisView", "text.markdown", "export.pdfTree", "export.docxXml"]) {
      expect([key, out[key].includes("answered slots on both sides, so this is not a disagreement between independent models")]).toEqual([key, true]);
      expect([key, /Supported by:?\**:? Claude, Perplexity(?![,\w])(?! \(panel slots\))/.test(out[key])]).toEqual([key, false]);
    }
  });

  it("generic-splits, partial collapse (ChatGPT, Claude → DeepSeek): the majority's disputing side names its executing models", async () => {
    const out = await render("generic-splits", "r5", "partial", true);
    const view = out["ui.synthesisView"];
    // Three independent supporting models: the stored majority is preserved (heading unchanged) …
    expect(view).toContain("agreed by 3 models");
    // … and the result line states both sides by executing model, with DeepSeek on both sides.
    expect(view).toContain(
      "recorded as majority support: 3 panel slots support it, each answered by its own model (DeepSeek (substituting ChatGPT); Grok; Gemini); 2 panel slots dispute it, each answered by its own model (DeepSeek (substituting Claude); Perplexity); DeepSeek (substituting ChatGPT, Claude) answered slots on both sides, so this is not a disagreement between independent models"
    );
    expect(view).not.toContain("majority: 3 of 5 dispatched models support it, 2 dispute it");
    void SPLIT_CLAIM;
  });

  it("splitNonSupp (the disputing Claude and Perplexity are one DeepSeek): '2 dispute it' becomes one executing model", async () => {
    const out = await render("generic-splits", "r5", "splitNonSupp", true);
    expect(out["ui.synthesisView"]).toContain("2 panel slots dispute it, all answered by one model, DeepSeek (substituting Claude, Perplexity)");
    // The independent majority's heading and count stand.
    expect(out["ui.synthesisView"]).toContain("agreed by 3 models");
    expect(out["ui.synthesisView"]).not.toContain("Top finding (repeated substitute model");
  });

  it("marked rowView: a split row's panel-slot text is followed by its executing models (all one / partial / unverified)", () => {
    const rec = records["generic-splits"];
    const row = rec.alignedClaims.find((r: any) => r.claimText === "Interest rates will fall next year");
    const roster = rec.results.map((r: any) => r.modelId);
    const textFor = (variant: Variant) => rowView(row, roster, provenanceOf(VARIANTS[variant](scenarioRows("generic-splits")))).text;
    const independent = textFor("independent");
    expect(textFor("allDeepSeek")).toBe(`${independent} DeepSeek (substituting Claude, Perplexity, ChatGPT, Grok, Gemini) answered slots on both sides, so this is not a disagreement between independent models.`);
    expect(textFor("splitNonSupp")).toBe(`${independent} These panel slots were answered by 4 independent models (DeepSeek (substituting Claude, Perplexity); ChatGPT; Grok; Gemini).`);
    expect(textFor("unverified")).toBe(`${independent} Model independence unverified: which models answered these panel slots is not recorded.`);
    expect(independent).not.toMatch(/independent models|unverified/);
  });

  it("rowIndependence judges both sides; the disputer clause is load-bearing (mutant: disputers dropped)", () => {
    const prov = provenanceOf(VARIANTS.splitNonSupp(scenarioRows("generic-splits")));
    const row = { status: "majority", cells: [{ modelId: "chatgpt", stance: "agrees" }, { modelId: "grok", stance: "agrees" }, { modelId: "claude", stance: "disputes" }, { modelId: "perplexity", stance: "disputes" }] };
    const ri = rowIndependence(row, prov)!;
    expect(ri).not.toBeNull();
    expect(ri.support.kind).toBe("independent");
    expect(ri.dispute).toMatchObject({ kind: "repeated_substitute" });
    expect(ri.disputeVoices).toEqual(["DeepSeek (substituting Claude, Perplexity)"]);
    // Supporters alone are independent: no qualification without the disputing side.
    expect(rowIndependence({ ...row, cells: row.cells.slice(0, 2) }, prov)).toBeNull();
  });
});

describe("R13: the fail gate's answer (split claims) is qualified like every other answer", () => {
  it("legal-regulatory (gate fail), all DeepSeek, r5: the answer's split results name the executing model", async () => {
    const rec = records["legal-regulatory"];
    expect(rec.synthesisReport.gate).toBe("fail");
    const prov = provenanceOf(VARIANTS.allDeepSeek(scenarioRows("legal-regulatory")));
    const view: any = presentIndependenceQualifiedReport(rec.synthesisReport, { rows: rec.alignedClaims, provenance: prov });
    const stored = rec.synthesisReport.presentation.answer.claims;
    expect(stored.length).toBeGreaterThan(0);
    view.presentation.answer.claims.forEach((c: any, i: number) => {
      expect(c.result).not.toBe(stored[i].result);
      expect(c.result).toMatch(/^recorded as split: .*DeepSeek/);
    });
    // Independent: the stored object itself.
    expect(presentIndependenceQualifiedReport(rec.synthesisReport, { rows: rec.alignedClaims, provenance: provenanceOf(scenarioRows("legal-regulatory")) })).toBe(rec.synthesisReport);
  });
});

describe("R9: a legacy agree line in the quoted-prefix form joins its row", () => {
  it("contested-empirical, legacy, all DeepSeek: “claim” — contested note … is followed by its computed result", async () => {
    const md = (await render("contested-empirical", "legacy", "allDeepSeek", true))["text.markdown"];
    const line = md.split("\n").find((l) => l.startsWith("- “Raising the minimum wage reduces employment” — all 4 models that listed this claim mark it contested"))!;
    expect(line).toBeDefined();
    expect(line).toContain("— **Panel result:** recorded as majority support: 2 panel slots support it, all answered by one model, DeepSeek (substituting ChatGPT, Perplexity)");
    expect(line).toContain("DeepSeek (substituting");
  });
});

describe("N1 / N2: the stored next step and the homogeneity badge", () => {
  it.each(["r5", "legacy", "marked"] as Shape[])("%s shape: a qualified top claim is not 'the top consensus claim'", async (shape) => {
    const ad = await render("generic-consensus", shape, "allDeepSeek", true);
    const ind = await render("generic-consensus", shape, "independent", true);
    for (const key of ["ui.synthesisView", "ui.governance"]) {
      expect([key, ad[key].includes(STORED_TOP_CONSENSUS_NEXT_STEP)]).toEqual([key, false]);
      expect([key, ad[key].includes(QUALIFIED_TOP_NEXT_STEP)]).toEqual([key, true]);
      expect([key, ind[key].includes(STORED_TOP_CONSENSUS_NEXT_STEP)]).toEqual([key, true]);
    }
  });

  it("the homogeneity badge on a one-model run (records whose diagnostics flag homogeneity)", async () => {
    const flagged = NAMES.filter((n) => records[n].synthesisReport.diagnostics?.homogeneityFlag);
    expect(flagged.length).toBeGreaterThan(0);
    for (const name of flagged) {
      const ad = await render(name, "r5", "allDeepSeek", true);
      const uv = await render(name, "r5", "unverified", true);
      const ind = await render(name, "r5", "independent", true);
      expect([name, ad["ui.synthesisView"].includes("Unusually uniform responses across panel slots (not independent agreement)")]).toEqual([name, true]);
      expect([name, uv["ui.synthesisView"].includes("Unusually uniform responses (model independence unverified)")]).toEqual([name, true]);
      expect([name, ind["ui.synthesisView"].includes("Unusually uniform agreement")]).toEqual([name, true]);
    }
  });
});

describe("partial collapse and unknown provenance: executing-model labels and independent counts", () => {
  it.each(SHAPES)("generic-consensus %s shape, partial: 4 independent models, never 5", async (shape) => {
    const out = await render("generic-consensus", shape, "partial", true);
    for (const key of ["ui.synthesisView", "ui.governance", "text.markdown", "text.memo", "export.pdfTree", "export.docxXml"]) {
      expect([key, out[key].includes("4 independent models")]).toEqual([key, true]);
      expect([key, out[key].includes("DeepSeek (substituting ChatGPT, Claude)")]).toEqual([key, true]);
      expect([key, /5 independent models|\b5\/5 models converge|5 of 5 agree/.test(out[key])]).toEqual([key, false]);
    }
  });

  it.each(SHAPES)("generic-consensus %s shape, unverified: stated as unverified on every surface; nothing invented", async (shape) => {
    const out = await render("generic-consensus", shape, "unverified", true);
    for (const key of ["ui.synthesisView", "ui.governance", "text.markdown", "text.memo", "export.pdfTree", "export.docxXml"]) {
      expect([key, /model independence unverified/i.test(out[key])]).toEqual([key, true]);
      expect([key, out[key].includes("substituting")]).toEqual([key, false]);
    }
  });
});
