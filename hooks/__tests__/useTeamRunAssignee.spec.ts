/**
 * Project/Research Assignment — `useTeamRunAssignee()`: exact request shape
 * (path ids only, body EXACTLY {assigneeUid, expectedAssigneeUid}), the
 * per-run lock, GET-response validation, and closed error mapping.
 * `react-test-renderer` + `act()` `HookHost` pattern.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
function createDeferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}
const callLog: { url: string; options: any }[] = [];
const queue: Array<{ deferred?: Deferred; value?: unknown }> = [];
const authedFetchMock = jest.fn((url: string, options: any) => {
  callLog.push({ url, options });
  const next = queue.shift();
  if (next?.deferred) return next.deferred.promise;
  return Promise.resolve(next?.value ?? { ok: true, json: async () => ({ ok: true, changed: true, runId: "r1", workspaceId: "ws 1", assigneeUid: "m1" }) });
});
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...args: [string, any]) => authedFetchMock(...args) }));

import { useTeamRunAssignee, buildSetTeamRunAssigneeRequest, mapTeamRunAssigneeErrorCode, type UseTeamRunAssigneeResult } from "@/hooks/useTeamRunAssignee";

const respond = (ok: boolean, body: unknown) => queue.push({ value: { ok, json: async () => body } });
const pending = () => {
  const d = createDeferred();
  queue.push({ deferred: d });
  return d;
};
function HookHost({ onResult }: { onResult: (r: UseTeamRunAssigneeResult) => void }) {
  onResult(useTeamRunAssignee({ workspaceId: "ws 1" }));
  return null;
}
function mountHook() {
  let latest!: UseTeamRunAssigneeResult;
  act(() => {
    TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return () => latest;
}
const URL = "/api/workspaces/ws%201/runs/r%2F1/assignee";

beforeEach(() => {
  callLog.length = 0;
  queue.length = 0;
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

describe("request shape", () => {
  it("PATCHes the path-addressed run with EXACTLY {assigneeUid, expectedAssigneeUid} — ids come from the path, never the body", async () => {
    expect(buildSetTeamRunAssigneeRequest({ workspaceId: "ws 1", runId: "r/1", assigneeUid: null, expectedAssigneeUid: "m1" })).toEqual({ url: URL, body: JSON.stringify({ assigneeUid: null, expectedAssigneeUid: "m1" }) });
    respond(true, { ok: true, changed: true, runId: "r/1", workspaceId: "ws 1", assigneeUid: "m2" });
    const hook = mountHook();
    await act(async () => {
      await hook().setRunAssignee({ runId: "r/1", assigneeUid: "m2", expectedAssigneeUid: "m1" });
    });
    expect(callLog[0].url).toBe(URL);
    expect(callLog[0].options.method).toBe("PATCH");
    expect(Object.keys(JSON.parse(callLog[0].options.body))).toEqual(["assigneeUid", "expectedAssigneeUid"]);
    expect(JSON.parse(callLog[0].options.body)).not.toHaveProperty("expectedUpdateTime");
  });
  it("GET loads the current assignee + reviewerUids from the same path", async () => {
    respond(true, { ok: true, assignee: { uid: "m1", displayName: "Bao", state: "active" }, reviewerUids: ["m1"] });
    const hook = mountHook();
    let r: unknown;
    await act(async () => {
      r = await hook().loadRunAssignee("r/1");
    });
    expect(callLog[0].url).toBe(URL);
    expect(callLog[0].options.method).toBe("GET");
    expect(r).toEqual({ status: "ok", assignee: { uid: "m1", displayName: "Bao", state: "active" }, reviewerUids: ["m1"] });
  });
});

describe("per-run lock", () => {
  it("a second write for the SAME run while one is in flight sends NO request; another run is not blocked; lock released after completion", async () => {
    const first = pending();
    const hook = mountHook();
    let p1!: Promise<unknown>;
    act(() => {
      p1 = hook().setRunAssignee({ runId: "r1", assigneeUid: "m1", expectedAssigneeUid: null });
    });
    expect(hook().isRunBusy("r1")).toBe(true);
    let second: unknown;
    await act(async () => {
      second = await hook().setRunAssignee({ runId: "r1", assigneeUid: "m2", expectedAssigneeUid: null });
    });
    expect(second).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog).toHaveLength(1);
    await act(async () => {
      await hook().setRunAssignee({ runId: "r2", assigneeUid: "m1", expectedAssigneeUid: null });
    });
    expect(callLog).toHaveLength(2);
    first.resolve({ ok: true, json: async () => ({ ok: true, changed: true, runId: "r1", workspaceId: "ws 1", assigneeUid: "m1" }) });
    await act(async () => {
      await p1;
    });
    expect(hook().isRunBusy("r1")).toBe(false);
  });
});

describe("response validation + closed error mapping", () => {
  it("write: a malformed 2xx body is internal_error; known codes map through; unknown codes collapse", async () => {
    const hook = mountHook();
    respond(true, { ok: true, changed: "yes", assigneeUid: "m1" });
    let r: unknown;
    await act(async () => {
      r = await hook().setRunAssignee({ runId: "r1", assigneeUid: "m1", expectedAssigneeUid: null });
    });
    expect(r).toEqual({ status: "error", errorCode: "internal_error" });
    respond(false, { ok: false, errorCode: "assignee_conflict" });
    await act(async () => {
      r = await hook().setRunAssignee({ runId: "r1", assigneeUid: "m1", expectedAssigneeUid: null });
    });
    expect(r).toEqual({ status: "error", errorCode: "assignee_conflict" });
    expect(mapTeamRunAssigneeErrorCode("something_else")).toBe("internal_error");
    expect(mapTeamRunAssigneeErrorCode("assignee_not_eligible")).toBe("assignee_not_eligible");
  });
  it("GET: a malformed assignee or reviewerUids shape is internal_error; a thrown fetch is network_error", async () => {
    const hook = mountHook();
    let r: unknown;
    for (const bad of [{ ok: true, assignee: { uid: "" }, reviewerUids: [] }, { ok: true, assignee: null, reviewerUids: "m1" }, { ok: true, assignee: { uid: "m1", displayName: "B", state: "gone" }, reviewerUids: [] }]) {
      respond(true, bad);
      await act(async () => {
        r = await hook().loadRunAssignee("r1");
      });
      expect(r).toEqual({ status: "error", errorCode: "internal_error" });
    }
    authedFetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await act(async () => {
      r = await hook().loadRunAssignee("r1");
    });
    expect(r).toEqual({ status: "error", errorCode: "network_error" });
  });
});
