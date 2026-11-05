/**
 * #290 Increment 1 — the readable layout, rendered through the real AdaptivePanelResponse (and, for Personal / Team
 * parity, through PersistedResearchResultView → ResultsDisplay).
 *
 *   A. regression: classic is untouched — absent / "classic" / any unknown layout renders the same bytes for every o5p
 *      record, carries no readable marker, and non-pilot schemas ignore the layout entirely. (The sealed oracles —
 *      historicalParity, nonDsWordingParity — run unchanged; readableFrozenFiles.spec.ts pins their fixtures.)
 *   B. structure ("visual"): header → answer → trust signals → details in DOM order; the details tier carries the
 *      classic sections byte-identically; the header drops only Consensus / Source grounding.
 *   C. the #290 remote-work acceptance fixture.
 *   D. semantic preservation (table-driven): for every stored gate × every synthesis state, the readable words are
 *      never stronger than the stored data, and limitations / uncertainty stay visible.
 *   E. accessibility: heading hierarchy, an accessible name and description per trust signal, no colour-only meaning.
 *   F. Personal and Team render the same readable lead.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { GATE_STATUS_WORD, UNRECOGNIZED_GATE_NOTICE, CAUTION_NOTICE, readGateStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { presentVerdictCaveat } from "@/lib/adaptiveSchema/agreementNarrative";
import { ANALYSIS_NOTICE_LINES } from "@/components/adaptive/AnalysisAvailabilityNotice";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import PanelEvidenceSection from "@/components/adaptive/PanelEvidenceSection";
import { RunModelProvenanceContext } from "@/components/adaptive/RunModelProvenanceContext";
import { RunSlotStatusContext } from "@/components/adaptive/RunSlotStatusContext";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { READABLE_ANSWER_COPY, READABLE_TRUST_COPY } from "@/lib/research/readableReport/copy";
import { ALL_SCENARIOS, PILOT_SCENARIOS, QUESTION, htmlText, panelElement, record, remoteWorkFixture, renderPanel, slotRows, tierHtml } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };
const STRENGTH: Record<string, number> = { pass: 3, caution: 2, fail: 1, unrecognized: 0 };

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** The gate signal's value text, read from the rendered trust tier. */
function signalValue(trust: string, id: string): string {
  const at = trust.indexOf(`data-trust-signal="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const m = /data-trust-signal-value=""[^>]*>([^<]*)</.exec(trust.slice(at));
  return m![1];
}

// ── A. regression ───────────────────────────────────────────────────────────

describe("A. classic is unchanged", () => {
  it.each(ALL_SCENARIOS)("%s: absent, classic and unknown layouts render identical bytes with no readable marker", (name) => {
    const rec = record(name);
    const rows = slotRows(name);
    const absent = renderPanel(rec, rows);
    expect(renderPanel(rec, rows, { reportLayout: "classic" })).toBe(absent);
    expect(renderPanel(rec, rows, { reportLayout: "Readable" })).toBe(absent);
    expect(renderPanel(rec, rows, { reportLayout: true })).toBe(absent);
    expect(absent).not.toMatch(/data-readable-tier|data-report-layout|data-trust-signal/);
  });

  it.each(["factual-normalizer", "factual-single", "graceful-limitation"])("%s (not a pilot schema): readable is ignored", (name) => {
    const rec = record(name);
    const rows = slotRows(name);
    expect(renderPanel(rec, rows, READABLE)).toBe(renderPanel(rec, rows));
  });
});

// ── B. structure ────────────────────────────────────────────────────────────

describe("B. readable structure", () => {
  it.each(PILOT_SCENARIOS)("%s: header → answer → trust → details, in DOM order", (name) => {
    const html = renderPanel(record(name), slotRows(name), READABLE);
    const order = ["header", "answer", "trust", "details"].map((t) => html.indexOf(`data-readable-tier="${t}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The answer and trust tiers are siblings that end before the details begin.
    expect(html.indexOf(tierHtml(html, "trust")!) + tierHtml(html, "trust")!.length).toBeLessThan(order[3]);
  });

  it.each(PILOT_SCENARIOS)("%s: the details tier carries the classic Model Responses and Panel Evidence markup, byte for byte", (name) => {
    const rec = record(name);
    const rows = slotRows(name);
    const wrap = (el: any) =>
      renderToStaticMarkup(
        createElement(RunModelProvenanceContext.Provider, { value: rows.map((r) => runModelProvenanceFromResultRow(r as any)) }, createElement(RunSlotStatusContext.Provider, { value: new Map(rows.map((r) => [r.modelId, String(r.status ?? "")])) }, el))
      );
    const schema = getResultSchema(rec.schemaId);
    const { alignedClaims, gate, synthesisReport, trustSummary } = rec;
    const modelResponses = wrap(createElement(ModelResponsesSection as any, { schema, results: rec.results, listView: gate && synthesisReport ? { alignedClaims, gate, synthesisReport, trustSummary } : undefined }));
    const evidence = wrap(createElement(PanelEvidenceSection as any, { schemaId: rec.schemaId, gate, synthesisReport, trustSummary, alignedClaims, modelsUsed: rec.results.map((r: any) => r.modelId), showClaimMatrix: schema.renderHint === "step_diff" }));
    const classic = renderPanel(rec, rows);
    const details = tierHtml(renderPanel(rec, rows, READABLE), "details")!;
    for (const part of [modelResponses, evidence]) {
      expect(classic).toContain(part);
      expect(details).toContain(part);
    }
    // The classic uncertainty / follow-up sections stay in readable mode.
    for (const label of [">Uncertainties<", ">Suggested follow-ups<"]) if (classic.includes(label)) expect(details).toContain(label);
  });

  it("the readable header keeps report type, status, models, generated; drops only Consensus and Source grounding", () => {
    const rec = record("generic-mixed");
    const rows = slotRows("generic-mixed");
    const classic = htmlText(renderPanel(rec, rows));
    const header = htmlText(tierHtml(renderPanel(rec, rows, READABLE), "header")!);
    expect(classic).toMatch(/Consensus/);
    expect(classic).toMatch(/Source grounding/);
    for (const label of ["Report type", "Status", "Models", "Generated"]) expect(header).toContain(label);
    expect(header).not.toMatch(/Consensus|Source grounding/);
  });

  it("the classic strip is replaced, not duplicated: the readable page has one answer section", () => {
    const html = renderPanel(record("generic-mixed"), slotRows("generic-mixed"), READABLE);
    expect(html.match(/data-readable-tier="answer"/g)).toHaveLength(1);
    expect(html).not.toContain('<h4 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Answer</h4>');
  });
});

