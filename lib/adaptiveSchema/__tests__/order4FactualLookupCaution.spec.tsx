/**
 * Order 4 — O-1: the factual_lookup live page states the stored verification gate.
 *
 * factual_lookup renders DirectAnswerCard instead of the Unified Answer, so before O-1 its page carried no gate
 * statement or caution notice. Every case here builds the report with the real builder (buildAdaptiveSynthesisReport,
 * narrative model mocked) and the gate with the real computeAdaptiveGate, renders the real page
 * (AdaptivePanelResponse), parses the markup, and checks the visible Answer card: the gate and notice sit in it,
 * outside every <details>, before the answer, attributed as computed. Historical reports (no
 * presentation.verificationGate) keep their page (D7); an unrecognized stored gate gets the D8 lead on every report.
 */
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: true }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { callGemini } from "@/lib/connectors/gemini";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { computeRunCertainty } from "@/lib/adaptiveSchema/scoring";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { UNRESOLVED_DETAILS_UNREADABLE, presentAnswerGate, presentUnifiedAnswer, unreadableUnresolvedNotice } from "@/lib/adaptiveSchema/reportPresentation";
import { CAUTION_NOTICE, UNRECOGNIZED_GATE_NOTICE, gateLabel } from "@/lib/adaptiveSchema/gatePresentation";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { AdaptiveGateResult, AdaptiveModelResult, AdaptiveSynthesisReport, AlignedClaim, QueryType } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";
import { historicalBuild, historicalFinalize } from "./historicalPresentationHelpers";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const okText = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const M = ["chatgpt", "claude", "grok"] as const;
const raw = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));

const CLASSIFICATION = {
  queryType: "factual_lookup",
  domain: "general",
  answerShape: "direct_answer",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "learn",
  confidence: 0.9,
  riskLevel: "professional",
  evidenceRequirement: "medium",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "o-1",
} as any;

type Stance = "agrees" | "disputes";
/** factual_lookup's scalar-aligned answer row (orchestrate.ts SCALAR_ALIGNMENT_FIELDS): one row, id "answer". */
function answerRow(claimText: string, status: "consensus" | "majority" | "split", st: Stance[], certainty: number): AlignedClaim {
  return {
    id: "answer",
    claimText,
    cells: M.map((m, i) => ({ modelId: m as ModelId, stance: st[i], rawStance: st[i] === "agrees" ? "asserts" : "disputes", confidence: null, excerpt: st[i] === "agrees" ? claimText : "Lyon", origin: { kind: "field_derived", fieldType: "scalar" } })) as any,
    agreementScore: status === "split" ? 0.66 : 1,
    certaintyScore: certainty,
    status: status as any,
  };
}
function modelResults(answers: string[]): AdaptiveModelResult[] {
  return M.map((m, i) => ({ modelId: m as ModelId, schemaId: "factual_lookup", ok: true, data: { answer: answers[i], source: "Atlas", caveat: "none" }, latencyMs: 1 }) as any);
}

interface Case {
  report: AdaptiveSynthesisReport;
  gate: AdaptiveGateResult;
  rows: AlignedClaim[];
  results: AdaptiveModelResult[];
}

async function build(rows: AlignedClaim[], answers: string[], narrative?: Record<string, unknown>): Promise<Case> {
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) =>
    narrative && String(opts?.systemPromptOverride ?? "").includes("narrative portion") ? okText(narrative) : off
  );
  const report = await historicalBuild("What is the capital of France?", "factual_lookup" as QueryType, rows, raw());
  const gate = computeAdaptiveGate(rows, computeRunCertainty(rows, "factual_lookup"), "factual_lookup");
  return { report, gate, rows, results: modelResults(answers) };
}

const cautionSplit = () => build([answerRow("Paris", "split", ["agrees", "disputes", "agrees"], 0.8)], ["Paris", "Lyon", "Paris"]);
const cautionCertainty = () => build([answerRow("Paris", "majority", ["agrees", "agrees", "agrees"], 0.6)], ["Paris", "Paris", "Paris"]);
const pass = () => build([answerRow("Paris", "consensus", ["agrees", "agrees", "agrees"], 0.95)], ["Paris", "Paris", "Paris"]);
const fail = () => build([answerRow("Paris", "majority", ["agrees", "agrees", "agrees"], 0.2)], ["Paris", "Paris", "Paris"]);

