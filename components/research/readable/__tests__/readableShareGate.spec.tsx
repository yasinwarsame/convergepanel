/**
 * #290 Increment 1 — review of bb4aed5 (MINOR): the readable full report showed "Verification gate: Unavailable" on a
 * legacy record whose stored gate contradicts its recorded inputs, but its "Generate LinkedIn post" / "Generate X post"
 * (and Copy synthesis / Export memo) built text from the stored gate: "Certainty: 40% (gate: pass)".
 *
 * Fix under test: the readable report view hands the page's ONE gate presentation (trustSignals.readableGatePresentation)
 * to every shareBuilders builder as the optional ReadableShareGate argument; classic passes nothing.
 *
 *   1. Builders, readable option: inconsistent legacy → "Verification gate: Unavailable", no stored gate word or
 *      confidence level in any generated line (stored text excepted, and qualified by the stored-text note in Markdown
 *      and memo); consistent legacy → the validated label; Order 4 → the classic output exactly.
 *   2. The real readable page: its four actions produce exactly the readable-option output (the wiring), and the real
 *      classic page's actions produce exactly the classic output (no leak).
 *   3. Frozen classic parity: every classic output (builders with no option, classic page HTML and its four actions) over
 *      a broad fixture set hashes to the digest captured at bb4aed5 (5,266 outputs).
 *
 * Expected words are written out literally here, not read from the code under test.
 */
const captured: Array<Record<string, any>> = [];
jest.mock("@/components/VerificationActions", () => {
  const actual = jest.requireActual("@/components/VerificationActions");
  const { createElement } = jest.requireActual("react");
  return {
    ...actual,
    VerificationActions: (props: any) => {
      captured.push(props);
      return createElement(actual.VerificationActions, props);
    },
  };
});
const clip: string[] = [];
jest.mock("@/lib/ui/copyFormats", () => ({ ...jest.requireActual("@/lib/ui/copyFormats"), copyToClipboardWithFallback: async (t: string) => (clip.push(t), true) }));
const downloads: string[] = [];
jest.mock("@/lib/verification/generateMemo", () => ({ ...jest.requireActual("@/lib/verification/generateMemo"), downloadTextFile: (t: string) => downloads.push(t) }));
const posts: string[] = [];
jest.mock("@/lib/adaptiveSchema/shareBuilders", () => {
  const a = jest.requireActual("@/lib/adaptiveSchema/shareBuilders");
  return {
    ...a,
    buildAdaptiveLinkedInPost: (...args: any[]) => {
      const r = a.buildAdaptiveLinkedInPost(...args);
      posts.push(r);
      return r;
    },
    buildAdaptiveXPost: (...args: any[]) => {
      const r = a.buildAdaptiveXPost(...args);
      posts.push(r);
      return r;
    },
  };
});
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { computeAdaptiveGate } from "@/lib/adaptiveSchema/gate";
import { hasGatePresentation } from "@/lib/adaptiveSchema/gatePresentation";
import { buildAdaptiveLinkedInPost, buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost, type ReadableShareGate } from "@/lib/adaptiveSchema/shareBuilders";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { readableGatePresentation } from "@/lib/research/readableReport/trustSignals";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";
import { QUESTION, record, remoteWorkFixture, renderPanel, slotRows } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };
type Known = "pass" | "caution" | "fail";
const WORD: Record<Known, string> = { pass: "Pass", caution: "Caution", fail: "Fail" };
const CONFIDENCE: Record<Known, string> = { pass: "High", caution: "Medium", fail: "Low" };
const UNAVAILABLE = "Verification gate: Unavailable";
const STORED_TEXT_NOTE = "Text stored with this report (such as the answer or the certainty line) may name a gate result. That stored text is reproduced as written; it is not the gate result.";
const CAUTION_NOTICE = "Caution: This result requires further review. The panel did not meet the conditions for a clean verification pass. Review the findings and limitations before relying on this answer.";
/** Any gate result statement: the D6 label, the historical "(gate: pass)" / X "(pass)" forms, a memo confidence level. */
const GATE_RESULT_TEXT = /Verification gate: (Pass|Caution|Fail)\b|\bgate: (pass|caution|fail)\b|\((pass|caution|fail)\)|\b(High|Medium|Low) confidence\b/i;

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const pct = (rec: any) => Math.round(rec.synthesisReport.runCertainty * 100);
const normMemo = (m: string) => m.replace(/^Generated: .*$/m, "Generated: <n>");

