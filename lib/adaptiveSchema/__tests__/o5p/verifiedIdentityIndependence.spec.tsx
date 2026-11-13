/**
 * C-a review of ff15cb6 — F-1 (MAJOR) and F-2 (MINOR) on the adaptive verdict surfaces (verdictIndependence.ts and
 * everything downstream: verdict card, primary strip, report view, share / memo builders, exportPositionView → PDF /
 * DOCX).
 *
 * F-1: the surfaces apply the shared verified-identity rule (lib/panel/executionIdentity.ts `executionIdentityVerified`,
 * read over per-slot facts through `identityRowFromFacts`). A historical adaptive run recorded before the executing
 * provider was persisted (pre-6.2a / S3mn: `substituted` recorded, NO provider) is "model independence unverified" on
 * every surface — never "Top consensus — agreed by N models" — and nothing reconstructs the missing provider history.
 * F-2: a stored placeholder slot (INVALID_MOCK, the J02 fact) is never counted as an independent model in the supporters
 * scope either, and the stored support count is never presented as "agreed by N models" when one of those slots held
 * placeholder text.
 * Unchanged: runs whose every answered slot records its provider render exactly as before (the same object where the
 * module promises it); repeated recorded substitutes keep their "repeated_substitute" presentation.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u1" }, authReady: true }) }));
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", Link: "LINK", Image: "IMAGE", StyleSheet: { create: (s: unknown) => s }, Font: { register: () => undefined }, renderToBuffer: jest.fn() }));

import { readFileSync } from "fs";
import { join } from "path";
import { SCENARIOS } from "./o5pScenarios";
import { exportRecord, renderRecord } from "./o5pRender";
import {
  ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING,
  ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING,
  ADAPTIVE_PLACEHOLDER_TOP_HEADING,
  ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING,
  AGREE_HEADING_PLACEHOLDER,
  AGREE_HEADING_UNVERIFIED,
  adaptiveTopHeading,
  adaptiveTopIndependence,
  adaptiveTopIndependenceStatement,
  independenceQualification,
  placeholderSlotsClause,
  presentIndependenceQualifiedReport,
  qualifiedTopHeading,
  raisedByText,
  rowIndependence,
  runIndependence,
  topIndependencePresentation,
  unmarkedTopIndependence,
} from "@/lib/adaptiveSchema/verdictIndependence";
import { EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED, exportPositionSafeReport, exportRunIndependence } from "@/lib/adaptiveSchema/exportPositionView";
import { positionView, presentPositionSafeReport } from "@/lib/adaptiveSchema/positionPresentation";
import { STORED_PLACEHOLDER_LITERALS, runExecutionIdentity, withPlaceholderFact } from "@/lib/panel/executionIdentity";
import { runModelProvenanceFromResultRow, type RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";
import { SETS, rowsOf, type SetName } from "@/lib/panel/__tests__/executionIdentityScenarios";
import type { ModelResult } from "@/lib/types";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const scenarioRows = (name: string) => SCENARIOS.find((s) => s.name === name)!.results();

type Shape = "r5" | "legacy" | "marked";
const SHAPES: Shape[] = ["r5", "legacy", "marked"];
function shaped(name: string, shape: Shape) {
  const rec = clone(records[name]);
  if (shape === "legacy") delete rec.synthesisReport.presentation;
  if (shape === "marked") rec.synthesisReport.presentation.disagreementPositionVersion = 1;
  return rec;
}

/** Pre-6.2a / S3mn rows: the call status is recorded, the executing provider is not. */
const withoutProvider = (rows: ModelResult[]) => rows.map(({ provider: _p, ...r }) => r as ModelResult);
/** Rows whose provider is the live normalizer's placeholder, not a recorded provider. */
const unknownProvider = (rows: ModelResult[]) => rows.map((r) => ({ ...r, provider: "unknown" }) as ModelResult);
/** The facts ResultsDisplay's adaptive branch provides (J02 wiring). */
const factsOf = (rows: readonly ModelResult[]): RunModelProvenanceFacts[] => rows.map((r) => withPlaceholderFact(runModelProvenanceFromResultRow(r as any), r as any));
/** A stored placeholder row: status ok, its own provider recorded, the exact D-5 literal as text. */
const mockRow = (modelId: "chatgpt" | "claude"): ModelResult =>
  ({ modelId, status: "ok", rawText: STORED_PLACEHOLDER_LITERALS[modelId], provider: modelId === "chatgpt" ? "openai" : "anthropic", latencyMs: 0 }) as unknown as ModelResult;

