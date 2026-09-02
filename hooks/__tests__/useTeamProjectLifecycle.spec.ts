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
