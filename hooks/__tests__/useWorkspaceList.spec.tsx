/**
 * Phase 11B.5 — `useWorkspaceList` lifecycle, exercised through a real rendered
 * hook harness with `react-test-renderer` (this repo's established convention —
 * no jsdom, no Testing Library, and none is added for this phase).
 *
 * `fetchWorkspaceList` is mocked; the hook itself is NOT. Mocking the hook would
 * leave its pagination, dedupe, abort and generation logic untested, which is
 * the entire reason this file exists.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedFetchWorkspaceList = jest.fn();
jest.mock("@/lib/client/workspaceListClient", () => ({
  fetchWorkspaceList: (...args: unknown[]) => mockedFetchWorkspaceList(...args),
}));

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

import { useWorkspaceList, type UseWorkspaceListResult } from "@/hooks/useWorkspaceList";

const page = (
  items: { workspaceId: string; name: string }[],
  over: { hasMore?: boolean; nextCursor?: string | null } = {}
) => ({ status: "ok" as const, page: { items, hasMore: false, nextCursor: null, ...over } });

/** Harness capturing the hook's latest return value. */
function mountHook() {
  const seen: UseWorkspaceListResult[] = [];
  function Probe() {
    seen.push(useWorkspaceList());
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  return {
    renderer,
    latest: () => seen[seen.length - 1],
    /** Re-render with whatever useAuth now returns (simulates an auth transition). */
    rerender: () => act(() => { renderer.update(createElement(Probe)); }),
  };
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: "uid_alice" }, authReady: true });
});

describe("useWorkspaceList — single page", () => {
  it("signed out: idle, no items, no request", async () => {
    mockedUseAuth.mockReturnValue({ user: null, authReady: true });
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("idle");
    expect(h.latest().items).toEqual([]);
    expect(mockedFetchWorkspaceList).not.toHaveBeenCalled();
  });

  it("auth not ready: idle, no request", async () => {
    mockedUseAuth.mockReturnValue({ user: { uid: "uid_alice" }, authReady: false });
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("idle");
    expect(mockedFetchWorkspaceList).not.toHaveBeenCalled();
  });

  it("zero memberships: ready with an empty list — not an error", async () => {
    mockedFetchWorkspaceList.mockResolvedValue(page([]));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("ready");
    expect(h.latest().items).toEqual([]);
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(1);
  });

  it("one page: ready, exactly one request, cursor starts null", async () => {
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_7x2", name: "Acme Risk Lab" }]));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("ready");
    expect(h.latest().items).toEqual([{ workspaceId: "ws_7x2", name: "Acme Risk Lab" }]);
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(1);
    expect(mockedFetchWorkspaceList.mock.calls[0][0]).toMatchObject({ cursor: null });
  });

  it("total failure with nothing established: error, empty items", async () => {
    mockedFetchWorkspaceList.mockResolvedValue({ status: "error" });
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("error");
    expect(h.latest().items).toEqual([]);
  });
});

