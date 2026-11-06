/**
 * #290 Increment 1 — review of 7212c47 (MINOR + NIT 1).
 *
 * MINOR: the readable copied Markdown of a legacy record whose stored gate contradicts its recorded inputs (the page shows
 * "Verification gate: Unavailable") opened with the stored claims — "**Panel verdict:** No consensus identified. Certainty
 * 54%; gate: caution.", then the stored answer "Verification gate: Caution. Caution: …" — and stated Unavailable (and the
 * stored-text note) only after the Certainty line. Owner order: lead with the page's banner and the note, before any raw
 * stored verdict / answer text; a raw stored verdict-bearing value that is still reproduced is labelled "Stored …
 * (historical; inconsistent with recorded inputs)". The memo the same; LinkedIn and X state the same status.
 * Consistent records (Pass / Caution / Fail), Order 4 reports and classic: no banner lead, no label, no reordering.
 *
 * NIT 1: the readable X post must fit X's 280 characters as classic does, keep "via ConvergePanel", and never cut the
 * gate line or a row's computed result (the model-written claim / topic and then the question give way).
 *
 * Review of 8def047 (MINOR): the stored executive summary was reproduced under "## Executive Summary" unlabelled. On a
 * legacy record it is often the stored verdict itself (the answer with its "Verification gate: Caution." lead, or the
 * pre-R5 fail template "Panel could not converge on a reliable answer."), and on an R5-era record it reproduces the
 * stored answer note. It is now labelled "Stored executive summary (historical; …)" as the answer is. CONFLICTS gains
 * a record whose summary carries a gate verdict and a pre-R5 fail-template summary; the complete copied Markdown of the
 * review's repro is asserted line for line. NIT-2: the X give-way order (claim before question) is pinned; NIT-3: the
 * defined X fallback is reached.
 *
 * Expected words are written out literally here, not read from the code under test.
 */
import { hasGatePresentation } from "@/lib/adaptiveSchema/gatePresentation";
import { buildAdaptiveLinkedInPost, buildAdaptiveMemoInput, buildAdaptiveSynthesisMarkdown, buildAdaptiveXPost } from "@/lib/adaptiveSchema/shareBuilders";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import { escapeMarkdownInline } from "@/lib/adaptiveSchema/textSerialization";
import { readableGatePresentation } from "@/lib/research/readableReport/trustSignals";
import { readFileSync } from "fs";
import { join } from "path";
import { QUESTION, record, remoteWorkFixture, slotRows } from "./readableFixtures";

const UNAVAILABLE = "Verification gate: Unavailable";
const BANNER =
  "Verification gate: Unavailable — the stored result is inconsistent with its recorded inputs. The gate is a rule-based check of the panel's certainty score and split positions; it is not an independent verification of the evidence.";
const NOTE = "Text stored with this report (such as the answer or the certainty line) may name a gate result. That stored text is reproduced as written; it is not the gate result.";
const LABEL = (what: string) => `Stored ${what} (historical; inconsistent with recorded inputs)`;
const HISTORICAL = "(historical; inconsistent with recorded inputs)";
/** The pre-R5 fail template: buildTemplateExecutiveSummary / the unified answer of a failed legacy run. */
const FAIL_TEMPLATE = "Panel could not converge on a reliable answer.";
/** A stored verdict without a gate word: the fail template. */
const STORED_VERDICT_TEXT = /Panel could not converge on a reliable answer/;
/** Any gate result statement: the D6 label, the historical "(gate: pass)" / X "(pass)" forms, a memo confidence level. */
const GATE_RESULT_TEXT = /Verification gate: (Pass|Caution|Fail)\b|\bgate: (pass|caution|fail)\b|\((pass|caution|fail)\)|\b(High|Medium|Low) confidence\b/i;
const LONG_QUESTION =
  "Across the last two decades of peer-reviewed labour-economics research, does a sustained shift to remote or hybrid work measurably change individual and team productivity, and how do sector, task type and measurement method change the answer?";

const pct = (rec: any) => Math.round(rec.synthesisReport.runCertainty * 100);
const normMemo = (m: string) => m.replace(/^Generated: .*$/m, "Generated: <n>");
const presentationOf = (rec: any) => readableGatePresentation({ gate: rec.gate, synthesisReport: rec.synthesisReport, schemaId: rec.schemaId });

