/**
 * #290 Increment 1 — review of 082a2a7 NOT CLEAN (MINOR-1, MINOR-2) and the owner ruling that followed.
 *
 *   MINOR-1: on an inconsistent legacy record the readable "Verification gate: Unavailable — …" banner kept the stored
 *            status colour (green for a stored pass, red for a stored fail).
 *   MINOR-2: the same page still showed the raw stored gate — the Model Responses header badge "gate: pass", the Panel
 *            Verdict badge "pass" (governance section and full synthesis report) — beside "Unavailable".
 *
 * Owner ruling: every readable gate display (banner words and tone, both Panel Verdict badges and accents, the Model
 * Responses header badge, the trust signal) comes from ONE presentation-only status. An inconsistent legacy record is
 * neutral and "Unavailable" everywhere; a consistent one shows its stored status with that status's tone everywhere;
 * Order 4 reports are unchanged; classic is unchanged.
 *
 * Every case renders the COMPLETE page through the real AdaptivePanelResponse. Gate elements are found by their CONTENT
 * and class names in the decoded HTML (not only by the readable data attribute), so a raw badge or a coloured tone is
 * caught wherever it is. Expected words and classes are written out literally here, not read from the code under test.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { GATE_THRESHOLDS } from "@/lib/adaptiveSchema/config";
import { hasGatePresentation, pageGateValue, readGateStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { htmlText, record, remoteWorkFixture, renderPanel, slotRows, tierHtml } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };
type Known = "pass" | "caution" | "fail";

const KIND = "This is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";
const UNAVAILABLE_BANNER =
  "Verification gate: Unavailable — the stored result is inconsistent with its recorded inputs. The gate is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";
const STORED_TEXT_NOTE = "Text stored with this report (such as the answer or the certainty line) may name a gate result. That stored text is reproduced as written; it is not the gate result.";
const UNAVAILABLE_LABEL = "Verification gate: Unavailable";
const WORD: Record<Known, string> = { pass: "Pass", caution: "Caution", fail: "Fail" };

/** The tone classes each gate display uses (AdaptiveSynthesisReportView / ListView style maps), written out. */
const TONE_MARK: Record<Known | "neutral", string> = { pass: "green-50", caution: "amber-50", fail: "red-50", neutral: "slate-50" };
const ACCENT: Record<Known | "neutral", string> = { pass: "bg-emerald-400", caution: "bg-amber-400", fail: "bg-red-400", neutral: "bg-slate-300" };
/** Any status colour on a gate display. */
const STATUS_COLOUR = /\b(bg|text|border)-(green|emerald|red|amber)-\d+\b/;

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── HTML helpers (decoded text, class names) ───────────────────────────────

interface El {
  tag: string;
  cls: string;
  /** data-readable-gate, or null when absent. */
  gateAttr: string | null;
  text: string;
  outer: string;
}

/** The balanced element whose opening tag starts at `open`. */
function elementAt(html: string, open: number): El {
  const head = /^<([a-z0-9]+)([^>]*)>/i.exec(html.slice(open))!;
  const tag = head[1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "gi");
  re.lastIndex = open;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      const outer = html.slice(open, m.index + m[0].length);
      return { tag, cls: /class="([^"]*)"/.exec(head[2])?.[1] ?? "", gateAttr: /data-readable-gate="([^"]*)"/.exec(head[2])?.[1] ?? null, text: htmlText(outer), outer };
    }
  }
  throw new Error("unbalanced element");
}

/** Every element of the given tag whose class list contains all of `classes`. */
function elementsWithClasses(html: string, tag: string, classes: string[]): El[] {
  const out: El[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*class="([^"]*)"[^>]*>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (classes.every((c) => m![1].split(/\s+/).includes(c))) out.push(elementAt(html, m.index));
  return out;
}

