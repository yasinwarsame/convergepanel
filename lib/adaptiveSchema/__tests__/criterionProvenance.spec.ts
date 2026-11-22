/**
 * Item 6A — unit contract for the authoritative user-criterion provenance rule and the single shared accessor
 * (lib/adaptiveSchema/criterionProvenance.ts). The rule: a criterion is "user" only when its displayed label occurs in
 * the user's ORIGINAL request as a contiguous, same-order run of whole tokens after case / punctuation / whitespace
 * normalization. Everything else, including every model self-report, is "model".
 */
import {
  classifyCriterionProvenance,
  CRITERIA_PROVENANCE_RULE,
  hasUnverifiedLegacyCriteria,
  LEGACY_RECEIPT_SUFFIX_USER_PROVIDED,
  provenanceTokens,
  readCriterionProvenance,
  receiptCriterionSuffix,
  receiptHasLegacyUserProvidedCriteria,
  RECEIPT_SUFFIX_UNVERIFIED,
  RECEIPT_SUFFIX_USER,
} from "@/lib/adaptiveSchema/criterionProvenance";

const user = (label: string, request: string | null | undefined) => expect(classifyCriterionProvenance(label, request)).toBe("user");
const model = (label: string, request: string | null | undefined) => expect(classifyCriterionProvenance(label, request)).toBe("model");

describe("classifyCriterionProvenance — recognized literal phrases", () => {
  it("recognizes an exact phrase", () => user("Budget under $10k", "Choose a CRM with a budget under $10k."));
  it("normalizes case, punctuation and whitespace", () => {
    user("Ease of integration", "We care most about EASE   OF\tINTEGRATION!");
    user("Ease-of-Integration", "ease of integration");
    user("time to deploy", "Time-to-deploy matters.");
    user("Total cost", "  total,  cost?  ");
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
  it("tokens are lowercase NFKC letter/number/mark runs", () => expect(provenanceTokens("Ease-of-Integration, ＴＷＯ 2!")).toEqual(["ease", "of", "integration", "two", "2"]));
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
  it("maps each provenance to one suffix; the verified suffix differs from the retired one", () => {
    expect(receiptCriterionSuffix("user")).toBe(RECEIPT_SUFFIX_USER);
    expect(receiptCriterionSuffix("unverified_legacy")).toBe(RECEIPT_SUFFIX_UNVERIFIED);
    expect(receiptCriterionSuffix("model")).toBe("");
    expect(RECEIPT_SUFFIX_USER).not.toBe(LEGACY_RECEIPT_SUFFIX_USER_PROVIDED);
  });
  it("recognizes a frozen pre-6A criterion line, and nothing else", () => {
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion: Total cost (user-provided)"])).toBe(true);
    expect(receiptHasLegacyUserProvidedCriteria(["Criterion: Total cost (stated in request)", "Criterion: Speed"])).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria(["Basis note (user-provided)"])).toBe(false);
    expect(receiptHasLegacyUserProvidedCriteria([])).toBe(false);
  });
});