/** Every stored string of the report at least 20 characters long. */
function storedStrings(report: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length >= 20) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(report);
  return out;
}
/** The earliest index in `text` of any stored string, and how many stored strings occur at all. */
function firstStored(text: string, rec: any): { at: number; found: number } {
  const hits = storedStrings(rec.synthesisReport)
    .map((s) => text.indexOf(s))
    .filter((i) => i >= 0);
  return { at: hits.length ? Math.min(...hits) : Infinity, found: hits.length };
}
const firstGateWord = (text: string) => {
  const m = GATE_RESULT_TEXT.exec(text);
  return m ? m.index : Infinity;
};

type Variant = "legacy" | "r5";
const asVariant = (rec: any, v: Variant) => {
  if (v === "legacy") delete rec.synthesisReport.presentation;
  else {
    delete rec.synthesisReport.presentation.verificationGate;
    delete rec.synthesisReport.presentation.disagreementPositionVersion;
  }
  expect(hasGatePresentation(rec.synthesisReport)).toBe(false);
  return rec;
};

interface Case {
  label: string;
  base: string;
  make?: () => any;
  edit?: (rec: any) => void;
}
const CONFLICTS: Case[] = [
  { label: "stored PASS under the pass threshold (no top claim)", base: "generic-malformed", edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "pass")) },
  { label: "stored PASS, two load-bearing splits", base: "legal-regulatory", edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "pass")) },
  { label: "stored PASS, split count disagrees", base: "contested-empirical", edit: (r) => ((r.gate.loadBearingSplitCount = 0), (r.gate.status = "pass"), (r.synthesisReport.gate = "pass")) },
  { label: "stored CAUTION over full certainty (generic-malformed shape kept)", base: "generic-malformed", edit: (r) => ((r.gate.runCertainty = 1), (r.gate.loadBearingSplitCount = 0), (r.gate.loadBearingClaims = [])) },
  { label: "stored CAUTION over full certainty and no split", base: "generic-consensus", edit: (r) => ((r.gate.status = "caution"), (r.synthesisReport.gate = "caution")) },
  { label: "stored FAIL over caution inputs (remote work)", base: "generic-substituted-and-failed", make: () => remoteWorkFixture().rec },
  { label: "stored FAIL over full certainty", base: "generic-consensus", edit: (r) => ((r.gate.status = "fail"), (r.synthesisReport.gate = "fail")) },
  { label: "report FAIL, gate object pass", base: "generic-consensus", edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "fail")) },
  { label: "report PASS, gate object fail (medical, no top claim)", base: "medical-health", edit: (r) => ((r.gate.status = "fail"), (r.synthesisReport.gate = "pass")) },
  // Review of 8def047: the stored summary carries a gate verdict ("Verification gate: Caution. Caution: …").
  { label: "gate object PASS, summary states the stored caution (generic-mixed-narrative-fail)", base: "generic-mixed-narrative-fail", edit: (r) => (r.gate.status = "pass") },
  // Review of 8def047: a pre-R5 failed run — summary and answer are the fail template; stored PASS over two splits.
  {
    label: "stored PASS, pre-R5 fail-template summary (legal-regulatory)",
    base: "legal-regulatory",
    edit: (r) => ((r.gate.status = "pass"), (r.synthesisReport.gate = "pass"), (r.synthesisReport.executiveSummary = FAIL_TEMPLATE), (r.synthesisReport.unifiedAnswer = FAIL_TEMPLATE)),
  },
];
const CONSISTENT: Case[] = [
  { label: "valid PASS (generic-consensus)", base: "generic-consensus" },
  { label: "valid PASS (procedural)", base: "procedural" },
  { label: "valid CAUTION (contested-empirical)", base: "contested-empirical" },
  { label: "valid CAUTION (generic-splits)", base: "generic-splits" },
  { label: "valid FAIL (legal-regulatory)", base: "legal-regulatory" },
];
const build = (c: Case, v: Variant) => {
  const rec = c.make ? c.make() : record(c.base);
  c.edit?.(rec);
  return asVariant(rec, v);
};

function outputs(rec: any, base: string, question: string, readable?: any) {
  const rows = slotRows(base);
  const memoInput = buildAdaptiveMemoInput(question, rec.synthesisReport, rows.map((r: any) => r.modelId), "run-290", null, undefined, readable);
  return {
    markdown: buildAdaptiveSynthesisMarkdown(question, rec.synthesisReport, undefined, readable),
    memoInput,
    memo: normMemo(generateVerificationMemo(memoInput)),
    linkedin: buildAdaptiveLinkedInPost(question, rec.synthesisReport, undefined, readable),
    x: buildAdaptiveXPost(question, rec.synthesisReport, undefined, readable),
  };
}

