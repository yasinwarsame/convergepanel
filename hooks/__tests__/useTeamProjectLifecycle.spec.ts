/**
 * Team Projects UI, Phase 12A.2 — `useTeamProjectLifecycle()` hook:
 * request shape (exact URL/method/body), single-flight guard, and
 * response validation — including the Team-specific nuance this hook
 * exists to handle correctly: `updateTime: null` (a post-mutation
 * projection-read failure) must still be accepted as a genuine success,
 * unlike Personal's `validateProjectMutationDto()`, which rejects it.
 * `react-test-renderer` + `act()` `HookHost` pattern, mirroring
 * `hooks/__tests__/useProjectLifecycle.spec.ts`.
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

const callLog: { url: string; options: any }[] = [];
const authedFetchMock = jest.fn((url: string, options: any) => {
  callLog.push({ url, options });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, project: {} }) });
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, any]) => authedFetchMock(...args),
}));

import { useTeamProjectLifecycle } from "@/hooks/useTeamProjectLifecycle";
import type { UseTeamProjectLifecycleResult, TeamProjectMutationResult } from "@/hooks/useTeamProjectLifecycle";

const WS_ID = "ws-1";

function freshDto(overrides: Record<string, unknown> = {}) {
  return {
    id: "new-1",
    workspaceId: WS_ID,
    name: "New Project",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updateTime: { seconds: 1, nanoseconds: 0 },
    ...overrides,
  };
}

function HookHost({ onResult }: { onResult: (r: UseTeamProjectLifecycleResult) => void }) {
  const result = useTeamProjectLifecycle({ workspaceId: WS_ID });
  onResult(result);
  return null;
}

async function mount(): Promise<{ latest: () => UseTeamProjectLifecycleResult }> {
  let latest!: UseTeamProjectLifecycleResult;
  await act(async () => {
    TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return { latest: () => latest };
}

beforeEach(() => {
  callLog.length = 0;
  authedFetchMock.mockClear();
  authedFetchMock.mockImplementation((url: string, options: any) => {
    callLog.push({ url, options });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto() }) });
  });
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, authReady: true });
});

describe("useTeamProjectLifecycle — createProject request shape", () => {
  it("POST /api/workspaces/{workspaceId}/projects with body { name } only", async () => {
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe(`/api/workspaces/${WS_ID}/projects`);
    expect(callLog[0].options.method).toBe("POST");
    expect(JSON.parse(callLog[0].options.body)).toEqual({ name: "New Project" });
    expect(result).toEqual({ status: "ok", project: expect.objectContaining({ id: "new-1", workspaceId: WS_ID }) });
  });

  it("CRITICAL — updateTime: null (post-mutation projection-read failure) is accepted as a genuine success, not internal_error", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto({ updateTime: null }) }) });
    });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.project.updateTime).toBeNull();
    }
  });

  it("a response whose project.workspaceId doesn't match the requested Workspace is rejected as internal_error", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto({ workspaceId: "some-other-workspace" }) }) });
    });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("a response whose project.status isn't 'active' (a freshly created Project can never be archived) is rejected", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto({ status: "archived" }) }) });
    });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("a non-ok HTTP response with a known errorCode maps through directly", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.resolve({ ok: false, json: async () => ({ ok: false, errorCode: "too_many_projects" }) });
    });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result).toEqual({ status: "error", errorCode: "too_many_projects" });
  });

  it("a thrown fetch maps to network_error, never throws out of the hook", async () => {
    authedFetchMock.mockImplementation(() => {
      throw new Error("network down");
    });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result).toEqual({ status: "error", errorCode: "network_error" });
  });

  it("isCreating is true only while a create request is in flight", async () => {
    let resolveResponse!: (v: unknown) => void;
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    const { latest } = await mount();
    expect(latest().isCreating).toBe(false);

    let pending!: Promise<TeamProjectMutationResult>;
    await act(async () => {
      pending = latest().createProject("New Project");
    });
    expect(latest().isCreating).toBe(true);

    await act(async () => {
      resolveResponse({ ok: true, json: async () => ({ ok: true, project: freshDto() }) });
      await pending;
    });
    expect(latest().isCreating).toBe(false);
  });
});

describe("useTeamProjectLifecycle — archive/restore, Phase PROJECT-UI-AR-I1", () => {
  const TOKEN = { seconds: 1723600000, nanoseconds: 123_456_789 };
  const ACTIVE = { id: "proj-1", workspaceId: WS_ID, name: "P", status: "active" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: TOKEN };
  const ARCHIVED = { ...ACTIVE, id: "proj-2", status: "archived" as const };
  const deferredQueueByUrl = new Map<string, Deferred[]>();
  function queuePending(url: string): Deferred {
    const d = createDeferred();
    deferredQueueByUrl.set(url, [...(deferredQueueByUrl.get(url) ?? []), d]);
    return d;
  }
  function respond(body: unknown, ok = true) {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      const queued = deferredQueueByUrl.get(url)?.shift();
      if (queued) return queued.promise as Promise<any>;
      return Promise.resolve({ ok, json: async () => body });
    });
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => {
    deferredQueueByUrl.clear();
  });

  it("D. archive: POST to the exact archive route with body EXACTLY { expectedUpdateTime: <the row's native updateTime> } — never updatedAt, never a generated timestamp", async () => {
    respond({ ok: true, project: { ...ACTIVE, status: "archived", updateTime: { seconds: 2, nanoseconds: 0 } } });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().archiveProject(ACTIVE);
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe(`/api/workspaces/${WS_ID}/projects/proj-1/archive`);
    expect(callLog[0].options.method).toBe("POST");
    expect(JSON.parse(callLog[0].options.body)).toEqual({ expectedUpdateTime: TOKEN });
    expect(result).toEqual({ status: "ok", project: expect.objectContaining({ id: "proj-1", status: "archived", updateTime: { seconds: 2, nanoseconds: 0 } }) });
  });

  it("E. restore: POST to the exact restore route with the archived row's exact token", async () => {
    respond({ ok: true, project: { ...ARCHIVED, status: "active", updateTime: { seconds: 3, nanoseconds: 1 } } });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().restoreProject(ARCHIVED);
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe(`/api/workspaces/${WS_ID}/projects/proj-2/restore`);
    expect(JSON.parse(callLog[0].options.body)).toEqual({ expectedUpdateTime: TOKEN });
    expect(result.status).toBe("ok");
  });

  it("updateTime: null -> NO request is sent for archive or restore; a safe invalid_update_time result is returned instead", async () => {
    respond({ ok: true, project: ACTIVE });
    const { latest } = await mount();
    let a!: TeamProjectMutationResult;
    let r!: TeamProjectMutationResult;
    await act(async () => {
      a = await latest().archiveProject({ ...ACTIVE, updateTime: null });
      r = await latest().restoreProject({ ...ARCHIVED, updateTime: null });
    });
    expect(callLog).toHaveLength(0);
    expect(a).toEqual({ status: "error", errorCode: "invalid_update_time" });
    expect(r).toEqual({ status: "error", errorCode: "invalid_update_time" });
  });

  it("projectionUnavailable (2xx, project.updateTime: null) is a COMMITTED success — returned as ok, never as an error, never retried", async () => {
    respond({ ok: true, project: { ...ACTIVE, status: "archived", updateTime: null }, projectionUnavailable: true });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().archiveProject(ACTIVE);
    });
    expect(callLog).toHaveLength(1);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.project.updateTime).toBeNull();
  });

  it("response validation: wrong id, wrong workspace, or a status that does not match the requested transition is rejected as internal_error", async () => {
    const { latest } = await mount();
    for (const bad of [{ ...ACTIVE, status: "archived", id: "someone-else" }, { ...ACTIVE, status: "archived", workspaceId: "ws-other" }, { ...ACTIVE, status: "active" }]) {
      callLog.length = 0;
      respond({ ok: true, project: bad });
      let result!: TeamProjectMutationResult;
      await act(async () => {
        result = await latest().archiveProject(ACTIVE);
      });
      expect(result).toEqual({ status: "error", errorCode: "internal_error" });
    }
  });

  it.each([
    [403, "insufficient_capability", "insufficient_capability"],
    [404, "team_workspace_not_found", "team_workspace_not_found"],
    [404, "project_not_found", "project_not_found"],
    [409, "invalid_project_status_transition", "invalid_project_status_transition"],
    [409, "conflict", "conflict"],
    [401, "unauthorized", "unauthorized"],
    [500, "internal_error", "internal_error"],
    [418, "something_new", "internal_error"],
  ])("error mapping: HTTP %s %s -> %s, exactly one request, no retry", async (_status, serverCode, expected) => {
    respond({ ok: false, errorCode: serverCode }, false);
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().archiveProject(ACTIVE);
    });
    expect(callLog).toHaveLength(1);
    expect(result).toEqual({ status: "error", errorCode: expected });
    expect(latest().isProjectBusy("proj-1")).toBe(false); // lock released on handled failure
  });

  it("F. per-Project lock: a second archive for the SAME Project while the first is in flight sends NO request; the lock is observable and released after completion", async () => {
    respond({ ok: true, project: ACTIVE });
    const { latest } = await mount();
    const pending = queuePending(`/api/workspaces/${WS_ID}/projects/proj-1/archive`);
    let firstPromise!: Promise<TeamProjectMutationResult>;
    await act(async () => {
      firstPromise = latest().archiveProject(ACTIVE);
    });
    await flush();
    expect(latest().isProjectBusy("proj-1")).toBe(true);
    expect(latest().getBusyOperation("proj-1")).toBe("archive");
    let second!: TeamProjectMutationResult;
    await act(async () => {
      second = await latest().archiveProject(ACTIVE);
    });
    expect(second).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog.filter((c) => c.url.endsWith("/proj-1/archive"))).toHaveLength(1);
    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ ok: true, project: { ...ACTIVE, status: "archived" } }) });
    });
    expect((await firstPromise).status).toBe("ok");
    expect(latest().isProjectBusy("proj-1")).toBe(false);
  });

  it("archive then immediate restore for the SAME Project before the first response: the restore is refused without a request", async () => {
    respond({ ok: true, project: ACTIVE });
    const { latest } = await mount();
    const pending = queuePending(`/api/workspaces/${WS_ID}/projects/proj-1/archive`);
    await act(async () => {
      void latest().archiveProject(ACTIVE);
    });
    await flush();
    let restore!: TeamProjectMutationResult;
    await act(async () => {
      restore = await latest().restoreProject({ ...ACTIVE, status: "archived" });
    });
    expect(restore).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog).toHaveLength(1);
    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ ok: true, project: { ...ACTIVE, status: "archived" } }) });
    });
  });

  it("unrelated Projects are independently mutable while one is busy", async () => {
    respond({ ok: true, project: { ...ARCHIVED, status: "active" } });
    const { latest } = await mount();
    const pending = queuePending(`/api/workspaces/${WS_ID}/projects/proj-1/archive`);
    await act(async () => {
      void latest().archiveProject(ACTIVE);
    });
    await flush();
    let other!: TeamProjectMutationResult;
    await act(async () => {
      other = await latest().restoreProject(ARCHIVED);
    });
    expect(other.status).toBe("ok");
    expect(callLog.map((c) => c.url)).toEqual([`/api/workspaces/${WS_ID}/projects/proj-1/archive`, `/api/workspaces/${WS_ID}/projects/proj-2/restore`]);
    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ ok: true, project: { ...ACTIVE, status: "archived" } }) });
    });
  });

  it("the lock is released after a thrown fetch (network_error) too", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.reject(new Error("offline"));
    });
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().restoreProject(ARCHIVED);
    });
    expect(result).toEqual({ status: "error", errorCode: "network_error" });
    expect(latest().isProjectBusy("proj-2")).toBe(false);
  });

  it("create still maps the two Team-route denials distinctly (403 insufficient_capability is no longer collapsed into internal_error)", async () => {
    respond({ ok: false, errorCode: "insufficient_capability" }, false);
    const { latest } = await mount();
    let result!: TeamProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("X");
    });
    expect(result).toEqual({ status: "error", errorCode: "insufficient_capability" });
  });
});

