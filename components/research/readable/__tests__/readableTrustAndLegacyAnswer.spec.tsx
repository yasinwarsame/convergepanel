/**
 * #290 Increment 1 — review MINOR M-1 and M-2 on 6bcc234.
 *
 *   M-1. The readable report states no "Panel reliability" score, no per-model citation / sources-named percentage cells
 *        and no "Citations" / "Sources named" column anywhere — the four trust signals are the one place those are
 *        stated. Asserted structurally on the COMPLETE mounted readable report (every collapsed section's content is
 *        mounted: Panel Evidence, Model Responses, Review & Governance with its full synthesis report), never by an
 *        adjacency regex. Classic still renders the trust summary table (parity).
 *   M-2. A report persisted without `presentation.answer` (the legacy answer path): the stored answer text comes first
 *        in the answer section, the stored gate lead (AnswerLead, frozen wording) follows it, headings stay honest
 *        (degraded is never headed "Answer"), and nothing reads stronger than the stored gate.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { AgreementDisagreementMap, AnswerLead, TrustSummaryTable } from "@/components/adaptive/AdaptiveSynthesisReportView";
import AdaptiveSynthesisReportView from "@/components/adaptive/AdaptiveSynthesisReportView";
import ListView from "@/components/adaptive/ListView";
import PanelEvidenceSection from "@/components/adaptive/PanelEvidenceSection";
import ReviewGovernanceSection from "@/components/adaptive/ReviewGovernanceSection";
import { ANALYSIS_NOTICE_LINES } from "@/components/adaptive/AnalysisAvailabilityNotice";
import { GATE_LABEL, GATE_STATUS_WORD, LEGACY_GATE_BANNER_LABEL, UNRECOGNIZED_GATE_NOTICE, readGateStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { READABLE_ANSWER_COPY, READABLE_TRUST_COPY } from "@/lib/research/readableReport/copy";
import { READABLE_MODEL_RESPONSES_ANCHOR } from "@/components/research/readable/ExecutiveAnswer";
import { PILOT_SCENARIOS, htmlText, panelElement, record, remoteWorkFixture, renderPanel, slotRows, tierHtml } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => textOf(c as any)).join("");
}
const host = (n: ReactTestInstance) => typeof n.type === "string";
const hostsOf = (root: ReactTestInstance, tag: string) => root.findAll((n) => n.type === tag);

async function mount(rec: any, rows: any, extra: Record<string, unknown> = {}) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(panelElement(rec, rows, extra));
  });
  return r;
}

/** Every <details> whose own <summary> reads `label`. */
function detailsNamed(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll((n) => n.type === "details" && n.children.some((c) => typeof c !== "string" && c.type === "summary" && textOf(c).trim() === label));
}

/** One row per <table>: its header cells' text and its body rows' cell texts. */
function tables(root: ReactTestInstance) {
  return hostsOf(root, "table").map((t) => ({
    headers: hostsOf(t, "th").map((th) => textOf(th).trim()),
    rows: hostsOf(t, "tr")
      .map((tr) => hostsOf(tr, "td").map((td) => textOf(td).trim()))
      .filter((cells) => cells.length > 0),
  }));
}

const TRUST_TABLE_HEADERS = ["Citations", "Sources named", "Trust", "Majority align", "Stance match"];
const PCT_CELL = /^\d{1,3}%!?$/;

const M1_FIXTURES: [string, () => { rec: any; rows: any }][] = [
  ...PILOT_SCENARIOS.map((n) => [n, () => ({ rec: record(n), rows: slotRows(n) })] as [string, () => { rec: any; rows: any }]),
  ["generic-malformed", () => ({ rec: record("generic-malformed"), rows: slotRows("generic-malformed") })],
  ["remote-work", remoteWorkFixture],
];

// ── M-1 ─────────────────────────────────────────────────────────────────────