/** The page's gate displays, found by their markup (independent of the readable data attribute). */
function gateDisplays(html: string) {
  // GateBanner: <div class="rounded-xl border px-4 py-3 text-sm font-medium …">.
  const banners = elementsWithClasses(html, "div", ["rounded-xl", "border", "px-4", "py-3", "text-sm", "font-medium"]);
  // Pill badges: the Panel Verdict badge and the Model Responses run-header chip (rounded-full, text-xs font-medium,
  // with a gate tone from the style maps). Gate pills are told apart from other pills by their words.
  const pills = elementsWithClasses(html, "span", ["inline-flex", "rounded-full", "border", "px-2", "py-0.5", "text-xs", "font-medium"]);
  const gatePills = pills.filter((p) => /^(Verification gate: \w+|gate: \w+|pass|caution|fail)$/i.test(p.text));
  const verdictCards = elementsWithClasses(html, "div", ["relative", "rounded-xl", "p-6", "overflow-hidden"]).filter((c) => c.text.includes("Panel Verdict"));
  const accents = elementsWithClasses(html, "div", ["absolute", "left-0", "top-0", "h-1.5", "w-full"]);
  return { banners, gatePills, verdictCards, accents };
}

/** Raw stored-gate badge forms the readable page must never show: "pass", "gate: pass", … */
const RAW_BADGE = /^(gate: )?(pass|caution|fail)$/i;
/** Any gate result wording, D6 label or legacy chip form, anywhere in a text. */
const GATE_RESULT_TEXT = /Verification gate: (Pass|Caution|Fail)\b|\bgate: (pass|caution|fail)\b/i;

