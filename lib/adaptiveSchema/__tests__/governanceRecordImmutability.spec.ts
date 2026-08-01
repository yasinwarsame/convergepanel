/**
 * Query-Routing Redesign, Phase 2A, Step 4 — canRefreshDecisionReceipt()
 * and applyHumanReviewUpdate() tests. Extended in Step 6B, Part B with
 * applyAutomatedGovernanceUpdate() tests (§18.7).
 *
 * Covers: refresh is allowed only for absent/unreviewed/pending, blocked
 * for every terminal humanReview status and for malformed/unsupported_version
 * parse results; applyHumanReviewUpdate never mutates its input, never
 * touches decisionReceipt/schemaId/answerShape/adaptiveOutputVersion/
 * createdAt/automatedGovernance, updates only humanReview + updatedAt,
 * requires non-empty conditions for approved_with_conditions, clears stale
 * conditions for every other status, and rejects malformed updates safely
 * without ever calling a connector, classifier, or network API.
 * applyAutomatedGovernanceUpdate mirrors this exactly for the OTHER
 * dimension: updates only automatedGovernance + updatedAt, never touches
 * humanReview/decisionReceipt, allowed after human review (the two
 * dimensions are independent), rejects malformed input safely.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

jest.mock("@/lib/adaptiveSchema/classifier", () => ({
  classifyQuery: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import {
  applyAutomatedGovernanceUpdate,
  applyHumanReviewUpdate,
  canRefreshDecisionReceipt,
  GovernanceRecordParseResult,
  HumanReviewUpdate,
} from "@/lib/adaptiveSchema/governanceRecordParser";
import { AdaptiveDecisionReceipt, GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

const mockedClassifyQuery = classifyQuery as jest.MockedFunction<typeof classifyQuery>;

function validReceipt(): AdaptiveDecisionReceipt {
  return {
    conclusion: "The panel recommends option A.",
    basis: ["Criterion 1 favors option A."],
    assumptions: ["Budget is fixed."],
    uncertainties: ["Long-term maintenance cost is unclear."],
    limitations: ["1 of 3 models did not produce usable output."],
    sources: ["https://example.com/a"],
    sourceBacked: true,
    humanReviewNeeded: false,
  };
}

function validRecord(overrides: Partial<GovernanceRecordV1> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    automatedGovernance: {
      status: "passed",
      reasons: [],
      evaluatedAt: "2026-07-28T00:00:00.000Z",
      policyVersion: 3,
    },
    humanReview: { status: "unreviewed" },
    decisionReceipt: validReceipt(),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockedCallGemini.mockClear();
  mockedClassifyQuery.mockClear();
});

describe("canRefreshDecisionReceipt", () => {
  it("allows refresh when the record is absent", () => {
    const parseResult: GovernanceRecordParseResult = { ok: false, reason: "absent" };
    expect(canRefreshDecisionReceipt(parseResult)).toEqual({ allowed: true, reason: "absent" });
  });

  it.each(["unreviewed", "pending"])("allows refresh when humanReview.status is %s", (status) => {
    const parseResult: GovernanceRecordParseResult = { ok: true, record: validRecord({ humanReview: { status: status as any } }) };
    expect(canRefreshDecisionReceipt(parseResult)).toEqual({ allowed: true, reason: status });
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"])(
    "blocks refresh when humanReview.status is %s",
    (status) => {
      const parseResult: GovernanceRecordParseResult = { ok: true, record: validRecord({ humanReview: { status: status as any } }) };
      expect(canRefreshDecisionReceipt(parseResult)).toEqual({ allowed: false, reason: status });
    }
  );

  it("blocks refresh for a malformed parse result", () => {
    const parseResult: GovernanceRecordParseResult = { ok: false, reason: "malformed" };
    expect(canRefreshDecisionReceipt(parseResult)).toEqual({ allowed: false, reason: "malformed" });
  });

  it("blocks refresh for an unsupported_version parse result", () => {
    const parseResult: GovernanceRecordParseResult = { ok: false, reason: "unsupported_version" };
    expect(canRefreshDecisionReceipt(parseResult)).toEqual({ allowed: false, reason: "unsupported_version" });
  });

  it("never calls a connector, classifier, or network API", () => {
    canRefreshDecisionReceipt({ ok: false, reason: "absent" });
    canRefreshDecisionReceipt({ ok: true, record: validRecord() });
    expect(mockedCallGemini).not.toHaveBeenCalled();
    expect(mockedClassifyQuery).not.toHaveBeenCalled();
  });
});

describe("applyHumanReviewUpdate", () => {
  const NOW = "2026-07-29T12:00:00.000Z";

  it("returns a new object, never mutating the input record", () => {
    const record = validRecord();
    const snapshot = JSON.parse(JSON.stringify(record));
    const result = applyHumanReviewUpdate(record, { status: "approved" }, NOW);
    expect(record).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).not.toBe(record);
    }
  });

  it("never mutates the update input", () => {
    const record = validRecord();
    const update: HumanReviewUpdate = { status: "approved_with_conditions", conditions: ["fix X"] };
    const snapshot = JSON.parse(JSON.stringify(update));
    applyHumanReviewUpdate(record, update, NOW);
    expect(update).toEqual(snapshot);
  });

  it("does not modify decisionReceipt", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "approved" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.decisionReceipt).toEqual(record.decisionReceipt);
    }
  });

  it("does not modify schemaId, answerShape, or adaptiveOutputVersion", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "rejected" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schemaId).toBe(record.schemaId);
      expect(result.record.answerShape).toBe(record.answerShape);
      expect(result.record.adaptiveOutputVersion).toBe(record.adaptiveOutputVersion);
    }
  });

  it("does not modify createdAt", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "approved" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.createdAt).toBe(record.createdAt);
    }
  });

  it("preserves automatedGovernance unchanged", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "approved" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.automatedGovernance).toEqual(record.automatedGovernance);
    }
  });

  it("updates updatedAt to the injected timestamp", () => {
    const record = validRecord({ updatedAt: "2020-01-01T00:00:00.000Z" });
    const result = applyHumanReviewUpdate(record, { status: "approved" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.updatedAt).toBe(NOW);
    }
  });

  it("updates humanReview.status and reviewer fields", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(
      record,
      { status: "approved", reviewerId: "u1", reviewerName: "Reviewer One", reviewedAt: NOW, comment: "Looks good." },
      NOW
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.humanReview).toEqual({
        status: "approved",
        reviewerId: "u1",
        reviewerName: "Reviewer One",
        reviewedAt: NOW,
        comment: "Looks good.",
        conditions: undefined,
      });
    }
  });

  it("requires non-empty conditions for approved_with_conditions", () => {
    const record = validRecord();
    const missing = applyHumanReviewUpdate(record, { status: "approved_with_conditions" }, NOW);
    expect(missing).toEqual({ ok: false, reason: "conditions_required" });

    const empty = applyHumanReviewUpdate(record, { status: "approved_with_conditions", conditions: [] }, NOW);
    expect(empty).toEqual({ ok: false, reason: "conditions_required" });

    const provided = applyHumanReviewUpdate(record, { status: "approved_with_conditions", conditions: ["fix X"] }, NOW);
    expect(provided.ok).toBe(true);
    if (provided.ok) {
      expect(provided.record.humanReview.conditions).toEqual(["fix X"]);
    }
  });

  it.each(["unreviewed", "pending", "approved", "changes_requested", "rejected"])(
    "clears stale conditions when moving to %s even if the caller passes some",
    (status) => {
      const record = validRecord({ humanReview: { status: "approved_with_conditions", conditions: ["old condition"] } });
      const result = applyHumanReviewUpdate(record, { status: status as any, conditions: ["should be dropped"] }, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.humanReview.conditions).toBeUndefined();
      }
    }
  );

  it("rejects an invalid status safely", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "not_a_status" as any }, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("rejects a non-string-array conditions field safely", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "approved_with_conditions", conditions: "not an array" as any }, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("rejects a malformed reviewedAt timestamp safely", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "approved", reviewedAt: "not-a-date" }, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects non-string reviewer fields safely", () => {
    const record = validRecord();
    const result = applyHumanReviewUpdate(record, { status: "approved", reviewerId: 5 as any }, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_fields" });
  });

  it("defaults updatedAt to the real current time when no timestamp is injected", () => {
    const record = validRecord();
    const before = Date.now();
    const result = applyHumanReviewUpdate(record, { status: "approved" });
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const updatedAtMs = Date.parse(result.record.updatedAt);
      expect(updatedAtMs).toBeGreaterThanOrEqual(before);
      expect(updatedAtMs).toBeLessThanOrEqual(after);
    }
  });

  it("never calls a connector, classifier, or network API", () => {
    applyHumanReviewUpdate(validRecord(), { status: "approved" }, NOW);
    applyHumanReviewUpdate(validRecord(), { status: "approved_with_conditions", conditions: ["x"] }, NOW);
    expect(mockedCallGemini).not.toHaveBeenCalled();
    expect(mockedClassifyQuery).not.toHaveBeenCalled();
  });
});

describe("applyAutomatedGovernanceUpdate", () => {
  const NOW = "2026-07-29T12:00:00.000Z";

  function validAutomatedGovernance(overrides: Partial<NonNullable<GovernanceRecordV1["automatedGovernance"]>> = {}) {
    return {
      status: "passed" as const,
      reasons: [] as string[],
      evaluatedAt: NOW,
      policyVersion: 1,
      ...overrides,
    };
  }

  it("returns a new object, never mutating the input record", () => {
    const record = validRecord();
    const snapshot = JSON.parse(JSON.stringify(record));
    const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), NOW);
    expect(record).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).not.toBe(record);
    }
  });

  it("never mutates the automatedGovernance input", () => {
    const record = validRecord();
    const automatedGovernance = validAutomatedGovernance({ reasons: ["a reason"] });
    const snapshot = JSON.parse(JSON.stringify(automatedGovernance));
    applyAutomatedGovernanceUpdate(record, automatedGovernance, NOW);
    expect(automatedGovernance).toEqual(snapshot);
  });

  it("preserves decisionReceipt deeply, unchanged", () => {
    const record = validRecord();
    const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.decisionReceipt).toEqual(record.decisionReceipt);
    }
  });

  it.each(["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"])(
    "preserves humanReview deeply, unchanged, for every status including terminal ones (%s) — automated re-evaluation is allowed after human review",
    (status) => {
      const record = validRecord({
        humanReview: { status: status as any, reviewerId: "u1", reviewerName: "Reviewer", comment: "a comment", conditions: status === "approved_with_conditions" ? ["x"] : undefined },
      });
      const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.humanReview).toEqual(record.humanReview);
      }
    }
  );

  it("preserves schemaId, answerShape, and adaptiveOutputVersion unchanged", () => {
    const record = validRecord();
    const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schemaId).toBe(record.schemaId);
      expect(result.record.answerShape).toBe(record.answerShape);
      expect(result.record.adaptiveOutputVersion).toBe(record.adaptiveOutputVersion);
    }
  });

  it("preserves createdAt unchanged", () => {
    const record = validRecord({ createdAt: "2020-01-01T00:00:00.000Z" });
    const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.createdAt).toBe("2020-01-01T00:00:00.000Z");
    }
  });

  it("updates automatedGovernance to the exact value provided", () => {
    const record = validRecord();
    const automatedGovernance = validAutomatedGovernance({ status: "flagged", reasons: ["1 model(s) failed to produce usable output"] });
    const result = applyAutomatedGovernanceUpdate(record, automatedGovernance, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.automatedGovernance).toEqual(automatedGovernance);
    }
  });

  it("updates updatedAt to the injected timestamp", () => {
    const record = validRecord({ updatedAt: "2020-01-01T00:00:00.000Z" });
    const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.updatedAt).toBe(NOW);
    }
  });

  it("rejects an invalid timestamp safely", () => {
    const record = validRecord();
    const result = applyAutomatedGovernanceUpdate(record, validAutomatedGovernance(), "not-a-date");
    expect(result).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("rejects a malformed automatedGovernance value safely", () => {
    const record = validRecord();
    const result = applyAutomatedGovernanceUpdate(record, { status: "not_a_real_status" } as any, NOW);
    expect(result).toEqual({ ok: false, reason: "invalid_automated_governance" });
  });

  it("does not mutate the input record when rejecting a malformed update", () => {
    const record = validRecord();
    const snapshot = JSON.parse(JSON.stringify(record));
    applyAutomatedGovernanceUpdate(record, { status: "not_a_real_status" } as any, NOW);
    expect(record).toEqual(snapshot);
  });

  it("never calls a connector, classifier, or network API", () => {
    applyAutomatedGovernanceUpdate(validRecord(), validAutomatedGovernance(), NOW);
    expect(mockedCallGemini).not.toHaveBeenCalled();
    expect(mockedClassifyQuery).not.toHaveBeenCalled();
  });
});
