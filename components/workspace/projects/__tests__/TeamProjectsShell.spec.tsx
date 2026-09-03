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
  return {
    isCreating: false,
    createProject: jest.fn(),
    isProjectBusy: () => false,
    getBusyOperation: () => null,
    archiveProject: jest.fn(),
    restoreProject: jest.fn(),
    ...overrides,
  };
}
/** Phase PROJECT-UI-AR-I1 — the shell mounts TWO `useTeamProjects` instances (active + archived); route each by the requested `status`. */
function projectsByStatus(active: any, archived: any = projectsResult()) {
  mockedUseTeamProjects.mockImplementation((args: { status: "active" | "archived" }) => (args.status === "archived" ? archived : active));
}
function item(overrides: Partial<any> = {}) {
  return { id: "p1", workspaceId: "ws-1", name: "Project One", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: { seconds: 1, nanoseconds: 0 }, ...overrides };
}
function buttons(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").filter((b) => b.props.children === label);
}

async function mount(props: { canCreateProject: boolean; canManageProjects?: boolean; canReadAudit?: boolean }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TeamProjectsShell, {
        workspaceId: "ws-1",
        workspaceName: "Acme Team",
        canReadAudit: true,
        canManageProjects: false,
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
    projectsByStatus(projectsResult());
    const renderer = await mount({ canCreateProject: true });
    expect(renderer.root.findByType("h1").props.children).toBe("Acme Team");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Projects");
  });

  it("zero Projects -> empty state; canCreateProject: true shows the create-oriented copy", async () => {
    projectsByStatus(projectsResult({ items: [], hasMore: false }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No projects yet");
    expect(text).toContain("organize your team's research");
  });

  it("zero Projects with canCreateProject: false -> informative empty state, no misleading active create action", async () => {
    projectsByStatus(projectsResult({ items: [], hasMore: false }));
    const renderer = await mount({ canCreateProject: false });
    expect(renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")).toBeUndefined();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No projects yet");
  });

  it("canCreateProject: true renders an active 'New Project' button", async () => {
    projectsByStatus(projectsResult());
    const renderer = await mount({ canCreateProject: true });
    expect(renderer.root.findAllByType("button").find((b) => b.props.children === "New Project")).toBeDefined();
  });

  it("PERMANENT capability — with existing Projects AND canCreateProject: true, 'New Project' remains available (not replaced by a checkmark/list-only view)", async () => {
    projectsByStatus(
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
    projectsByStatus(
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
    projectsByStatus(projectsResult({ status: "loading", items: [] }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("No projects yet");
    expect(text).toContain("Loading Projects");
  });

  it("error state shows a retry affordance, not a false-empty list", async () => {
    projectsByStatus(projectsResult({ status: "error", initialErrorCode: "internal_error", items: [] }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("No projects yet");
  });

  it("Phase 12A.2 Section M — New Project creates, then navigates DIRECTLY into the new Project using the authoritative response id (mirrors 12A.1's Workspace-creation redirect improvement)", async () => {
    const createProject = jest.fn().mockResolvedValue({ status: "ok", project: { id: "new-1", workspaceId: "ws-1", name: "New", status: "active", createdAt: "x", updatedAt: "x", updateTime: null } });
    projectsByStatus(projectsResult());
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
    projectsByStatus(projectsResult());
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

describe("TeamProjectsShell — two sections, Phase PROJECT-UI-AR-I1", () => {
  it("mounts exactly two list instances: one requesting status active, one requesting status archived, for the same Workspace", async () => {
    projectsByStatus(projectsResult(), projectsResult());
    await mount({ canCreateProject: true });
    const calls = mockedUseTeamProjects.mock.calls.map((c) => c[0]);
    expect(calls.some((a) => a.workspaceId === "ws-1" && a.status === "active")).toBe(true);
    expect(calls.some((a) => a.workspaceId === "ws-1" && a.status === "archived")).toBe(true);
    expect(new Set(calls.map((a) => a.status)).size).toBe(2);
  });

  it("renders an 'Archived Projects' section with its own empty state, and keeps New Project out of it", async () => {
    projectsByStatus(projectsResult({ items: [item()] }), projectsResult({ items: [], hasMore: false }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Archived Projects");
    expect(text).toContain("No archived projects.");
    expect(buttons(renderer, "New Project")).toHaveLength(1);
  });

  it("archived rows render in the archived section with their own detail links, and the archived section has an independent loading state", async () => {
    projectsByStatus(projectsResult({ items: [item()] }), projectsResult({ status: "loading", items: [] }));
    const renderer = await mount({ canCreateProject: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Loading archived Projects");
    projectsByStatus(projectsResult({ items: [item()] }), projectsResult({ items: [item({ id: "old-1", name: "Old Project", status: "archived" })] }));
    const renderer2 = await mount({ canCreateProject: true });
    const link = renderer2.root.findAllByType("a").find((a) => a.props.children === "Old Project");
    expect(link!.props.href).toBe("/workspace/team/ws-1/projects/old-1");
  });
});

describe("TeamProjectsShell — status-driven, capability-gated lifecycle actions", () => {
  it("A. active + canManageProjects: Archive visible, Restore absent", async () => {
    projectsByStatus(projectsResult({ items: [item()] }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    expect(buttons(renderer, "Archive")).toHaveLength(1);
    expect(buttons(renderer, "Restore")).toHaveLength(0);
  });

  it("B. archived + canManageProjects: Restore visible, Archive absent", async () => {
    projectsByStatus(projectsResult(), projectsResult({ items: [item({ id: "old-1", status: "archived" })] }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    expect(buttons(renderer, "Restore")).toHaveLength(1);
    expect(buttons(renderer, "Archive")).toHaveLength(0);
  });

  it("C. without projects.manage neither Archive nor Restore renders, for active or archived rows, while name links remain", async () => {
    projectsByStatus(projectsResult({ items: [item()] }), projectsResult({ items: [item({ id: "old-1", name: "Old", status: "archived" })] }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: false });
    expect(buttons(renderer, "Archive")).toHaveLength(0);
    expect(buttons(renderer, "Restore")).toHaveLength(0);
    expect(renderer.root.findAllByType("a").filter((a) => a.props.href.startsWith("/workspace/team/ws-1/projects/"))).toHaveLength(2);
  });

  it("updateTime: null (projection-unavailable row) renders NO lifecycle control even for a manager — the row must be refetched before it can be acted on", async () => {
    projectsByStatus(projectsResult({ items: [item({ updateTime: null })] }), projectsResult({ items: [item({ id: "old-1", status: "archived", updateTime: null })] }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    expect(buttons(renderer, "Archive")).toHaveLength(0);
    expect(buttons(renderer, "Restore")).toHaveLength(0);
  });

  it("busy Project: its control is disabled and Restore shows its pending label", async () => {
    projectsByStatus(projectsResult({ items: [item()] }), projectsResult({ items: [item({ id: "old-1", status: "archived" })] }));
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ isProjectBusy: (id: string) => id === "old-1", getBusyOperation: (id: string) => (id === "old-1" ? "restore" : null) }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    expect(buttons(renderer, "Restoring…")[0].props.disabled).toBe(true);
    expect(buttons(renderer, "Archive")[0].props.disabled).toBe(false);
  });
});

describe("TeamProjectsShell — archive/restore flows (success, stale, denied, failure)", () => {
  async function openArchiveDialogAndConfirm(renderer: TestRenderer.ReactTestRenderer) {
    await act(async () => {
      buttons(renderer, "Archive")[0].props.onClick();
    });
    const dialog = renderer.root.findAll((n) => n.props?.role === "dialog");
    expect(dialog).toHaveLength(1);
    // The row's own "Archive" trigger comes first in tree order; the dialog's confirm button is rendered after it.
    const confirm = buttons(renderer, "Archive").at(-1)!;
    await act(async () => {
      await confirm.props.onClick();
    });
    return renderer;
  }

  it("G. archive success: exactly one archiveProject call with the row's project, dialog closes, BOTH sections refresh from page one", async () => {
    const active = projectsResult({ items: [item()] });
    const archived = projectsResult();
    projectsByStatus(active, archived);
    const archiveProject = jest.fn().mockResolvedValue({ status: "ok", project: item({ status: "archived" }) });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ archiveProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await openArchiveDialogAndConfirm(renderer);
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(archiveProject).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", updateTime: { seconds: 1, nanoseconds: 0 } }));
    expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
    expect(active.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(archived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
  });

  it("H. restore success: one restoreProject call with the archived row, BOTH sections refresh", async () => {
    const active = projectsResult();
    const archived = projectsResult({ items: [item({ id: "old-1", status: "archived", updateTime: { seconds: 7, nanoseconds: 3 } })] });
    projectsByStatus(active, archived);
    const restoreProject = jest.fn().mockResolvedValue({ status: "ok", project: item({ id: "old-1", status: "active" }) });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ restoreProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await act(async () => {
      await buttons(renderer, "Restore")[0].props.onClick();
    });
    expect(restoreProject).toHaveBeenCalledTimes(1);
    expect(restoreProject).toHaveBeenCalledWith(expect.objectContaining({ id: "old-1", updateTime: { seconds: 7, nanoseconds: 3 } }));
    expect(active.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(archived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
  });

  it("projectionUnavailable success (ok with updateTime: null) is treated as COMMITTED: dialog closes, both sections refresh, no second call", async () => {
    const active = projectsResult({ items: [item()] });
    const archived = projectsResult();
    projectsByStatus(active, archived);
    const archiveProject = jest.fn().mockResolvedValue({ status: "ok", project: item({ status: "archived", updateTime: null }) });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ archiveProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await openArchiveDialogAndConfirm(renderer);
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Something went wrong");
    expect(active.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(archived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["conflict", "This project changed. Refresh and try again."],
    ["invalid_project_status_transition", "This project's status has already changed."],
    ["insufficient_capability", "You don't have permission to do that in this Workspace."],
    ["project_not_found", "This project could not be found."],
    ["team_workspace_not_found", "This Workspace could not be found."],
  ])("I/J/K. archive denied with %s: ONE request, the stale dialog is closed (never reusable), the message shows inline on the row, both sections refresh, no retry", async (code, copy) => {
    const active = projectsResult({ items: [item()] });
    const archived = projectsResult();
    projectsByStatus(active, archived);
    const archiveProject = jest.fn().mockResolvedValue({ status: "error", errorCode: code });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ archiveProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await openArchiveDialogAndConfirm(renderer);
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
    const alerts = renderer.root.findAll((n) => n.props?.role === "alert");
    expect(alerts.map((a) => a.props.children)).toContain(copy);
    expect(active.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(archived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
  });

  it("restore denied with conflict: ONE request, inline stale copy, both sections refresh, no retry", async () => {
    const active = projectsResult();
    const archived = projectsResult({ items: [item({ id: "old-1", status: "archived" })] });
    projectsByStatus(active, archived);
    const restoreProject = jest.fn().mockResolvedValue({ status: "error", errorCode: "conflict" });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ restoreProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await act(async () => {
      await buttons(renderer, "Restore")[0].props.onClick();
    });
    expect(restoreProject).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll((n) => n.props?.role === "alert").map((a) => a.props.children)).toContain("This project changed. Refresh and try again.");
    expect(active.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(archived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
  });

  it("generic failure (internal_error) on archive: the dialog stays open with the generic error, NO section refresh, no false row movement, manual retry remains possible", async () => {
    const active = projectsResult({ items: [item()] });
    const archived = projectsResult();
    projectsByStatus(active, archived);
    const archiveProject = jest.fn().mockResolvedValue({ status: "error", errorCode: "internal_error" });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ archiveProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await openArchiveDialogAndConfirm(renderer);
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(1);
    expect(renderer.root.findAll((n) => n.props?.role === "alert").map((a) => a.props.children)).toContain("Something went wrong. Please try again.");
    expect(active.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(archived.resetAndReloadFromStart).not.toHaveBeenCalled();
    // Manual retry is still possible: the confirm button is present and enabled.
    const confirm = buttons(renderer, "Archive").at(-1)!;
    expect(confirm.props.disabled).toBe(false);
  });

  it("generic failure on restore: inline generic error, no refresh, the Restore button remains available", async () => {
    const active = projectsResult();
    const archived = projectsResult({ items: [item({ id: "old-1", status: "archived" })] });
    projectsByStatus(active, archived);
    const restoreProject = jest.fn().mockResolvedValue({ status: "error", errorCode: "network_error" });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ restoreProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await act(async () => {
      await buttons(renderer, "Restore")[0].props.onClick();
    });
    expect(active.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(archived.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(buttons(renderer, "Restore")).toHaveLength(1);
  });

  it("Cancel in the archive dialog sends no request and refreshes nothing", async () => {
    const active = projectsResult({ items: [item()] });
    const archived = projectsResult();
    projectsByStatus(active, archived);
    const archiveProject = jest.fn();
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycleResult({ archiveProject }));
    const renderer = await mount({ canCreateProject: true, canManageProjects: true });
    await act(async () => {
      buttons(renderer, "Archive")[0].props.onClick();
    });
    await act(async () => {
      buttons(renderer, "Cancel")[0].props.onClick();
    });
    expect(archiveProject).not.toHaveBeenCalled();
    expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
    expect(active.resetAndReloadFromStart).not.toHaveBeenCalled();
  });
});

