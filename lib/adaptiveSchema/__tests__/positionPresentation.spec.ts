/**
 * Order 5 Contract P — positionPresentation.ts unit tests: the marker read rule, the read-side slot validator, row
 * types, split-only claim kinds (M-6), field-derived comparison semantics with the shipped normalizer and no median or
 * tolerance basis (M-4, M-5), exact unique joins (M-1 / M4), slot provenance labels (M5) and the read-time report view
 * (M-1, M-2, M-7, M-8). Every case here is written against R1.4's material findings; see the closure matrix.
 */

import {
  MODEL_PROSE_WITHHELD,
  NEUTRAL_KEY_CLAIM_STEP,
  NO_RECORDED_POSITIONS,
  POSITION_DETAILS_UNAVAILABLE,
  claimKind,
  isPositionMarked,
  panelCounts,
  positionView,
  presentPositionSafeReport,
  readSlots,
  renderPositionPanelStatement,
  rowTypeOf,
  rowView,
  slotLabel,
  splitRowAt,
  uniqueRowByClaim,
} from "@/lib/adaptiveSchema/positionPresentation";
import { VERDICT_NEXT_STEPS } from "@/lib/adaptiveSchema/config";

const ROSTER = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const claimCell = (modelId: string, stance: string, extra: Record<string, unknown> = {}) => ({ modelId, stance, rawStance: "asserts", confidence: "majority_view", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" }, excerpt: `${modelId} wording`, ...extra });
const fieldCell = (fieldType: string, modelId: string, stance: string, raw: unknown, excerpt = "") => ({ modelId, stance, rawStance: "asserts", confidence: null, origin: { kind: "field_derived", fieldType }, excerpt, raw });
const row = (claimText: string, status: string, cells: unknown[], extra: Record<string, unknown> = {}) => ({ id: claimText.toLowerCase().replace(/\W+/g, "-"), claimText, cells, agreementScore: 0.5, certaintyScore: 0.5, status, ...extra });
const metric = (vals: (number | null | string)[], unit: string | string[] = "x", stances?: string[]) =>
  row("P/E", "majority", vals.map((v, i) => (v === undefined ? null : fieldCell("metric", ROSTER[i], stances?.[i] ?? "agrees", { label: "P/E", value: v, unit: Array.isArray(unit) ? unit[i] : unit, asOf: "2026", source: "s" }, `${v}`))));
const step = (actions: (string | null)[], status = "consensus") => row("Step 1: Install the package", status, actions.map((a, i) => (a === null ? null : fieldCell("step", ROSTER[i], "agrees", { order: 1, action: a }, a))));
const scalar = (vals: (string | null)[], status = "split") => row(vals.find(Boolean) ?? "", status, vals.map((v, i) => (v === null ? null : fieldCell("scalar", ROSTER[i], "agrees", undefined, v))));
const VOTE_WORDS = /\b(support\w*|disput\w*|agree\w*|consensus|majority|split|converg\w*|oppos\w*|vote\w*)\b/i;

describe("marker read rule (O5-R14-1)", () => {
  it.each([
    [{ presentation: { disagreementPositionVersion: 1 } }, true],
    [{ presentation: { disagreementPositionVersion: "1" } }, false],
    [{ presentation: { disagreementPositionVersion: 2 } }, false],
    [{ presentation: { disagreementPositionVersion: true } }, false],
    [{ presentation: { disagreementPositionVersion: null } }, false],
    [{ presentation: { disagreementPositionVersion: NaN } }, false],
    [{ presentation: { disagreementPositionVersion: 1.0000001 } }, false],
    [{ presentation: {} }, false],
    [{ presentation: [1] }, false],
    [{ presentation: null }, false],
    [{}, false],
    [null, false],
    ["{\"presentation\":{\"disagreementPositionVersion\":1}}", false],
  ])("%j → %s", (report, expected) => {
    expect(isPositionMarked(report)).toBe(expected);
  });

  it("an inherited marker does not count", () => {
    const p = Object.create({ disagreementPositionVersion: 1 });
    expect(isPositionMarked({ presentation: p })).toBe(false);
  });
});

describe("read-side slot validator", () => {
  it("attributes by modelId, never by array position", () => {
    const r = readSlots([claimCell("claude", "agrees"), claimCell("chatgpt", "disputes"), null, null, null], ROSTER);
    expect(r.slots.find((s) => s.slot === "chatgpt")).toMatchObject({ kind: "position", stance: "disputes" });
    expect(r.slots.find((s) => s.slot === "claude")).toMatchObject({ kind: "position", stance: "agrees" });
    expect(r.unattributable).toBe(0);
  });

  it("collapses same-stance duplicates and discloses conflicting duplicates (no first-wins)", () => {
    const same = readSlots([claimCell("chatgpt", "agrees"), claimCell("chatgpt", "agrees")], ROSTER);
    expect(same.slots[0]).toMatchObject({ kind: "position", stance: "agrees" });
    const conflict = readSlots([claimCell("chatgpt", "agrees"), claimCell("chatgpt", "disputes")], ROSTER);
    expect(conflict.slots[0]).toEqual({ slot: "chatgpt", kind: "conflicting", stances: ["agrees", "disputes"] });
  });

  it("an unknown stance is unrecognized; unknown, missing or non-string modelIds and non-objects are unattributable", () => {
    const r = readSlots([claimCell("chatgpt", "supports"), { stance: "agrees" }, claimCell("llama", "disputes"), "text", 7, { modelId: 5, stance: "agrees" }, { modelId: "__proto__", stance: "agrees" }], ROSTER);
    expect(r.slots[0]).toEqual({ slot: "chatgpt", kind: "unrecognized" });
    expect(r.unattributable).toBe(6);
    expect(r.slots.filter((s) => s.kind === "unreadable").map((s) => s.slot)).toEqual(["claude", "grok", "perplexity", "gemini"]);
  });

  it("non-array cells read as unreadable for every slot", () => {
    expect(readSlots({ 0: claimCell("chatgpt", "agrees") }, ROSTER).slots.every((s) => s.kind === "unreadable")).toBe(true);
  });

  it("records how each excerpt was obtained, never as a verbatim quote", () => {
    const v = rowView(row("C", "split", [claimCell("chatgpt", "agrees"), { modelId: "claude", stance: "disputes", origin: { kind: "inferred" }, excerpt: "paraphrase", backfilled: true }, { modelId: "grok", stance: "disputes", backfilled: true, excerpt: "old" }]), ROSTER);
    expect(v.slots.slice(0, 3).map((s) => s.excerpt?.note)).toEqual(["recorded excerpt; may be paraphrased", "inferred from the response text, not stated by the model", "inferred from the response text, not stated by the model"]);
  });
});

describe("row type", () => {
  it.each([
    [[claimCell("chatgpt", "agrees")], "claim"],
    [[{ modelId: "chatgpt", stance: "agrees", origin: { kind: "inferred" } }], "claim"],
    [[{ modelId: "chatgpt", stance: "agrees", backfilled: true }], "claim"],
    [[fieldCell("metric", "chatgpt", "agrees", {})], "metric"],
    [[fieldCell("scalar", "chatgpt", "agrees", undefined)], "scalar"],
    [[fieldCell("metric", "chatgpt", "agrees", {}), claimCell("claude", "agrees")], "unknown"],
    [[{ modelId: "chatgpt", stance: "agrees" }], "unknown"],
    [[fieldCell("table", "chatgpt", "agrees", {})], "unknown"],
    [[null, null], "empty"],
    ["cells", "unknown"],
  ])("%j → %s", (cells, expected) => {
    expect(rowTypeOf(cells)).toBe(expected);
  });
});

describe("claim kinds apply to split claim rows only (M-6)", () => {
  const kind = (cells: unknown[]) => claimKind(readSlots(cells, ROSTER));
  it.each([
    ["genuine", [claimCell("chatgpt", "agrees"), claimCell("claude", "disputes"), claimCell("grok", "unclear")], "opposing_positions"],
    ["all dispute", ROSTER.map((m) => claimCell(m, "disputes")), "recorded_opposition"],
    ["dispute + unclear", [claimCell("chatgpt", "disputes"), claimCell("claude", "unclear")], "opposition_with_unresolved"],
    ["partial only", [claimCell("chatgpt", "partial"), claimCell("claude", "unclear")], "partial_without_opposition"],
    ["support + unclear", [claimCell("chatgpt", "agrees"), claimCell("claude", "unclear")], "support_with_unresolved"],
    ["all unclear", ROSTER.map((m) => claimCell(m, "unclear")), "no_clear_position"],
    ["none", [null, null, null], "no_positions"],
    ["one slot self-contradicting", [claimCell("chatgpt", "agrees"), claimCell("chatgpt", "disputes")], "conflicting_only"],
    ["conflict in one slot plus a distinct supporter", [claimCell("chatgpt", "agrees"), claimCell("chatgpt", "disputes"), claimCell("grok", "agrees")], "opposing_positions"],
    ["dispute plus an unattributable entry", [claimCell("chatgpt", "disputes"), claimCell("llama", "agrees")], "opposition_with_unresolved"],
  ])("%s → %s", (_label, cells, expected) => {
    expect(kind(cells)).toBe(expected);
  });

  it("a 5/5 consensus claim row is a consensus row, not an 'unresolved' or 'support with unresolved' kind", () => {
    const v = rowView(row("Wages cut jobs", "consensus", ROSTER.map((m) => claimCell(m, "agrees"))), ROSTER);
    expect(v).toMatchObject({ heading: "Consensus", isOpposition: false, claimStatus: "consensus" });
    expect(v.text).toBe("consensus: all 5 dispatched models support it");
    expect(v.text).not.toMatch(/unresolved|not a split/);
  });

  it("a duplicated slot is counted once", () => {
    const v = rowView(row("W", "majority", [claimCell("chatgpt", "agrees"), claimCell("chatgpt", "agrees"), claimCell("claude", "agrees"), claimCell("grok", "disputes")]), ROSTER);
    expect(v.text).toBe("majority: 2 of 5 dispatched models support it, 1 disputes it");
  });

  it("only distinct-slot opposition is opposition; qualifiers appear when anything was unattributable", () => {
    expect(rowView(row("C", "split", [claimCell("chatgpt", "agrees"), claimCell("claude", "disputes")]), ROSTER)).toMatchObject({ heading: "Recorded opposing positions", isOpposition: true });
    const qualified = rowView(row("C", "split", [claimCell("chatgpt", "partial"), claimCell("llama", "disputes")]), ROSTER);
    expect(qualified.isOpposition).toBe(false);
    expect(qualified.text).toContain("no disputing position recorded among readable, attributable positions");
    expect(qualified.text).toContain("1 stored position could not be attributed to a panel slot");
  });

  it("an all-null claim row reads 'No recorded model positions.'", () => {
    expect(rowView(row("C", "split", [null, null, null]), ROSTER)).toMatchObject({ heading: "No recorded positions", text: NO_RECORDED_POSITIONS });
  });
});

describe("field-derived rows: a computed comparison, never a vote (M1, M-4, M-5, M-7)", () => {
  it.each([
    ["St. Louis / St Louis", ["St. Louis", "St Louis", "St. Louis"]],
    ["Paris, France / Paris France", ["Paris, France", "Paris France"]],
    ["U.S. / US", ["U.S.", "US", "u.s."]],
  ])("scalar %s uses the shipped normalizer → Values match", (_l, vals) => {
    const v = rowView(scalar(vals, "consensus"), ROSTER);
    expect(v.heading).toBe("Values match");
    expect(v.slots.filter((s) => s.position.includes("same answer as")).length).toBe(vals.length);
  });

  it.each([
    ["all distinct", ["Paris", "Lyon", "Nice"], "Values differ", "No two panel slots gave the same answer (3 different answers"],
    ["2-2 tie", ["Paris", "Paris", "Lyon", "Lyon"], "Values differ", "no single most common answer"],
    ["2-1", ["Paris", "Paris", "Lyon"], "Values differ", "the most common was given by 2 of 3 panel slots"],
    ["one answer", ["Paris", null, null], "Comparison", "Only 1 panel slot gave an answer"],
    ["no answers", [null, null], "No recorded positions", NO_RECORDED_POSITIONS],
  ])("scalar %s", (_l, vals, heading, text) => {
    const v = rowView(scalar(vals as (string | null)[]), ROSTER);
    expect(v.heading).toBe(heading);
    expect(v.text).toContain(text);
  });

  it("M-5: never states a median or tolerance basis, even when the comparator's hidden duplicates changed its median", () => {
    // Stored: all dispute (the comparator saw chatgpt's second P/E of 10, which is not stored).
    const v = rowView(metric([0, 0, 0.001], "x", ["disputes", "disputes", "disputes"]), ROSTER);
    expect(v.text).not.toMatch(/median|tolerance|within|near/i);
    expect(v.text).toBe("Values differ: 3 numeric values, 2 distinct, from 0 x to 0.001 x. A computed comparison of the stated values, not model positions.");
    expect(v.slots.slice(0, 3).map((s) => s.position)).toEqual(["0 x", "0 x", "0.001 x"]);
  });

  it.each([
    ["one numeric + two non-numeric", [20, null, "n/a"], "Comparison", "Only 1 numeric value was given; there is nothing to compare it with; 2 panel slots gave no comparable value."],
    ["single slot", [20], "Comparison", "Only 1 numeric value was given"],
    ["identical incl. zero", [0, 0, 0], "Values match", "All 3 numeric values are identical."],
    ["all non-numeric", [null, null], "Comparison", "Not comparable: no numeric values were given."],
    ["NaN and Infinity are not numbers", [NaN, Infinity, 5], "Comparison", "Only 1 numeric value was given"],
    ["negative and zero", [-1, 0, 1], "Values differ", "from -1 x to 1 x"],
  ])("metric %s", (_l, vals, heading, text) => {
    const v = rowView(metric(vals as (number | null)[]), ROSTER);
    expect(v.heading).toBe(heading);
    expect(v.text).toContain(text);
  });

  it("mixed units are not compared", () => {
    const v = rowView(metric([20, 0.2], ["%", "ratio"]), ROSTER);
    expect(v).toMatchObject({ heading: "Comparison", text: "Not compared: the values use different units (“%”, “ratio”)." });
  });

  it("scenario probabilities show as percentages, rounded, matching the excerpt (not 0.45)", () => {
    const r = row("Soft landing", "majority", [0.45, 0.45, 0.7].map((p, i) => fieldCell("scenario", ROSTER[i], "agrees", { label: "Soft landing", probability: p, narrative: "N", leadingIndicators: [] })));
    const v = rowView(r, ROSTER);
    expect(v.text).toContain("from 45% to 70%");
    expect(v.slots[0].position).toBe("45%");
  });

  it.each([
    ["identical", ["Install the package", "Install the package", "install the package."], "Values match"],
    ["disjoint pairs (stored consensus)", ["Install the package", "Install the package", "Configure firewall rules", "Configure firewall rules"], "Values differ"],
    ["partial overlap", ["Install the package", "Install the dependency package", "Configure the firewall"], "Values differ"],
    ["single slot", ["Install the package", null, null], "Comparison"],
  ])("steps %s", (_l, actions, heading) => {
    expect(rowView(step(actions as (string | null)[]), ROSTER).heading).toBe(heading);
  });

  it("M-7: no field row, whatever its stored status or stances, is worded as a vote, support, dispute, split or consensus", () => {
    const fieldRows = [metric([20, 21, 40], "x", ["agrees", "agrees", "disputes"]), metric([92, 93, 107, 108]), step(["Install the package", "Install the package", "Configure firewall rules", "Configure firewall rules"]), scalar(["Paris", "Paris", "Lyon", "Lyon"]), scalar(["Paris", "Lyon"], "consensus")];
    for (const r of fieldRows) {
      const v = rowView(r, ROSTER);
      expect(v.isOpposition).toBe(false);
      expect(v.supporters).toEqual([]);
      expect(v.disputers).toEqual([]);
      expect(`${v.heading} ${v.text} ${v.slots.map((s) => s.position).join(" ")}`).not.toMatch(VOTE_WORDS);
    }
  });

  it("a mixed-origin or unsupported field row fails closed", () => {
    expect(rowView(row("X", "split", [fieldCell("metric", "chatgpt", "agrees", {}), claimCell("claude", "disputes")]), ROSTER)).toMatchObject({ heading: "Position details unavailable", isOpposition: false });
    expect(rowView(row("X", "split", [fieldCell("table", "chatgpt", "agrees", {})]), ROSTER).heading).toBe("Position details unavailable");
  });
});

describe("joins (M4, M-1)", () => {
  const rows = [row("A", "split", [claimCell("chatgpt", "agrees")]), row("B", "consensus", [claimCell("chatgpt", "agrees")]), row("C", "split", [claimCell("chatgpt", "disputes")]), row("C", "split", [claimCell("claude", "disputes")])];
  it("exact, unique claim text only", () => {
    expect(uniqueRowByClaim(rows, "B", ["consensus"]).row).toBe(rows[1]);
    expect(uniqueRowByClaim(rows, "b", ["consensus"]).row).toBeNull();
    expect(uniqueRowByClaim(rows, "B.", ["consensus"]).row).toBeNull();
    expect(uniqueRowByClaim(rows, "B", ["split"])).toEqual({ row: null, reason: "not_found" });
    expect(uniqueRowByClaim(rows, "C", ["split"])).toEqual({ row: null, reason: "ambiguous" });
    expect(uniqueRowByClaim(null, "A")).toEqual({ row: null, reason: "no_rows" });
    expect(uniqueRowByClaim(rows, 5)).toEqual({ row: null, reason: "unreadable_entry" });
  });
  it("per-index entries join only when the indexed split row has the same text", () => {
    expect(splitRowAt(rows, 0, "A").row).toBe(rows[0]);
    expect(splitRowAt(rows, 0, "C")).toEqual({ row: null, reason: "mismatch" });
    expect(splitRowAt(rows, 1, "C")).toEqual({ row: null, reason: "ambiguous" });
    expect(splitRowAt(rows, 7, "A")).toEqual({ row: null, reason: "not_found" });
  });
});

describe("slot provenance labels (M5)", () => {
  const prov = [{ modelId: "claude", substituted: true, provider: "deepseek" }, { modelId: "grok", substituted: true }, { modelId: "chatgpt", substituted: false, requestedModel: "gpt-x" }];
  it.each([
    ["chatgpt", "full", "ChatGPT slot"],
    ["claude", "full", "Claude slot (substituted; answered by DeepSeek)"],
    ["grok", "full", "Grok slot (substituted; answered by provider not recorded)"],
    ["gemini", "full", "Gemini slot"],
    ["chatgpt", "compact", "ChatGPT"],
    ["claude", "compact", null],
  ])("%s %s → %s", (slot, format, expected) => {
    expect(slotLabel(slot, prov, format as "full" | "compact")).toBe(expected);
  });
  it("never names a requested or actual model as the author", () => {
    expect(slotLabel("chatgpt", prov, "full")).not.toContain("gpt-x");
  });
});

describe("panel statement restated from rows (M-1)", () => {
  it("counts field rows as value comparisons and split claim rows by kind — never 'a split on N'", () => {
    const rows = [
      row("Wages", "consensus", ROSTER.map((m) => claimCell(m, "agrees"))),
      row("Tariffs", "split", [claimCell("chatgpt", "agrees"), claimCell("claude", "disputes")]),
      row("Rates", "split", ROSTER.map((m) => claimCell(m, "unclear"))),
      scalar(["Paris", "Lyon"]),
      step(["Install the package", "Install the package"]),
    ];
    const s = renderPositionPanelStatement(panelCounts(rows, ROSTER));
    expect(s).toBe("Of 5 scored rows across 5 dispatched panel slots: consensus on 1 claim; recorded opposing positions on 1 claim; unresolved positions on 1 claim; 1 value comparison with matching values; 1 value comparison with differing values.");
    expect(s).not.toMatch(/a split on/);
  });
  it("no claim consensus or majority → 'No consensus identified.' prefix", () => {
    expect(renderPositionPanelStatement(panelCounts([scalar(["Paris", "Paris"], "consensus")], ROSTER))).toMatch(/^No consensus identified\. Of 1 scored row/);
  });
});

// ─── The read-time report view ──────────────────────────────────────────────

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as object).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

function markedReport(overrides: Record<string, unknown> = {}) {
  return {
    presentation: {
      panelAgreement: "Of 3 scored claims across 5 dispatched models: consensus on 1; a split on 2.",
      answer: { note: null, claims: [{ claim: "Wages", result: "consensus: all 5 dispatched models support it", supporters: "ChatGPT, Claude, Grok, Perplexity, Gemini" }, { claim: "Step 1: Install the package", result: "consensus: 4 of 5 dispatched models support it", supporters: "ChatGPT, Claude, Grok, Perplexity" }] },
      agree: [{ claim: "Wages", result: "consensus: all 5 dispatched models support it" }],
      disagree: [
        { claim: "Tariffs", result: "split: 1 of 5 dispatched models support it and 1 disputes it", whySource: "model_explanation" },
        { claim: "Rates", result: "split: 0 of 5 dispatched models support it and 0 dispute it", whySource: "computed" },
      ],
      executiveSummarySource: "model_explanation",
      certaintyExplanation: "Grok relies on older data.",
      verificationGate: { unresolvedLoadBearing: [{ claim: "Tariffs", result: "split: …", supporters: "ChatGPT", disputers: "Claude" }] },
      disagreementPositionVersion: 1,
    },
    unifiedAnswer: "stored",
    panelVerdict: "4/5 models converge on “Step 1: Install the package”; certainty 61%; gate: caution.",
    gate: "caution",
    runCertainty: 0.61,
    whereModelsAgree: ["“Wages”"],
    whereModelsDisagree: ["Tariffs", "Rates"],
    certaintyAssessment: "Run certainty 61% (gate: caution).",
    narrativeSections: [{ title: "Context", body: "ChatGPT and Claude split on tariffs." }],
    executiveSummary: "Experts are divided. ChatGPT and Claude split on tariffs.",
    disagreements: [
      { topic: "Tariffs", whyTheyDiffer: "Claude weighs costs while ChatGPT weighs jobs.", positions: [{ modelId: "chatgpt", position: "x" }], stakes: "decision-critical" },
      { topic: "Rates", whyTheyDiffer: "Models take different positions on this point — see each model's excerpt below.", positions: [], stakes: "important" },
    ],
    biasAndBlindSpots: [{ biasType: "recency", description: "ChatGPT and Grok take opposite positions on rates.", modelsImplicated: ["chatgpt"], evidence: [], likelyCauses: ["x"], impact: "ChatGPT and Grok take opposite positions on rates.", mitigationSteps: [] }],
    biasEmptyReason: null,
    panelCoverageGaps: [{ dimension: "Jobs", whyItMatters: "ChatGPT and Claude split on jobs, and Grok ignored it entirely.", followUpQuestion: "?" }],
    diagnostics: { citedClaimCount: 0, totalClaimCount: 4, evidenceMix: { empirical: 1, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.5 },
    verdictCard: {
      question: "Q?",
      topConsensus: "Step 1: Install the package",
      consensusModelCount: 4,
      topConsensusAgreement: "consensus: 4 of 5 dispatched models support it",
      keyDisagreement: "Rates",
      keyDisagreementAgreement: "split: 0 of 5 dispatched models support it and 0 dispute it",
      disagreementDetail: "Models take different positions — see the disagreement card below for each model's stance.",
      disagreementModelCount: 5,
      caveat: "ChatGPT and Grok take opposite positions on rates.",
      caveatSource: "model_bias_check",
      recommendedNextSteps: [...VERDICT_NEXT_STEPS.caution],
    },
    degraded: false,
    ...overrides,
  } as any;
}
const ROWS = [
  row("Wages", "consensus", ROSTER.map((m) => claimCell(m, "agrees"))),
  row("Tariffs", "split", [claimCell("chatgpt", "agrees"), claimCell("claude", "disputes"), claimCell("grok", "unclear")]),
  row("Rates", "split", ROSTER.map((m) => claimCell(m, "unclear"))),
  step(["Install the package", "Install the package", "Configure firewall rules", "Configure firewall rules"]),
];

describe("presentPositionSafeReport", () => {
  it("an unmarked report is returned unchanged (the same object)", () => {
    const r = markedReport();
    delete r.presentation.disagreementPositionVersion;
    expect(presentPositionSafeReport(r, { rows: ROWS, roster: ROSTER })).toBe(r);
    const s = markedReport();
    s.presentation.disagreementPositionVersion = "1";
    expect(presentPositionSafeReport(s, { rows: ROWS, roster: ROSTER })).toBe(s);
  });

  it("never mutates its inputs; idempotent; the view data never serializes", () => {
    const r = deepFreeze(markedReport());
    const rows = deepFreeze(JSON.parse(JSON.stringify(ROWS)));
    const before = JSON.stringify(r);
    const v = presentPositionSafeReport(r, { rows, roster: ROSTER });
    expect(JSON.stringify(r)).toBe(before);
    expect(presentPositionSafeReport(v, { rows: [], roster: [] })).toBe(v);
    expect(positionView(v)).not.toBeNull();
    expect(positionView(JSON.parse(JSON.stringify(v)))).toBeNull();
    expect(Object.keys(v)).not.toContain("positionView");
  });

  it("M-1: answer claims, agree, disagree, load-bearing and the panel statement are restated from the joined rows", () => {
    const v = presentPositionSafeReport(markedReport(), { rows: ROWS, roster: ROSTER });
    const p = v.presentation!;
    expect(p.panelAgreement).not.toMatch(/a split on|split:/);
    expect(p.answer.claims.map((c) => c.result)).toEqual(["consensus: all 5 dispatched models support it", "2 different wordings at this position among 4 panel slots (compared by wording only, ignoring case and punctuation). A computed comparison, not model positions."]);
    expect(p.answer.claims[1].supporters).toBeUndefined();
    expect(p.answer.claims[0].supporters).toBe("ChatGPT slot, Claude slot, Grok slot, Perplexity slot, Gemini slot");
    expect(p.disagree.map((d) => d.result)).toEqual(["1 panel slot supporting or partially supporting and 1 disputing; 1 unclear.", "No clear supporting or disputing position is recorded; 5 unclear."]);
    expect(p.verificationGate!.unresolvedLoadBearing[0]).toEqual({ claim: "Tariffs", result: "1 panel slot supporting or partially supporting and 1 disputing; 1 unclear.", supporters: "ChatGPT slot", disputers: "Claude slot" });
    expect(JSON.stringify(p)).not.toMatch(/\bsplit:/);
  });

  it("M-2 / M6 / M-8: every model-written prose field and the computed default explanation are withheld, with one disclosure", () => {
    const v = presentPositionSafeReport(markedReport(), { rows: ROWS, roster: ROSTER });
    expect(v.presentation!.executiveSummarySource).toBe("unified_answer");
    expect(v.presentation!.certaintyExplanation).toBeUndefined();
    expect(v.narrativeSections).toEqual([]);
    expect(v.disagreements.map((d) => d.whyTheyDiffer)).toEqual(["", ""]);
    expect(v.disagreements.every((d) => d.positions.length === 0)).toBe(true);
    expect(v.biasAndBlindSpots).toEqual([]);
    expect(v.panelCoverageGaps).toEqual([]);
    expect(v.verdictCard.caveat).toBeNull();
    expect(v.verdictCard.caveatSource).toBeUndefined();
    expect(v.verdictCard.recommendedNextSteps).not.toContain(VERDICT_NEXT_STEPS.caution[2]);
    const view = positionView(v)!;
    expect(view).toMatchObject({ modelProseWithheld: true, biasFindingsWithheld: 1, coverageGapsWithheld: 1 });
    expect(JSON.stringify(v)).not.toMatch(/Claude weighs|ignored it entirely|opposite positions|Experts are divided|Models take different positions/);
    expect(MODEL_PROSE_WITHHELD).toMatch(/not shown/);
  });

  it("M-7: the verdict top claim and panel verdict do not describe a field row as models converging", () => {
    const v = presentPositionSafeReport(markedReport(), { rows: ROWS, roster: ROSTER });
    expect(v.panelVerdict).not.toMatch(/converge/);
    expect(v.panelVerdict).toMatch(/^Top value comparison: “Step 1: Install the package” — 2 different wordings/);
    expect(v.verdictCard.consensusModelCount).toBe(0);
    expect(positionView(v)!.verdict.topHeading).toBe("Top value comparison");
  });

  it("the key unresolved claim: neutral heading and neutral caution step unless it is recorded opposition", () => {
    const v = presentPositionSafeReport(markedReport(), { rows: ROWS, roster: ROSTER });
    expect(positionView(v)!.verdict.keyHeading).toBe("Unresolved claim");
    expect(v.verdictCard.disagreementDetail).toBeNull();
    expect(v.verdictCard.recommendedNextSteps[0]).toBe(NEUTRAL_KEY_CLAIM_STEP);
    const opp = presentPositionSafeReport(markedReport({ verdictCard: { ...markedReport().verdictCard, keyDisagreement: "Tariffs" } }), { rows: ROWS, roster: ROSTER });
    expect(positionView(opp)!.verdict.keyHeading).toBe("Recorded opposing positions");
    expect(opp.verdictCard.recommendedNextSteps[0]).toBe(VERDICT_NEXT_STEPS.caution[0]);
  });

  it("without rows nothing is derived: every position reads unavailable, no kind is shown", () => {
    const v = presentPositionSafeReport(markedReport(), { rows: null, roster: ROSTER });
    expect(v.presentation!.answer.claims.every((c) => c.result === POSITION_DETAILS_UNAVAILABLE && !c.supporters)).toBe(true);
    expect(v.presentation!.disagree.every((d) => d.result === POSITION_DETAILS_UNAVAILABLE)).toBe(true);
    expect(v.presentation!.panelAgreement).toMatch(/unavailable/);
    expect(v.verdictCard.topConsensusAgreement).toBe(POSITION_DETAILS_UNAVAILABLE);
  });

  it("a shifted or mismatched per-index entry is not joined", () => {
    const shifted = markedReport();
    shifted.disagreements = [shifted.disagreements[1], shifted.disagreements[0]];
    const v = presentPositionSafeReport(shifted, { rows: ROWS, roster: ROSTER });
    expect(v.presentation!.disagree.map((d) => d.result)).toEqual([POSITION_DETAILS_UNAVAILABLE, POSITION_DETAILS_UNAVAILABLE]);
  });
});

describe("malformed and unsupported records (Phase 5 / 8)", () => {
  it("never throws, and a malformed entry keeps its neighbours' valid joins", () => {
    const r = markedReport();
    r.presentation.answer.claims = [null, 7, { claim: 5 }, r.presentation.answer.claims[0]];
    r.presentation.agree = [null, r.presentation.agree[0]];
    r.disagreements = [null, r.disagreements[1]];
    r.presentation.disagree = [{ nope: true }, r.presentation.disagree[1]];
    r.presentation.verificationGate.unresolvedLoadBearing = [null, { claim: "Tariffs", result: "x" }];
    const v = presentPositionSafeReport(r, { rows: ROWS, roster: ROSTER });
    expect(v.presentation!.answer.claims[3].result).toBe("consensus: all 5 dispatched models support it");
    expect(v.presentation!.answer.claims.slice(0, 3)).toEqual([null, 7, { claim: 5 }]);
    expect(v.presentation!.agree[1].result).toBe("consensus: all 5 dispatched models support it");
    // disagreements[1] is "Rates" at index 1, but the split rows' index 1 is "Rates" only if the entry matches: it does.
    expect(v.presentation!.disagree[1].result).toBe("No clear supporting or disputing position is recorded; 5 unclear.");
    expect(v.presentation!.verificationGate!.unresolvedLoadBearing[1].result).toMatch(/^1 panel slot supporting/);
  });

  it("malformed rows and cells read as unavailable or unreadable, never as a position", () => {
    expect(rowView(null, ROSTER)).toMatchObject({ heading: "Position details unavailable", isOpposition: false });
    expect(rowView({ cells: "x", status: "split" }, ROSTER)).toMatchObject({ heading: "Position details unavailable" });
    expect(rowView({ cells: [{ modelId: "chatgpt", stance: "agrees", origin: { kind: "claim" } }, "junk"], status: "split" }, ROSTER).rowType).toBe("unknown");
    const v = rowView(row("C", "consensus", [claimCell("chatgpt", "agrees"), { modelId: "claude", stance: 9, origin: { kind: "claim" } }]), ROSTER);
    expect(v.text).toContain("1 position could not be read");
    expect(v.slots[1].position).toBe("Unrecognized position");
  });

  it("a malformed verdict card is not restated, and nothing is joined from it", () => {
    const r = markedReport({ verdictCard: "corrupt" });
    const v = presentPositionSafeReport(r, { rows: ROWS, roster: ROSTER });
    expect(v.verdictCard).toBe("corrupt");
    expect(positionView(v)!.verdict.topHeading).toBe("Top claim");
  });

  it("contested notes are restated only from well-formed stored dimensions", () => {
    const ok = rowView(row("C", "consensus", ROSTER.map((m) => claimCell(m, "agrees")), { contested: { marked: true, assessed: false, markedCount: 2, listedCount: 5 } }), ROSTER);
    expect(ok.contested).toBe("2 of 5 models that listed this claim mark it contested");
    for (const contested of [{ marked: true, markedCount: "2", listedCount: 5 }, { marked: true, markedCount: 6, listedCount: 5 }, { marked: "yes", markedCount: 1, listedCount: 1 }, null]) {
      expect(rowView(row("C", "consensus", ROSTER.map((m) => claimCell(m, "agrees")), { contested }), ROSTER).contested).toBeNull();
    }
  });
});
