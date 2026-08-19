/**
 * Phase 7D — `useProjectLifecycle()` hook: request shape (exact URL/method/
 * body per operation), OCC token pass-through precision, response-integrity
 * validation, and per-Project mutation locking. Structural mirror of
 * `hooks/__tests__/useProjects.spec.ts`'s `react-test-renderer` + `act()` +
 * deferred-promise harness — no jsdom.
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
const deferredQueueByUrl = new Map<string, Deferred[]>();
const authedFetchMock = jest.fn((url: string, options: any) => {
  callLog.push({ url, options });
  const queue = deferredQueueByUrl.get(url) ?? [];
  const deferred = queue.shift() ?? createDeferred();
  deferredQueueByUrl.set(url, queue);
  return deferred.promise;
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, any]) => authedFetchMock(...args),
}));

import { useProjectLifecycle } from "@/hooks/useProjectLifecycle";
import type { UseProjectLifecycleResult, ProjectMutationResult } from "@/hooks/useProjectLifecycle";
import type { ProjectSummary } from "@/hooks/useProjects";

const TOKEN = { seconds: 1723600000, nanoseconds: 123_456_789 };
const FRESH_TOKEN = { seconds: 1723600100, nanoseconds: 987_654_321 };

const PROJECT: ProjectSummary = {
  id: "proj-1",
  name: "My Project",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  updateTime: TOKEN,
};

const ARCHIVED_PROJECT: ProjectSummary = { ...PROJECT, id: "proj-2", status: "archived" };

function freshDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT.id,
    name: PROJECT.name,
    status: "active",
    createdAt: PROJECT.createdAt,
    updatedAt: "2026-08-01T00:05:00.000Z",
    updateTime: FRESH_TOKEN,
    ...overrides,
  };
}

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

function HookHost({ onResult }: { onResult: (r: UseProjectLifecycleResult) => void }) {
  const result = useProjectLifecycle();
  onResult(result);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

beforeEach(() => {
  callLog.length = 0;
  deferredQueueByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

async function mount(): Promise<{ latest: () => UseProjectLifecycleResult; renderer: TestRenderer.ReactTestRenderer }> {
  let latest!: UseProjectLifecycleResult;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return { latest: () => latest, renderer };
}

describe("useProjectLifecycle — createProject request shape", () => {
  it("POST /api/user/projects with body { name } only — no client uid/workspaceId/createdByUserId", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects", { ok: true, body: { ok: true, project: freshDto({ id: "new-1" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe("/api/user/projects");
    expect(callLog[0].options.method).toBe("POST");
    const body = JSON.parse(callLog[0].options.body);
    expect(body).toEqual({ name: "New Project" });
    expect(body.uid).toBeUndefined();
    expect(body.workspaceId).toBeUndefined();
    expect(body.createdByUserId).toBeUndefined();
    expect(result).toEqual({ status: "ok", project: expect.objectContaining({ id: "new-1" }) });
  });

  it("SECURITY: a create response with status=archived is rejected as internal_error — never adopted", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects", { ok: true, body: { ok: true, project: freshDto({ status: "archived" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("server error code passes through (e.g. invalid_project_name)", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects", { ok: false, body: { ok: false, errorCode: "invalid_project_name" } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("");
    });
    expect(result).toEqual({ status: "error", errorCode: "invalid_project_name" });
  });

  it("network exception maps to network_error", async () => {
    const { latest } = await mount();
    authedFetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().createProject("New Project");
    });
    expect(result).toEqual({ status: "error", errorCode: "network_error" });
  });
});

describe("useProjectLifecycle — renameProject request shape + OCC precision", () => {
  it("PATCH /api/user/projects/{id} with body { name, expectedUpdateTime } — token passed through byte-exact, never reconstructed", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1", { ok: true, body: { ok: true, project: freshDto() } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().renameProject(PROJECT, "Renamed");
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe("/api/user/projects/proj-1");
    expect(callLog[0].options.method).toBe("PATCH");
    const body = JSON.parse(callLog[0].options.body);
    expect(body.name).toBe("Renamed");
    // PRECISION: the exact seconds+nanoseconds, not truncated/reconstructed.
    expect(body.expectedUpdateTime).toEqual(TOKEN);
    expect(body.expectedUpdateTime.nanoseconds).toBe(123_456_789);
    expect(result).toEqual({ status: "ok", project: expect.objectContaining({ updateTime: FRESH_TOKEN }) });
  });

  it("the response's fresh updateTime is exactly what's adopted — a subsequent caller would send THAT token, not the original", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1", { ok: true, body: { ok: true, project: freshDto() } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().renameProject(PROJECT, "Renamed");
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.project.updateTime).toEqual(FRESH_TOKEN);
      expect(result.project.updateTime).not.toEqual(TOKEN);
    }
  });

  it("SECURITY: rename response with the wrong id is rejected", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1", { ok: true, body: { ok: true, project: freshDto({ id: "someone-else" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().renameProject(PROJECT, "Renamed");
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("SECURITY: rename response that silently changes status is rejected", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1", { ok: true, body: { ok: true, project: freshDto({ status: "archived" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().renameProject(PROJECT, "Renamed");
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("stale 409 conflict passes through as errorCode, never auto-retried", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1", { ok: false, body: { ok: false, errorCode: "conflict" } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().renameProject(PROJECT, "Renamed");
    });
    expect(result).toEqual({ status: "error", errorCode: "conflict" });
    expect(callLog).toHaveLength(1); // exactly one request — no automatic retry
  });

  it("rename works for an archived Project (rename is status-independent)", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-2", { ok: true, body: { ok: true, project: freshDto({ id: "proj-2", status: "archived" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().renameProject(ARCHIVED_PROJECT, "Renamed");
    });
    expect(result.status).toBe("ok");
  });
});

describe("useProjectLifecycle — archiveProject", () => {
  it("POST /api/user/projects/{id}/archive with body { expectedUpdateTime } only", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1/archive", { ok: true, body: { ok: true, project: freshDto({ status: "archived" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().archiveProject(PROJECT);
    });
    expect(callLog[0].url).toBe("/api/user/projects/proj-1/archive");
    expect(callLog[0].options.method).toBe("POST");
    const body = JSON.parse(callLog[0].options.body);
    expect(body).toEqual({ expectedUpdateTime: TOKEN });
    expect(result).toEqual({ status: "ok", project: expect.objectContaining({ status: "archived" }) });
  });

  it("SECURITY: archive success whose returned status is still active is rejected", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1/archive", { ok: true, body: { ok: true, project: freshDto({ status: "active" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().archiveProject(PROJECT);
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("invalid_project_status_transition (already archived) passes through, never treated as success", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-1/archive", { ok: false, body: { ok: false, errorCode: "invalid_project_status_transition" } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().archiveProject(PROJECT);
    });
    expect(result).toEqual({ status: "error", errorCode: "invalid_project_status_transition" });
  });
});

describe("useProjectLifecycle — restoreProject", () => {
  it("POST /api/user/projects/{id}/restore with body { expectedUpdateTime } only", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-2/restore", { ok: true, body: { ok: true, project: freshDto({ id: "proj-2", status: "active" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().restoreProject(ARCHIVED_PROJECT);
    });
    expect(callLog[0].url).toBe("/api/user/projects/proj-2/restore");
    expect(callLog[0].options.method).toBe("POST");
    const body = JSON.parse(callLog[0].options.body);
    expect(body).toEqual({ expectedUpdateTime: TOKEN });
    expect(result).toEqual({ status: "ok", project: expect.objectContaining({ status: "active" }) });
  });

  it("SECURITY: restore success whose returned status is still archived is rejected", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/projects/proj-2/restore", { ok: true, body: { ok: true, project: freshDto({ id: "proj-2", status: "archived" }) } });
    let result!: ProjectMutationResult;
    await act(async () => {
      result = await latest().restoreProject(ARCHIVED_PROJECT);
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });
});

describe("useProjectLifecycle — MUTATION-TARGETED: per-Project locking (spec items 18/19/37)", () => {
  it("a second archive call for the SAME Project while the first is in flight is rejected up front — never dispatches a second request", async () => {
    const { latest } = await mount();
    const pending = queuePendingResponse("/api/user/projects/proj-1/archive");

    let firstPromise!: Promise<ProjectMutationResult>;
    await act(async () => {
      firstPromise = latest().archiveProject(PROJECT);
    });
    await flush();
    expect(latest().isProjectBusy("proj-1")).toBe(true);

    let secondResult!: ProjectMutationResult;
    await act(async () => {
      secondResult = await latest().archiveProject(PROJECT);
    });
    expect(secondResult).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog.filter((c) => c.url === "/api/user/projects/proj-1/archive").length).toBe(1); // only the first request ever dispatched

    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto({ status: "archived" }) }) });
    });
    const firstResult = await firstPromise;
    expect(firstResult.status).toBe("ok");
    expect(latest().isProjectBusy("proj-1")).toBe(false); // lock released after completion
  });

  it("rename and archive for the SAME Project cannot both be in flight — the second (archive) is rejected while rename is outstanding", async () => {
    const { latest } = await mount();
    const pendingRename = queuePendingResponse("/api/user/projects/proj-1");

    let renamePromise!: Promise<ProjectMutationResult>;
    await act(async () => {
      renamePromise = latest().renameProject(PROJECT, "New Name");
    });
    await flush();

    let archiveResult!: ProjectMutationResult;
    await act(async () => {
      archiveResult = await latest().archiveProject(PROJECT);
    });
    expect(archiveResult).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog.filter((c) => c.url === "/api/user/projects/proj-1/archive").length).toBe(0); // never dispatched

    await act(async () => {
      pendingRename.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto() }) });
    });
    await renamePromise;
  });

  it("mutations for DIFFERENT Projects proceed independently — no cross-Project blocking", async () => {
    const { latest } = await mount();
    const pendingA = queuePendingResponse("/api/user/projects/proj-1/archive");
    queueResponse("/api/user/projects/proj-2/restore", { ok: true, body: { ok: true, project: freshDto({ id: "proj-2", status: "active" }) } });

    let archivePromise!: Promise<ProjectMutationResult>;
    await act(async () => {
      archivePromise = latest().archiveProject(PROJECT);
    });
    await flush();
    expect(latest().isProjectBusy("proj-1")).toBe(true);
    expect(latest().isProjectBusy("proj-2")).toBe(false);

    let restoreResult!: ProjectMutationResult;
    await act(async () => {
      restoreResult = await latest().restoreProject(ARCHIVED_PROJECT);
    });
    expect(restoreResult.status).toBe("ok"); // proj-2's own mutation succeeded independently

    await act(async () => {
      pendingA.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto({ status: "archived" }) }) });
    });
    await archivePromise;
  });

  it("rapid duplicate create submissions: only one request dispatches", async () => {
    const { latest } = await mount();
    const pending = queuePendingResponse("/api/user/projects");

    let firstPromise!: Promise<ProjectMutationResult>;
    let secondPromise!: Promise<ProjectMutationResult>;
    await act(async () => {
      // Both calls happen synchronously within the same tick — the lock is
      // acquired synchronously (before any await) inside the first call, so
      // by the time the second call runs, the lock is already held.
      firstPromise = latest().createProject("A");
      secondPromise = latest().createProject("A");
    });
    await flush();

    // Exactly one of the two calls actually dispatched a request; the other
    // was rejected synchronously by the lock, before ever reaching authedFetch.
    expect(callLog.filter((c) => c.url === "/api/user/projects").length).toBe(1);

    const secondResult = await secondPromise;
    expect(secondResult).toEqual({ status: "error", errorCode: "internal_error" });

    await act(async () => {
      pending.resolve({ ok: true, json: async () => ({ ok: true, project: freshDto({ id: "new-1" }) }) });
    });
    const firstResult = await firstPromise;
    expect(firstResult.status).toBe("ok");
  });
});
