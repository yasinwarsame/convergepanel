/**
 * Phase PROJECT-UI-AR-P3A-I1 — TeamProjectsShell with the REAL `useTeamProjects`
 * and `useTeamProjectLifecycle` hooks (only `authedFetch` and auth mocked),
 * so the shell-owned lifecycle notice is proven to survive the real
 * refetch that empties both lists and unmounts every row. This is the
 * exact scenario the hook-mocked shell spec cannot observe (its no-op
 * reset never unmounts rows).
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: any) => require("react").createElement("a", { href }, children) }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u" }, loading: false, authReady: true }) }));

const fetchLog: string[] = [];
let restoreResponse: { ok: boolean; body: unknown } = { ok: false, body: { ok: false, errorCode: "conflict" } };
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (url: string) => {
    fetchLog.push(url);
    if (url.includes("/restore")) return Promise.resolve({ ok: restoreResponse.ok, json: async () => restoreResponse.body });
    if (url.includes("status=archived")) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, items: [{ id: "old-1", workspaceId: "ws-1", name: "Old", status: "archived", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }], hasMore: false }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, items: [], hasMore: false }) });
  },
}));

import TeamProjectsShell from "@/components/workspace/projects/TeamProjectsShell";

const flush = () => new Promise((r) => setTimeout(r, 0));
const noticeTexts = (r: TestRenderer.ReactTestRenderer, role: "alert" | "status") =>
  r.root.findAll((n) => n.props?.role === role && n.props?.tabIndex === -1).map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));

async function mountAndSettle() {
  fetchLog.length = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(TeamProjectsShell, { workspaceId: "ws-1", workspaceName: "Acme", canCreateProject: true, canManageProjects: true, canReadAudit: false }));
  });
  await act(async () => {
    await flush();
  });
  return renderer;
}

it("a 409 on restore leaves the shell-owned error visible after the real refetch unmounts the rows AND after it brings a fresh row back; exactly one restore request; no dialog", async () => {
  restoreResponse = { ok: false, body: { ok: false, errorCode: "conflict" } };
  const renderer = await mountAndSettle();
  const restore = renderer.root.findAllByType("button").find((b) => b.props.children === "Restore")!;
  expect(restore).toBeDefined();
  await act(async () => {
    await restore.props.onClick();
  });
  // The real reset emptied both lists and the mocked refetch resolved within the same act(); what matters is that
  // the notice was NOT owned by the (now replaced) row and is still rendered.
  expect(noticeTexts(renderer, "alert")).toEqual(["Error: This project changed. Refresh and try again."]);
  await act(async () => {
    await flush();
    await flush();
  });
  expect(renderer.root.findAllByType("li")).toHaveLength(1); // fresh row from the refetch
  expect(noticeTexts(renderer, "alert")).toEqual(["Error: This project changed. Refresh and try again."]);
  expect(fetchLog.filter((u) => u.includes("/restore"))).toHaveLength(1);
  expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
});

it("a committed restore leaves the shell-owned success notice visible across the real refetch", async () => {
  restoreResponse = { ok: true, body: { ok: true, project: { id: "old-1", workspaceId: "ws-1", name: "Old", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 2, nanoseconds: 0 } } } };
  const renderer = await mountAndSettle();
  const restore = renderer.root.findAllByType("button").find((b) => b.props.children === "Restore")!;
  await act(async () => {
    await restore.props.onClick();
  });
  expect(noticeTexts(renderer, "status")).toEqual(["Done: Old was restored."]);
  await act(async () => {
    await flush();
    await flush();
  });
  expect(noticeTexts(renderer, "status")).toEqual(["Done: Old was restored."]);
  expect(fetchLog.filter((u) => u.includes("/restore"))).toHaveLength(1);
});
