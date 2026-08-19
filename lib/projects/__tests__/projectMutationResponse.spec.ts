import { mapMutationErrorCode, validateProjectMutationDto } from "@/lib/projects/projectMutationResponse";

const VALID_TOKEN = { seconds: 1723600000, nanoseconds: 0 };
const FRESH_TOKEN = { seconds: 1723600100, nanoseconds: 500 };

function dto(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    name: "My Project",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updateTime: VALID_TOKEN,
    ...overrides,
  };
}

describe("mapMutationErrorCode", () => {
  it.each([
    "unauthorized",
    "auth_error",
    "projects_disabled",
    "invalid_request_body",
    "unexpected_field",
    "invalid_project_name",
    "invalid_update_time",
    "conflict",
    "invalid_project_status_transition",
    "project_not_found",
    "project_unavailable",
    "too_many_projects",
    "rate_limited",
    "workspace_missing",
    "workspace_invalid",
    "workspace_unavailable",
    "internal_error",
  ])("known error code %s passes through unchanged", (code) => {
    expect(mapMutationErrorCode(code)).toBe(code);
  });

  it("unrecognized/absent errorCode falls back to internal_error, never guessed", () => {
    expect(mapMutationErrorCode("some_future_code")).toBe("internal_error");
    expect(mapMutationErrorCode(undefined)).toBe("internal_error");
    expect(mapMutationErrorCode(null)).toBe("internal_error");
    expect(mapMutationErrorCode(123)).toBe("internal_error");
  });

  it("network_error is a client-only code, never returned by this mapper (never guessed from a server body)", () => {
    expect(mapMutationErrorCode("network_error")).toBe("internal_error");
  });
});

describe("validateProjectMutationDto — create", () => {
  it("accepts a well-formed active-status DTO", () => {
    expect(validateProjectMutationDto(dto({ status: "active" }), { operation: "create" })).not.toBeNull();
  });

  it("SECURITY: rejects a create response claiming status=archived — a freshly created Project is never archived", () => {
    expect(validateProjectMutationDto(dto({ status: "archived" }), { operation: "create" })).toBeNull();
  });

  it("rejects missing/malformed updateTime", () => {
    expect(validateProjectMutationDto(dto({ updateTime: undefined }), { operation: "create" })).toBeNull();
    expect(validateProjectMutationDto(dto({ updateTime: { seconds: "x", nanoseconds: 0 } }), { operation: "create" })).toBeNull();
  });

  it("rejects empty-string id", () => {
    expect(validateProjectMutationDto(dto({ id: "" }), { operation: "create" })).toBeNull();
  });

  it("rejects non-string name", () => {
    expect(validateProjectMutationDto(dto({ name: 123 }), { operation: "create" })).toBeNull();
  });

  it("rejects null/non-object input", () => {
    expect(validateProjectMutationDto(null, { operation: "create" })).toBeNull();
    expect(validateProjectMutationDto("not an object", { operation: "create" })).toBeNull();
  });
});

describe("validateProjectMutationDto — rename", () => {
  it("accepts when id matches and status is unchanged", () => {
    const result = validateProjectMutationDto(dto({ id: "proj-1", status: "active", updateTime: FRESH_TOKEN }), { operation: "rename", expectedId: "proj-1", expectedStatus: "active" });
    expect(result).not.toBeNull();
    expect(result?.updateTime).toEqual(FRESH_TOKEN);
  });

  it("SECURITY: rejects when the returned id does not match the Project that was renamed", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-OTHER" }), { operation: "rename", expectedId: "proj-1", expectedStatus: "active" })).toBeNull();
  });

  it("SECURITY: rejects when rename response silently changes status — rename must never transition status", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-1", status: "archived" }), { operation: "rename", expectedId: "proj-1", expectedStatus: "active" })).toBeNull();
  });

  it("works for an archived Project being renamed too (rename is status-independent server-side)", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-1", status: "archived" }), { operation: "rename", expectedId: "proj-1", expectedStatus: "archived" })).not.toBeNull();
  });
});

describe("validateProjectMutationDto — archive", () => {
  it("accepts id match + status=archived", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-1", status: "archived" }), { operation: "archive", expectedId: "proj-1" })).not.toBeNull();
  });

  it("SECURITY: rejects archive success whose status is still active — contradictory response never adopted", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-1", status: "active" }), { operation: "archive", expectedId: "proj-1" })).toBeNull();
  });

  it("SECURITY: rejects wrong id", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-OTHER", status: "archived" }), { operation: "archive", expectedId: "proj-1" })).toBeNull();
  });
});

describe("validateProjectMutationDto — restore", () => {
  it("accepts id match + status=active", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-1", status: "active" }), { operation: "restore", expectedId: "proj-1" })).not.toBeNull();
  });

  it("SECURITY: rejects restore success whose status is still archived", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-1", status: "archived" }), { operation: "restore", expectedId: "proj-1" })).toBeNull();
  });

  it("SECURITY: rejects wrong id", () => {
    expect(validateProjectMutationDto(dto({ id: "proj-OTHER", status: "active" }), { operation: "restore", expectedId: "proj-1" })).toBeNull();
  });
});
