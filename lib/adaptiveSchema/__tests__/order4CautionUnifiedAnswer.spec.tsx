/**
 * Order 4 — Caution Unified Answer (D2–D8; D1 deferred; D9 boundaries).
 *
 * Every case runs the real report builder (buildAdaptiveSynthesisReport; the narrative model mocked) and reads the
 * final rendered surfaces: the report view (parsed to a DOM, so each text is checked with the data-source of the
 * element that holds it), the Answer strip, the verdict card, the governance gate, the list view chip, Markdown,
 * the generated memo, LinkedIn, X, the stored JSON, the real DOCX (unzipped, document.xml parsed as XML) and the
 * PDF element text. Historical records (no presentation.verificationGate) and unrecognized stored gates are covered
 * on the same surfaces.
 */
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (s: unknown) => s },
  renderToBuffer: jest.fn(),
}));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: true }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JSZip from "jszip";
import { callGemini } from "@/lib/connectors/gemini";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { computeRunCertainty } from "@/lib/adaptiveSchema/scoring";
import { computeContestedDimensions } from "@/lib/adaptiveSchema/consensusIntegrity";
import { renderRowStatus, rowAgreementFacts } from "@/lib/adaptiveSchema/agreementNarrative";
import { buildAdaptiveLinkedInPost, buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost } from "@/lib/adaptiveSchema/shareBuilders";
import { presentUnifiedAnswer } from "@/lib/adaptiveSchema/reportPresentation";
import { deriveConsensusLevel } from "@/lib/adaptiveSchema/reportSummary";
import { CAUTION_NEXT_STEP_WITHOUT_DISAGREEMENT, VERDICT_NEXT_STEPS } from "@/lib/adaptiveSchema/config";
import {
  CAUTION_NOTICE,
  CAUTION_NOTICE_SHORT,
  LEGACY_GATE_BANNER_LABEL,
  MODEL_PROSE_DOES_NOT_CHANGE_GATE,
  UNRECOGNIZED_GATE_NOTICE,
  gateBannerText,
  gateLabel,
  readGateStatus,
} from "@/lib/adaptiveSchema/gatePresentation";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import AdaptiveSynthesisReportView, { PanelVerdictCard } from "@/components/adaptive/AdaptiveSynthesisReportView";
import PrimarySynthesisStrip from "@/components/adaptive/PrimarySynthesisStrip";
import { ReviewGovernanceBody } from "@/components/adaptive/ReviewGovernanceSection";
import ListView from "@/components/adaptive/ListView";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "@/lib/pdf/__tests__/testUtils";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { AdaptiveGateResult, AdaptiveSynthesisReport, AlignedClaim, QueryType } from "@/lib/adaptiveSchema/types";
import { ModelId, ModelResult } from "@/lib/types";

const g = callGemini as jest.MockedFunction<typeof callGemini>;
const M = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as const;
const NAMES: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", perplexity: "Perplexity", gemini: "Gemini" };
const off = { modelId: "gemini", status: "error", rawText: null, errorMessage: "off", latencyMs: 1 } as any;
const okText = (o: unknown) => ({ modelId: "gemini", status: "ok", latencyMs: 1, rawText: JSON.stringify(o) }) as any;
const results = (): ModelResult[] => M.map((m) => ({ modelId: m as ModelId, status: "ok", rawText: "{}", latencyMs: 1 }));

// ─── Fixtures ────────────────────────────────────────────────────────────

