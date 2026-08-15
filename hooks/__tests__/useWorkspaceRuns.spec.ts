/**
 * Phase 5D — `parseWorkspaceRunsPageResponse()` / `isDefinitiveEmptyState()`
 * (pure, no mocking needed) plus the full `useWorkspaceRuns()` hook
 * pagination/race/isolation matrix, via `react-test-renderer` + `act()` +
 * mocked `authedFetch`/`useAuth` — the exact established pattern already
 * used for async-hook race testing in this repo (see
 * `components/teamGovernance/__tests__/adaptiveMultiReviewerPanelSectionRunIdRace.spec.tsx`).
 * No jsdom, no @testing-library — matches this repo's convention.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
function createDeferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const callLog: string[] = [];
const deferredQueueByUrl = new Map<string, Deferred[]>();
const authedFetchMock = jest.fn((url: string) => {
  callLog.push(url);
  const queue = deferredQueueByUrl.get(url) ?? [];
  const deferred = queue.shift() ?? createDeferred(); // never resolves if nothing queued
  deferredQueueByUrl.set(url, queue);
  return deferred.promise;
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, unknown]) => authedFetchMock(...args),
}));

import { useWorkspaceRuns, parseWorkspaceRunsPageResponse, isDefinitiveEmptyState } from "@/hooks/useWorkspaceRuns";
import type { UseWorkspaceRunsResult, WorkspaceRunSummary } from "@/hooks/useWorkspaceRuns";

// ---------------------------------------------------------------------------
// Pure functions — no mocking required.
// ---------------------------------------------------------------------------

const SAMPLE_ITEM: WorkspaceRunSummary = { id: "run-1", at: "2026-08-15T00:00:00.000Z", question: "Q", selectedModels: ["chatgpt"] };

describe("parseWorkspaceRunsPageResponse (pure)", () => {
  it("real production success envelope with items -> success page", () => {
    const result = parseWorkspaceRunsPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "abc" } });
    expect(result).toEqual({ ok: true, page: { items: [SAMPLE_ITEM], hasMore: true, nextCursor: "abc" } });
  });

  it("real empty-Workspace envelope (items:[], hasMore:false, no nextCursor key) -> success page with nextCursor undefined", () => {
    const result = parseWorkspaceRunsPageResponse({ ok: true, body: { ok: true, items: [], hasMore: false } });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: false, nextCursor: undefined } });
  });

  it("CRITICAL: items:[] with hasMore:true and a nextCursor is parsed as a valid success page, not an error and not treated specially", () => {
    const result = parseWorkspaceRunsPageResponse({ ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "next" } });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: true, nextCursor: "next" } });
  });

  it.each(["unauthorized", "auth_error", "workspace_unavailable", "workspace_invalid", "workspace_missing", "invalid_cursor", "index_required", "internal_error"])(
    "known error code %s passes through unchanged",
    (errorCode) => {
      const result = parseWorkspaceRunsPageResponse({ ok: false, body: { ok: false, errorCode, message: "x" } });
      expect(result).toEqual({ ok: false, errorCode });
    }
  );

  it("unrecognized errorCode -> falls back to internal_error, never crashes or passes through an unknown value", () => {
    const result = parseWorkspaceRunsPageResponse({ ok: false, body: { ok: false, errorCode: "some_new_future_code" } });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("malformed body (ok:true HTTP but body.items missing) -> error, never a guessed page", () => {
    const result = parseWorkspaceRunsPageResponse({ ok: true, body: { ok: true } });
    expect(result.ok).toBe(false);
  });

  it("malformed body (hasMore not boolean) -> error", () => {
    const result = parseWorkspaceRunsPageResponse({ ok: true, body: { ok: true, items: [], hasMore: "yes" } });
    expect(result.ok).toBe(false);
  });

  it("null body never throws", () => {
    expect(() => parseWorkspaceRunsPageResponse({ ok: true, body: null })).not.toThrow();
  });
});

describe("isDefinitiveEmptyState (pure) — the corrected condition [Revision 1]", () => {
  it("status ready, items=[], hasMore=false -> true (the ONLY case that renders the empty state)", () => {
    expect(isDefinitiveEmptyState({ status: "ready", items: [], hasMore: false })).toBe(true);
  });

  it("status ready, items=[], hasMore=true -> false (never empty while continuation exists)", () => {
    expect(isDefinitiveEmptyState({ status: "ready", items: [], hasMore: true })).toBe(false);
  });

  it("status ready, items non-empty, hasMore=false -> false", () => {
    expect(isDefinitiveEmptyState({ status: "ready", items: [SAMPLE_ITEM], hasMore: false })).toBe(false);
  });

  it("status loading, items=[], hasMore=false -> false (items.length===0 alone is never sufficient)", () => {
    expect(isDefinitiveEmptyState({ status: "loading", items: [], hasMore: false })).toBe(false);
  });

  it("status error, items=[], hasMore=false -> false", () => {
    expect(isDefinitiveEmptyState({ status: "error", items: [], hasMore: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook — mocked useAuth/authedFetch.
// ---------------------------------------------------------------------------

function queueResponse(url: string, response: { ok: boolean; body: unknown }) {
  const deferred = createDeferred();
  const existing = deferredQueueByUrl.get(url) ?? [];
  existing.push(deferred);
  deferredQueueByUrl.set(url, existing);
  deferred.resolve({ ok: response.ok, json: async () => response.body });
  return deferred;
}

function queuePendingResponse(url: string): Deferred {
  const deferred = createDeferred();
  const existing = deferredQueueByUrl.get(url) ?? [];
  existing.push(deferred);
  deferredQueueByUrl.set(url, existing);
  return deferred;
}

function HookHost({ onResult }: { onResult: (r: UseWorkspaceRunsResult) => void }) {
  const result = useWorkspaceRuns();
  onResult(result);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const RUNS_URL = "/api/user/workspace/runs";
function cursorUrl(cursor: string) {
  return `${RUNS_URL}?cursor=${encodeURIComponent(cursor)}`;
}

beforeEach(() => {
  callLog.length = 0;
  deferredQueueByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

describe("useWorkspaceRuns — initial load", () => {
  it("populated first page -> status ready, items set, hasMore/nextCursor adopted", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c1" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    expect(latest.hasMore).toBe(true);
    renderer.unmount();
  });

  it("CRITICAL: first page items=[] with hasMore=true -> status ready (NOT error, NOT stuck loading), items empty, hasMore true, cursor adopted for the next call", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "next-page" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.items).toEqual([]);
    expect(latest.hasMore).toBe(true);

    // Prove the cursor from THIS empty page was genuinely adopted: calling
    // loadMore() must request the exact cursor the server just returned.
    queueResponse(cursorUrl("next-page"), { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog).toContain(cursorUrl("next-page"));
    renderer.unmount();
  });

  it("first page items=[] hasMore=false -> the definitive empty condition holds", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(isDefinitiveEmptyState(latest)).toBe(true);
    renderer.unmount();
  });

  it("initial failure -> status error, initialErrorCode set, items stay empty", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: false, body: { ok: false, errorCode: "internal_error" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([]);
    renderer.unmount();
  });
});

describe("useWorkspaceRuns — pagination forward-progress [Revision 1]", () => {
  it("multiple consecutive empty continuation pages: cursor advances A -> B -> C exactly once each, no repeat, no loop, eventual valid item appended", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "B" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([]);
    expect(latest.hasMore).toBe(true);

    queueResponse(cursorUrl("B"), { ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "C" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items).toEqual([]);
    expect(latest.hasMore).toBe(true);
    expect(!isDefinitiveEmptyState(latest)).toBe(true); // never shows empty state while hasMore is true

    queueResponse(cursorUrl("C"), { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();

    expect(latest.items).toEqual([SAMPLE_ITEM]);
    expect(latest.hasMore).toBe(false);
    // Each cursor requested exactly once — no repeats.
    expect(callLog.filter((u) => u === RUNS_URL).length).toBe(1);
    expect(callLog.filter((u) => u === cursorUrl("B")).length).toBe(1);
    expect(callLog.filter((u) => u === cursorUrl("C")).length).toBe(1);
    renderer.unmount();
  });

  it("visible rows followed by a terminal empty continuation page: rows preserved, hasMore becomes false, no empty state shown", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c2" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("c2"), { ok: true, body: { ok: true, items: [], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();

    expect(latest.items).toEqual([SAMPLE_ITEM]); // preserved, not wiped by the empty terminal page
    expect(latest.hasMore).toBe(false);
    expect(isDefinitiveEmptyState(latest)).toBe(false); // there ARE visible rows
    renderer.unmount();
  });

  it("cursor advances on EVERY successful response regardless of item count — proven by requesting a THIRD page after two successful pages, one of which was empty", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "p2" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("p2"), { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "p3" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();

    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog).toContain(cursorUrl("p3"));
    renderer.unmount();
  });

  it("CRITICAL: a failed Load-more request does NOT advance the cursor — retry re-sends the exact same cursor", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "will-fail" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("will-fail"), { ok: false, body: { ok: false, errorCode: "internal_error" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadMoreErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([SAMPLE_ITEM]); // preserved

    // Retry — must hit the SAME cursor, not a new one.
    queueResponse(cursorUrl("will-fail"), { ok: true, body: { ok: true, items: [], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog.filter((u) => u === cursorUrl("will-fail")).length).toBe(2); // failed attempt + retry, same URL both times
    expect(latest.loadMoreErrorCode).toBeNull();
    renderer.unmount();
  });

  it("repeated Load-more clicks while a request is already in flight are suppressed — only one request fires", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "slow" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    const pending = queuePendingResponse(cursorUrl("slow"));
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadingMore).toBe(true);

    await act(async () => {
      latest.loadMore(); // second click while still loading — must be a no-op
      latest.loadMore();
    });
    await flush();
    expect(callLog.filter((u) => u === cursorUrl("slow")).length).toBe(1);

    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ ok: true, items: [], hasMore: false }) });
    });
    await flush();
    renderer.unmount();
  });

  it("invalid_cursor on Load more never surfaces 'cursor' in the error code path being retried; resetAndReloadFromStart discards state and cursor, refetches page 1", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "stale-cursor" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("stale-cursor"), { ok: false, body: { ok: false, errorCode: "invalid_cursor" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadMoreErrorCode).toBe("invalid_cursor");
    expect(latest.items).toEqual([SAMPLE_ITEM]); // preserved until explicit user action

    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } });
    await act(async () => {
      latest.resetAndReloadFromStart();
    });
    await flush();
    expect(callLog.filter((u) => u === RUNS_URL).length).toBe(2); // initial + explicit reset, never automatic
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    expect(latest.loadMoreErrorCode).toBeNull();
    renderer.unmount();
  });

  it("workspace_unavailable during Load more preserves rows and never mutates hasMore into false / an empty-looking state", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("c"), { ok: false, body: { ok: false, errorCode: "workspace_unavailable" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.hasMore).toBe(true);
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    expect(latest.loadMoreErrorCode).toBe("workspace_unavailable");
    renderer.unmount();
  });

  it("a thrown fetch exception (genuine network failure, not a parsed server error body) maps to network_error, cursor unaffected", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    authedFetchMock.mockImplementationOnce(() => Promise.reject(new Error("fetch failed")));
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadMoreErrorCode).toBe("network_error");
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    renderer.unmount();
  });
});

describe("useWorkspaceRuns — deduplication", () => {
  it("a duplicate id across pages is dropped defensively, with a dev warning, not silently accepted as expected", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("c"), { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } }); // same id again
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_ITEM]); // not duplicated
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    renderer.unmount();
  });
});

describe("useWorkspaceRuns — account isolation", () => {
  it("logout (user becomes null) resets to an unauthorized error state and clears items", async () => {
    let latest!: UseWorkspaceRunsResult;
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_ITEM]);

    mockedUseAuth.mockReturnValue({ user: null, loading: false, authReady: true });
    await act(async () => {
      renderer.update(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("unauthorized");
    expect(latest.items).toEqual([]);
    renderer.unmount();
  });

  it("CRITICAL: a UID switch never lets User A's stale, late-resolving response repopulate state for User B — proven by resolving A's request AFTER B has already loaded", async () => {
    let latest!: UseWorkspaceRunsResult;
    const pendingA = queuePendingResponse(RUNS_URL);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("loading"); // User A's request still in flight

    // Switch to User B before A's request resolves.
    mockedUseAuth.mockReturnValue({ user: { uid: "owner-2" }, loading: false, authReady: true });
    queueResponse(RUNS_URL, { ok: true, body: { ok: true, items: [{ ...SAMPLE_ITEM, id: "b-item" }], hasMore: false } });
    await act(async () => {
      renderer.update(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([{ ...SAMPLE_ITEM, id: "b-item" }]);

    // User A's request FINALLY resolves late.
    await act(async () => {
      pendingA.resolve({ ok: true, json: async () => ({ ok: true, items: [SAMPLE_ITEM], hasMore: false }) });
    });
    await flush();

    // Must still be User B's data — A's stale response must never have applied.
    expect(latest.items).toEqual([{ ...SAMPLE_ITEM, id: "b-item" }]);
    renderer.unmount();
  });
});
