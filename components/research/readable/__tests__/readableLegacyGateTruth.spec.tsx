/**
 * #290 Increment 1 — the readable legacy gate banner states only what holds.
 *
 * Review of cb2febb NOT CLEAN:
 *   MAJOR — the banner described gate.ts's condition on "the most-raised claims" unqualified, but gate.ts looks only at
 *     the top GATE_THRESHOLDS.loadBearingTopN claims after a salience sort that cuts ties in stored order: a fourth,
 *     equally-raised split claim made "none of the most-raised claims had a split position" false (and generic-splits
 *     stores caution with TWO top-salience splits). The old oracle read rec.gate.loadBearingClaims — the gate's own
 *     cut — so it could not see this (circular).
 *   MINOR — on a malformed legacy record whose stored gate contradicts its stored inputs, a condition-stating banner
 *     contradicted the inputs shown on the same page.
 *
 * Owner order: the banner is "Verification gate: <Pass|Caution|Fail>." plus the kind of check the gate is (rule-based,
 * not an independent verification of the evidence) — no statement about which claims agreed, matched or split. A legacy
 * record whose stored gate contradicts its recorded inputs shows "Verification gate: Unavailable — …" (no gate result:
 * not the stored one, not a recomputed one). Missing inputs are not "inconsistent".
 *
 * Every case renders the COMPLETE readable report through the real AdaptivePanelResponse. The oracles are computed
 * from the stored ROWS independently (claimSalience over every claim, ties included) or from the real gate.ts — never
 * from the gate's stored loadBearingClaims. Expected wording is written out literally here, not read from copy.ts.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { readFileSync } from "fs";
import { join } from "path";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { GateBanner } from "@/components/adaptive/AdaptiveSynthesisReportView";
import { GATE_THRESHOLDS } from "@/lib/adaptiveSchema/config";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { LEGACY_GATE_BANNER_LABEL, gateLabel, hasGatePresentation, pageGateValue, readGateStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { claimSalience } from "@/lib/adaptiveSchema/scoring";
import { VOCAB, scanVocabulary } from "@/lib/adaptiveSchema/__tests__/o5p/vocabularyScanner";
import { htmlText, panelElement, record, remoteWorkFixture, renderPanel, slotRows, tierHtml } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };
type Known = "pass" | "caution" | "fail";

/** The owner-ordered wording, written out (not imported) so the spec checks the words themselves. */
const KIND = "This is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";
const PLAIN: Record<Known, string> = {
  pass: `Verification gate: Pass. ${KIND}`,
  caution: `Verification gate: Caution. ${KIND}`,
  fail: `Verification gate: Fail. ${KIND}`,
};
const UNAVAILABLE =
  "Verification gate: Unavailable — the stored result is inconsistent with its recorded inputs. The gate is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";

/** The cb2febb wording the review found untrue (and the 28f770c wording before it). */
const OLD_WORDING = [
  "Verification gate: Pass — the certainty score met the pass threshold and none of the most-raised claims had a split position; the evidence was not independently checked",
  "Verification gate: Caution — the certainty score was below the pass threshold or a claim had a split position, and no more than one of the most-raised claims had a split position; the evidence was not independently checked",
  "Verification gate: Fail — the certainty score was below the caution threshold or two or more of the most-raised claims had a split position; the evidence was not independently checked",
  "Verification gate: Pass — the models' positions on the most-raised claims matched; the evidence was not independently checked",
];

/** Any claim a gate banner must never make: about which claims agreed / matched / split, or that evidence was verified. */
const BANNER_OVERCLAIM =
  /\b(match\w*|agree\w*|identical\w*|same (positions?|stances?)|uniform\w*|unanim\w*|consensus|converg\w*|confirm\w*|verified|verify|most-raised|none of|no more than|two or more|all (of )?the|had no split|threshold)\b/i;
const unqualifiedVerified = (text: string) => /\bverified\b/i.test(text.split("not a verified finding").join(""));

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => textOf(c as any)).join("");
}

async function banners(rec: any, rows: any, extra: Record<string, unknown> = READABLE): Promise<{ text: string[]; props: any[] }> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(panelElement(rec, rows, extra));
  });
  const found = r.root.findAllByType(GateBanner);
  return { text: found.map((b) => textOf(b)), props: found.map((b) => b.props) };
}