/** The page text with every stored narrative string removed (stored text is shown as written — never edited). */
function textOutsideStoredNarrative(html: string, rec: any): string {
  let text = htmlText(html);
  const r = rec.synthesisReport;
  const stored = [r.unifiedAnswer, r.certaintyAssessment, r.executiveSummary, ...(Array.isArray(r.whereModelsAgree) ? r.whereModelsAgree : [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .sort((a, b) => b.length - a.length);
  for (const s of stored) text = text.split(s).join(" ");
  return text;
}

const legacy = (rec: any) => {
  expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
  delete rec.synthesisReport.presentation;
  expect(hasGatePresentation(rec.synthesisReport)).toBe(false);
  return rec;
};

// ── Cases ──────────────────────────────────────────────────────────────────

interface Conflict {
  label: string;
  base: string;
  /** The stored value the page reads (pageGateValue). */
  stored: Known;
  make?: () => any;
  edit?: (rec: any) => void;
  /** The conflict, stated on the stored fields (not from the code under test). */
  conflict: (rec: any) => void;
}

const differsFromRealGate = (rec: any) => expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).not.toBe(rec.synthesisReport.gate);

const CONFLICTS: Conflict[] = [
  {
    label: "stored PASS, certainty below the pass threshold",
    base: "generic-malformed",
    stored: "pass",
    edit: (rec) => ((rec.gate.status = "pass"), (rec.synthesisReport.gate = "pass")),
    conflict: (rec) => (expect(rec.gate.runCertainty).toBeLessThan(GATE_THRESHOLDS.passMin), differsFromRealGate(rec)),
  },
  {
    label: "stored PASS, two load-bearing splits recorded",
    base: "legal-regulatory",
    stored: "pass",
    edit: (rec) => ((rec.gate.status = "pass"), (rec.synthesisReport.gate = "pass")),
    conflict: (rec) => (expect(rec.gate.loadBearingSplitCount).toBeGreaterThanOrEqual(2), differsFromRealGate(rec)),
  },
  {
    label: "stored PASS, recorded split count disagrees with the recorded load-bearing claims",
    base: "contested-empirical",
    stored: "pass",
    edit: (rec) => ((rec.gate.loadBearingSplitCount = 0), (rec.gate.status = "pass"), (rec.synthesisReport.gate = "pass")),
    conflict: (rec) => expect(rec.gate.loadBearingClaims.filter((c: any) => c.status === "split").length).not.toBe(rec.gate.loadBearingSplitCount),
  },
  {
    label: "stored CAUTION over full certainty and no split",
    base: "generic-consensus",
    stored: "caution",
    edit: (rec) => ((rec.gate.status = "caution"), (rec.synthesisReport.gate = "caution")),
    conflict: (rec) => (expect(rec.gate.runCertainty).toBeGreaterThanOrEqual(GATE_THRESHOLDS.passMin), expect(rec.gate.loadBearingSplitCount).toBe(0), differsFromRealGate(rec)),
  },
  {
    label: "stored FAIL over inputs that give caution (remote-work shape)",
    base: "generic-substituted-and-failed",
    stored: "fail",
    make: () => remoteWorkFixture().rec,
    conflict: (rec) => (expect(rec.gate.loadBearingSplitCount).toBeLessThan(2), expect(rec.gate.runCertainty).toBeGreaterThanOrEqual(GATE_THRESHOLDS.cautionMin), differsFromRealGate(rec)),
  },
  {
    label: "stored FAIL over full certainty and no split",
    base: "generic-consensus",
    stored: "fail",
    edit: (rec) => ((rec.gate.status = "fail"), (rec.synthesisReport.gate = "fail")),
    conflict: differsFromRealGate,
  },
  {
    label: "report says FAIL, gate object says pass",
    base: "generic-consensus",
    stored: "fail",
    edit: (rec) => ((rec.gate.status = "pass"), (rec.synthesisReport.gate = "fail")),
    conflict: (rec) => expect(rec.gate.status).not.toBe(rec.synthesisReport.gate),
  },
  {
    label: "report says PASS, gate object says fail",
    base: "generic-consensus",
    stored: "pass",
    edit: (rec) => ((rec.gate.status = "fail"), (rec.synthesisReport.gate = "pass")),
    conflict: (rec) => expect(rec.gate.status).not.toBe(rec.synthesisReport.gate),
  },
  {
    label: "report says CAUTION, gate object says pass",
    base: "generic-consensus",
    stored: "caution",
    edit: (rec) => ((rec.gate.status = "pass"), (rec.synthesisReport.gate = "caution")),
    conflict: (rec) => expect(rec.gate.status).not.toBe(rec.synthesisReport.gate),
  },
];

const build = (c: { base: string; make?: () => any; edit?: (rec: any) => void }) => {
  const rec = c.make ? c.make() : record(c.base);
  c.edit?.(rec);
  return rec;
};

// ── Inconsistent legacy records ────────────────────────────────────────────

describe("inconsistent legacy record, readable: Unavailable and neutral on every gate display; no raw badge, no status colour", () => {
  it.each(CONFLICTS.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    const rec = legacy(build(c));
    c.conflict(rec);
    expect(readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status))).toBe(c.stored);
    const before = JSON.stringify(rec);
    const html = renderPanel(rec, slotRows(c.base), READABLE);
    expect(JSON.stringify(rec)).toBe(before); // stored data read, never written

    const { banners, gatePills, verdictCards, accents } = gateDisplays(html);

    // Both banners (governance + full synthesis report): the unavailable words and note, neutral tone.
    expect(banners.map((b) => b.text)).toEqual([`${UNAVAILABLE_BANNER} ${STORED_TEXT_NOTE}`, `${UNAVAILABLE_BANNER} ${STORED_TEXT_NOTE}`]);
    for (const b of banners) {
      expect(b.cls).toContain(TONE_MARK.neutral);
      expect(b.cls).not.toMatch(STATUS_COLOUR);
      expect(b.gateAttr).toBe("unavailable");
    }

    // Gate pills: two Panel Verdict badges + the Model Responses header badge — all "Verification gate: Unavailable",
    // neutral; no raw "pass" / "gate: pass" pill anywhere on the page.
    expect(gatePills.map((p) => p.text)).toEqual([UNAVAILABLE_LABEL, UNAVAILABLE_LABEL, UNAVAILABLE_LABEL]);
    for (const p of gatePills) {
      expect(p.text).not.toMatch(RAW_BADGE);
      expect(p.cls).toContain(TONE_MARK.neutral);
      expect(p.cls).not.toMatch(STATUS_COLOUR);
      expect(p.gateAttr).toBe("unavailable");
    }
    // The Model Responses header badge specifically (MINOR-2's "gate: pass").
    const responses = elementAt(html, html.lastIndexOf("<", html.indexOf('id="readable-model-responses"')));
    expect(gateDisplays(responses.outer).gatePills.map((p) => p.text)).toEqual([UNAVAILABLE_LABEL]);

    // Panel Verdict cards: neutral accent bar, never the stored status's.
    expect(verdictCards).toHaveLength(2);
    expect(accents.map((a) => a.cls.split(/\s+/).pop())).toEqual([ACCENT.neutral, ACCENT.neutral]);

    // The trust signal: Unavailable, with the stored-text note.
    const trust = htmlText(tierHtml(html, "trust")!);
    expect(trust).toContain("Unavailable");
    expect(trust).toContain(STORED_TEXT_NOTE);

    // Outside the stored narrative text, no gate result in any form (D6 label, raw chip form) is on the page.
    const outside = textOutsideStoredNarrative(html, rec);
    expect(outside).not.toMatch(GATE_RESULT_TEXT);
    // Stored text is shown as written (never edited): the certainty line keeps its stored "(gate: …)" words, and the
    // note beside the unavailable state says such words are stored text, not the gate result.
    if (/\(gate: \w+\)/.test(rec.synthesisReport.certaintyAssessment)) expect(htmlText(html)).toContain(rec.synthesisReport.certaintyAssessment.replace(/\s+/g, " ").trim());
  });

  it("control: the detectors are live — the CLASSIC page of the same inconsistent record shows a raw chip, a raw badge and a status colour", () => {
    const c = CONFLICTS.find((x) => x.label.startsWith("stored PASS, certainty"))!;
    const rec = legacy(build(c));
    const html = renderPanel(rec, slotRows(c.base));
    const { banners, gatePills, accents } = gateDisplays(html);
    expect(gatePills.map((p) => p.text)).toEqual(expect.arrayContaining(["gate: pass", "pass"]));
    expect(gatePills.some((p) => RAW_BADGE.test(p.text))).toBe(true);
    expect(banners.some((b) => STATUS_COLOUR.test(b.cls))).toBe(true);
    expect(accents.some((a) => a.cls.includes(ACCENT.pass))).toBe(true);
    expect(textOutsideStoredNarrative(html, rec)).toMatch(GATE_RESULT_TEXT);
  });
});