// ── C. remote-work acceptance fixture ───────────────────────────────────────

describe("C. #290 remote-work fixture", () => {
  it('renders 4 of 5 responded, gate Fail, "no written synthesis", and no "Pass" / "verified" in the lead', () => {
    const { rec, rows } = remoteWorkFixture();
    const html = renderPanel(rec, rows, READABLE);
    const answer = tierHtml(html, "answer")!;
    const trust = tierHtml(html, "trust")!;
    expect(signalValue(trust, "coverage")).toBe("Responded: 4 of 5 dispatched, including 1 answered by a substitute model");
    expect(signalValue(trust, "gate")).toBe("Fail");
    expect(signalValue(trust, "sources")).toBe(READABLE_TRUST_COPY.sourcesNotRequested);
    expect(htmlText(answer)).toContain(READABLE_ANSWER_COPY.assembledHeading);
    expect(htmlText(answer)).toContain(ANALYSIS_NOTICE_LINES.degraded);
    const lead = htmlText(answer + trust);
    expect(lead).not.toMatch(/\bPass\b/);
    // The only "verified" allowed is the frozen caveat's own negation ("not a verified finding").
    expect(lead.split("not a verified finding").join("")).not.toMatch(/verified/i);
    expect(htmlText(trust)).not.toMatch(/consensus/i);
    // The page-level limitation notice is still there too.
    expect(html).toContain('data-testid="analysis-availability-notice"');
  });
});

// ── D. semantic preservation ────────────────────────────────────────────────

type Synth = "written" | "assembled" | "unknown" | "missing";
const GATES: unknown[] = ["pass", "caution", "fail", "unrecognized-value"];
const SYNTHS: Synth[] = ["written", "assembled", "unknown", "missing"];
const CASES = GATES.flatMap((g) => SYNTHS.map((s) => [g, s] as const));
const HEADING: Record<Synth, string> = {
  written: READABLE_ANSWER_COPY.writtenHeading,
  assembled: READABLE_ANSWER_COPY.assembledHeading,
  unknown: READABLE_ANSWER_COPY.unknownHeading,
  missing: READABLE_ANSWER_COPY.missingHeading,
};

