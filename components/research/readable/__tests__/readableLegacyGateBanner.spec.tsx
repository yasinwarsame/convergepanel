/**
 * #290 Increment 1 — review R4 NOT CLEAN (legacy "Verified" banner) and the capped-tooltip nit.
 *
 * A report persisted before the Order 4 gate presentation (no synthesisReport.presentation.verificationGate) renders its
 * gate banner with the frozen historical wording LEGACY_GATE_BANNER_LABEL ("Verified — panel converges", "Caution —
 * partial convergence", "Could not verify — panel split"). On the readable page that banner appears twice (the
 * governance section's Verification gate, and the full synthesis report inside it) and reads as an evidence
 * verification claim. Readable passes the page's one gate presentation (trustSignals.readableGatePresentation) through
 * the optional `readable` / `readableGate` props; classic passes nothing and keeps the historical wording byte for byte.
 *
 * Every case renders the COMPLETE readable report through the real AdaptivePanelResponse (reportLayout "readable"), in
 * two variants: as stored (Order 4 presentation present) and legacy (presentation removed — exactly what a pre-Order-4
 * record looks like). Stored gate values are never edited except where a case says so.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { GateBanner } from "@/components/adaptive/AdaptiveSynthesisReportView";
import ListView from "@/components/adaptive/ListView";
import { TRUST_SCORE_CAP_BY_HEALTH, TRUST_SCORE_CAP_REASON } from "@/lib/adaptiveSchema/config";
import { GATE_STATUS_WORD, LEGACY_GATE_BANNER_LABEL, gateBannerText, gateLabel, hasGatePresentation, pageGateValue, readGateStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { READABLE_GATE_COPY, READABLE_TRUST_COPY } from "@/lib/research/readableReport/copy";
import { readableGatePresentation } from "@/lib/research/readableReport/trustSignals";
import { scanVocabulary } from "@/lib/adaptiveSchema/__tests__/o5p/vocabularyScanner";
import { htmlText, panelElement, record, remoteWorkFixture, renderPanel, slotRows, tierHtml } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };
const NEW_WORDING = Object.values(READABLE_GATE_COPY.legacyBanner);
/** Every readable-only gate banner text, the unavailable one included (classic must carry none). */
const ALL_READABLE_BANNERS = [...NEW_WORDING, READABLE_GATE_COPY.inconsistentBanner];
const LEGACY_WORDING = Object.values(LEGACY_GATE_BANNER_LABEL);
/** As react-dom/server escapes text. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => textOf(c as any)).join("");
}

async function mount(rec: any, rows: any, extra: Record<string, unknown> = {}) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(panelElement(rec, rows, extra));
  });
  return r;
}

interface Case {
  label: string;
  base: string;
  make?: () => any;
  edit?: (rec: any) => void;
  /**
   * Review of cb2febb (MINOR): the stored gate contradicts the record's own stored data (stated here from the fixture,
   * not from the code under test), so a legacy readable page shows the gate as unavailable.
   */
  storedConflict?: true;
}

const CASES: Case[] = [
  { label: "pre-Order-4 pass (all most-raised claims consensus)", base: "generic-consensus" },
  { label: "failed verification gate", base: "legal-regulatory" },
  {
    label: "missing verification evidence (gate inputs not recorded)",
    base: "generic-consensus",
    edit: (rec) => {
      delete rec.gate.runCertainty;
      delete rec.gate.loadBearingSplitCount;
      delete rec.gate.loadBearingClaims;
    },
  },
  { label: "model convergence without checked evidence (procedural pass)", base: "procedural" },
  { label: "model convergence without checked evidence (forecast pass)", base: "forecast" },
  { label: "disagreement (contested empirical)", base: "contested-empirical" },
  { label: "disagreement (many splits)", base: "generic-splits" },
  { label: "degraded coverage (one failed, one substituted)", base: "generic-substituted-and-failed" },
  { label: "degraded coverage (assembled summary)", base: "generic-mixed-narrative-fail" },
  // remoteWorkFixture edits the stored gate to fail; its recorded inputs (69%, one of three split) give caution.
  { label: "degraded coverage + fail (remote-work shape)", base: "generic-substituted-and-failed", make: () => remoteWorkFixture().rec, storedConflict: true },
  {
    // F4: the banner shows the report's stored gate, not the gate object's copy.
    label: "page gate value: gate object says pass, the report says fail",
    base: "generic-consensus",
    edit: (rec) => {
      rec.gate.status = "pass";
      rec.synthesisReport.gate = "fail";
    },
    storedConflict: true,
  },
];