const MATRIX = (cases: Case[]) => cases.flatMap((c) => (["legacy", "r5"] as Variant[]).flatMap((v) => [QUESTION, LONG_QUESTION].map((q) => [`${v} · ${c.label} · ${q === QUESTION ? "short" : "long"} question`, c, v, q] as const)));

// ── Positive: the unavailable gate leads; stored values are labelled ───────

describe("inconsistent legacy record (readable): the unavailable gate leads every generated text; stored verdicts are labelled historical", () => {
  it.each(MATRIX(CONFLICTS))("%s", (_l, c, v, q) => {
    const rec = build(c, v);
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const out = outputs(rec, c.base, q, p);

    // Markdown: question, then the banner, then the note — before any stored text and any stored gate word.
    const md = out.markdown;
    const lines = md.split("\n");
    expect(lines.slice(0, 7)).toEqual(["# Synthesis Report", "", `**Question:** ${q}`, "", BANNER, "", NOTE]);
    const banner = md.indexOf(BANNER);
    const note = md.indexOf(NOTE);
    const stored = firstStored(md, rec);
    expect(stored.found).toBeGreaterThan(0); // the check is live: stored text is reproduced
    expect(banner).toBeLessThan(note);
    expect(note).toBeLessThan(stored.at);
    expect(note).toBeLessThan(firstGateWord(md));
    expect(firstGateWord(md)).toBeLessThan(Infinity); // the stored gate words are still reproduced (transparency) …
    // … but only under a historical label: each line naming a gate result is a labelled stored value, or follows the
    // labelled stored answer within the Unified Answer section.
    // Review of 8def047: and every line of the Executive Summary section follows its stored-summary label; a stored
    // verdict without a gate word (the fail template) is held to the same rule.
    let section = "";
    let underStoredAnswer = false;
    let underStoredSummary = false;
    for (const line of lines) {
      if (line.startsWith("## ")) {
        section = line;
        underStoredAnswer = false;
        underStoredSummary = false;
        continue;
      }
      if (line === `**${LABEL("answer")}:**`) underStoredAnswer = section === "## Unified Answer";
      if (line === `**${LABEL("executive summary")}:**`) underStoredSummary = section === "## Executive Summary";
      if (section === "## Executive Summary" && line !== "" && line !== `**${LABEL("executive summary")}:**`) expect(underStoredSummary).toBe(true);
      if (!GATE_RESULT_TEXT.test(line) && !STORED_VERDICT_TEXT.test(line)) continue;
      expect(line.startsWith("**Stored ") || underStoredAnswer || underStoredSummary).toBe(true);
    }
    // The Executive Summary section reproduces stored text, so it opens with the stored-summary label (both paths); on
    // the legacy path the stored summary follows it verbatim.
    const es = lines.indexOf("## Executive Summary");
    expect(lines[es + 1]).toBe(`**${LABEL("executive summary")}:**`);
    expect(lines[es + 2].length).toBeGreaterThan(0);
    if (v === "legacy") expect(lines.slice(es + 2).join("\n").startsWith(`${rec.synthesisReport.executiveSummary}\n`)).toBe(true);
    expect(lines.filter((l) => l === `**${LABEL("executive summary")}:**`)).toHaveLength(1);
    // The raw stored panel verdict appears only under its historical label; an unlabelled "Panel verdict" line is only
    // the computed one, which states Unavailable.
    const verdict = rec.synthesisReport.panelVerdict as string;
    const verdictLines = lines.filter((l) => l.includes(verdict) || l.includes(escapeMarkdownInline(verdict)));
    verdictLines.forEach((l) => expect(l.startsWith(`**${LABEL("panel verdict")}:** `)).toBe(true));
    lines.filter((l) => l.startsWith("**Panel verdict:**")).forEach((l) => expect(l).toContain(`; ${UNAVAILABLE}.`));
    if (!rec.synthesisReport.verdictCard.topConsensusAgreement || v === "legacy") {
      expect(verdictLines).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith(`**${LABEL("panel verdict")}:** `))).toHaveLength(1);
    }
    // The Unified Answer section reproduces stored text, so it opens with the stored-answer label (legacy and R5 paths).
    const ans = lines.indexOf("## Unified Answer");
    expect(lines[ans + 1]).toBe(`**${LABEL("answer")}:**`);
    expect(lines[ans + 2].length).toBeGreaterThan(0);
    // The Certainty section: the readable gate alone, then the stored certainty text, labelled.
    const cert = lines.indexOf("## Certainty");
    expect(lines.slice(cert + 1, cert + 4)).toEqual([`${pct(rec)}% (${UNAVAILABLE})`, "", `**${LABEL("certainty text")}:** ${rec.synthesisReport.certaintyAssessment}`]);
    // The banner and note are written once, at the top (not repeated at the bottom).
    expect(md.split(NOTE)).toHaveLength(2);
    expect(md.split(BANNER)).toHaveLength(2);

    // Memo: the banner and note are its first statement after the computed figures, before any stored text; the stored
    // assessment is labelled.
    const memo = out.memo;
    const mBanner = memo.indexOf(`- ${BANNER} ${NOTE}`);
    expect(mBanner).toBeGreaterThan(memo.indexOf("KEY FINDINGS"));
    const mStored = firstStored(memo, rec);
    expect(mStored.found).toBeGreaterThan(0);
    expect(mBanner).toBeLessThan(mStored.at);
    expect(mBanner).toBeLessThan(firstGateWord(memo));
    expect(memo).toContain(`CONFIDENCE ASSESSMENT\n${LABEL("assessment")}:\n`);
    expect(memo).toContain("(No gate-based confidence)");

    // LinkedIn and X: the same status, stated before any stored text.
    for (const post of [out.linkedin, out.x]) {
      expect(post).toContain(`${UNAVAILABLE} · Certainty: ${pct(rec)}%`);
      expect(post.indexOf(UNAVAILABLE)).toBeLessThan(firstStored(post, rec).at);
      expect(post).not.toMatch(GATE_RESULT_TEXT);
    }
  });
});

