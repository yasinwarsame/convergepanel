/**
 * Owner order C (review of cf74a52): truthful independent-executing-model presentation THROUGHOUT a historical adaptive
 * report — every agreement statement, not only the top heading. A report computed before the independent-voice rule
 * counted every slot a substitute model answered as its own supporter; at render time each consensus / majority
 * statement whose stored row's supporting slots are not independent executing models is stated by its executing models
 * (verdictIndependence.ts). Stored scores, claims and rows are never changed.
 *
 * Records: the 2c17feee historical records (historicalParity.spec.tsx) in three stored shapes (R5 as stored, legacy
 * without presentation, Contract P marked), rendered through every consumer (o5pRender.renderRecord: report view, panel
 * response, governance card, strip, Markdown, LinkedIn, X, memo, PDF element tree, DOCX document.xml).
 * Row variants (the run's per-slot rows; the stored report is the same):
 *   allDeepSeek   — every answering slot substituted by DeepSeek: one executing model;
 *   partial       — ChatGPT and Claude substituted by DeepSeek: 4 executing models for 5 slots;
 *   twoVoices     — ChatGPT, Claude, Grok, Perplexity substituted by DeepSeek, Gemini its own: 2 executing models;
 *   unverified    — Grok's row records no status (execution identity unknown);
 *   splitNonSupp  — Claude and Perplexity (the generic-splits top claim's NON-supporters) collapse to DeepSeek.
 * Unaffected rows render byte-identically against the 2c17feee oracle (historicalParity.spec.tsx, unchanged).
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCENARIOS } from "./o5pScenarios";
import { provenanceOf, renderRecord } from "./o5pRender";
import { htmlText } from "./htmlText";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { PanelVerdictCard } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import {
  AGREE_HEADING_ONE_EXECUTING_MODEL,
  AGREE_HEADING_REPEATED_SUBSTITUTE,
  ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING,
  independenceQualification,
  presentIndependenceQualifiedReport,
  unmarkedTopIndependence,
} from "@/lib/adaptiveSchema/verdictIndependence";
import { EXPORT_VERDICT_SECTION_COUNTED_BY_EXECUTING_MODEL, EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED } from "@/lib/adaptiveSchema/exportPositionView";
import type { ModelResult } from "@/lib/types";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const scenarioRows = (name: string) => SCENARIOS.find((s) => s.name === name)!.results();

const sub = (r: ModelResult) => ({ ...r, status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: `${r.provider}:${r.modelId}-model-1` }) as ModelResult;
const subOnly = (ids: string[]) => (rows: ModelResult[]) => rows.map((r) => (ids.includes(r.modelId) ? sub(r) : r));
const VARIANTS = {
  allDeepSeek: subOnly(["chatgpt", "claude", "grok", "perplexity", "gemini"]),
  partial: subOnly(["chatgpt", "claude"]),
  twoVoices: subOnly(["chatgpt", "claude", "grok", "perplexity"]),
  unverified: (rows: ModelResult[]) => rows.map((r) => (r.modelId === "grok" ? ({ ...r, status: undefined } as unknown as ModelResult) : r)),
  splitNonSupp: subOnly(["claude", "perplexity"]),
};

type Shape = "r5" | "legacy" | "marked";
const SHAPES: Shape[] = ["r5", "legacy", "marked"];
function shaped(name: string, shape: Shape) {
  const rec = clone(records[name]);
  if (shape === "legacy") delete rec.synthesisReport.presentation;
  if (shape === "marked") rec.synthesisReport.presentation.disagreementPositionVersion = 1;
  return rec;
}

/** Visible text of a surface: HTML / DOCX XML tags stripped; the PDF element tree's strings joined. */
function textOf(key: string, v: string): string {
  if (key === "export.pdfTree") {
    const out: string[] = [];
    JSON.parse(v, (k, val) => {
      if (typeof val === "string" && k !== "t") out.push(val);
      return val;
    });
    return out.join(" ");
  }
  if (key.startsWith("ui.") || key === "export.docxXml") return htmlText(v);
  return v;
}