type Variant = "order4" | "legacy";

function build(c: Case, variant: Variant) {
  const rec = c.make ? c.make() : record(c.base);
  c.edit?.(rec);
  expect(hasGatePresentation(rec.synthesisReport)).toBe(true); // every source record carries the Order 4 presentation…
  if (variant === "legacy") delete rec.synthesisReport.presentation;
  expect(hasGatePresentation(rec.synthesisReport)).toBe(variant === "order4"); // …and the legacy fixture does not.
  return { rec, rows: slotRows(c.base) };
}

const MATRIX = CASES.flatMap((c) => (["order4", "legacy"] as Variant[]).map((v) => [c.label, v, c] as const));

/** "verified" outside the fixed "(… not a verified finding)" qualifiers. */
const unqualifiedVerified = (text: string) => /\bverified\b/i.test(text.split("not a verified finding").join(""));

describe("readable: no legacy \"Verified\" banner; the stored gate is stated, agreement is not called verification", () => {
  it.each(MATRIX)("%s (%s)", async (_label, variant, c) => {
    const { rec, rows } = build(c, variant);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status));
    expect(stored).not.toBe("unrecognized");
    const html = renderPanel(rec, rows, READABLE);
    const text = htmlText(html);

    // Answer first, then trust signals, then details (unchanged structure).
    const order = ["header", "answer", "trust", "details"].map((t) => html.indexOf(`data-readable-tier="${t}"`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // The four trust signals are intact, and the gate signal states the stored gate word.
    const trust = tierHtml(html, "trust")!;
    for (const id of ["gate", "coverage", "sources", "behaviour"]) expect(trust).toContain(`data-trust-signal="${id}"`);
    const conflict = variant === "legacy" && c.storedConflict === true;
    expect(/data-trust-signal="gate"[\s\S]*?data-trust-signal-value=""[^>]*>([^<]*)</.exec(trust)![1]).toBe(conflict ? READABLE_GATE_COPY.inconsistentValue : GATE_STATUS_WORD[stored]);
    if (c.label.startsWith("missing")) expect(htmlText(trust)).toContain(READABLE_TRUST_COPY.gateInputsNotRecorded);

    // Nowhere on the readable page: the historical banner wording, or an unqualified "verified".
    for (const legacy of LEGACY_WORDING) expect(text).not.toContain(legacy);
    expect(text).not.toContain("Verified — panel converges");
    expect(text).not.toMatch(/Could not verify/);
    expect(unqualifiedVerified(text)).toBe(false);

    // Every gate banner on the page (governance Verification gate + full synthesis report): the new wording for a
    // legacy report, gatePresentation's neutral label (unchanged) for an Order 4 report.
    const root = (await mount(rec, rows, READABLE)).root;
    const banners = root.findAllByType(GateBanner).map((b) => textOf(b));
    expect(banners).toHaveLength(2);
    const expected = conflict ? READABLE_GATE_COPY.inconsistentBanner : variant === "legacy" ? READABLE_GATE_COPY.legacyBanner[stored as "pass" | "caution" | "fail"] : gateLabel(stored);
    // The unavailable banner carries the stored-text note as its second line (review of 082a2a7, owner ruling).
    const shownBanner = conflict ? `${expected}${READABLE_GATE_COPY.storedTextNote}` : expected;
    expect(banners).toEqual([shownBanner, shownBanner]);
    if (variant === "order4") for (const w of [...NEW_WORDING, READABLE_GATE_COPY.inconsistentBanner]) expect(text).not.toContain(w);
    else expect(text.split(expected)).toHaveLength(3);
    // The banner follows the answer: the reader meets the answer before any gate banner.
    expect(html.indexOf(esc(expected))).toBeGreaterThan(order[1]);
  });

  it("no gate recorded at all (all models failed): no banner, no legacy or new banner wording, no unqualified verified", async () => {
    const rec = record("generic-all-failed");
    const rows = slotRows("generic-all-failed");
    const text = htmlText(renderPanel(rec, rows, READABLE));
    for (const w of [...LEGACY_WORDING, ...ALL_READABLE_BANNERS]) expect(text).not.toContain(w);
    expect(unqualifiedVerified(text)).toBe(false);
    expect((await mount(rec, rows, READABLE)).root.findAllByType(GateBanner)).toHaveLength(0);
  });

  it("an unrecognized stored gate on a legacy report keeps the D8 wording (never relabelled as a pass)", async () => {
    const { rec, rows } = build({ label: "u", base: "generic-mixed", edit: (r) => ((r.gate.status = "verified-ish"), (r.synthesisReport.gate = "verified-ish")) }, "legacy");
    const banners = (await mount(rec, rows, READABLE)).root.findAllByType(GateBanner).map((b) => textOf(b));
    expect(banners).toEqual([gateLabel("unrecognized"), gateLabel("unrecognized")]);
    for (const w of NEW_WORDING) expect(banners.join(" ")).not.toContain(w);
  });
});

