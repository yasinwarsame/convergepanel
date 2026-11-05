/**
 * #290 Increment 1 — review of 28f770c NOT CLEAN (MAJOR): the readable legacy Pass banner said "the models' positions
 * on the most-raised claims matched". lib/adaptiveSchema/gate.ts does not mean that: pass is certainty >= passMin AND no
 * split among the loadBearingTopN most-raised claims, so a pass can rest on majority claims with partial positions
 * (forecast) or a single-source claim (procedural).
 *
 * Each case renders the COMPLETE readable report through the real AdaptivePanelResponse (reportLayout "readable") for
 * a report persisted before the Order 4 gate presentation (presentation removed), and checks:
 *   - both gate banners carry READABLE_GATE_COPY.legacyBanner for the stored status, clause for clause;
 *   - every clause the banner states holds on the stored gate inputs (the oracle is gate.ts's rule, recomputed by the
 *     real computeAdaptiveGate from the stored rows, which must reproduce the stored status);
 *   - no banner says the positions matched / agreed / were identical, or that anything was verified or confirmed;
 *   - the page carries no unqualified "verified".
 * Classic byte parity for the same fixtures is asserted in readableLegacyGateBanner.spec.tsx, historicalParity and
 * nonDsWordingParity.
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
import { LEGACY_GATE_BANNER_LABEL, hasGatePresentation, pageGateValue, readGateStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { READABLE_GATE_COPY } from "@/lib/research/readableReport/copy";
import { VOCAB, scanVocabulary } from "@/lib/adaptiveSchema/__tests__/o5p/vocabularyScanner";
import { htmlText, panelElement, record, remoteWorkFixture, renderPanel, slotRows } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };
type Known = "pass" | "caution" | "fail";

/** The 28f770c wording the review found untrue. */
const OLD_28F770C = {
  pass: "Verification gate: Pass — the models' positions on the most-raised claims matched; the evidence was not independently checked",
  caution: "Verification gate: Caution — the panel did not meet the conditions for a clean pass; the evidence was not independently checked",
  fail: "Verification gate: Fail — the panel did not meet the gate's conditions; the evidence was not independently checked",
};

/** Overclaims a gate banner must never make: positions matched / agreed, or the evidence verified / confirmed. */
const BANNER_OVERCLAIM = /\b(match\w*|agree\w*|identical|same positions?|uniform\w*|unanim\w*|consensus|converg\w*|confirm\w*|verified|verify)\b/i;
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

async function banners(rec: any, rows: any): Promise<string[]> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(panelElement(rec, rows, READABLE));
  });
  return r.root.findAllByType(GateBanner).map((b) => textOf(b));
}

/**
 * Every clause of the banner for a status, each with the predicate it asserts over the stored gate inputs. The clauses
 * are the banner's own words; the predicates are gate.ts's rule for that status.
 */
interface Inputs {
  certainty: number;
  topSplits: number;
  anySplit: boolean;
}
const CLAUSES: Record<Known, Array<[string, (i: Inputs) => boolean]>> = {
  pass: [
    ["the certainty score met the pass threshold", (i) => i.certainty >= GATE_THRESHOLDS.passMin],
    ["none of the most-raised claims had a split position", (i) => i.topSplits === 0],
  ],
  caution: [
    ["the certainty score was below the pass threshold or a claim had a split position", (i) => i.certainty < GATE_THRESHOLDS.passMin || i.anySplit],
    ["no more than one of the most-raised claims had a split position", (i) => i.topSplits <= 1],
  ],
  fail: [["the certainty score was below the caution threshold or two or more of the most-raised claims had a split position", (i) => i.certainty < GATE_THRESHOLDS.cautionMin || i.topSplits >= 2]],
};

interface Case {
  label: string;
  base: string;
  expect: Known;
  make?: () => any;
  edit?: (rec: any) => void;
  /** What the fixture must exercise (so a case cannot silently stop testing what it is named for). */
  shape?: (rec: any) => void;
  inputsRecorded?: boolean;
  /** The stored gate value was edited without its inputs (remote-work shape): only the banner wording is checked. */
  storedValueOnly?: boolean;
}

const statuses = (rec: any) => rec.gate.loadBearingClaims.map((c: any) => c.status);