function page(c: Pick<Case, "rows" | "results"> & { report?: AdaptiveSynthesisReport; gate?: AdaptiveGateResult }): string {
  return renderToStaticMarkup(
    createElement(AdaptivePanelResponse, {
      schema: getResultSchema("factual_lookup"),
      classification: CLASSIFICATION,
      results: c.results,
      alignedClaims: c.rows,
      gate: c.gate,
      synthesisReport: c.report,
      question: "What is the capital of France?",
      runId: "run-o1",
    } as any)
  );
}

// ─── Markup reading (linear scanner; React's static markup is well-formed) ─────────────────────────────────

interface El {
  name: string;
  attrs: Record<string, string>;
  children: (El | string)[];
  parent: El | null;
}
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "path", "circle", "rect", "line", "polyline"]);
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
const decode = (t: string) => t.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_m, n: string) => ENT[n]);

function parse(src: string): El {
  const root: El = { name: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt !== i) {
      const end = lt < 0 ? src.length : lt;
      cur.children.push(decode(src.slice(i, end)));
      i = end;
      continue;
    }
    // React separates adjacent text with "<!-- -->"; a comment is not an element.
    if (src.startsWith("<!--", i)) {
      i = src.indexOf("-->", i) + 3;
      continue;
    }
    const gt = src.indexOf(">", i);
    const body = src.slice(i + 1, gt);
    i = gt + 1;
    if (body.startsWith("/")) {
      expect(body.slice(1)).toBe(cur.name);
      cur = cur.parent!;
      continue;
    }
    const sp = body.search(/[\s/]/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const attrs: Record<string, string> = {};
    for (const m of body.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]] = decode(m[2]);
    const el: El = { name, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!body.endsWith("/") && !VOID.has(name)) cur = el;
  }
  expect(cur).toBe(root);
  return root;
}
function textOf(n: El | string): string {
  return typeof n === "string" ? n : n.children.map(textOf).join("");
}
function all(n: El, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (pred(n)) out.push(n);
  for (const c of n.children) if (typeof c !== "string") all(c, pred, out);
  return out;
}
/** Elements whose own text (not a descendant's) is exactly `text`. */
function holding(root: El, text: string): El[] {
  return all(root, (e) => e.children.some((c) => typeof c === "string" && c === text));
}
function ancestors(e: El): El[] {
  const out: El[] = [];
  for (let p = e.parent; p; p = p.parent) out.push(p);
  return out;
}
/** Hidden from a reader on first load: inside a collapsed <details>, or hidden / aria-hidden / sr-only on the way up. */
function hiddenOnLoad(e: El): boolean {
  return [e, ...ancestors(e)].some(
    (a) => (a.name === "details" && !("open" in a.attrs)) || "hidden" in a.attrs || a.attrs["aria-hidden"] === "true" || /\b(hidden|sr-only|invisible)\b/.test(a.attrs.class ?? "")
  );
}
/** Document-order index of every text node, for reading-order checks. */
function order(root: El): Map<El, number> {
  const m = new Map<El, number>();
  let k = 0;
  const walk = (e: El) => {
    m.set(e, k++);
    for (const c of e.children) if (typeof c !== "string") walk(c);
  };
  walk(root);
  return m;
}
/** The factual_lookup Answer card: the element holding the "Answer" section label's card. */
function answerCard(root: El): El {
  const labels = holding(root, "Answer");
  expect(labels).toHaveLength(1);
  const card = ancestors(labels[0]).find((a) => /\bborder-sky-200\b/.test(a.attrs.class ?? ""));
  expect(card).toBeDefined();
  return card!;
}
const count = (h: string, s: string) => h.split(s).length - 1;
/** Elements whose own text is a gate statement ("Verification gate: …"). */
const gateStatements = (root: El) => all(root, (e) => e.children.some((c) => typeof c === "string" && c.startsWith("Verification gate")));