function caseRecord(base: string, gate: unknown, synth: Synth) {
  const rec = record(base);
  rec.gate.status = gate;
  rec.synthesisReport.gate = gate;
  if (synth === "written") rec.synthesisReport.degraded = false;
  if (synth === "assembled") rec.synthesisReport.degraded = true;
  if (synth === "unknown") delete rec.synthesisReport.degraded;
  if (synth === "missing") delete rec.synthesisReport;
  return rec;
}

describe("D. readable wording is never stronger than the stored data", () => {
  it.each(CASES)("gate %p × synthesis %s (generic-mixed)", (gate, synth) => {
    const rec = caseRecord("generic-mixed", gate, synth);
    const rows = slotRows("generic-mixed");
    const html = renderPanel(rec, rows, READABLE);
    const answer = tierHtml(html, "answer")!;
    const trust = tierHtml(html, "trust")!;
    const stored = readGateStatus(gate);

    // Gate: the stored status word, exactly — so its strength equals the stored status, never more.
    const shown = signalValue(trust, "gate");
    expect(shown).toBe(GATE_STATUS_WORD[stored]);
    const shownKey = (Object.keys(GATE_STATUS_WORD) as (keyof typeof GATE_STATUS_WORD)[]).find((k) => GATE_STATUS_WORD[k] === shown)!;
    expect(STRENGTH[shownKey]).toBeLessThanOrEqual(STRENGTH[stored]);
    const trustText = htmlText(trust);
    expect(trustText).not.toMatch(/consensus|verified|models agree|panel agrees/i);
    if (stored !== "pass") expect(htmlText(answer + trust)).not.toMatch(/\bPass\b/);
    if (stored === "unrecognized") {
      expect(trustText).toContain(UNRECOGNIZED_GATE_NOTICE);
      expect(trustText).not.toContain(READABLE_TRUST_COPY.gateInputsHeading);
    }
    if (stored === "caution") expect(trustText).toContain(CAUTION_NOTICE);

    // Sources on a schema that asks for none: N/A, never a percentage.
    expect(signalValue(trust, "sources")).toBe(READABLE_TRUST_COPY.sourcesNotRequested);

    // Answer heading: "Answer" only for a written synthesis.
    const answerText = htmlText(answer);
    expect(answerText.startsWith(HEADING[synth])).toBe(true);
    if (synth !== "written") expect(answerText).not.toMatch(/^Answer\b/);
    if (synth === "missing") {
      const original = record("generic-mixed").synthesisReport;
      expect(answerText).not.toContain(original.verdictCard.topConsensus);
      expect(html).toContain('id="readable-model-responses"');
    } else {
      // Limitations stay: the degraded line (when degraded) and the stored caveat (when the classic strip shows one).
      if (synth === "assembled") expect(answerText).toContain(ANALYSIS_NOTICE_LINES.degraded);
      const caveat = presentVerdictCaveat(rec.synthesisReport.verdictCard);
      if (caveat) expect(answerText).toContain(htmlText(caveat));
    }
    // Uncertainty sections stay visible in readable mode exactly when classic shows them.
    const classic = renderPanel(rec, rows);
    if (classic.includes(">Uncertainties<")) expect(html).toContain(">Uncertainties<");
  });

  it.each(PILOT_SCENARIOS)("%s: no readable trust value is stronger than classic's stored gate, and none says verified", (name) => {
    const rec = record(name);
    const trust = tierHtml(renderPanel(rec, slotRows(name), READABLE), "trust")!;
    const shown = signalValue(trust, "gate");
    const stored = rec.synthesisReport ? readGateStatus(rec.synthesisReport.gate) : rec.gate ? readGateStatus(rec.gate.status) : null;
    expect(shown).toBe(stored ? GATE_STATUS_WORD[stored] : READABLE_TRUST_COPY.gateNotRecorded);
    expect(htmlText(trust)).not.toMatch(/verified|consensus/i);
    expect(signalValue(trust, "sources")).not.toMatch(/%/);
  });
});

// ── E. accessibility ────────────────────────────────────────────────────────

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => textOf(c as any)).join("");
}

async function mountReadable(rec: any, rows: any) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(panelElement(rec, rows, READABLE));
  });
  return r;
}