const CASES: Case[] = [
  {
    label: "legacy pass — forecast: majority claims with partial positions, none split",
    base: "forecast",
    expect: "pass",
    shape: (rec) => {
      expect(statuses(rec)).toEqual(["majority", "majority"]);
      // Partial / non-supporting positions exist on the load-bearing claims: they did not "match".
      for (const c of rec.gate.loadBearingClaims) expect(c.cells.map((x: any) => x.stance)).toContain("partial");
    },
  },
  {
    label: "legacy pass — procedural: a single-source claim among the most-raised",
    base: "procedural",
    expect: "pass",
    shape: (rec) => expect(statuses(rec)).toContain("single_source"),
  },
  { label: "legacy pass — all most-raised claims consensus", base: "generic-consensus", expect: "pass", shape: (rec) => expect(new Set(statuses(rec))).toEqual(new Set(["consensus"])) },
  {
    label: "legacy caution — certainty below the pass threshold, no split (limited coverage)",
    base: "generic-malformed",
    expect: "caution",
    shape: (rec) => {
      expect(rec.gate.runCertainty).toBeLessThan(GATE_THRESHOLDS.passMin);
      expect(rec.gate.loadBearingSplitCount).toBe(0);
    },
  },
  {
    label: "legacy caution — one most-raised claim split at a certainty above the pass threshold",
    base: "contested-empirical",
    expect: "caution",
    shape: (rec) => {
      expect(rec.gate.runCertainty).toBeGreaterThanOrEqual(GATE_THRESHOLDS.passMin);
      expect(rec.gate.loadBearingSplitCount).toBe(1);
    },
  },
  {
    label: "legacy fail — two most-raised claims split at a certainty above the pass threshold",
    base: "legal-regulatory",
    expect: "fail",
    shape: (rec) => {
      expect(rec.gate.runCertainty).toBeGreaterThanOrEqual(GATE_THRESHOLDS.passMin);
      expect(rec.gate.loadBearingSplitCount).toBe(2);
    },
  },
  {
    // No rendering fixture fails on certainty alone, so generic-malformed's stored certainty is lowered below the
    // caution floor and its stored gate set to what gate.ts then computes (checked in build()).
    label: "legacy fail — certainty below the caution threshold, no split",
    base: "generic-malformed",
    expect: "fail",
    edit: (rec) => {
      rec.gate.runCertainty = GATE_THRESHOLDS.cautionMin / 2;
      rec.gate.status = "fail";
      rec.synthesisReport.gate = "fail";
    },
    shape: (rec) => {
      expect(rec.gate.runCertainty).toBeLessThan(GATE_THRESHOLDS.cautionMin);
      expect(rec.gate.loadBearingSplitCount).toBe(0);
    },
  },
  { label: "legacy caution — degraded coverage (one failed, one substituted)", base: "generic-substituted-and-failed", expect: "caution" },
  {
    label: "legacy fail — degraded synthesis (remote-work shape; stored gate edited to fail)",
    base: "generic-substituted-and-failed",
    expect: "fail",
    make: () => remoteWorkFixture().rec,
    storedValueOnly: true,
    shape: (rec) => expect(rec.synthesisReport.degraded).toBe(true),
  },
  {
    label: "legacy pass — missing verification evidence (gate inputs not recorded)",
    base: "generic-consensus",
    expect: "pass",
    inputsRecorded: false,
    edit: (rec) => {
      delete rec.gate.runCertainty;
      delete rec.gate.loadBearingSplitCount;
      delete rec.gate.loadBearingClaims;
    },
  },
];

function build(c: Case) {
  const rec = c.make ? c.make() : record(c.base);
  if (c.inputsRecorded === false) {
    c.edit?.(rec);
  } else {
    c.edit?.(rec);
    c.shape?.(rec);
    // The stored status is what the real gate.ts gives for the stored rows and certainty (remote-work: an edited value).
    if (!c.storedValueOnly) expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).toBe(rec.gate.status);
  }
  expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
  delete rec.synthesisReport.presentation;
  expect(hasGatePresentation(rec.synthesisReport)).toBe(false);
  return { rec, rows: slotRows(c.base) };
}