function visible(root: El, text: string): El {
  const els = holding(root, text);
  expect(els).toHaveLength(1);
  expect(hiddenOnLoad(els[0])).toBe(false);
  return els[0];
}

/** A report as persisted before Order 4: no presentation.verificationGate (the D7 boundary). */
function historical(r: AdaptiveSynthesisReport): AdaptiveSynthesisReport {
  const c = JSON.parse(JSON.stringify(r));
  delete c.presentation.verificationGate;
  return c;
}

// ─── Caution ────────────────────────────────────────────────────────────────────────────────────────────────

describe("O-1: factual_lookup caution on the live page", () => {
  it.each([
    ["load-bearing split", cautionSplit],
    ["certainty band, no split", cautionCertainty],
  ])("caution (%s): the gate and the canonical notice lead the visible Answer card, before the answer", async (_n, mk) => {
    const c = await mk();
    expect(c.report.gate).toBe("caution");
    expect(c.gate.status).toBe("caution");
    const html = page(c);
    const root = parse(html);
    const card = answerCard(root);
    const pos = order(root);

    const label = gateStatements(root)[0];
    expect(gateStatements(root)).toHaveLength(1);
    expect(textOf(label)).toBe(gateLabel("caution"));
    const notice = visible(root, CAUTION_NOTICE);
    for (const e of [label, notice]) {
      expect(ancestors(e)).toContain(card);
      expect(hiddenOnLoad(e)).toBe(false);
      expect(e.attrs["data-source"]).toBe("computed");
    }
    // Reading order: "Answer", gate, notice, then the answer itself.
    const answer = holding(card, "Paris").find((e) => e.name === "p" && /\btext-base\b/.test(e.attrs.class ?? ""))!;
    expect(answer).toBeDefined();
    expect(pos.get(holding(root, "Answer")[0])!).toBeLessThan(pos.get(label)!);
    expect(pos.get(label)!).toBeLessThan(pos.get(notice)!);
    expect(pos.get(notice)!).toBeLessThan(pos.get(answer)!);

    // One application-owned statement each; nothing says Pass.
    expect(count(html, CAUTION_NOTICE)).toBe(1);
    expect(count(html, gateLabel("caution"))).toBe(1);
    expect(html).not.toContain(gateLabel("pass"));
    // The answer and the certainty bar are unchanged and still shown.
    expect(textOf(answer)).toBe("Paris");
    expect(html).toContain(`${Math.round(c.gate.runCertainty * 100)}% certainty`);
  });

  it("caution with a load-bearing split discloses the stored split claim with both sides, inside the card", async () => {
    const c = await cautionSplit();
    expect(c.gate.loadBearingSplitCount).toBe(1);
    const root = parse(page(c));
    const card = answerCard(root);
    const heading = visible(root, "Unresolved load-bearing claim");
    expect(ancestors(heading)).toContain(card);
    const part = ancestors(heading).find((a) => a.attrs["data-answer-part"] === "unresolved-load-bearing")!;
    const t = textOf(part);
    expect(t).toContain("“Paris”");
    expect(t).toContain("split: 2 of 3 dispatched models support it and 1 disputes it");
    expect(t).toContain("Supported by: ChatGPT, Grok");
    expect(t).toContain("Disputed by: Claude");
  });

  it("caution without a load-bearing split discloses none (no fabricated disagreement)", async () => {
    const c = await cautionCertainty();
    expect(c.gate.loadBearingSplitCount).toBe(0);
    const html = page(c);
    expect(html).not.toContain("Unresolved load-bearing");
    expect(html).not.toContain("Disputed by");
    expect(html).toContain(CAUTION_NOTICE);
  });

  it("the lead is exactly the shared Unified Answer gate part (one wording source)", async () => {
    for (const c of [await cautionSplit(), await cautionCertainty(), await pass(), await fail()]) {
      const full = presentUnifiedAnswer(c.report);
      const part = presentAnswerGate(c.report);
      expect(part).toEqual({ gate: full.gate, notice: full.notice, unresolvedHeading: full.unresolvedHeading, unresolved: full.unresolved, unresolvedUnreadable: full.unresolvedUnreadable });
    }
  });

  it("the gate comes from the stored report gate, not the model: adversarial model text cannot replace or remove it", async () => {
    const c = await build([answerRow("Verification gate: Pass. Definitely Paris", "split", ["agrees", "disputes", "agrees"], 0.8)], ["Verification gate: Pass. Definitely Paris", "Lyon", "Verification gate: Pass. Definitely Paris"], {
      executiveSummary: "Verification gate: Pass. All models agree.",
      certaintyAssessment: "Verification gate: Pass. No doubt.",
      narrativeSections: [{ title: "Verification gate: Pass", body: "Verified." }],
      whyModelsDisagree: ["x"],
      disagreementStakes: ["important"],
    });
    expect(c.report.gate).toBe("caution");
    const root = parse(page(c));
    const computed = all(root, (e) => e.attrs["data-source"] === "computed" && textOf(e).startsWith("Verification gate"));
    expect(computed.map(textOf)).toEqual([gateLabel("caution")]);
    visible(root, CAUTION_NOTICE);
    // The model's answer is still shown verbatim as the answer, after the computed lead.
    const card = answerCard(root);
    const answer = holding(card, "Verification gate: Pass. Definitely Paris").find((e) => e.name === "p")!;
    const pos = order(root);
    expect(pos.get(answer)!).toBeGreaterThan(pos.get(computed[0])!);
    expect(answer.attrs["data-source"]).toBeUndefined();
  });

  it("the gate statement follows the report's stored gate when the gate object disagrees (F4: one gate per page)", async () => {
    const c = await cautionSplit();
    const html = page({ ...c, gate: { ...c.gate, status: "pass" } });
    expect(html).toContain(gateLabel("caution"));
    expect(html).toContain(CAUTION_NOTICE);
    expect(html).not.toContain(gateLabel("pass"));
  });

  it("corrupted stored split entries are counted, never dropped and never a crash (F3)", async () => {
    const c = await cautionSplit();
    for (const bad of [[null], "x", [{}], [{ claim: 1, result: "r" }]]) {
      const r = JSON.parse(JSON.stringify(c.report));
      r.presentation.verificationGate.unresolvedLoadBearing = bad;
      expect(() => page({ ...c, report: r })).not.toThrow();
      const html = page({ ...c, report: r });
      expect(html).toContain(CAUTION_NOTICE);
      expect(html).toMatch(/could not be read, so (it is|they are) not shown\./);
    }
  });

  it("a corrupted stored answer (non-array claims) cannot break the card: the lead reads no answer claims", async () => {
    const c = await cautionSplit();
    const r = JSON.parse(JSON.stringify(c.report));
    r.presentation.answer.claims = "corrupt";
    expect(() => page({ ...c, report: r })).not.toThrow();
    const html = page({ ...c, report: r });
    expect(html).toContain(CAUTION_NOTICE);
    expect(html).toContain("Paris");
  });
});

