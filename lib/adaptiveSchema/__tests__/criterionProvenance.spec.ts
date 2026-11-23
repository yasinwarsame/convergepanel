/**
 * Item 6A — unit contract for the authoritative user-criterion provenance rule, the single shared accessor, and the
 * Receipt presentation (lib/adaptiveSchema/criterionProvenance.ts), after the structural correction (owner Option A,
 * 2026-11-23): a conservative boundary ALLOW-list instead of per-character joiner rules, numeric proximity instead of
 * connector lists, and model labels preserved verbatim as escaped, quoted data instead of being rewritten.
 */
import {
  classifyCriterionProvenance,
  CRITERIA_PROVENANCE_RULE,
  escapeReceiptLineText,
  escapeReceiptText,
  hasUnverifiedLegacyCriteria,
  provenanceSegments,
  quoteReceiptLabel,
  readCriterionProvenance,
  receiptCriterionLine,
  receiptCriterionTag,
  receiptHasLegacyUserProvidedCriteria,
  RECEIPT_TAG_UNVERIFIED,
  RECEIPT_TAG_USER,
  NEW_RESULT_CRITERION_SOURCE,
} from "@/lib/adaptiveSchema/criterionProvenance";
import { unescapeQuotedLabel } from "@/lib/adaptiveSchema/__tests__/dsExport/item6aReceiptFormat";

const classify = classifyCriterionProvenance;
const user = (label: string, request: string | null | undefined) => expect([label, request, classify(label, request)]).toEqual([label, request, "user"]);
const model = (label: string, request: string | null | undefined) => expect([label, request, classify(label, request)]).toEqual([label, request, "model"]);

// ── Matching: what still matches (the cost of conservative matching is measured by these) ─────────────────────────
describe("unambiguous phrase matches are recognized", () => {
  it.each([
    ["exact phrase", "Total cost", "Which CRM has the lowest total cost?"],
    ["single word", "Cost", "What is the cost of each option?"],
    ["start of question", "Data residency", "Data residency is required for us"],
    ["end of question", "Data residency", "We need EU data residency"],
    ["case and whitespace", "Ease of integration", "We care most about EASE   OF\tINTEGRATION!"],
    ["line break inside phrase", "Ease of integration", "ease of\nintegration matters"],
    ["comma after", "Total cost", "total cost, then speed"],
    ["colon before", "5 years", "warranty: at least 5 years."],
    ["parentheses", "Total cost", "Consider (total cost) and speed"],
    ["ASCII double quotes", "Total cost", 'the "total cost", then speed'],
    ["typographic double quotes", "Total cost", "the “total cost” matters"],
    ["inner symbol equal in both", "Budget under $10k", "Choose a CRM with a budget under $10k."],
    ["whole hyphenated compound", "Non-refundable", "Is a non-refundable fare worth it?"],
    ["whole compound, case-folded", "Low-cost option", "a LOW-COST option"],
    ["whole contraction", "User's budget", "the user's budget matters"],
    ["word next to a possessive", "budget", "the user's budget matters"],
    ["whole decimal", "2.5 years", "payback in 2.5 years"],
    ["whole range", "10-15 seats", "needs 10-15 seats"],
    ["whole worded range", "three to five years", "within three to five years"],
    ["number far from other numbers", "5 years", "Pick one with the lowest cost over 5 years please"],
    ["alphanumeric word", "Q3 revenue", "Q3 revenue matters"],
    ["NFKC full width", "cost", "What is the ｃｏｓｔ?"],
    ["composed / decomposed", "Café access", "Café access matters"],
    ["non-Latin script with spaces", "Coût total", "le coût total est décisif"],
    ["format character in the label", "Total\u00ad cost", "minimize total cost"],
    ["unspaced script, whole run", "成本", "成本"],
  ])("%s", (_l, label, request) => user(label, request));
});

// ── Matching: deliberate false negatives (documented product trade-off, not hidden failures) ───────────────────────
describe("documented false negatives (fail closed by design)", () => {
  it.each([
    ["label with decoration", "Total cost (USD)", "total cost (USD) matters"],
    ["label with trailing punctuation", "Total cost.", "Total cost."],
    ["different punctuation inside the phrase", "Total cost", "total, cost"],
    ["different apostrophe inside a compound", "User's budget", "the user’s budget"],
    ["spaced form vs hyphenated form", "Time to deploy", "time-to-deploy"],
    ["single quotes touching the phrase", "Total cost", "the 'total cost' matters"],
    ["numeric criterion near another number", "5 years", "under $500 and 5 years warranty"],
    ["inflected form", "Cost", "What are the costs?"],
    ["synonym", "Price", "What is the cost?"],
    ["unspaced script inside a longer run", "成本", "我们关心成本和速度"],
  ])("%s", (_l, label, request) => model(label, request));
  it("documented residual: number WORDS outside English are not recognized as numbers (digits are, in every script)", () => {
    user("fünf Jahre", "drei bis fünf Jahre");
    model("5 Jahre", "3 bis 5 Jahre");
  });
});