describe("useWorkspaceList — pagination", () => {
  it("pages until hasMore is false: 21 memberships, 2 requests, second carries the first cursor", async () => {
    const first = Array.from({ length: 20 }, (_, i) => ({ workspaceId: `ws_${i}`, name: `Workspace ${i}` }));
    mockedFetchWorkspaceList
      .mockResolvedValueOnce(page(first, { hasMore: true, nextCursor: "c20" }))
      .mockResolvedValueOnce(page([{ workspaceId: "ws_20", name: "Workspace 20" }]));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("ready");
    expect(h.latest().items).toHaveLength(21);
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(2);
    expect(mockedFetchWorkspaceList.mock.calls[1][0]).toMatchObject({ cursor: "c20" });
  });

  it("deduplicates a workspaceId repeated across pages, preserving first server order", async () => {
    mockedFetchWorkspaceList
      .mockResolvedValueOnce(page([{ workspaceId: "ws_a", name: "A" }, { workspaceId: "ws_b", name: "B" }], { hasMore: true, nextCursor: "c1" }))
      .mockResolvedValueOnce(page([{ workspaceId: "ws_a", name: "A (dupe)" }, { workspaceId: "ws_c", name: "C" }]));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().items.map((i) => i.workspaceId)).toEqual(["ws_a", "ws_b", "ws_c"]);
    expect(h.latest().items[0].name).toBe("A"); // first occurrence wins
  });

  it("NO PAGE CEILING: a membership beyond 50 pages is still reachable — the server read model guarantees reachability through pagination and the client must not reintroduce a cap", async () => {
    // 60 pages of 20 plus a final short page: 1201 memberships. A 50-page client
    // bound would make everything past page 50 permanently unselectable, and
    // retry() restarts at page one so partial_error offers no continuation.
    const PAGES = 60;
    for (let p = 0; p < PAGES; p++) {
      const items = Array.from({ length: 20 }, (_, i) => ({ workspaceId: `ws_${p}_${i}`, name: `Workspace ${p}-${i}` }));
      mockedFetchWorkspaceList.mockResolvedValueOnce(page(items, { hasMore: true, nextCursor: `c_${p}` }));
    }
    mockedFetchWorkspaceList.mockResolvedValueOnce(page([{ workspaceId: "ws_last", name: "The Final Workspace" }]));

    const h = mountHook();
    await act(async () => {});

    expect(h.latest().status).toBe("ready");
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(PAGES + 1);
    expect(h.latest().items).toHaveLength(PAGES * 20 + 1);
    // the one that a 50-page ceiling would have hidden
    expect(h.latest().items.map((i) => i.workspaceId)).toContain("ws_last");
    expect(h.latest().items[h.latest().items.length - 1]).toEqual({ workspaceId: "ws_last", name: "The Final Workspace" });
  });

  it("STRUCTURAL: the paging loop carries no numeric bound at all — a behavioural test can only prove 'no ceiling below my fixture size', never 'no ceiling'", () => {
    // Deliberately a source assertion, and deliberately narrow. The test above
    // proves 61 pages are reachable, but any finite fixture is satisfied by a
    // ceiling just above it, so the reachability invariant
    // (`listViewerTeamWorkspaces`: "no fixed cap silently truncates a uid's real
    // membership set") needs the ABSENCE of a bound stated directly. This fails
    // if anyone reintroduces one at any magnitude.
    const source = readFileSync(join(__dirname, "..", "useWorkspaceList.ts"), "utf8");
    const loop = source.slice(source.indexOf("for (;;)"), source.indexOf("cursor = nextCursor;"));
    expect(source).toContain("for (;;) {");
    expect(source).not.toMatch(/for \(let page\b/);
    expect(source).not.toMatch(/MAX_PAGES/);
    // no numeric comparison acting as a page bound inside the loop header or body
    expect(loop).not.toMatch(/page\s*<\s*\d+/);
    expect(loop).not.toMatch(/\bpage\+\+/);
  });

  it("partial failure keeps verified items and reports partial_error — never 'ready'", async () => {
    mockedFetchWorkspaceList
      .mockResolvedValueOnce(page([{ workspaceId: "ws_a", name: "A" }], { hasMore: true, nextCursor: "c1" }))
      .mockResolvedValueOnce({ status: "error" });
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("partial_error");
    expect(h.latest().items).toEqual([{ workspaceId: "ws_a", name: "A" }]);
  });

  it("hasMore true with a NULL cursor stops instead of looping", async () => {
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_a", name: "A" }], { hasMore: true, nextCursor: null }));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("partial_error");
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(1);
  });

  it("a REPEATED cursor stops instead of looping forever", async () => {
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_a", name: "A" }], { hasMore: true, nextCursor: "same" }));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("partial_error");
    // page 1 consumes "same", page 2 sees it already consumed and stops
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(2);
  });
});

