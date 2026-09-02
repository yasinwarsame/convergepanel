/**
 * Team Projects UI, Phase 12A.2 — pure parsing/validation tests for
 * `parseTeamProjectsListPageResponse()` / `isDefinitiveEmptyTeamProjectsState()`.
 * No React needed for these — plain functions over plain data, mirroring
 * `hooks/__tests__/useProjects.spec.ts`'s equivalent pure-function
 * coverage for the Personal hook.
 */

import { parseTeamProjectsListPageResponse, isDefinitiveEmptyTeamProjectsState } from "@/hooks/useTeamProjects";

const WS_ID = "ws-1";

function validItem(overrides: Partial<any> = {}) {
  return {
    id: "proj-1",
    workspaceId: WS_ID,
    name: "ABC Acquisition",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updateTime: { seconds: 1, nanoseconds: 0 },
    ...overrides,
  };
}

describe("parseTeamProjectsListPageResponse", () => {
  it("accepts a well-formed page with items scoped to the expected Workspace", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: true,
      body: { ok: true, items: [validItem()], hasMore: false },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: true, page: { items: [validItem()], hasMore: false, nextCursor: undefined } });
  });

  it("accepts updateTime: null (post-mutation projection-read failure) — not a validation failure", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: true,
      body: { ok: true, items: [validItem({ updateTime: null })], hasMore: false },
      expectedWorkspaceId: WS_ID,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed updateTime (not null, not a valid token shape) as internal_error", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: true,
      body: { ok: true, items: [validItem({ updateTime: "not-a-token" })], hasMore: false },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("CRITICAL — a single item whose workspaceId does NOT match the requested Workspace fails the WHOLE page closed, never silently filtered", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: true,
      body: { ok: true, items: [validItem(), validItem({ id: "proj-2", workspaceId: "ws-OTHER" })], hasMore: false },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("a single item whose status isn't 'active' (an archived row leaking into the active-only list) fails the whole page closed", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: true,
      body: { ok: true, items: [validItem({ status: "archived" })], hasMore: false },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("a non-ok HTTP response with a known errorCode maps through directly", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: false,
      body: { ok: false, errorCode: "insufficient_capability" },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "insufficient_capability" });
  });

  it("an unrecognized errorCode collapses to internal_error, never guessed", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: false,
      body: { ok: false, errorCode: "some_future_code_this_client_has_never_heard_of" },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("nextCursor is carried through only when present and a string", () => {
    const result = parseTeamProjectsListPageResponse({
      ok: true,
      body: { ok: true, items: [], hasMore: true, nextCursor: "abc123" },
      expectedWorkspaceId: WS_ID,
    });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: true, nextCursor: "abc123" } });
  });
});

describe("isDefinitiveEmptyTeamProjectsState", () => {
  it("true only when ready, zero items, and hasMore false", () => {
    expect(isDefinitiveEmptyTeamProjectsState({ status: "ready", items: [], hasMore: false })).toBe(true);
  });

  it("false when loading, even with zero items", () => {
    expect(isDefinitiveEmptyTeamProjectsState({ status: "loading", items: [], hasMore: false })).toBe(false);
  });

  it("false when hasMore is true, even with zero items currently loaded", () => {
    expect(isDefinitiveEmptyTeamProjectsState({ status: "ready", items: [], hasMore: true })).toBe(false);
  });

  it("false when items are present", () => {
    expect(isDefinitiveEmptyTeamProjectsState({ status: "ready", items: [validItem()], hasMore: false })).toBe(false);
  });
});
