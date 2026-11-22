/**
 * Item 6A — unit contract for the authoritative user-criterion provenance rule and the single shared accessor
 * (lib/adaptiveSchema/criterionProvenance.ts). The rule: a criterion is "user" only when its displayed label occurs in
 * the user's ORIGINAL request as a contiguous, same-order run of whole tokens after case / punctuation / whitespace
 * normalization. Everything else, including every model self-report, is "model".
 */
import {
  classifyCriterionProvenance,
  criterionDisplayLabel,
  UNLABELLED_CRITERION,
  CRITERIA_PROVENANCE_RULE,
  hasUnverifiedLegacyCriteria,
  provenanceTokens,
  readCriterionProvenance,
  receiptCriterionLine,
  receiptCriterionTag,
  receiptHasLegacyUserProvidedCriteria,
  RECEIPT_TAG_UNVERIFIED,
  RECEIPT_TAG_USER,
} from "@/lib/adaptiveSchema/criterionProvenance";

const user = (label: string, request: string | null | undefined) => expect(classifyCriterionProvenance(label, request)).toBe("user");
const model = (label: string, request: string | null | undefined) => expect(classifyCriterionProvenance(label, request)).toBe("model");

describe("classifyCriterionProvenance — recognized literal phrases", () => {
  it("recognizes an exact phrase", () => user("Budget under $10k", "Choose a CRM with a budget under $10k."));
  it("normalizes case, punctuation and whitespace", () => {
    user("Ease of integration", "We care most about EASE   OF\tINTEGRATION!");
    user("Total cost", "  total,  cost?  ");
    user("Ease-of-Integration", "EASE-OF-INTEGRATION matters"); // same compound, case-normalized
  });
  it("recognizes a single-token criterion stated as a whole word", () => user("Cost", "What is the cost of each option?"));
  it("recognizes a phrase at the start and end of the request", () => {
    user("Data residency", "Data residency is required for us");
    user("Data residency", "We need EU data residency");
  });
});

describe("classifyCriterionProvenance — rejected (fail closed)", () => {
  it("rejects a criterion absent from the request", () => model("Vendor lock-in", "Which CRM should we choose for a 10-person team?"));
  it("rejects partial-word collisions", () => {
    model("cost", "Costume budget for the play");
    model("risk", "The asterisk in the contract");
    model("Total cost", "Totally costless");
  });
  it("rejects synonyms, plurals and inflections (no stemming or semantics)", () => {
    model("Price", "What is the cost?");
    model("Cost", "What are the costs?");
    model("Integration", "How easily does it integrate?");
  });
  it("rejects scattered words and reordered words (phrase must be contiguous and in order)", () => {
    model("Increasing cost", "Why is the cost increasing?");
    model("Total cost", "What is the total annual cost?");
    model("Cost of ownership", "ownership of the cost model");
  });
  it("fails closed when the original request is missing, empty or blank", () => {
    model("Cost", undefined);
    model("Cost", null);
    model("Cost", "");
    model("Cost", "   \n ");
  });
  it("fails closed for a label with no tokens", () => {
    model("", "anything");
    model("!!! --- ???", "anything !!! --- ???");
  });
});

describe("classifyCriterionProvenance — Unicode", () => {
  it("applies NFKC (full-width and composed / decomposed forms compare equal)", () => {
    user("cost", "What is the ｃｏｓｔ?");
    user("Café access", "Café access matters");
    user("Coût total", "le coût total est décisif");
  });
  it("treats letters with marks as word characters (no split inside a word)", () => model("co", "Le coût"));
  it("documented limitation: unspaced scripts tokenize as whole runs and fail closed", () => {
    user("成本", "成本");
    model("成本", "我们关心成本和速度");
  });
  // N4 owner policy (2026-11-23): hyphenated compounds and contractions are single lexical units.
  it("tokens are lowercase NFKC cohesive lexical units", () => expect(provenanceTokens("Ease-of-Integration, ＴＷＯ 2! can't")).toEqual(["ease-of-integration", "two", "2", "can't"]));
});

describe("readCriterionProvenance — the one shared accessor", () => {
  const marked = { criteriaProvenance: CRITERIA_PROVENANCE_RULE } as const;
  const legacy = {} as { criteriaProvenance?: "request_text_v1" };
  it("reports the stored value for results carrying the marker", () => {
    expect(readCriterionProvenance(marked, { source: "user" })).toBe("user");
    expect(readCriterionProvenance(marked, { source: "model" })).toBe("model");
  });
  it("never trusts a legacy (unmarked) 'user' value", () => {
    expect(readCriterionProvenance(legacy, { source: "user" })).toBe("unverified_legacy");
    expect(readCriterionProvenance(legacy, { source: "model" })).toBe("model");
  });
  it("treats any other marker value as legacy", () => {
    expect(readCriterionProvenance({ criteriaProvenance: "request_text_v0" as never }, { source: "user" })).toBe("unverified_legacy");
  });
  it("flags legacy results only when they carry a model-reported 'user' criterion", () => {
    expect(hasUnverifiedLegacyCriteria({ criteria: [{ source: "user" }, { source: "model" }] } as never)).toBe(true);
    expect(hasUnverifiedLegacyCriteria({ criteria: [{ source: "model" }] } as never)).toBe(false);
    expect(hasUnverifiedLegacyCriteria({ ...marked, criteria: [{ source: "user" }] } as never)).toBe(false);
  });
});

