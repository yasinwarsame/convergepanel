/**
 * Executing-model attribution — exact, per-surface label sets (connector fail-closed correction pass, finding E).
 *
 * The frozen parity oracles hold every byte of the pre-rule surfaces; these tests hold the attribution itself, as exact
 * lists (so a dropped, duplicated or reverted label fails), on the surfaces whose regressions the parity suites alone
 * cannot localise:
 *  - Agreement / disagreement map "Agree", "Dispute" and "Silent" chips (text AND identity dot of every chip);
 *  - `SlotChip` / `ModelChip` (label + neutral dot for a substitute);
 *  - the report view's Copy action (`handleCopy`, the only production call site of `buildAdaptiveSynthesisMarkdown`)
 *    passing the run's provenance;
 *  - the builder's generated answer-claim supporters and load-bearing supporters / disputers on a NEW report, and what
 *    the PDF / DOCX exports print from them.
 * Real components and the real builder; the narrative model call is a mock.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn(async () => ({ modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 })) }));
const mockCopied: string[] = [];
jest.mock("@/lib/ui/copyFormats", () => {
  const actual = jest.requireActual("@/lib/ui/copyFormats");
  return { ...actual, copyToClipboardWithFallback: async (text: string) => (mockCopied.push(text), true) };
});

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "fs";
import { join } from "path";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import AdaptiveSynthesisReportView, { AgreementDisagreementMap } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { SlotChip } from "@/components/adaptive/shared";
import { VerificationActions } from "@/components/VerificationActions";
import { buildAdaptiveSynthesisMarkdown } from "@/lib/adaptiveSchema/shareBuilders";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { computeRunCertainty } from "@/lib/adaptiveSchema/scoring";
import { computeContestedDimensions } from "@/lib/adaptiveSchema/consensusIntegrity";
import { renderRecord, provenanceOf, QUESTION } from "@/lib/adaptiveSchema/__tests__/o5p/o5pRender";
import { CLASSIFICATION_BASE, SCENARIOS } from "@/lib/adaptiveSchema/__tests__/o5p/o5pScenarios";
import type { RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import type { AlignedClaim } from "@/lib/adaptiveSchema/types";
import type { ModelId, ModelResult } from "@/lib/types";

const M: ModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const SUB_CLAUDE = "DeepSeek (substituting Claude)";
const SUB_GROK = "DeepSeek (substituting Grok)";
/** Identity dots, written out independently of the component (ModelChip's MODEL_DOT_COLORS). */
const DOT: Record<string, string> = { chatgpt: "bg-emerald-500", claude: "bg-indigo-500", grok: "bg-amber-500", perplexity: "bg-sky-500", gemini: "bg-rose-500" };
const NEUTRAL = "bg-cp-faint";

const prov = (substituted: Partial<Record<ModelId, string>>): RunModelProvenanceFacts[] =>
  M.map((m) => (substituted[m] ? { modelId: m, provider: substituted[m]!, substituted: true } : { modelId: m, provider: m, substituted: false }));

