/**
 * Phase 7C — `parseUnfiledRunsPageResponse()` / `isDefinitiveEmptyUnfiledState()`
 * (pure) plus the `useUnfiledRuns()` hook pagination/race/isolation matrix
 * and the client-side defense-in-depth `projectId === null` contract.
 * Structural mirror of `hooks/__tests__/useWorkspaceRuns.spec.ts`.
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

import { useUnfiledRuns, parseUnfiledRunsPageResponse, isDefinitiveEmptyUnfiledState } from "@/hooks/useUnfiledRuns";
import type { UseUnfiledRunsResult, ProjectRunSummary } from "@/hooks/useUnfiledRuns";

const SAMPLE_ITEM: ProjectRunSummary = { id: "run-1", at: "2026-08-15T00:00:00.000Z", question: "Q", selectedModels: ["chatgpt"], projectId: null };

describe("parseUnfiledRunsPageResponse (pure)", () => {
  it("real production success envelope -> success page", () => {
    const result = parseUnfiledRunsPageResponse({ ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "abc", scope: { type: "unfiled" } } });
    expect(result).toEqual({ ok: true, page: { items: [SAMPLE_ITEM], hasMore: true, nextCursor: "abc" } });
  });

  it("empty envelope -> success page with nextCursor undefined", () => {
    const result = parseUnfiledRunsPageResponse({ ok: true, body: { ok: true, items: [], hasMore: false } });
    expect(result).toEqual({ ok: true, page: { items: [], hasMore: false, nextCursor: undefined } });
  });

  it.each(["unauthorized", "auth_error", "projects_disabled", "workspace_unavailable", "workspace_invalid", "workspace_missing", "invalid_cursor", "internal_error"])(
    "known error code %s passes through unchanged",
    (errorCode) => {
      const result = parseUnfiledRunsPageResponse({ ok: false, body: { ok: false, errorCode, message: "x" } });
      expect(result).toEqual({ ok: false, errorCode });
    }
  );

  it("unrecognized errorCode -> falls back to internal_error", () => {
    expect(parseUnfiledRunsPageResponse({ ok: false, body: { ok: false, errorCode: "missing_scope" } })).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("malformed body -> error, never a guessed page", () => {
    expect(parseUnfiledRunsPageResponse({ ok: true, body: { ok: true } }).ok).toBe(false);
  });
});

describe("isDefinitiveEmptyUnfiledState (pure)", () => {
  it("ready + empty + hasMore:false -> true", () => {
    expect(isDefinitiveEmptyUnfiledState({ status: "ready", items: [], hasMore: false })).toBe(true);
  });
  it("ready + empty + hasMore:true -> false", () => {
    expect(isDefinitiveEmptyUnfiledState({ status: "ready", items: [], hasMore: true })).toBe(false);
  });
  it("loading -> false regardless of items/hasMore", () => {
    expect(isDefinitiveEmptyUnfiledState({ status: "loading", items: [], hasMore: false })).toBe(false);
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

function HookHost({ onResult }: { onResult: (r: UseUnfiledRunsResult) => void }) {
  const result = useUnfiledRuns();
  onResult(result);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const UNFILED_URL = "/api/user/project-runs?scope=unfiled";
function cursorUrl(cursor: string) {
  return `${UNFILED_URL}&cursor=${encodeURIComponent(cursor)}`;
}

beforeEach(() => {
  callLog.length = 0;
  deferredQueueByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

describe("useUnfiledRuns — always requests scope=unfiled, never projectId", () => {
  it("requests exactly /api/user/project-runs?scope=unfiled on initial load", async () => {
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: () => {} }));
    });
    await flush();
    expect(callLog).toContain(UNFILED_URL);
    expect(callLog.some((u) => u.includes("projectId"))).toBe(false);
    renderer.unmount();
  });
});

describe("useUnfiledRuns — initial load", () => {
  it("populated first page -> status ready, items set", async () => {
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c1" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.items).toEqual([SAMPLE_ITEM]);
    renderer.unmount();
  });

  it("initial failure -> status error, items stay empty (never fabricates 'no unfiled research')", async () => {
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: false, body: { ok: false, errorCode: "internal_error" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.status).toBe("error");
    expect(isDefinitiveEmptyUnfiledState(latest)).toBe(false);
    renderer.unmount();
  });
});

describe("useUnfiledRuns — MUTATION-TARGETED: projectId !== null contract (spec items 12/34/36-A/D)", () => {
  it("an item with a non-null projectId returned by the API is rejected client-side, never rendered as Unfiled, with a dev warning", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM, { ...SAMPLE_ITEM, id: "run-bad", projectId: "some-project" }], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items.map((i) => i.id)).toEqual(["run-1"]); // run-bad rejected
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    renderer.unmount();
  });

  it("an item with projectId undefined (legacy/missing-field shape) is also rejected, never silently reinterpreted as Unfiled", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let latest!: UseUnfiledRunsResult;
    const legacyShaped = { id: "run-legacy", at: SAMPLE_ITEM.at, question: "Q", selectedModels: [] } as unknown as ProjectRunSummary; // projectId field entirely absent
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [legacyShaped], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(latest.items).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    renderer.unmount();
  });

  it("a page of ALL rejected items still resolves to the definitive empty state (hasMore:false) rather than getting stuck", async () => {
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [{ ...SAMPLE_ITEM, projectId: "x" }], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();
    expect(isDefinitiveEmptyUnfiledState(latest)).toBe(true);
    renderer.unmount();
  });
});

describe("useUnfiledRuns — pagination", () => {
  it("a failed Load-more does NOT advance the cursor — retry re-sends the exact same cursor", async () => {
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "will-fail" } });
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

    queueResponse(cursorUrl("will-fail"), { ok: true, body: { ok: true, items: [], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog.filter((u) => u === cursorUrl("will-fail")).length).toBe(2);
    renderer.unmount();
  });

  it("PRECISION: nextCursor is passed back to the API exactly as received, never reconstructed client-side", async () => {
    let latest!: UseUnfiledRunsResult;
    const opaqueCursor = "eyJzIjoxNzIzNjAwMDAwLCJuIjoxMjM3ODkwMDAsImkiOiJydW4tMSJ9";
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: opaqueCursor } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl(opaqueCursor), { ok: true, body: { ok: true, items: [], hasMore: false } });
    await act(async () => {
      latest.loadMore();
    });
    await flush();
    expect(callLog).toContain(cursorUrl(opaqueCursor));
    renderer.unmount();
  });
});

describe("useUnfiledRuns — deduplication", () => {
  it("a duplicate id across pages is dropped defensively, with a dev warning", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: true, nextCursor: "c" } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

    queueResponse(cursorUrl("c"), { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } });
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

describe("useUnfiledRuns — account isolation", () => {
  it("logout resets to unauthorized error, clears items", async () => {
    let latest!: UseUnfiledRunsResult;
    queueResponse(UNFILED_URL, { ok: true, body: { ok: true, items: [SAMPLE_ITEM], hasMore: false } });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
    });
    await flush();

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
});