describe("E. accessibility", () => {
  it.each([["remote-work"], ["generic-mixed"], ["financial-valuation"], ["creative"]])("%s: headings, names, descriptions, text values", async (name) => {
    const { rec, rows } = name === "remote-work" ? remoteWorkFixture() : { rec: record(name), rows: slotRows(name) };
    const r = await mountReadable(rec, rows);
    const byId = (id: string) => r.root.find((n) => typeof n.type === "string" && n.props.id === id);

    for (const tier of ["answer", "trust"]) {
      const section = r.root.find((n) => n.type === "section" && n.props["data-readable-tier"] === tier);
      const heading = byId(section.props["aria-labelledby"]);
      expect(heading.type).toBe("h2");
      expect(textOf(heading).trim().length).toBeGreaterThan(0);
      // Heading hierarchy inside each lead section: starts at h2 and never skips a level.
      const levels = section.findAll((n) => typeof n.type === "string" && /^h[1-6]$/.test(n.type as string)).map((n) => Number((n.type as string)[1]));
      expect(levels[0]).toBe(2);
      for (let i = 1; i < levels.length; i += 1) expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1);
    }

    const groups = r.root.findAll((n) => typeof n.type === "string" && n.props.role === "group" && n.props["data-trust-signal"] !== undefined);
    expect(groups.map((g) => g.props["data-trust-signal"])).toEqual(["gate", "coverage", "sources", "behaviour"]);
    const names = new Set<string>();
    for (const g of groups) {
      const name = byId(g.props["aria-labelledby"]);
      const description = byId(g.props["aria-describedby"]);
      expect(name.type).toBe("h3");
      expect(textOf(name).trim().length).toBeGreaterThan(0);
      expect(textOf(description).trim().length).toBeGreaterThan(20);
      names.add(textOf(name));
      // The value is words or counts, never colour alone.
      const value = g.find((n) => n.props["data-trust-signal-value"] !== undefined);
      expect(textOf(value).trim().length).toBeGreaterThan(0);
    }
    expect(names.size).toBe(4);
  });

  it("the trust panel carries no status colour at all (meaning is in the words)", () => {
    const { rec, rows } = remoteWorkFixture();
    const trust = tierHtml(renderPanel(rec, rows, READABLE), "trust")!;
    expect(trust).not.toMatch(/\b(?:bg|text|border)-(?:red|green|emerald|amber|rose|orange|yellow|lime)-/);
  });

  it("the missing-synthesis link points at an element that exists", () => {
    const rec = caseRecord("generic-mixed", "fail", "missing");
    const html = renderPanel(rec, slotRows("generic-mixed"), READABLE);
    expect(html).toContain('href="#readable-model-responses"');
    expect(html).toContain('id="readable-model-responses"');
  });
});

// ── F. Personal / Team parity ───────────────────────────────────────────────

describe("F. Personal and Team share the renderer", () => {
  const presentation = (rec: any, rows: any) =>
    ({
      runId: "run-290",
      viewerRole: "owner",
      question: QUESTION,
      results: rows,
      adaptive: { ...rec, generatedAt: "2026-10-01T00:00:00.000Z" },
      restoreNotice: null,
      synthesisReport: null,
      synthesisConsensusSummary: null,
      orgGovernanceStatus: null,
      governance: undefined,
      governanceContext: { policyVersion: null, decidedAt: null, timeSensitiveGeneratedAt: null },
    }) as any;
  const stripIds = (html: string) => html.replace(/\s(?:id|aria-labelledby|aria-describedby)="[^"]*"/g, "");

  it.each([["remote-work"], ["generic-mixed"], ["procedural"]])("%s: readable answer + trust are identical for Personal (default) and Team (delegated_read_only)", (name) => {
    const { rec, rows } = name === "remote-work" ? remoteWorkFixture() : { rec: record(name), rows: slotRows(name) };
    const personal = renderToStaticMarkup(createElement(PersistedResearchResultView, { presentation: presentation(rec, rows), reportLayout: "readable" }));
    const team = renderToStaticMarkup(createElement(PersistedResearchResultView, { presentation: presentation(rec, rows), reportLayout: "readable", adaptiveAncillaryPresentation: { kind: "delegated_read_only" } }));
    for (const tier of ["answer", "trust"]) expect(stripIds(tierHtml(team, tier)!)).toBe(stripIds(tierHtml(personal, tier)!));
    // Classic through the same view stays classic when no layout is passed.
    const classic = renderToStaticMarkup(createElement(PersistedResearchResultView, { presentation: presentation(rec, rows) }));
    expect(classic).not.toContain("data-readable-tier");
  });
});