describe("readable legacy gate banner states gate.ts's rule for the stored status — and only what holds", () => {
  it.each(CASES.map((c) => [c.label, c] as const))("%s", async (_label, c) => {
    const { rec, rows } = build(c);
    const stored = readGateStatus(pageGateValue(rec.synthesisReport, rec.gate.status));
    expect(stored).toBe(c.expect);

    const expected = READABLE_GATE_COPY.legacyBanner[c.expect];
    const html = renderPanel(rec, rows, READABLE);
    const text = htmlText(html);
    const shown = await banners(rec, rows);
    expect(shown).toEqual([expected, expected]);
    expect(text.split(expected)).toHaveLength(3);

    for (const b of shown) {
      expect(b.startsWith(`Verification gate: ${{ pass: "Pass", caution: "Caution", fail: "Fail" }[c.expect]} — `)).toBe(true);
      expect(b.endsWith("; the evidence was not independently checked")).toBe(true);
      for (const [clause] of CLAUSES[c.expect]) expect(b).toContain(clause);
      expect(b).not.toMatch(BANNER_OVERCLAIM);
    }

    // Each clause holds on the stored inputs (when the page has them).
    if (c.inputsRecorded !== false && !c.storedValueOnly) {
      const top = rec.gate.loadBearingClaims;
      expect(top.length).toBeLessThanOrEqual(GATE_THRESHOLDS.loadBearingTopN);
      const inputs: Inputs = {
        certainty: rec.gate.runCertainty,
        topSplits: top.filter((x: any) => x.status === "split").length,
        anySplit: rec.alignedClaims.some((x: any) => x.status === "split"),
      };
      expect(inputs.topSplits).toBe(rec.gate.loadBearingSplitCount);
      for (const [clause, holds] of CLAUSES[c.expect]) expect([clause, holds(inputs)]).toEqual([clause, true]);
    }

    // Nowhere on the readable page: any 28f770c / historical banner wording, or an unqualified "verified".
    for (const w of [...Object.values(OLD_28F770C), ...Object.values(LEGACY_GATE_BANNER_LABEL)]) expect(text).not.toContain(w);
    expect(text).not.toMatch(/positions on the most-raised claims matched/);
    expect(unqualifiedVerified(text)).toBe(false);
  });

  it("factual lookup (gate.ts caps an otherwise-passing gate at caution on any split): the caution clauses hold; the page shows no gate banner", async () => {
    for (const base of ["factual-tie", "factual-normalizer"]) {
      const rec = record(base);
      expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).toBe("caution");
      const inputs: Inputs = {
        certainty: rec.gate.runCertainty,
        topSplits: rec.gate.loadBearingClaims.filter((x: any) => x.status === "split").length,
        anySplit: rec.alignedClaims.some((x: any) => x.status === "split"),
      };
      for (const [clause, holds] of CLAUSES.caution) expect([clause, holds(inputs)]).toEqual([clause, true]);
      delete rec.synthesisReport.presentation;
      expect(await banners(rec, slotRows(base))).toEqual([]);
    }
  });

  it("the pass clauses are false for the old 'matched' reading: a pass fixture's most-raised claims are not all consensus", () => {
    for (const base of ["forecast", "procedural"]) {
      const rec = record(base);
      expect(rec.gate.status).toBe("pass");
      expect(statuses(rec).every((s: string) => s === "consensus")).toBe(false);
    }
  });
});

describe("the vocabulary gate sees the gate banner wording (non-vacuous)", () => {
  const manifest: Array<{ file: string; literal: string; category: string; rule: string }> = JSON.parse(
    readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/vocabularyManifest.json"), "utf8")
  );

  it("the 28f770c 'matched' Pass copy, and the equivalent overclaims, are caught by the scanner's vocabulary", () => {
    expect(VOCAB.test(OLD_28F770C.pass)).toBe(true);
    for (const phrase of [
      "positions matched",
      "matching positions",
      "the models' answers match",
      "identical positions",
      "the same position",
      "the same positions",
      "uniform positions",
      "harmonized positions",
      "positions coincided",
      "confirmed by the panel",
      "in line with each other",
      "in accord",
    ])
      expect([phrase, VOCAB.test(phrase)]).toEqual([phrase, true]);
  });

  it("every readable legacy banner literal is scanned and classified as computed status in the manifest", () => {
    const hits = scanVocabulary(process.cwd(), ["lib/research/readableReport/copy.ts"]).map((l) => l.literal);
    for (const w of Object.values(READABLE_GATE_COPY.legacyBanner)) {
      const literal = JSON.stringify(w);
      expect(hits).toContain(literal);
      const entry = manifest.find((e) => e.file === "lib/research/readableReport/copy.ts" && e.literal === literal);
      expect(entry?.category).toBe("computed-status");
      expect(entry?.rule).toMatch(/gate\.ts/);
    }
  });

  it("no manifest entry classifies the 28f770c wording (it is gone from the source)", () => {
    for (const w of Object.values(OLD_28F770C)) expect(manifest.some((e) => e.literal.includes(w))).toBe(false);
  });
});