type Stance = "agrees" | "partial" | "disputes" | "unclear" | null;
let seq = 0;
function row(claimText: string, status: string, st: Stance[], certainty = 0.9): AlignedClaim {
  const r: AlignedClaim = {
    id: `ex-${seq++}`,
    claimText,
    cells: M.map((m, i) => (st[i] ? { modelId: m, stance: st[i], rawStance: "asserts", confidence: "settled", excerpt: `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } } : null)) as any,
    agreementScore: status === "split" ? 0.3 : 0.9,
    certaintyScore: certainty,
    status: status as any,
  };
  const contested = computeContestedDimensions(r);
  return contested ? { ...r, contested } : r;
}

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const isChip = (n: TestRenderer.ReactTestInstance) => n.type === "span" && typeof n.props.className === "string" && n.props.className.startsWith("inline-flex items-center gap-1.5");
/** Every chip under a node: [label, dot class]. */
function chips(node: TestRenderer.ReactTestInstance): Array<[string, string]> {
  return node.findAll(isChip).map((c) => {
    const dot = c.findAll((d) => d.type === "span" && typeof d.props.className === "string" && d.props.className.startsWith("h-2 w-2 shrink-0 rounded-full "))[0];
    return [nodeText(c).trim(), dot.props.className.replace("h-2 w-2 shrink-0 rounded-full ", "")];
  });
}
/** The chip groups of each map row, keyed by the group heading ("Agree" / "Dispute" / "Silent"). */
function mapGroups(r: TestRenderer.ReactTestRenderer): Array<Record<string, Array<[string, string]>>> {
  const headings = r.root.findAll((n) => n.type === "span" && ["Agree", "Dispute", "Silent"].includes(nodeText(n)) && String(n.props.className).includes("uppercase"));
  const byRow = new Map<TestRenderer.ReactTestInstance, Record<string, Array<[string, string]>>>();
  for (const h of headings) {
    const group = h.parent!;
    const rowNode = group.parent!;
    const rec = byRow.get(rowNode) ?? {};
    rec[nodeText(h)] = chips(group);
    byRow.set(rowNode, rec);
  }
  return [...byRow.values()];
}

async function mount(el: any, provenance: RunModelProvenanceFacts[] | null) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(RunModelProvenanceContext.Provider, { value: provenance }, el));
  });
  return r;
}

describe("agreement / disagreement map chips (exact label and dot per chip)", () => {
  const claims = () => [
    row("Rates fall next year", "majority", ["agrees", "agrees", "disputes", null, null]),
    row("Housing cools", "split", ["agrees", "disputes", "agrees", "disputes", null]),
  ];

  it("a substituted slot's Agree and Dispute chips name the executing model with the neutral dot; every other chip is unchanged", async () => {
    const r = await mount(createElement(AgreementDisagreementMap, { claims: claims(), modelsUsed: M.slice(0, 4) }), prov({ claude: "deepseek" }));
    const groups = mapGroups(r);
    expect(groups).toEqual(
      expect.arrayContaining([
        { Agree: [["ChatGPT", DOT.chatgpt], [SUB_CLAUDE, NEUTRAL]], Dispute: [["Grok", DOT.grok]], Silent: [["Perplexity", DOT.perplexity]] },
        { Agree: [["ChatGPT", DOT.chatgpt], ["Grok", DOT.grok]], Dispute: [[SUB_CLAUDE, NEUTRAL], ["Perplexity", DOT.perplexity]] },
      ])
    );
    expect(groups).toHaveLength(2);
    // Exactly two executing-model chips on the map, never the requested model's name or dot.
    const all = groups.flatMap((g) => Object.values(g).flat());
    expect(all.filter(([label]) => label === SUB_CLAUDE)).toEqual([[SUB_CLAUDE, NEUTRAL], [SUB_CLAUDE, NEUTRAL]]);
    expect(all.filter(([label, dot]) => label === "Claude" || dot === DOT.claude)).toEqual([]);
  });

  it("control: with no recorded substitution every chip is the slot's family chip", async () => {
    const r = await mount(createElement(AgreementDisagreementMap, { claims: claims(), modelsUsed: M.slice(0, 4) }), prov({}));
    const all = mapGroups(r).flatMap((g) => Object.values(g).flat());
    expect(all.filter(([label]) => label === "Claude")).toEqual([["Claude", DOT.claude], ["Claude", DOT.claude]]);
    expect(all.filter(([label]) => label.includes("substituting"))).toEqual([]);
  });

  it("NIT: a slot answered by the same substitute as an agreeing slot is not shown again as a 'Silent' chip; a genuinely silent slot still is", async () => {
    // chatgpt and claude both answered by DeepSeek; chatgpt (the repeated substitute) has no stance on the row.
    const twoSubs = prov({ chatgpt: "deepseek", claude: "deepseek" });
    const one = [row("Rates fall next year", "majority", [null, "agrees", "disputes", "agrees", null])];
    const r = await mount(createElement(AgreementDisagreementMap, { claims: one, modelsUsed: M.slice(0, 4) }), twoSubs);
    expect(mapGroups(r)).toEqual([{ Agree: [[SUB_CLAUDE, NEUTRAL], ["Perplexity", DOT.perplexity]], Dispute: [["Grok", DOT.grok]] }]);
    // Control: chatgpt is a real, silent model → still a Silent chip.
    const r2 = await mount(createElement(AgreementDisagreementMap, { claims: one, modelsUsed: M.slice(0, 4) }), prov({ claude: "deepseek" }));
    expect(mapGroups(r2)).toEqual([{ Agree: [[SUB_CLAUDE, NEUTRAL], ["Perplexity", DOT.perplexity]], Dispute: [["Grok", DOT.grok]], Silent: [["ChatGPT", DOT.chatgpt]] }]);
  });
});

describe("SlotChip", () => {
  it.each([
    ["claude", { claude: "deepseek" }, [[SUB_CLAUDE, NEUTRAL]]],
    ["claude", {}, [["Claude", DOT.claude]]],
    ["grok", { grok: "deepseek" }, [[SUB_GROK, NEUTRAL]]],
    ["chatgpt", { claude: "deepseek" }, [["ChatGPT", DOT.chatgpt]]],
  ] as const)("%s with %j → %j", async (modelId, subs, expected) => {
    const r = await mount(createElement(SlotChip, { modelId, size: "xs" } as any), prov(subs as any));
    expect(chips(r.root)).toEqual(expected);
  });
});

describe("report view Copy (handleCopy → buildAdaptiveSynthesisMarkdown) carries the run's provenance", () => {
  const FIX = join(__dirname, "..", "..", "..", "lib", "adaptiveSchema", "__tests__", "o5p", "__fixtures__", "baseline-2c17fee");
  const records = JSON.parse(readFileSync(join(FIX, "records.json"), "utf8"));
  const NAME = "generic-substituted-and-failed";
  const scenario = SCENARIOS.find((s) => s.name === NAME)!;

  it("the copied markdown names the substituted slot's disagreement positions by the executing model, exactly", async () => {
    const rec = JSON.parse(JSON.stringify(records[NAME]));
    const p = provenanceOf(scenario.results() as ModelResult[]);
    const modelIds = rec.results.map((x: any) => x.modelId);
    const r = await mount(
      createElement(AdaptiveSynthesisReportView, { report: rec.synthesisReport, gate: rec.gate, alignedClaims: rec.alignedClaims, trustSummary: rec.trustSummary, question: QUESTION, modelsUsed: modelIds, runId: "run-o5p" } as any),
      p
    );
    mockCopied.length = 0;
    await act(async () => {
      await r.root.findByType(VerificationActions).props.onCopy();
    });
    expect(mockCopied).toHaveLength(1);
    const copied = mockCopied[0];
    // The same text the share harness renders (pinned in the executing-attribution render hashes).
    expect(copied).toBe(buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, { rows: rec.alignedClaims, roster: modelIds, provenance: p } as any));
    const positionLines = copied.split("\n").filter((l) => /^ {2}- [^:]+: /.test(l)).map((l) => l.slice(4, l.indexOf(":")));
    expect(positionLines.filter((n) => n === SUB_CLAUDE)).toHaveLength(3);
    expect(positionLines.filter((n) => n === "Claude")).toHaveLength(0);
    expect(copied.split(SUB_CLAUDE).length - 1).toBe(3);
  });
});

describe("builder: generated supporters / disputers of a NEW report, and what PDF / DOCX print", () => {
  const A5: Stance[] = ["agrees", "agrees", "agrees", "agrees", "agrees"];
  const SPL: Stance[] = ["agrees", "agrees", "disputes", "disputes", "disputes"];
  const results = (subs: Partial<Record<ModelId, string>>): ModelResult[] =>
    M.map((m) => ({ modelId: m, status: subs[m] ? "substituted" : "ok", rawText: "{}", latencyMs: 1, provider: subs[m] ?? { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" }[m] }) as ModelResult);

  /**
   * A new report is marked (Contract P): its PDF / DOCX present supporters / disputers from the row cells with the
   * marked slot wording. The same report with the marker removed takes the unmarked export path, which prints the
   * builder's stored `supporters` / `disputers` strings (answerClaimLines / unresolvedGroups) — as every historical report does.
   */
  async function build(rows: AlignedClaim[], subs: Partial<Record<ModelId, string>>) {
    const raw = results(subs);
    const report = await buildAdaptiveSynthesisReport(QUESTION, "generic", rows, raw);
    expect((report.presentation as any).disagreementPositionVersion).toBe(1);
    const gate = computeAdaptiveGate(rows, computeRunCertainty(rows, "generic"), "generic");
    const rec = (synthesisReport: any) => ({ schemaId: "generic", classification: { ...CLASSIFICATION_BASE, queryType: "generic", answerShape: "sections" }, results: raw, alignedClaims: rows, gate, synthesisReport });
    const out = await renderRecord(rec(report) as any, raw);
    const unmarkedReport = JSON.parse(JSON.stringify(report));
    delete unmarkedReport.presentation.disagreementPositionVersion;
    const unmarked = await renderRecord(rec(unmarkedReport) as any, raw);
    return { report, gate, out, unmarked };
  }
  const MARKED_SUB_CLAUDE = "Claude slot (substituted; answered by DeepSeek)";
  const MARKED_SUB_GROK = "Grok slot (substituted; answered by DeepSeek)";
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("answer claims: supporters name the substitute by its executing model (and the exports print exactly that)", async () => {
    const rows = [row("Rate cuts reach inflation within a year", "consensus", A5), row("Housing costs respond slowest", "consensus", A5), row("Wage growth lags", "consensus", A5)];
    const { report, gate, out, unmarked } = await build(rows, { claude: "deepseek" });
    expect(gate.status).toBe("pass");
    const supporters = (report.presentation!.answer!.claims as any[]).map((c) => c.supporters);
    expect(supporters).toEqual(Array(supporters.length).fill(`ChatGPT, ${SUB_CLAUDE}, Grok, Perplexity, Gemini`));
    expect(supporters.length).toBeGreaterThan(0);
    for (const k of ["export.docxXml", "export.pdfTree"]) {
      // Unmarked export path: the stored string, once per answer claim.
      expect([k, count(unmarked[k]!, `ChatGPT, ${SUB_CLAUDE}, Grok, Perplexity, Gemini`)]).toEqual([k, supporters.length]);
      expect([k, unmarked[k]!.includes("ChatGPT, Claude, Grok")]).toEqual([k, false]);
      // Marked (new report) export path: the slot wording names the executing model; the bare requested slot never supports.
      expect([k, out[k]!.includes(MARKED_SUB_CLAUDE)]).toEqual([k, true]);
      expect([k, out[k]!.includes("Claude slot,")]).toEqual([k, false]);
    }
  });

  it("load-bearing split (supporters side substituted): supporters name the executing model", async () => {
    const rows = [row("Rate cuts reach inflation within a year", "majority", ["agrees", "agrees", "agrees", "agrees", "disputes"], 0.85), row("Tariffs raise consumer prices", "split", SPL, 0.6)];
    const { report, out, unmarked } = await build(rows, { claude: "deepseek" });
    const lb = (report.presentation!.verificationGate!.unresolvedLoadBearing as any[]).map((c) => [c.supporters, c.disputers]);
    expect(lb).toEqual([[`ChatGPT, ${SUB_CLAUDE}`, "Grok, Perplexity, Gemini"]]);
    for (const k of ["export.docxXml", "export.pdfTree"]) {
      // Exactly one supporters list that is ChatGPT + the substitute alone (the answer claim's longer list continues with ", Grok").
      expect([k, count(unmarked[k]!, `ChatGPT, ${SUB_CLAUDE}`) - count(unmarked[k]!, `ChatGPT, ${SUB_CLAUDE},`)]).toEqual([k, 1]);
      expect([k, out[k]!.includes(`ChatGPT slot, ${MARKED_SUB_CLAUDE}`)]).toEqual([k, true]);
    }
  });

  it("load-bearing split (disputers side substituted): disputers name the executing model", async () => {
    const rows = [row("Rate cuts reach inflation within a year", "majority", ["agrees", "agrees", "agrees", "agrees", "disputes"], 0.85), row("Tariffs raise consumer prices", "split", SPL, 0.6)];
    const { report, out, unmarked } = await build(rows, { grok: "deepseek" });
    const lb = (report.presentation!.verificationGate!.unresolvedLoadBearing as any[]).map((c) => [c.supporters, c.disputers]);
    expect(lb).toEqual([["ChatGPT, Claude", `${SUB_GROK}, Perplexity, Gemini`]]);
    for (const k of ["export.docxXml", "export.pdfTree"]) {
      expect([k, count(unmarked[k]!, `${SUB_GROK}, Perplexity, Gemini`)]).toEqual([k, 1]);
      expect([k, out[k]!.includes(`${MARKED_SUB_GROK}, Perplexity slot, Gemini slot`)]).toEqual([k, true]);
    }
  });
});