describe("Receipt suffixes and frozen-Receipt recognition", () => {
  it("N1: the trusted tag sits before the colon; the sanitized model label after it", () => {
    expect(receiptCriterionTag("user")).toBe(RECEIPT_TAG_USER);
    expect(receiptCriterionTag("unverified_legacy")).toBe(RECEIPT_TAG_UNVERIFIED);
    expect(receiptCriterionTag("model")).toBe("");
    expect(receiptCriterionLine("Total cost", "user")).toBe("Criterion (stated in request): Total cost");
    expect(receiptCriterionLine("Total cost", "unverified_legacy")).toBe("Criterion (provenance unverified): Total cost");
    expect(receiptCriterionLine("Total cost (stated in the request)", "model")).toBe("Criterion: Total cost");
    expect(receiptCriterionLine("Budget (user-provided).", "model")).toBe("Criterion: Budget");
  });
  const DS = { schemaId: "decision_support" };
  it("N2: recognizes a frozen pre-6A Decision Support criterion line, and nothing else", () => {
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion: Total cost (user-provided)"], DS)).toBe(true);
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion (stated in request): Total cost", "Criterion: Speed"], DS)).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(["Basis note (user-provided)"], DS)).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria([], DS)).toBe(false);
  });
  it("N2: model text cannot trigger it — other schemas, marked results, assessment lines, missing schema", () => {
    const line = ["Criterion: Total cost (user-provided)"];
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: "definition_explanation" })).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: undefined })).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: "decision_support", resultProvenanceMarker: "request_text_v1" })).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(line, { schemaId: "decision_support", resultProvenanceMarker: undefined })).toBe(true);
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion: HubSpot × Total cost: cheaper (user-provided)"], DS)).toBe(false);
  });
});

// ── Item 6A correction round (R1 F3/F4) ─────────────────────────────────────────────────────────────────────────────

describe("F4 — invisible format characters never split a word", () => {
  it.each([
    ["soft hyphen", "cost­ume budget"],
    ["zero-width space", "cost​ume budget"],
    ["zero-width non-joiner", "cost‌ume budget"],
    ["zero-width joiner", "cost‍ume budget"],
    ["word joiner", "cost⁠ume budget"],
    ["BOM", "cost﻿ume budget"],
  ])("%s inside 'costume' does not yield 'cost'", (_l, request) => {
    model("Cost", request);
    user("Costume budget", request);
  });
  it("a format character inside the LABEL is ignored the same way", () => user("Total­ cost", "minimize total cost"));
});

describe("F4 — numeric expressions stay whole", () => {
  it.each([
    ["decimal", "5 years", "payback in 2.5 years"],
    ["decimal comma", "5 years", "payback in 2,5 years"],
    ["thousands", "000 users", "serves 1,000 users"],
    ["range", "15 seats", "needs 10-15 seats"],
    ["en-dash range", "15 seats", "needs 10–15 seats"],
    ["fraction", "4 of budget", "uses 3/4 of budget"],
    ["time", "30 deadline", "by 10:30 deadline"],
    ["version", "0 rollout", "the v2.0 rollout"],
  ])("%s: a fragment of a larger number is not a match", (_l, label, request) => model(label, request));
  it.each([
    ["decimal", "2.5 years", "payback in 2.5 years"],
    ["thousands", "1,000 users", "serves 1,000 users"],
    ["range", "10-15 seats", "needs 10-15 seats"],
    ["plain number", "5 years", "within 5 years, ideally"],
    ["alphanumeric", "Q3 revenue", "Q3 revenue matters"],
  ])("%s: the whole numeric expression matches", (_l, label, request) => user(label, request));
  // N4 owner policy (2026-11-23): this test used to pin that a hyphen between letters splits; that is now forbidden.
  it("a hyphenated compound is one unit (N4 policy, replaces the old split pin)", () => model("Ease of integration", "ease-of-integration"));
  it("sentence punctuation after a number still splits", () => user("5 options", "We have 5 options. Choose one."));
});

