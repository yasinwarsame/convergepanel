/**
 * Phase 10D.1, corrected in 10D.1C, corrected again in 10D.1C2 —
 * `buildReviewOverview()` tests.
 *
 * 10D.1C2 changed the non-redundancy contract: a genuinely multi-sentence
 * conclusion still gets only its first sentence excerpted (word-boundary
 * safe), but a single-sentence conclusion at or under the excerpt budget
 * is now included in FULL — the 10D.1C version instead substituted a
 * content-free `sourceBacked` status sentence for the entire majority
 * case (single-sentence conclusions), which omitted the actual Panel
 * result. See reviewOverviewBuilder.ts's file header for the full
 * rationale.
 */

import { buildReviewOverview, type ReviewOverviewInput } from "@/lib/adaptiveSchema/reviewOverviewBuilder";

function baseInput(overrides: Partial<ReviewOverviewInput> = {}): ReviewOverviewInput {
  return {
    question: "Some question?",
    totalModels: null,
    modelsWithUsableOutput: null,
    conclusion: "",
    sourceBacked: false,
    humanReviewNeeded: false,
    ...overrides,
  };
}

describe("buildReviewOverview — question handling", () => {
  it("includes the question verbatim, quoted", () => {
    const overview = buildReviewOverview(baseInput({ question: "Should we migrate to a new CRM?" }));
    expect(overview).toContain('This review covers the question: "Should we migrate to a new CRM?"');
  });

  it("never double-punctuates a question that already ends in ?, !, or .", () => {
    expect(buildReviewOverview(baseInput({ question: "Is this safe?" }))).toContain('"Is this safe?"');
    expect(buildReviewOverview(baseInput({ question: "Is this safe?" }))).not.toContain("?.");
    expect(buildReviewOverview(baseInput({ question: "Act now!" }))).not.toContain("!.");
    expect(buildReviewOverview(baseInput({ question: "Define recursion." }))).not.toContain("..");
  });

  it("adds a period to a question with no terminal punctuation", () => {
    expect(buildReviewOverview(baseInput({ question: "What causes inflation" }))).toContain('"What causes inflation."');
  });

  it("falls back to a generic phrase when the question is empty", () => {
    const overview = buildReviewOverview(baseInput({ question: "" }));
    expect(overview).toContain("This review covers a submitted research question.");
    expect(overview).not.toContain('""');
  });

  it("truncates a very long question at 200 characters with an ellipsis", () => {
    const longQuestion = "x".repeat(500);
    const overview = buildReviewOverview(baseInput({ question: longQuestion }));
    expect(overview).toContain(`"${"x".repeat(200)}…"`);
    expect(overview).not.toContain("x".repeat(201));
  });
});

describe("buildReviewOverview — participation count accuracy (Phase 10D.1C)", () => {
  it("5 attempted, 3 usable: reports 3, never a looser connector-success count", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 3 }));
    expect(overview).toContain("Of 5 models attempted, 3 produced usable results.");
  });

  it("5 attempted, 0 usable (e.g. all connector-succeeded but failed schema validation): reports 0, never overstates", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 0 }));
    expect(overview).toContain("Of 5 models attempted, 0 produced usable results.");
  });

  it("1 attempted, 1 usable: correct singular grammar, not '1 models'/'1 responses'", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 1, modelsWithUsableOutput: 1 }));
    expect(overview).toContain("Of 1 model attempted, 1 produced a usable result.");
    expect(overview).not.toMatch(/1 models/);
    expect(overview).not.toMatch(/1 produced usable results\b/);
  });

  it("never mentions a connector-success concept — modelsWithUsableOutput is the only count field used for 'usable'", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: 3 }));
    expect(overview).not.toMatch(/connector|successful model/i);
  });

  it("omits the participation sentence entirely when totalModels is unavailable — never invents a count", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: null, modelsWithUsableOutput: null }));
    expect(overview).not.toMatch(/model/i);
  });

  it("historical fallback: totalModels known but modelsWithUsableOutput unavailable — degrades to an attempted-only statement, never fabricates a usable count under a different metric", () => {
    const overview = buildReviewOverview(baseInput({ totalModels: 5, modelsWithUsableOutput: null }));
    expect(overview).toContain("A panel of 5 models was attempted for this review.");
    expect(overview).not.toMatch(/usable/i);
  });
});