/**
 * Facts as every real source records them (a result row, or a version-2 export entry): the recorded status and the
 * substitution it implies. `substituted` undefined → no status at all (a statusless row / a version-1 export entry).
 */
const f = (modelId: string, substituted?: boolean, provider?: string, extra: Partial<RunModelProvenanceFacts> = {}): RunModelProvenanceFacts => ({
  modelId,
  ...(substituted !== undefined ? { status: substituted ? "substituted" : "ok", substituted } : {}),
  ...(provider ? { provider } : {}),
  ...extra,
});
/** Version-1 export facts (Order 29 A2): `substituted` recorded, NO status — unknown to the gate, never upgraded. */
const v1 = (modelId: string, substituted: boolean, provider?: string): RunModelProvenanceFacts => ({ modelId, substituted, ...(provider ? { provider } : {}) });

const UI_KEYS = ["ui.synthesisView", "ui.panelResponse", "ui.primaryStrip"];
const AGREED_BY_MODELS = /agreed by \d+ model|— \d+ models?</;

// ─── F-1: the rule on its own ───────────────────────────────────────────────────────────────────────────────────────

describe("F-1: the shared verified-identity rule on the verdict surfaces (the rule on its own)", () => {
  const VERIFIED = [f("chatgpt", false, "openai"), f("claude", false, "anthropic"), f("grok", false, "xai")];

  it("version-1 export facts (substituted recorded, no outcome) are unknown: unverified in both scopes, with or without a provider (Order 29 A2)", () => {
    const frozenV1 = [v1("chatgpt", false, "openai"), v1("claude", true, "deepseek"), v1("grok", false, "xai")];
    expect(adaptiveTopIndependence(["chatgpt", "claude"], frozenV1)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(null, frozenV1)).toEqual({ kind: "unverified", scope: "run" });
    // Mixed: one version-1 entry beside recorded ones → unverified, never upgraded.
    expect(adaptiveTopIndependence(null, [VERIFIED[0], VERIFIED[1], v1("grok", false, "xai")])).toEqual({ kind: "unverified", scope: "run" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [VERIFIED[0], v1("claude", false, "anthropic")])).toEqual({ kind: "unverified", scope: "supporters" });
    // Only the recorded status counts; nothing is read from `substituted`.
    expect(adaptiveTopIndependence(null, [{ modelId: "chatgpt", status: "ok", provider: "openai" }, { modelId: "claude", status: "substituted", provider: "deepseek" }])).toEqual({ kind: "independent" });
  });

  it("pre-6.2a facts (status recorded, no provider): unverified in both scopes; nothing reconstructs the provider", () => {
    const pre62a = [f("chatgpt", false), f("claude", false), f("grok", false)];
    expect(adaptiveTopIndependence(["chatgpt", "claude"], pre62a)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(null, pre62a)).toEqual({ kind: "unverified", scope: "run" });
    expect(runIndependence(pre62a)).toEqual({ kind: "unverified", scope: "run" });
    expect(JSON.stringify(pre62a)).not.toContain("provider");
  });

  it("one considered slot without a recorded provider (ok or substituted), or with provider 'unknown', makes the statement unverified", () => {
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [f("chatgpt", false, "openai"), f("claude", false)])).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [f("chatgpt", false, "openai"), f("claude", true)])).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [f("chatgpt", false, "openai"), f("claude", true, "unknown")])).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [f("chatgpt", false, "openai"), f("claude", false, "  ")])).toEqual({ kind: "unverified", scope: "supporters" });
    // S3mn: a recorded substitute beside an unrecorded one is never merged into it by inference.
    expect(adaptiveTopIndependence(null, [f("chatgpt", true, "deepseek"), f("claude", true), f("grok", false, "xai")])).toEqual({ kind: "unverified", scope: "run" });
  });

  it("the slot's identity is judged only among the considered slots: an unverifiable slot outside the supporters does not qualify them", () => {
    const prov = [f("chatgpt", false, "openai"), f("claude", false), f("grok", false, "xai")];
    expect(adaptiveTopIndependence(["chatgpt", "grok"], prov)).toEqual({ kind: "independent" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], prov)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(null, prov)).toEqual({ kind: "unverified", scope: "run" });
  });

  it("a supporter with no facts row, a sentinel slot id, or a row without a recorded status → unverified", () => {
    expect(adaptiveTopIndependence(["chatgpt", "gemini"], VERIFIED)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "unknown"], VERIFIED)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "substitute:unknown"], VERIFIED)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [VERIFIED[0], f("claude", undefined, "anthropic")])).toEqual({ kind: "unverified", scope: "supporters" });
  });

  it("a slot that did not answer needs no provider (as on the result rows): a failed slot with no provider leaves a verified run verified, and is never a voice", () => {
    const failed: RunModelProvenanceFacts = { modelId: "gemini", status: "failed", substituted: false };
    expect(adaptiveTopIndependence(null, [...VERIFIED, failed])).toEqual({ kind: "independent" });
    for (const status of ["timeout", "error", "refused", "rate_limited"]) expect(adaptiveTopIndependence(null, [...VERIFIED, { modelId: "gemini", status, substituted: false }])).toEqual({ kind: "independent" });
    // A2: a recorded failure is excluded from the voices — a repeated substitute beside a failed slot names only the answering models.
    const collapsed = [f("chatgpt", true, "deepseek"), f("claude", true, "deepseek"), f("grok", false, "xai"), { modelId: "gemini", status: "timeout" } as RunModelProvenanceFacts];
    expect(adaptiveTopIndependence(null, collapsed)).toEqual({ kind: "repeated_substitute", scope: "run", voices: ["DeepSeek (substituting ChatGPT, Claude)", "Grok"], repeated: ["DeepSeek (substituting ChatGPT, Claude)"] });
    // Order 30 A2: a raising-slot list that names the failed slot is an inconsistent record — no count; the answering slots alone are counted.
    expect(raisedByText(["chatgpt", "claude", "grok", "gemini"], collapsed)).toBe("(raised by panel slots that include slots with no successful model response; model independence unverified)");
    expect(raisedByText(["chatgpt", "claude", "grok"], collapsed)).toBe("(raised by 3 panel slots, answered by 2 independent models: DeepSeek (substituting ChatGPT, Claude); Grok)");
    // Finding K=0 → IND: a stored claim whose supporters all recorded failures is never an independent consensus.
    // Order 30: with the reason (no successful response among them).
    expect(adaptiveTopIndependence(["chatgpt"], [{ modelId: "chatgpt", status: "timeout" }, ...VERIFIED])).toEqual({ kind: "unverified", scope: "supporters", basis: "no_responses" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [{ modelId: "chatgpt", status: "timeout" }, { modelId: "claude", status: "failed" }])).toEqual({ kind: "unverified", scope: "supporters", basis: "no_responses" });
    // Run scope with nothing answered and no stored claim joined renders as before (owner option (b): the all-failed
    // panel's 2c17feee oracle holds); the shared gate still reads that run as unverified (K = 0 is never IND).
    const allFailed = [{ modelId: "chatgpt", status: "timeout" }, { modelId: "claude", status: "failed" }];
    expect(adaptiveTopIndependence(null, allFailed)).toEqual({ kind: "independent" });
    expect(runIndependence(allFailed)).toBeNull();
    expect(runExecutionIdentity(allFailed.map((f) => ({ ...f, rawText: null })))).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 0 });
    // The same slot recorded as answered without a provider: unverified.
    expect(adaptiveTopIndependence(null, [...VERIFIED, { modelId: "gemini", status: "ok", substituted: false }])).toEqual({ kind: "unverified", scope: "run" });
  });

  it("verified independent providers: 'independent', the module's one frozen object (same identity on every call)", () => {
    const a = adaptiveTopIndependence(["chatgpt", "claude", "grok"], VERIFIED);
    const b = adaptiveTopIndependence(null, VERIFIED);
    expect(a).toEqual({ kind: "independent" });
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(runIndependence(VERIFIED)).toBeNull();
    expect(rowIndependence({ status: "consensus", cells: VERIFIED.map((x) => ({ modelId: x.modelId, stance: "agrees" })) }, VERIFIED)).toBeNull();
  });

  it("repeated substitutes with a recorded provider: unchanged 'repeated_substitute' presentation", () => {
    const prov = [f("chatgpt", true, "deepseek"), f("claude", true, "deepseek"), f("grok", false, "xai")];
    expect(adaptiveTopIndependence(["chatgpt", "claude", "grok"], prov)).toEqual({
      kind: "repeated_substitute",
      scope: "supporters",
      voices: ["DeepSeek (substituting ChatGPT, Claude)", "Grok"],
      repeated: ["DeepSeek (substituting ChatGPT, Claude)"],
    });
    expect(adaptiveTopIndependence(null, prov)).toMatchObject({ kind: "repeated_substitute", scope: "run" });
    expect(qualifiedTopHeading(adaptiveTopIndependence(["chatgpt", "claude", "grok"], prov) as any, "consensus")).toBe("Top consensus (2 independent models; a substitute model that answered several slots counted once)");
  });

  it("differential with the shared gate: over every C-a row set, the run scope is 'unverified' exactly when runExecutionIdentity(rows) is not verified", () => {
    // S6 (no rows at all) is the RunModelProvenanceContext contract — nothing inferred, rendered as before — not a gate case.
    for (const name of Object.keys(SETS).filter((n) => n !== "S6") as SetName[]) {
      const rows = rowsOf(name);
      const identity = runExecutionIdentity(rows);
      const t = adaptiveTopIndependence(null, factsOf(rows));
      expect([name, t.kind === "unverified"]).toEqual([name, !identity.verified]);
      // A verified run with stored placeholders is qualified on both sides (never presented as a clean independent run).
      if (identity.verified) expect([name, t.kind === "placeholder"]).toEqual([name, identity.placeholderSlots.length > 0]);
    }
  });
});