// ── Consistent legacy records ──────────────────────────────────────────────

const CONSISTENT: Array<{ label: string; base: string; stored: Known; edit?: (rec: any) => void }> = [
  { label: "legacy PASS (generic-consensus)", base: "generic-consensus", stored: "pass" },
  { label: "legacy PASS (procedural)", base: "procedural", stored: "pass" },
  { label: "legacy CAUTION (contested-empirical)", base: "contested-empirical", stored: "caution" },
  { label: "legacy CAUTION (generic-splits)", base: "generic-splits", stored: "caution" },
  { label: "legacy FAIL (legal-regulatory)", base: "legal-regulatory", stored: "fail" },
  {
    label: "legacy PASS, gate inputs not recorded (missing is not inconsistent)",
    base: "generic-consensus",
    stored: "pass",
    edit: (rec) => {
      delete rec.gate.runCertainty;
      delete rec.gate.loadBearingSplitCount;
      delete rec.gate.loadBearingClaims;
    },
  },
];

describe("consistent legacy record, readable: every gate display shows the stored status with that status's tone", () => {
  it.each(CONSISTENT.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    const rec = legacy(build(c));
    if (rec.gate.runCertainty !== undefined) expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).toBe(c.stored);
    const html = renderPanel(rec, slotRows(c.base), READABLE);
    const { banners, gatePills, accents } = gateDisplays(html);
    const label = `Verification gate: ${WORD[c.stored]}`;

    expect(banners.map((b) => b.text)).toEqual([`${label}. ${KIND}`, `${label}. ${KIND}`]);
    expect(gatePills.map((p) => p.text)).toEqual([label, label, label]);
    for (const el of [...banners, ...gatePills]) {
      expect(el.cls).toContain(TONE_MARK[c.stored]);
      expect(el.gateAttr).toBe(c.stored);
      expect(el.text).not.toMatch(RAW_BADGE);
    }
    expect(accents.map((a) => a.cls.split(/\s+/).pop())).toEqual([ACCENT[c.stored], ACCENT[c.stored]]);
    expect(htmlText(html)).not.toMatch(/Unavailable/);
    expect(htmlText(tierHtml(html, "trust")!)).toContain(WORD[c.stored]);
    // No raw chip / bare badge form, and no other status's label.
    for (const other of (["pass", "caution", "fail"] as Known[]).filter((s) => s !== c.stored)) expect(textOutsideStoredNarrative(html, rec)).not.toContain(`Verification gate: ${WORD[other]}`);
    expect(textOutsideStoredNarrative(html, rec)).not.toMatch(/\bgate: (pass|caution|fail)\b/);
  });
});

