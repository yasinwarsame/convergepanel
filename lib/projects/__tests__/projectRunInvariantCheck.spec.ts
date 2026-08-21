/**
 * Personal Run/Project Invariant Health Check, Phase 8C-B1.3B — pure
 * classifier tests. No Firestore, no live Production access.
 */

import { classifyRunForInvariantCheck, isRunInvariantViolation, type RunInvariantVerdict } from "../projectRunInvariantCheck";

const UID = "uid-1";
const PERSONAL_WS = "personal-uid-1";

describe("classifyRunForInvariantCheck", () => {
  it("legacy: workspaceId absent, projectId absent → legacy_no_workspace, not a violation", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: false,
      workspaceIdValue: undefined,
      hasProjectIdField: false,
      projectIdValue: undefined,
    });
    expect(verdict).toBe("legacy_no_workspace");
    expect(isRunInvariantViolation(verdict)).toBe(false);
  });

  it("legacy: workspaceId explicitly null → legacy_no_workspace (never treated as Personal-bound)", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: null,
      hasProjectIdField: false,
      projectIdValue: undefined,
    });
    expect(verdict).toBe("legacy_no_workspace");
  });

  it("Personal, projectId null → personal_unfiled, not a violation", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: PERSONAL_WS,
      hasProjectIdField: true,
      projectIdValue: null,
    });
    expect(verdict).toBe("personal_unfiled");
    expect(isRunInvariantViolation(verdict)).toBe(false);
  });

  it("Personal, projectId a valid Project id string → personal_filed, not a violation", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: PERSONAL_WS,
      hasProjectIdField: true,
      projectIdValue: "proj-abc123",
    });
    expect(verdict).toBe("personal_filed");
    expect(isRunInvariantViolation(verdict)).toBe(false);
  });

  it("Personal, projectId field absent → personal_violation_absent, IS a violation", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: PERSONAL_WS,
      hasProjectIdField: false,
      projectIdValue: undefined,
    });
    expect(verdict).toBe("personal_violation_absent");
    expect(isRunInvariantViolation(verdict)).toBe(true);
  });

  it("Personal, projectId empty string → personal_violation_malformed, IS a violation", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: PERSONAL_WS,
      hasProjectIdField: true,
      projectIdValue: "",
    });
    expect(verdict).toBe("personal_violation_malformed");
    expect(isRunInvariantViolation(verdict)).toBe(true);
  });

  it("Personal, projectId wrong type (number) → personal_violation_malformed, IS a violation", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: PERSONAL_WS,
      hasProjectIdField: true,
      projectIdValue: 12345,
    });
    expect(verdict).toBe("personal_violation_malformed");
    expect(isRunInvariantViolation(verdict)).toBe(true);
  });

  it("Team-bound (workspaceId present but does not match this run's own owner's Personal Workspace id) → non_personal_workspace, Personal semantics never applied", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: "VQCBcztCPrdWsKwDRwiw", // a Firestore auto-id, e.g. a real Team Workspace
      hasProjectIdField: false,
      projectIdValue: undefined,
    });
    expect(verdict).toBe("non_personal_workspace");
    expect(isRunInvariantViolation(verdict)).toBe(false);
  });

  it("a different user's Personal Workspace id (mismatched owner) → non_personal_workspace, never misclassified as this run's own Personal binding", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: "personal-someone-else",
      hasProjectIdField: false,
      projectIdValue: undefined,
    });
    expect(verdict).toBe("non_personal_workspace");
  });

  it("malformed workspaceId (wrong type) → non_personal_workspace, never crashes", () => {
    const verdict = classifyRunForInvariantCheck({
      userId: UID,
      hasWorkspaceIdField: true,
      workspaceIdValue: 42,
      hasProjectIdField: false,
      projectIdValue: undefined,
    });
    expect(verdict).toBe("non_personal_workspace");
  });

  it("isRunInvariantViolation is true for exactly the two violation verdicts and false for every other verdict", () => {
    const all: RunInvariantVerdict[] = [
      "legacy_no_workspace",
      "non_personal_workspace",
      "personal_unfiled",
      "personal_filed",
      "personal_violation_absent",
      "personal_violation_malformed",
    ];
    const violating = all.filter(isRunInvariantViolation);
    expect(violating.sort()).toEqual(["personal_violation_absent", "personal_violation_malformed"].sort());
  });
});
