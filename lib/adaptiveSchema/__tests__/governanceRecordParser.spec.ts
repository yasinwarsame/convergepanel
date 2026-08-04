/**
 * Query-Routing Redesign, Phase 2A, Step 4 — parseGovernanceRecord() tests.
 *
 * Covers: a valid record parses; absent/malformed/unsupported-version data
 * all fail safe with the right reason; every required field (schemaId,
 * answerShape, adaptiveOutputVersion, automatedGovernance, humanReview,
 * decisionReceipt's real uniform shape, createdAt/updatedAt) is validated;
 * schemaId/answerShape mismatch is rejected; optional fields may be safely
 * omitted; the parser never throws regardless of input shape.
 */

import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { AdaptiveDecisionReceipt, GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

function validReceipt(overrides: Partial<AdaptiveDecisionReceipt> = {}): AdaptiveDecisionReceipt {
  return {
    conclusion: "The panel recommends option A.",
    basis: ["Criterion 1 favors option A."],
    assumptions: ["Budget is fixed."],
    uncertainties: ["Long-term maintenance cost is unclear."],
    limitations: ["1 of 3 models did not produce usable output."],
    sources: ["https://example.com/a"],
    sourceBacked: true,
    humanReviewNeeded: false,
    ...overrides,
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
    humanReview: {
      status: "unreviewed",
    },
    decisionReceipt: validReceipt(),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseGovernanceRecord", () => {
  it("parses a valid V1 record", () => {
    const record = validRecord();
    const result = parseGovernanceRecord(record);
    expect(result).toEqual({ ok: true, record });
  });

  it("parses a valid record round-tripped through JSON (Firestore-shaped data)", () => {
    const record = validRecord();
    const roundTripped = JSON.parse(JSON.stringify(record));
    const result = parseGovernanceRecord(roundTripped);
    expect(result.ok).toBe(true);
  });

  it.each([null, undefined])("treats %p as absent", (raw) => {
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "absent" });
  });

  it.each([
    ["a string", "not an object"],
    ["a number", 42],
    ["an array", [1, 2, 3]],
  ])("treats %s as malformed", (_label, raw) => {
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([0, 2, "1", null, undefined])("treats version %p as unsupported_version", (version) => {
    const raw = { ...validRecord(), version };
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it.each(["not_a_schema", "", 123, null, undefined])("rejects invalid schemaId %p as malformed", (schemaId) => {
    const raw = { ...validRecord(), schemaId };
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an invalid answerShape as malformed", () => {
    const raw = { ...validRecord(), answerShape: "ranked_list" }; // schemaId is decision_support
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a schemaId/answerShape mismatch across two otherwise-valid schemas", () => {
    const raw = { ...validRecord({ schemaId: "ranked_enumeration" as any }), answerShape: "comparison_grid" };
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([2, "1", null, undefined])("rejects invalid adaptiveOutputVersion %p as malformed", (adaptiveOutputVersion) => {
    const raw = { ...validRecord(), adaptiveOutputVersion };
    expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
  });

  describe("automatedGovernance", () => {
    it("is optional — omitted entirely still parses", () => {
      const raw = validRecord();
      delete (raw as any).automatedGovernance;
      expect(parseGovernanceRecord(raw)).toEqual({ ok: true, record: raw });
    });

    it.each(["unknown_status", "", 1, null])("rejects invalid automatedGovernance.status %p as malformed", (status) => {
      const raw = { ...validRecord(), automatedGovernance: { status, reasons: [] } };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a non-string-array reasons field as malformed", () => {
      const raw = { ...validRecord(), automatedGovernance: { status: "passed", reasons: [1, 2] } };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a non-numeric policyVersion as malformed", () => {
      const raw = {
        ...validRecord(),
        automatedGovernance: { status: "passed", reasons: [], policyVersion: "3" },
      };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });
  });

  describe("humanReview", () => {
    it.each(["invalid_status", "", 1, null, undefined])("rejects invalid humanReview.status %p as malformed", (status) => {
      const raw = { ...validRecord(), humanReview: { status } };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a missing humanReview object as malformed", () => {
      const raw = validRecord();
      delete (raw as any).humanReview;
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it("accepts every valid humanReview.status value", () => {
      const statuses = ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"];
      for (const status of statuses) {
        const raw = { ...validRecord(), humanReview: { status, conditions: status === "approved_with_conditions" ? ["x"] : undefined } };
        expect(parseGovernanceRecord(raw).ok).toBe(true);
      }
    });

    it("rejects a non-string-array conditions field as malformed", () => {
      const raw = { ...validRecord(), humanReview: { status: "approved_with_conditions", conditions: "not an array" } };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });
  });

  describe("decisionReceipt — real uniform shape only", () => {
    it("rejects a missing decisionReceipt as malformed", () => {
      const raw = validRecord();
      delete (raw as any).decisionReceipt;
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it.each(["conclusion", "basis", "assumptions", "uncertainties", "limitations", "sources", "sourceBacked", "humanReviewNeeded"])(
      "rejects a receipt missing required field %s as malformed",
      (field) => {
        const receipt: any = validReceipt();
        delete receipt[field];
        const raw = { ...validRecord(), decisionReceipt: receipt };
        expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
      }
    );

    it("rejects a non-string conclusion as malformed", () => {
      const raw = { ...validRecord(), decisionReceipt: validReceipt({ conclusion: 5 as any }) };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a non-boolean sourceBacked as malformed", () => {
      const raw = { ...validRecord(), decisionReceipt: validReceipt({ sourceBacked: "true" as any }) };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it("accepts a receipt with every array field empty", () => {
      const raw = {
        ...validRecord(),
        decisionReceipt: validReceipt({ basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [] }),
      };
      expect(parseGovernanceRecord(raw).ok).toBe(true);
    });

    it("does not require or accept a schema-specific field on the receipt — extra fields are simply ignored, not required", () => {
      const raw = { ...validRecord(), decisionReceipt: { ...validReceipt(), rankedItems: ["should be ignored"] } };
      expect(parseGovernanceRecord(raw).ok).toBe(true);
    });
  });

  describe("timestamps", () => {
    it.each(["not-a-date", "", 123, null, undefined])("rejects invalid createdAt %p as malformed", (createdAt) => {
      const raw = { ...validRecord(), createdAt };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });

    it.each(["not-a-date", "", 123, null, undefined])("rejects invalid updatedAt %p as malformed", (updatedAt) => {
      const raw = { ...validRecord(), updatedAt };
      expect(parseGovernanceRecord(raw)).toEqual({ ok: false, reason: "malformed" });
    });
  });

  it("never throws across a battery of hostile inputs", () => {
    const hostileInputs: unknown[] = [
      null,
      undefined,
      0,
      "",
      [],
      {},
      { version: 1 },
      { version: 1, schemaId: "decision_support" },
      Symbol("x"),
      () => {},
      new Date(),
      { toString: () => { throw new Error("boom"); } },
    ];
    for (const input of hostileInputs) {
      expect(() => parseGovernanceRecord(input)).not.toThrow();
    }
  });
});