// ── M18: report.gate unrecognized, gate.status recognized ─────────────────

describe("report's stored gate unrecognized while the gate object's status is known (mutant M18)", () => {
  it.each(["verified-ish", 7, null])("report.gate %p over gate.status 'pass': Unrecognized and neutral everywhere, never the gate object's 'pass'", (bad) => {
    const rec = legacy(record("generic-consensus"));
    rec.synthesisReport.gate = bad;
    expect(rec.gate.status).toBe("pass");
    const html = renderPanel(rec, slotRows("generic-consensus"), READABLE);
    const { banners, gatePills, accents } = gateDisplays(html);
    expect(banners.map((b) => b.text)).toEqual(["Verification gate: Unrecognized", "Verification gate: Unrecognized"]);
    expect(gatePills.map((p) => p.text)).toEqual(["Verification gate: Unrecognized", "Verification gate: Unrecognized", "Verification gate: Unrecognized"]);
    for (const el of [...banners, ...gatePills]) {
      expect(el.cls).toContain(TONE_MARK.neutral);
      expect(el.cls).not.toMatch(STATUS_COLOUR);
      expect(el.gateAttr).toBe("unrecognized");
    }
    expect(accents.map((a) => a.cls.split(/\s+/).pop())).toEqual([ACCENT.neutral, ACCENT.neutral]);
    expect(htmlText(tierHtml(html, "trust")!)).toContain("Unrecognized");
    expect(htmlText(html)).not.toContain("Unavailable");
    expect(textOutsideStoredNarrative(html, rec)).not.toMatch(GATE_RESULT_TEXT);
  });
});

// ── Order 4 reports: unchanged ─────────────────────────────────────────────

describe("Order 4 report, readable: the gate displays are the classic ones (words and tone), even over a conflict", () => {
  const ORDER4 = [
    ...CONSISTENT.filter((c) => !c.edit).map((c) => ({ label: c.label.replace("legacy", "Order 4"), base: c.base, edit: undefined as ((rec: any) => void) | undefined, make: undefined as (() => any) | undefined })),
    ...CONFLICTS.map((c) => ({ label: `Order 4, ${c.label}`, base: c.base, edit: c.edit, make: c.make })),
  ];
  it.each(ORDER4.map((c) => [c.label, c] as const))("%s", (_label, c) => {
    const rec = build(c);
    expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status)) as Known;
    const rows = slotRows(c.base);
    const readable = gateDisplays(renderPanel(rec, rows, READABLE));
    const classic = gateDisplays(renderPanel(rec, rows));
    const label = `Verification gate: ${WORD[stored]}`;
    expect(readable.banners.map((b) => b.text)).toEqual([label, label]);
    expect(readable.gatePills.map((p) => p.text)).toEqual([label, label, label]);
    // Same element markup as classic, but for the readable data attribute.
    const strip = (o: string) => o.replace(/ data-readable-gate="[^"]*"/g, "");
    expect(readable.banners.map((b) => strip(b.outer))).toEqual(classic.banners.map((b) => b.outer));
    expect(readable.gatePills.map((p) => strip(p.outer)).sort()).toEqual(classic.gatePills.map((p) => p.outer).sort());
    expect(readable.accents.map((a) => a.outer)).toEqual(classic.accents.map((a) => a.outer).slice(0, readable.accents.length));
    for (const el of [...readable.banners, ...readable.gatePills]) expect(el.cls).toContain(TONE_MARK[stored]);
  });
});