describe("F3 — model-written labels cannot carry trusted provenance markers", () => {
  it.each([
    ["Total cost (stated in request)", "Total cost"],
    ["Total cost (provenance unverified)", "Total cost"],
    ["Total cost (user-provided)", "Total cost"],
    ["Total cost (User Provided)", "Total cost"],
    ["Total cost [stated in request]", "Total cost"],
    ["Total cost （user-provided）", "Total cost"],
    ["Total cost (user​-provided)", "Total cost"],
    ["Total cost (user-provided) (stated in request)", "Total cost"],
    ["(user-provided)", UNLABELLED_CRITERION],
  ])("%s → %s", (label, shown) => expect(criterionDisplayLabel(label)).toBe(shown));
  it("labels without a reserved trailing marker are returned byte for byte", () => {
    for (const l of ["Total cost", "Cost (USD)", "Integration (user-facing API)", "Ｆｕｌｌ ｗｉｄｔｈ", "stated in request"]) expect(criterionDisplayLabel(l)).toBe(l);
  });
  it("a spoofed suffix never makes a criterion user-provided by itself", () => {
    model("Vendor lock-in (stated in request)", "Which CRM is cheapest?");
    user("Total cost (stated in request)", "Which CRM has the lowest total cost?"); // the real phrase is in the request
  });
});

// ── Item 6A final correction round (R2 N1/N3/N4) ────────────────────────────────────────────────────────────────────
describe("N1 — near-variant origin claims in model labels are removed; substantive brackets kept", () => {
  it.each([
    ["Budget (stated in the request)", "Budget"],
    ["Budget (user-provided).", "Budget"],
    ["Budget (user-provided)\u200b.", "Budget"],
    ["Budget \u2014 user-provided", "Budget"],
    ["Budget - per the user's request", "Budget"],
    ["Budget {user-provided}", "Budget"],
    ["Budget (verified user-provided)", "Budget"],
    ["Budget (as specified by the user)", "Budget"],
    ["Budget \u00ab user provided \u00bb", "Budget"],
    ["(user-provided) Budget", "Budget"],
    ["Budget (provenance: verified)", "Budget"],
  ])("%s → %s", (label, shown) => expect(criterionDisplayLabel(label)).toBe(shown));
  it.each(["Cost (USD)", "Customer support (24/7)", "API (user-facing)", "Total cost \u2014 first year", "Data residency (EU)", "Time-to-value"])(
    "keeps %s byte for byte",
    (label) => expect(criterionDisplayLabel(label)).toBe(label)
  );
});

describe("N3 — a number is never matched as a fragment of a larger numeric expression", () => {
  it.each([
    ["Arabic decimal", "5 years", "payback in 2\u066b5 years"],
    ["Arabic thousands", "000 users", "serves 1\u066c000 users"],
    ["middle-dot decimal", "5 years", "payback in 2\u00b75 years"],
    ["math minus range", "5 years", "2\u22125 years"],
    ["vulgar fraction (NFKC)", "2 year", "within \u00bd year"],
    ["spaced hyphen range", "15 years", "within 10 - 15 years"],
    ["spaced en-dash range", "15 years", "within 10 \u2013 15 years"],
    ["NBSP thousands", "000 users", "serves 1\u00a0000 users"],
    ["narrow NBSP thousands", "000 users", "serves 1\u202f000 users"],
    ["plain-space thousands", "000 users", "serves 1 000 users"],
    ["signed value", "5 years", "a -5 years offset"],
    ["math-minus signed", "5 years", "a \u22125 years offset"],
    ["worded range", "10 years", "between 5 and 10 years"],
    ["to-range", "10 years", "5 to 10 years"],
    ["ratio", "5 users", "3 of 5 users"],
    ["trailing range", "5", "5 to 10"],
    // A different separator is a different numeric expression ("2·5" may be a product, "2٫5" a decimal): never equal.
    ["different decimal separator", "2\u066b5 years", "in 2\u00b75 years"],
    ["minus vs hyphen range", "2\u22125 years", "within 2-5 years"],
    ["fraction slash vs slash", "1\u20442 year", "within 1/2 year"],
  ])("%s", (_l, label, request) => model(label, request));
  it.each([
    ["Arabic decimal whole", "2\u066b5 years", "payback in 2\u066b5 years"],
    ["spaced range whole", "10-15 years", "within 10 - 15 years"],
    ["number then words", "5 years", "within 5 years or more"],
    ["compound number", "5-year plan", "a 5-year plan"],
    ["signed whole", "-5 years", "a -5 years offset"],
  ])("%s still matches", (_l, label, request) => user(label, request));
});

describe("N4 — hyphenated compounds and contractions are cohesive (owner policy)", () => {
  it.each([
    ["Refundable", "Is a non-refundable fare worth it?"],
    ["can", "I can't decide"],
    ["Entry", "re-entry costs"],
    ["Cost", "a low-cost option"],
    ["Profit", "non-profit status"],
    ["Mail", "e-mail support"],
    ["year plan", "a 5-year plan"],
    ["Compliance", "the risk of non\u2010compliance"],
    ["user needs", "the user's needs"],
  ])("%s is not matched inside %s", (label, request) => model(label, request));
  it.each([
    ["Non-refundable", "Is a non-refundable fare worth it?"],
    ["Re-entry", "re-entry costs"],
    ["Low-cost option", "a LOW-COST option"],
  ])("the whole compound %s still matches", (label, request) => user(label, request));
});
