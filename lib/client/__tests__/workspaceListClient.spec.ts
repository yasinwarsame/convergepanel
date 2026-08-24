/**
 * Approval Workflow, Phase 9C.1-R1C — client-safe Workspace-list contract/
 * fetch tests. `authedFetch` is mocked directly so these tests assert
 * exactly what URL was requested and how responses/failures map to the
 * caller-safe result shape — never a raw fetch, never SWR/React Query.
 */

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: any[]) => mockedAuthedFetch(...args),
}));

import { parseWorkspaceListResponse, fetchWorkspaceList } from "@/lib/client/workspaceListClient";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("parseWorkspaceListResponse", () => {
  it("parses a well-formed response", () => {
    const parsed = parseWorkspaceListResponse({ ok: true, items: [{ workspaceId: "ws-1", name: "Acme" }], hasMore: true, nextCursor: "wm_abc" });
    expect(parsed).toEqual({ items: [{ workspaceId: "ws-1", name: "Acme" }], hasMore: true, nextCursor: "wm_abc" });
  });

  it("nextCursor absent -> null", () => {
    const parsed = parseWorkspaceListResponse({ ok: true, items: [], hasMore: false });
    expect(parsed?.nextCursor).toBeNull();
  });

  it("rejects ok:false", () => {
    expect(parseWorkspaceListResponse({ ok: false, items: [], hasMore: false })).toBeNull();
  });

  it("rejects a malformed item (missing name)", () => {
    expect(parseWorkspaceListResponse({ ok: true, items: [{ workspaceId: "ws-1" }], hasMore: false })).toBeNull();
  });

  it("rejects non-boolean hasMore", () => {
    expect(parseWorkspaceListResponse({ ok: true, items: [], hasMore: "yes" })).toBeNull();
  });

  it("rejects arbitrary non-object JSON", () => {
    expect(parseWorkspaceListResponse(null)).toBeNull();
    expect(parseWorkspaceListResponse("not an object")).toBeNull();
    expect(parseWorkspaceListResponse(42)).toBeNull();
  });
});

describe("fetchWorkspaceList", () => {
  it("requests GET /api/workspaces with no cursor by default", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [], hasMore: false }) });
    await fetchWorkspaceList({ user: null, authReady: true });
    const [url] = mockedAuthedFetch.mock.calls[0];
    expect(url).toBe("/api/workspaces?");
  });

  it("forwards a supplied cursor", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [], hasMore: false }) });
    await fetchWorkspaceList({ user: null, authReady: true, cursor: "wm_xyz" });
    const [url] = mockedAuthedFetch.mock.calls[0];
    expect(url).toContain("cursor=wm_xyz");
  });

  it("maps a non-ok response to status:error, never exposing the backend status/body", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ errorCode: "team_workspaces_disabled" }) });
    const result = await fetchWorkspaceList({ user: null, authReady: true });
    expect(result).toEqual({ status: "error" });
  });

  it("maps a network throw to status:error", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchWorkspaceList({ user: null, authReady: true });
    expect(result).toEqual({ status: "error" });
  });

  it("maps a malformed-but-200 response to status:error (never silently trusts arbitrary JSON)", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ unexpected: "shape" }) });
    const result = await fetchWorkspaceList({ user: null, authReady: true });
    expect(result).toEqual({ status: "error" });
  });

  it("returns the parsed page on success", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [{ workspaceId: "ws-1", name: "Acme" }], hasMore: false, nextCursor: null }) });
    const result = await fetchWorkspaceList({ user: null, authReady: true });
    expect(result).toEqual({ status: "ok", page: { items: [{ workspaceId: "ws-1", name: "Acme" }], hasMore: false, nextCursor: null } });
  });
});