function gateSignalOf(html: string): { value: string; state: string; text: string } {
  const trust = tierHtml(html, "trust")!;
  const at = trust.indexOf('data-trust-signal="gate"');
  const el = trust.slice(trust.lastIndexOf("<", at));
  const state = /data-state="([^"]*)"/.exec(el)![1];
  const value = /data-trust-signal-value=""[^>]*>([^<]*)</.exec(el)![1];
  const end = el.indexOf('data-trust-signal="coverage"');
  return { value, state, text: htmlText(end > 0 ? el.slice(0, end) : el) };
}

/** Independent of the gate's stored cut: every claim sharing the highest salience in the stored rows (ties included). */
function topSalienceTie(rows: any[]): any[] {
  const max = Math.max(...rows.map((r) => claimSalience(r)));
  return rows.filter((r) => claimSalience(r) === max);
}

const legacy = (rec: any) => {
  expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
  delete rec.synthesisReport.presentation;
  expect(hasGatePresentation(rec.synthesisReport)).toBe(false);
  return rec;
};

/**
 * The reviewer's repro: generic-consensus with two more consensus claims and one split claim, all raised by every model
 * (salience 5). gate.ts keeps the first three in stored order (all consensus) → pass, while a split claim is exactly as
 * raised as they are. The stored gate is what the real gate.ts gives for the stored rows and certainty.
 */
function tieBeyondTopN() {
  const rec = record("generic-consensus");
  const base = rec.alignedClaims;
  const split = record("generic-splits").alignedClaims.find((c: any) => c.status === "split");
  const clone = (c: any, id: string) => ({ ...JSON.parse(JSON.stringify(c)), id, claimText: `${c.claimText} (${id})` });
  rec.alignedClaims = [...base, clone(base[0], "extra-consensus-a"), clone(base[1], "extra-consensus-b"), JSON.parse(JSON.stringify(split))];
  const g = computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId);
  rec.gate = { ...rec.gate, ...JSON.parse(JSON.stringify(g)) };
  rec.synthesisReport.gate = g.status;
  return rec;
}

interface Case {
  label: string;
  base: string;
  expect: Known;
  make?: () => any;
  edit?: (rec: any) => void;
  /** What the fixture must exercise, checked on the ROWS (so a case cannot silently stop testing what it is named for). */
  shape?: (rec: any) => void;
}

const statusesOf = (rows: any[]) => rows.map((c) => c.status);

const PLAIN_CASES: Case[] = [
  {
    label: "legacy pass — forecast: majority claims with partial positions, none split",
    base: "forecast",
    expect: "pass",
    shape: (rec) => {
      const top = topSalienceTie(rec.alignedClaims);
      expect(statusesOf(top).every((s) => s === "majority")).toBe(true);
      for (const c of top) expect(c.cells.map((x: any) => x.stance)).toContain("partial");
    },
  },
  { label: "legacy pass — procedural: a single-source claim among the stored claims", base: "procedural", expect: "pass", shape: (rec) => expect(statusesOf(rec.alignedClaims)).toContain("single_source") },
  { label: "legacy pass — all claims consensus", base: "generic-consensus", expect: "pass", shape: (rec) => expect(new Set(statusesOf(rec.alignedClaims))).toEqual(new Set(["consensus"])) },
  {
    label: "legacy pass — a FOURTH equally-raised claim is split (tie beyond the top three)",
    base: "generic-consensus",
    expect: "pass",
    make: tieBeyondTopN,
    shape: (rec) => {
      const top = topSalienceTie(rec.alignedClaims);
      expect(top.length).toBeGreaterThan(GATE_THRESHOLDS.loadBearingTopN);
      // A split claim is among the most-raised — "none of the most-raised claims had a split position" would be false.
      expect(top.filter((c) => c.status === "split")).toHaveLength(1);
    },
  },
  {
    label: "legacy caution — generic-splits: TWO top-salience claims split, stored caution",
    base: "generic-splits",
    expect: "caution",
    shape: (rec) => {
      const top = topSalienceTie(rec.alignedClaims);
      // "no more than one of the most-raised claims had a split position" would be false.
      expect(top.filter((c) => c.status === "split").length).toBeGreaterThanOrEqual(2);
    },
  },
  {
    label: "legacy caution — certainty below the pass threshold, no split (limited coverage)",
    base: "generic-malformed",
    expect: "caution",
    shape: (rec) => expect(rec.gate.runCertainty).toBeLessThan(GATE_THRESHOLDS.passMin),
  },
  { label: "legacy caution — one claim split at a certainty above the pass threshold", base: "contested-empirical", expect: "caution" },
  { label: "legacy caution — degraded coverage (one failed, one substituted)", base: "generic-substituted-and-failed", expect: "caution" },
  { label: "legacy fail — two claims split at a certainty above the pass threshold", base: "legal-regulatory", expect: "fail" },
  {
    label: "legacy fail — certainty below the caution threshold, no split (stored gate set to gate.ts's result)",
    base: "generic-malformed",
    expect: "fail",
    edit: (rec) => {
      rec.gate.runCertainty = GATE_THRESHOLDS.cautionMin / 2;
      rec.gate.status = "fail";
      rec.synthesisReport.gate = "fail";
    },
  },
];