describe("M-1. the readable report states no panel reliability score and no per-model citation percentages", () => {
  it.each(M1_FIXTURES)("%s: complete readable report", async (_name, make) => {
    const { rec, rows } = make();
    const r = await mount(rec, rows, READABLE);
    const root = r.root;
    const hasSynthesis = !!(rec.gate && rec.synthesisReport);

    // The table component is mounted nowhere — not in Panel Evidence, not in the governance section's full report.
    expect(root.findAllByType(TrustSummaryTable)).toHaveLength(0);

    // The collapsed sections' contents ARE mounted (so the checks below see them), Panel Evidence included.
    if (hasSynthesis) {
      const evidence = detailsNamed(root, "Panel Evidence");
      expect(evidence).toHaveLength(1);
      expect(evidence[0].findAllByType(AgreementDisagreementMap)).toHaveLength(1);
      expect(root.findAllByType(PanelEvidenceSection)[0].props.trustSummary).toBeUndefined();
      // The governance section's full synthesis report is mounted, with no trust summary handed to it.
      const full = root.findAllByType(AdaptiveSynthesisReportView);
      expect(full).toHaveLength(1);
      expect(full[0].props.trustSummary).toBeUndefined();
      expect(detailsNamed(root, "Full synthesis report")).toHaveLength(1);
      expect(root.findAllByType(ReviewGovernanceSection)).toHaveLength(1);
    }

    // Structurally: no table has a trust-summary column, and no table row holds a percentage cell.
    for (const t of tables(root)) {
      for (const h of TRUST_TABLE_HEADERS) expect(t.headers).not.toContain(h);
      for (const cells of t.rows) for (const cell of cells) expect(cell).not.toMatch(PCT_CELL);
    }
    // No host element anywhere states a panel reliability score or the trust summary heading.
    const allText = textOf(root);
    expect(allText).not.toContain("Panel reliability");
    expect(root.findAll((n) => host(n) && n.children.length === 1 && textOf(n).trim() === "Trust summary")).toHaveLength(0);

    // Model Responses: the per-model stored score is named as the trust signals name it, never "trust N%".
    if (hasSynthesis) {
      const list = root.findAllByType(ListView);
      expect(list).toHaveLength(1);
      expect(allText).not.toMatch(/trust \d+%/);
      expect(allText).not.toContain("trust capped");
      const scored = rec.trustSummary.perModel.filter((m: any) => rec.results.find((x: any) => x.modelId === m.modelId)?.ok && rec.results.find((x: any) => x.modelId === m.modelId)?.data);
      for (const m of scored) expect(allText).toContain(READABLE_TRUST_COPY.listScoreRow(Math.round(m.trustScore * 100)));
      const sortButtons = hostsOf(list[0], "button").map((b) => textOf(b).trim());
      expect(sortButtons).toContain(READABLE_TRUST_COPY.listScoreSort);
      expect(sortButtons).not.toContain("trust");
      if (scored.some((m: any) => m.capped)) expect(allText).toContain(READABLE_TRUST_COPY.listScoreCapped);
    }
  });

  it("a parsed model whose stored score is capped: readable names it as the signals do, classic keeps its wording", async () => {
    // generic-mixed with its first parsed slot's stored entry marked degraded + capped (stored values, not recomputed).
    const rec = record("generic-mixed");
    const entry = rec.trustSummary.perModel[0];
    expect(rec.results.find((x: any) => x.modelId === entry.modelId).ok).toBe(true);
    entry.capped = true;
    entry.parseHealth = "degraded";
    const rows = slotRows("generic-mixed");
    const readable = textOf((await mount(rec, rows, READABLE)).root);
    expect(readable).toContain(READABLE_TRUST_COPY.listScoreCapped);
    expect(readable).not.toContain("trust capped");
    expect(readable).toContain(READABLE_TRUST_COPY.listScoreRow(Math.round(entry.trustScore * 100)));
    const classic = textOf((await mount(rec, rows)).root);
    expect(classic).toContain("degraded · trust capped");
    expect(classic).not.toContain(READABLE_TRUST_COPY.listScoreCapped);
  });

  it.each(M1_FIXTURES)("%s: classic still renders the trust summary table and the classic score names (parity)", async (_name, make) => {
    const { rec, rows } = make();
    const r = await mount(rec, rows);
    const root = r.root;
    if (!(rec.gate && rec.synthesisReport)) {
      expect(root.findAllByType(TrustSummaryTable)).toHaveLength(0);
      return;
    }
    // Panel Evidence and the governance section's full report each mount the table.
    expect(root.findAllByType(TrustSummaryTable)).toHaveLength(2);
    const trustTables = tables(root).filter((t) => t.headers.includes("Citations"));
    expect(trustTables).toHaveLength(2);
    for (const t of trustTables) {
      expect(t.rows).toHaveLength(rec.trustSummary.perModel.length);
      const col = t.headers.indexOf("Citations");
      for (const [i, cells] of t.rows.entries()) expect(cells[col]).toBe(`${Math.round(rec.trustSummary.perModel[i].citationScore * 100)}%`);
    }
    expect(textOf(root)).toContain(`Panel reliability: ${Math.round(rec.trustSummary.overallTrust * 100)}%`);
    expect(textOf(root)).toMatch(/trust \d+%/);
    expect(hostsOf(root.findByType(ListView), "button").map((b) => textOf(b).trim())).toContain("trust");
  });
});