// ── Review of 8def047: the complete copied Markdown of the review's repro ──

describe("review of 8def047 repro: the complete readable copied Markdown, opening lines first", () => {
  it("generic-mixed-narrative-fail, gate object PASS, legacy shape: every line, the stored summary labelled", () => {
    const rec = record("generic-mixed-narrative-fail");
    rec.gate.status = "pass";
    delete rec.synthesisReport.presentation;
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const STORED_CAUTION =
      "Verification gate: Caution. Caution: This result requires further review. The panel did not meet the conditions for a clean verification pass. Review the findings and limitations before relying on this answer.";
    const STORED_BODY = [
      "",
      "“Raising the minimum wage reduces employment” (ChatGPT, Claude, Grok, Perplexity, Gemini). “Inflation expectations remain anchored” (ChatGPT, Claude, Grok, Perplexity, Gemini).",
      "",
      "Unresolved load-bearing claim:",
      "- “Tariffs protect domestic manufacturing jobs” (split: 1 of 5 dispatched models support it and 1 disputes it)",
    ];
    expect(buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, undefined, p).split("\n")).toEqual([
      "# Synthesis Report",
      "",
      "**Question:** Does remote work change productivity?",
      "",
      BANNER,
      "",
      NOTE,
      "",
      "**Stored panel verdict (historical; inconsistent with recorded inputs):** 5/5 models converge on “Raising the minimum wage reduces employment”; certainty 71%; gate: caution.",
      "",
      "## Unified Answer",
      "**Stored answer (historical; inconsistent with recorded inputs):**",
      STORED_CAUTION,
      ...STORED_BODY,
      "",
      "## Executive Summary",
      "**Stored executive summary (historical; inconsistent with recorded inputs):**",
      STORED_CAUTION,
      ...STORED_BODY,
      "",
      "## Where models agree",
      "- “Raising the minimum wage reduces employment”",
      "- “Inflation expectations remain anchored”",
      "",
      "## Where models disagree",
      "- **Tariffs protect domestic manufacturing jobs** — Models take different positions on this point — see each model's excerpt below.",
      "  - ChatGPT: Tariffs protect jobs.",
      "  - Claude: Tariffs do not protect jobs.",
      "  - Grok: Tariff effects are unclear.",
      "- **Housing prices will cool** — Models take different positions on this point — see each model's excerpt below.",
      "  - ChatGPT: Housing will cool.",
      "  - Claude: Housing will not cool.",
      "  - Grok: No cooling expected.",
      "- **Productivity growth will accelerate** — Models take different positions on this point — see each model's excerpt below.",
      "  - ChatGPT: Productivity may rise somewhat.",
      "  - Claude: Productivity may rise somewhat.",
      "",
      "## Bias & blind spots",
      "- **recency bias** — ChatGPT and Grok take opposite positions on rates.",
      "",
      "## Certainty",
      "71% (Verification gate: Unavailable)",
      "",
      "**Stored certainty text (historical; inconsistent with recorded inputs):** Run certainty 71% (gate: caution). Of 6 scored claims across 5 dispatched models: consensus on 2; a split on 3; a single source only on 1.",
      "",
      "Source: convergepanel.com",
    ]);
  });

  it("pre-R5 fail template (legacy), stored PASS: the template stands only under the stored labels", () => {
    const rec = record("legal-regulatory");
    rec.gate.status = "pass";
    rec.synthesisReport.gate = "pass";
    rec.synthesisReport.executiveSummary = FAIL_TEMPLATE;
    rec.synthesisReport.unifiedAnswer = FAIL_TEMPLATE;
    delete rec.synthesisReport.presentation;
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const lines = buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, undefined, p).split("\n");
    expect(lines.slice(0, 8)).toEqual(["# Synthesis Report", "", "**Question:** Does remote work change productivity?", "", BANNER, "", NOTE, ""]);
    const es = lines.indexOf("## Executive Summary");
    expect(lines.slice(es, es + 4)).toEqual(["## Executive Summary", "**Stored executive summary (historical; inconsistent with recorded inputs):**", FAIL_TEMPLATE, ""]);
    const ans = lines.indexOf("## Unified Answer");
    expect(lines.slice(ans, ans + 3)).toEqual(["## Unified Answer", "**Stored answer (historical; inconsistent with recorded inputs):**", FAIL_TEMPLATE]);
    expect(lines.filter((l) => l === FAIL_TEMPLATE)).toHaveLength(2);
  });

  it("an empty stored summary gets no label: nothing stored is reproduced there", () => {
    const rec = record("generic-mixed-narrative-fail");
    rec.gate.status = "pass";
    delete rec.synthesisReport.presentation;
    rec.synthesisReport.executiveSummary = "";
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const lines = buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, undefined, p).split("\n");
    const es = lines.indexOf("## Executive Summary");
    expect(lines.slice(es, es + 4)).toEqual(["## Executive Summary", "", "", "## Where models agree"]);
    expect(lines).not.toContain("**Stored executive summary (historical; inconsistent with recorded inputs):**");
  });

  it("R5-era presented path (legal-regulatory, stored PASS): the stored answer note in the summary is labelled", () => {
    const rec = record("legal-regulatory");
    rec.gate.status = "pass";
    rec.synthesisReport.gate = "pass";
    delete rec.synthesisReport.presentation.verificationGate;
    delete rec.synthesisReport.presentation.disagreementPositionVersion;
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    const lines = buildAdaptiveSynthesisMarkdown(QUESTION, rec.synthesisReport, undefined, p).split("\n");
    expect(lines.slice(0, 8)).toEqual(["# Synthesis Report", "", "**Question:** Does remote work change productivity?", "", BANNER, "", NOTE, ""]);
    const es = lines.indexOf("## Executive Summary");
    expect(lines[es + 1]).toBe("**Stored executive summary (historical; inconsistent with recorded inputs):**");
    const summary = lines.slice(es + 2, lines.findIndex((l, i) => i > es && l.startsWith("## ")));
    expect(summary).toContain(FAIL_TEMPLATE);
  });
});

