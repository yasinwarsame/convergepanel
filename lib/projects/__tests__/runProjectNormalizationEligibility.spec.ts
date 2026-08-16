/**
 * Phase 6D.1 — pure classifier tests for the future bounded normalization.
 */

import { classifyProjectIdFieldState, classifyRunForNormalization } from "@/lib/projects/runProjectNormalizationEligibility";

describe("classifyProjectIdFieldState", () => {
  it("field absent -> absent", () => {
    expect(classifyProjectIdFieldState({ hasProjectIdField: false, projectIdValue: undefined })).toBe("absent");
  });
  it("field present, null -> null", () => {
    expect(classifyProjectIdFieldState({ hasProjectIdField: true, projectIdValue: null })).toBe("null");
  });
  it("field present, non-empty string -> assigned", () => {
    expect(classifyProjectIdFieldState({ hasProjectIdField: true, projectIdValue: "proj-1" })).toBe("assigned");
  });
  it("field present, empty string -> malformed", () => {
    expect(classifyProjectIdFieldState({ hasProjectIdField: true, projectIdValue: "" })).toBe("malformed");
  });
  it("field present, wrong type (number) -> malformed", () => {
    expect(classifyProjectIdFieldState({ hasProjectIdField: true, projectIdValue: 42 })).toBe("malformed");
  });
  it("field present, wrong type (object) -> malformed", () => {
    expect(classifyProjectIdFieldState({ hasProjectIdField: true, projectIdValue: {} })).toBe("malformed");
  });
});

describe("classifyRunForNormalization", () => {
  it("no workspaceId field -> legacy, never eligible", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: false,
      workspaceIdValue: undefined,
      workspaceValid: true, // even if a caller mistakenly passed true, legacy wins
      projectIdField: { hasProjectIdField: false, projectIdValue: undefined },
    });
    expect(result).toBe("legacy");
  });

  it("workspaceId field present but null -> legacy", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: true,
      workspaceIdValue: null,
      workspaceValid: true,
      projectIdField: { hasProjectIdField: false, projectIdValue: undefined },
    });
    expect(result).toBe("legacy");
  });

  it("SECURITY: Workspace-bound but invalid association -> bound_invalid, never eligible even with a missing projectId field", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: true,
      workspaceIdValue: "personal-someone",
      workspaceValid: false,
      projectIdField: { hasProjectIdField: false, projectIdValue: undefined },
    });
    expect(result).toBe("bound_invalid");
  });

  it("valid Workspace + projectId field absent -> would_normalize (the only eligible case)", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: true,
      workspaceIdValue: "personal-uid-1",
      workspaceValid: true,
      projectIdField: { hasProjectIdField: false, projectIdValue: undefined },
    });
    expect(result).toBe("would_normalize");
  });

  it("valid Workspace + projectId already null -> already_null (skip)", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: true,
      workspaceIdValue: "personal-uid-1",
      workspaceValid: true,
      projectIdField: { hasProjectIdField: true, projectIdValue: null },
    });
    expect(result).toBe("already_null");
  });

  it("valid Workspace + projectId already assigned -> already_assigned (skip) — must never be overwritten", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: true,
      workspaceIdValue: "personal-uid-1",
      workspaceValid: true,
      projectIdField: { hasProjectIdField: true, projectIdValue: "proj-abc" },
    });
    expect(result).toBe("already_assigned");
  });

  it("valid Workspace + malformed projectId -> malformed_blocker (skip, needs manual review)", () => {
    const result = classifyRunForNormalization({
      hasWorkspaceIdField: true,
      workspaceIdValue: "personal-uid-1",
      workspaceValid: true,
      projectIdField: { hasProjectIdField: true, projectIdValue: 123 },
    });
    expect(result).toBe("malformed_blocker");
  });

  it("MUTATION-STYLE REGRESSION: a `projectId || null` style classifier would wrongly treat malformed falsy values (0, '', false) as eligible for normalization — this classifier does not", () => {
    const falsyMalformed = [0, "", false];
    for (const value of falsyMalformed) {
      const result = classifyRunForNormalization({
        hasWorkspaceIdField: true,
        workspaceIdValue: "personal-uid-1",
        workspaceValid: true,
        projectIdField: { hasProjectIdField: true, projectIdValue: value },
      });
      expect(result).toBe("malformed_blocker");
      expect(result).not.toBe("would_normalize");
    }
  });
});
