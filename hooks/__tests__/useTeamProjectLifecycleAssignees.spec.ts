/**
 * Project/Research Assignment — `useTeamProjectLifecycle().setAssignees()`:
 * exact request (the row's OWN native token, the raw uid list), the shared
 * per-Project lock, DTO validation (assignees required), and the three
 * assignment-only error codes mapping through.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));
const callLog: { url: string; options: any }[] = [];
const authedFetchMock = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...args: [string, any]) => authedFetchMock(...args) }));

import { useTeamProjectLifecycle, buildSetTeamProjectAssigneesRequest, type UseTeamProjectLifecycleResult } from "@/hooks/useTeamProjectLifecycle";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

const WS_ID = "ws-1";
const TOKEN = { seconds: 7, nanoseconds: 3 };
const PROJECT: TeamProjectSummary = { id: "p 1", workspaceId: WS_ID, name: "P", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: TOKEN, assignees: [] };
const dto = (overrides: Record<string, unknown> = {}) => ({ ...PROJECT, updateTime: { seconds: 8, nanoseconds: 0 }, assignees: [{ uid: "m1", displayName: "Bao", state: "active" }], ...overrides });

function HookHost({ onResult }: { onResult: (r: UseTeamProjectLifecycleResult) => void }) {
  onResult(useTeamProjectLifecycle({ workspaceId: WS_ID }));
  return null;
}
async function mount() {
  let latest!: UseTeamProjectLifecycleResult;
  await act(async () => {
    TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return () => latest;
}
const respond = (body: unknown, ok = true) =>
  authedFetchMock.mockImplementationOnce((url: string, options: any) => {
    callLog.push({ url, options });
    return Promise.resolve({ ok, json: async () => body });
  });

beforeEach(() => {
  callLog.length = 0;
  authedFetchMock.mockReset();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, authReady: true });
});

it("POSTs to .../projects/{id}/assignees with body EXACTLY {assigneeUids, expectedUpdateTime: the row's native token} — never updatedAt", async () => {
  expect(buildSetTeamProjectAssigneesRequest({ workspaceId: WS_ID, projectId: "p 1", assigneeUids: ["m1"], expectedUpdateTime: TOKEN })).toEqual({ url: "/api/workspaces/ws-1/projects/p%201/assignees", body: JSON.stringify({ assigneeUids: ["m1"], expectedUpdateTime: TOKEN }) });
  respond({ ok: true, changed: true, project: dto() });
  const latest = await mount();
  let r: unknown;
  await act(async () => {
    r = await latest().setAssignees(PROJECT, ["m1"]);
  });
  expect(callLog[0].url).toBe("/api/workspaces/ws-1/projects/p%201/assignees");
  expect(callLog[0].options.method).toBe("POST");
  expect(JSON.parse(callLog[0].options.body)).toEqual({ assigneeUids: ["m1"], expectedUpdateTime: TOKEN });
  expect(r).toEqual({ status: "ok", project: expect.objectContaining({ id: "p 1", assignees: [{ uid: "m1", displayName: "Bao", state: "active" }] }) });
});

it("updateTime: null ⇒ NO request, invalid_update_time", async () => {
  const latest = await mount();
  let r: unknown;
  await act(async () => {
    r = await latest().setAssignees({ ...PROJECT, updateTime: null }, ["m1"]);
  });
  expect(r).toEqual({ status: "error", errorCode: "invalid_update_time" });
  expect(authedFetchMock).not.toHaveBeenCalled();
});

it("shares the per-Project lock with archive: while setAssignees is in flight, archive for the SAME Project sends nothing and the busy operation reads set_assignees", async () => {
  let release!: (v: unknown) => void;
  authedFetchMock.mockImplementationOnce((url: string, options: any) => {
    callLog.push({ url, options });
    return new Promise((res) => (release = res));
  });
  const latest = await mount();
  let p!: Promise<unknown>;
  act(() => {
    p = latest().setAssignees(PROJECT, ["m1"]);
  });
  expect(latest().isProjectBusy("p 1")).toBe(true);
  expect(latest().getBusyOperation("p 1")).toBe("set_assignees");
  let second: unknown;
  await act(async () => {
    second = await latest().archiveProject(PROJECT);
  });
  expect(second).toEqual({ status: "error", errorCode: "internal_error" });
  expect(callLog).toHaveLength(1);
  release({ ok: true, json: async () => ({ ok: true, project: dto() }) });
  await act(async () => {
    await p;
  });
  expect(latest().isProjectBusy("p 1")).toBe(false);
});

it("DTO validation: a 2xx whose project lacks a valid `assignees` array, names another Project, or is archived ⇒ internal_error", async () => {
  const latest = await mount();
  for (const bad of [dto({ assignees: undefined }), dto({ assignees: [{ uid: "m1" }] }), dto({ id: "other" }), dto({ status: "archived" })]) {
    respond({ ok: true, project: bad });
    let r: unknown;
    await act(async () => {
      r = await latest().setAssignees(PROJECT, ["m1"]);
    });
    expect(r).toEqual({ status: "error", errorCode: "internal_error" });
  }
});

it.each(["assignee_not_eligible", "too_many_assignees", "project_archived", "conflict", "insufficient_capability"])("server code %s maps through unchanged", async (code) => {
  respond({ ok: false, errorCode: code }, false);
  const latest = await mount();
  let r: unknown;
  await act(async () => {
    r = await latest().setAssignees(PROJECT, ["m1"]);
  });
  expect(r).toEqual({ status: "error", errorCode: code });
});