// ── Negative: consistent records and classic get no lead, no label ─────────

describe("consistent legacy record (readable) and every classic output: no banner lead, no historical label, no reordering", () => {
  it.each(MATRIX(CONSISTENT))("readable, %s", (_l, c, v, q) => {
    const rec = build(c, v);
    const p = presentationOf(rec);
    expect(p.status).not.toBe("unavailable");
    const out = outputs(rec, c.base, q, p);
    const lines = out.markdown.split("\n");
    expect(lines[4].startsWith("**Panel verdict:** ")).toBe(true); // the verdict follows the question, as before
    for (const text of [out.markdown, out.memo, out.linkedin, out.x]) {
      expect(text).not.toContain(HISTORICAL);
      expect(text).not.toContain(BANNER);
      expect(text).not.toContain(NOTE);
      expect(text).not.toContain("Unavailable");
    }
    expect(lines.some((l) => l.startsWith(`${pct(rec)}% (Verification gate: `) && l.includes(") — "))).toBe(true);
    expect(out.memoInput.keyFindings?.[0] ?? "").not.toContain("Verification gate");
  });

  it.each(MATRIX([...CONFLICTS, ...CONSISTENT]))("classic, %s", (_l, c, v, q) => {
    const rec = build(c, v);
    const out = outputs(rec, c.base, q);
    for (const text of [out.markdown, out.memo, out.linkedin, out.x]) {
      expect(text).not.toContain(HISTORICAL);
      expect(text).not.toContain(BANNER);
      expect(text).not.toContain("Unavailable");
    }
    expect(out.markdown.split("\n")[4].startsWith("**Panel verdict:** ")).toBe(true);
    expect(out.markdown).toMatch(new RegExp(`\\n${pct(rec)}% \\(gate: (pass|caution|fail)\\) — `));
  });
});

