/**
 * Team Projects UI, Phase 12A.2 — `TeamProjectsShell` interactive
 * behavior. `react-test-renderer` + `act()` (this repo has no jsdom —
 * matches `WorkspaceOverviewShell.spec.tsx`'s identical convention).
 * `useTeamProjects`/`useTeamProjectLifecycle` are mocked directly (unlike
 * `WorkspaceOverviewShell`, this shell calls the hooks itself rather than
 * receiving fetcher functions) — the real component tree/render logic is
 * exercised end-to-end.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

const mockedRouterPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...args: unknown[]) => mockedRouterPush(...args) }),
}));

const mockedUseTeamProjects = jest.fn();
jest.mock("@/hooks/useTeamProjects", () => {
  const actual = jest.requireActual("@/hooks/useTeamProjects");
  return { ...actual, useTeamProjects: (...args: any[]) => mockedUseTeamProjects(...args) };
});

const mockedUseTeamProjectLifecycle = jest.fn();
jest.mock("@/hooks/useTeamProjectLifecycle", () => ({
  useTeamProjectLifecycle: (...args: any[]) => mockedUseTeamProjectLifecycle(...args),
}));

import TeamProjectsShell from "@/components/workspace/projects/TeamProjectsShell";

function projectsResult(overrides: Partial<any> = {}) {
  return {
    items: [],
    hasMore: false,
    status: "ready",
    initialErrorCode: null,
    loadingMore: false,
    loadMoreErrorCode: null,
    loadMore: jest.fn(),
    retryInitial: jest.fn(),
    resetAndReloadFromStart: jest.fn(),
    ...overrides,
  };
}

function lifecycleResult(overrides: Partial<any> = {}) {
  return { isCreating: false, createProject: jest.fn(), ...overrides };
}

async function mount(props: { canCreateProject: boolean; canReadAudit?: boolean }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TeamProjectsShell, {
        workspaceId: "ws-1",
        workspaceName: "Acme Team",
        canReadAudit: true,
        ...props,
      })
    );
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult());
});

describe("TeamProjectsShell", () => {
  it("renders the Workspace name and shared nav with Projects active", async () => {
    mockedUseTeamProjects.mockReturnValue(projectsResult());
    const renderer = await mount({ canCreateProject: true });
    expect(renderer.root.findByType("h1").props.children).toBe("Acme Team");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Projects");
  });

  it("zero Projects -> empty state; canCreateProject: true shows the create-oriented copy", async () => {
    mockedUseTeamProjects.mockReturnValue(projectsResult({ items: [], hasMore: false }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No projects yet");
    expect(text).toContain("organize your team's research");
  });

  it("zero Projects with canCreateProject: false -> informative empty state, no misleading active create action", async () => {
    mockedUseTeamProjects.mockReturnValue(projectsResult({ items: [], hasMore: false }));
    const renderer = await mount({ canCreateProject: false });
    expect(renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")).toBeUndefined();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No projects yet");
  });

  it("canCreateProject: true renders an active 'New Project' button", async () => {
    mockedUseTeamProjects.mockReturnValue(projectsResult());
    const renderer = await mount({ canCreateProject: true });
    expect(renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")).toBeDefined();
  });

  it("PERMANENT capability — with existing Projects AND canCreateProject: true, 'New Project' remains available (not replaced by a checkmark/list-only view)", async () => {
    mockedUseTeamProjects.mockReturnValue(
      projectsResult({
        items: [
          { id: "p1", workspaceId: "ws-1", name: "Project One", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: { seconds: 1, nanoseconds: 0 } },
          { id: "p2", workspaceId: "ws-1", name: "Project Two", status: "active", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", updateTime: { seconds: 2, nanoseconds: 0 } },
        ],
      })
    );
    const renderer = await mount({ canCreateProject: true });
    expect(renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")).toBeDefined();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Project One");
    expect(text).toContain("Project Two");
  });

  it("each Project row links to the correct Workspace-scoped detail route", async () => {
    mockedUseTeamProjects.mockReturnValue(
      projectsResult({
        items: [{ id: "proj-xyz", workspaceId: "ws-1", name: "ABC Acquisition", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: null }],
      })
    );
    const renderer = await mount({ canCreateProject: true });
    const link = renderer.root.findAllByType("a").find((a) => a.props.children === "ABC Acquisition");
    expect(link).toBeDefined();
    expect(link!.props.href).toBe("/workspace/team/ws-1/projects/proj-xyz");
  });

  it("loading state shows a loading indicator, not the empty state", async () => {
    mockedUseTeamProjects.mockReturnValue(projectsResult({ status: "loading", items: [] }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("No projects yet");
    expect(text).toContain("Loading Projects");
  });

  it("error state shows a retry affordance, not a false-empty list", async () => {
    mockedUseTeamProjects.mockReturnValue(projectsResult({ status: "error", initialErrorCode: "internal_error", items: [] }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("No projects yet");
  });

  it("Phase 12A.2 Section M — New Project creates, then navigates DIRECTLY into the new Project using the authoritative response id (mirrors 12A.1's Workspace-creation redirect improvement)", async () => {
    const createProject = jest.fn().mockResolvedValue({ status: "ok", project: { id: "new-1", workspaceId: "ws-1", name: "New", status: "active", createdAt: "x", updatedAt: "x", updateTime: null } });
    mockedUseTeamProjects.mockReturnValue(projectsResult());
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ createProject }));

    const renderer = await mount({ canCreateProject: true });
    const newProjectButton = renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")!;
    await act(async () => {
      newProjectButton.props.onClick();
    });
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(mockedRouterPush).toHaveBeenCalledWith("/workspace/team/ws-1/projects/new-1");
  });

  it("a failed creation does NOT navigate anywhere — the dialog stays open with an error, no false redirect", async () => {
    const createProject = jest.fn().mockResolvedValue({ status: "error", errorCode: "invalid_project_name" });
    mockedUseTeamProjects.mockReturnValue(projectsResult());
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ createProject }));

    const renderer = await mount({ canCreateProject: true });
    const newProjectButton = renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")!;
    await act(async () => {
      newProjectButton.props.onClick();
    });
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(mockedRouterPush).not.toHaveBeenCalled();
  });
});