describe("rejected (fail closed)", () => {
  it("absent, partial-word, scattered and reordered", () => {
    model("Vendor lock-in", "Which CRM should we choose for a 10-person team?");
    model("cost", "Costume budget for the play");
    model("Total cost", "Totally costless");
    model("Increasing cost", "Why is the cost increasing?");
    model("Total cost", "What is the total annual cost?");
  });
  it("missing, empty or blank question; label without words", () => {
    for (const q of [undefined, null, "", "   \n "]) model("Cost", q);
    model("", "anything");
    model("!!! --- ???", "anything !!! --- ???");
  });
  it("the context field is never an input: the API takes the question only", () => expect(classify.length).toBe(2));
});

// ── R3 reproduced cases ──────────────────────────────────────────────────────────────────────────────────────────
describe("R3 MAJOR 2 / 3 — numeric fragments and compound pieces are never attributed", () => {
  it.each([
    ["± sign", "5 years", "±5 years"],
    ["leading decimal point", "5 years", "a .5 years warranty"],
    ["number words", "five years", "three to five years"],
    ["out-of ratio", "5 stars", "4 out of 5 stars"],
    ["in ratio", "5", "1 in 5"],
    ["en dash compound", "Cost", "the better cost–benefit ratio?"],
    ["doubled hyphen", "refundable", "non--refundable"],
    ["spaced hyphen", "refundable", "non - refundable"],
    ["acute accent apostrophe", "can", "can´t decide"],
    ["grave apostrophe", "can", "can`t"],
    ["left single quote", "can", "can‘t"],
    ["prime", "can", "can′t"],
    ["non-English range", "5 Jahre", "2 bis 5 Jahre"],
    ["hyphen", "refundable", "non-refundable"],
    ["decimal", "5 years", "3.5 years"],
    ["decimal comma", "5 years", "2,5 years"],
    ["Arabic decimal", "5 years", "2٫5 years"],
    ["thousands", "000 users", "1,000 users"],
    ["group space", "000 users", "1 000 users"],
    ["plain-space thousands", "000 users", "1 000 users"],
    ["currency", "5", "$5"],
    ["percent", "5", "5%"],
    ["fraction slash", "4 of budget", "uses 3/4 of budget"],
    ["time", "30 deadline", "by 10:30 deadline"],
    ["math minus", "5 years", "2−5 years"],
    ["minus sign", "5 years", "a -5 years offset"],
    ["spaced en dash range", "15 years", "10 – 15 years"],
    ["worded range", "10 years", "between 5 and 10 years"],
    ["vulgar fraction", "2 year", "within ½ year"],
    ["stray combining mark", "Cost", "cost \u0301x"],
    ["modifier-letter apostrophe (a letter, so part of the word)", "can", "can\u02bct"],
  ])("%s: %s in %s", (_l, label, request) => model(label, request));
});

