/**
 * Phase 7C — `parseProjectsListPageResponse()` / `isDefinitiveEmptyProjectsState()`
 * (pure) plus the `useProjects()` hook pagination/race/isolation matrix.
 * Structural mirror of `hooks/__tests__/useWorkspaceRuns.spec.ts` — same
 * `react-test-renderer` + `act()` + deferred-promise harness, no jsdom.
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
  const deferred = queue.shift() ?? createDeferred();
  deferredQueueByUrl.set(url, queue);
  return deferred.promise;
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, unknown]) => authedFetchMock(...args),
}));

import { useProjects, parseProjectsListPageResponse, isDefinitiveEmptyProjectsState } from "@/hooks/useProjects";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";
import { ActiveProjectsSection } from "@/components/projects/ActiveProjectsSection";

const SAMPLE_PROJECT: ProjectSummary = { id: "proj-1", name: "Project One", status: "active", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
const SAMPLE_ARCHIVED_PROJECT: ProjectSummary = { id: "proj-9", name: "Archived One", status: "archived", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };

describe("parseProjectsListPageResponse (pure)", () => {
  it("real production success envelope -> success page", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "abc" }, expectedStatus: "active" });
    expect(result).toEqual({ ok: true, page: { items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "abc" } });
  });

  it("empty envelope (items:[], hasMore:false, no nextCursor key) -> success page with nextCursor undefined", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [], hasMore: false }, expectedStatus: "active" });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: false, nextCursor: undefined } });
  });

  it("items:[] with hasMore:true and a nextCursor is a valid success page, not an error", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "next" }, expectedStatus: "active" });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: true, nextCursor: "next" } });
  });

  it.each(["unauthorized", "auth_error", "projects_disabled", "invalid_status", "workspace_unavailable", "workspace_invalid", "workspace_missing", "invalid_cursor", "internal_error"])(
    "known error code %s passes through unchanged",
    (errorCode) => {
      const result = parseProjectsListPageResponse({ ok: false, body: { ok: false, errorCode, message: "x" }, expectedStatus: "active" });
      expect(result).toEqual({ ok: false, errorCode });
    }
  );

  it("unrecognized errorCode -> falls back to internal_error", () => {
    const result = parseProjectsListPageResponse({ ok: false, body: { ok: false, errorCode: "some_new_future_code" }, expectedStatus: "active" });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("malformed body (ok:true HTTP but body.items missing) -> error, never a guessed page", () => {
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true }, expectedStatus: "active" }).ok).toBe(false);
  });

  it("null body never throws", () => {
    expect(() => parseProjectsListPageResponse({ ok: true, body: null, expectedStatus: "active" })).not.toThrow();
  });
});

describe("parseProjectsListPageResponse — MUTATION-TARGETED: status-scope integrity (Phase 7C.1, spec items 2/6/7)", () => {
  it("active request + all-active rows -> success", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false }, expectedStatus: "active" });
    expect(result).toEqual({ ok: true, page: { items: [SAMPLE_PROJECT], hasMore: false, nextCursor: undefined } });
  });

  it("archived request + all-archived rows -> success", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ARCHIVED_PROJECT], hasMore: false }, expectedStatus: "archived" });
    expect(result).toEqual({ ok: true, page: { items: [SAMPLE_ARCHIVED_PROJECT], hasMore: false, nextCursor: undefined } });
  });

  it("SECURITY: active request + an archived row -> internal_error, the archived row is never rendered", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ARCHIVED_PROJECT], hasMore: false }, expectedStatus: "active" });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("SECURITY: archived request + an active row -> internal_error, the active row is never rendered", () => {
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false }, expectedStatus: "archived" });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("SECURITY: a mixed-status page (active P1, archived P2, active P3) rejects the WHOLE page — P2 is never silently omitted while P1/P3 render", () => {
    const p1 = { ...SAMPLE_PROJECT, id: "p1" };
    const p2 = { ...SAMPLE_ARCHIVED_PROJECT, id: "p2" };
    const p3 = { ...SAMPLE_PROJECT, id: "p3" };
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [p1, p2, p3], hasMore: false }, expectedStatus: "active" });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("SECURITY: same mixed-status contradiction rejected for an archived-scoped request", () => {
    const p1 = { ...SAMPLE_ARCHIVED_PROJECT, id: "p1" };
    const p2 = { ...SAMPLE_PROJECT, id: "p2" };
    const result = parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [p1, p2], hasMore: false }, expectedStatus: "archived" });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("a structurally malformed item (missing id, missing name, non-string status) is rejected the same way as a status mismatch", () => {
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [{ name: "no id", status: "active" }], hasMore: false }, expectedStatus: "active" }).ok).toBe(false);
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [{ id: "x", status: "active" }], hasMore: false }, expectedStatus: "active" }).ok).toBe(false);
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [{ id: "x", name: "n", status: 123 }], hasMore: false }, expectedStatus: "active" }).ok).toBe(false);
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [{ id: "", name: "n", status: "active" }], hasMore: false }, expectedStatus: "active" }).ok).toBe(false); // empty-string id rejected
  });

  it("an empty items array is vacuously valid regardless of expectedStatus (nothing to contradict)", () => {
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [], hasMore: false }, expectedStatus: "active" }).ok).toBe(true);
    expect(parseProjectsListPageResponse({ ok: true, body: { ok: true, items: [], hasMore: false }, expectedStatus: "archived" }).ok).toBe(true);
  });
});

describe("isDefinitiveEmptyProjectsState (pure)", () => {
  it("status ready, items=[], hasMore=false -> true", () => {
    expect(isDefinitiveEmptyProjectsState({ status: "ready", items: [], hasMore: false })).toBe(true);
  });
  it("status ready, items=[], hasMore=true -> false", () => {
    expect(isDefinitiveEmptyProjectsState({ status: "ready", items: [], hasMore: true })).toBe(false);
  });
  it("status loading, items=[], hasMore=false -> false", () => {
    expect(isDefinitiveEmptyProjectsState({ status: "loading", items: [], hasMore: false })).toBe(false);
  });
  it("status error, items=[], hasMore=false -> false", () => {
    expect(isDefinitiveEmptyProjectsState({ status: "error", items: [], hasMore: false })).toBe(false);
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

function HookHost({ status, onResult }: { status: "active" | "archived"; onResult: (r: UseProjectsResult) => void }) {
  const result = useProjects({ status });
  onResult(result);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const ACTIVE_URL = "/api/user/projects?status=active";
const ARCHIVED_URL = "/api/user/projects?status=archived";
function cursorUrl(base: string, cursor: string) {
  return `${base}&cursor=${encodeURIComponent(cursor)}`;
}

beforeEach(() => {
  callLog.length = 0;
  deferredQueueByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

describe("useProjects — status param determines the exact endpoint requested", () => {
  it("status:'active' -> requests ?status=active", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(callLog).toContain(ACTIVE_URL);
    expect(callLog).not.toContain(ARCHIVED_URL);
    expect(latest.items).toEqual([SAMPLE_PROJECT]);
    renderer.unmount();
  });

  it("status:'archived' -> requests ?status=archived, independently of an active-status hook", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ARCHIVED_URL, { ok: true, body: { ok: true, items: [], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "archived", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(callLog).toContain(ARCHIVED_URL);
    expect(callLog).not.toContain(ACTIVE_URL);
    renderer.unmount();
  });
});

describe("useProjects — initial load", () => {
  it("populated first page -> status ready, items set, hasMore/nextCursor adopted", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "c1" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.items).toEqual([SAMPLE_PROJECT]);
    expect(latest.hasMore).toBe(true);
    renderer.unmount();
  });

  it("first page items=[] hasMore=false -> definitive empty condition holds", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(isDefinitiveEmptyProjectsState(latest)).toBe(true);
    renderer.unmount();
  });

  it("initial failure -> status error, initialErrorCode set, items stay empty (never fabricates 'no active projects yet')", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: false, body: { ok: false, errorCode: "internal_error" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("internal_error");
    expect(isDefinitiveEmptyProjectsState(latest)).toBe(false);
    renderer.unmount();
  });
});

describe("useProjects — pagination", () => {
  it("cursor resume: second page continues from the first, no duplicates, no skips", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "c2" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl(ACTIVE_URL, "c2"), { ok: true, body: { ok: true, items: [{ ...SAMPLE_PROJECT, id: "proj-2" }], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items.map((i) => i.id)).toEqual(["proj-1", "proj-2"]);
    expect(latest.hasMore).toBe(false);
    renderer.unmount();
  });

  it("a failed Load-more does NOT advance the cursor — retry re-sends the exact same cursor", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "will-fail" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl(ACTIVE_URL, "will-fail"), { ok: false, body: { ok: false, errorCode: "internal_error" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadMoreErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([SAMPLE_PROJECT]);

    queueResponse(cursorUrl(ACTIVE_URL, "will-fail"), { ok: true, body: { ok: true, items: [], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog.filter((u) => u === cursorUrl(ACTIVE_URL, "will-fail")).length).toBe(2);
    expect(latest.loadMoreErrorCode).toBeNull();
    renderer.unmount();
  });

  it("intermediate empty continuation page (items:[], hasMore:true) never renders the empty-state condition and forward progress continues", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [], hasMore: true, nextCursor: "p2" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(isDefinitiveEmptyProjectsState(latest)).toBe(false); // hasMore true -> never "empty"

    queueResponse(cursorUrl(ACTIVE_URL, "p2"), { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_PROJECT]);
    renderer.unmount();
  });
});

describe("useProjects — MUTATION-TARGETED, full hook: status-scope integrity end-to-end (Phase 7C.1, spec items 3/7/8)", () => {
  it("initial page containing a status-mismatched row -> status error, internal_error, zero rows adopted, no empty-state fabrication", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_ARCHIVED_PROJECT], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([]);
    expect(isDefinitiveEmptyProjectsState(latest)).toBe(false); // never fabricates "No active projects yet."
    renderer.unmount();
  });

  it("Load-more integrity: page 1 valid active P1 (hasMore:true), page 2 returns an archived row -> P1 stays rendered, P2 never adopted, loadMoreErrorCode=internal_error, cursor from page 1 remains authoritative, retry re-sends the same cursor", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "page1-cursor" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_PROJECT]);

    // Page 2 is well-formed (ok:true, items array, hasMore boolean) but
    // contains an archived row inside an active-scoped request.
    queueResponse(cursorUrl(ACTIVE_URL, "page1-cursor"), { ok: true, body: { ok: true, items: [SAMPLE_ARCHIVED_PROJECT], hasMore: true, nextCursor: "should-never-be-adopted" } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadMoreErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([SAMPLE_PROJECT]); // P1 preserved; the archived row never adopted
    expect(latest.hasMore).toBe(true); // untouched from page 1's own value

    // Retry must re-request page 1's own cursor, never the malformed
    // page's "should-never-be-adopted" cursor.
    queueResponse(cursorUrl(ACTIVE_URL, "page1-cursor"), { ok: true, body: { ok: true, items: [{ ...SAMPLE_PROJECT, id: "proj-2" }], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog.filter((u) => u === cursorUrl(ACTIVE_URL, "page1-cursor")).length).toBe(2); // failed attempt + retry, same cursor both times
    expect(callLog).not.toContain(cursorUrl(ACTIVE_URL, "should-never-be-adopted"));
    expect(latest.items.map((i) => i.id)).toEqual(["proj-1", "proj-2"]);
    expect(latest.loadMoreErrorCode).toBeNull();
    renderer.unmount();
  });
});

describe("useProjects — deduplication", () => {
  it("a duplicate id across pages is dropped defensively, with a dev warning", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "c" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl(ACTIVE_URL, "c"), { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_PROJECT]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    renderer.unmount();
  });
});

describe("useProjects — account isolation", () => {
  it("logout (user becomes null) resets to an unauthorized error state and clears items", async () => {
    let latest!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_PROJECT]);

    mockedUseAuth.mockReturnValue({ user: null, loading: false, authReady: true });
    await act(async () => {
      renderer.update(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("unauthorized");
    expect(latest.items).toEqual([]);
    renderer.unmount();
  });

  it("CRITICAL: a UID switch never lets a stale, late-resolving response repopulate state for the new user", async () => {
    let latest!: UseProjectsResult;
    const pendingA = queuePendingResponse(ACTIVE_URL);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("loading");

    mockedUseAuth.mockReturnValue({ user: { uid: "owner-2" }, loading: false, authReady: true });
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [{ ...SAMPLE_PROJECT, id: "b-project" }], hasMore: false } });
    await act(async () => {
      renderer.update(createElement(HookHost, { status: "active", onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([{ ...SAMPLE_PROJECT, id: "b-project" }]);

    await act(async () => {
      pendingA.resolve({ ok: true, json: async () => ({ ok: true, items: [SAMPLE_PROJECT], hasMore: false }) });
    });
    await flush();
    expect(latest.items).toEqual([{ ...SAMPLE_PROJECT, id: "b-project" }]); // A's stale response never applied
    renderer.unmount();
  });
});

describe("useProjects — MUTATION-TARGETED: two simultaneous instances (Active + Archived, mirroring ProjectsShell) never share pagination state (spec item 19/36-G)", () => {
  function DualHost({ onActive, onArchived }: { onActive: (r: UseProjectsResult) => void; onArchived: (r: UseProjectsResult) => void }) {
    const active = useProjects({ status: "active" });
    const archived = useProjects({ status: "archived" });
    onActive(active);
    onArchived(archived);
    return null;
  }

  it("calling loadMore() on the Active instance never advances or affects the Archived instance's cursor/items/loadingMore", async () => {
    let latestActive!: UseProjectsResult;
    let latestArchived!: UseProjectsResult;
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: true, nextCursor: "active-c2" } });
    queueResponse(ARCHIVED_URL, { ok: true, body: { ok: true, items: [{ ...SAMPLE_PROJECT, id: "archived-1", status: "archived" }], hasMore: true, nextCursor: "archived-c2" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(DualHost, {
          onActive: (r) => (latestActive = r),
          onArchived: (r) => (latestArchived = r),
        })
      );
    });
    await flush();
    expect(latestActive.items.map((i) => i.id)).toEqual(["proj-1"]);
    expect(latestArchived.items.map((i) => i.id)).toEqual(["archived-1"]);

    // Load more on Active ONLY — must request Active's own cursor, never
    // Archived's, and must never mutate Archived's state.
    queueResponse(cursorUrl(ACTIVE_URL, "active-c2"), { ok: true, body: { ok: true, items: [{ ...SAMPLE_PROJECT, id: "proj-2" }], hasMore: false } });
    await act(async () => {
      latestActive.loadMore();
    });
    await flush();

    expect(callLog).toContain(cursorUrl(ACTIVE_URL, "active-c2"));
    expect(callLog).not.toContain(cursorUrl(ARCHIVED_URL, "active-c2")); // proves the cursor is not shared cross-endpoint
    expect(latestActive.items.map((i) => i.id)).toEqual(["proj-1", "proj-2"]);
    // Archived's own state must be completely untouched by Active's loadMore.
    expect(latestArchived.items.map((i) => i.id)).toEqual(["archived-1"]);
    expect(latestArchived.hasMore).toBe(true);
    expect(latestArchived.loadingMore).toBe(false);
    renderer.unmount();
  });
});

describe("ActiveProjectsSection through the REAL useProjects()/parseProjectsListPageResponse() path (Phase 7C.1 spec item 9) — no independent filtering added to the component itself; the parser boundary is what protects it", () => {
  function ActiveSectionHost() {
    const result = useProjects({ status: "active" });
    return createElement(ActiveProjectsSection, { result });
  }

  it("a response containing an archived Project never renders that Project's name, even though the component performs no status filtering of its own", async () => {
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_ARCHIVED_PROJECT], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(ActiveSectionHost));
    });
    await flush();
    const html = JSON.stringify(renderer.toJSON());
    expect(html).not.toContain(SAMPLE_ARCHIVED_PROJECT.name);
    expect(html).toContain("Try again"); // section-local error, not a fabricated empty state
    renderer.unmount();
  });

  it("a genuinely all-active response renders normally through the same real path", async () => {
    queueResponse(ACTIVE_URL, { ok: true, body: { ok: true, items: [SAMPLE_PROJECT], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(ActiveSectionHost));
    });
    await flush();
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain(SAMPLE_PROJECT.name);
    renderer.unmount();
  });
});
