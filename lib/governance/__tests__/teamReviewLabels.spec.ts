/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — centralized label
 * helper tests.
 */

import {
  schemaLabel,
  answerShapeLabel,
  automatedGovernanceStatusLabel,
  humanReviewStatusLabel,
  isTerminalHumanReviewStatusLabel,
  UNKNOWN_LABEL,
} from "@/lib/governance/teamReviewLabels";

describe("schemaLabel", () => {
  it.each([
    ["ranked_enumeration", "Ranked List"],
    ["comparison_matrix", "Comparison"],
    ["definition_explanation", "Explanation"],
    ["causal_explanation", "Cause and Effect"],
    ["checklist_taxonomy", "Checklist"],
    ["deep_research", "Deep Research"],
    ["evidence_review", "Evidence Review"],
    ["bias_blindspot_audit", "Bias and Blind-Spot Audit"],
    ["decision_support", "Decision Support"],
  ])("%s -> %s", (schemaId, expected) => {
    expect(schemaLabel(schemaId)).toBe(expected);
  });

  it("returns Unknown for an unrecognized or missing schemaId", () => {
    expect(schemaLabel("not_a_real_schema")).toBe(UNKNOWN_LABEL);
    expect(schemaLabel(undefined)).toBe(UNKNOWN_LABEL);
    expect(schemaLabel(null)).toBe(UNKNOWN_LABEL);
  });

  it("never renames the persisted enum value itself — only produces a display string", () => {
    expect(schemaLabel("decision_support")).not.toBe("decision_support");
  });
});

describe("answerShapeLabel", () => {
  it.each([
    ["ranked_list", "Ranked List"],
    ["comparison_grid", "Comparison Grid"],
    ["definition_card", "Definition Card"],
    ["causal_map", "Causal Map"],
    ["checklist_taxonomy_view", "Checklist View"],
    ["deep_research_view", "Deep Research View"],
    ["evidence_review_view", "Evidence Review View"],
    ["bias_blindspot_audit_view", "Bias & Blind-Spot Audit View"],
    ["decision_support_view", "Decision Support View"],
  ])("%s -> %s", (shape, expected) => {
    expect(answerShapeLabel(shape)).toBe(expected);
  });

  it("returns Unknown for an unrecognized or missing answerShape", () => {
    expect(answerShapeLabel("bogus_shape")).toBe(UNKNOWN_LABEL);
    expect(answerShapeLabel(undefined)).toBe(UNKNOWN_LABEL);
  });
});

describe("automatedGovernanceStatusLabel", () => {
  it.each([
    ["passed", "Passed"],
    ["flagged", "Flagged"],
    ["blocked", "Blocked"],
    ["not_evaluated", "Not Evaluated"],
    ["error", "Evaluation Error"],
  ])("%s -> %s", (status, expected) => {
    expect(automatedGovernanceStatusLabel(status)).toBe(expected);
  });

  it("returns Unknown for an unrecognized or missing status", () => {
    expect(automatedGovernanceStatusLabel("bogus")).toBe(UNKNOWN_LABEL);
    expect(automatedGovernanceStatusLabel(undefined)).toBe(UNKNOWN_LABEL);
  });
});

describe("humanReviewStatusLabel", () => {
  it.each([
    ["unreviewed", "Unreviewed"],
    ["pending", "Pending"],
    ["approved", "Approved"],
    ["approved_with_conditions", "Approved with Conditions"],
    ["changes_requested", "Changes Requested"],
    ["rejected", "Rejected"],
  ])("%s -> %s", (status, expected) => {
    expect(humanReviewStatusLabel(status)).toBe(expected);
  });

  it("returns Unknown for an unrecognized or missing status", () => {
    expect(humanReviewStatusLabel("bogus")).toBe(UNKNOWN_LABEL);
    expect(humanReviewStatusLabel(null)).toBe(UNKNOWN_LABEL);
  });
});

describe("isTerminalHumanReviewStatusLabel", () => {
  it("is true for all 4 terminal statuses", () => {
    for (const status of ["approved", "approved_with_conditions", "changes_requested", "rejected"]) {
      expect(isTerminalHumanReviewStatusLabel(status)).toBe(true);
    }
  });

  it("is false for unreviewed/pending/unknown", () => {
    expect(isTerminalHumanReviewStatusLabel("unreviewed")).toBe(false);
    expect(isTerminalHumanReviewStatusLabel("pending")).toBe(false);
    expect(isTerminalHumanReviewStatusLabel("bogus")).toBe(false);
    expect(isTerminalHumanReviewStatusLabel(undefined)).toBe(false);
  });
});
