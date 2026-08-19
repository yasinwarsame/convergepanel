/**
 * Phase 7D — `ProjectsShell` (the default-export wrapper, not the pure
 * `ProjectsShellView`). Tests the actual reconciliation wiring closures
 * (`onCreated`/`onRenamed`/`refreshSections`) built from the three live
 * hooks — a real gap `ProjectsShell.spec.tsx` doesn't cover, since that
 * file only exercises `ProjectsShellView` with fake props. The three
 * hooks are mocked; `ProjectsShellView` is located in the rendered tree
 * and its handler props are invoked directly to prove the wrapper's own
 * logic (spec item 23): create resets Active only; rename replaces on
 * BOTH sections; archive/restore reset BOTH sections; Unfiled is never
 * touched by any Project lifecycle mutation.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockActive = {
  items: [],
  hasMore: false,
  status: "ready" as const,
  initialErrorCode: null,
  loadingMore: false,
  loadMoreErrorCode: null,
  loadMore: jest.fn(),
  retryInitial: jest.fn(),
  resetAndReloadFromStart: jest.fn(),
  replaceItem: jest.fn(),
};

const mockArchived = {
  items: [],
  hasMore: false,
  status: "ready" as const,
  initialErrorCode: null,
  loadingMore: false,
  loadMoreErrorCode: null,
  loadMore: jest.fn(),
  retryInitial: jest.fn(),
  resetAndReloadFromStart: jest.fn(),
  replaceItem: jest.fn(),
};

const mockUnfiled = {
  items: [],
  hasMore: false,
  status: "ready" as const,
  initialErrorCode: null,
  loadingMore: false,
  loadMoreErrorCode: null,
  loadMore: jest.fn(),
  retryInitial: jest.fn(),
  resetAndReloadFromStart: jest.fn(),
};

jest.mock("@/hooks/useProjects", () => {
  const actual = jest.requireActual("@/hooks/useProjects");
  return {
    ...actual,
    useProjects: (args: { status: "active" | "archived" }) => (args.status === "active" ? mockActive : mockArchived),
  };
});

jest.mock("@/hooks/useUnfiledRuns", () => {
  const actual = jest.requireActual("@/hooks/useUnfiledRuns");
  return {
    ...actual,
    useUnfiledRuns: () => mockUnfiled,
  };
});

jest.mock("@/hooks/useProjectLifecycle", () => ({
  useProjectLifecycle: () => ({
    isProjectBusy: () => false,
    getBusyOperation: () => null,
    isCreating: false,
    createProject: jest.fn(),
    renameProject: jest.fn(),
    archiveProject: jest.fn(),
    restoreProject: jest.fn(),
  }),
}));

jest.mock("@/hooks/useRunProjectAssociation", () => ({
  useRunProjectAssociation: () => ({
    isRunBusy: () => false,
    assign: jest.fn(),
  }),
}));

import ProjectsShell, { ProjectsShellView } from "@/components/projects/ProjectsShell";
import type { ProjectSummary } from "@/hooks/useProjects";

const RENAMED_PROJECT: ProjectSummary = {
  id: "proj-1",
  name: "Renamed",
  status: "active",
  createdAt: "x",
  updatedAt: "x",
  updateTime: { seconds: 1, nanoseconds: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
});

function mountShell() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ProjectsShell));
  });
  const view = renderer.root.findByType(ProjectsShellView as any);
  return { renderer, view };
}

describe("ProjectsShell wiring — create (spec item 23: Active only)", () => {
  it("onCreated resets Active but never touches Archived or Unfiled", () => {
    const { view } = mountShell();
    act(() => {
      (view.props as any).onCreated();
    });
    expect(mockActive.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(mockArchived.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(mockUnfiled.resetAndReloadFromStart).not.toHaveBeenCalled();
  });
});

describe("ProjectsShell wiring — rename (spec item 11/23: local replaceItem on BOTH sections, never a network reset)", () => {
  it("onRenamed calls replaceItem on both Active and Archived, resets neither, never touches Unfiled", () => {
    const { view } = mountShell();
    act(() => {
      (view.props as any).onRenamed(RENAMED_PROJECT);
    });
    expect(mockActive.replaceItem).toHaveBeenCalledWith(RENAMED_PROJECT);
    expect(mockArchived.replaceItem).toHaveBeenCalledWith(RENAMED_PROJECT);
    expect(mockActive.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(mockArchived.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(mockUnfiled.resetAndReloadFromStart).not.toHaveBeenCalled();
  });
});

describe("ProjectsShell wiring — archive/restore (spec item 13/15/23: BOTH sections reset, Unfiled untouched)", () => {
  it("refreshSections resets both Active and Archived, never Unfiled", () => {
    const { view } = mountShell();
    act(() => {
      (view.props as any).refreshSections();
    });
    expect(mockActive.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(mockArchived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(mockUnfiled.resetAndReloadFromStart).not.toHaveBeenCalled();
  });
});

describe("ProjectsShell wiring — Phase 7E-A: run assignment resets Unfiled only (spec item 20)", () => {
  it("onRunAssigned resets Unfiled but never touches Active or Archived", () => {
    const { view } = mountShell();
    act(() => {
      (view.props as any).onRunAssigned();
    });
    expect(mockUnfiled.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(mockActive.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(mockArchived.resetAndReloadFromStart).not.toHaveBeenCalled();
  });
});