// ── G. export and governance ownership in readable mode (review MAJOR-1, MINOR-1) ──

import AdaptiveExportButton from "@/components/adaptive/AdaptiveExportButton";
import AdaptiveExportHistorySection from "@/components/adaptive/AdaptiveExportHistorySection";
import ReviewGovernanceSection from "@/components/adaptive/ReviewGovernanceSection";
import { readFileSync } from "fs";
import { join } from "path";
import { SCANNED_ROOTS } from "@/lib/adaptiveSchema/__tests__/o5p/vocabularyScanner";

async function mountWith(rec: any, rows: any, extra: Record<string, unknown>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(panelElement(rec, rows, extra));
  });
  return r;
}
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);
const DELEGATED = {
  kind: "delegated_read_only",
  exportSurface: createElement("div", { "data-testid": "team-export-surface" }),
  exportHistorySurface: createElement("div", { "data-testid": "team-export-history-surface" }),
  reviewGovernanceSurface: createElement("div", { "data-testid": "team-review-governance-surface" }),
};

describe("G. readable mode keeps the export and governance ownership decisions", () => {
  it.each(PILOT_SCENARIOS)("%s: Team delegated_read_only mounts no Personal export component and renders the Team surfaces", async (name) => {
    const r = await mountWith(record(name), slotRows(name), { ...READABLE, ancillaryPresentation: DELEGATED });
    expect(r.root.findAllByType(AdaptiveExportButton)).toHaveLength(0);
    expect(r.root.findAllByType(AdaptiveExportHistorySection)).toHaveLength(0);
    expect(r.root.findAllByType(ReviewGovernanceSection)).toHaveLength(0);
    expect(byTestId(r, "team-export-surface")).toHaveLength(1);
    expect(byTestId(r, "team-export-history-surface")).toHaveLength(1);
    expect(byTestId(r, "team-review-governance-surface")).toHaveLength(1);
  });

  it.each(PILOT_SCENARIOS)("%s: Personal default mounts the Personal export button, history and review & governance section exactly once (control)", async (name) => {
    const r = await mountWith(record(name), slotRows(name), READABLE);
    expect(r.root.findAllByType(AdaptiveExportButton)).toHaveLength(1);
    expect(r.root.findAllByType(AdaptiveExportHistorySection)).toHaveLength(1);
    expect(r.root.findAllByType(ReviewGovernanceSection)).toHaveLength(1);
    // The governance section sits in the details tier, after the trust signals.
    const details = r.root.find((n) => n.props["data-readable-tier"] === "details");
    expect(details.findAllByType(ReviewGovernanceSection)).toHaveLength(1);
  });

  it("ReadableSummaryBar: one export decision, the same source shape as TopSummaryBar's pinned one", () => {
    const bar = readFileSync(join(process.cwd(), "components/research/readable/ReadableSummaryBar.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(bar.match(/<AdaptiveExportButton\b/g) ?? []).toHaveLength(1);
    expect(bar.match(/<AdaptiveExportHistorySection\b/g) ?? []).toHaveLength(1);
    expect(bar).toMatch(/const exportControl = ancillary\.kind === "delegated_read_only" \? \(ancillary\.exportSurface \?\? null\) : <AdaptiveExportButton runId=\{runId\} \/>;/);
    expect(bar).toMatch(/const exportHistory = ancillary\.kind === "delegated_read_only" \? \(ancillary\.exportHistorySurface \?\? null\) : <AdaptiveExportHistorySection runId=\{runId\} \/>;/);
  });

  it("the readable branch passes the same resolved policy object to ReadableSummaryBar", () => {
    const panel = readFileSync(join(process.cwd(), "components/adaptive/AdaptivePanelResponse.tsx"), "utf8");
    expect(panel).toMatch(/<ReadableSummaryBar[\s\S]*?ancillaryPresentation=\{ancillary\}/);
  });
});

describe("H. the readable copy is inside the vocabulary gate (review MAJOR-2)", () => {
  it("SCANNED_ROOTS includes both readable roots", () => {
    expect(SCANNED_ROOTS).toEqual(expect.arrayContaining(["lib/research/readableReport", "components/research/readable"]));
  });
});
