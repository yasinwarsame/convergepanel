/**
 * Phase 5C — parseWorkspaceMetadataResponse(). Pure function, directly
 * testable without React/hooks/mocking useAuth or authedFetch.
 */

import { parseWorkspaceMetadataResponse } from "@/hooks/useWorkspaceMetadata";

describe("parseWorkspaceMetadataResponse", () => {
  it("real production success envelope -> success with the actual name", () => {
    const result = parseWorkspaceMetadataResponse({ ok: true, body: { ok: true, workspace: { name: "Personal Workspace", type: "personal" } } });
    expect(result).toEqual({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } });
  });

  it("never trusts a 'type' other than personal from the body — always normalizes to the literal 'personal'", () => {
    const result = parseWorkspaceMetadataResponse({ ok: true, body: { ok: true, workspace: { name: "X", type: "team" } } });
    expect(result).toEqual({ status: "success", workspace: { name: "X", type: "personal" } });
  });

  it.each(["unauthorized", "auth_error", "workspace_unavailable", "workspace_invalid", "workspace_missing"])(
    "known error code %s passes through unchanged",
    (errorCode) => {
      const result = parseWorkspaceMetadataResponse({ ok: false, body: { ok: false, errorCode, message: "x" } });
      expect(result).toEqual({ status: "error", errorCode });
    }
  );

  it("unrecognized errorCode from the server -> falls back to workspace_unavailable, never crashes or passes through an unknown value", () => {
    const result = parseWorkspaceMetadataResponse({ ok: false, body: { ok: false, errorCode: "some_new_future_code", message: "x" } });
    expect(result).toEqual({ status: "error", errorCode: "workspace_unavailable" });
  });

  it("ok:true HTTP status but malformed body (ok:true, workspace missing) -> error, never a guessed Workspace", () => {
    const result = parseWorkspaceMetadataResponse({ ok: true, body: { ok: true } });
    expect(result.status).toBe("error");
  });

  it("ok:true HTTP status but workspace.name is not a string -> error, never a guessed Workspace", () => {
    const result = parseWorkspaceMetadataResponse({ ok: true, body: { ok: true, workspace: { name: 12345, type: "personal" } } });
    expect(result.status).toBe("error");
  });

  it("completely null/malformed body -> error, workspace_unavailable, never throws", () => {
    expect(() => parseWorkspaceMetadataResponse({ ok: true, body: null })).not.toThrow();
    const result = parseWorkspaceMetadataResponse({ ok: true, body: null });
    expect(result).toEqual({ status: "error", errorCode: "workspace_unavailable" });
  });

  it("HTTP not-ok with a valid-shaped body.ok:true is still treated as an error (transport-level failure wins)", () => {
    const result = parseWorkspaceMetadataResponse({ ok: false, body: { ok: true, workspace: { name: "X", type: "personal" } } });
    expect(result.status).toBe("error");
  });
});
