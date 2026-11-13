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
 *   4. Review of 7212c47: the parity extended to stored / legacy / R5-era presentations × short / long questions (15,798
 *      classic outputs) and to the readable outputs that fix must not change (3,840), both captured at 7212c47. The
 *      unavailable lead and the historical labels are asserted in readableShareGateLead.spec.tsx.
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
const UNAVAILABLE_BANNER =
  "Verification gate: Unavailable — the stored result is inconsistent with its recorded inputs. The gate is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";
/** Review of 7212c47: a stored verdict-bearing value reproduced beside the unavailable gate. */
const HISTORICAL = (what: string) => `Stored ${what} (historical; inconsistent with recorded inputs)`;
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
    linkedin: buildAdaptiveLinkedInPost(QUESTION, rec.synthesisReport, undefined, undefined, readable),
    x: buildAdaptiveXPost(QUESTION, rec.synthesisReport, undefined, undefined, readable),
    // Integration (connector attribution): the page also hands Copy the run's provenance, so a substituted slot's
    // position is named by its executing model ("DeepSeek (substituting Claude)"); so does this.
    markdown: buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, undefined, provenance, undefined, readable),
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
    // Markdown (review of 7212c47): the computed certainty line states Unavailable on its own; the stored certainty text
    // follows, labelled as stored and historical. The banner and the note lead the document (see "leads" below).
    const md = out.markdown.split("\n");
    const at = md.indexOf(`${pct(rec)}% (${UNAVAILABLE})`);
    expect(at).toBeGreaterThan(0);
    expect(md.slice(at + 1, at + 3)).toEqual(["", `**${HISTORICAL("certainty text")}:** ${rec.synthesisReport.certaintyAssessment}`]);
    // Memo: no gate-based confidence level; the banner and the note lead the findings; the stored assessment is labelled.
    expect(out.memoInput.confidenceLabel).toBe("No gate-based");
    expect(out.memo).toContain("(No gate-based confidence)");
    expect(out.memoInput.keyFindings?.[0]).toBe(`${UNAVAILABLE_BANNER} ${STORED_TEXT_NOTE}`);
    expect((out.memoInput.confidenceAssessment ?? "").startsWith(`${HISTORICAL("assessment")}:\n`)).toBe(true);

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
    // The panel verdict line and the certainty line: both Unavailable; the banner and the note lead (review of 7212c47).
    // (A verdict card without a top claim reproduces the stored panel verdict text — labelled as stored and historical.)
    if (rec.synthesisReport.verdictCard.topConsensusAgreement) expect(md.find((l) => l.startsWith("**Panel verdict:**"))).toContain(`certainty ${pct(rec)}%; ${UNAVAILABLE}.`);
    else {
      expect(md.some((l) => l.startsWith("**Panel verdict:**"))).toBe(false);
      expect(md.some((l) => l.startsWith(`**${HISTORICAL("panel verdict")}:** `))).toBe(true);
    }
    expect(md).toContain(`${pct(rec)}% (${UNAVAILABLE})`);
    expect(md.some((l) => l.startsWith(`**${HISTORICAL("certainty text")}:** `))).toBe(true);
    expect(md.slice(4, 7)).toEqual([UNAVAILABLE_BANNER, "", STORED_TEXT_NOTE]);
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
    const x = buildAdaptiveXPost(QUESTION, rec.synthesisReport, pos, undefined, { status: "unavailable", badge: UNAVAILABLE, banner: UNAVAILABLE_BANNER, bannerNote: STORED_TEXT_NOTE });
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
// Re-recorded at the connector integration (Order 34, evidence INTEGRATION.md): was 80d27004…0bb1 at bb4aed5. Exactly 44 of
// the 5,266 outputs differ from main 2cd71bb — the classic page's copied text and HTML of the two records with a
// substituted slot (generic-substituted-and-failed, remote), where the accepted connector attribution names the
// substituted slot's executing model; no other output moved (per-key diff in the evidence folder).
// Re-recorded (owner-authorized F-1, Order 35 A): was ccae07a7…ea3d at the integration head 3e94848. Exactly 22 of the 5,266
// outputs differ — the classic page's memo download of the two records with a failed and a substituted slot
// (generic-substituted-and-failed × 10 gate edits × stored/legacy, remote × 2): "5 AI models researched … independently" /
// "researched by 5 large language models" → 4 (the verified count of answering executing models). No other line or output
// moved (per-key and per-line diff in the Order 35 evidence folder).
const CLASSIC_DIGEST_AT_BB4AED5 = { count: 5266, sha256: "fcd45130e4ff0ddc0ad4732d9782551510f503c7b06afcbf2705bab7fd8969dd" };

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

