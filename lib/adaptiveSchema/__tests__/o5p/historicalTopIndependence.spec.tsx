/**
 * Owner ruling (review of 1ee4982): truthful independent-model presentation of EXISTING adaptive reports, at render /
 * presentation time. A historical report computed before the independent-voice rule counted every slot a substitute
 * model answered as its own supporter ("Top consensus — agreed by 5 models" with ChatGPT and Claude both answered by
 * DeepSeek). Stored values are never recomputed; the run's own per-slot rows decide the heading and description.
 *
 * Records: the 2c17feee historical records (historicalParity.spec.tsx), in three stored shapes — the R5 shape as stored
 * (presentation, no marker), the legacy shape (no presentation) and a marked copy (Contract P marker) — rendered through
 * every consumer by the same harness (o5pRender.renderRecord). Rows: the record's own scenario rows, then
 *   collapsed:   ChatGPT and Claude recorded as substituted by DeepSeek;
 *   unverified:  one row without a recorded status (execution identity not recorded).
 * Unaffected (independent) rows render byte-identically against the 2c17feee oracle — asserted for every scenario by
 * historicalParity.spec.tsx, unchanged.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { readFileSync } from "fs";
import { join } from "path";
import { SCENARIOS } from "./o5pScenarios";
import { renderRecord } from "./o5pRender";
import {
  ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING,
  ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING,
  adaptiveTopIndependence,
  unmarkedTopIndependence,
} from "@/lib/adaptiveSchema/verdictIndependence";
import type { ModelResult } from "@/lib/types";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const scenarioRows = (name: string) => SCENARIOS.find((s) => s.name === name)!.results();

const collapse = (rows: ModelResult[]) =>
  rows.map((r) => (r.modelId === "chatgpt" || r.modelId === "claude" ? ({ ...r, status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: `${r.provider}:${r.modelId}-model-1` } as ModelResult) : r));
const unverified = (rows: ModelResult[]) => rows.map((r) => (r.modelId === "grok" ? ({ ...r, status: undefined } as unknown as ModelResult) : r));

type Shape = "r5" | "legacy" | "marked";
function shaped(name: string, shape: Shape) {
  const rec = clone(records[name]);
  if (shape === "legacy") delete rec.synthesisReport.presentation;
  if (shape === "marked") rec.synthesisReport.presentation.disagreementPositionVersion = 1;
  return rec;
}

const DEEPSEEK = "DeepSeek (substituting ChatGPT, Claude)";
const UI_KEYS = ["ui.synthesisView", "ui.panelResponse"];

describe("historical adaptive report, collapsed DeepSeek slots (generic-consensus: 5 slots stored as 'agreed by 5')", () => {
  it.each(["r5", "legacy", "marked"] as Shape[])("%s shape: no unqualified 'Top consensus' / 'agreed by N'; the executing model is named", async (shape) => {
    const out = await renderRecord(shaped("generic-consensus", shape), collapse(scenarioRows("generic-consensus")));
    for (const k of UI_KEYS) {
      const html = out[k]!;
      expect([k, html.includes(">Top consensus<")]).toEqual([k, false]);
      expect([k, /agreed by \d+ model/.test(html)]).toEqual([k, false]);
      expect([k, /supported or partially supported by \d+ panel slot/.test(html)]).toEqual([k, false]);
      // Review of cf74a52 (N1): four independent executing models keep a qualified consensus heading; the card's result
      // line states the executing models itself (MAJOR-1), so no separate statement repeats it.
      expect([k, html.includes("Top consensus (4 independent models; a substitute model that answered several slots counted once)")]).toEqual([k, true]);
      expect([k, html.includes(`recorded as consensus of 5 panel slots; those slots were answered by 4 independent models (${DEEPSEEK}; Grok; Perplexity; Gemini)`)]).toEqual([k, true]);
      expect([k, html.includes("Recorded as supported by 5 panel slots")]).toEqual([k, false]);
    }
    const md = out["text.markdown"]!;
    expect(md).toContain(`**Model independence:** Recorded as supported by 5 panel slots`);
    expect(md).toContain(DEEPSEEK);
    expect(md).not.toMatch(/Top consensus:/);
    if (shape !== "marked") {
      // Unmarked memos state the run's independent executing models, not the dispatched slots.
      expect(out["text.memo"]).toContain("4 AI models researched this question independently.");
      expect(out["text.memo"]).not.toContain("5 AI models researched");
    }
  });

  it("primary strip (readable / answer-first layout): no 'Models agree — 5 models'", async () => {
    const out = await renderRecord(shaped("generic-consensus", "r5"), collapse(scenarioRows("generic-consensus")));
    const strip = out["ui.primaryStrip"]!;
    expect(strip).not.toContain(">Models agree<");
    expect(strip).not.toMatch(/— 5 models/);
    // Rendered here without the stored rows: the run's slots decide, and the stored result says what it counts.
    expect(strip).toContain(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING);
    expect(strip).toContain("counted by panel slot; in this run DeepSeek (substituting ChatGPT, Claude) answered several slots");
  });

  it("marked shape: the exports (PDF / DOCX) head the top claim with the qualified heading", async () => {
    const out = await renderRecord(shaped("generic-consensus", "marked"), collapse(scenarioRows("generic-consensus")));
    for (const k of ["export.pdfTree", "export.docxXml"]) {
      expect([k, out[k]!.includes("Top consensus (4 independent models; a substitute model that answered several slots counted once)")]).toEqual([k, true]);
      expect([k, /Top consensus(?! \(4 independent)/.test(out[k]!)]).toEqual([k, false]);
    }
  });

  it("stored values are not recomputed: the stored card and rows are untouched by rendering", async () => {
    const rec = shaped("generic-consensus", "r5");
    const before = JSON.stringify(rec);
    await renderRecord(rec, collapse(scenarioRows("generic-consensus")));
    expect(JSON.stringify(rec)).toBe(before);
    expect(rec.synthesisReport.verdictCard.consensusModelCount).toBe(5);
  });
});

describe("historical adaptive report, insufficient provenance (a row without a recorded status)", () => {
  it.each(["r5", "legacy", "marked"] as Shape[])("%s shape: 'Model independence unverified'; nothing invented", async (shape) => {
    const out = await renderRecord(shaped("generic-consensus", shape), unverified(scenarioRows("generic-consensus")));
    for (const k of UI_KEYS) {
      const html = out[k]!;
      expect([k, html.includes(">Top consensus<")]).toEqual([k, false]);
      expect([k, /agreed by \d+ model/.test(html)]).toEqual([k, false]);
      expect([k, html.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([k, true]);
      expect([k, html.includes("recorded as consensus of 5 panel slots; model independence unverified — which models answered the supporting slots is not recorded")]).toEqual([k, true]);
      expect([k, html.includes("substituting")]).toEqual([k, false]);
    }
    expect(out["text.markdown"]).toContain("**Model independence:** Model independence unverified:");
    if (shape !== "marked") expect(out["text.memo"]).toContain("CONSENSUS SCORE: withheld (model independence not recorded)");
  });
});

describe("independent supporters are unaffected", () => {
  it("one DeepSeek substitution (no collapse) and all-independent rows: no qualification anywhere", async () => {
    for (const name of ["generic-substituted-and-failed", "generic-consensus", "generic-splits", "procedural", "contested-empirical"]) {
      for (const shape of ["r5", "legacy", "marked"] as Shape[]) {
        const out = await renderRecord(shaped(name, shape), scenarioRows(name));
        for (const [k, v] of Object.entries(out)) {
          if (!v) continue;
          expect([name, shape, k, v.includes(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING) || v.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING) || v.includes("Model independence:")]).toEqual([name, shape, k, false]);
        }
      }
    }
    // 15 full renders (every consumer, PDF and DOCX included) in one test: under a loaded full-suite run this exceeded
    // jest's 5 s default (seen on ff15cb6 before any C-a review change). The assertions are unchanged.
  }, 120_000);

  it("without the run's rows (surface not handed the record) nothing is inferred", () => {
    expect(adaptiveTopIndependence(["chatgpt", "claude"], null)).toEqual({ kind: "independent" });
    expect(unmarkedTopIndependence(records["generic-consensus"].synthesisReport.verdictCard, records["generic-consensus"].alignedClaims, null)).toBeNull();
  });
});

describe("the rule on its own", () => {
  const f = (modelId: string, substituted?: boolean, provider?: string) => ({ modelId, ...(substituted !== undefined ? { substituted } : {}), ...(provider ? { provider } : {}) });
  it("supporters collapse → repeated; a non-supporting collapsed pair does not qualify supporter scope", () => {
    const prov = [f("chatgpt", true, "deepseek"), f("claude", true, "deepseek"), f("grok", false, "xai")];
    expect(adaptiveTopIndependence(["chatgpt", "claude", "grok"], prov)).toEqual({ kind: "repeated_substitute", scope: "supporters", voices: [DEEPSEEK, "Grok"], repeated: [DEEPSEEK] });
    expect(adaptiveTopIndependence(["chatgpt", "grok"], prov)).toEqual({ kind: "independent" });
    expect(adaptiveTopIndependence(null, prov)).toMatchObject({ kind: "repeated_substitute", scope: "run" });
  });
  it("a supporter with no row, or a row without a recorded status → unverified", () => {
    expect(adaptiveTopIndependence(["chatgpt", "gemini"], [f("chatgpt", false)])).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [f("chatgpt", false), f("claude")])).toEqual({ kind: "unverified", scope: "supporters" });
  });
  it("two substitutes with no recorded provider: their executing identity cannot be verified → unverified (nothing split)", () => {
    // C-a review F-1 (owner ruling): the shared corrected D-4 gate (lib/panel/executionIdentity.ts) requires a recorded
    // provider on every answered slot; an unrecorded substitute is never merged into "one model" by inference.
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [f("chatgpt", true), f("claude", true)])).toEqual({ kind: "unverified", scope: "supporters" });
  });
});