// ─── F-2: stored placeholder slots ──────────────────────────────────────────────────────────────────────────────────

describe("F-2: a stored placeholder slot is never an independent model on the top-claim surfaces", () => {
  const CLAUDE = f("claude", false, "anthropic");
  const GROK = f("grok", false, "xai");
  const MOCK = f("chatgpt", false, "openai", { invalidProviderOutput: true });

  it("mixed valid + placeholder supporters: the placeholder is excluded from the voices and the statement is never 'independent'", () => {
    const t = adaptiveTopIndependence(["chatgpt", "claude", "grok"], [MOCK, CLAUDE, GROK]);
    expect(t).toEqual({ kind: "placeholder", scope: "supporters", voices: ["Claude", "Grok"], placeholders: ["chatgpt"] });
    expect(qualifiedTopHeading(t as any, "consensus")).toBe("Top consensus (2 independent models; stored placeholder text set aside)");
    expect(qualifiedTopHeading(t as any, "majority")).toBe("Top majority-supported claim (2 independent models; stored placeholder text set aside)");
    expect(adaptiveTopIndependenceStatement(t, 3)).toBe("Recorded as supported by 3 panel slots, answered by 2 independent models: Claude; Grok. 1 panel slot held stored placeholder text (not a model response) and is not counted.");
  });

  it("a placeholder beside one real model, or alone: never a consensus heading; the voices never include the placeholder slot", () => {
    const one = adaptiveTopIndependence(["chatgpt", "claude"], [MOCK, CLAUDE, GROK]);
    expect(one).toEqual({ kind: "placeholder", scope: "supporters", voices: ["Claude"], placeholders: ["chatgpt"] });
    expect(qualifiedTopHeading(one as any, "consensus")).toBe(ADAPTIVE_PLACEHOLDER_TOP_HEADING);
    const alone = adaptiveTopIndependence(["chatgpt"], [MOCK, CLAUDE, GROK]);
    expect(alone).toEqual({ kind: "placeholder", scope: "supporters", voices: [], placeholders: ["chatgpt"] });
    expect(adaptiveTopIndependenceStatement(alone, 1)).toBe("Recorded as supported by 1 panel slot, answered by 0 independent models. 1 panel slot held stored placeholder text (not a model response) and is not counted.");
    expect(placeholderSlotsClause(2)).toBe("2 panel slots held stored placeholder text (not a model response)");
  });

  it("placeholder + repeated recorded substitutes: the substitutes' presentation, with the placeholder in no voice", () => {
    const prov = [MOCK, f("claude", true, "deepseek"), f("grok", true, "deepseek")];
    const t = adaptiveTopIndependence(["chatgpt", "claude", "grok"], prov);
    expect(t).toEqual({ kind: "repeated_substitute", scope: "supporters", voices: ["DeepSeek (substituting Claude, Grok)"], repeated: ["DeepSeek (substituting Claude, Grok)"] });
  });

  it("placeholder + an unverifiable slot: unverified (the gate decides first)", () => {
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [MOCK, f("claude", false)])).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], [MOCK, f("claude", true, "unknown")])).toEqual({ kind: "unverified", scope: "supporters" });
  });

  it("run scope (J02 + the shared rule): the placeholder slot is never a run-scope voice, and its presence qualifies the run (never a clean independent run)", () => {
    expect(adaptiveTopIndependence(null, [MOCK, CLAUDE, GROK])).toEqual({ kind: "placeholder", scope: "run", voices: ["Claude", "Grok"], placeholders: ["chatgpt"] });
    expect(runIndependence([MOCK, CLAUDE, GROK])).toEqual({ kind: "placeholder", scope: "run", voices: ["Claude", "Grok"], placeholders: ["chatgpt"] });
    expect(runIndependence([MOCK, f("claude", true, "deepseek"), f("grok", true, "deepseek")])).toEqual({ kind: "repeated_substitute", scope: "run", voices: ["DeepSeek (substituting Claude, Grok)"], repeated: ["DeepSeek (substituting Claude, Grok)"] });
    // A run-scope judgement is never headed as a consensus, and its heading says the run's slots, not "the supporting slots" (m-2).
    expect(qualifiedTopHeading(runIndependence([MOCK, CLAUDE, GROK])!, "consensus")).toBe(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING);
    expect(adaptiveTopHeading(runIndependence([MOCK, CLAUDE, GROK])!)).toBe(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING);
    expect(adaptiveTopHeading(adaptiveTopIndependence(["chatgpt", "claude"], [MOCK, CLAUDE, GROK]))).toBe(ADAPTIVE_PLACEHOLDER_TOP_HEADING);
    expect(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING).not.toContain("supporting");
    expect(adaptiveTopIndependenceStatement(runIndependence([MOCK, CLAUDE, GROK])!, null)).toBe("The slots of this run were answered by 2 independent models: Claude; Grok. 1 panel slot held stored placeholder text (not a model response) and is not counted.");
    expect(adaptiveTopIndependenceStatement(adaptiveTopIndependence(["chatgpt", "claude", "grok"], [MOCK, CLAUDE, GROK]), null)).toBe("Supporting slots answered by 2 independent models: Claude; Grok. 1 panel slot held stored placeholder text (not a model response) and is not counted.");
  });

  it("the J02 fact is the only placeholder marker a facts row carries: the same slot without it is a genuine independent row", () => {
    expect(adaptiveTopIndependence(["chatgpt", "claude", "grok"], [f("chatgpt", false, "openai"), CLAUDE, GROK])).toEqual({ kind: "independent" });
    // Facts built from a real placeholder row through the shared oracle carry the fact.
    const facts = factsOf([mockRow("chatgpt"), { modelId: "claude", status: "ok", rawText: "Paris.", provider: "anthropic" } as any, { modelId: "grok", status: "ok", rawText: "Paris.", provider: "xai" } as any]);
    expect(facts[0].invalidProviderOutput).toBe(true);
    expect(adaptiveTopIndependence(["chatgpt", "claude", "grok"], facts)).toMatchObject({ kind: "placeholder", voices: ["Claude", "Grok"], placeholders: ["chatgpt"] });
  });

  it("row statements: the placeholder slot is on no side's voices and never 'on both sides'", () => {
    const row = { status: "split", cells: [{ modelId: "chatgpt", stance: "agrees" }, { modelId: "claude", stance: "agrees" }, { modelId: "grok", stance: "disputes" }] };
    const ri = rowIndependence(row, [MOCK, CLAUDE, GROK])!;
    expect(ri.t).toEqual({ kind: "placeholder", scope: "supporters", voices: ["Claude", "Grok"], placeholders: ["chatgpt"] });
    expect(ri.supportVoices).toEqual(["Claude"]);
    expect(ri.disputeVoices).toEqual(["Grok"]);
    expect(ri.bothSides).toEqual([]);
    expect(raisedByText(["chatgpt", "claude", "grok"], [MOCK, CLAUDE, GROK])).toBe("(raised by 3 panel slots, answered by 2 independent models: Claude; Grok)");
  });
});