const SURFACES = ["ui.synthesisView", "ui.panelResponse", "ui.governance", "text.markdown", "text.linkedin", "text.memo", "export.pdfTree", "export.docxXml"];
const ALL_DEEPSEEK = "DeepSeek (substituting ChatGPT, Claude, Grok, Perplexity, Gemini)";
const PARTIAL = "DeepSeek (substituting ChatGPT, Claude)";
/** A stored consensus / majority statement standing alone — the unqualified slot count presented as model agreement. */
const UNQUALIFIED_AGREEMENT = /(?<!recorded as )\b(consensus|majority): (all )?\d+ (of \d+ )?dispatched models support it(?! \(counted by panel slot)/;
const SLOT_NAMES_AS_SUPPORTERS = /Supported by:?\**:? ChatGPT, Claude, Grok, Perplexity, Gemini(?! \(panel slots\))/;

const cache = new Map<string, Promise<Record<string, string | null>>>();
const render = (name: string, shape: Shape, variant: keyof typeof VARIANTS) => {
  const k = `${name}|${shape}|${variant}`;
  if (!cache.has(k)) cache.set(k, renderRecord(shaped(name, shape), VARIANTS[variant](scenarioRows(name))));
  return cache.get(k)!;
};

describe("every slot answered by DeepSeek (generic-consensus, stored 'consensus: all 5 dispatched models support it')", () => {
  it.each(SHAPES)("%s shape: no surface presents one executing model as multi-model agreement", async (shape) => {
    const out = await render("generic-consensus", shape, "allDeepSeek");
    for (const key of SURFACES) {
      const text = textOf(key, out[key]!);
      expect([key, UNQUALIFIED_AGREEMENT.exec(text)?.[0] ?? null]).toEqual([key, null]);
      expect([key, SLOT_NAMES_AS_SUPPORTERS.test(text)]).toEqual([key, false]);
      expect([key, /Top consensus\b(?! \()/.test(text)]).toEqual([key, false]);
      expect([key, /agreed by \d+ model/.test(text)]).toEqual([key, false]);
      // The executing model is named on every surface that states an agreement.
      expect([key, text.includes(ALL_DEEPSEEK)]).toEqual([key, true]);
    }
    for (const key of ["ui.synthesisView", "text.markdown", "text.linkedin"]) {
      const text = textOf(key, out[key]!);
      expect([key, /Where models agree(?! \()/.test(text)]).toEqual([key, false]);
    }
    // The share posts never call one executing model a multi-model panel.
    expect(out["text.linkedin"]).not.toContain("multi-model AI panel");
    expect(out["text.x"]).not.toContain("multi-model AI panel");
  });

  it.each(["r5", "legacy"] as Shape[])("%s shape: the unified answer, agree list and card name the executing model and its slot count", async (shape) => {
    const out = await render("generic-consensus", shape, "allDeepSeek");
    const view = textOf("ui.synthesisView", out["ui.synthesisView"]!);
    if (shape === "r5") {
      expect(view).toContain(`Panel result: not an independent consensus: the 5 panel slots supporting it were all answered by one model, ${ALL_DEEPSEEK}`);
      expect(view).toContain(`Supported by: ${ALL_DEEPSEEK}`);
    } else {
      // The legacy answer string names slots: it is followed by what they are.
      expect(view).toContain(`Model independence: The models named here are panel slots: in this run ${ALL_DEEPSEEK} answered several slots, so they are not all independent models.`);
    }
    expect(view).toContain(AGREE_HEADING_ONE_EXECUTING_MODEL);
    expect(view).toContain(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING);
    // The panel count says what it counts; the load-bearing list names the executing model once, with its status.
    expect(view).toContain(`Of 2 scored claims across 5 dispatched models: consensus on 2. These counts are of panel slots: in this run ${ALL_DEEPSEEK} answered several slots, so they are not counts of independent models.`);
    if (shape === "r5") {
      expect(view).toContain(`Panel result: Not an independent consensus (supported by ${ALL_DEEPSEEK})`);
      expect(view).not.toContain("DeepSeek (substituting ChatGPT), DeepSeek (substituting Claude)");
    }
    if (shape === "legacy") {
      // Each stored "Where models agree" line is followed by its computed result.
      expect(view).toContain(`“Raising the minimum wage reduces employment” Panel result: not an independent consensus: the 5 panel slots supporting it were all answered by one model, ${ALL_DEEPSEEK}`);
    }
    // The qualified card states independence once, in its result line (MAJOR-1: no consensus line under the qualifier).
    expect(view).not.toContain("Recorded as supported by 5 panel slots");
    expect(out["text.linkedin"]).toContain(`across an AI panel whose responding slots were all answered by one model, ${ALL_DEEPSEEK}.`);
    expect(out["text.x"]).toContain("Asked an AI panel (one model answered every slot):");
  });

  it.each(["r5", "legacy"] as Shape[])("%s shape: the memo's key findings are not consensus lines", async (shape) => {
    const memo = (await render("generic-consensus", shape, "allDeepSeek"))["text.memo"]!;
    const findings = memo.slice(memo.indexOf("KEY FINDINGS"), memo.indexOf("\n\n", memo.indexOf("KEY FINDINGS")));
    expect(findings).toContain("not an independent consensus");
    expect(UNQUALIFIED_AGREEMENT.test(findings)).toBe(false);
  });
});

describe("partial collapse (5 slots, 4 executing models): the counts agree on every surface", () => {
  it.each(SHAPES)("%s shape", async (shape) => {
    const out = await render("generic-consensus", shape, "partial");
    for (const key of SURFACES) {
      const text = textOf(key, out[key]!);
      expect([key, UNQUALIFIED_AGREEMENT.exec(text)?.[0] ?? null]).toEqual([key, null]);
      expect([key, text.includes("4 independent models")]).toEqual([key, true]);
      expect([key, text.includes(PARTIAL)]).toEqual([key, true]);
      expect([key, /answered by 5 independent models|5 independent models/.test(text)]).toEqual([key, false]);
    }
    // N1: two or more independent supporters keep a (qualified) consensus heading.
    for (const key of ["ui.synthesisView", "ui.governance", "export.pdfTree", "export.docxXml"]) {
      expect([key, textOf(key, out[key]!).includes("Top consensus (4 independent models; a substitute model that answered several slots counted once)")]).toEqual([key, true]);
    }
    if (shape !== "marked") {
      expect(out["text.memo"]).toContain("4 AI models researched this question independently.");
      expect(textOf("ui.synthesisView", out["ui.synthesisView"]!)).toContain(AGREE_HEADING_REPEATED_SUBSTITUTE);
    }
  });
});

describe("two genuinely independent executing models among five slots", () => {
  it.each(SHAPES)("%s shape: stated as 2 independent models, never 5", async (shape) => {
    const out = await render("generic-consensus", shape, "twoVoices");
    for (const key of SURFACES) {
      const text = textOf(key, out[key]!);
      expect([key, UNQUALIFIED_AGREEMENT.exec(text)?.[0] ?? null]).toEqual([key, null]);
      expect([key, text.includes("2 independent models")]).toEqual([key, true]);
    }
    expect(textOf("ui.synthesisView", out["ui.synthesisView"]!)).toContain("Top consensus (2 independent models;");
    // Two independent models are a multi-model panel: the share intro is as before.
    expect(out["text.linkedin"]).toContain("across a multi-model AI panel using ConvergePanel.");
  });
});

describe("unknown historical provenance (a row without a recorded status)", () => {
  it.each(SHAPES)("%s shape: explicit unverified-independence classification; nothing invented", async (shape) => {
    const out = await render("generic-consensus", shape, "unverified");
    for (const key of SURFACES) {
      const text = textOf(key, out[key]!);
      expect([key, UNQUALIFIED_AGREEMENT.exec(text)?.[0] ?? null]).toEqual([key, null]);
      expect([key, /model independence unverified/i.test(text)]).toEqual([key, true]);
      expect([key, text.includes("substituting")]).toEqual([key, false]);
    }
    expect(textOf("export.pdfTree", out["export.pdfTree"]!)).toContain(shape === "marked" ? "Top finding (model independence unverified" : EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED);
    expect(out["text.linkedin"]).toContain("across an AI panel (model independence unverified: which models answered is not recorded).");
  });
});

describe("valid independent support is preserved (generic-splits: the top claim's supporters ChatGPT, Grok, Gemini are independent; non-supporters Claude, Perplexity collapse)", () => {
  it.each(["r5", "legacy"] as Shape[])("%s shape: strip, card and governance card agree — an independent majority, unqualified", async (shape) => {
    const out = await render("generic-splits", shape, "splitNonSupp");
    for (const key of ["ui.panelResponse", "ui.synthesisView", "ui.governance"]) {
      const text = textOf(key, out[key]!);
      expect([key, text.includes(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING)]).toEqual([key, false]);
      expect([key, text.includes("agreed by 3 models") || text.includes("— 3 models")]).toEqual([key, true]);
    }
    const panel = textOf("ui.panelResponse", out["ui.panelResponse"]!);
    expect(panel).toContain("Models agree"); // the strip, judged from the stored rows (MINOR-1)
    expect(panel).not.toContain("not presented as an independent consensus");
  });

  it("the strip handed the rows judges the top claim's supporters; without them, the run (stated as such)", () => {
    const rec = records["generic-splits"];
    const prov = provenanceOf(VARIANTS.splitNonSupp(scenarioRows("generic-splits")));
    const strip = (rows?: unknown[]) => htmlText(renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: prov }, createElement(PrimarySynthesisStrip, { synthesisReport: rec.synthesisReport, alignedClaims: rows }))));
    const withRows = strip(rec.alignedClaims);
    expect(withRows).toContain("Models agree");
    expect(withRows).toContain("— 3 models");
    expect(withRows).not.toContain("counted by panel slot");
    const withoutRows = strip(undefined);
    expect(withoutRows).toContain(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING);
    expect(withoutRows).toContain("counted by panel slot");
  });

  it("the governance card's PanelVerdictCard (no rows passed) reads the qualified view, never re-judging by the run", () => {
    const rec = records["generic-splits"];
    const prov = provenanceOf(VARIANTS.splitNonSupp(scenarioRows("generic-splits")));
    const view = presentIndependenceQualifiedReport(rec.synthesisReport, { rows: rec.alignedClaims, provenance: prov });
    expect(independenceQualification(view)).toMatchObject({ top: null });
    const card = htmlText(renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: prov }, createElement(PanelVerdictCard, { report: view, gate: rec.gate }))));
    expect(card).toContain("agreed by 3 models");
    expect(card).not.toContain(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING);
  });
});