let seq = 0;
type Stance = "agrees" | "partial" | "disputes" | "unclear" | null;
function row(claimText: string, status: string, st: Stance[], certainty: number, confidence = "settled"): AlignedClaim {
  const r: AlignedClaim = {
    id: `o4-${seq++}`,
    claimText,
    cells: M.map((m, i) =>
      st[i] ? { modelId: m as ModelId, stance: st[i], rawStance: "asserts", confidence, excerpt: `${m} excerpt`, origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" } } : null
    ) as any,
    agreementScore: status === "split" ? 0.3 : 0.9,
    certaintyScore: certainty,
    status: status as any,
  };
  const contested = computeContestedDimensions(r);
  return contested ? { ...r, contested } : r;
}
const A5: Stance[] = ["agrees", "agrees", "agrees", "agrees", "agrees"];
const A4D1: Stance[] = ["agrees", "agrees", "agrees", "agrees", "disputes"];
const SPL: Stance[] = ["agrees", "agrees", "disputes", "disputes", "disputes"];
/** A split with an unclear position: Grok is unclear — on neither side. */
const SPL_UNCLEAR: Stance[] = ["agrees", "agrees", "unclear", "disputes", "disputes"];
const LIM: Stance[] = ["agrees", "agrees", null, null, null];
const ONE: Stance[] = ["agrees", null, null, null, null];

interface Scenario {
  name: string;
  schema: QueryType;
  gate: "pass" | "caution" | "fail";
  /** Rows of the gate's load-bearing claims that are split — the D3 disclosure (caution only). */
  unresolved: string[];
  rows: () => AlignedClaim[];
}

const SCENARIOS: Scenario[] = [
  { name: "pass", schema: "generic", gate: "pass", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "consensus", A5, 0.9), row("Wage growth lags price growth", "majority", A4D1, 0.85), row("Housing costs respond slowest", "consensus", A5, 0.9)] },
  { name: "caution-split", schema: "generic", gate: "caution", unresolved: ["Tariffs raise consumer prices"], rows: () => [row("Rate cuts reach inflation within a year", "consensus", A5, 0.9), row("Wage growth lags price growth", "majority", A4D1, 0.85), row("Tariffs raise consumer prices", "split", SPL, 0.6)] },
  { name: "caution-split-unclear", schema: "generic", gate: "caution", unresolved: ["Tariffs raise consumer prices"], rows: () => [row("Rate cuts reach inflation within a year", "consensus", A5, 0.9), row("Wage growth lags price growth", "majority", A4D1, 0.85), row("Tariffs raise consumer prices", "split", SPL_UNCLEAR, 0.6)] },
  { name: "caution-certainty", schema: "generic", gate: "caution", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "majority", A4D1, 0.55), row("Wage growth lags price growth", "majority", A4D1, 0.6), row("Housing costs respond slowest", "majority", A4D1, 0.55)] },
  { name: "caution-limited", schema: "generic", gate: "caution", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "majority", A4D1, 0.6), row("Housing costs respond slowest", "limited_coverage", LIM, 0.6)] },
  { name: "caution-limited-only", schema: "generic", gate: "caution", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "limited_coverage", LIM, 0.6), row("Housing costs respond slowest", "limited_coverage", LIM, 0.6)] },
  { name: "caution-contested", schema: "generic", gate: "caution", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "majority", A4D1, 0.6, "contested"), row("Wage growth lags price growth", "majority", A4D1, 0.6)] },
  { name: "caution-single-source", schema: "generic", gate: "caution", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "single_source", ONE, 0.6), row("Housing costs respond slowest", "single_source", ONE, 0.6)] },
  { name: "caution-majority-only", schema: "generic", gate: "caution", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "majority", A4D1, 0.6)] },
  // factual_lookup: a split that is NOT load-bearing caps the gate at caution — disclosed elsewhere, not as load-bearing.
  { name: "caution-factual-split", schema: "factual_lookup", gate: "caution", unresolved: [], rows: () => [row("The capital is Canberra", "consensus", A5, 0.95), row("The capital moved in 1927", "consensus", A5, 0.95), row("Population is 26 million", "consensus", A5, 0.95), row("Founded 1913", "split", ["agrees", "disputes", null, null, null], 0.9)] },
  { name: "fail-splits", schema: "generic", gate: "fail", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "majority", A4D1, 0.8), row("Tariffs raise consumer prices", "split", SPL, 0.6), row("Deficits raise long rates", "split", SPL, 0.6)] },
  { name: "fail-certainty", schema: "generic", gate: "fail", unresolved: [], rows: () => [row("Rate cuts reach inflation within a year", "majority", A4D1, 0.3), row("Wage growth lags price growth", "majority", A4D1, 0.35)] },
];

/** Overconfident model prose — every certainty claim D4 names, including one impersonating the application's gate. */
const PROSE = {
  executiveSummary: "Verification gate: Pass. This is fully verified, certain and settled; the evidence leaves no doubt and it passed every check.",
  certaintyAssessment: "Confidence is absolute; the evidence leaves no meaningful doubt, so the result is a clean pass.",
  narrativeSections: [{ title: "Verification gate: Pass", body: "The evidence strongly favours this answer and leaves no room for doubt." }],
};

type Variant = "template" | "prose" | "filtered";
function mockNarrative(variant: Variant, splits: number) {
  g.mockImplementation(async (_q: any, _c: any, _k: any, opts: any) => {
    const sp = String(opts?.systemPromptOverride ?? "");
    if (variant !== "template" && sp.includes("narrative portion")) {
      const filtered = { executiveSummary: "All five models agree; the panel is unanimous.", certaintyAssessment: "Every model agrees.", narrativeSections: [] };
      return okText({ ...(variant === "prose" ? PROSE : filtered), whyModelsDisagree: Array(splits).fill("Models weigh different evidence."), disagreementStakes: Array(splits).fill("important") });
    }
    return off;
  });
}

async function build(s: Scenario, variant: Variant = "template"): Promise<{ report: AdaptiveSynthesisReport; rows: AlignedClaim[]; gate: AdaptiveGateResult }> {
  const rows = s.rows();
  mockNarrative(variant, rows.filter((r) => r.status === "split").length);
  const report = await buildAdaptiveSynthesisReport("Q?", s.schema, rows, results());
  const gate = computeAdaptiveGate(rows, computeRunCertainty(rows, s.schema), s.schema);
  return { report, rows, gate };
}

// ─── Markup scanner (linear; no backtracking regex) ───────────────────────

interface MarkupNode {
  name: string;
  attrs: Record<string, string>;
  children: (MarkupNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the entities React and the DOCX writer emit; records an error for anything else. */
function decodeEntities(text: string, errors: string[]): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "&") {
      out += ch;
      continue;
    }
    const end = text.indexOf(";", i);
    const name = end > i ? text.slice(i + 1, end) : "";
    if (end < 0 || name.length === 0 || name.length > 8) {
      errors.push(`bare & at ${i}`);
      out += ch;
      continue;
    }
    if (name[0] === "#") {
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code)) errors.push(`bad character reference &${name};`);
      else out += String.fromCodePoint(code);
    } else if (name in ENTITIES) out += ENTITIES[name];
    else errors.push(`unknown entity &${name};`);
    i = end;
  }
  return out;
}

/** XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]. */
function invalidXmlChar(text: string): number {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const ok = c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
    if (!ok) return c;
  }
  return -1;
}

/** One pass over the markup: a tree of elements and decoded text, plus every well-formedness error found. */
function parseMarkup(src: string): { root: MarkupNode; errors: string[] } {
  const errors: string[] = [];
  const root: MarkupNode = { name: "#root", attrs: {}, children: [] };
  const stack: MarkupNode[] = [root];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "<") {
      const next = src.indexOf("<", i);
      const raw = src.slice(i, next < 0 ? src.length : next);
      const bad = invalidXmlChar(raw);
      if (bad >= 0) errors.push(`invalid character U+${bad.toString(16)}`);
      stack[stack.length - 1].children.push(decodeEntities(raw, errors));
      i = next < 0 ? src.length : next;
      continue;
    }
    if (src.startsWith("<?", i) || src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // A tag: read to the closing ">" outside quoted attribute values.
    let j = i + 1;
    let quote: string | null = null;
    while (j < src.length && (quote !== null || src[j] !== ">")) {
      if (quote === null && (src[j] === '"' || src[j] === "'")) quote = src[j];
      else if (quote !== null && src[j] === quote) quote = null;
      j++;
    }
    if (j >= src.length) {
      errors.push("unterminated tag");
      break;
    }
    const body = src.slice(i + 1, j);
    i = j + 1;
    if (body[0] === "/") {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) errors.push(`mismatched </${name}> (open: ${top?.name})`);
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    let k = 0;
    while (k < inner.length && inner[k] !== " " && inner[k] !== "\n" && inner[k] !== "\t") k++;
    const node: MarkupNode = { name: inner.slice(0, k), attrs: {}, children: [] };
    // Attributes: name="value" pairs.
    while (k < inner.length) {
      while (k < inner.length && (inner[k] === " " || inner[k] === "\n" || inner[k] === "\t")) k++;
      const eq = inner.indexOf("=", k);
      if (eq < 0) break;
      const name = inner.slice(k, eq).trim();
      const q = inner[eq + 1];
      const close = inner.indexOf(q, eq + 2);
      if ((q !== '"' && q !== "'") || close < 0) {
        errors.push(`bad attribute in <${node.name}>`);
        break;
      }
      node.attrs[name] = decodeEntities(inner.slice(eq + 2, close), errors);
      k = close + 1;
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) errors.push(`unclosed: ${stack.slice(1).map((n) => n.name).join(", ")}`);
  return { root, errors };
}

function nodeText(n: MarkupNode | string): string {
  return typeof n === "string" ? n : n.children.map(nodeText).join("");
}