// ── M-2 ─────────────────────────────────────────────────────────────────────

type Variant = "answer-removed" | "presentation-removed";
interface LegacyCase {
  label: string;
  base: string;
  edit?: (rec: any) => void;
}

const LEGACY_CASES: LegacyCase[] = [
  { label: "recognized pass", base: "generic-consensus" },
  { label: "fail", base: "legal-regulatory" },
  { label: "caution", base: "generic-mixed" },
  {
    label: "unrecognized gate",
    base: "generic-mixed",
    edit: (rec) => {
      rec.gate.status = "verified-ish";
      rec.synthesisReport.gate = "verified-ish";
    },
  },
  { label: "degraded (assembled)", base: "generic-mixed-narrative-fail" },
  {
    label: "degraded flag not recorded",
    base: "generic-mixed",
    edit: (rec) => {
      delete rec.synthesisReport.degraded;
    },
  },
  {
    label: "degraded + unrecognized gate",
    base: "generic-mixed-narrative-fail",
    edit: (rec) => {
      rec.gate.status = 7;
      rec.synthesisReport.gate = 7;
    },
  },
  { label: "partial (one model failed, one substituted)", base: "generic-substituted-and-failed" },
  { label: "partial (two of four parsed)", base: "generic-malformed" },
  { label: "uncertain (many splits)", base: "generic-splits" },
  { label: "contested empirical", base: "contested-empirical" },
  { label: "fail + degraded (remote-work shape)", base: "generic-substituted-and-failed", edit: (rec) => Object.assign(rec, remoteWorkFixture().rec) },
];

function legacyRecord(c: LegacyCase, variant: Variant) {
  const rec = record(c.base);
  c.edit?.(rec);
  expect(rec.synthesisReport.presentation?.answer).toBeTruthy(); // the source record does carry one…
  if (variant === "answer-removed") delete rec.synthesisReport.presentation.answer;
  else delete rec.synthesisReport.presentation;
  expect(rec.synthesisReport.presentation?.answer).toBeUndefined(); // …and the fixture does not.
  return rec;
}

const CASES = LEGACY_CASES.flatMap((c) => (["answer-removed", "presentation-removed"] as Variant[]).map((v) => [c.label, v, c] as const));
const ws = (t: string) => t.replace(/\s+/g, " ").trim();