describe("readable legacy gate banner: the stored word and the kind of check — no claim about which claims split", () => {
  it.each(PLAIN_CASES.map((c) => [c.label, c] as const))("%s", async (_label, c) => {
    const rec = c.make ? c.make() : record(c.base);
    c.edit?.(rec);
    c.shape?.(rec);
    // Non-circular oracle: the real gate.ts, from the stored ROWS and certainty, gives the stored status.
    expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).toBe(c.expect);
    expect(readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status))).toBe(c.expect);
    legacy(rec);
    const rows = slotRows(c.base);

    const html = renderPanel(rec, rows, READABLE);
    const text = htmlText(html);
    const shown = (await banners(rec, rows)).text;
    expect(shown).toEqual([PLAIN[c.expect], PLAIN[c.expect]]);
    expect(text.split(PLAIN[c.expect])).toHaveLength(3);
    for (const b of shown) expect(b.replace(KIND, "")).not.toMatch(BANNER_OVERCLAIM);
    for (const b of shown) expect(b).not.toContain("Unavailable");

    // The trust signal shows the stored word (the record is consistent).
    expect(gateSignalOf(html).value).toBe({ pass: "Pass", caution: "Caution", fail: "Fail" }[c.expect]);

    for (const w of [...OLD_WORDING, ...Object.values(LEGACY_GATE_BANNER_LABEL), UNAVAILABLE]) expect(text).not.toContain(w);
    expect(text).not.toMatch(/most-raised claims (matched|had)/);
    expect(unqualifiedVerified(text)).toBe(false);
  });

  it("missing gate inputs: the plain label and explanation — never 'inconsistent'", async () => {
    const rec = legacy(record("generic-consensus"));
    delete rec.gate.runCertainty;
    delete rec.gate.loadBearingSplitCount;
    delete rec.gate.loadBearingClaims;
    const rows = slotRows("generic-consensus");
    const html = renderPanel(rec, rows, READABLE);
    expect((await banners(rec, rows)).text).toEqual([PLAIN.pass, PLAIN.pass]);
    const sig = gateSignalOf(html);
    expect(sig.value).toBe("Pass");
    expect(sig.text).toContain("The gate's stored inputs are not available on this page.");
    expect(htmlText(html)).not.toMatch(/inconsistent|Unavailable/);
  });

  it("factual lookup (gate.ts caps a passing gate at caution on any split) is not called inconsistent; the page shows no banner", async () => {
    const { storedGateConsistency } = require("@/lib/research/readableReport/trustSignals");
    for (const base of ["factual-tie", "factual-normalizer"]) {
      const rec = legacy(record(base));
      expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).toBe("caution");
      expect(storedGateConsistency({ gate: rec.gate, synthesisReport: rec.synthesisReport, schemaId: rec.schemaId })).toBe("consistent");
      expect((await banners(rec, slotRows(base))).text).toEqual([]);
    }
  });
});

/**
 * Malformed legacy records: the stored gate contradicts what the record itself stores. Each conflict is stated from the
 * stored data directly (not from the code under test).
 */
