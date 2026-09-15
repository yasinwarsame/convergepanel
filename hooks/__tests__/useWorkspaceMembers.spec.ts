/** Project/Research Assignment — `useWorkspaceMembers()`: the extracted member fetcher (enabled gating, stale-response guard, error state, reload). */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));
const mockedFetchWorkspaceMembers = jest.fn();
jest.mock("@/lib/client/workspaceTeamClient", () => ({ fetchWorkspaceMembers: (...a: unknown[]) => mockedFetchWorkspaceMembers(...a) }));

import { useWorkspaceMembers, type UseWorkspaceMembersResult } from "@/hooks/useWorkspaceMembers";

const MEMBER = { uid: "m1", displayName: "Bao", role: "member", isCanonicalOwner: false, joinedAt: "x", updateTimeToken: { seconds: 1, nanoseconds: 0 } };
function Host({ enabled, onResult }: { enabled: boolean; onResult: (r: UseWorkspaceMembersResult) => void }) {
  onResult(useWorkspaceMembers({ workspaceId: "ws-1", enabled }));
  return null;
}
async function mount(enabled = true) {
  let latest!: UseWorkspaceMembersResult;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Host, { enabled, onResult: (r) => (latest = r) }));
  });
  return { latest: () => latest, renderer };
}

beforeEach(() => {
  mockedFetchWorkspaceMembers.mockReset();
  mockedUseAuth.mockReturnValue({ user: { uid: "u" }, authReady: true });
});

it("loads through the shared client function once and exposes members + the Workspace token", async () => {
  mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [MEMBER], workspaceUpdateToken: { seconds: 5, nanoseconds: 0 } });
  const { latest } = await mount();
  expect(mockedFetchWorkspaceMembers).toHaveBeenCalledTimes(1);
  expect(mockedFetchWorkspaceMembers).toHaveBeenCalledWith({ user: { uid: "u" }, authReady: true, workspaceId: "ws-1" });
  expect(latest().status).toBe("ready");
  expect(latest().members).toEqual([MEMBER]);
  expect(latest().workspaceUpdateToken).toEqual({ seconds: 5, nanoseconds: 0 });
});

it("enabled: false issues NO request and stays idle", async () => {
  const { latest } = await mount(false);
  expect(mockedFetchWorkspaceMembers).not.toHaveBeenCalled();
  expect(latest().status).toBe("idle");
});

it("error ⇒ status error with an empty list; reload() re-fetches", async () => {
  mockedFetchWorkspaceMembers.mockResolvedValueOnce({ status: "error" }).mockResolvedValueOnce({ status: "ok", members: [MEMBER], workspaceUpdateToken: { seconds: 1, nanoseconds: 0 } });
  const { latest } = await mount();
  expect(latest().status).toBe("error");
  expect(latest().members).toEqual([]);
  await act(async () => {
    latest().reload();
  });
  expect(latest().status).toBe("ready");
  expect(mockedFetchWorkspaceMembers).toHaveBeenCalledTimes(2);
});

it("a stale (superseded) response never overwrites a newer one", async () => {
  let resolveFirst!: (v: unknown) => void;
  mockedFetchWorkspaceMembers.mockImplementationOnce(() => new Promise((res) => (resolveFirst = res))).mockResolvedValueOnce({ status: "ok", members: [MEMBER], workspaceUpdateToken: { seconds: 2, nanoseconds: 0 } });
  const { latest } = await mount();
  await act(async () => {
    latest().reload();
  });
  expect(latest().members).toEqual([MEMBER]);
  await act(async () => {
    resolveFirst({ status: "ok", members: [], workspaceUpdateToken: { seconds: 1, nanoseconds: 0 } });
  });
  expect(latest().members).toEqual([MEMBER]);
});
