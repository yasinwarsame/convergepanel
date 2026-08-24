/**
 * Approval Workflow, Phase 9C.1 — client-safe queue contract/fetch tests.
 * `authedFetch` is mocked directly so these tests assert exactly what URL/
 * params were requested and how responses/failures map to the caller-safe
 * result shape — never a raw fetch, never SWR/React Query.
 */

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: any[]) => mockedAuthedFetch(...args),
}));

import {
  buildReviewQueueSearchParams,
  parseProjectFilterParam,
  projectFilterToParamValue,
  parseWorkspaceReviewQueueResponse,
  fetchWorkspaceReviewQueue,
  fetchWorkspaceProjectOptions,
  DEFAULT_REVIEW_QUEUE_LIMIT,
} from "@/lib/client/workspaceReviewQueueClient";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildReviewQueueSearchParams", () => {
  it("all Projects (filter undefined) omits both projectId and scope", () => {
    const params = buildReviewQueueSearchParams({ view: "assigned_to_me", projectFilter: undefined });
    expect(params.get("view")).toBe("assigned_to_me");
    expect(params.has("projectId")).toBe(false);
    expect(params.has("scope")).toBe(false);
    expect(params.get("limit")).toBe(String(DEFAULT_REVIEW_QUEUE_LIMIT));
  });

  it("Unfiled (filter null) sets scope=unfiled, never projectId", () => {
    const params = buildReviewQueueSearchParams({ view: "needs_review", projectFilter: null });
    expect(params.get("scope")).toBe("unfiled");
    expect(params.has("projectId")).toBe(false);
  });

  it("specific Project (filter string) sets projectId, never scope", () => {
    const params = buildReviewQueueSearchParams({ view: "overdue", projectFilter: "proj-1" });
    expect(params.get("projectId")).toBe("proj-1");
    expect(params.has("scope")).toBe(false);
  });

  it("includes cursor only when provided", () => {
    const withCursor = buildReviewQueueSearchParams({ view: "assigned_to_me", projectFilter: undefined, cursor: "opaque-cursor-1" });
    expect(withCursor.get("cursor")).toBe("opaque-cursor-1");
    const withoutCursor = buildReviewQueueSearchParams({ view: "assigned_to_me", projectFilter: undefined });
    expect(withoutCursor.has("cursor")).toBe(false);
  });

  it("respects an explicit limit override, defaulting to 25", () => {
    const params = buildReviewQueueSearchParams({ view: "assigned_to_me", projectFilter: undefined, limit: 50 });
    expect(params.get("limit")).toBe("50");
    expect(DEFAULT_REVIEW_QUEUE_LIMIT).toBe(25);
  });
});

describe("project filter URL round-trip", () => {
  it("absent or 'all' param -> filter undefined (all Projects)", () => {
    expect(parseProjectFilterParam(null)).toBeUndefined();
    expect(parseProjectFilterParam("all")).toBeUndefined();
  });

  it("'unfiled' param -> filter null", () => {
    expect(parseProjectFilterParam("unfiled")).toBeNull();
  });

  it("any other value -> that literal Project id", () => {
    expect(parseProjectFilterParam("proj-42")).toBe("proj-42");
  });

  it("round-trips through projectFilterToParamValue exactly", () => {
    expect(projectFilterToParamValue(undefined)).toBe("all");
    expect(projectFilterToParamValue(null)).toBe("unfiled");
    expect(projectFilterToParamValue("proj-42")).toBe("proj-42");
    for (const filter of [undefined, null, "proj-42"] as const) {
      expect(parseProjectFilterParam(projectFilterToParamValue(filter))).toBe(filter);
    }
  });
});

const VALID_ROW = {
  runId: "run-1",
  workspaceId: "ws-1",
  projectId: null,
  runLabel: "Some research question",
  reviewStatus: "unreviewed",
  createdAt: "2026-08-01T00:00:00.000Z",
  reviewedAt: null,
  assignment: { assignedReviewerUserId: null, assignedReviewerDisplayName: null, dueAt: null, state: "unassigned" },
  isAssignedToMe: false,
  isOverdue: false,
};

