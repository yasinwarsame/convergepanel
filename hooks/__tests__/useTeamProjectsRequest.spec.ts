/**
 * Phase PROJECT-UI-AR-I1 — `useTeamProjects()` request contract, exercised
 * by rendering the hook (react-test-renderer host, `authedFetch` mocked)
 * rather than only its pure parser: the URL must carry EXACTLY the
 * requested status, and the parser must be invoked with that same status
 * so an active row can never be adopted into an archived page or vice
 * versa.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

const callLog: { url: string; options: any }[] = [];
let responseBody: unknown = { ok: true, items: [], hasMore: false };
const authedFetchMock = jest.fn((url: string, options: any) => {
  callLog.push({ url, options });
  return Promise.resolve({ ok: true, json: async () => responseBody });
});
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...args: [string, any]) => authedFetchMock(...args) }));

import { useTeamProjects, type UseTeamProjectsResult, type TeamProjectListStatus } from "@/hooks/useTeamProjects";

const WS_ID = "ws-1";

function row(overrides: Record<string, unknown> = {}) {
  return { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: { seconds: 1, nanoseconds: 0 }, ...overrides };
}

function HookHost({ status, onResult }: { status: TeamProjectListStatus; onResult: (r: UseTeamProjectsResult) => void }) {
  const result = useTeamProjects({ workspaceId: WS_ID, status });
  onResult(result);
  return null;
}

async function mount(status: TeamProjectListStatus): Promise<() => UseTeamProjectsResult> {
  let latest!: UseTeamProjectsResult;
  await act(async () => {
    TestRenderer.create(createElement(HookHost, { status, onResult: (r) => (latest = r) }));
  });
  return () => latest;
}

beforeEach(() => {
  callLog.length = 0;
  responseBody = { ok: true, items: [], hasMore: false };
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-1" }, loading: false, authReady: true });
});

it("status: 'active' requests exactly ?status=active", async () => {
  await mount("active");
  expect(callLog).toHaveLength(1);
  expect(callLog[0].url).toBe(`/api/workspaces/${WS_ID}/projects?status=active`);
  expect(callLog[0].options.method).toBe("GET");
});

it("status: 'archived' requests exactly ?status=archived", async () => {
  await mount("archived");
  expect(callLog).toHaveLength(1);
  expect(callLog[0].url).toBe(`/api/workspaces/${WS_ID}/projects?status=archived`);
});

it("an archived page adopts archived rows (with their native updateTime tokens) as ready items", async () => {
  responseBody = { ok: true, items: [row({ id: "old-1", status: "archived", updateTime: { seconds: 9, nanoseconds: 8 } })], hasMore: false };
  const latest = await mount("archived");
  expect(latest().status).toBe("ready");
  expect(latest().items).toEqual([expect.objectContaining({ id: "old-1", status: "archived", updateTime: { seconds: 9, nanoseconds: 8 } })]);
});

it("an archived page that receives an ACTIVE row fails closed (internal_error), never rendering a mis-filed row", async () => {
  responseBody = { ok: true, items: [row({ status: "active" })], hasMore: false };
  const latest = await mount("archived");
  expect(latest().status).toBe("error");
  expect(latest().initialErrorCode).toBe("internal_error");
  expect(latest().items).toEqual([]);
});

it("an active page that receives an ARCHIVED row fails closed (unchanged behavior)", async () => {
  responseBody = { ok: true, items: [row({ status: "archived" })], hasMore: false };
  const latest = await mount("active");
  expect(latest().status).toBe("error");
  expect(latest().initialErrorCode).toBe("internal_error");
});

it("resetAndReloadFromStart re-requests page one with the SAME requested status (used after archive/restore)", async () => {
  const latest = await mount("archived");
  await act(async () => {
    latest().resetAndReloadFromStart();
  });
  expect(callLog).toHaveLength(2);
  expect(callLog[1].url).toBe(`/api/workspaces/${WS_ID}/projects?status=archived`);
});