function findAll(n: MarkupNode, name: string, out: MarkupNode[] = []): MarkupNode[] {
  for (const c of n.children) {
    if (typeof c === "string") continue;
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

// ─── Surfaces ────────────────────────────────────────────────────────────

interface DomText {
  text: string;
  /** data-source of the nearest element that carries one. */
  source: string | null;
  /** data-section of the nearest section. */
  section: string | null;
  /** The text belongs to a SectionLabel-style application heading (an element with uppercase tracking classes, no data-source). */
  inHeading: boolean;
}

/** Walks the parsed view: each element's own text (React splits interpolations into several text nodes, joined here) and each text node, with the data-source / data-section of the nearest carrying ancestor. */
function walkView(html: string, perElement: boolean): DomText[] {
  const { root, errors } = parseMarkup(html);
  expect(errors).toEqual([]);
  const out: DomText[] = [];
  const walk = (node: MarkupNode, source: string | null, section: string | null, inHeading: boolean) => {
    const nextSource = node.attrs["data-source"] ?? source;
    const nextSection = node.attrs["data-section"] ?? section;
    const cls = node.attrs.class ?? "";
    const heading = inHeading || (!node.attrs["data-source"] && cls.includes("uppercase") && cls.includes("tracking"));
    if (perElement) {
      const own = node.children.filter((c): c is string => typeof c === "string").join("").trim();
      if (own) out.push({ text: own, source: nextSource, section: nextSection, inHeading: heading });
    }
    for (const c of node.children) {
      if (typeof c !== "string") walk(c, nextSource, nextSection, heading);
      else if (!perElement && c.trim()) out.push({ text: c.trim(), source: nextSource, section: nextSection, inHeading: heading });
    }
  };
  walk(root, null, null, false);
  return out;
}

const domTexts = (html: string) => walkView(html, false);
const elementTexts = (html: string) => walkView(html, true);

const plain = (html: string) => domTexts(html).map((t) => t.text).join("\n");
/** Application text only: everything except model-attributed elements (view) or quoted model lines (Markdown, memo). */
const appView = (html: string) => elementTexts(html).filter((t) => !(t.source ?? "").startsWith("model_")).map((t) => t.text).join("\n");
const appLines = (text: string) => text.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
const inSection = (html: string, id: string) => domTexts(html).filter((t) => t.section === id).map((t) => t.text).join("\n");

function mdSection(md: string, heading: string): string {
  const start = md.indexOf(`${heading}\n`);
  if (start < 0) return "";
  const rest = md.slice(start + heading.length + 1);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

function recordOf(report: AdaptiveSynthesisReport, rows: AlignedClaim[]) {
  const base = pdfLayoutFixtures().find((x) => (x.record as any).reportSnapshot?.legacy?.synthesisReport?.verdictCard)!;
  const record = JSON.parse(JSON.stringify(base.record));
  record.reportSnapshot.legacy.synthesisReport = report;
  record.reportSnapshot.legacy.alignedClaims = rows;
  record.reportSnapshot.legacy.gate = { status: report.gate, runCertainty: report.runCertainty, loadBearingClaims: [], loadBearingSplitCount: 0 };
  return record;
}

/** The real DOCX: document.xml parsed as XML (fails on invalid XML), one string per paragraph. */
async function docxOf(report: AdaptiveSynthesisReport, rows: AlignedClaim[]): Promise<{ paragraphs: string[]; xmlErrors: string[] }> {
  const { bytes } = await renderAdaptiveResearchDocxV1(recordOf(report, rows));
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  const { root, errors: xmlErrors } = parseMarkup(xml);
  const paragraphs = findAll(root, "w:p")
    .map((p) => findAll(p, "w:t").map(nodeText).join(""))
    .filter((t) => t.length > 0);
  return { paragraphs, xmlErrors };
}

async function surfaces(report: AdaptiveSynthesisReport, rows: AlignedClaim[], gate: AdaptiveGateResult) {
  const viewHtml = renderToStaticMarkup(createElement(AdaptiveSynthesisReportView as any, { report, gate, alignedClaims: rows, question: "Q?", modelsUsed: M }));
  const cardHtml = renderToStaticMarkup(createElement(PanelVerdictCard, { report, gate }));
  const stripHtml = renderToStaticMarkup(createElement(PrimarySynthesisStrip, { synthesisReport: report }));
  const governanceHtml = renderToStaticMarkup(createElement(ReviewGovernanceBody as any, { loading: false, unavailable: false, detail: null, historyScope: "unknown", gate, synthesisReport: report }));
  const listHtml = renderToStaticMarkup(
    createElement(ListView, { schema: SCHEMA_REGISTRY.generic, results: [], alignedClaims: rows, gate, synthesisReport: report })
  );
  const memoInput = buildAdaptiveMemoInput("Q?", report, M as unknown as ModelId[], "run");
  const docx = await docxOf(report, rows);
  return {
    viewHtml,
    view: plain(viewHtml),
    viewApp: appView(viewHtml),
    banner: inSection(viewHtml, "gate-banner"),
    answer: inSection(viewHtml, "unified-answer"),
    exec: inSection(viewHtml, "executive-summary"),
    certainty: inSection(viewHtml, "certainty"),
    card: plain(cardHtml),
    strip: plain(stripHtml),
    stripHtml,
    governance: plain(governanceHtml),
    list: plain(listHtml),
    md: buildAdaptiveSynthesisMarkdown("Q?", report),
    mdApp: appLines(buildAdaptiveSynthesisMarkdown("Q?", report)),
    memoInput,
    memo: generateVerificationMemo(memoInput),
    memoApp: appLines(generateVerificationMemo(memoInput)),
    li: buildAdaptiveLinkedInPost("Q?", report),
    x: buildAdaptiveXPost("Q?", report),
    json: JSON.parse(JSON.stringify(report)) as AdaptiveSynthesisReport,
    docx: docx.paragraphs,
    docxXmlErrors: docx.xmlErrors,
    pdf: extractPdfElementText(AdaptiveResearchDocument({ record: recordOf(report, rows) } as any)),
  };
}

const statusOf = (r: AlignedClaim) => renderRowStatus(rowAgreementFacts(r, 5));
const names = (r: AlignedClaim, stances: string[]) => r.cells.filter((c) => c && stances.includes(c.stance)).map((c) => NAMES[c!.modelId]).join(", ");
const OVERCLAIMS = [LEGACY_GATE_BANNER_LABEL.pass, LEGACY_GATE_BANNER_LABEL.fail, LEGACY_GATE_BANNER_LABEL.caution];

afterEach(() => jest.clearAllMocks());

// ─── D2 / D3 / D5 / D6: the caution decision matrix ──────────────────────

describe.each(SCENARIOS.flatMap((s) => (["template", "prose", "filtered"] as Variant[]).map((v) => [`${s.name} (${v})`, s, v] as const)))("%s", (_n, s, variant) => {
  let ctx: { report: AdaptiveSynthesisReport; rows: AlignedClaim[]; gate: AdaptiveGateResult };
  let out: Awaited<ReturnType<typeof surfaces>>;
  beforeAll(async () => {
    ctx = await build(s, variant);
    out = await surfaces(ctx.report, ctx.rows, ctx.gate);
  });

  it("the stored gate is the computed gate (D9: Order 4 changes no gate)", () => {
    expect(ctx.report.gate).toBe(s.gate);
    expect(ctx.report.gate).toBe(ctx.gate.status);
    expect(ctx.report.runCertainty).toBe(ctx.gate.runCertainty);
    expect(ctx.report.presentation!.verificationGate).toBeDefined();
  });

  it("D6: every gate-bearing surface states the gate in the neutral wording, and no surface carries an old overclaim", () => {
    const label = gateLabel(s.gate);
    for (const surface of [out.banner, out.answer, out.card, out.strip, out.governance, out.list, out.md, out.memo, out.li, out.x, out.docx.join("\n"), out.pdf]) {
      expect(surface).toContain(label);
    }
    for (const surface of [out.view, out.card, out.strip, out.governance, out.list, out.md, out.memo, out.li, out.x, out.docx.join("\n"), out.pdf]) {
      for (const overclaim of OVERCLAIMS) expect(surface).not.toContain(overclaim);
    }
    // Only the application states the gate outside model-written blocks: in a non-pass report "Verification gate: Pass" can come only from model prose.
    if (s.gate !== "pass") {
      for (const t of elementTexts(out.viewHtml).filter((x) => x.text.includes(gateLabel("pass")))) expect(t.source).toBe("model_explanation");
    }
  });

  it("D2: the computed caution notice is in the Unified Answer on every surface iff the gate is caution", () => {
    const caution = s.gate === "caution";
    for (const surface of [out.answer, out.strip, mdSection(out.md, "## Unified Answer"), out.memo, out.li, out.docx.join("\n"), out.pdf, out.json.unifiedAnswer]) {
      expect(surface.includes(CAUTION_NOTICE)).toBe(caution);
    }
    expect(out.x.includes(CAUTION_NOTICE_SHORT)).toBe(caution);
    // The notice is computed text — never model-attributed — and comes before the answer's claims.
    for (const t of elementTexts(out.viewHtml).filter((x) => x.text === CAUTION_NOTICE)) expect(t.source).toBe("computed");
    if (caution) {
      const a = presentUnifiedAnswer(ctx.report);
      expect(a.gate).toEqual({ source: "computed", label: "Verification gate", text: "Caution" });
      expect(a.notice).toEqual({ source: "computed", label: null, text: CAUTION_NOTICE });
      expect(out.answer.indexOf(CAUTION_NOTICE)).toBeLessThan(Math.min(...ctx.report.presentation!.answer.claims.map((c) => out.answer.indexOf(c.claim)).filter((i) => i >= 0), Infinity));
    }
  });

  it("D3: a caution answer discloses exactly the gate's load-bearing splits, each with its own result and sides; nothing is invented", () => {
    const expected = s.gate === "caution" ? s.unresolved : [];
    const p = ctx.report.presentation!;
    const disclosed = presentUnifiedAnswer(ctx.report).unresolved ?? [];
    expect(disclosed.map((d) => d.claim.text)).toEqual(expected.map((c) => `“${c}”`));
    expect(p.verificationGate!.unresolvedLoadBearing.map((u) => u.claim)).toEqual(ctx.gate.loadBearingClaims.filter((r) => r.status === "split").map((r) => r.claimText));
    for (const claim of expected) {
      const r = ctx.rows.find((x) => x.claimText === claim)!;
      const u = p.verificationGate!.unresolvedLoadBearing.find((x) => x.claim === claim)!;
      expect(u.result).toBe(statusOf(r)); // its own row's computed status
      expect(u.supporters).toBe(names(r, ["agrees", "partial"]));
      expect(u.disputers).toBe(names(r, ["disputes"])); // unclear on neither side
      for (const surface of [out.answer, out.strip, mdSection(out.md, "## Unified Answer"), out.docx.join("\n"), out.pdf, out.json.unifiedAnswer]) {
        expect(surface).toContain(claim);
        expect(surface).toContain(statusOf(r));
      }
      expect(out.answer).toContain(`Disputed by: ${u.disputers}`);
      expect(out.memo).toContain(`Claim: “${claim}” — Panel result: ${statusOf(r)} — Supported by: ${u.supporters} — Disputed by: ${u.disputers}`);
    }
    if (expected.length === 0) {
      for (const surface of [out.view, out.strip, out.md, out.memo, out.docx.join("\n"), out.pdf, out.json.unifiedAnswer]) expect(surface).not.toContain("Unresolved load-bearing");
    }
    // No cause is asserted anywhere: the application never says why the gate returned caution.
    for (const surface of [out.view, out.md, out.memo, out.li, out.docx.join("\n"), out.pdf]) expect(surface).not.toMatch(/caution (because|due to|caused by)/i);
  });

  it("D3: a caution with no split names no disagreement in its next steps", () => {
    const steps = ctx.report.verdictCard.recommendedNextSteps;
    if (s.gate === "caution" && !ctx.rows.some((r) => r.status === "split")) {
      expect(steps[0]).toBe(CAUTION_NEXT_STEP_WITHOUT_DISAGREEMENT);
      for (const step of steps) expect(step).not.toMatch(/disagreement/i);
    } else {
      expect(steps).toEqual(VERDICT_NEXT_STEPS[s.gate].slice(0, 3));
    }
  });

  it("fail keeps its fail-specific protection; pass gets no notice", () => {
    if (s.gate === "fail") {
      expect(ctx.report.presentation!.answer.note).toBe("Panel could not converge on a reliable answer.");
      expect(ctx.report.executiveSummary).toBe(ctx.report.unifiedAnswer); // model summary still suppressed
      expect(out.answer).toContain("Panel could not converge on a reliable answer.");
    }
    if (s.gate === "pass") {
      for (const surface of [out.view, out.md, out.memo, out.li, out.x, out.docx.join("\n"), out.pdf]) {
        expect(surface).not.toContain(CAUTION_NOTICE);
        expect(surface).not.toContain(MODEL_PROSE_DOES_NOT_CHANGE_GATE);
      }
    }
  });

  it("D4: model prose never stands in for the computed gate — it follows the gate and stays attributed", () => {
    const texts = elementTexts(out.viewHtml);
    const modelTexts = texts.filter((t) => t.source === "model_explanation");
    // Every model-written string in the view sits inside a model-attributed element, never an application heading.
    for (const fragment of [PROSE.executiveSummary, PROSE.certaintyAssessment, PROSE.narrativeSections[0].body]) {
      for (const t of texts.filter((x) => x.text.includes(fragment))) expect(t.source).toBe("model_explanation");
    }
    const titles = texts.filter((x) => x.section === "narrative-sections" && x.text === PROSE.narrativeSections[0].title);
    if (variant === "prose") expect(titles).toHaveLength(1);
    for (const t of titles) {
      expect(t.source).toBe("model_explanation");
      expect(t.inHeading).toBe(false);
    }
    if (variant === "prose" && s.gate !== "pass") {
      // Executive summary: the model's (filtered) summary is shown attributed, after the computed gate; on fail it is not shown.
      const summary = ctx.report.executiveSummary;
      if (s.gate === "caution") {
        expect(ctx.report.presentation!.executiveSummarySource).toBe("model_explanation");
        expect(modelTexts.some((t) => t.text === summary)).toBe(true);
        expect(out.exec.indexOf("Caution")).toBeLessThan(out.exec.indexOf(summary));
      }
      if (s.gate === "fail") expect(out.exec).not.toContain("Verification gate: Pass.");
      // Certainty: the computed statement that the prose does not change the gate precedes the model's explanation.
      const framing = `${gateLabel(s.gate)}. ${MODEL_PROSE_DOES_NOT_CHANGE_GATE}`;
      expect(out.certainty).toContain(framing);
      expect(out.certainty.indexOf(framing)).toBeLessThan(out.certainty.indexOf(PROSE.certaintyAssessment));
      expect(texts.find((t) => t.text === framing)!.source).toBe("computed");
      // Markdown and memo: the prose is quoted under its label, the computed gate is not.
      expect(out.md).toContain(`**${gateLabel(s.gate)}**`);
      expect(out.md).not.toContain(`\n${PROSE.certaintyAssessment}`);
      expect(out.memo).not.toContain(`\n${PROSE.certaintyAssessment}`);
      // Raw model text is stored unchanged (no rewrite of the narrative).
      expect(ctx.report.presentation!.certaintyExplanation).toBe(PROSE.certaintyAssessment);
    }
  });

  it("D5: the JSON keeps the raw stored values; the memo and social posts keep the gate meaning", () => {
    expect(out.json.gate).toBe(s.gate);
    expect(out.json.runCertainty).toBe(ctx.report.runCertainty);
    expect(out.memoInput.confidenceLabel).toBe({ pass: "High", caution: "Medium", fail: "Low" }[s.gate]);
    expect(out.memoInput.keyFindings![0].startsWith(gateLabel(s.gate))).toBe(true);
    expect(out.x.length).toBeLessThanOrEqual(280);
    expect(out.li).toContain(`${gateLabel(s.gate)} · Certainty: ${Math.round(ctx.report.runCertainty * 100)}%`);
  });

  it("DOCX: the document XML is well-formed and the answer section carries the gate (and notice) before its claims", () => {
    expect(out.docxXmlErrors).toEqual([]);
    const at = out.docx.indexOf("Unified answer");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(out.docx[at + 1]).toBe(gateLabel(s.gate));
    if (s.gate === "caution") expect(out.docx[at + 2]).toBe(CAUTION_NOTICE);
  });
});

// ─── D7: historical records ──────────────────────────────────────────────

/** A report as persisted before Order 4: no presentation.verificationGate, the stored answer without the caution lead. */
function historical(report: AdaptiveSynthesisReport, opts: { prePresentation?: boolean } = {}): AdaptiveSynthesisReport {
  const h = JSON.parse(JSON.stringify(report));
  delete h.presentation.verificationGate;
  if (h.gate === "caution") {
    h.unifiedAnswer = h.unifiedAnswer.split("\n\n")[1];
    if (h.executiveSummary.startsWith(gateLabel("caution"))) h.executiveSummary = h.unifiedAnswer;
  }
  if (opts.prePresentation) {
    delete h.presentation;
    for (const k of ["topConsensusAgreement", "keyDisagreementAgreement", "caveatSource", "topConsensusContested"]) delete h.verdictCard[k];
  }
  return h;
}

describe.each(SCENARIOS.flatMap((s) => [[`${s.name} (Order 3 record)`, s, false], [`${s.name} (pre-presentation record)`, s, true]] as const))("D7 historical — %s", (_n, s, prePresentation) => {
  it("renders with no Order 4 semantics: no neutral gate label, no notice, no disclosure; the stored gate, certainty and text are unchanged", async () => {
    const built = await build(s, "prose");
    const h = historical(built.report, { prePresentation });
    const before = JSON.stringify(h);
    const out = await surfaces(h, built.rows, built.gate);
    expect(JSON.stringify(h)).toBe(before); // rendering mutates nothing
    // The stored model texts are shown as stored (historical records label nothing); this fixture's prose itself
    // says "Verification gate: Pass", so it is removed before checking the application's own text.
    const stored = [h.executiveSummary, h.presentation?.certaintyExplanation, ...h.narrativeSections.flatMap((n) => [n.title, n.body])].filter((t): t is string => !!t);
    const app = (t: string) => stored.reduce((acc, x) => acc.split(x).join(""), t);
    expect(out.json.gate).toBe(s.gate);
    // Application text only: this fixture's model prose itself says "Verification gate: Pass." (attributed, quoted).
    for (const surface of [out.viewApp, out.card, out.strip, out.governance, out.list, out.mdApp, out.memoApp, out.li, out.x, out.docx.join("\n"), out.pdf].map(app)) {
      expect(surface).not.toContain("Verification gate:");
      expect(surface).not.toContain(CAUTION_NOTICE);
      expect(surface).not.toContain("Unresolved load-bearing");
      expect(surface).not.toContain(MODEL_PROSE_DOES_NOT_CHANGE_GATE);
    }
    expect(out.banner).toBe(LEGACY_GATE_BANNER_LABEL[s.gate]);
    expect(out.list).toContain(`gate: ${s.gate}`);
    expect(out.md).toContain(`(gate: ${s.gate})`);
    expect(out.x).toContain(`(${s.gate})`);
    // Narrative section titles stay application headings on historical records, as before.
    const titleTexts = elementTexts(out.viewHtml).filter((t) => t.text === PROSE.narrativeSections[0].title);
    if (s.gate !== "fail" || titleTexts.length > 0) for (const t of titleTexts) expect(t.inHeading).toBe(true);
  });
});

// ─── D8: unknown / malformed stored gates ────────────────────────────────

const UNKNOWN_GATES: [string, unknown][] = [
  ["unsupported string", "review_pending"],
  ["empty string", ""],
  ["null", null],
  ["missing", undefined],
  ["number", 42],
  ["object", { status: "pass" }],
  ["uppercase PASS", "PASS"],
  ["near-miss 'passed'", "passed"],
  ["future status", "escalated"],
];

describe.each(UNKNOWN_GATES.flatMap(([n, v]) => [[`${n} (new record)`, v, false], [`${n} (historical record)`, v, true]] as const))("D8 unknown gate — %s", (_n, value, isHistorical) => {
  it("never crashes, is never a known status, and every surface shows the controlled unrecognized state", async () => {
    const built = await build(SCENARIOS[0], "prose"); // a pass report: an unknown gate must not read as its old pass
    const report: any = isHistorical ? historical(built.report) : JSON.parse(JSON.stringify(built.report));
    if (value === undefined) delete report.gate;
    else report.gate = value;
    const gate: any = { ...built.gate, status: value };
    expect(readGateStatus(value)).toBe("unrecognized");
    const out = await surfaces(report, built.rows, gate);
    expect(out.banner).toBe(gateLabel("unrecognized"));
    for (const surface of [out.answer, out.strip, mdSection(out.md, "## Unified Answer"), out.memo, out.docx.join("\n"), out.pdf]) {
      expect(surface).toContain(gateLabel("unrecognized"));
      expect(surface).toContain(UNRECOGNIZED_GATE_NOTICE);
    }
    for (const surface of [out.card, out.governance, out.list, out.exec, out.certainty]) expect(surface).toContain(gateLabel("unrecognized"));
    expect(out.exec).toContain(UNRECOGNIZED_GATE_NOTICE);
    // A historical record's narrative titles are application headings, as they always were (D7): its stored model
    // texts are removed before checking what the application itself says.
    const storedModel = isHistorical ? report.narrativeSections.flatMap((n: any) => [n.title, n.body]) : [];
    const app = (t: string) => storedModel.reduce((acc: string, x: string) => acc.split(x).join(""), t);
    for (const surface of [out.viewApp, out.card, out.strip, out.governance, out.list, out.mdApp, out.memoApp, out.li, out.x, out.docx.join("\n"), out.pdf].map(app)) {
      for (const known of ["pass", "caution", "fail"] as const) expect(surface).not.toContain(gateLabel(known));
      for (const overclaim of OVERCLAIMS) expect(surface).not.toContain(overclaim);
      expect(surface).not.toContain(CAUTION_NOTICE);
      expect(surface).not.toContain("undefined");
    }
    expect(out.memoInput.confidenceLabel).toBe("Unrecognized");
    // Stored computed strings (panelVerdict, certaintyAssessment) keep the gate word they were created with — shown
    // as stored (no rewrite); every gate the application words at render time is "unrecognized".
    const storedStrings = [report.panelVerdict, report.certaintyAssessment];
    const rendered = storedStrings.reduce((acc: string, x: string) => acc.split(x).join(""), out.md);
    expect(rendered).not.toMatch(/gate: (pass|caution|fail)\b/);
    expect(deriveConsensusLevel({ schemaId: "generic", gate })).toBe("unscored");
    expect(out.docxXmlErrors).toEqual([]);
    // Raw value preserved for diagnostics in the stored JSON.
    expect(out.json.gate).toEqual(value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  });
});

describe("markup scanner self-test (the well-formedness and attribution checks can fail)", () => {
  it("reports mismatched and unclosed tags, unknown entities, bare ampersands and XML-invalid characters", () => {
    expect(parseMarkup("<a><b></a>").errors.length).toBeGreaterThan(0);
    expect(parseMarkup("<a>").errors).toEqual(["unclosed: a"]);
    expect(parseMarkup("<a>&nbsp;</a>").errors).toEqual(["unknown entity &nbsp;"]);
    expect(parseMarkup("<a>R & D</a>").errors.length).toBe(1);
    expect(parseMarkup(`<w:t>x${String.fromCharCode(1)}y</w:t>`).errors).toEqual(["invalid character U+1"]);
    expect(parseMarkup('<p data-source="computed">a &amp; b<br/></p>').errors).toEqual([]);
  });

  it("reads text with its nearest data-source and data-section", () => {
    const t = elementTexts('<div data-section="s"><p data-source="model_explanation">x <span>y</span></p><p>z</p></div>');
    expect(t).toEqual([
      { text: "x", source: "model_explanation", section: "s", inHeading: false },
      { text: "y", source: "model_explanation", section: "s", inHeading: false },
      { text: "z", source: null, section: "s", inHeading: false },
    ]);
  });
});

describe("gate wording source (D6)", () => {
  it("one map; historical banner words are frozen and used only without the Order 4 presentation", () => {
    expect([gateLabel("pass"), gateLabel("caution"), gateLabel("fail"), gateLabel("unrecognized")]).toEqual([
      "Verification gate: Pass",
      "Verification gate: Caution",
      "Verification gate: Fail",
      "Verification gate: Unrecognized",
    ]);
    const framed = { presentation: { verificationGate: { unresolvedLoadBearing: [] } } } as any;
    expect(gateBannerText(framed, "pass")).toBe("Verification gate: Pass");
    expect(gateBannerText({ presentation: {} } as any, "pass")).toBe(LEGACY_GATE_BANNER_LABEL.pass);
    expect(gateBannerText(null, "nope")).toBe("Verification gate: Unrecognized");
    expect(gateBannerText(framed, "fail")).not.toMatch(/split/);
    expect(gateBannerText(framed, "pass")).not.toMatch(/verified|converge/i);
  });

  it("a corrupted verificationGate never crashes the answer", () => {
    const report = { gate: "caution", unifiedAnswer: "x", presentation: { answer: { note: null, claims: [] }, verificationGate: { unresolvedLoadBearing: "bad" } } } as any;
    expect(presentUnifiedAnswer(report).unresolved).toEqual([]);
  });
});

// ─── Order 7 boundary: a degraded run is not reclassified ────────────────

describe("degraded run (2 of 5 models failed) — Order 7, out of scope", () => {
  it("keeps its computed gate and is worded as that gate; no dropout disclosure is added by Order 4", async () => {
    mockNarrative("template", 0);
    const resp = (c: unknown) => JSON.stringify({ summary: "s", settledClaims: [c], disputedClaims: [], keyMetrics: [], openQuestions: [] });
    const claim = { id: "a", claim: "Rate cuts reach inflation within about a year.", stance: "asserts", confidence: "settled", evidenceType: "empirical" };
    const rs = M.map((m, i) => (i < 3 ? { modelId: m, status: "ok", rawText: resp(claim), latencyMs: 5 } : { modelId: m, status: "error", rawText: null, errorMessage: "provider error", latencyMs: 5 }));
    const out: any = await finalizeAdaptiveRun(SCHEMA_REGISTRY.contested_empirical, rs as any, "Q");
    const report: AdaptiveSynthesisReport = out.synthesisReport;
    // The gate is what the unchanged gate computes from the run's own rows and certainty.
    const recomputed = computeAdaptiveGate(out.alignedClaims, computeRunCertainty(out.alignedClaims, "contested_empirical"), "contested_empirical");
    expect(report.gate).toBe(recomputed.status);
    expect(out.gate.status).toBe(recomputed.status);
    const a = presentUnifiedAnswer(report);
    expect(a.gate!.text).toBe({ pass: "Pass", caution: "Caution", fail: "Fail" }[report.gate]);
    expect(JSON.stringify(report)).not.toMatch(/dropout|failed models?|did not respond/i);
  });
});

// ─── Shared memo generator: claim verification unaffected ────────────────

describe("claim-verification memo (shared generator) is unaffected", () => {
  it("generates exactly the claim memo it did before Order 4", () => {
    const input = {
      type: "claim" as const,
      claim: "The bridge opened in 1932",
      verdict: "MOSTLY_TRUE",
      consensusScore: 74,
      confidenceLabel: "Medium",
      evidenceQuality: "strong",
      verificationId: "v-1",
      agreementPoints: ["Opened in 1932"],
      disagreementPoints: ["Exact day differs"],
      modelEvidence: [{ modelId: "chatgpt", verdict: "TRUE", confidence: "high", summary: "Opened March 1932." }],
    };
    const memo = generateVerificationMemo(input as any).replace(/Generated: .*/, "Generated: <t>");
    expect(memo).not.toContain("Verification gate");
    expect(memo).toContain("CONSENSUS SCORE: 74/100 (Medium confidence)");
    expect(memo).toMatchSnapshot();
  });
});
