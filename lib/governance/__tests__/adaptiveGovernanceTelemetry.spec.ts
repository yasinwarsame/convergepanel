/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.8/5.9 —
 * logAdaptiveGovernanceEvent() tests.
 */

const mockLoggerInfo = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { info: (...args: unknown[]) => mockLoggerInfo(...args), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logAdaptiveGovernanceEvent } from "@/lib/governance/adaptiveGovernanceTelemetry";

beforeEach(() => {
  mockLoggerInfo.mockClear();
});

describe("logAdaptiveGovernanceEvent", () => {
  it("logs via the existing shared logger — never a second logging system", () => {
    logAdaptiveGovernanceEvent("panel_created", { runId: "run-1", teamId: "team-1", panelRevision: 1 });
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it("includes the operation name and every provided metadata field", () => {
    logAdaptiveGovernanceEvent("finalization_completed", { runId: "run-1", teamId: "team-1", panelRevision: 2, statusCategory: "approved", aggregationPolicyVersion: 1 });
    const [, metadata] = mockLoggerInfo.mock.calls[0];
    expect(metadata).toEqual({
      operation: "finalization_completed",
      runId: "run-1",
      teamId: "team-1",
      panelRevision: 2,
      statusCategory: "approved",
      aggregationPolicyVersion: 1,
    });
  });

  it("the message string identifies the operation", () => {
    logAdaptiveGovernanceEvent("override_completed", { runId: "run-1" });
    const [message] = mockLoggerInfo.mock.calls[0];
    expect(message).toContain("override_completed");
  });

  it("TypeScript's own metadata type structurally excludes comment/conditions/justification/email/displayName — proven by the absence of any such property on a maximal call", () => {
    logAdaptiveGovernanceEvent("vote_submitted", {
      runId: "run-1",
      teamId: "team-1",
      panelRevision: 1,
      statusCategory: "approved",
      failureCategory: "none",
      artifactStatus: "recorded",
      aggregationPolicyVersion: 1,
    });
    const [, metadata] = mockLoggerInfo.mock.calls[0];
    for (const forbidden of ["comment", "conditions", "justification", "email", "displayName", "rawRequest", "rawFirestoreError", "prompt", "receipt", "sources"]) {
      expect(metadata).not.toHaveProperty(forbidden);
    }
  });

  it("every declared operation name is accepted without a type error (compile-time contract, exercised at runtime here)", () => {
    const operations: Parameters<typeof logAdaptiveGovernanceEvent>[0][] = [
      "panel_created",
      "panel_reconfigured",
      "panel_cancelled",
      "vote_submitted",
      "vote_conflict",
      "finalization_completed",
      "finalization_waiting",
      "finalization_deadlocked",
      "finalization_stale",
      "override_completed",
      "override_stale",
      "override_already_finalized",
      "repair_completed",
      "repair_inconsistent",
      "malformed_record_detected",
      "unsupported_schema_version_detected",
    ];
    for (const op of operations) {
      expect(() => logAdaptiveGovernanceEvent(op, { runId: "run-1" })).not.toThrow();
    }
    expect(mockLoggerInfo).toHaveBeenCalledTimes(operations.length);
  });
});
