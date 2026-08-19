import { runProjectAssociationErrorCopy, isStaleUnfiledAssociationError, isStaleTargetAssociationError } from "@/components/projects/runProjectAssociationErrorCopy";
import type { RunProjectAssociationErrorCode } from "@/lib/projects/runProjectAssociationResponse";

const ALL_CODES: RunProjectAssociationErrorCode[] = [
  "unauthorized",
  "auth_error",
  "projects_disabled",
  "invalid_request_body",
  "unexpected_field",
  "run_not_found",
  "project_not_found",
  "project_archived",
  "project_association_conflict",
  "project_association_unchanged",
  "rate_limited",
  "internal_error",
  "network_error",
];

describe("runProjectAssociationErrorCopy", () => {
  it.each(ALL_CODES)("returns a non-empty, user-safe string for every known code (%s)", (code) => {
    const copy = runProjectAssociationErrorCopy(code);
    expect(typeof copy).toBe("string");
    expect(copy.length).toBeGreaterThan(0);
  });

  it("never exposes internal terms (Firestore, Workspace, transaction) in any copy", () => {
    for (const code of ALL_CODES) {
      const copy = runProjectAssociationErrorCopy(code).toLowerCase();
      expect(copy).not.toMatch(/firestore|workspace|transaction/);
    }
  });
});

describe("isStaleUnfiledAssociationError", () => {
  it.each(["run_not_found", "project_association_conflict", "project_association_unchanged"] as RunProjectAssociationErrorCode[])(
    "true for %s",
    (code) => expect(isStaleUnfiledAssociationError(code)).toBe(true)
  );

  it.each(["project_not_found", "project_archived", "rate_limited", "internal_error", "network_error"] as RunProjectAssociationErrorCode[])(
    "false for %s",
    (code) => expect(isStaleUnfiledAssociationError(code)).toBe(false)
  );
});

describe("isStaleTargetAssociationError", () => {
  it.each(["project_not_found", "project_archived"] as RunProjectAssociationErrorCode[])("true for %s", (code) =>
    expect(isStaleTargetAssociationError(code)).toBe(true)
  );

  it.each(["run_not_found", "project_association_conflict", "project_association_unchanged", "rate_limited"] as RunProjectAssociationErrorCode[])(
    "false for %s",
    (code) => expect(isStaleTargetAssociationError(code)).toBe(false)
  );
});
