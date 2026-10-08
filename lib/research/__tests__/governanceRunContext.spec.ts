/**
 * Step 6.1 — `deriveGovernanceRunContext()` / `governanceRunContextLines()`.
 *
 * Stop condition: every displayed governance-context value comes directly from
 * an existing persisted field through this one helper; missing data produces no
 * inferred value; each presence/absence rule is independently falsifiable.
 * Every case below changes exactly ONE input from a body where all three values
 * are present, and asserts the OTHER two survive unchanged.
 */
import {
  DECIDED_HUMAN_REVIEW_STATUSES,
  EMPTY_GOVERNANCE_RUN_CONTEXT,
  EVALUATED_AUTOMATED_STATUSES,
  TIME_SENSITIVE_FRESHNESS,
  deriveGovernanceRunContext,
  formatDecisionAge,
  governanceRunContextLines,
} from "@/lib/research/governanceRunContext";

const REVIEWED_AT = "2026-10-05T12:00:00.000Z";
const GENERATED_AT = "2026-10-01T09:00:00.000Z";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const FMT = { locale: "en-GB", timeZone: "UTC" };

type Body = Record<string, any>;
function body(): Body {
  return {
    ok: true,
    adaptive: {
      status: "valid",
      output: { classification: { freshness: "recent" }, meta: { freshness: "timeless" }, generatedAt: GENERATED_AT },
      humanReview: { status: "approved", reviewedAt: REVIEWED_AT },
      reviewRouting: "unknown",
      automatedGovernance: { status: "passed", policyVersion: 7 },
    },
    legacyAdaptive: { status: "absent", output: null },
  };
}
const FULL = { policyVersion: 7, decidedAt: REVIEWED_AT, timeSensitiveGeneratedAt: GENERATED_AT };
const with_ = (edit: (b: Body) => void) => {
  const b = body();
  edit(b);
  return deriveGovernanceRunContext(b);
};

it("a body carrying all three persisted values yields all three", () => {
  expect(deriveGovernanceRunContext(body())).toEqual(FULL);
});

describe("policy version — persisted automatedGovernance.policyVersion, only for a real evaluation", () => {
  it.each(EVALUATED_AUTOMATED_STATUSES)("status %s → shown", (status) => {
    expect(with_((b) => (b.adaptive.automatedGovernance.status = status))).toEqual(FULL);
  });
  it.each(["not_evaluated", "error", "PASSED", "", undefined])("status %p → absent", (status) => {
    expect(with_((b) => (b.adaptive.automatedGovernance.status = status))).toEqual({ ...FULL, policyVersion: null });
  });
  it.each([undefined, 0, -1, 1.5, "7", Number.NaN, Number.POSITIVE_INFINITY, null])("policyVersion %p → absent, never defaulted", (v) => {
    expect(with_((b) => (b.adaptive.automatedGovernance.policyVersion = v))).toEqual({ ...FULL, policyVersion: null });
  });
  it("no persisted automated evaluation → absent", () => {
    expect(with_((b) => (b.adaptive.automatedGovernance = null))).toEqual({ ...FULL, policyVersion: null });
  });
  it("a non-valid adaptive envelope contributes no policy version even if the field is present", () => {
    const ctx = with_((b) => {
      b.adaptive.status = "malformed";
      b.legacyAdaptive = { status: "valid", output: { classification: { freshness: "live" }, generatedAt: GENERATED_AT } };
    });
    expect(ctx).toEqual({ policyVersion: null, decidedAt: null, timeSensitiveGeneratedAt: GENERATED_AT });
  });
});

describe("decision time — persisted humanReview.reviewedAt, only for an actual decision", () => {
  it.each(DECIDED_HUMAN_REVIEW_STATUSES)("status %s → shown", (status) => {
    expect(with_((b) => (b.adaptive.humanReview.status = status))).toEqual(FULL);
  });
  it.each(["unreviewed", "pending", "", undefined])("status %p → absent even with a reviewedAt", (status) => {
    expect(with_((b) => (b.adaptive.humanReview.status = status))).toEqual({ ...FULL, decidedAt: null });
  });
  it.each([undefined, "", "not a date", 1759665600000, null])("reviewedAt %p → absent, never inferred", (v) => {
    expect(with_((b) => (b.adaptive.humanReview.reviewedAt = v))).toEqual({ ...FULL, decidedAt: null });
  });
  it("no human review → absent", () => {
    expect(with_((b) => (b.adaptive.humanReview = null))).toEqual({ ...FULL, decidedAt: null });
  });
});

