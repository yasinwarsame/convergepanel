/**
 * ADD-TO-TEAM-PROJECT §V — `useTeamResearchSnapshot()`: exact request shape,
 * per-source lock, response-integrity validation, error mapping. Structural
 * mirror of `useRunProjectAssociation.spec.ts`'s deferred-promise harness.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
function createDeferred(): Deferred {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const callLog: { url: string; options: any }[] = [];
const queue: Deferred[] = [];
const authedFetchMock = jest.fn((url: string, options: any) => {
  callLog.push({ url, options });
  const d = queue.shift() ?? createDeferred();
  return d.promise;
});
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...args: [string, any]) => authedFetchMock(...args) }));

import { useTeamResearchSnapshot, buildTeamResearchSnapshotRequest, type UseTeamResearchSnapshotResult } from "@/hooks/useTeamResearchSnapshot";

function respond(ok: boolean, body: unknown) {
  const d = createDeferred();
  queue.push(d);
  d.resolve({ ok, json: async () => body });
}
function pending(): Deferred {
  const d = createDeferred();
  queue.push(d);
  return d;
}

function HookHost({ onResult }: { onResult: (r: UseTeamResearchSnapshotResult) => void }) {
  onResult(useTeamResearchSnapshot());
  return null;
}
function mountHook() {
  let latest!: UseTeamResearchSnapshotResult;
  act(() => {
    TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return () => latest;
}

const args = { sourceRunId: "run-src", workspaceId: "ws 1", projectId: "p-1" };
const URL = "/api/workspaces/ws%201/projects/p-1/research/snapshots";
const dto = { ok: true, status: "created", runId: "run-copy", workspaceId: "ws 1", projectId: "p-1", href: "/workspace/team/ws%201/projects/p-1/research/run-copy" };

beforeEach(() => {
  callLog.length = 0;
  queue.length = 0;
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

describe("request shape", () => {
  it("POSTs to the path-addressed destination with EXACTLY the typed source identity in the body", async () => {
    expect(buildTeamResearchSnapshotRequest(args)).toEqual({ url: URL, body: JSON.stringify({ source: { sourceType: "personal_research", runId: "run-src" } }) });
    respond(true, dto);
    const hook = mountHook();
    await act(async () => {
      await hook().create(args);
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe(URL);
    expect(callLog[0].options.method).toBe("POST");
    expect(JSON.parse(callLog[0].options.body)).toEqual({ source: { sourceType: "personal_research", runId: "run-src" } });
    expect(Object.keys(JSON.parse(callLog[0].options.body))).toEqual(["source"]);
  });
});

describe("per-source lock", () => {
  it("a second create for the SAME source while one is in flight returns internal_error WITHOUT a second request; a different source is not blocked", async () => {
    const first = pending();
    const hook = mountHook();
    let p1!: Promise<unknown>;
    act(() => {
      p1 = hook().create(args);
    });
    expect(hook().isSourceBusy("run-src")).toBe(true);
    let second: unknown;
    await act(async () => {
      second = await hook().create(args);
    });
    expect(second).toEqual({ status: "error", errorCode: "internal_error" });
    expect(callLog).toHaveLength(1);

    respond(true, { ...dto, runId: "run-other", href: "/workspace/team/ws%201/projects/p-1/research/run-other" });
    await act(async () => {
      await hook().create({ ...args, sourceRunId: "run-other-src" });
    });
    expect(callLog).toHaveLength(2);

    first.resolve({ ok: true, json: async () => dto });
    await act(async () => {
      await p1;
    });
    expect(hook().isSourceBusy("run-src")).toBe(false);
  });
});

describe("response integrity + error mapping", () => {
  it("a valid DTO for the requested destination → ok", async () => {
    respond(true, dto);
    const hook = mountHook();
    let r: unknown;
    await act(async () => {
      r = await hook().create(args);
    });
    expect(r).toEqual({ status: "ok", snapshot: dto });
  });

  it("a 2xx DTO naming a DIFFERENT destination or a foreign href → internal_error (never followed)", async () => {
    const hook = mountHook();
    for (const bad of [{ ...dto, workspaceId: "ws-other" }, { ...dto, projectId: "p-other" }, { ...dto, href: "https://evil.example" }, { ...dto, status: "moved" }]) {
      respond(true, bad);
      let r: unknown;
      await act(async () => {
        r = await hook().create(args);
      });
      expect(r).toEqual({ status: "error", errorCode: "internal_error" });
    }
  });

  it("non-2xx → the server's known code, unknown codes → internal_error, thrown fetch → network_error", async () => {
    const hook = mountHook();
    respond(false, { ok: false, errorCode: "project_archived" });
    let r: unknown;
    await act(async () => {
      r = await hook().create(args);
    });
    expect(r).toEqual({ status: "error", errorCode: "project_archived" });

    respond(false, { ok: false, errorCode: "brand_new_code" });
    await act(async () => {
      r = await hook().create(args);
    });
    expect(r).toEqual({ status: "error", errorCode: "internal_error" });

    const d = pending();
    d.reject(new Error("offline"));
    await act(async () => {
      r = await hook().create(args);
    });
    expect(r).toEqual({ status: "error", errorCode: "network_error" });
    expect(hook().isSourceBusy("run-src")).toBe(false);
  });
});