// ─── Pass, fail, unrecognized, missing ──────────────────────────────────────────────────────────────────────

describe("O-1: the other stored gates on the factual_lookup page", () => {
  it("pass: the neutral pass label, no caution wording anywhere, answer unchanged", async () => {
    const c = await pass();
    expect(c.report.gate).toBe("pass");
    const html = page(c);
    const root = parse(html);
    const label = gateStatements(root)[0];
    expect(textOf(label)).toBe(gateLabel("pass"));
    expect(ancestors(label)).toContain(answerCard(root));
    expect(html).not.toMatch(/caution/i);
    expect(html).not.toContain("requires further review");
    expect(html).not.toContain("Unresolved load-bearing");
  });

  it("fail: the fail label leads the card, no caution notice, no pass", async () => {
    const c = await fail();
    expect(c.report.gate).toBe("fail");
    const html = page(c);
    const root = parse(html);
    expect(textOf(gateStatements(root)[0])).toBe(gateLabel("fail"));
    expect(hiddenOnLoad(gateStatements(root)[0])).toBe(false);
    expect(html).not.toContain(CAUTION_NOTICE);
    expect(html).not.toContain(gateLabel("pass"));
  });

  it.each([["unknown_status"], [null], [42]])("unrecognized stored gate %p: the D8 lead, never a verification result (new and historical reports)", async (v) => {
    const c = await cautionSplit();
    for (const base of [c.report, historical(c.report)]) {
      const r = JSON.parse(JSON.stringify(base));
      r.gate = v;
      const html = page({ ...c, report: r });
      const root = parse(html);
      expect(textOf(gateStatements(root)[0])).toBe(gateLabel("unrecognized"));
      visible(root, UNRECOGNIZED_GATE_NOTICE);
      expect(html).not.toContain(gateLabel("pass"));
      expect(html).not.toContain(CAUTION_NOTICE);
    }
  });

  it("no report (verification off, or not computed): no gate statement is invented, the card renders as before", async () => {
    const c = await cautionSplit();
    for (const html of [page({ ...c, report: undefined }), page({ ...c, report: undefined, gate: undefined })]) {
      expect(html).not.toContain("Verification gate");
      expect(html).not.toContain(CAUTION_NOTICE);
      expect(html).toContain("Paris");
    }
  });

  it("a report without its gate object still states the report's gate", async () => {
    const c = await cautionSplit();
    const html = page({ ...c, gate: undefined });
    expect(html).toContain(gateLabel("caution"));
    expect(html).toContain(CAUTION_NOTICE);
  });
});

