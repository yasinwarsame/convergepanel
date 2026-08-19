/**
 * Phase 7E-A — `useRunProjectAssociation()` hook: exact request shape
 * against the already-production-proven `PATCH /api/user/runs/{runId}/project`,
 * `expectedProjectId` precision (never a Project `updateTime`, never
 * omitted), response-integrity validation, and per-run mutation locking.
 * Structural mirror of `hooks/__tests__/useProjectLifecycle.spec.ts`'s
 * `react-test-renderer` + deferred-promise harness — no jsdom.
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

import { useRunProjectAssociation } from "@/hooks/useRunProjectAssociation";
import type { UseRunProjectAssociationResult, RunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

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

function HookHost({ onResult }: { onResult: (r: UseRunProjectAssociationResult) => void }) {
  const result = useRunProjectAssociation();
  onResult(result);
  return null;
}

beforeEach(() => {
  callLog.length = 0;
  deferredQueueByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

async function mount(): Promise<{ latest: () => UseRunProjectAssociationResult; renderer: TestRenderer.ReactTestRenderer }> {
  let latest!: UseRunProjectAssociationResult;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return { latest: () => latest, renderer };
}

describe("useRunProjectAssociation — assign() request shape", () => {
  it("PATCH /api/user/runs/{runId}/project with body { projectId, expectedProjectId } exactly", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: true, body: { ok: true, runId: "run-1", projectId: "proj-1" } });
    let result!: RunProjectAssociationResult;
    await act(async () => {
      result = await latest().assign("run-1", "proj-1", null);
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe("/api/user/runs/run-1/project");
    expect(callLog[0].options.method).toBe("PATCH");
    const body = JSON.parse(callLog[0].options.body);
    expect(body).toEqual({ projectId: "proj-1", expectedProjectId: null });
    expect(result).toEqual({ status: "ok", runId: "run-1", projectId: "proj-1" });
  });

  it("percent-encodes the run id in the URL", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run%20with%20spaces/project", { ok: true, body: { ok: true, runId: "run with spaces", projectId: "proj-1" } });
    await act(async () => {
      await latest().assign("run with spaces", "proj-1", null);
    });
    expect(callLog[0].url).toBe("/api/user/runs/run%20with%20spaces/project");
  });

  it("NEVER sends Project updateTime/expectedUpdateTime — that token belongs to Project lifecycle OCC, not run association", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: true, body: { ok: true, runId: "run-1", projectId: "proj-1" } });
    await act(async () => {
      await latest().assign("run-1", "proj-1", null);
    });
    const body = JSON.parse(callLog[0].options.body);
    expect(body.updateTime).toBeUndefined();
    expect(body.expectedUpdateTime).toBeUndefined();
  });

  it("NEVER sends uid/workspaceId — only the two allowed keys", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: true, body: { ok: true, runId: "run-1", projectId: "proj-1" } });
    await act(async () => {
      await latest().assign("run-1", "proj-1", null);
    });
    const body = JSON.parse(callLog[0].options.body);
    expect(Object.keys(body).sort()).toEqual(["expectedProjectId", "projectId"]);
  });

  it("expectedProjectId is sent exactly as given, including a non-null value verbatim (future Move shape) — never coerced", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: true, body: { ok: true, runId: "run-1", projectId: "proj-2" } });
    await act(async () => {
      await latest().assign("run-1", "proj-2", "proj-1");
    });
    const body = JSON.parse(callLog[0].options.body);
    expect(body.expectedProjectId).toBe("proj-1");
  });
});

describe("useRunProjectAssociation — response-integrity validation", () => {
  it("a response naming a different runId is rejected as internal_error — never adopted", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: true, body: { ok: true, runId: "run-DIFFERENT", projectId: "proj-1" } });
    let result!: RunProjectAssociationResult;
    await act(async () => {
      result = await latest().assign("run-1", "proj-1", null);
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("a response naming a different resulting projectId is rejected as internal_error — never adopted", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: true, body: { ok: true, runId: "run-1", projectId: "proj-DIFFERENT" } });
    let result!: RunProjectAssociationResult;
    await act(async () => {
      result = await latest().assign("run-1", "proj-1", null);
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("server error code passes through (e.g. project_archived)", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: false, body: { ok: false, errorCode: "project_archived" } });
    let result!: RunProjectAssociationResult;
    await act(async () => {
      result = await latest().assign("run-1", "proj-1", null);
    });
    expect(result).toEqual({ status: "error", errorCode: "project_archived" });
  });

  it("unrecognized server error code collapses to internal_error", async () => {
    const { latest } = await mount();
    queueResponse("/api/user/runs/run-1/project", { ok: false, body: { ok: false, errorCode: "something_new" } });
    let result!: RunProjectAssociationResult;
    await act(async () => {
      result = await latest().assign("run-1", "proj-1", null);
    });
    expect(result).toEqual({ status: "error", errorCode: "internal_error" });
  });

  it("network exception maps to network_error", async () => {
    const { latest } = await mount();
    authedFetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    let result!: RunProjectAssociationResult;
    await act(async () => {
      result = await latest().assign("run-1", "proj-1", null);
    });
    expect(result).toEqual({ status: "error", errorCode: "network_error" });
  });
});

describe("useRunProjectAssociation — MUTATION-TARGETED: per-run locking", () => {
  it("isRunBusy is true only while an assignment for that exact run is in flight", async () => {
    const { latest } = await mount();
    const deferred = queuePendingResponse("/api/user/runs/run-1/project");
    expect(latest().isRunBusy("run-1")).toBe(false);

    let pending!: Promise<RunProjectAssociationResult>;
    act(() => {
      pending = latest().assign("run-1", "proj-1", null);
    });
    expect(latest().isRunBusy("run-1")).toBe(true);

    await act(async () => {
      deferred.resolve({ ok: true, json: async () => ({ ok: true, runId: "run-1", projectId: "proj-1" }) });
      await pending;
    });
    expect(latest().isRunBusy("run-1")).toBe(false);
  });

  it("a rapid duplicate call for the SAME run while one is in flight is rejected before dispatch — exactly one PATCH fires", async () => {
    const { latest } = await mount();
    const deferred = queuePendingResponse("/api/user/runs/run-1/project");

    let first!: Promise<RunProjectAssociationResult>;
    let second!: RunProjectAssociationResult;
    act(() => {
      first = latest().assign("run-1", "proj-1", null);
    });
    await act(async () => {
      second = await latest().assign("run-1", "proj-2", null);
    });
    expect(second).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog).toHaveLength(1); // the duplicate never reached authedFetch

    await act(async () => {
      deferred.resolve({ ok: true, json: async () => ({ ok: true, runId: "run-1", projectId: "proj-1" }) });
      await first;
    });
  });

  it("a DIFFERENT run remains independently operable while another run's assignment is in flight", async () => {
    const { latest } = await mount();
    queuePendingResponse("/api/user/runs/run-1/project");
    queueResponse("/api/user/runs/run-2/project", { ok: true, body: { ok: true, runId: "run-2", projectId: "proj-1" } });

    act(() => {
      void latest().assign("run-1", "proj-1", null);
    });
    expect(latest().isRunBusy("run-1")).toBe(true);
    expect(latest().isRunBusy("run-2")).toBe(false);

    let resultForRun2!: RunProjectAssociationResult;
    await act(async () => {
      resultForRun2 = await latest().assign("run-2", "proj-1", null);
    });
    expect(resultForRun2).toEqual({ status: "ok", runId: "run-2", projectId: "proj-1" });
  });
});