// ─── F-1 on every surface: the historical fixtures without a recorded provider ──────────────────────────────────────

describe("F-1 on every surface: historical adaptive fixtures recorded without an executing provider", () => {
  const CASES: [string, (rows: ModelResult[]) => ModelResult[]][] = [
    ["no provider recorded (pre-6.2a)", withoutProvider],
    ["provider recorded as 'unknown'", unknownProvider],
  ];

  it.each(CASES)("%s — UI: qualified as unverified, no 'Top consensus' / 'agreed by N models' / 'Models agree — N models'", async (_n, shapeRows) => {
    for (const shape of SHAPES) {
      const out = await renderRecord(shaped("generic-consensus", shape), shapeRows(scenarioRows("generic-consensus")));
      for (const k of UI_KEYS) {
        const html = out[k]!;
        // The strip is rendered without the stored rows: a marked report derives no position there (Contract P), so only an unmarked strip heads the top claim.
        if (!(shape === "marked" && k === "ui.primaryStrip")) expect([shape, k, html.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([shape, k, true]);
        expect([shape, k, html.includes(">Top consensus<")]).toEqual([shape, k, false]);
        expect([shape, k, html.includes(">Models agree<")]).toEqual([shape, k, false]);
        expect([shape, k, AGREED_BY_MODELS.test(html)]).toEqual([shape, k, false]);
        expect([shape, k, html.includes("substituting")]).toEqual([shape, k, false]);
        expect([shape, k, /\d+ independent model/.test(html)]).toEqual([shape, k, false]);
      }
      if (shape !== "marked") {
        expect([shape, out["ui.synthesisView"]!.includes(AGREE_HEADING_UNVERIFIED)]).toEqual([shape, true]);
        expect([shape, out["ui.synthesisView"]!.includes(">Where models agree<")]).toEqual([shape, false]);
      }
    }
  }, 120_000);

  it.each(CASES)("%s — text and memo: the top claim's independence is stated as unverified; the memo withholds the score", async (_n, shapeRows) => {
    for (const shape of SHAPES) {
      const out = await renderRecord(shaped("generic-consensus", shape), shapeRows(scenarioRows("generic-consensus")));
      expect([shape, out["text.markdown"]!.includes("**Model independence:** Model independence unverified:")]).toEqual([shape, true]);
      expect([shape, /Top consensus:/.test(out["text.markdown"]!)]).toEqual([shape, false]);
      if (shape !== "marked") {
        expect([shape, out["text.memo"]!.includes("CONSENSUS SCORE: withheld (model independence not recorded)")]).toEqual([shape, true]);
        expect([shape, out["text.memo"]!.includes("5 AI models researched")]).toEqual([shape, false]);
      }
    }
  }, 120_000);

  it.each(CASES)("%s — PDF and DOCX (exportPositionView): the verdict section and top heading are qualified as unverified", async (_n, shapeRows) => {
    for (const shape of SHAPES) {
      const rec = shaped("generic-consensus", shape);
      const rows = shapeRows(scenarioRows("generic-consensus"));
      const out = await renderRecord(rec, rows);
      for (const k of ["export.pdfTree", "export.docxXml"]) {
        expect([shape, k, out[k]!.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING)]).toEqual([shape, k, true]);
        expect([shape, k, /Top consensus(?! \()/.test(out[k]!)]).toEqual([shape, k, false]);
        expect([shape, k, out[k]!.includes("agreed by")]).toEqual([shape, k, false]);
      }
      const record = exportRecord(rec, rows, "pdf")!;
      expect([shape, exportRunIndependence(record)]).toEqual([shape, { kind: "unverified", scope: "run" }]);
      const { view, independence } = exportPositionSafeReport(record);
      if (shape === "marked") {
        expect([shape, view?.verdict.topIndependence]).toEqual([shape, { kind: "unverified", scope: "supporters" }]);
        expect([shape, view?.verdict.topHeading]).toEqual([shape, ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING]);
      } else {
        expect([shape, independence]).toEqual([shape, { sectionHeading: EXPORT_VERDICT_SECTION_INDEPENDENCE_UNVERIFIED, topHeading: ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING }]);
      }
    }
  }, 120_000);

  it("stored values are not rewritten by any surface", async () => {
    const rec = shaped("generic-consensus", "r5");
    const before = JSON.stringify(rec);
    await renderRecord(rec, withoutProvider(scenarioRows("generic-consensus")));
    expect(JSON.stringify(rec)).toBe(before);
    expect(rec.synthesisReport.verdictCard.consensusModelCount).toBe(5);
  }, 60_000);

  it("the same record with every provider recorded renders as before: no qualification, the stored report object itself", async () => {
    const rows = scenarioRows("generic-consensus");
    const out = await renderRecord(shaped("generic-consensus", "r5"), rows);
    for (const [k, v] of Object.entries(out)) {
      if (!v) continue;
      expect([k, v.includes(ADAPTIVE_INDEPENDENCE_UNVERIFIED_TOP_HEADING) || v.includes(ADAPTIVE_REPEATED_SUBSTITUTE_TOP_HEADING) || v.includes(ADAPTIVE_PLACEHOLDER_TOP_HEADING) || v.includes(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING) || v.includes("Model independence")]).toEqual([k, false]);
    }
    const report = shaped("generic-consensus", "r5").synthesisReport;
    expect(presentIndependenceQualifiedReport(report, { rows: records["generic-consensus"].alignedClaims, provenance: factsOf(rows) })).toBe(report);
    expect(independenceQualification(report)).toBeNull();
    expect(exportRunIndependence(exportRecord(shaped("generic-consensus", "r5"), rows, "pdf")!)).toBeNull();
  }, 60_000);
});

// ─── F-2 on the verdict card / strip / report: a stored placeholder among the supporting slots ──────────────────────

describe("F-2 on the surfaces: a placeholder slot among the top claim's supporters", () => {
  const placeholderRows = (rows: ModelResult[]) => rows.map((r) => (r.modelId === "chatgpt" ? mockRow("chatgpt") : r));

  it("unmarked and marked: never 'agreed by 5 models'; the placeholder slot is set aside and the remaining models are counted", async () => {
    const rows = placeholderRows(scenarioRows("generic-consensus"));
    const provenance = factsOf(rows);
    expect(provenance.find((p) => p.modelId === "chatgpt")?.invalidProviderOutput).toBe(true);
    for (const shape of SHAPES) {
      const out = await renderRecord(shaped("generic-consensus", shape), rows, { provenance });
      for (const k of UI_KEYS) {
        const html = out[k]!;
        expect([shape, k, AGREED_BY_MODELS.test(html)]).toEqual([shape, k, false]);
        expect([shape, k, html.includes(">Top consensus<")]).toEqual([shape, k, false]);
        expect([shape, k, html.includes(">Models agree<")]).toEqual([shape, k, false]);
        expect([shape, k, html.includes("5 independent model")]).toEqual([shape, k, false]);
        // With the stored rows (report view, panel response) the top row's supporters are judged; the strip is rendered
        // without them and judges the run (an unmarked report) or derives no position (a marked one).
        if (k !== "ui.primaryStrip") expect([shape, k, html.includes("Top consensus (4 independent models; stored placeholder text set aside)")]).toEqual([shape, k, true]);
        else if (shape !== "marked") {
          // The strip judges the run (m-2): the run-scope heading, never the supporters wording.
          expect([shape, k, html.includes(ADAPTIVE_PLACEHOLDER_RUN_TOP_HEADING)]).toEqual([shape, k, true]);
          expect([shape, k, html.includes("among the supporting slots")]).toEqual([shape, k, false]);
        }
      }
      expect([shape, out["ui.synthesisView"]!.includes(placeholderSlotsClause(1))]).toEqual([shape, true]);
      expect([shape, out["text.markdown"]!.includes(placeholderSlotsClause(1))]).toEqual([shape, true]);
      expect([shape, out["text.markdown"]!.includes("agreed by 5")]).toEqual([shape, false]);
      if (shape !== "marked") {
        // m-3: the unmarked memo is told the independent executing models once the placeholder slot is set aside (4, never the 5 dispatched slots).
        expect([shape, JSON.parse(out["text.memoInput"]!).independentModelCount]).toEqual([shape, 4]);
        expect([shape, out["text.memo"]!.includes("4 AI models researched this question independently.")]).toEqual([shape, true]);
        expect([shape, out["text.memo"]!.includes("5 AI models researched")]).toEqual([shape, false]);
      }
    }
  }, 120_000);

  it("m-3: with one real model left beside the placeholder slots, the unmarked memo reports no consensus (count 1), never the dispatched-slot count", async () => {
    const rows = scenarioRows("generic-consensus").map((r) => (r.modelId === "chatgpt" ? mockRow("chatgpt") : r.modelId === "claude" ? mockRow("claude") : r.modelId === "grok" ? ({ ...r, status: "failed", rawText: null } as ModelResult) : r.modelId === "perplexity" ? ({ ...r, status: "failed", rawText: null } as ModelResult) : r));
    const provenance = factsOf(rows);
    const out = await renderRecord(shaped("generic-consensus", "r5"), rows, { provenance });
    expect(JSON.parse(out["text.memoInput"]!).independentModelCount).toBe(1);
    expect(out["text.memo"]).toContain("CONSENSUS SCORE: none (fewer than two independent models responded");
    expect(out["text.memo"]).not.toContain("5 AI models researched");
  }, 60_000);

  it("the qualified view of the unmarked report heads 'Where models agree' for the placeholder case and keeps the stored object untouched", () => {
    const rec = shaped("generic-consensus", "r5");
    const provenance = factsOf(placeholderRows(scenarioRows("generic-consensus")));
    const before = JSON.stringify(rec.synthesisReport);
    const view = presentIndependenceQualifiedReport(rec.synthesisReport, { rows: rec.alignedClaims, provenance });
    const q = independenceQualification(view)!;
    expect(view).not.toBe(rec.synthesisReport);
    expect(JSON.stringify(rec.synthesisReport)).toBe(before);
    expect(q.run).toEqual({ kind: "placeholder", scope: "run", voices: ["Claude", "Grok", "Perplexity", "Gemini"], placeholders: ["chatgpt"] });
    expect(q.top).toMatchObject({ kind: "placeholder", scope: "supporters", placeholders: ["chatgpt"] });
    expect(q.agreeHeading).toBe(AGREE_HEADING_PLACEHOLDER);
    expect(unmarkedTopIndependence(rec.synthesisReport.verdictCard, rec.alignedClaims, provenance)).toMatchObject({ kind: "placeholder", placeholders: ["chatgpt"] });
    const card = topIndependencePresentation(view, null, rec.alignedClaims, provenance)!;
    expect(card.heading).toBe("Top consensus (4 independent models; stored placeholder text set aside)");
    // The card's result line already states the executing models (topResultQualified), so no separate statement repeats it.
    expect(card.statement).toBeNull();
    expect((view as any).verdictCard.topConsensusAgreement).toContain(placeholderSlotsClause(1));
    const marked = positionView(presentPositionSafeReport(shaped("generic-consensus", "marked").synthesisReport, { rows: rec.alignedClaims, roster: rec.results.map((r: any) => r.modelId), provenance }))!;
    expect(marked.verdict.topIndependence).toMatchObject({ kind: "placeholder", placeholders: ["chatgpt"] });
    expect(marked.verdict.topHeading).toBe("Top consensus (4 independent models; stored placeholder text set aside)");
  });
});
