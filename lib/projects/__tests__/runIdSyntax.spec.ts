import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";

describe("validateRunIdSyntax", () => {
  it("accepts a well-formed run id", () => {
    expect(validateRunIdSyntax("run-1e70e52a-43ad-40bc-b781-cf161763fe23")).toEqual({ ok: true, runId: "run-1e70e52a-43ad-40bc-b781-cf161763fe23" });
  });

  it("rejects non-string values", () => {
    expect(validateRunIdSyntax(123).ok).toBe(false);
    expect(validateRunIdSyntax(null).ok).toBe(false);
    expect(validateRunIdSyntax(undefined).ok).toBe(false);
    expect(validateRunIdSyntax({}).ok).toBe(false);
    expect(validateRunIdSyntax([]).ok).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateRunIdSyntax("").ok).toBe(false);
  });

  it("rejects whitespace-only / incidental whitespace", () => {
    expect(validateRunIdSyntax("   ").ok).toBe(false);
    expect(validateRunIdSyntax(" run-1").ok).toBe(false);
    expect(validateRunIdSyntax("run-1 ").ok).toBe(false);
  });

  it("rejects path separators", () => {
    expect(validateRunIdSyntax("run/1").ok).toBe(false);
    expect(validateRunIdSyntax("../etc/passwd").ok).toBe(false);
  });

  it("rejects control characters", () => {
    expect(validateRunIdSyntax("run-1" + String.fromCharCode(10)).ok).toBe(false);
    expect(validateRunIdSyntax("run-1" + String.fromCharCode(0)).ok).toBe(false);
    expect(validateRunIdSyntax("run-1" + String.fromCharCode(127)).ok).toBe(false);
  });

  it("rejects reserved '.' and '..'", () => {
    expect(validateRunIdSyntax(".").ok).toBe(false);
    expect(validateRunIdSyntax("..").ok).toBe(false);
  });

  it("rejects unreasonably long ids", () => {
    expect(validateRunIdSyntax("a".repeat(1501)).ok).toBe(false);
    expect(validateRunIdSyntax("a".repeat(1500)).ok).toBe(true);
  });
});