describe("parseWorkspaceReviewQueueResponse — structural response validation", () => {
  it("accepts a well-formed response", () => {
    const parsed = parseWorkspaceReviewQueueResponse({ ok: true, items: [VALID_ROW], hasMore: true, nextCursor: "c1", viewerActions: { canManageReviews: true } });
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.hasMore).toBe(true);
    expect(parsed?.nextCursor).toBe("c1");
    expect(parsed?.viewerActions.canManageReviews).toBe(true);
  });

  it("nextCursor absent -> null, never undefined leaking through", () => {
    const parsed = parseWorkspaceReviewQueueResponse({ ok: true, items: [], hasMore: false, viewerActions: { canManageReviews: false } });
    expect(parsed?.nextCursor).toBeNull();
  });

  it("rejects ok:false", () => {
    expect(parseWorkspaceReviewQueueResponse({ ok: false, errorCode: "internal_error" })).toBeNull();
  });

  it("rejects a non-array items field", () => {
    expect(parseWorkspaceReviewQueueResponse({ ok: true, items: "not-an-array", hasMore: false })).toBeNull();
  });

  it("rejects a malformed row (missing required fields)", () => {
    expect(parseWorkspaceReviewQueueResponse({ ok: true, items: [{ runId: "run-1" }], hasMore: false })).toBeNull();
  });

  it("rejects null/non-object input", () => {
    expect(parseWorkspaceReviewQueueResponse(null)).toBeNull();
    expect(parseWorkspaceReviewQueueResponse("garbage")).toBeNull();
  });

  it("missing viewerActions defaults canManageReviews to false, never true", () => {
    const parsed = parseWorkspaceReviewQueueResponse({ ok: true, items: [], hasMore: false });
    expect(parsed?.viewerActions.canManageReviews).toBe(false);
  });
});

describe("fetchWorkspaceReviewQueue", () => {
  const user = { uid: "u1" } as any;

  it("requests the exact route with workspaceId in the path", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, items: [], hasMore: false, viewerActions: { canManageReviews: false } }) });
    await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    const [url] = mockedAuthedFetch.mock.calls[0];
    expect(url).toBe("/api/workspaces/ws-1/review-queue?view=assigned_to_me&limit=25");
  });

  it("maps a 403 to a concealed not_found result, never leaking the reason", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 403 });
    const result = await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    expect(result).toEqual({ status: "not_found" });
  });

  it("maps a 404 to a concealed not_found result", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    expect(result).toEqual({ status: "not_found" });
  });

  it("maps a 500 to a generic error result, never exposing backend detail", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    expect(result).toEqual({ status: "error" });
  });

  it("maps a malformed 200 response body to an error result, never trusting arbitrary JSON", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, items: "not-an-array" }) });
    const result = await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    expect(result).toEqual({ status: "error" });
  });

  it("maps a thrown network error to a generic error result, never throwing to the caller", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    expect(result).toEqual({ status: "error" });
  });

  it("returns the parsed page on success", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, items: [VALID_ROW], hasMore: false, viewerActions: { canManageReviews: false } }) });
    const result = await fetchWorkspaceReviewQueue({ workspaceId: "ws-1", user, authReady: true, view: "assigned_to_me", projectFilter: undefined });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.page.items).toHaveLength(1);
  });
});

describe("fetchWorkspaceProjectOptions", () => {
  const user = { uid: "u1" } as any;

  it("returns the parsed {id, name} list on success", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [{ id: "p1", name: "Q3 Diligence" }] }) });
    const options = await fetchWorkspaceProjectOptions({ workspaceId: "ws-1", user, authReady: true });
    expect(options).toEqual([{ id: "p1", name: "Q3 Diligence" }]);
  });

  it("degrades to an empty list on failure — never blocks or throws", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 500 });
    const options = await fetchWorkspaceProjectOptions({ workspaceId: "ws-1", user, authReady: true });
    expect(options).toEqual([]);
  });

  it("degrades to an empty list on a thrown network error", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const options = await fetchWorkspaceProjectOptions({ workspaceId: "ws-1", user, authReady: true });
    expect(options).toEqual([]);
  });

  it("filters out malformed entries rather than crashing on them", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [{ id: "p1", name: "Valid" }, { id: 123, name: "Bad id type" }, {}] }) });
    const options = await fetchWorkspaceProjectOptions({ workspaceId: "ws-1", user, authReady: true });
    expect(options).toEqual([{ id: "p1", name: "Valid" }]);
  });

  it("issues exactly one request — no per-row Project lookups", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [] }) });
    await fetchWorkspaceProjectOptions({ workspaceId: "ws-1", user, authReady: true });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });
});
