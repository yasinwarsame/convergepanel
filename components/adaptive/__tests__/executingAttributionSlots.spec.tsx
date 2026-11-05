/**
 * Executing-model attribution on adaptive surfaces (owner rule, connector fail-closed pass A1).
 *
 * On an UNMARKED report a slot the run records as substituted is named by the model that wrote it —
 * "DeepSeek (substituting Claude)" — in every place that says who supported / disputed / agreed: SlotName, SlotChip
 * (claim matrix columns, consensus map), the load-bearing claim lists, the Trust Summary, and the copied markdown.
 * Marked (Contract P) reports keep "Claude slot (substituted; answered by DeepSeek)". Without the run's record nothing
 * is inferred. Real components, rendered with renderToStaticMarkup; assertions on the rendered text.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import { SlotChip, SlotName } from "@/components/adaptive/shared";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { PositionPresentationContext } from "@/components/adaptive/PositionPresentationContext";
import AdaptiveSynthesisReportView, { TrustSummaryTable } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { buildAdaptiveSynthesisMarkdown } from "@/lib/adaptiveSchema/shareBuilders";
import { REPEATED_SUBSTITUTE_EXCLUDED } from "@/lib/panel/independentVoices";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { SCENARIOS } from "@/lib/adaptiveSchema/__tests__/o5p/o5pScenarios";
import { provenanceOf, renderRecord } from "@/lib/adaptiveSchema/__tests__/o5p/o5pRender";

const PROV: RunModelProvenanceFacts[] = [
  { modelId: "chatgpt", provider: "openai", substituted: false },
  { modelId: "claude", provider: "deepseek", substituted: true },
];
const html = (el: any, prov: readonly RunModelProvenanceFacts[] | null = PROV) => renderToStaticMarkup(createElement(RunModelProvenanceContext.Provider, { value: prov }, el));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "|");

describe("SlotName / SlotChip", () => {
  it("unmarked report: a recorded substituted slot is named by its executing model", () => {
    expect(text(html(createElement(SlotName, { modelId: "claude" })))).toBe("DeepSeek (substituting Claude)");
    const chip = html(createElement(SlotChip, { modelId: "claude", size: "xs" } as any));
    expect(text(chip)).toContain("DeepSeek (substituting Claude)");
    expect(text(chip)).not.toMatch(/\|Claude\|/);
    expect(chip).not.toContain("bg-indigo-500"); // the requested model's identity dot is not used for DeepSeek's answer
  });

  it("unmarked report: a non-substituted slot keeps its family name and dot", () => {
    expect(text(html(createElement(SlotName, { modelId: "chatgpt" })))).toBe("ChatGPT");
    const chip = html(createElement(SlotChip, { modelId: "chatgpt", size: "xs" } as any));
    expect(text(chip)).toContain("ChatGPT");
    expect(chip).toContain("bg-emerald-500");
  });

  it("no run record held: nothing inferred — family name", () => {
    expect(text(html(createElement(SlotName, { modelId: "claude" }), null))).toBe("Claude");
  });

  it("marked report keeps the Contract P slot wording", () => {
    const marked = createElement(PositionPresentationContext.Provider, { value: { marked: true, roster: ["chatgpt", "claude"], provenance: PROV } } as any, createElement(SlotName, { modelId: "claude" }));
    expect(text(html(marked))).toBe("Claude slot (substituted; answered by DeepSeek)");
  });
});

describe("Trust Summary: a repeated substitute reads 'not counted', not a parse failure", () => {
  const trust = (perModel: Array<[string, "ok" | "failed"]>) => ({
    perModel: perModel.map(([modelId, parseHealth]) => ({ modelId, claimsContributed: 1, majorityAlignment: 1, citationScore: 1, contradictionCount: 0, parseHealth, trustScore: parseHealth === "ok" ? 0.9 : 0, capped: parseHealth !== "ok" })),
    overallTrust: 0.9,
  });
  const TWO_SUBS: RunModelProvenanceFacts[] = [
    { modelId: "chatgpt", provider: "deepseek", substituted: true },
    { modelId: "claude", provider: "deepseek", substituted: true },
    { modelId: "grok", provider: "xai", substituted: false },
    { modelId: "gemini", provider: "google", substituted: false },
  ];

  it("second DeepSeek slot → 'not counted' (with the reason); a genuine parse failure still reads 'failed'", () => {
    const out = html(createElement(TrustSummaryTable, { trustSummary: trust([["chatgpt", "ok"], ["claude", "failed"], ["grok", "ok"], ["gemini", "failed"]]) } as any), TWO_SUBS);
    expect(out).toContain(`title="${REPEATED_SUBSTITUTE_EXCLUDED}"`);
    expect(out.match(/>not counted</g)).toHaveLength(1);
    expect(out.match(/>failed</g)).toHaveLength(1);
    expect(text(out)).toContain("DeepSeek (substituting Claude)");
  });

  it("the FIRST substituted slot that failed is a real failure (no earlier counted substitute)", () => {
    const out = html(createElement(TrustSummaryTable, { trustSummary: trust([["chatgpt", "failed"], ["claude", "ok"], ["grok", "ok"]]) } as any), TWO_SUBS);
    expect(out).not.toContain(">not counted<");
    expect(out.match(/>failed</g)).toHaveLength(1);
  });
});

describe("recorded historical report (generic-substituted-and-failed): every agreement surface names DeepSeek", () => {
  const FIX = join(__dirname, "..", "..", "..", "lib", "adaptiveSchema", "__tests__", "o5p", "__fixtures__", "baseline-2c17fee");
  const records = JSON.parse(readFileSync(join(FIX, "records.json"), "utf8"));
  const NAME = "generic-substituted-and-failed";
  const scenario = SCENARIOS.find((s) => s.name === NAME)!;

  it("load-bearing claims, claim matrix, consensus map and copied markdown attribute the substitute", async () => {
    const out = await renderRecord(JSON.parse(JSON.stringify(records[NAME])), scenario.results());
    // Load-bearing claim list (LoadBearingClaim): supporters / disputers.
    expect(out["ui.synthesisView"]).toContain("(supported by ChatGPT, DeepSeek (substituting Claude), Perplexity, Gemini)");
    expect(out["ui.synthesisView"]).toContain("(supported by ChatGPT; disputed by DeepSeek (substituting Claude))");
    expect(out["ui.synthesisView"]).not.toMatch(/supported by ChatGPT, Claude,/);
    // Claim matrix column.
    expect(out["ui.claimMatrix"]).toMatch(/<th[^>]*>DeepSeek \(substituting Claude\)<\/th>/);
    // Copied markdown: disagreement positions.
    expect(out["text.markdown"]).toContain("DeepSeek (substituting Claude):");
    expect(out["text.markdown"]).not.toMatch(/ {2}- Claude:/);
  });

  it("a report without a presentation lists load-bearing claims with executing-model names", () => {
    const rec = JSON.parse(JSON.stringify(records[NAME]));
    const report = { ...rec.synthesisReport };
    delete report.presentation;
    const out = html(
      createElement(AdaptiveSynthesisReportView, { report, gate: rec.gate, alignedClaims: rec.alignedClaims, trustSummary: rec.trustSummary, question: "q", modelsUsed: rec.results.map((r: any) => r.modelId), runId: "r" } as any),
      provenanceOf(scenario.results() as any)
    );
    expect(out).toMatch(/\(ChatGPT, DeepSeek \(substituting Claude\)[^)]*\)/);
  });

  it("copied markdown without provenance keeps family names (nothing inferred)", () => {
    const report = JSON.parse(JSON.stringify(records[NAME])).synthesisReport;
    const md = buildAdaptiveSynthesisMarkdown("q", report);
    expect(md).not.toContain("substituting");
  });
});