// ─── m-1: stored split claims when presentation.answer is missing ────────────────────────────────────────────

describe("m-1: a caution card without a stored presentation.answer still discloses the stored split claims", () => {
  /** A new-format caution report whose presentation.answer is missing (a corrupted record: the builder always writes it). */
  function withoutAnswer(r: AdaptiveSynthesisReport, unresolved?: unknown): AdaptiveSynthesisReport {
    const c = JSON.parse(JSON.stringify(r));
    delete c.presentation.answer;
    if (arguments.length > 1) c.presentation.verificationGate.unresolvedLoadBearing = unresolved;
    return c;
  }
  /** The card's split disclosure: heading, then each claim's parts, as a reader sees them. */
  function disclosure(html: string): { el: El | undefined; items: string[][]; note: string | null } {
    const root = parse(html);
    const el = all(root, (e) => e.attrs["data-answer-part"] === "unresolved-load-bearing")[0];
    if (!el) return { el, items: [], note: null };
    expect(ancestors(el)).toContain(answerCard(root));
    expect(hiddenOnLoad(el)).toBe(false);
    const items = all(el, (e) => e.name === "li").map((li) => li.children.map(textOf));
    const p = el.children.filter((c): c is El => typeof c !== "string" && c.name === "p").map(textOf);
    return { el, items, note: p.length > 1 ? p[p.length - 1] : null };
  }

  it("valid stored splits: the same disclosure as with the answer stored — claim, its result, both sides — before the answer", async () => {
    const c = await cautionSplit();
    const stored = (c.report.presentation!.verificationGate as any).unresolvedLoadBearing;
    expect(stored).toHaveLength(1);
    const withAnswer = disclosure(page(c));
    const html = page({ ...c, report: withoutAnswer(c.report) });
    const got = disclosure(html);
    expect(got.items).toEqual(withAnswer.items);
    expect(got.items).toEqual([[`Claim: “${stored[0].claim}”`, `Panel result: ${stored[0].result}`, `Supported by: ${stored[0].supporters}`, `Disputed by: ${stored[0].disputers}`]]);
    expect(count(html, CAUTION_NOTICE)).toBe(1);
    const root = parse(html);
    const pos = order(root);
    const heading = visible(root, "Unresolved load-bearing claim");
    const answer = holding(answerCard(root), "Paris").find((e) => e.name === "p" && /\btext-base\b/.test(e.attrs.class ?? ""))!;
    expect(pos.get(visible(root, CAUTION_NOTICE))!).toBeLessThan(pos.get(heading)!);
    expect(pos.get(heading)!).toBeLessThan(pos.get(answer)!);
  });

  it("an unclear model is on neither side: the stored sides are shown as stored, nothing is added", async () => {
    const M5 = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as const;
    const st = ["agrees", "agrees", "unclear", "disputes", "disputes"];
    const row: AlignedClaim = { id: "answer", claimText: "Paris", cells: M5.map((m, i) => ({ modelId: m as ModelId, stance: st[i], rawStance: "asserts", confidence: null, excerpt: "x", origin: { kind: "field_derived", fieldType: "scalar" } })) as any, agreementScore: 0.5, certaintyScore: 0.8, status: "split" as any };
    g.mockImplementation(async () => off);
    const report = await historicalBuild("Q?", "factual_lookup" as QueryType, [row], M5.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 })));
    const gate = computeAdaptiveGate([row], computeRunCertainty([row], "factual_lookup"), "factual_lookup");
    expect(report.gate).toBe("caution");
    const results = M5.map((m) => ({ modelId: m as ModelId, schemaId: "factual_lookup", ok: true, data: { answer: "Paris", source: "Atlas", caveat: "none" }, latencyMs: 1 }) as any);
    const got = disclosure(page({ rows: [row], results, gate, report: withoutAnswer(report) }));
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toContain("Supported by: ChatGPT, Claude");
    expect(got.items[0]).toContain("Disputed by: Perplexity, Gemini");
    expect(got.items[0].join(" ")).not.toContain("Grok");
  });

  it("mixed valid and unreadable entries: the valid one shown once, the unreadable ones counted", async () => {
    const c = await cautionSplit();
    const stored = (c.report.presentation!.verificationGate as any).unresolvedLoadBearing;
    const got = disclosure(page({ ...c, report: withoutAnswer(c.report, [...stored, null, { claim: 1, result: "r" }]) }));
    expect(got.items).toHaveLength(1);
    expect(got.items[0][0]).toBe(`Claim: “${stored[0].claim}”`);
    expect(got.note).toBe(unreadableUnresolvedNotice(2));
  });

  it.each([
    ["only unreadable entries", [null, {}, { claim: "c" }], unreadableUnresolvedNotice(3)],
    ["a non-array value", "corrupt", UNRESOLVED_DETAILS_UNREADABLE],
    ["no stored list at all", undefined, UNRESOLVED_DETAILS_UNREADABLE],
  ])("%s: the details are stated as unavailable — never read as no split, never invented", async (_n, bad, note) => {
    const c = await cautionSplit();
    const html = page({ ...c, report: withoutAnswer(c.report, bad) });
    const got = disclosure(html);
    expect(got.items).toEqual([]);
    expect(got.note).toBe(note);
    expect(html).not.toContain("Disputed by");
    expect(count(html, CAUTION_NOTICE)).toBe(1);
  });

  it("an empty stored list: no disclosure and no note (no fabricated disagreement)", async () => {
    const c = await cautionSplit();
    const html = page({ ...c, report: withoutAnswer(c.report, []) });
    expect(disclosure(html).el).toBeUndefined();
    expect(html).not.toContain("could not be read");
    expect(html).toContain(CAUTION_NOTICE);
  });

  it.each([["pass"], ["fail"], ["unknown_status"]])("gate %s with unreadable entries and no answer: no split disclosure, the gate's own lead only", async (g2) => {
    const c = await cautionSplit();
    const r: any = withoutAnswer(c.report, [null, "x"]);
    r.gate = g2;
    const html = page({ ...c, report: r });
    expect(html).not.toContain("Unresolved load-bearing");
    expect(html).not.toContain("could not be read");
    expect(html).not.toContain(CAUTION_NOTICE);
    expect(count(html, gateLabel(g2 === "unknown_status" ? "unrecognized" : (g2 as "pass" | "fail")))).toBe(1);
  });

  it("historical (no verificationGate) without an answer: unchanged, no lead", async () => {
    const c = await cautionSplit();
    const r: any = withoutAnswer(historical(c.report));
    const html = page({ ...c, report: r });
    expect(html).not.toContain("Verification gate");
    expect(html).not.toContain("Unresolved load-bearing");
  });

  it("the Unified Answer of the same record is unchanged: it shows its stored answer string and adds no disclosure", async () => {
    const c = await cautionSplit();
    const r = withoutAnswer(c.report);
    const ua = presentUnifiedAnswer(r);
    expect(Object.keys(ua).sort()).toEqual(["claims", "claimsHeading", "gate", "note", "notice"]);
    expect(ua.note).toEqual({ source: "legacy", label: null, text: c.report.unifiedAnswer });
    expect(presentAnswerGate(r).unresolved).toHaveLength(1);
  });

  it("rendering never changes the stored record", async () => {
    const c = await cautionSplit();
    const r = withoutAnswer(c.report, [...(c.report.presentation!.verificationGate as any).unresolvedLoadBearing, null]);
    const before = JSON.stringify(r);
    page({ ...c, report: r });
    presentAnswerGate(r);
    expect(JSON.stringify(r)).toBe(before);
  });
});

