import { parseProjectRunsQuery } from "@/lib/projects/projectRunsQuery";

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe("parseProjectRunsQuery", () => {
  it("projectId alone -> project scope", () => {
    const result = parseProjectRunsQuery(params({ projectId: "proj-1" }));
    expect(result).toEqual({ ok: true, scope: { type: "project", projectId: "proj-1" }, limit: 20, cursorRaw: null });
  });

  it("scope=unfiled alone -> unfiled scope", () => {
    const result = parseProjectRunsQuery(params({ scope: "unfiled" }));
    expect(result).toEqual({ ok: true, scope: { type: "unfiled" }, limit: 20, cursorRaw: null });
  });

  it("neither projectId nor scope -> missing_scope", () => {
    const result = parseProjectRunsQuery(params({}));
    expect(result).toEqual({ ok: false, reason: "missing_scope" });
  });

  it("both projectId and scope -> ambiguous_scope", () => {
    const result = parseProjectRunsQuery(params({ projectId: "proj-1", scope: "unfiled" }));
    expect(result).toEqual({ ok: false, reason: "ambiguous_scope" });
  });

  it("scope with an unrecognized value -> unknown_scope", () => {
    const result = parseProjectRunsQuery(params({ scope: "all" }));
    expect(result).toEqual({ ok: false, reason: "unknown_scope" });
  });

  it("scope=projectId (the explicitly disallowed magic-fake-id shape) is treated as an unknown scope value, never accepted", () => {
    const result = parseProjectRunsQuery(params({ scope: "projectId" }));
    expect(result).toEqual({ ok: false, reason: "unknown_scope" });
  });

  it("a syntactically malformed projectId value is still parsed as project scope — validated downstream, not here (never a distinguishing 400)", () => {
    const result = parseProjectRunsQuery(params({ projectId: "../etc/passwd" }));
    expect(result).toEqual({ ok: true, scope: { type: "project", projectId: "../etc/passwd" }, limit: 20, cursorRaw: null });
  });

  it("limit is clamped [1, 50], defaulting to 20 — matches the exact established clamp expression used by GET /api/user/workspace/runs and GET /api/user/projects", () => {
    expect(parseProjectRunsQuery(params({ scope: "unfiled", limit: "5" }))).toMatchObject({ limit: 5 });
    // "0" parses to falsy 0, which the shared `|| DEFAULT_LIMIT` fallback
    // (copied verbatim from established precedent) treats as "not
    // supplied" and defaults to 20 — not clamped up to 1. This is
    // existing, intentional behavior, not specific to this new route.
    expect(parseProjectRunsQuery(params({ scope: "unfiled", limit: "0" }))).toMatchObject({ limit: 20 });
    expect(parseProjectRunsQuery(params({ scope: "unfiled", limit: "-5" }))).toMatchObject({ limit: 1 });
    expect(parseProjectRunsQuery(params({ scope: "unfiled", limit: "999" }))).toMatchObject({ limit: 50 });
    expect(parseProjectRunsQuery(params({ scope: "unfiled", limit: "not-a-number" }))).toMatchObject({ limit: 20 });
    expect(parseProjectRunsQuery(params({ scope: "unfiled" }))).toMatchObject({ limit: 20 });
  });

  it("cursor is passed through raw, untouched", () => {
    const result = parseProjectRunsQuery(params({ scope: "unfiled", cursor: "opaque-token" }));
    expect(result).toMatchObject({ cursorRaw: "opaque-token" });
  });

  it("client-supplied workspaceId/userId are never read as authority — parser has no field for them", () => {
    const result = parseProjectRunsQuery(params({ scope: "unfiled", workspaceId: "forged", userId: "forged" }));
    expect(result).toEqual({ ok: true, scope: { type: "unfiled" }, limit: 20, cursorRaw: null });
  });
});