/** Every stored string of the report at least 20 characters long (stored text is reproduced as written, never edited). */
function storedStrings(report: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length >= 20) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(report);
  return out.sort((a, b) => b.length - a.length);
}
const withoutStored = (text: string, rec: any) => storedStrings(rec.synthesisReport).reduce((t, s) => t.split(s).join(" "), text);

const legacy = (rec: any) => {
  expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
  delete rec.synthesisReport.presentation;
  expect(hasGatePresentation(rec.synthesisReport)).toBe(false);
  return rec;
};

interface Case {
  label: string;
  base: string;
  make?: () => any;
  edit?: (rec: any) => void;
}
const build = (c: Case) => {
  const rec = c.make ? c.make() : record(c.base);
  c.edit?.(rec);
  return rec;
};
const presentationOf = (rec: any) => readableGatePresentation({ gate: rec.gate, synthesisReport: rec.synthesisReport, schemaId: rec.schemaId });

/** The four generated texts, built directly (readable option or none). */
function generated(rec: any, readable?: ReadableShareGate) {
  const rows = slotRows(rec.__base);
  const ids = rows.map((r: any) => r.modelId);
  // The page hands the memo the run's provenance (RunModelProvenanceContext); so does this.
  const provenance = rows.map((r: any) => runModelProvenanceFromResultRow(r));
  const memoInput = buildAdaptiveMemoInput(QUESTION, rec.synthesisReport, ids, "run-290", provenance, undefined, readable);
  return {
    linkedin: buildAdaptiveLinkedInPost(QUESTION, rec.synthesisReport, undefined, readable),
    x: buildAdaptiveXPost(QUESTION, rec.synthesisReport, undefined, readable),
    markdown: buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, undefined, readable),
    memoInput,
    memo: normMemo(generateVerificationMemo(memoInput)),
  };
}

/** The real page's four actions (Copy synthesis, Export memo, LinkedIn, X), clicked through their handlers. */
function pageActions(rec: any, extra: Record<string, unknown>) {
  captured.length = 0;
  clip.length = 0;
  downloads.length = 0;
  posts.length = 0;
  renderPanel(rec, slotRows(rec.__base), extra);
  const sets = captured.filter((p) => p.onGenerateLinkedIn);
  expect(sets).toHaveLength(1);
  const p = sets[0];
  void p.onCopy();
  p.onExportMemo();
  for (const h of ["onGenerateLinkedIn", "onGenerateX"]) {
    try {
      p[h]();
    } catch {
      /* the post's setState after a static render; the builder already ran */
    }
  }
  expect(clip).toHaveLength(1);
  expect(downloads).toHaveLength(1);
  expect(posts).toHaveLength(2);
  return { markdown: clip[0], memo: normMemo(downloads[0]), linkedin: posts[0], x: posts[1] };
}

const withBase = (rec: any, base: string) => Object.defineProperty(rec, "__base", { value: base, enumerable: false });

// ── Cases ──────────────────────────────────────────────────────────────────

const CONFLICTS: Array<Case & { stored: Known }> = [
  { label: "stored PASS, certainty below the pass threshold", base: "generic-malformed", stored: "pass", edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "pass")) },
  { label: "stored PASS, two load-bearing splits recorded", base: "legal-regulatory", stored: "pass", edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "pass")) },
  { label: "stored PASS, split count disagrees with the recorded load-bearing claims", base: "contested-empirical", stored: "pass", edit: (r) => ((r.gate.loadBearingSplitCount = 0), (r.gate.status = "pass"), (r.synthesisReport.gate = "pass")) },
  { label: "stored CAUTION over full certainty and no split", base: "generic-consensus", stored: "caution", edit: (r) => ((r.gate.status = "caution"), (r.synthesisReport.gate = "caution")) },
  { label: "stored FAIL over inputs that give caution (remote-work shape)", base: "generic-substituted-and-failed", stored: "fail", make: () => remoteWorkFixture().rec },
  { label: "stored FAIL over full certainty and no split", base: "generic-consensus", stored: "fail", edit: (r) => ((r.gate.status = "fail"), (r.synthesisReport.gate = "fail")) },
  { label: "report says FAIL, gate object says pass", base: "generic-consensus", stored: "fail", edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "fail")) },
  { label: "report says PASS, gate object says fail", base: "generic-consensus", stored: "pass", edit: (r) => ((r.gate.status = "fail"), (r.synthesisReport.gate = "pass")) },
];