// ─── Other schemas (the lead is the factual_lookup card's only) ──────────────────────────────────────────────

describe("O-1: no other schema's page changes", () => {
  const GENERIC_ROWS = (): AlignedClaim[] => [
    { id: "g-1", claimText: "Rate cuts reach inflation within a year", cells: M.map((m) => ({ modelId: m as ModelId, stance: "agrees", rawStance: "asserts", confidence: "settled", excerpt: "x", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } })) as any, agreementScore: 0.9, certaintyScore: 0.6, status: "majority" as any },
  ];
  it.each([["generic"], ["procedural"]])("%s caution page: no factual_lookup lead, the notice count stays 3 (strip + collapsed report view)", async (schemaId) => {
    g.mockImplementation(async () => off);
    const rows = GENERIC_ROWS();
    const report = await historicalBuild("Q?", schemaId as QueryType, rows, raw());
    const gate = computeAdaptiveGate(rows, computeRunCertainty(rows, schemaId as QueryType), schemaId as QueryType);
    expect(report.gate).toBe("caution");
    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema: getResultSchema(schemaId as QueryType),
        classification: { ...CLASSIFICATION, queryType: schemaId, answerShape: getResultSchema(schemaId as QueryType).renderHint },
        results: M.map((m) => ({ modelId: m as ModelId, schemaId, ok: true, data: {}, latencyMs: 1 }) as any),
        alignedClaims: rows,
        gate,
        synthesisReport: report,
        question: "Q?",
        runId: "run-o1",
      } as any)
    );
    expect(html).not.toContain('data-answer-part="answer-gate-lead"');
    expect(count(html, CAUTION_NOTICE)).toBe(3);
  });
});

// ─── Historical (D7) ────────────────────────────────────────────────────────────────────────────────────────

describe("O-1: historical factual_lookup reports keep their page (D7)", () => {
  it.each([
    ["caution", cautionSplit],
    ["pass", pass],
    ["fail", fail],
  ])("historical %s: the page is byte-identical to the page without the report lead", async (_n, mk) => {
    const c = await mk();
    const h = historical(c.report);
    const html = page({ ...c, report: h });
    expect(html).not.toContain("Verification gate");
    expect(html).not.toContain(CAUTION_NOTICE);
    expect(html).not.toContain('data-answer-part="answer-gate-lead"');
    // The card markup equals the card rendered with no report at all.
    const card = (s: string) => s.slice(s.indexOf("Answer</"), s.indexOf("% certainty"));
    expect(card(html)).toBe(card(page({ ...c, report: undefined })));
  });

  it("a report with no presentation at all is historical too", async () => {
    const c = await cautionSplit();
    const r = JSON.parse(JSON.stringify(c.report));
    delete r.presentation;
    const html = page({ ...c, report: r });
    expect(html).not.toContain("Verification gate");
    expect(html).not.toContain(CAUTION_NOTICE);
  });
});