describe("buildReviewOverview — result direction for SHORT (single-sentence) conclusions (Phase 10D.1C2, Part K)", () => {
  it("includes the actual result direction, not merely a sourceBacked/workflow status", () => {
    const conclusion = "The evidence does not support the claim.";
    const overview = buildReviewOverview(baseInput({ conclusion, sourceBacked: true }));
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    expect(overview).not.toMatch(/source-backed|not source-backed/i);
  });

  it("preserves a leading negation verbatim — never drops or inverts polarity", () => {
    const conclusion = "The evidence does not support the claim.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain("does not support");
  });

  it("preserves a recommendation-style short conclusion in full", () => {
    const conclusion = "The proposed option is preferable under the stated constraints.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
  });

  it("preserves an uncertainty-expressing short conclusion without upgrading it to certainty", () => {
    const conclusion = "The causes remain uncertain.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    expect(overview).not.toMatch(/certainly|definitely|conclusively/i);
  });

  it("preserves a convergence-style short conclusion verbatim, without a separately invented consensus claim", () => {
    const conclusion = "The models broadly agree on the definition.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    // "broadly agree" is the model's own text, not a new signal invented by this module.
    expect(overview.match(/agree/gi)?.length ?? 0).toBe(1);
  });

  it("Panel Conclusion (the raw input) still carries the full canonical conclusion — this module never mutates it, only reads it for the excerpt", () => {
    const conclusion = "Go: HubSpot — lower cost fits the stated budget.";
    buildReviewOverview(baseInput({ conclusion }));
    expect(conclusion).toBe("Go: HubSpot — lower cost fits the stated budget."); // unchanged by the call
  });

  it("uses 'The panel's finding:' (not 'begins:') when the full conclusion is short enough to include whole — 'begins' would misleadingly imply a partial excerpt", () => {
    const conclusion = "Overall risk is moderate.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain("The panel's finding: Overall risk is moderate.");
    expect(overview).not.toContain("finding begins");
  });

  it("no longer reads sourceBacked for wording — identical output regardless of sourceBacked value for a short conclusion", () => {
    const conclusion = "Overall risk is moderate.";
    const withSources = buildReviewOverview(baseInput({ conclusion, sourceBacked: true }));
    const withoutSources = buildReviewOverview(baseInput({ conclusion, sourceBacked: false }));
    expect(withSources).toBe(withoutSources);
  });
});

describe("buildReviewOverview — non-redundancy contract for LONG / multi-sentence conclusions (Phase 10D.1C2, Part L)", () => {
  it("a genuinely multi-sentence conclusion is never reproduced in full — only the first sentence appears, as a strictly shorter excerpt", () => {
    const conclusion = "Remote work modestly reduces measured productivity overall. However, effects vary substantially by industry and task type.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel's finding begins: Remote work modestly reduces measured productivity overall.");
    expect(overview).not.toContain("However, effects vary substantially");
  });

  it("a long single-sentence conclusion (over the excerpt budget) is truncated, never reproduced in full", () => {
    const conclusion = "A".repeat(50) + " " + "B".repeat(200) + ".";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("…");
  });

  it("first sentence spanning ~99% of a genuinely multi-sentence conclusion: still excerpted (not the whole conclusion), and the overview stays reasonably concise rather than technically-passing-while-duplicating-nearly-everything", () => {
    const firstSentence = "A".repeat(140) + ".";
    const secondSentence = "B" + ".";
    const conclusion = `${firstSentence} ${secondSentence}`; // first sentence is ~99% of total length but still a genuine second sentence exists
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).not.toContain(secondSentence);
    // The excerpted first sentence itself must still respect the excerpt budget (140 <= 150, so used whole here).
    expect(overview).toContain(`The panel's finding begins: ${firstSentence}`);
  });

  it("handles a punctuation-heavy multi-sentence conclusion without malformed punctuation runs", () => {
    const conclusion = "Is this safe?! It depends on context, and the second factor matters too, quite a bit actually so let's be careful about it here.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toContain(conclusion);
    expect(overview).not.toMatch(/[.?!]{3,}/);
  });
});

/** Unicode code-point count — matches the production definition exactly, never UTF-16 `.length`. */
function codePointCount(s: string): number {
  return Array.from(s).length;
}

