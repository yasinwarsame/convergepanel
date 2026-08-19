/**
 * Phase 7E-B — `parseProjectRunsPageResponse()` / `isDefinitiveEmptyProjectRunsState()`
 * (pure) plus the `useProjectRuns(projectId)` hook pagination/race/isolation
 * matrix. Structural mirror of `hooks/__tests__/useUnfiledRuns.spec.ts`,
 * but with the materially stricter fail-WHOLE-page-closed integrity policy
 * (never per-item drop-and-continue) required by spec items 9/11/12/13.
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

import { useProjectRuns, parseProjectRunsPageResponse, isDefinitiveEmptyProjectRunsState } from "@/hooks/useProjectRuns";
import type { UseProjectRunsResult, ProjectRunSummary } from "@/hooks/useProjectRuns";

const PROJECT_ID = "proj-1";
const VALID_SCOPE = { type: "project", project: { id: PROJECT_ID, name: "My Project", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } } };
const SAMPLE_ITEM: ProjectRunSummary = { id: "run-1", at: "2026-08-15T00:00:00.000Z", question: "Q", selectedModels: ["chatgpt"], projectId: PROJECT_ID };

describe("parseProjectRunsPageResponse (pure)", () => {
  it("real production success envelope -> success page", () => {
    const result = parseProjectRunsPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "abc", scope: VALID_SCOPE }, expectedProjectId: PROJECT_ID });
    expect(result).toEqual({ ok: true, page: { items: [SAMPLE_ITEM], hasMore: true, nextCursor: "abc" } });
  });

  it("empty envelope -> success page with nextCursor undefined", () => {
    const result = parseProjectRunsPageResponse({ ok: true, body: { ok: true, items: [], hasMore: false, scope: VALID_SCOPE }, expectedProjectId: PROJECT_ID });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: false, nextCursor: undefined } });
  });

  it.each(["unauthorized", "auth_error", "projects_disabled", "project_not_found", "project_unavailable", "workspace_unavailable", "workspace_invalid", "workspace_missing", "invalid_cursor", "internal_error"])(
    "known error code %s passes through unchanged",
    (errorCode) => {
      const result = parseProjectRunsPageResponse({ ok: false, body: { ok: false, errorCode, message: "x" }, expectedProjectId: PROJECT_ID });
      expect(result).toEqual({ ok: false, errorCode });
    }
  );

  it("unrecognized errorCode -> falls back to internal_error", () => {
    expect(parseProjectRunsPageResponse({ ok: false, body: { ok: false, errorCode: "missing_scope" }, expectedProjectId: PROJECT_ID })).toEqual({ ok: false, errorCode: "internal_error" });
  });

  describe("MUTATION-TARGETED: scope envelope validation (spec item 11)", () => {
    it("scope missing entirely -> whole page rejected as internal_error", () => {
      const result = parseProjectRunsPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false }, expectedProjectId: PROJECT_ID });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });

    it("scope.type is 'unfiled' instead of 'project' -> whole page rejected", () => {
      const result = parseProjectRunsPageResponse({
        ok: true,
        body: { ok: true, items: [SAMPLE_ITEM], hasMore: false, scope: { type: "unfiled" } },
        expectedProjectId: PROJECT_ID,
      });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });

    it("scope.project.id !== requested projectId -> whole page rejected, even with otherwise-valid items", () => {
      const result = parseProjectRunsPageResponse({
        ok: true,
        body: { ok: true, items: [SAMPLE_ITEM], hasMore: false, scope: { ...VALID_SCOPE, project: { ...VALID_SCOPE.project, id: "proj-DIFFERENT" } } },
        expectedProjectId: PROJECT_ID,
      });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });

    it("scope.project malformed (missing name/status) -> whole page rejected", () => {
      const result = parseProjectRunsPageResponse({
        ok: true,
        body: { ok: true, items: [], hasMore: false, scope: { type: "project", project: { id: PROJECT_ID } } },
        expectedProjectId: PROJECT_ID,
      });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });
  });

  describe("MUTATION-TARGETED: per-item projectId invariant, whole page rejected (spec items 9/12/13)", () => {
    it("missing projectId field on one item -> whole page rejected, zero rows adopted", () => {
      const badItem = { id: "run-bad", at: SAMPLE_ITEM.at, question: "Q", selectedModels: [] } as unknown as ProjectRunSummary;
      const result = parseProjectRunsPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ITEM, badItem], hasMore: false, scope: VALID_SCOPE }, expectedProjectId: PROJECT_ID });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });

    it("null projectId on one item -> whole page rejected", () => {
      const result = parseProjectRunsPageResponse({
        ok: true,
        body: { ok: true, items: [SAMPLE_ITEM, { ...SAMPLE_ITEM, id: "run-bad", projectId: null }], hasMore: false, scope: VALID_SCOPE },
        expectedProjectId: PROJECT_ID,
      });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });

    it("different Project's id on one item -> whole page rejected — nine valid + one contradictory rejects all ten", () => {
      const nineValid = Array.from({ length: 9 }, (_, i) => ({ ...SAMPLE_ITEM, id: `run-${i}` }));
      const oneContradictory = { ...SAMPLE_ITEM, id: "run-bad", projectId: "proj-OTHER" };
      const result = parseProjectRunsPageResponse({
        ok: true,
        body: { ok: true, items: [...nineValid, oneContradictory], hasMore: false, scope: VALID_SCOPE },
        expectedProjectId: PROJECT_ID,
      });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });

    it("malformed projectId (non-string, non-null) -> whole page rejected", () => {
      const result = parseProjectRunsPageResponse({
        ok: true,
        body: { ok: true, items: [{ ...SAMPLE_ITEM, projectId: 42 }], hasMore: false, scope: VALID_SCOPE },
        expectedProjectId: PROJECT_ID,
      });
      expect(result).toEqual({ ok: false, errorCode: "internal_error" });
    });
  });
});

describe("isDefinitiveEmptyProjectRunsState (pure)", () => {
  it("ready + empty + hasMore:false -> true", () => {
    expect(isDefinitiveEmptyProjectRunsState({ status: "ready", items: [], hasMore: false })).toBe(true);
  });
  it("ready + empty + hasMore:true -> false", () => {
    expect(isDefinitiveEmptyProjectRunsState({ status: "ready", items: [], hasMore: true })).toBe(false);
  });
  it("loading -> false regardless of items/hasMore", () => {
    expect(isDefinitiveEmptyProjectRunsState({ status: "loading", items: [], hasMore: false })).toBe(false);
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

function HookHost({ projectId, onResult }: { projectId: string; onResult: (r: UseProjectRunsResult) => void }) {
  const result = useProjectRuns(projectId);
  onResult(result);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const PROJECT_URL = `/api/user/project-runs?projectId=${PROJECT_ID}`;
function cursorUrl(cursor: string) {
  return `${PROJECT_URL}&cursor=${encodeURIComponent(cursor)}`;
}

beforeEach(() => {
  callLog.length = 0;
  deferredQueueByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

describe("useProjectRuns — always requests exactly projectId, never scope=unfiled", () => {
  it("requests exactly /api/user/project-runs?projectId={id} on initial load", async () => {
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [], hasMore: false, scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: () => {} }));
    });
    await flush();
    expect(callLog).toContain(PROJECT_URL);
    expect(callLog.some((u) => u.includes("scope=unfiled"))).toBe(false);
    renderer.unmount();
  });
});

describe("useProjectRuns — initial load", () => {
  it("populated first page -> status ready, items set", async () => {
    let latest!: UseProjectRunsResult;
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c1", scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    renderer.unmount();
  });

  it("initial contradiction (bad scope) -> status error internal_error, zero rows adopted, never a fabricated empty state", async () => {
    let latest!: UseProjectRunsResult;
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false, scope: { type: "unfiled" } } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([]);
    expect(isDefinitiveEmptyProjectRunsState(latest)).toBe(false);
    renderer.unmount();
  });
});

describe("useProjectRuns — MUTATION-TARGETED: load-more contradiction preserves prior page (spec item 13)", () => {
  it("a contradictory load-more page contributes zero rows; prior valid rows and cursor are preserved; same cursor is retried", async () => {
    let latest!: UseProjectRunsResult;
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c1", scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_ITEM]);

    // Load-more page 2 is contradictory (wrong scope Project id).
    queueResponse(cursorUrl("c1"), {
      ok: true,
      body: { ok: true, items: [{ ...SAMPLE_ITEM, id: "run-2" }], hasMore: true, nextCursor: "c2", scope: { ...VALID_SCOPE, project: { ...VALID_SCOPE.project, id: "proj-OTHER" } } },
    });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.loadMoreErrorCode).toBe("internal_error");
    expect(latest.items).toEqual([SAMPLE_ITEM]); // prior valid page untouched, contradictory page contributed zero rows
    expect(latest.hasMore).toBe(true); // not silently flipped to false

    // Retry the SAME cursor, this time valid.
    queueResponse(cursorUrl("c1"), { ok: true, body: { ok: true, items: [{ ...SAMPLE_ITEM, id: "run-2" }], hasMore: false, scope: VALID_SCOPE } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items.map((i) => i.id)).toEqual(["run-1", "run-2"]);
    expect(callLog.filter((u) => u === cursorUrl("c1")).length).toBe(2);
    renderer.unmount();
  });
});

describe("useProjectRuns — pagination precision", () => {
  it("PRECISION: nextCursor is passed back to the API exactly as received, never reconstructed client-side", async () => {
    let latest!: UseProjectRunsResult;
    const opaqueCursor = "eyJzIjoxNzIzNjAwMDAwLCJuIjoxMjM3ODkwMDAsImkiOiJydW4tMSJ9";
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: opaqueCursor, scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl(opaqueCursor), { ok: true, body: { ok: true, items: [], hasMore: false, scope: VALID_SCOPE } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog).toContain(cursorUrl(opaqueCursor));
    renderer.unmount();
  });
});

describe("useProjectRuns — deduplication", () => {
  it("a duplicate id across pages is dropped defensively, with a dev warning", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let latest!: UseProjectRunsResult;
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c", scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("c"), { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false, scope: VALID_SCOPE } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    renderer.unmount();
  });
});

describe("useProjectRuns — account isolation", () => {
  it("logout resets to unauthorized error, clears items", async () => {
    let latest!: UseProjectRunsResult;
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false, scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();

    mockedUseAuth.mockReturnValue({ user: null, loading: false, authReady: true });
    await act(async () => {
      renderer.update(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(latest.initialErrorCode).toBe("unauthorized");
    expect(latest.items).toEqual([]);
    renderer.unmount();
  });
});

describe("useProjectRuns — empty Project state", () => {
  it("zero runs + hasMore:false -> definitive empty state", async () => {
    let latest!: UseProjectRunsResult;
    queueResponse(PROJECT_URL, { ok: true, body: { ok: true, items: [], hasMore: false, scope: VALID_SCOPE } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { projectId: PROJECT_ID, onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(isDefinitiveEmptyProjectRunsState(latest)).toBe(true);
    renderer.unmount();
  });
});
