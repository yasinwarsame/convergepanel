/**
 * Projects Foundation, Phase 6B — validateProjectIdSyntax() tests.
 * Defense-in-depth only; authorization is resolveProjectForOwner()'s job.
 */

import { validateProjectIdSyntax } from "@/lib/projects/projectId";

describe("validateProjectIdSyntax", () => {
  it("accepts an ordinary opaque Firestore-style auto-id", () => {
    expect(validateProjectIdSyntax("aBcD1234EfGh5678IjKl")).toEqual({ ok: true, projectId: "aBcD1234EfGh5678IjKl" });
  });

  it("rejects non-string input", () => {
    expect(validateProjectIdSyntax(123)).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects an empty string", () => {
    expect(validateProjectIdSyntax("")).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects incidental leading/trailing whitespace", () => {
    expect(validateProjectIdSyntax(" abc ")).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects a control character", () => {
    expect(validateProjectIdSyntax("abc\x00def")).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects a value containing a path separator", () => {
    expect(validateProjectIdSyntax("abc/def")).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects the reserved '.' segment", () => {
    expect(validateProjectIdSyntax(".")).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects the reserved '..' segment", () => {
    expect(validateProjectIdSyntax("..")).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("rejects an id exceeding Firestore's document-id byte limit", () => {
    const tooLong = "a".repeat(1501);
    expect(validateProjectIdSyntax(tooLong)).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("accepts an id at exactly the byte limit", () => {
    const atLimit = "a".repeat(1500);
    expect(validateProjectIdSyntax(atLimit)).toEqual({ ok: true, projectId: atLimit });
  });

  it("does not construct or derive an id — it only validates the exact input given", () => {
    const result = validateProjectIdSyntax("some-id");
    expect(result).toEqual({ ok: true, projectId: "some-id" });
  });
});
