import { parseRunProjectAssociationBody, validateNullableProjectIdValue } from "@/lib/projects/runProjectAssociationBody";

describe("parseRunProjectAssociationBody", () => {
  it("accepts both fields present, both null (unassign shape)", () => {
    const result = parseRunProjectAssociationBody({ projectId: null, expectedProjectId: null });
    expect(result).toEqual({ ok: true, projectId: null, expectedProjectId: null });
  });

  it("accepts both fields present, string values", () => {
    const result = parseRunProjectAssociationBody({ projectId: "proj-2", expectedProjectId: "proj-1" });
    expect(result).toEqual({ ok: true, projectId: "proj-2", expectedProjectId: "proj-1" });
  });

  it("rejects non-object body", () => {
    expect(parseRunProjectAssociationBody(null).ok).toBe(false);
    expect(parseRunProjectAssociationBody("string").ok).toBe(false);
    expect(parseRunProjectAssociationBody(42).ok).toBe(false);
    expect(parseRunProjectAssociationBody([]).ok).toBe(false);
  });

  it("rejects missing projectId", () => {
    const result = parseRunProjectAssociationBody({ expectedProjectId: null });
    expect(result).toEqual({ ok: false, reason: "missing_field" });
  });

  it("rejects missing expectedProjectId", () => {
    const result = parseRunProjectAssociationBody({ projectId: null });
    expect(result).toEqual({ ok: false, reason: "missing_field" });
  });

  it("rejects an unknown field even alongside both required fields", () => {
    const result = parseRunProjectAssociationBody({ projectId: null, expectedProjectId: null, workspaceId: "personal-x" });
    expect(result).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("SECURITY: forged workspaceId/userId/runId/force/status fields are rejected outright, never silently dropped", () => {
    for (const forged of ["workspaceId", "userId", "runId", "force", "status"]) {
      const result = parseRunProjectAssociationBody({ projectId: null, expectedProjectId: null, [forged]: "x" });
      expect(result).toEqual({ ok: false, reason: "unknown_field" });
    }
  });

  it("distinguishes explicit null from a truly absent key — {} is missing_field, not two nulls", () => {
    const result = parseRunProjectAssociationBody({});
    expect(result).toEqual({ ok: false, reason: "missing_field" });
  });
});

describe("validateNullableProjectIdValue", () => {
  it("null is always valid", () => {
    expect(validateNullableProjectIdValue(null)).toEqual({ ok: true, value: null });
  });

  it("a syntactically valid Project id string is valid", () => {
    expect(validateNullableProjectIdValue("proj-1")).toEqual({ ok: true, value: "proj-1" });
  });

  it("rejects non-null, non-string values", () => {
    expect(validateNullableProjectIdValue(undefined).ok).toBe(false);
    expect(validateNullableProjectIdValue(42).ok).toBe(false);
    expect(validateNullableProjectIdValue({}).ok).toBe(false);
    expect(validateNullableProjectIdValue([]).ok).toBe(false);
    expect(validateNullableProjectIdValue(true).ok).toBe(false);
  });

  it("rejects a malformed Project-id-shaped string (path separator)", () => {
    expect(validateNullableProjectIdValue("proj/1").ok).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateNullableProjectIdValue("").ok).toBe(false);
  });
});