interface Conflict {
  label: string;
  base: string;
  make?: () => any;
  edit?: (rec: any) => void;
  /** The independent statement of the conflict, on the stored fields. */
  conflict: (rec: any) => void;
}

const CONFLICTS: Conflict[] = [
  {
    label: "remote-work shape: stored fail over inputs that give caution (69%, one of three split)",
    base: "generic-substituted-and-failed",
    make: () => remoteWorkFixture().rec,
    conflict: (rec) => {
      expect(rec.synthesisReport.gate).toBe("fail");
      expect(rec.gate.runCertainty).toBeGreaterThanOrEqual(GATE_THRESHOLDS.cautionMin);
      expect(rec.gate.loadBearingSplitCount).toBeLessThan(2);
      expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).not.toBe("fail");
    },
  },
  {
    label: "report says fail, gate object says pass (two stored results)",
    base: "generic-consensus",
    edit: (rec) => {
      rec.gate.status = "pass";
      rec.synthesisReport.gate = "fail";
    },
    conflict: (rec) => expect(rec.gate.status).not.toBe(rec.synthesisReport.gate),
  },
  {
    label: "report says pass, gate object says fail, inputs give pass (the page's stored value would be the stronger one)",
    base: "generic-consensus",
    edit: (rec) => {
      rec.gate.status = "fail";
      rec.synthesisReport.gate = "pass";
    },
    conflict: (rec) => expect(rec.gate.status).not.toBe(rec.synthesisReport.gate),
  },
  {
    label: "stored pass with certainty below the pass threshold",
    base: "generic-malformed",
    edit: (rec) => {
      rec.gate.status = "pass";
      rec.synthesisReport.gate = "pass";
    },
    conflict: (rec) => expect(rec.gate.runCertainty).toBeLessThan(GATE_THRESHOLDS.passMin),
  },
  {
    label: "stored pass with two load-bearing splits recorded",
    base: "legal-regulatory",
    edit: (rec) => {
      rec.gate.status = "pass";
      rec.synthesisReport.gate = "pass";
    },
    conflict: (rec) => expect(rec.gate.loadBearingSplitCount).toBeGreaterThanOrEqual(2),
  },
  {
    label: "recorded split count disagrees with the recorded load-bearing claims",
    base: "contested-empirical",
    edit: (rec) => {
      rec.gate.loadBearingSplitCount = 0;
      rec.gate.status = "pass";
      rec.synthesisReport.gate = "pass";
    },
    conflict: (rec) => expect(rec.gate.loadBearingClaims.filter((c: any) => c.status === "split").length).not.toBe(rec.gate.loadBearingSplitCount),
  },
];