// ── 4. Frozen parity extended (review of 7212c47) ──────────────────────────

/**
 * Review of 7212c47 extends the frozen parity above (which stays as it is) to the cases the readable fix touches:
 *   - classic: the 22 o5p records × the 10 gate edits × three presentation variants (as stored; legacy — no presentation;
 *     R5-era — presentation without the Order 4 gate) × a short and a long question, plus the remote-work fixture: the
 *     builders with no option (with and without position input; memo input and memo text) and the classic page with that
 *     question (HTML, and its actions' Markdown, memo and posts). Captured at 7212c47 (before this fix).
 *   - readable, what this fix must not change: over the same records with the short question, the readable option's
 *     LinkedIn and X posts for every page presentation, and its Markdown and memo for every presentation but
 *     "unavailable" (consistent legacy records, Order 4 reports, unrecognized). Captured at 7212c47.
 */
const LONG_QUESTION_290B =
  "Across the last two decades of peer-reviewed labour-economics research, does a sustained shift to remote or hybrid work measurably change individual and team productivity, and how do sector, task type and measurement method change the answer?";
// Re-recorded at the connector integration (Order 34): was e7fa0463…dcab at 7212c47. 479 of 15,798 outputs differ from main
// 2cd71bb: the classic X post (and the page's posts) for the long question, where the accepted connector D03 budget keeps
// the computed result and the brand line whole (main's classic build cut both), and the substituted-slot attribution on the
// two records with a substituted slot. The readable-unchanged digest below did not move.
// Re-recorded (owner-authorized F-1, Order 35 A): was 201f5680…0b16 at 3e94848. Exactly 66 of 15,798 outputs differ, all the
// classic page's memo download of the same two records, with the same single correction (5 → 4 independent answering
// models); the readable-unchanged digest below did not move.
const CLASSIC_DIGEST_AT_7212C47 = { count: 15798, sha256: "0f2af7f84de37cdf57135aef273c52de2bc5788e731b674949d80a821574441d" };
const READABLE_UNCHANGED_DIGEST_AT_7212C47 = { count: 3840, sha256: "5db7b09c022b33834c028c03845c4fbadad9032c84cb01383fa3508a2508a17f" };

function extendedRecords(): Array<[string, () => any, string]> {
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
  const variant = (r: any, v: string) => {
    if (!r.synthesisReport?.presentation) return;
    if (v === "legacy") delete r.synthesisReport.presentation;
    if (v === "r5") {
      delete r.synthesisReport.presentation.verificationGate;
      delete r.synthesisReport.presentation.disagreementPositionVersion;
    }
  };
  const recs: Array<[string, () => any, string]> = [];
  for (const n of names)
    for (const [e, f] of edits)
      for (const v of ["stored", "legacy", "r5"])
        recs.push([
          `${n}|${e}|${v}`,
          () => {
            const r = record(n);
            f(r);
            variant(r, v);
            return r;
          },
          n,
        ]);
  for (const v of ["stored", "legacy", "r5"])
    recs.push([
      `remote|${v}`,
      () => {
        const r = remoteWorkFixture().rec;
        variant(r, v);
        return r;
      },
      "generic-substituted-and-failed",
    ]);
  return recs;
}

const sha290b = (s: string) => createHash("sha256").update(s).digest("hex");
function digestOf(out: Record<string, string>) {
  const keys = Object.keys(out).sort();
  if (process.env.R290B_DUMP) require("fs").writeFileSync(`${process.env.R290B_DUMP}.${keys.length}.json`, JSON.stringify(out, Object.keys(out).sort(), 1));
  return { count: keys.length, sha256: sha290b(keys.map((k) => `${k}=${out[k]}`).join("\n")) };
}