describe("useWorkspaceList — identity lifecycle", () => {
  it("aborts the in-flight request on unmount", async () => {
    const d = deferred<unknown>();
    mockedFetchWorkspaceList.mockReturnValue(d.promise);
    const h = mountHook();
    const signal = mockedFetchWorkspaceList.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => { h.renderer.unmount(); });
    expect(signal.aborted).toBe(true);
  });

  it("aborts the previous uid's request and clears its items immediately on a uid change", async () => {
    const d = deferred<unknown>();
    mockedFetchWorkspaceList.mockReturnValue(d.promise);
    const h = mountHook();
    const firstSignal = mockedFetchWorkspaceList.mock.calls[0][0].signal as AbortSignal;

    mockedUseAuth.mockReturnValue({ user: { uid: "uid_bob" }, authReady: true });
    mockedFetchWorkspaceList.mockReturnValue(deferred<unknown>().promise);
    h.rerender();

    expect(firstSignal.aborted).toBe(true);
    expect(h.latest().items).toEqual([]);
  });

  it("GENERATION GUARD: a late response belonging to the PREVIOUS uid is discarded, even though it resolves last", async () => {
    const alice = deferred<unknown>();
    mockedFetchWorkspaceList.mockReturnValueOnce(alice.promise);
    const h = mountHook();

    // switch identity; bob resolves first
    mockedUseAuth.mockReturnValue({ user: { uid: "uid_bob" }, authReady: true });
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_beta", name: "Beta Workspace" }]));
    h.rerender();
    await act(async () => {});
    expect(h.latest().items).toEqual([{ workspaceId: "ws_beta", name: "Beta Workspace" }]);

    // ...then alice's request resolves LATE. Abort alone would not save us here:
    // this promise is already settled, so only the generation check can reject it.
    await act(async () => {
      alice.resolve(page([{ workspaceId: "ws_7x2", name: "Acme Risk Lab" }]));
      await alice.promise;
    });

    expect(h.latest().items).toEqual([{ workspaceId: "ws_beta", name: "Beta Workspace" }]);
    expect(JSON.stringify(h.latest().items)).not.toContain("Acme Risk Lab");
  });

  it("a dead generation STOPS PAGING: after a uid change, the old lifecycle issues no further page requests even when its first page resolves late", async () => {
    // alice's page 1 says hasMore, so a lifecycle with no post-await generation
    // check would go on to request page 2 for an identity that is gone.
    const alicePage1 = deferred<unknown>();
    mockedFetchWorkspaceList.mockReturnValueOnce(alicePage1.promise);
    const h = mountHook();
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(1);

    mockedUseAuth.mockReturnValue({ user: { uid: "uid_bob" }, authReady: true });
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_beta", name: "Beta Workspace" }]));
    h.rerender();
    await act(async () => {});

    const callsBefore = mockedFetchWorkspaceList.mock.calls.length;
    await act(async () => {
      alicePage1.resolve(page([{ workspaceId: "ws_7x2", name: "Acme Risk Lab" }], { hasMore: true, nextCursor: "alice_c1" }));
      await alicePage1.promise;
    });

    // no page-2 request was issued for the abandoned identity
    expect(mockedFetchWorkspaceList.mock.calls.length).toBe(callsBefore);
    expect(mockedFetchWorkspaceList.mock.calls.every((c) => c[0].cursor !== "alice_c1")).toBe(true);
    expect(h.latest().items).toEqual([{ workspaceId: "ws_beta", name: "Beta Workspace" }]);
  });

  it("logout clears items and returns to idle", async () => {
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_a", name: "A" }]));
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().items).toHaveLength(1);

    mockedUseAuth.mockReturnValue({ user: null, authReady: true });
    h.rerender();
    expect(h.latest().items).toEqual([]);
    expect(h.latest().status).toBe("idle");
  });

  it("retry() re-runs the lifecycle for the same uid", async () => {
    mockedFetchWorkspaceList.mockResolvedValueOnce({ status: "error" });
    const h = mountHook();
    await act(async () => {});
    expect(h.latest().status).toBe("error");

    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_a", name: "A" }]));
    await act(async () => { h.latest().retry(); });
    await act(async () => {});
    expect(h.latest().status).toBe("ready");
    expect(h.latest().items).toHaveLength(1);
  });

  it("does NOT refetch when an unrelated auth re-render changes the user OBJECT but not the uid", async () => {
    mockedFetchWorkspaceList.mockResolvedValue(page([{ workspaceId: "ws_a", name: "A" }]));
    const h = mountHook();
    await act(async () => {});
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(1);

    mockedUseAuth.mockReturnValue({ user: { uid: "uid_alice" }, authReady: true }); // new object, same uid
    h.rerender();
    await act(async () => {});
    expect(mockedFetchWorkspaceList).toHaveBeenCalledTimes(1);
  });
});