describe("conflicting legacy metadata: readable shows the gate as unavailable, never a corrected or stronger result", () => {
  it.each(CONFLICTS.map((c) => [c.label, c] as const))("%s", async (_label, c) => {
    const rec = c.make ? c.make() : record(c.base);
    c.edit?.(rec);
    c.conflict(rec);
    legacy(rec);
    const rows = slotRows(c.base);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status)) as Known;

    const html = renderPanel(rec, rows, READABLE);
    const text = htmlText(html);
    expect((await banners(rec, rows)).text).toEqual([UNAVAILABLE, UNAVAILABLE]);
    for (const w of [...Object.values(PLAIN), ...OLD_WORDING, ...Object.values(LEGACY_GATE_BANNER_LABEL)]) expect(text).not.toContain(w);
    // Outside the stored answer text (shown verbatim wherever the page shows it — an answer composed after Order 4 may
    // open with its own gate sentence, which is stored data, not a statement the readable layout adds), no gate result
    // is stated.
    const storedAnswer = String(rec.synthesisReport.unifiedAnswer).replace(/\s+/g, " ").trim();
    expect(text).toContain(storedAnswer);
    expect(text.split(storedAnswer).join(" ")).not.toMatch(/Verification gate: (Pass|Caution|Fail)\b/);

    const sig = gateSignalOf(html);
    expect(sig.value).toBe("Unavailable");
    expect(sig.state).toBe("inconsistent");
    expect(sig.text).toContain("The stored result is inconsistent with its recorded inputs, so no gate result is shown.");
    // The recorded inputs are still shown as stored.
    expect(sig.text).toContain(`Certainty score: ${Math.round(rec.gate.runCertainty * 100)}%`);
    expect(sig.text).toContain(`Most-raised claims with a split position: ${rec.gate.loadBearingSplitCount} of ${rec.gate.loadBearingClaims.length}`);
    // No caution notice is offered as though the stored caution were the result.
    expect(sig.text).not.toMatch(/did not meet the conditions/);
    expect(unqualifiedVerified(text)).toBe(false);
    expect(stored).not.toBe("unrecognized");
  });

  it.each(CONFLICTS.map((c) => [c.label, c] as const))("Order 4 report (presentation kept), same conflict — unchanged: %s", async (_label, c) => {
    const rec = c.make ? c.make() : record(c.base);
    c.edit?.(rec);
    expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
    const rows = slotRows(c.base);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status));
    const html = renderPanel(rec, rows, READABLE);
    expect((await banners(rec, rows)).text).toEqual([gateLabel(stored), gateLabel(stored)]);
    expect(htmlText(html)).not.toContain(UNAVAILABLE);
    const sig = gateSignalOf(html);
    expect(sig.value).toBe({ pass: "Pass", caution: "Caution", fail: "Fail", unrecognized: "Unrecognized" }[stored]);
    expect(sig.state).toBe(stored);
  });

  it.each(CONFLICTS.map((c) => [c.label, c] as const))("classic keeps the stored historical label byte for byte: %s", async (_label, c) => {
    const rec = c.make ? c.make() : record(c.base);
    c.edit?.(rec);
    legacy(rec);
    const rows = slotRows(c.base);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status)) as Known;
    const html = renderPanel(rec, rows);
    const b = await banners(rec, rows, {});
    expect(b.text.length).toBeGreaterThan(0);
    for (const t of b.text) expect(t).toBe(LEGACY_GATE_BANNER_LABEL[stored]);
    for (const p of b.props) expect(p.legacyLabels).toBeUndefined();
    expect(html).not.toContain("Unavailable");
    expect(html).not.toContain("rule-based check");
  });

  it("stored data is read, never written: the record is byte-identical after a readable render", () => {
    for (const c of CONFLICTS) {
      const rec = c.make ? c.make() : record(c.base);
      c.edit?.(rec);
      legacy(rec);
      const before = JSON.stringify(rec);
      renderPanel(rec, slotRows(c.base), READABLE);
      expect(JSON.stringify(rec)).toBe(before);
    }
  });
});

describe("the vocabulary gate sees the gate banner wording (non-vacuous)", () => {
  const manifest: Array<{ file: string; literal: string; category: string; rule: string }> = JSON.parse(
    readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/vocabularyManifest.json"), "utf8")
  );

  it("the overclaims are caught by the scanner's vocabulary, with the cb2febb-review stems", () => {
    for (const phrase of [
      "positions matched",
      "identical positions",
      "identically positioned",
      "the same position",
      "the same stance",
      "the same stances",
      "consistent answers",
      "equivalent positions",
      "concordant positions",
      "concordance",
      "confirmed by the panel",
      "in line with each other",
    ])
      expect([phrase, VOCAB.test(phrase)]).toEqual([phrase, true]);
    // "inconsistent" is not agreement vocabulary: the unavailable banner is seen for its "split", not for it.
    expect(VOCAB.test("inconsistent with its recorded inputs")).toBe(false);
  });

  it("every readable gate banner literal is scanned and classified as computed status in the manifest", () => {
    const hits = scanVocabulary(process.cwd(), ["lib/research/readableReport/copy.ts"]).map((l) => l.literal);
    for (const w of [...Object.values(PLAIN), UNAVAILABLE]) {
      const literal = JSON.stringify(w);
      expect(hits).toContain(literal);
      const entry = manifest.find((e) => e.file === "lib/research/readableReport/copy.ts" && e.literal === literal);
      expect(entry?.category).toBe("computed-status");
      expect(entry?.rule).toMatch(/gate\.ts|storedGateConsistency/);
    }
  });

  it("no manifest entry classifies the cb2febb or 28f770c wording (it is gone from the source)", () => {
    for (const w of OLD_WORDING) expect(manifest.some((e) => e.literal.includes(w))).toBe(false);
  });
});