// ── NIT 1: readable X posts fit ────────────────────────────────────────────

describe("readable X post: at most 280 characters, the brand kept, the gate line and a row's computed result never cut", () => {
  const names = Object.keys(JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/o5p/__fixtures__/baseline-2c17fee/records.json"), "utf8")));
  const LONG_TOPIC = "Whether hybrid schedules raise measured output per hour once commuting time saved is counted as productive time";
  const GATES: Array<Record<string, any>> = [
    { status: "unavailable", badge: UNAVAILABLE, banner: BANNER, bannerNote: NOTE },
    { status: "caution", badge: "Verification gate: Caution", banner: "b", bannerNote: null },
    { status: "pass", badge: "Verification gate: Pass", banner: "b", bannerNote: null },
    { status: "fail", badge: "Verification gate: Fail", banner: "b", bannerNote: null },
  ];
  const shapes: Array<[string, (r: any) => void]> = [
    ["stored", () => {}],
    ["legacy", (r) => delete r.synthesisReport.presentation],
    ["r5", (r) => (delete r.synthesisReport.presentation.verificationGate, delete r.synthesisReport.presentation.disagreementPositionVersion)],
    ["legacy-long-topic", (r) => (delete r.synthesisReport.presentation, r.synthesisReport.disagreements[0] && (r.synthesisReport.disagreements[0].topic = LONG_TOPIC))],
    ["r5-long-result", (r) => (delete r.synthesisReport.presentation.verificationGate, delete r.synthesisReport.presentation.disagreementPositionVersion, r.synthesisReport.presentation.disagree[0] && (r.synthesisReport.presentation.disagree[0].result = `${r.synthesisReport.presentation.disagree[0].result}; recorded across sectors`))],
  ];

  it("over every o5p record × shape × gate × question length", () => {
    let checked = 0;
    let withRow = 0;
    let gaveWay = 0;
    for (const n of names) {
      if (!record(n).synthesisReport) continue;
      for (const [, shape] of shapes)
        for (const g of GATES)
          for (const q of [QUESTION, LONG_QUESTION]) {
            const rec = record(n);
            shape(rec);
            if (rec.synthesisReport.presentation?.disagreementPositionVersion) continue; // the marked builder has its own budget
            const x = buildAdaptiveXPost(q, rec.synthesisReport, undefined, g as any);
            const gateLine = `${g.badge}${g.status === "caution" ? " (requires further review)" : ""} · Certainty: ${pct(rec)}%`;
            checked += 1;
            expect(x.length).toBeLessThanOrEqual(280);
            const parts = x.split("\n\n");
            expect(parts[parts.length - 1]).toBe("via ConvergePanel");
            expect(parts[1]).toBe(gateLine);
            const split = rec.synthesisReport.presentation?.disagree?.[0];
            const row = parts.find((s) => s.startsWith("Models split on: "));
            if (row) {
              withRow += 1;
              if (split) expect(row.endsWith(` — panel result: ${split.result}`)).toBe(true);
            } else if (split || rec.synthesisReport.disagreements.length > 0) {
              expect(x).toBe(["Asked a multi-model AI panel", gateLine, "via ConvergePanel"].join("\n\n")); // the defined fallback only
            }
            if (q === LONG_QUESTION && !parts[0].endsWith(`${LONG_QUESTION.slice(0, 60)}`) && parts[0].length < 31 + 80) gaveWay += 1;
          }
    }
    process.stdout.write(`X fit: checked=${checked} withRow=${withRow} gaveWay=${gaveWay}\n`);
    expect(checked).toBeGreaterThan(700);
    expect(withRow).toBeGreaterThan(300);
    expect(gaveWay).toBeGreaterThan(0); // the question gave way somewhere (the case the NIT names)
  });

  it("the case the review names: a caution legacy record with a long question and topic keeps the brand and its full row", () => {
    const rec = record("generic-splits");
    delete rec.synthesisReport.presentation;
    rec.synthesisReport.disagreements[0].topic = LONG_TOPIC;
    const x = buildAdaptiveXPost(LONG_QUESTION, rec.synthesisReport, undefined, GATES[1] as any);
    expect(x.length).toBeLessThanOrEqual(280);
    expect(x.endsWith("\n\nvia ConvergePanel")).toBe(true);
    expect(x).toContain(`Verification gate: Caution (requires further review) · Certainty: ${pct(rec)}%`);
    expect(x).toMatch(/\n\nModels split on: Whether hybrid schedules /);
  });

  it("an R5 split row with a long question: the computed result is whole, the claim gave way", () => {
    const rec = record("generic-mixed");
    delete rec.synthesisReport.presentation.verificationGate;
    delete rec.synthesisReport.presentation.disagreementPositionVersion;
    const p = presentationOf(rec);
    const x = buildAdaptiveXPost(LONG_QUESTION, rec.synthesisReport, undefined, p);
    const split = rec.synthesisReport.presentation.disagree[0];
    expect(x.length).toBeLessThanOrEqual(280);
    expect(x.endsWith("\n\nvia ConvergePanel")).toBe(true);
    expect(x).toContain(` — panel result: ${split.result}\n\nvia ConvergePanel`);
  });

  it("NIT-2 (review of 8def047): the claim gives way before the question — every claim length is tried at a question length first", () => {
    // Unavailable gate, R5 row, long question: no claim fits beside the 80-character question, so the question takes 48
    // and the claim the longest that then fits (24). Trying the question first (24, with the 60-character claim) is wrong.
    const rec = record("generic-mixed");
    rec.gate.status = "pass";
    delete rec.synthesisReport.presentation.verificationGate;
    delete rec.synthesisReport.presentation.disagreementPositionVersion;
    const p = presentationOf(rec);
    expect(p.status).toBe("unavailable");
    expect(buildAdaptiveXPost(LONG_QUESTION, rec.synthesisReport, undefined, p)).toBe(
      [
        "Asked a multi-model AI panel: \"Across the last two decades of peer-reviewed la…\"",
        "Verification gate: Unavailable · Certainty: 71%",
        "Models split on: “Tariffs protect domesti…” — panel result: split: 1 of 5 dispatched models support it and 1 disputes it",
        "via ConvergePanel",
      ].join("\n\n")
    );
  });

  it("NIT-3 (review of 8def047): a row whose computed result cannot fit beside any question gives the defined fallback", () => {
    const rec = record("generic-mixed");
    rec.gate.status = "pass";
    delete rec.synthesisReport.presentation.verificationGate;
    delete rec.synthesisReport.presentation.disagreementPositionVersion;
    rec.synthesisReport.presentation.disagree[0].result = `split: ${"x".repeat(200)}`;
    const p = presentationOf(rec);
    expect(buildAdaptiveXPost(LONG_QUESTION, rec.synthesisReport, undefined, p)).toBe(["Asked a multi-model AI panel", "Verification gate: Unavailable · Certainty: 71%", "via ConvergePanel"].join("\n\n"));
  });

  it("a post that fits keeps the layout it had: the classic layout with the readable gate line", () => {
    const rec = record("generic-splits");
    delete rec.synthesisReport.presentation;
    const x = buildAdaptiveXPost(QUESTION, rec.synthesisReport, undefined, GATES[1] as any);
    expect(x).toBe(
      [`Asked a multi-model AI panel: "${QUESTION}"`, `Verification gate: Caution (requires further review) · Certainty: ${pct(rec)}%`, `Models split on: ${rec.synthesisReport.disagreements[0].topic}`, "via ConvergePanel"].join("\n\n")
    );
  });
});
