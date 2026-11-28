/**
 * ZCA L-6 — the client half of the six Personal workspace pages: each kind asks its endpoint, renders
 * its existing shell only for a positive answer, and renders the page's notFound() for every 404.
 */
type FakeUser = { uid: string; getIdToken: () => Promise<string> };
const AUTH: { user: FakeUser | null; authReady: boolean } = { user: null, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockAuthedFetch(...a) }));
jest.mock("next/navigation", () => ({ ...jest.requireActual("next/navigation"), useRouter: () => ({ replace: jest.fn() }), usePathname: () => "/workspace" }));
const mockShellProps: Array<{ shell: string; props: Record<string, unknown> }> = [];
const shell = (name: string) => (props: Record<string, unknown>) => { mockShellProps.push({ shell: name, props }); return null; };
jest.mock("@/components/workspace/WorkspaceShell", () => shell("WorkspaceShell"));
jest.mock("@/components/projects/ProjectsShell", () => shell("ProjectsShell"));
jest.mock("@/components/projects/ProjectDetailShell", () => shell("ProjectDetailShell"));
jest.mock("@/components/workspace/PersonalResearchDetailShell", () => shell("PersonalResearchDetailShell"));
jest.mock("@/components/workspace/WorkspaceReviewQueueShell", () => shell("WorkspaceReviewQueueShell"));
jest.mock("@/components/workspace/WorkspaceReviewsChooser", () => shell("WorkspaceReviewsChooser"));
jest.mock("@/components/workspace/TeamWorkspacesLanding", () => shell("TeamWorkspacesLanding"));

import { Component, createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PersonalWorkspacePage, { PERSONAL_PAGE_GATE, type PersonalPageProps } from "@/components/workspace/PersonalWorkspacePage";

class Boundary extends Component<{ children?: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { this.props.onError(e); }
  render() { return this.state.failed ? null : this.props.children; }
}
let caught: unknown;
async function mount(page: PersonalPageProps) {
  caught = undefined;
  await act(async () => {
    TestRenderer.create(createElement(Boundary, { onError: (e: unknown) => { caught = e; } }, createElement(PersonalWorkspacePage, page)));
  });
}
const isNotFound = () => (caught as { digest?: string } | undefined)?.digest === "NEXT_NOT_FOUND";
const answer = (status: number, body: unknown = {}) => mockAuthedFetch.mockResolvedValue({ status, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  mockShellProps.length = 0;
  AUTH.user = { uid: "u1", getIdToken: async () => "t" };
  AUTH.authReady = true;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => (console.error as jest.Mock).mockRestore?.());

const GATED: Array<[PersonalPageProps, string, string, Record<string, unknown>]> = [
  [{ kind: "workspaceHome" }, "personal_workspace", "WorkspaceShell", {}],
  [{ kind: "projects" }, "projects", "ProjectsShell", {}],
  [{ kind: "research", runId: "run-1" }, "signed_in", "PersonalResearchDetailShell", { runId: "run-1" }],
  [{ kind: "teamLanding" }, "team_workspaces", "TeamWorkspacesLanding", {}],
];

it("pins each gated kind's gate", () => {
  expect(PERSONAL_PAGE_GATE).toEqual({ workspaceHome: "personal_workspace", projects: "projects", research: "signed_in", teamLanding: "team_workspaces" });
});

describe.each(GATED)("gated page %j", (page, gate, shellName, props) => {
  it("asks its gate with the bearer helper; open → its shell with the former props", async () => {
    answer(200, { ok: true });
    await mount(page);
    expect(mockAuthedFetch).toHaveBeenCalledWith(`/api/user/workspace-ui-gate?gate=${gate}`, expect.objectContaining({ user: AUTH.user, method: "GET" }));
    expect(mockShellProps).toEqual([{ shell: shellName, props }]);
  });
  it("closed gate (404) → notFound(), no shell", async () => {
    answer(404);
    await mount(page);
    expect(isNotFound()).toBe(true);
    expect(mockShellProps).toEqual([]);
  });
  it("signed out locally → nothing requested, no shell", async () => {
    AUTH.user = null;
    await mount(page);
    expect(mockAuthedFetch).not.toHaveBeenCalled();
    expect(mockShellProps).toEqual([]);
  });
});

describe("projectDetail", () => {
  it("found → ProjectDetailShell with exactly { id, name, status } from the endpoint", async () => {
    answer(200, { ok: true, project: { id: "p-1", name: "Q3", status: "archived", extra: "dropped" } });
    await mount({ kind: "projectDetail", projectId: "p-1" });
    expect(mockAuthedFetch).toHaveBeenCalledWith("/api/user/projects/p-1", expect.anything());
    expect(mockShellProps).toEqual([{ shell: "ProjectDetailShell", props: { project: { id: "p-1", name: "Q3", status: "archived" } } }]);
  });
  it("404 → notFound()", async () => {
    answer(404);
    await mount({ kind: "projectDetail", projectId: "p-1" });
    expect(isNotFound()).toBe(true);
  });
  it("503 (lookup failure) → the neutral unavailable state, not concealed as notFound()", async () => {
    answer(503);
    await mount({ kind: "projectDetail", projectId: "p-1" });
    expect(isNotFound()).toBe(false);
    expect(mockShellProps).toEqual([]);
  });
});

describe("reviews", () => {
  it("chooser answer → WorkspaceReviewsChooser", async () => {
    answer(200, { ok: true, mode: "chooser" });
    await mount({ kind: "reviews", workspace: null });
    expect(mockAuthedFetch).toHaveBeenCalledWith("/api/user/workspace-reviews-target", expect.anything());
    expect(mockShellProps).toEqual([{ shell: "WorkspaceReviewsChooser", props: {} }]);
  });
  it("queue answer → WorkspaceReviewQueueShell with the endpoint's workspace id, name and multiplicity; the ?workspace= is forwarded", async () => {
    answer(200, { ok: true, mode: "queue", workspaceId: "ws/a", workspaceName: "Acme", hasMultipleWorkspaces: true });
    await mount({ kind: "reviews", workspace: "ws/a" });
    expect(mockAuthedFetch).toHaveBeenCalledWith(`/api/user/workspace-reviews-target?workspace=${encodeURIComponent("ws/a")}`, expect.anything());
    expect(mockShellProps).toEqual([{ shell: "WorkspaceReviewQueueShell", props: { workspaceId: "ws/a", workspaceName: "Acme", hasMultipleWorkspaces: true } }]);
  });
  it("404 → notFound()", async () => {
    answer(404);
    await mount({ kind: "reviews", workspace: null });
    expect(isNotFound()).toBe(true);
  });
  it("an unexpected mode is not rendered", async () => {
    answer(200, { ok: true, mode: "everything" });
    await mount({ kind: "reviews", workspace: null });
    expect(mockShellProps).toEqual([]);
  });
});