describe("M-2. legacy answer path (no stored presentation.answer): answer first, then the stored gate lead", () => {
  it.each(CASES)("%s (%s)", (_label, variant, c) => {
    const rec = legacyRecord(c, variant);
    const rows = slotRows(c.base);
    const html = renderPanel(rec, rows, READABLE);
    const answer = tierHtml(html, "answer")!;
    const trust = tierHtml(html, "trust")!;
    const report = rec.synthesisReport;
    const stored = readGateStatus(report.gate);

    // Heading: honest about what the text is.
    const status = report.degraded === false ? "written" : report.degraded === true ? "assembled" : "unknown";
    expect(answer).toContain(`data-answer-status="${status}"`);
    const heading = { written: READABLE_ANSWER_COPY.writtenHeading, assembled: READABLE_ANSWER_COPY.assembledHeading, unknown: READABLE_ANSWER_COPY.unknownHeading }[status];
    const answerText = htmlText(answer);
    expect(answerText.startsWith(heading)).toBe(true);
    if (status !== "written") expect(answerText).not.toMatch(/^Answer\b/);
    if (status === "assembled") expect(answerText).toContain(ANALYSIS_NOTICE_LINES.degraded);

    // The legacy answer text is rendered, in full and verbatim (a stored answer string composed after Order 4 may itself
    // open with its gate sentence — that is the stored answer, shown as stored). Everything the readable layout adds
    // about the gate is measured outside that element: `outside` is the section with the stored text replaced by a mark.
    const textAt = answer.indexOf('data-answer-part="legacy-answer-text"');
    expect(textAt).toBeGreaterThan(-1);
    expect(answerText).toContain(ws(report.unifiedAnswer));
    const storedEl = /<p data-answer-part="legacy-answer-text"[^>]*>[\s\S]*?<\/p>/.exec(answer)![0];
    expect(answer.split(storedEl)).toHaveLength(2);
    const outside = answer.replace(storedEl, "<STORED-ANSWER/>");
    const markAt = outside.indexOf("<STORED-ANSWER/>");
    expect(htmlText(storedEl)).toBe(ws(report.unifiedAnswer));

    // The gate lead: exactly the frozen AnswerLead markup for this stored report (no stronger, no weaker), AFTER the text.
    const lead = renderToStaticMarkup(createElement(AnswerLead, { report }));
    const expectsLead = variant === "answer-removed" || stored === "unrecognized";
    if (expectsLead) {
      expect(lead).toContain(`${GATE_LABEL}: ${GATE_STATUS_WORD[stored]}`);
      expect(answer.split(lead)).toHaveLength(2);
      expect(answer.indexOf(lead)).toBeGreaterThan(textAt);
      // The stored answer precedes every gate statement the layout adds — the first one outside the stored text.
      expect(outside.indexOf(GATE_LABEL)).toBeGreaterThan(markAt);
      expect(outside.indexOf('data-answer-part="gate"')).toBeGreaterThan(markAt);
    } else {
      // A report from before the Order 4 gate presentation with a known gate: no gate line in the answer (as classic).
      expect(lead).toBe("");
      expect(answer).not.toContain('data-answer-part="gate"');
      expect(outside).not.toContain(GATE_LABEL);
    }
    if (stored === "unrecognized") {
      expect(outside).toContain(UNRECOGNIZED_GATE_NOTICE);
      expect(outside.indexOf(UNRECOGNIZED_GATE_NOTICE)).toBeGreaterThan(markAt);
    }

    // Never stronger than stored: the trust panel shows the stored gate word; nothing in the lead reads Pass / verified
    // unless the stored gate is a recognized pass; the frozen legacy banner wording is not used.
    const trustValue = /data-trust-signal="gate"[\s\S]*?data-trust-signal-value=""[^>]*>([^<]*)</.exec(trust)![1];
    expect(trustValue).toBe(GATE_STATUS_WORD[stored]);
    const lead2 = htmlText(answer + trust);
    if (stored !== "pass") expect(lead2).not.toMatch(/\bPass\b/);
    for (const banner of Object.values(LEGACY_GATE_BANNER_LABEL)) expect(lead2).not.toContain(banner);
    expect(lead2.split("not a verified finding").join("")).not.toMatch(/\bverified\b/i);
  });

  it("the classic strip is unchanged by this: classic still leads with AnswerLead before the stored answer (parity)", () => {
    const rec = legacyRecord(LEGACY_CASES[3], "answer-removed");
    const classic = renderPanel(rec, slotRows("generic-mixed"));
    const lead = renderToStaticMarkup(createElement(AnswerLead, { report: rec.synthesisReport }));
    expect(lead).toContain(UNRECOGNIZED_GATE_NOTICE);
    const at = classic.indexOf(lead);
    expect(at).toBeGreaterThan(-1);
    expect(htmlText(classic.slice(at)).indexOf(ws(rec.synthesisReport.unifiedAnswer))).toBeGreaterThan(-1);
    expect(classic).not.toContain("data-readable-tier");
  });
});

// ── NITs ────────────────────────────────────────────────────────────────────

describe("readable anchors (review NITs)", () => {
  it("the Model Responses anchor wrapper is a visible element, and the missing-answer link names it", async () => {
    const rec = record("generic-mixed");
    delete rec.synthesisReport;
    const r = await mount(rec, slotRows("generic-mixed"), READABLE);
    const anchor = r.root.findAll((n) => host(n) && n.props.id === READABLE_MODEL_RESPONSES_ANCHOR);
    expect(anchor).toHaveLength(1);
    expect(anchor[0].type).toBe("div");
    expect(anchor[0].props.hidden).toBeUndefined();
    expect(anchor[0].props.style).toBeUndefined();
    expect(anchor[0].props.className).toBeUndefined();
    const link = r.root.find((n) => n.type === "a" && n.props.href === `#${READABLE_MODEL_RESPONSES_ANCHOR}`);
    expect(textOf(link)).toBe(READABLE_ANSWER_COPY.missingLink);
    expect(READABLE_ANSWER_COPY.missingLink).toBe("Go to Model Responses");
  });
});