describe("PDF / DOCX (controlled exception: the unmarked verdict section and answer)", () => {
  it.each(["r5", "legacy"] as Shape[])("%s shape: section heading, top heading, executing models and counts", async (shape) => {
    const all = await render("generic-consensus", shape, "allDeepSeek");
    const partial = await render("generic-consensus", shape, "partial");
    for (const key of ["export.pdfTree", "export.docxXml"]) {
      const a = textOf(key, all[key]!);
      expect([key, a.includes(EXPORT_VERDICT_SECTION_COUNTED_BY_EXECUTING_MODEL)]).toEqual([key, true]);
      expect([key, /Where models agree \/ disagree(?! \()/.test(a)]).toEqual([key, false]);
      expect([key, a.includes(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING)]).toEqual([key, true]);
      expect([key, /\bAgreement\b/.test(a)]).toEqual([key, false]);
      expect([key, a.includes(`not an independent consensus: the 5 panel slots supporting it were all answered by one model, ${ALL_DEEPSEEK}`)]).toEqual([key, true]);
      if (shape === "r5") expect([key, a.includes(ALL_DEEPSEEK) && !SLOT_NAMES_AS_SUPPORTERS.test(a)]).toEqual([key, true]);
      const p = textOf(key, partial[key]!);
      expect([key, p.includes("recorded as consensus of 5 panel slots; those slots were answered by 4 independent models")]).toEqual([key, true]);
    }
  });
});

describe("the view itself", () => {
  const rec = records["generic-consensus"];
  it("returns the stored object for an independent run and without the run's rows; never mutates stored data", () => {
    const stored = clone(rec.synthesisReport);
    const before = JSON.stringify(stored);
    expect(presentIndependenceQualifiedReport(stored, { rows: rec.alignedClaims, provenance: provenanceOf(scenarioRows("generic-consensus")) })).toBe(stored);
    expect(presentIndependenceQualifiedReport(stored, { rows: rec.alignedClaims, provenance: null })).toBe(stored);
    const q = presentIndependenceQualifiedReport(stored, { rows: rec.alignedClaims, provenance: provenanceOf(VARIANTS.allDeepSeek(scenarioRows("generic-consensus"))) });
    expect(q).not.toBe(stored);
    expect(JSON.stringify(stored)).toBe(before);
    expect(presentIndependenceQualifiedReport(q, { rows: rec.alignedClaims, provenance: null })).toBe(q); // idempotent
  });

  it("N2: a top claim whose text two stored rows share is not joined (the run decides, never the first row)", () => {
    const rows = clone(rec.alignedClaims);
    const top = rows.find((r: any) => r.claimText === rec.synthesisReport.verdictCard.topConsensus);
    // The duplicate is supported by ChatGPT + Gemini only (independent); the run's ChatGPT and Claude collapse.
    const dup = { ...clone(top), id: "dup", cells: top.cells.map((c: any) => (c && (c.modelId === "chatgpt" || c.modelId === "gemini") ? c : null)) };
    const prov = provenanceOf(VARIANTS.partial(scenarioRows("generic-consensus")));
    expect(unmarkedTopIndependence(rec.synthesisReport.verdictCard, [dup, ...rows], prov)).toMatchObject({ kind: "repeated_substitute", scope: "run" });
    expect(unmarkedTopIndependence(rec.synthesisReport.verdictCard, [dup], prov)).toBeNull();
    // The view joins the same way: a duplicated text is stated by the run (counted by panel slot), never by the first row.
    const view: any = presentIndependenceQualifiedReport(rec.synthesisReport, { rows: [dup, ...rows], provenance: prov });
    const topClaim = view.presentation.answer.claims.find((c: any) => c.claim === top.claimText);
    expect(topClaim.result).toBe("consensus: all 5 dispatched models support it (counted by panel slot; in this run DeepSeek (substituting ChatGPT, Claude) answered several slots, so this is not a count of independent models)");
    expect(topClaim.supporters).toBe("ChatGPT, Claude, Grok, Perplexity, Gemini (panel slots)");
    expect(independenceQualification(view)).toMatchObject({ top: { kind: "repeated_substitute", scope: "run" } });
  });
});