/** Extracts the excerpt text from a "The panel's finding[ begins]: X" overview. */
function extractExcerpt(overview: string): string {
  const match = overview.match(/The panel's finding(?: begins)?: (.+?)(?: This result was flagged for human review\.)?$/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("buildReviewOverview — hard-bounded, Unicode-safe truncation (Phase 10D.1C3, Parts G/H/I)", () => {
  it("never cuts a word in half when truncating a long single-sentence conclusion with ordinary spaces", () => {
    const conclusion =
      "The panel evaluated a wide range of factors including company size, industry vertical, regulatory jurisdiction, and long-term strategic fit before reaching its recommendation.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const match = overview.match(/The panel's finding begins: (.+?)…/);
    expect(match).not.toBeNull();
    const excerptWords = match![1].trim().split(/\s+/);
    const lastWord = excerptWords[excerptWords.length - 1];
    expect(conclusion).toMatch(new RegExp(`\\b${lastWord}\\b`));
  });

  it("boundary case: conclusion exactly 150 code points — included in full, no truncation", () => {
    const conclusion = "A".repeat(149) + ".";
    expect(codePointCount(conclusion)).toBe(150);
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    expect(overview).not.toContain("…");
  });

  it("boundary case: conclusion 149 code points — included in full", () => {
    const conclusion = "A".repeat(148) + ".";
    expect(codePointCount(conclusion)).toBe(149);
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
  });

  it("boundary case: conclusion 151 code points — truncated, excerpt (with ellipsis) never exceeds 150 code points", () => {
    const conclusion = "word ".repeat(30) + "final.";
    expect(codePointCount(conclusion)).toBeGreaterThan(150);
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).toContain("…");
    expect(overview).not.toContain(conclusion);
    expect(codePointCount(extractExcerpt(overview))).toBeLessThanOrEqual(150);
  });

  it("HARD BOUND (closes P2 #1): a 500-char unbroken ASCII token followed by trailing prose is hard-cut, never extended past the budget", () => {
    const longToken = "x".repeat(500);
    const conclusion = `${longToken} rest of the sentence follows here.`;
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(codePointCount(extractExcerpt(overview))).toBeLessThanOrEqual(150);
  });

  it("HARD BOUND (closes P2 #1): a 5,000-char unbroken ASCII token followed by trailing prose is hard-cut to <=150 code points — never allowed to grow to the token's length", () => {
    const longToken = "x".repeat(5000);
    const conclusion = `${longToken} rest of the sentence follows here.`;
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const excerpt = extractExcerpt(overview);
    expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
    // This is exactly the confirmed R3 defect scenario: previously produced a 5,001-character excerpt.
    expect(excerpt.length).toBeLessThan(200);
  });

  it("HARD BOUND: a URL-like unbroken token (no internal whitespace) is hard-cut to the budget, not preserved whole", () => {
    const urlToken = "https://example.com/" + "a".repeat(400) + "/report";
    const conclusion = `${urlToken} is the primary source cited.`;
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(codePointCount(extractExcerpt(overview))).toBeLessThanOrEqual(150);
  });

  it("HARD BOUND: a base64-like unbroken token is hard-cut to the budget", () => {
    const base64Token = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=".repeat(10);
    const conclusion = `${base64Token} was decoded and reviewed.`;
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(codePointCount(extractExcerpt(overview))).toBeLessThanOrEqual(150);
  });

  it("a conclusion with no whitespace ANYWHERE (single pathological token, no trailing prose) is still hard-bounded to <=150 code points", () => {
    const conclusion = "x".repeat(5000);
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(codePointCount(extractExcerpt(overview))).toBeLessThanOrEqual(150);
  });

  it("SURROGATE SAFETY (closes P2 #2): a surrogate-pair emoji straddling the old raw-UTF-16 cut boundary never produces an unpaired surrogate", () => {
    // Construct a no-whitespace string where a supplementary-plane emoji (😀, U+1F600 — 2 UTF-16 code units, 1 code point) straddles a raw UTF-16 cut at index (maxCodePoints - 1) = 149: 148 leading code units puts the emoji's high surrogate at index 148 and its low surrogate at index 149, so `.slice(0, 149)` would split it.
    const prefix = "x".repeat(148);
    const conclusion = prefix + "😀" + "y".repeat(50);
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const excerpt = extractExcerpt(overview);
    // No lone high surrogate (0xD800–0xDBFF) or lone low surrogate (0xDC00–0xDFFF) anywhere in the output.
    for (let i = 0; i < excerpt.length; i++) {
      const code = excerpt.charCodeAt(i);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
      if (isHighSurrogate) {
        expect(i + 1).toBeLessThan(excerpt.length);
        const next = excerpt.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true); // must be immediately followed by its low surrogate
      }
      if (isLowSurrogate) {
        expect(i).toBeGreaterThan(0);
        const prev = excerpt.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true); // must be immediately preceded by its high surrogate
      }
    }
    expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
  });

  it("emoji-heavy conclusion (many surrogate-pair characters) is bounded by code points, not UTF-16 units, and contains no broken glyphs", () => {
    const conclusion = "😀".repeat(200); // 200 code points, 400 UTF-16 code units, no whitespace anywhere
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const excerpt = extractExcerpt(overview);
    expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
    // Every code point in the excerpt (up to the ellipsis) must be a complete emoji or the ellipsis — Array.from re-validates no lone surrogates survived.
    const points = Array.from(excerpt);
    for (const p of points) {
      expect(p === "😀" || p === "…").toBe(true);
    }
  });

  it("mixed ASCII + emoji conclusion truncates safely without splitting the emoji", () => {
    const conclusion = "The panel found significant risk 😀".repeat(10);
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const excerpt = extractExcerpt(overview);
    expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(excerpt).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone low surrogate
  });

  it("CJK / no-space text: hard bound preserved, no crash, no unbounded growth", () => {
    const conclusion = "本" .repeat(300); // 300 CJK characters, no ASCII spaces anywhere
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const excerpt = extractExcerpt(overview);
    expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
  });

  it("combining-mark sequence (letter + combining accent) does not crash and stays within the hard bound; a split is an accepted cosmetic limitation, not a crash/corruption", () => {
    const combiningE = "é"; // "e" + combining acute accent (2 code points, renders as one visual glyph "é")
    const conclusion = (combiningE.repeat(80) + " trailing text follows after the mark sequence ends here for good measure.");
    const overview = buildReviewOverview(baseInput({ conclusion }));
    const excerpt = extractExcerpt(overview);
    expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
    // No exception thrown, no NaN/undefined leaking into the string.
    expect(excerpt).not.toMatch(/undefined|NaN/);
  });

  it("never produces a doubled ellipsis or a punctuation-then-ellipsis artifact", () => {
    const conclusion = "word ".repeat(40) + "and, finally, a conclusion with trailing punctuation right at the edge of the budget here.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toMatch(/\.\.\.|…\.|\?…|!…|,…/);
  });

  it("truncates cleanly around internal punctuation (comma, semicolon, colon, dash, parentheses) without leaving a dangling punctuation mark before the ellipsis", () => {
    const conclusion =
      "word ".repeat(28) + "value: (details, more-detail); further-elaboration continues past the budget line here for good measure.";
    const overview = buildReviewOverview(baseInput({ conclusion }));
    expect(overview).not.toMatch(/[,;:\-–—]…/);
  });

  it("property-style invariant: for a wide table of representative conclusions, the excerpt (with ellipsis) never exceeds 150 code points", () => {
    const cases = [
      "",
      "A",
      "A".repeat(149) + ".",
      "A".repeat(150) + ".",
      "A".repeat(151) + ".",
      "This is ordinary prose that runs on for a while before it eventually reaches a natural stopping point after several clauses.",
      "word ".repeat(60) + "end.",
      "x".repeat(5000),
      "x".repeat(5000) + " trailing prose after the token.",
      "https://example.com/" + "a".repeat(1000),
      "本".repeat(500),
      "😀".repeat(300),
      "é".repeat(200),
      "First sentence here. Second sentence follows with more detail and elaboration that goes on for quite a while.",
    ];
    for (const conclusion of cases) {
      const overview = buildReviewOverview(baseInput({ conclusion }));
      if (conclusion.trim().length === 0) {
        expect(overview).not.toMatch(/panel's finding/i);
        continue;
      }
      const excerpt = extractExcerpt(overview);
      expect(codePointCount(excerpt)).toBeLessThanOrEqual(150);
    }
  });
});