const CONSISTENT: Array<Case & { stored: Known }> = [
  { label: "valid PASS (generic-consensus)", base: "generic-consensus", stored: "pass" },
  { label: "valid PASS (procedural)", base: "procedural", stored: "pass" },
  { label: "valid CAUTION (contested-empirical)", base: "contested-empirical", stored: "caution" },
  { label: "valid CAUTION (generic-splits)", base: "generic-splits", stored: "caution" },
  { label: "valid FAIL (legal-regulatory)", base: "legal-regulatory", stored: "fail" },
];

const legacyCase = (c: Case) => withBase(legacy(build(c)), c.base);

// ── 1. Builders with the readable option ───────────────────────────────────

describe("inconsistent legacy record: every generated format states 'Verification gate: Unavailable', never the stored gate", () => {
  it.each(CONFLICTS.map((c) => [c.label, c] as const))("%s", (_l, c) => {
    const rec = legacyCase(c);
    expect(rec.synthesisReport.gate).toBe(c.stored);
    expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status === c.stored && rec.gate.status === rec.synthesisReport.gate && rec.gate.loadBearingClaims.filter((x: any) => x.status === "split").length === rec.gate.loadBearingSplitCount).toBe(false);
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const before = JSON.stringify(rec);
    const out = generated(rec, p);
    expect(JSON.stringify(rec)).toBe(before); // stored data read, never written
    expect(rec.synthesisReport.gate).toBe(c.stored); // the raw stored gate is kept

    // LinkedIn: the gate line is the readable one; no caution notice for a stored caution.
    const li = out.linkedin.split("\n");
    expect(li[2]).toBe(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
    expect(out.linkedin).not.toContain(CAUTION_NOTICE);
    // X: same, no "(pass)" / "(requires further review)".
    expect(out.x.split("\n\n")[1]).toBe(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
    expect(out.x).not.toContain("requires further review");
    // Markdown: the computed certainty line states Unavailable; the stored certainty text follows as written and the
    // stored-text note right after it.
    const md = out.markdown.split("\n");
    const at = md.indexOf(`${pct(rec)}% (${UNAVAILABLE}) — ${rec.synthesisReport.certaintyAssessment}`);
    expect(at).toBeGreaterThan(0);
    expect(md.slice(at + 1, at + 3)).toEqual(["", STORED_TEXT_NOTE]);
    // Memo: no gate-based confidence level; the note follows the stored certainty text.
    expect(out.memoInput.confidenceLabel).toBe("No gate-based");
    expect(out.memo).toContain("(No gate-based confidence)");
    expect((out.memoInput.confidenceAssessment ?? "").endsWith(`\n\n${STORED_TEXT_NOTE}`)).toBe(true);

    // Outside the stored text, no generated format states any gate result; the posts and Markdown state Unavailable.
    for (const text of [out.linkedin, out.x, out.markdown]) expect(text).toContain(UNAVAILABLE);
    for (const text of [out.linkedin, out.x, out.markdown, out.memo]) expect(withoutStored(text, rec)).not.toMatch(GATE_RESULT_TEXT);
  });

  it("control: the detectors are live — the CLASSIC output of the same record states the stored gate", () => {
    for (const c of CONFLICTS) {
      const rec = legacyCase(c);
      const out = generated(rec);
      expect(out.linkedin).toContain(`Certainty: ${pct(rec)}% (gate: ${c.stored})`);
      expect(out.x).toContain(`Certainty: ${pct(rec)}% (${c.stored})`);
      expect(out.memoInput.confidenceLabel).toBe(CONFIDENCE[c.stored]);
      for (const text of [out.linkedin, out.x, out.markdown, out.memo]) {
        expect(text).not.toContain("Unavailable");
        expect(withoutStored(text, rec)).toMatch(GATE_RESULT_TEXT);
      }
    }
  });
});

describe("R5-era legacy record (presentation without the Order 4 gate): the presented Markdown path states the readable gate too", () => {
  const r5 = (c: Case) => {
    const rec = withBase(build(c), c.base);
    delete rec.synthesisReport.presentation.verificationGate;
    delete rec.synthesisReport.presentation.disagreementPositionVersion;
    expect(hasGatePresentation(rec.synthesisReport)).toBe(false);
    expect(rec.synthesisReport.presentation).toBeTruthy();
    return rec;
  };
  it.each([...CONFLICTS.slice(0, 2), CONFLICTS[5]].map((c) => [c.label, c] as const))("inconsistent: %s", (_l, c) => {
    const rec = r5(c);
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const out = generated(rec, p);
    const md = out.markdown.split("\n");
    // The panel verdict line and the certainty line: both Unavailable; the note after the certainty block.
    // (A verdict card without a top claim states the stored panel verdict text instead — stored text, as written.)
    const verdictLine = md.find((l) => l.startsWith("**Panel verdict:**"))!;
    if (rec.synthesisReport.verdictCard.topConsensusAgreement) expect(verdictLine).toContain(`certainty ${pct(rec)}%; ${UNAVAILABLE}.`);
    else expect(verdictLine).not.toContain("certainty");
    expect(md.some((l) => l.startsWith(`${pct(rec)}% (${UNAVAILABLE}) — `))).toBe(true);
    expect(md[md.length - 3]).toBe(STORED_TEXT_NOTE);
    expect(out.linkedin.split("\n")[2]).toBe(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
    for (const text of [out.linkedin, out.x, out.markdown, out.memo]) expect(withoutStored(text, rec)).not.toMatch(GATE_RESULT_TEXT);
    // Control: classic keeps the historical "gate: <stored>" in the computed lines.
    const classic = generated(rec).markdown;
    if (rec.synthesisReport.verdictCard.topConsensusAgreement) expect(classic).toContain(`certainty ${pct(rec)}%; gate: ${c.stored}.`);
    expect(classic).toContain(`${pct(rec)}% (gate: ${c.stored}) — `);
  });
  it.each(CONSISTENT.map((c) => [c.label, c] as const))("consistent: %s", (_l, c) => {
    const rec = r5(c);
    const p = presentationOf(rec);
    expect(p.status).toBe(c.stored);
    const md = generated(rec, p).markdown;
    if (rec.synthesisReport.verdictCard.topConsensusAgreement) expect(md).toContain(`certainty ${pct(rec)}%; Verification gate: ${WORD[c.stored]}.`);
    expect(md).toContain(`${pct(rec)}% (Verification gate: ${WORD[c.stored]}) — `);
    expect(md).not.toContain(STORED_TEXT_NOTE);
    expect(withoutStored(md, rec)).not.toMatch(/\bgate: (pass|caution|fail)\b/);
  });
});

describe("consistent legacy record: every generated format states the validated gate label", () => {
  it.each(CONSISTENT.map((c) => [c.label, c] as const))("%s", (_l, c) => {
    const rec = legacyCase(c);
    expect(computeAdaptiveGate(rec.alignedClaims, rec.gate.runCertainty, rec.schemaId).status).toBe(c.stored);
    const p = presentationOf(rec);
    expect(p.status).toBe(c.stored);
    const out = generated(rec, p);
    const label = `Verification gate: ${WORD[c.stored]}`;
    expect(out.linkedin.split("\n")[2]).toBe(`${label} · Certainty: ${pct(rec)}%`);
    expect(out.linkedin.includes(CAUTION_NOTICE)).toBe(c.stored === "caution");
    expect(out.x.split("\n\n")[1]).toBe(`${label}${c.stored === "caution" ? " (requires further review)" : ""} · Certainty: ${pct(rec)}%`);
    expect(out.markdown).toContain(`${pct(rec)}% (${label}) — ${rec.synthesisReport.certaintyAssessment}`);
    expect(out.memoInput.confidenceLabel).toBe(CONFIDENCE[c.stored]);
    expect(out.memoInput.confidenceAssessment).not.toContain(STORED_TEXT_NOTE);
    for (const text of [out.linkedin, out.x, out.markdown, out.memo]) {
      expect(text).not.toContain("Unavailable");
      expect(text).not.toContain(STORED_TEXT_NOTE);
      const outside = withoutStored(text, rec);
      // No historical raw form, and no other status's label.
      expect(outside).not.toMatch(/\bgate: (pass|caution|fail)\b|\((pass|caution|fail)\)/);
      for (const other of (["pass", "caution", "fail"] as Known[]).filter((s) => s !== c.stored)) expect(outside).not.toContain(`Verification gate: ${WORD[other]}`);
    }
    // The memo body is the classic one but for nothing: a consistent record's memo is unchanged.
    expect(out.memo).toBe(generated(rec).memo);
  });
});

describe("Order 4 reports: the readable option gives exactly the classic output (the page shows the same gate)", () => {
  const ORDER4 = [...CONSISTENT, ...CONFLICTS, { label: "marked mixed", base: "generic-mixed", stored: "caution" as Known }, { label: "factual lookup", base: "factual-tie", stored: "caution" as Known }];
  it.each(ORDER4.map((c) => [c.label, c] as const))("%s", (_l, c) => {
    const rec = withBase(build(c), c.base);
    expect(hasGatePresentation(rec.synthesisReport)).toBe(true);
    const p = presentationOf(rec);
    expect(p.status).not.toBe("unavailable");
    expect(generated(rec, p)).toEqual(generated(rec));
  });

  it("marked X post: the option reaches the marked builder too (an unavailable presentation is stated, never the stored gate)", () => {
    const rec = withBase(record("generic-mixed"), "generic-mixed");
    // The 2c17fee records predate the Order 5 marker; mark this one (disagreementPositionVersion 1) for the marked builder.
    rec.synthesisReport.presentation.disagreementPositionVersion = 1;
    const rows = slotRows("generic-mixed");
    const pos = { rows, roster: rows.map((r: any) => r.modelId) } as any;
    const classic = buildAdaptiveXPost(QUESTION, rec.synthesisReport, pos);
    expect(classic).toContain("Verification gate: Caution (requires further review)");
    // The marked builder (its row or its pointer to the full report), never the historical "Models split on: ".
    expect(classic).toMatch(/Unresolved: |unresolved rows? — see the full report/);
    expect(classic).not.toContain("Models split on: ");
    const x = buildAdaptiveXPost(QUESTION, rec.synthesisReport, pos, { status: "unavailable", badge: UNAVAILABLE, bannerNote: STORED_TEXT_NOTE });
    expect(x).toContain(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
    expect(x).not.toMatch(/Verification gate: Caution|requires further review/);
    expect(x).toMatch(/Unresolved: |unresolved rows? — see the full report/); // still the marked builder
    expect(x).not.toContain("Models split on: ");
  });
});

// ── 2. The real pages ──────────────────────────────────────────────────────

describe("the real readable page's Copy / Export memo / LinkedIn / X produce the readable-option text; the classic page's, the classic text", () => {
  const ALL = [...CONFLICTS.map((c) => ({ ...c, kind: "inconsistent" })), ...CONSISTENT.map((c) => ({ ...c, kind: "consistent" }))];
  it.each(ALL.map((c) => [c.kind, c.label, c] as const))("%s: %s", (kind, _l, c) => {
    const rec = legacyCase(c);
    const readable = pageActions(rec, READABLE);
    const expected = generated(rec, presentationOf(rec));
    expect(readable).toEqual({ markdown: expected.markdown, memo: expected.memo, linkedin: expected.linkedin, x: expected.x });
    if (kind === "inconsistent") {
      expect(readable.linkedin).toContain(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
      expect(readable.x).toContain(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
      for (const text of Object.values(readable)) expect(withoutStored(text, rec)).not.toMatch(GATE_RESULT_TEXT);
    } else {
      expect(readable.linkedin).toContain(`Verification gate: ${WORD[c.stored]} · Certainty: ${pct(rec)}%`);
    }

    const classic = pageActions(rec, {});
    const plain = generated(rec);
    expect(classic).toEqual({ markdown: plain.markdown, memo: plain.memo, linkedin: plain.linkedin, x: plain.x });
    expect(classic.linkedin).toContain(`Certainty: ${pct(rec)}% (gate: ${c.stored})`);
    for (const text of Object.values(classic)) expect(text).not.toContain("Unavailable");
  });
});

// ── 3. Frozen classic parity (bb4aed5) ─────────────────────────────────────

/**
 * Captured at bb4aed5 (before this fix) with the same enumeration: the 22 o5p records × 10 gate edits × stored / legacy,
 * plus the remote-work fixture; per record the builders with no option (with and without position input; memo input and
 * memo text) and the classic page (HTML, and its actions' Markdown, memo and posts). 5,266 outputs.
 */
const CLASSIC_DIGEST_AT_BB4AED5 = { count: 5266, sha256: "80d2700414be75d134ea8c2ff78f50ba442e59c96ce76227f553729a59160bb1" };

describe("frozen classic parity: every classic output over the broad fixture set is byte-identical to bb4aed5", () => {
  it("5,266 hashed classic outputs, one digest", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const names = Object.keys(JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json"), "utf8")));
    const edits: Array<[string, (r: any) => void]> = [
      ["none", () => {}],
      ["both-pass", (r) => r.gate && ((r.gate.status = "pass"), (r.synthesisReport.gate = "pass"))],
      ["both-caution", (r) => r.gate && ((r.gate.status = "caution"), (r.synthesisReport.gate = "caution"))],
      ["both-fail", (r) => r.gate && ((r.gate.status = "fail"), (r.synthesisReport.gate = "fail"))],
      ["rep-fail-gate-pass", (r) => r.gate && ((r.gate.status = "pass"), (r.synthesisReport.gate = "fail"))],
      ["rep-pass-gate-fail", (r) => r.gate && ((r.gate.status = "fail"), (r.synthesisReport.gate = "pass"))],
      ["rep-weird", (r) => r.gate && (r.synthesisReport.gate = "verified-ish")],
      ["rep-null", (r) => r.gate && (r.synthesisReport.gate = null)],
      ["split0-pass", (r) => r.gate && ((r.gate.loadBearingSplitCount = 0), (r.gate.status = "pass"), (r.synthesisReport.gate = "pass"))],
      ["inputs-missing", (r) => r.gate && (delete r.gate.runCertainty, delete r.gate.loadBearingSplitCount, delete r.gate.loadBearingClaims)],
    ];
    const recs: Array<[string, () => any, string]> = [];
    for (const n of names)
      for (const [e, f] of edits)
        for (const leg of [false, true])
          recs.push([
            `${n}|${e}|${leg ? "legacy" : "stored"}`,
            () => {
              const r = record(n);
              f(r);
              if (leg && r.synthesisReport) delete r.synthesisReport.presentation;
              return r;
            },
            n,
          ]);
    for (const leg of [false, true])
      recs.push([
        `remote|${leg}`,
        () => {
          const r = remoteWorkFixture().rec;
          if (leg) delete r.synthesisReport.presentation;
          return r;
        },
        "generic-substituted-and-failed",
      ]);

    const out: Record<string, string> = {};
    for (const [key, make, base] of recs) {
      const rec = make();
      const rows = slotRows(base);
      if (rec.synthesisReport) {
        const pos = { rows, roster: rows.map((x: any) => x.modelId) } as any;
        for (const [pk, pi] of [["nopos", undefined], ["pos", pos]] as const) {
          out[`${key}|${pk}|md`] = sha(buildAdaptiveSynthesisMarkdown("Q?", rec.synthesisReport, pi as any));
          out[`${key}|${pk}|li`] = sha(buildAdaptiveLinkedInPost("Q?", rec.synthesisReport, pi as any));
          out[`${key}|${pk}|x`] = sha(buildAdaptiveXPost("Q?", rec.synthesisReport, pi as any));
        }
        const mi = buildAdaptiveMemoInput("Q?", rec.synthesisReport, rows.map((x: any) => x.modelId), "v1", null, rows);
        out[`${key}|memoinput`] = sha(JSON.stringify(mi));
        out[`${key}|memotext`] = sha(normMemo(generateVerificationMemo(mi)));
      }
      // The classic page and its actions.
      const k = `${key}|classic`;
      captured.length = 0;
      clip.length = 0;
      downloads.length = 0;
      posts.length = 0;
      out[`${k}|html`] = sha(renderPanel(rec, rows, {}));
      const sets = captured.filter((p) => p.onGenerateLinkedIn);
      out[`${k}|viewcount`] = String(sets.length);
      for (const p of sets)
        for (const h of ["onCopy", "onExportMemo", "onGenerateLinkedIn", "onGenerateX"]) {
          try {
            const r = p[h]?.();
            if (r && typeof r.catch === "function") r.catch(() => {});
          } catch {
            /* setState after a static render */
          }
        }
      out[`${k}|clip`] = sha(JSON.stringify(clip));
      out[`${k}|memo`] = sha(JSON.stringify(downloads.map(normMemo)));
      out[`${k}|posts`] = sha(JSON.stringify(posts));
    }
    const keys = Object.keys(out).sort();
    const digest = sha(keys.map((k) => `${k}=${out[k]}`).join("\n"));
    expect({ count: keys.length, sha256: digest }).toEqual(CLASSIC_DIGEST_AT_BB4AED5);
  }, 300000);
});