describe("frozen parity extended (review of 7212c47)", () => {
  it("classic: every classic output over records × gate edits × presentation variants × short / long question is byte-identical to 7212c47", () => {
    const out: Record<string, string> = {};
    for (const [key, make, base] of extendedRecords())
      for (const [qk, q] of [["short", QUESTION], ["long", LONG_QUESTION_290B]] as const) {
        const rec = make();
        const rows = slotRows(base);
        const k0 = `${key}|${qk}`;
        if (rec.synthesisReport) {
          const pos = { rows, roster: rows.map((x: any) => x.modelId) } as any;
          for (const [pk, pi] of [["nopos", undefined], ["pos", pos]] as const) {
            out[`${k0}|${pk}|md`] = sha290b(buildAdaptiveSynthesisMarkdown(q, rec.synthesisReport, pi as any));
            out[`${k0}|${pk}|li`] = sha290b(buildAdaptiveLinkedInPost(q, rec.synthesisReport, pi as any));
            out[`${k0}|${pk}|x`] = sha290b(buildAdaptiveXPost(q, rec.synthesisReport, pi as any));
          }
          const mi = buildAdaptiveMemoInput(q, rec.synthesisReport, rows.map((x: any) => x.modelId), "v1", null, rows);
          out[`${k0}|memoinput`] = sha290b(JSON.stringify(mi));
          out[`${k0}|memotext`] = sha290b(normMemo(generateVerificationMemo(mi)));
        }
        const k = `${k0}|classic`;
        captured.length = 0;
        clip.length = 0;
        downloads.length = 0;
        posts.length = 0;
        out[`${k}|html`] = sha290b(renderPanel(rec, rows, { question: q }));
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
        out[`${k}|clip`] = sha290b(JSON.stringify(clip));
        out[`${k}|memo`] = sha290b(JSON.stringify(downloads.map(normMemo)));
        out[`${k}|posts`] = sha290b(JSON.stringify(posts));
      }
    expect(digestOf(out)).toEqual(CLASSIC_DIGEST_AT_7212C47);
  }, 600000);

  it("readable: the outputs this fix must not change (posts for every presentation, Markdown / memo unless unavailable) equal 7212c47", () => {
    const out: Record<string, string> = {};
    const statuses = new Set<string>();
    for (const [key, make, base] of extendedRecords()) {
      const rec = make();
      if (!rec.synthesisReport) continue;
      const p = readableGatePresentation({ gate: rec.gate, synthesisReport: rec.synthesisReport, schemaId: rec.schemaId });
      statuses.add(p.status);
      const rows = slotRows(base);
      const pos = { rows, roster: rows.map((x: any) => x.modelId) } as any;
      for (const [pk, pi] of [["nopos", undefined], ["pos", pos]] as const) {
        out[`${key}|${p.status}|${pk}|li`] = sha290b(buildAdaptiveLinkedInPost(QUESTION, rec.synthesisReport, pi as any, undefined, p));
        out[`${key}|${p.status}|${pk}|x`] = sha290b(buildAdaptiveXPost(QUESTION, rec.synthesisReport, pi as any, undefined, p));
        if (p.status !== "unavailable") out[`${key}|${p.status}|${pk}|md`] = sha290b(buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, pi as any, undefined, undefined, p));
      }
      if (p.status !== "unavailable") {
        const mi = buildAdaptiveMemoInput(QUESTION, rec.synthesisReport, rows.map((x: any) => x.modelId), "v1", null, rows, p);
        out[`${key}|${p.status}|memoinput`] = sha290b(JSON.stringify(mi));
        out[`${key}|${p.status}|memotext`] = sha290b(normMemo(generateVerificationMemo(mi)));
      }
    }
    expect([...statuses].sort()).toEqual(["caution", "fail", "pass", "unavailable", "unrecognized"]);
    expect(digestOf(out)).toEqual(READABLE_UNCHANGED_DIGEST_AT_7212C47);
  }, 600000);
});
