import {
  mapRunProjectAssociationErrorCode,
  validateRunProjectAssociationDto,
  type RunProjectAssociationErrorCode,
} from "@/lib/projects/runProjectAssociationResponse";

describe("mapRunProjectAssociationErrorCode", () => {
  const KNOWN: RunProjectAssociationErrorCode[] = [
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
  ];

  it.each(KNOWN)("passes through known code %s unchanged", (code) => {
    expect(mapRunProjectAssociationErrorCode(code)).toBe(code);
  });

  it.each([undefined, null, "", "totally_unknown_code", 42, {}])("collapses unrecognized/absent value %p to internal_error", (raw) => {
    expect(mapRunProjectAssociationErrorCode(raw)).toBe("internal_error");
  });
});

describe("validateRunProjectAssociationDto", () => {
  const CHECK = { expectedRunId: "run-1", expectedTargetProjectId: "proj-1" };

  it("accepts a well-formed, exactly-matching response", () => {
    const raw = { ok: true, runId: "run-1", projectId: "proj-1" };
    expect(validateRunProjectAssociationDto(raw, CHECK)).toEqual(expect.objectContaining({ runId: "run-1", projectId: "proj-1" }));
  });

  it("accepts projectId: null when that's what was expected (future unassign shape)", () => {
    const raw = { ok: true, runId: "run-1", projectId: null };
    expect(validateRunProjectAssociationDto(raw, { expectedRunId: "run-1", expectedTargetProjectId: null })).toEqual(
      expect.objectContaining({ runId: "run-1", projectId: null })
    );
  });

  it("rejects a runId mismatch — an integrity error, never adopted", () => {
    const raw = { ok: true, runId: "run-DIFFERENT", projectId: "proj-1" };
    expect(validateRunProjectAssociationDto(raw, CHECK)).toBeNull();
  });

  it("rejects a projectId mismatch — an integrity error, never adopted", () => {
    const raw = { ok: true, runId: "run-1", projectId: "proj-DIFFERENT" };
    expect(validateRunProjectAssociationDto(raw, CHECK)).toBeNull();
  });

  it("rejects a null projectId when a specific target was expected", () => {
    const raw = { ok: true, runId: "run-1", projectId: null };
    expect(validateRunProjectAssociationDto(raw, CHECK)).toBeNull();
  });

  it.each([
    ["missing runId", { projectId: "proj-1" }],
    ["non-string runId", { runId: 5, projectId: "proj-1" }],
    ["empty runId", { runId: "", projectId: "proj-1" }],
    ["missing projectId", { runId: "run-1" }],
    ["non-string, non-null projectId", { runId: "run-1", projectId: 5 }],
    ["malformed projectId syntax", { runId: "run-1", projectId: "has/slash" }],
    ["null body", null],
    ["array body", []],
    ["string body", "run-1"],
  ])("rejects malformed shape: %s", (_label, raw) => {
    expect(validateRunProjectAssociationDto(raw, CHECK)).toBeNull();
  });
});