// ── Classic: unchanged ─────────────────────────────────────────────────────

describe("classic, same fixtures: no readable gate presentation reaches it; the historical raw forms remain", () => {
  const ALL = [
    ...CONFLICTS.map((c) => ({ label: c.label, base: c.base, edit: c.edit, make: c.make })),
    ...CONSISTENT.map((c) => ({ label: c.label, base: c.base, edit: c.edit, make: undefined as (() => any) | undefined })),
  ];
  it.each(ALL.flatMap((c) => (["legacy", "order4"] as const).map((v) => [c.label, v, c] as const)))("%s (%s)", (_label, variant, c) => {
    const rec = build(c);
    if (variant === "legacy") legacy(rec);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status)) as Known;
    const html = renderPanel(rec, slotRows(c.base));
    expect(html).not.toContain("data-readable-gate");
    expect(html).not.toContain("Unavailable");
    expect(html).not.toContain(STORED_TEXT_NOTE);
    const { gatePills, accents } = gateDisplays(html);
    const pills = gatePills.map((p) => p.text).sort();
    if (variant === "legacy") expect(pills).toEqual([`gate: ${stored}`, stored, stored].sort());
    else expect(pills).toEqual([`Verification gate: ${WORD[stored]}`, `Verification gate: ${WORD[stored]}`, `Verification gate: ${WORD[stored]}`]);
    for (const a of accents) expect(a.cls).toContain(ACCENT[stored]);
  });
});

// ── One presentation object, computed once ─────────────────────────────────

describe("the readable page computes the gate presentation ONCE and hands the same object to every gate display", () => {
  it.each(["legacy inconsistent", "legacy consistent", "order4"] as const)("%s", async (kind) => {
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { panelElement } = require("./readableFixtures");
    const { GateBanner, PanelVerdictCard } = require("@/components/adaptive/AdaptiveSynthesisReportView");
    const ListView = require("@/components/adaptive/ListView").default;
    const TrustSignalsPanel = require("@/components/research/readable/TrustSignalsPanel").default;
    const rec = record("generic-consensus");
    if (kind !== "order4") legacy(rec);
    if (kind === "legacy inconsistent") (rec.gate.status = "fail"), (rec.synthesisReport.gate = "fail");
    let r: any;
    await act(async () => {
      r = TestRenderer.create(panelElement(rec, slotRows("generic-consensus"), READABLE));
    });
    const shared = r.root.findByType(TrustSignalsPanel).props.gatePresentation;
    expect(shared).toBeDefined();
    const banners = r.root.findAllByType(GateBanner).map((n: any) => n.props.readable);
    const cards = r.root.findAllByType(PanelVerdictCard).map((n: any) => n.props.readable);
    const lists = r.root.findAllByType(ListView).map((n: any) => n.props.readableGate);
    expect([banners.length, cards.length, lists.length]).toEqual([2, 2, 1]);
    for (const p of [...banners, ...cards, ...lists]) expect(p).toBe(shared);
    expect(shared.status).toBe({ "legacy inconsistent": "unavailable", "legacy consistent": "pass", order4: "pass" }[kind]);
  });
});