describe("classic parity: the same fixtures keep the historical banner wording byte for byte", () => {
  it.each(MATRIX)("%s (%s)", async (_label, variant, c) => {
    const { rec, rows } = build(c, variant);
    const html = renderPanel(rec, rows);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status));
    for (const w of ALL_READABLE_BANNERS) expect(htmlText(html)).not.toContain(w);
    const root = (await mount(rec, rows)).root;
    const banners = root.findAllByType(GateBanner);
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners) {
      expect(b.props.readable).toBeUndefined();
      // The exact markup gateBannerText gives this stored report (frozen gatePresentation wording).
      const markup = renderToStaticMarkup(createElement(GateBanner, { report: b.props.report, gate: b.props.gate }));
      expect(markup).toContain(`>${esc(gateBannerText(b.props.report, pageGateValue(b.props.report, b.props.gate)))}<`);
      expect(html).toContain(markup);
    }
    if (variant === "legacy") expect(htmlText(html)).toContain(LEGACY_GATE_BANNER_LABEL[stored as "pass" | "caution" | "fail"]);
  });
});

describe("GateBanner's readable option: Order 4 / unrecognized words unchanged; legacy words replaced; same tone when consistent", () => {
  const STATUSES: unknown[] = ["pass", "caution", "fail", "verified-ish", 7, undefined];
  const reportOf = (gate: unknown, order4: boolean) => {
    const rec = record("generic-mixed");
    rec.synthesisReport.gate = gate;
    if (!order4) delete rec.synthesisReport.presentation;
    return rec.synthesisReport;
  };
  it.each(STATUSES.flatMap((s) => [true, false].map((o) => [String(s), o, s] as const)))("stored %s, Order 4 presentation %s", (_n, order4, s) => {
    const report = reportOf(s, order4);
    // No recorded inputs on the gate object: never "inconsistent" (missing is not inconsistent).
    const presentation = readableGatePresentation({ gate: { status: s } as any, synthesisReport: report });
    const classic = renderToStaticMarkup(createElement(GateBanner, { report, gate: s }));
    const readable = renderToStaticMarkup(createElement(GateBanner, { report, gate: s, readable: presentation }));
    const status = readGateStatus(s);
    expect(classic).toContain(`>${esc(gateBannerText(report, s))}<`);
    const withAttr = (html: string) => html.replace("<div ", `<div data-readable-gate="${presentation.status}" `);
    if (order4 || status === "unrecognized") {
      expect(readable).toBe(withAttr(classic));
    } else {
      const legacy = LEGACY_GATE_BANNER_LABEL[status];
      const replacement = READABLE_GATE_COPY.legacyBanner[status];
      expect(classic).toContain(`>${legacy}<`);
      expect(readable).toBe(withAttr(classic.replace(`>${legacy}<`, `>${esc(replacement)}<`))); // same element, same tone classes
    }
  });
});