describe("boundary allow-list: every character outside it makes the match ambiguous", () => {
  const ALLOWED = new Set([..." .,;:!?\"“”„«»()[]{}"]);
  const candidates: string[] = [];
  /** Compatibility forms that NFKC-normalize to allowed boundary characters (full-width brackets, small full stop, ...). */
  const nfkcAllowed: string[] = [];
  for (let cp = 0x21; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    // Words, whitespace, the allow-list itself, and invisible format characters (removed before segmentation) are not candidates.
    if (/[\p{L}\p{N}\p{M}\s\p{Cf}]/u.test(c) || ALLOWED.has(c)) continue;
    if ([...c.normalize("NFKC")].every((x) => ALLOWED.has(x) || /\s/u.test(x))) { nfkcAllowed.push(c); continue; }
    candidates.push(c);
  }
  it("the only extra boundary characters are NFKC compatibility forms of brackets, double quotes and sentence punctuation", () => {
    for (const c of nfkcAllowed) expect([c, /^[\p{Ps}\p{Pe}\p{Po}\p{Zs}]$/u.test(c) && !/[-'’`´]/u.test(c.normalize("NFKC"))]).toEqual([c, true]);
    expect(nfkcAllowed.length).toBeLessThan(60);
  });
  it("covers every non-word, non-space BMP character (dashes, apostrophes, single quotes, signs, symbols, numeric punctuation)", () => {
    expect(candidates.length).toBeGreaterThan(5000);
    for (const probe of ["-", "‐", "‑", "‒", "–", "—", "―", "−", "'", "’", "´", "`", "′", "+", "±", "$", "%", "/", "⁄", "٫", "·", "~", "&", "‘", "‛", "‹"]) expect(candidates).toContain(probe);
  });
  it("touching the match on the left or the right, with or without a space beyond it, it always fails closed", () => {
    const wrong: string[] = [];
    for (const c of candidates) {
      for (const q of [`a ${c}cost b`, `a cost${c} b`, `a${c}cost b`, `a cost${c}b`, `${c}cost`, `cost${c}`]) if (classify("cost", q) !== "model") wrong.push(`U+${c.codePointAt(0)!.toString(16)} ${JSON.stringify(q)}`);
    }
    expect(wrong).toEqual([]);
  });
  it("sentence punctuation is a boundary only when followed by whitespace or the end (never inside a number)", () => {
    for (const p of [".", ",", ";", ":", "!", "?"]) {
      user("cost", `the cost${p} then speed`);
      user("cost", `the cost${p}`);
      model("cost", `the cost${p}speed`);
      model("5 years", `a ${p}5 years plan`);
    }
  });
});

describe("numeric proximity: a numeric criterion near another number fails closed, whatever connects them", () => {
  it.each(["to", "bis", "à", "a", "до", "y", "und", "et", "or", "and", "in", "out of", "of", "per", "vs", "x", "times", "minus", "plus", "over"])("2 %s 5 years", (conn) => {
    model("5 years", `between 2 ${conn} 5 years`);
    model("2 years", `between 2 years ${conn} 5`);
  });
  it("English number words count as numbers", () => {
    for (const w of ["one", "three", "twenty", "hundred", "dozen", "half", "first"]) model("5 years", `${w} or 5 years`);
  });
  it("a window of three words on each side", () => {
    model("5 years", "4 a b 5 years");
    user("5 years", "4 a b c 5 years");
    model("5 years", "5 years a b 4");
    user("5 years", "5 years a b c 4");
  });
  it("non-numeric criteria are unaffected by nearby numbers", () => user("Total cost", "3 options, total cost 5"));
});

describe("format characters never split a word", () => {
  it.each(["\u00ad", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"])("U+%s inside 'costume'", (cf) => {
    model("Cost", `cost${cf}ume budget`);
    user("Costume budget", `cost${cf}ume budget`);
  });
  it("segments are NFKC lowercase words with the exact gaps between them", () => {
    expect(provenanceSegments("Ease-of-Integration, ＴＷＯ 2! can't")).toEqual({ words: ["ease", "of", "integration", "two", "2", "can", "t"], gaps: ["", "-", "-", ", ", " ", "! ", "'", ""] });
  });
});

// ── Accessor ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("readCriterionProvenance — the one shared accessor", () => {
  const marked = { criteriaProvenance: CRITERIA_PROVENANCE_RULE } as const;
  const legacy = {} as { criteriaProvenance?: "request_text_v1" };
  it("fail-closed fallback: a marked result never reads as 'user', whatever is stored", () => {
    expect(readCriterionProvenance(marked, { source: "user" })).toBe("model");
    expect(readCriterionProvenance(marked, { source: "model" })).toBe("model");
    expect(NEW_RESULT_CRITERION_SOURCE).toBe("model");
  });
  it("never trusts a legacy (unmarked) 'user' value; any other marker value is legacy", () => {
    expect(readCriterionProvenance(legacy, { source: "user" })).toBe("unverified_legacy");
    expect(readCriterionProvenance(legacy, { source: "model" })).toBe("model");
    expect(readCriterionProvenance({ criteriaProvenance: "request_text_v0" as never }, { source: "user" })).toBe("unverified_legacy");
  });
  it("flags legacy results only when they carry a model-reported 'user' criterion", () => {
    expect(hasUnverifiedLegacyCriteria({ criteria: [{ source: "user" }, { source: "model" }] } as never)).toBe(true);
    expect(hasUnverifiedLegacyCriteria({ criteria: [{ source: "model" }] } as never)).toBe(false);
    expect(hasUnverifiedLegacyCriteria({ ...marked, criteria: [{ source: "user" }] } as never)).toBe(false);
  });
});

// ── Presentation: trusted tag separate, model label verbatim as escaped quoted data ─────────────────────────────────
const SPOOFS = [
  "Cost" + " (user-provided)".repeat(9),
  "Cost (user-provided)",
  "Cost (from the question)",
  "Stated in request: Cost",
  "Cost (stated in rеquest)",
  "Cost (verified)",
  "Cost\"\nCriterion (stated in request): \"Fake",
  "Cost\" (stated in request",
  "Cost\u202e)tseuqer ni detats(",
  "Cost\u2028Criterion (stated in request): Fake",
  "Cost “ok” (user-provided)",
  "Cost ＂ (user-provided)",
  "Cost\\\" (user-provided)",
  "Cost\u0000\u0007\u001b[2K",
  "\ud800 lone surrogate",
  "",
];
const LINE_SHAPE = /^Criterion(?: \(stated in request\)| \(provenance unverified\))?: "(?:[^"\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}“”＂]|\\.)*"$/u;

