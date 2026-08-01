/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part B —
 * evaluateAdaptiveGovernance() tests.
 *
 * Covers: SOURCE_COMPLETENESS scoped to the 3 real source-tracking
 * schemas only (never a false flag on the other 6), MODEL_FAILURES using
 * the real `reviewIfAnyModelFailed` field, status aggregation (passed/
 * flagged/not_evaluated/error — blocked is defined but not currently
 * reachable, per §18.3/§18.4), partial-coverage reasons, invalid-count
 * safe failure, purity, determinism, and zero model/classifier calls.
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
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { getDefaultGovernancePolicy, GovernancePolicy } from "@/lib/governance/evaluateGovernance";
import { AdaptiveDecisionReceipt, GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

const mockedClassifyQuery = classifyQuery as jest.MockedFunction<typeof classifyQuery>;

const NOW = "2026-07-29T12:00:00.000Z";

function receipt(overrides: Partial<AdaptiveDecisionReceipt> = {}): AdaptiveDecisionReceipt {
  return {
    conclusion: "The panel recommends option A.",
    basis: [],
    assumptions: [],
    uncertainties: [],
    limitations: [],
    sources: [],
    sourceBacked: false,
    humanReviewNeeded: false,
    ...overrides,
  };
}

function governanceRecord(schemaId: string, receiptOverrides: Partial<AdaptiveDecisionReceipt> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: schemaId as any,
    answerShape: "decision_support_view" as any,
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: receipt(receiptOverrides),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function policy(overrides: Partial<GovernancePolicy> = {}): GovernancePolicy {
  return { ...getDefaultGovernancePolicy(), ...overrides };
}

beforeEach(() => {
  mockedCallGemini.mockClear();
  mockedClassifyQuery.mockClear();
});

describe("evaluateAdaptiveGovernance", () => {
  describe("SOURCE_COMPLETENESS — scoped to the 3 real source-tracking schemas only", () => {
    const TRACKING_SCHEMAS = ["ranked_enumeration", "comparison_matrix", "definition_explanation"];
    const NON_TRACKING_SCHEMAS = [
      "causal_explanation",
      "checklist_taxonomy",
      "deep_research",
      "evidence_review",
      "bias_blindspot_audit",
      "decision_support",
    ];

    it.each(TRACKING_SCHEMAS)("flags %s when sourceBacked is true but sources is empty (policy on)", (schemaId) => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord(schemaId, { sourceBacked: true, sources: [] }),
        policy: policy({ blockIfSourceBackedMissingSources: true }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("flagged");
      expect(result.reasons).toContain("Source completeness: run reported source-backed with no preserved source labels");
    });

    it.each(TRACKING_SCHEMAS)("does NOT flag %s when sourceBacked is true and sources are present", (schemaId) => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord(schemaId, { sourceBacked: true, sources: ["https://example.com/a"] }),
        policy: policy({ blockIfSourceBackedMissingSources: true }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
    });

    it.each(TRACKING_SCHEMAS)("does NOT flag %s when sourceBacked is false, regardless of sources", (schemaId) => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord(schemaId, { sourceBacked: false, sources: [] }),
        policy: policy({ blockIfSourceBackedMissingSources: true }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
    });

    it.each(TRACKING_SCHEMAS)("passes %s silently (no reason) when the policy flag is off, even if sourceBacked/sources would otherwise flag", (schemaId) => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord(schemaId, { sourceBacked: true, sources: [] }),
        policy: policy({ blockIfSourceBackedMissingSources: false }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
      expect(result.reasons).toEqual([]);
    });

    it.each(NON_TRACKING_SCHEMAS)(
      "%s is never flagged for sources: [] — reported as not-evaluated for this schema instead, even with sourceBacked: true",
      (schemaId) => {
        const result = evaluateAdaptiveGovernance({
          governanceRecord: governanceRecord(schemaId, { sourceBacked: true, sources: [] }),
          policy: policy({ blockIfSourceBackedMissingSources: true }),
          modelFailureCount: 0,
          successfulModelCount: 2,
          evaluatedAt: NOW,
        });
        expect(result.status).not.toBe("flagged");
        expect(result.reasons).toContain("Source completeness not evaluated for this schema (no per-unit source tracking)");
      }
    );

    it("a non-tracking schema still reaches 'passed' overall via MODEL_FAILURES evaluating, with the skip reason attached", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("checklist_taxonomy", { sourceBacked: true, sources: [] }),
        policy: policy({ blockIfSourceBackedMissingSources: true, reviewIfAnyModelFailed: true }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
      expect(result.reasons).toEqual(["Source completeness not evaluated for this schema (no per-unit source tracking)"]);
    });

    it("a non-tracking schema's skip reason is reported regardless of the policy flag — it describes a data-availability limitation, not a policy choice", () => {
      const flagOn = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ blockIfSourceBackedMissingSources: true }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      const flagOff = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ blockIfSourceBackedMissingSources: false }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(flagOn.reasons).toContain("Source completeness not evaluated for this schema (no per-unit source tracking)");
      expect(flagOff.reasons).toContain("Source completeness not evaluated for this schema (no per-unit source tracking)");
    });
  });

  describe("MODEL_FAILURES — real reviewIfAnyModelFailed field", () => {
    it("flags when reviewIfAnyModelFailed is true and modelFailureCount > 0", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ reviewIfAnyModelFailed: true }),
        modelFailureCount: 1,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("flagged");
      expect(result.reasons).toContain("1 model(s) failed to produce usable output");
    });

    it("passes when reviewIfAnyModelFailed is true and modelFailureCount is 0", () => {
      // Uses a source-tracking schema with sourceBacked: false so
      // SOURCE_COMPLETENESS also passes silently (no skip reason to
      // conflate with) — isolates this assertion to MODEL_FAILURES alone.
      // decision_support (a non-tracking schema) would always contribute
      // its own unrelated skip reason regardless of policy, since that
      // reason describes a data-availability limitation, not a policy
      // choice — see the schema-scope tests above.
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("ranked_enumeration", { sourceBacked: false }),
        policy: policy({ reviewIfAnyModelFailed: true }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
      expect(result.reasons).toEqual([]);
    });

    it("passes silently when reviewIfAnyModelFailed is false, even with failures present", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("ranked_enumeration", { sourceBacked: false }),
        policy: policy({ reviewIfAnyModelFailed: false }),
        modelFailureCount: 3,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
      expect(result.reasons).toEqual([]);
    });

    it("reason text scales with the exact failure count", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ reviewIfAnyModelFailed: true }),
        modelFailureCount: 4,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      });
      expect(result.reasons).toContain("4 model(s) failed to produce usable output");
    });

    it("never treats a model that was simply not selected as a failure — modelFailureCount is trusted as-is, not re-derived", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ reviewIfAnyModelFailed: true }),
        modelFailureCount: 0,
        successfulModelCount: 5,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("passed");
    });
  });

  describe("status aggregation and invalid input", () => {
    it("both rules flagging still produces a single 'flagged' status with both reasons present", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("ranked_enumeration", { sourceBacked: true, sources: [] }),
        policy: policy({ blockIfSourceBackedMissingSources: true, reviewIfAnyModelFailed: true }),
        modelFailureCount: 2,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("flagged");
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "Source completeness: run reported source-backed with no preserved source labels",
          "2 model(s) failed to produce usable output",
        ])
      );
    });

    it.each([-1, 1.5, NaN, Infinity])("returns status 'error' for an invalid modelFailureCount (%p), never a fabricated pass", (bad) => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy(),
        modelFailureCount: bad,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("error");
      expect(result.reasons).toEqual(["Model health counts were invalid"]);
    });

    it.each([-1, 1.5, NaN])("returns status 'error' for an invalid successfulModelCount (%p)", (bad) => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy(),
        modelFailureCount: 0,
        successfulModelCount: bad,
        evaluatedAt: NOW,
      });
      expect(result.status).toBe("error");
    });

    it("preserves policyVersion as a number on every outcome, including error", () => {
      const withError = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ policyVersion: 7 }),
        modelFailureCount: -1,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(withError.policyVersion).toBe(7);

      const withPass = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy({ policyVersion: 7 }),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(withPass.policyVersion).toBe(7);
    });

    it("sets evaluatedAt to the injected value on every outcome", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy(),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(result.evaluatedAt).toBe(NOW);
    });

    it("never excludes consensus, substitution, sensitive-domain, or evidence-quality rules from being silently represented as passing — they simply never appear in reasons at all", () => {
      const result = evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: policy(),
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      const serialized = JSON.stringify(result.reasons);
      expect(serialized).not.toMatch(/consensus/i);
      expect(serialized).not.toMatch(/substitut/i);
      expect(serialized).not.toMatch(/sensitive/i);
      expect(serialized).not.toMatch(/evidence quality/i);
    });
  });

  describe("purity, determinism, and zero I/O", () => {
    it("is deterministic — identical input produces an identical result", () => {
      const input = {
        governanceRecord: governanceRecord("ranked_enumeration", { sourceBacked: true, sources: [] }),
        policy: policy(),
        modelFailureCount: 1,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      };
      const r1 = evaluateAdaptiveGovernance(input);
      const r2 = evaluateAdaptiveGovernance(input);
      expect(r1).toEqual(r2);
    });

    it("never mutates the input governanceRecord", () => {
      const record = governanceRecord("ranked_enumeration", { sourceBacked: true, sources: [] });
      const snapshot = JSON.parse(JSON.stringify(record));
      evaluateAdaptiveGovernance({
        governanceRecord: record,
        policy: policy(),
        modelFailureCount: 1,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      });
      expect(record).toEqual(snapshot);
    });

    it("never mutates the input policy", () => {
      const p = policy();
      const snapshot = JSON.parse(JSON.stringify(p));
      evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("decision_support"),
        policy: p,
        modelFailureCount: 0,
        successfulModelCount: 2,
        evaluatedAt: NOW,
      });
      expect(p).toEqual(snapshot);
    });

    it("never calls a connector or the classifier", () => {
      evaluateAdaptiveGovernance({
        governanceRecord: governanceRecord("ranked_enumeration", { sourceBacked: true, sources: [] }),
        policy: policy(),
        modelFailureCount: 1,
        successfulModelCount: 1,
        evaluatedAt: NOW,
      });
      expect(mockedCallGemini).not.toHaveBeenCalled();
      expect(mockedClassifyQuery).not.toHaveBeenCalled();
    });
  });
});