describe("the readable gate wording", () => {
  // Review of cb2febb (MAJOR): the banner states the stored word and the kind of check — never a condition on which
  // claims split, agreed or matched (gate.ts's top-N cut with stored-order ties makes any such sentence unsafe).
  it("states the stored gate word and the kind of check, separates it from evidence verification, and claims nothing about the claims", () => {
    const kind = "This is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";
    for (const [status, words] of Object.entries(READABLE_GATE_COPY.legacyBanner)) {
      expect(words).toBe(`${gateLabel(status as "pass")}. ${kind}`);
      expect(words).not.toMatch(/verif(ied|y)\b/i);
      expect(words).not.toMatch(/converg|consensus|most-raised|none of|no more than|two or more|match|agree|threshold/i);
    }
    expect(READABLE_GATE_COPY.inconsistentBanner.startsWith("Verification gate: Unavailable — the stored result is inconsistent with its recorded inputs.")).toBe(true);
    expect(READABLE_GATE_COPY.inconsistentBanner).not.toMatch(/\b(Pass|Caution|Fail)\b|verif(ied|y)\b|most-raised|match|agree/i);
  });

  // Review of 28f770c (MINOR): this used to assert the banner had NO scanner hit — vacuous, because the scanner did not
  // know "matched". The banner now names the stored "split" status, so every banner literal must be SEEN by the scanner
  // (and is classified in the manifest: readableLegacyGateTruth.spec.tsx); the capped tooltip still carries none.
  it("every banner literal is seen by the vocabulary scanner; the capped tooltip carries no vocabulary", () => {
    const hits = scanVocabulary(process.cwd(), ["lib/research/readableReport/copy.ts"]).map((l) => l.literal);
    for (const w of [...NEW_WORDING, READABLE_GATE_COPY.inconsistentBanner]) expect(hits).toContain(JSON.stringify(w));
    expect(hits.some((h) => /behaviour score is capped/.test(h))).toBe(false);
  });
});

describe("capped-score tooltip (ListView) names the behaviour score in readable mode", () => {
  async function cappedRender(extra: Record<string, unknown>, parseHealth: "degraded" | "failed" = "degraded") {
    const rec = record("generic-mixed");
    const entry = rec.trustSummary.perModel[0];
    expect(rec.results.find((x: any) => x.modelId === entry.modelId).ok).toBe(true);
    entry.capped = true;
    entry.parseHealth = parseHealth;
    const root = (await mount(rec, slotRows("generic-mixed"), extra)).root;
    const list = root.findAllByType(ListView);
    expect(list).toHaveLength(1);
    return list[0].findAll((n) => n.type === "span" && typeof n.props.title === "string" && n.props.className?.includes("cursor-help")).map((n) => n.props.title as string);
  }

  it("readable: the tooltip says behaviour score (with the configured cap), never trust score", async () => {
    const titles = await cappedRender(READABLE);
    const cap = Math.round((TRUST_SCORE_CAP_BY_HEALTH.degraded as number) * 100);
    expect(titles).toEqual([READABLE_TRUST_COPY.listScoreCappedReason("degraded", cap)]);
    expect(titles[0]).toContain(`behaviour score is capped at ${cap}%`);
    expect(titles[0]).not.toMatch(/trust score/i);
  });

  it("readable: a failed parse health names the behaviour score too", () => {
    expect(READABLE_TRUST_COPY.listScoreCappedReason("failed", 0)).toBe("Response failed to parse or validate — behaviour score is 0.");
    expect(READABLE_TRUST_COPY.listScoreCappedReason("degraded", null)).not.toMatch(/ at \d/);
  });

  it("classic: the tooltip is TRUST_SCORE_CAP_REASON, unchanged", async () => {
    expect(await cappedRender({})).toEqual([TRUST_SCORE_CAP_REASON.degraded]);
  });
});