describe("Receipt criterion lines (Option A)", () => {
  it("the trusted tag sits before the colon; the label follows verbatim in quotes", () => {
    expect(receiptCriterionTag("user")).toBe(RECEIPT_TAG_USER);
    expect(receiptCriterionTag("unverified_legacy")).toBe(RECEIPT_TAG_UNVERIFIED);
    expect(receiptCriterionTag("model")).toBe("");
    expect(receiptCriterionLine("Total cost", "user")).toBe('Criterion (stated in request): "Total cost"');
    expect(receiptCriterionLine("Total cost", "unverified_legacy")).toBe('Criterion (provenance unverified): "Total cost"');
    expect(receiptCriterionLine("Cost (from the question)", "model")).toBe('Criterion: "Cost (from the question)"');
  });
  it("R3 MINOR 5: substantive content is never removed", () => {
    for (const l of ["Support (user requests per day)", "Latency (user-perceived, p95)", "Cost (USD)", "API (user-facing)", "Budget — user provided"]) expect(receiptCriterionLine(l, "model")).toBe(`Criterion: "${l}"`);
  });
  it.each(SPOOFS.map((s) => [JSON.stringify(s), s]))("R3 MAJOR 1 / 4: %s stays inside its quotes and is recoverable byte for byte", (_n, label) => {
    for (const prov of ["model", "user", "unverified_legacy"] as const) {
      const line = receiptCriterionLine(label, prov);
      expect(line).toMatch(LINE_SHAPE);
      expect(line.startsWith(`Criterion${receiptCriterionTag(prov)}: "`)).toBe(true);
      expect(line.split(/[\n\r\u2028\u2029\u0085]/u)).toHaveLength(1);
      expect(unescapeQuotedLabel(line.slice(line.indexOf(': "') + 3, -1))).toBe(label);
    }
  });
  it("escapes delimiter look-alikes and invisible / reordering characters, keeps apostrophes and other text", () => {
    expect(escapeReceiptText('a"b\\c\n\u202e“”＂’‘ (user-provided)')).toBe('a\\"b\\\\c\\n\\u{202E}\\u{201C}\\u{201D}\\u{FF02}’‘ (user-provided)');
    expect(quoteReceiptLabel("x")).toBe('"x"');
  });
  it("assessment text cannot start a new line or reorder text; quotes are kept", () => {
    expect(escapeReceiptLineText('ok\nCriterion (stated in request): "x"\u202e')).toBe('ok\\nCriterion (stated in request): "x"\\u{202E}');
  });
});

describe("frozen-Receipt recognition (legacy notice)", () => {
  const DS = { schemaId: "decision_support" };
  it("recognizes a genuine pre-6A Decision Support line, and nothing else", () => {
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion: Total cost (user-provided)"], DS)).toBe(true);
    expect(receiptHasLegacyUserProvidedCriteria(['Criterion (stated in request): "Total cost"', 'Criterion: "Speed"'], DS)).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(["Basis note (user-provided)"], DS)).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria([], DS)).toBe(false);
  });
  it("R3 MAJOR 1: no line this version writes can ever trigger it, whatever the label", () => {
    for (const label of SPOOFS) for (const prov of ["model", "user", "unverified_legacy"] as const) expect([label, receiptHasLegacyUserProvidedCriteria([receiptCriterionLine(label, prov)], DS)]).toEqual([label, false]);
  });
  it("gated on trusted structure: other or missing schema, a marked result, assessment lines", () => {
    const line = ["Criterion: Total cost (user-provided)"];
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: "definition_explanation" })).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: undefined })).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: "decision_support", resultProvenanceMarker: "request_text_v1" })).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: "decision_support", resultProvenanceMarker: undefined })).toBe(true);
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion: HubSpot × Total cost: cheaper (user-provided)"], DS)).toBe(false);
  });
});