describe("time sensitivity — persisted classification.freshness + generatedAt of the rendered envelope", () => {
  it.each(TIME_SENSITIVE_FRESHNESS)("freshness %s → shown", (freshness) => {
    expect(with_((b) => (b.adaptive.output.classification.freshness = freshness))).toEqual(FULL);
  });
  it.each(["timeless", "LIVE", "", undefined])("freshness %p → absent", (freshness) => {
    expect(with_((b) => (b.adaptive.output.classification.freshness = freshness))).toEqual({ ...FULL, timeSensitiveGeneratedAt: null });
  });
  it("meta.freshness is NOT the source — only the persisted classification is", () => {
    const ctx = with_((b) => {
      b.adaptive.output.classification.freshness = "timeless";
      b.adaptive.output.meta.freshness = "live";
    });
    expect(ctx).toEqual({ ...FULL, timeSensitiveGeneratedAt: null });
  });
  it.each([undefined, "", "yesterday"])("generatedAt %p → absent, never substituted", (v) => {
    expect(with_((b) => (b.adaptive.output.generatedAt = v))).toEqual({ ...FULL, timeSensitiveGeneratedAt: null });
  });
  it("legacy-adaptive envelope is read when there is no valid adaptive one", () => {
    const ctx = deriveGovernanceRunContext({
      adaptive: { status: "absent", output: null, humanReview: null, automatedGovernance: null },
      legacyAdaptive: { status: "valid", output: { classification: { freshness: "date_sensitive" }, generatedAt: GENERATED_AT } },
    });
    expect(ctx).toEqual({ policyVersion: null, decidedAt: null, timeSensitiveGeneratedAt: GENERATED_AT });
  });
  it("a valid adaptive envelope wins: a time-sensitive legacy envelope beside a timeless adaptive one is ignored", () => {
    const ctx = with_((b) => {
      b.adaptive.output.classification.freshness = "timeless";
      b.legacyAdaptive = { status: "valid", output: { classification: { freshness: "live" }, generatedAt: GENERATED_AT } };
    });
    expect(ctx).toEqual({ ...FULL, timeSensitiveGeneratedAt: null });
  });
});

describe("robustness", () => {
  it.each([null, undefined, "x", 3, []])("non-object body %p → the empty context", (raw) => {
    expect(deriveGovernanceRunContext(raw)).toEqual(EMPTY_GOVERNANCE_RUN_CONTEXT);
  });
  it("does not mutate its input", () => {
    const b = body();
    const before = JSON.stringify(b);
    deriveGovernanceRunContext(b);
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe("display lines", () => {
  it("renders the three persisted values in a fixed order", () => {
    expect(governanceRunContextLines(FULL, NOW, FMT)).toEqual([
      { key: "policy", text: "Evaluated under policy v7" },
      { key: "decided", text: "Decided 3 days ago (5 Oct 2026)" },
      { key: "time_sensitive", text: "Time-sensitive question · generated 1 Oct 2026" },
    ]);
  });
  it("each line appears only for its own value", () => {
    const keys = (ctx: typeof FULL | Record<string, unknown>) => governanceRunContextLines(ctx as never, NOW, FMT).map((l) => l.key);
    expect(keys({ ...FULL, policyVersion: null })).toEqual(["decided", "time_sensitive"]);
    expect(keys({ ...FULL, decidedAt: null })).toEqual(["policy", "time_sensitive"]);
    expect(keys({ ...FULL, timeSensitiveGeneratedAt: null })).toEqual(["policy", "decided"]);
    expect(keys(EMPTY_GOVERNANCE_RUN_CONTEXT)).toEqual([]);
  });
  it("never mentions the current policy", () => {
    expect(JSON.stringify(governanceRunContextLines(FULL, NOW, FMT)).toLowerCase()).not.toMatch(/current|latest|outdated|newer|changed/);
  });
});

describe("decision age", () => {
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  it.each([
    [0, "just now"],
    [-5 * MIN, "just now"],
    [59_999, "just now"],
    [MIN, "1 minute ago"],
    [2 * MIN, "2 minutes ago"],
    [59 * MIN, "59 minutes ago"],
    [60 * MIN, "1 hour ago"],
    [23 * 60 * MIN, "23 hours ago"],
    [DAY, "1 day ago"],
    [29 * DAY, "29 days ago"],
    [30 * DAY, "1 month ago"],
    [364 * DAY, "12 months ago"],
    [365 * DAY, "1 year ago"],
    [800 * DAY, "2 years ago"],
  ])("%p ms → %s", (elapsed, expected) => {
    expect(formatDecisionAge(NOW - (elapsed as number), NOW)).toBe(expected);
  });
});