describe("buildReviewOverview — zero-usable / unusable conclusion (Phase 10D.1C2, Part N)", () => {
  it("omits the result-direction sentence entirely when the conclusion is empty — never fabricates a finding", () => {
    const overview = buildReviewOverview(baseInput({ conclusion: "" }));
    expect(overview).not.toMatch(/panel's finding/i);
  });

  it("omits the result-direction sentence when the conclusion is whitespace-only", () => {
    const overview = buildReviewOverview(baseInput({ conclusion: "   \n\t " }));
    expect(overview).not.toMatch(/panel's finding/i);
  });

  it("zero usable models with a non-empty degraded-state conclusion: reports the true result-direction text, never implies normal success", () => {
    const overview = buildReviewOverview(
      baseInput({ totalModels: 4, modelsWithUsableOutput: 0, conclusion: "Insufficient panel output to reach a conclusion." })
    );
    expect(overview).toContain("Of 4 models attempted, 0 produced usable results.");
    expect(overview).toContain("The panel's finding: Insufficient panel output to reach a conclusion.");
  });
});

describe("buildReviewOverview — humanReviewNeeded wording", () => {
  it("includes a neutral human-review-flagged sentence only when true", () => {
    expect(buildReviewOverview(baseInput({ humanReviewNeeded: true }))).toContain("This result was flagged for human review.");
    expect(buildReviewOverview(baseInput({ humanReviewNeeded: false }))).not.toContain("flagged for human review");
  });

  it("does not translate humanReviewNeeded into a stronger unreliability claim", () => {
    const overview = buildReviewOverview(baseInput({ humanReviewNeeded: true }));
    expect(overview).not.toMatch(/unreliable|untrustworthy|incorrect/i);
  });

  it("humanReviewNeeded is not treated as Panel result direction — it appears as its own trailing sentence, never merged into the finding sentence", () => {
    const overview = buildReviewOverview(baseInput({ conclusion: "Risk is elevated.", humanReviewNeeded: true }));
    expect(overview).toContain("The panel's finding: Risk is elevated. This result was flagged for human review.");
  });
});

describe("buildReviewOverview — real schema-shaped fixtures (Phase 10D.1C2, Part O)", () => {
  it("definition_explanation: short conclusion now carries real result direction", () => {
    const conclusion = "A recursive function is one that calls itself to solve smaller instances of the same problem.";
    const overview = buildReviewOverview(
      baseInput({ question: "What is recursion?", totalModels: 4, modelsWithUsableOutput: 4, conclusion, sourceBacked: false })
    );
    expect(overview).toBe(
      `This review covers the question: "What is recursion?" Of 4 models attempted, 4 produced usable results. The panel's finding: ${conclusion}`
    );
  });

  it("causal_explanation: short conclusion carries real result direction", () => {
    const conclusion = "Sleep deprivation impairs next-day cognitive performance.";
    const overview = buildReviewOverview(
      baseInput({ question: "Why does lack of sleep hurt performance?", totalModels: 3, modelsWithUsableOutput: 2, conclusion, sourceBacked: true })
    );
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    expect(overview).toContain("Of 3 models attempted, 2 produced usable results.");
  });

  it("deep_research: multi-sentence executive summary, only the first sentence excerpted", () => {
    const conclusion = "Remote work modestly reduces measured productivity in most studies. Effects vary substantially by industry and role.";
    const overview = buildReviewOverview(
      baseInput({ question: "Does remote work reduce productivity?", totalModels: 5, modelsWithUsableOutput: 4, conclusion })
    );
    expect(overview).not.toContain(conclusion);
    expect(overview).toContain("The panel's finding begins: Remote work modestly reduces measured productivity in most studies.");
  });

  it("evidence_review: short overallAssessment carries real result direction", () => {
    const conclusion = "The evidence is moderately strong but methodologically limited.";
    const overview = buildReviewOverview(
      baseInput({ question: "Is this study's evidence strong?", totalModels: 3, modelsWithUsableOutput: 3, conclusion, sourceBacked: true })
    );
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
  });

  it("bias_blindspot_audit: short summary carries real result direction", () => {
    const conclusion = "The panel's analysis shows a moderate US-centric framing.";
    const overview = buildReviewOverview(
      baseInput({ question: "Is this analysis geographically biased?", totalModels: 3, modelsWithUsableOutput: 2, conclusion, sourceBacked: false })
    );
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    expect(overview).toContain("Of 3 models attempted, 2 produced usable results.");
  });

  it("decision_support: templated conclusion (action + rationale) carries real result direction", () => {
    const conclusion = "Go: HubSpot — lower cost fits the stated budget.";
    const overview = buildReviewOverview(
      baseInput({ question: "Which CRM should we choose?", totalModels: 2, modelsWithUsableOutput: 2, conclusion, sourceBacked: false })
    );
    expect(overview).toContain(`The panel's finding: ${conclusion}`);
    expect(overview).not.toMatch(/1 models|1 responses/);
    expect(overview).not.toMatch(/[.?!]{2,}/);
  });

  it("partial-degradation fixture: connector calls succeeded but schema validation failed for some — modelsWithUsableOutput reflects the true usable count, not the connector-success count", () => {
    const overview = buildReviewOverview(
      baseInput({ question: "What are the risks?", totalModels: 4, modelsWithUsableOutput: 2, conclusion: "Risk is elevated in Q3." })
    );
    expect(overview).toContain("Of 4 models attempted, 2 produced usable results.");
    expect(overview).toContain("The panel's finding: Risk is elevated in Q3.");
  });
});

describe("buildReviewOverview — determinism", () => {
  it("is pure and deterministic — identical input always produces identical output", () => {
    const input = baseInput({ totalModels: 2, modelsWithUsableOutput: 2, conclusion: "C.", humanReviewNeeded: true });
    expect(buildReviewOverview(input)).toBe(buildReviewOverview(input));
  });
});
