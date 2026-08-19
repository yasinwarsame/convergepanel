/**
 * Phase 7E-A — AddToProjectDialog. Interactive test via `react-test-renderer`
 * (no jsdom), same pattern as `RenameProjectDialog.spec.tsx`. `useProjects`
 * is mocked wholesale (its own parser/integrity-check tests already live in
 * `hooks/__tests__/useProjects.spec.ts` and must stay green independently —
 * not re-tested here) so this file can drive every loading/error/empty/
 * ready state deterministically and assert this dialog calls it with
 * exactly `{status:"active"}`, never `"archived"`.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";

const mockUseProjectsArgs: { status: "active" | "archived" }[] = [];
let mockUseProjectsReturn: UseProjectsResult;
jest.mock("@/hooks/useProjects", () => {
  const actual = jest.requireActual("@/hooks/useProjects");
  return {
    ...actual,
    useProjects: (args: { status: "active" | "archived" }) => {
      mockUseProjectsArgs.push(args);
      return mockUseProjectsReturn;
    },
  };
});

import { AddToProjectDialog } from "@/components/projects/AddToProjectDialog";
import type { UseRunProjectAssociationResult, RunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
import type { ProjectRunSummary } from "@/hooks/useUnfiledRuns";

function fakeProjectsResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
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
    replaceItem: jest.fn(),
    ...overrides,
  };
}

function fakeAssociation(overrides: Partial<UseRunProjectAssociationResult> = {}): UseRunProjectAssociationResult {
  return {
    isRunBusy: () => false,
    getBusyOperation: () => null,
    assign: jest.fn(),
    move: jest.fn(),
    remove: jest.fn(),
    ...overrides,
  };
}

const UPDATE_TIME = { seconds: 1723600000, nanoseconds: 0 };
const PROJECT_A: ProjectSummary = { id: "proj-a", name: "Project A", status: "active", createdAt: "x", updatedAt: "x", updateTime: UPDATE_TIME };
const PROJECT_B: ProjectSummary = { id: "proj-b", name: "Project B", status: "active", createdAt: "x", updatedAt: "x", updateTime: UPDATE_TIME };
const RUN: ProjectRunSummary = { id: "run-1", at: "2026-08-01T00:00:00.000Z", question: "Unfiled question", selectedModels: ["chatgpt"], projectId: null };

function setup(
  association: UseRunProjectAssociationResult,
  onClose = jest.fn(),
  onAssigned = jest.fn(),
  onStaleUnfiled = jest.fn(),
  run: ProjectRunSummary = RUN
) {
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(AddToProjectDialog, { run, triggerRef, onClose, association, onAssigned, onStaleUnfiled }));
  });
  return { renderer, onClose, onAssigned, onStaleUnfiled };
}

beforeEach(() => {
  mockUseProjectsArgs.length = 0;
  mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_A, PROJECT_B] });
});

describe("AddToProjectDialog — target chooser scope (spec item 9/12)", () => {
  it("calls useProjects with exactly {status:'active'}, never 'archived'", () => {
    setup(fakeAssociation());
    expect(mockUseProjectsArgs).toEqual([{ status: "active" }]);
  });

  it("renders every active Project name as a selectable option", () => {
    const { renderer } = setup(fakeAssociation());
    const options = renderer.root.findAllByProps({ role: "option" });
    expect(options.map((o) => o.children.join(""))).toEqual(["Project A", "Project B"]);
  });
});

describe("AddToProjectDialog — loading/error/empty states (spec item 13/35)", () => {
  it("loading state shows a restrained message, no options", () => {
    mockUseProjectsReturn = fakeProjectsResult({ status: "loading" });
    const { renderer } = setup(fakeAssociation());
    expect(renderer.toJSON()).toBeTruthy();
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(0);
  });

  it("error state shows a retry affordance, never fabricates the empty-state copy", () => {
    mockUseProjectsReturn = fakeProjectsResult({ status: "error", initialErrorCode: "internal_error" });
    const { renderer } = setup(fakeAssociation());
    const retry = renderer.root.findAllByType("button").find((b) => b.props.children === "Try again");
    expect(retry).toBeTruthy();
  });

  it("zero active Projects with hasMore=false shows 'No active projects available.'", () => {
    mockUseProjectsReturn = fakeProjectsResult({ items: [], hasMore: false });
    const { renderer } = setup(fakeAssociation());
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("No active projects available.");
  });
});

describe("AddToProjectDialog — deliberate selection, zero mutation until explicit Add (spec item 14)", () => {
  it("opening the dialog dispatches zero association mutation", () => {
    const assign = jest.fn();
    setup(fakeAssociation({ assign }));
    expect(assign).not.toHaveBeenCalled();
  });

  it("selecting a target dispatches zero association mutation", () => {
    const assign = jest.fn();
    const { renderer } = setup(fakeAssociation({ assign }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    expect(assign).not.toHaveBeenCalled();
    expect(option.props["aria-selected"]).toBe(true);
  });

  it("Cancel dispatches zero mutation", () => {
    const assign = jest.fn();
    const { renderer, onClose } = setup(fakeAssociation({ assign }));
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(assign).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Add is disabled until a target is selected", () => {
    const { renderer } = setup(fakeAssociation());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    expect(addButton.props.disabled).toBe(true);
  });
});

describe("AddToProjectDialog — Add dispatches exactly one PATCH via association.assign", () => {
  it("sends (run.id, selectedProjectId, run.projectId) exactly", async () => {
    const assign = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string | null]>(async () => ({
      status: "ok",
      runId: "run-1",
      projectId: "proj-a",
    }));
    const { renderer } = setup(fakeAssociation({ assign }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    await act(async () => {
      await addButton.props.onClick();
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("run-1", "proj-a", null);
  });

  it("on success, closes and calls onAssigned with the selected Project's name", async () => {
    const assign = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string | null]>(async () => ({
      status: "ok",
      runId: "run-1",
      projectId: "proj-a",
    }));
    const { renderer, onClose, onAssigned } = setup(fakeAssociation({ assign }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    await act(async () => {
      await addButton.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAssigned).toHaveBeenCalledWith("Project A");
  });

  it("busy (association.isRunBusy true) disables Add and shows 'Adding…'", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: () => true }));
    const addButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Add"))!;
    expect(addButton.props.disabled).toBe(true);
    expect(addButton.props.children).toBe("Adding…");
  });
});

describe("AddToProjectDialog — stale-Unfiled failures (spec item 21/23): no retry, Unfiled refresh, dialog stays open", () => {
  it.each(["run_not_found", "project_association_conflict", "project_association_unchanged"] as const)(
    "%s: shows error, calls onStaleUnfiled, never closes, never calls onAssigned",
    async (errorCode) => {
      const assign = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string | null]>(async () => ({ status: "error", errorCode }));
      const { renderer, onClose, onAssigned, onStaleUnfiled } = setup(fakeAssociation({ assign }));
      const option = renderer.root.findAllByProps({ role: "option" })[0];
      act(() => option.props.onClick());
      const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
      await act(async () => {
        await addButton.props.onClick();
      });
      expect(assign).toHaveBeenCalledTimes(1); // exactly once — never auto-retried
      expect(onClose).not.toHaveBeenCalled();
      expect(onAssigned).not.toHaveBeenCalled();
      expect(onStaleUnfiled).toHaveBeenCalledTimes(1);
      const alert = renderer.root.findByProps({ role: "alert" });
      expect(alert.children.join("")).toBeTruthy();
    }
  );
});

describe("AddToProjectDialog — stale-target failures (spec item 22): no retry, chooser refresh, selection cleared", () => {
  it.each(["project_not_found", "project_archived"] as const)("%s: shows error, refreshes the chooser's own list, clears selection, never calls onStaleUnfiled", async (errorCode) => {
    const assign = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string | null]>(async () => ({ status: "error", errorCode }));
    const resetAndReloadFromStart = jest.fn();
    mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_A, PROJECT_B], resetAndReloadFromStart });
    const { renderer, onClose, onAssigned, onStaleUnfiled } = setup(fakeAssociation({ assign }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    await act(async () => {
      await addButton.props.onClick();
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onAssigned).not.toHaveBeenCalled();
    expect(onStaleUnfiled).not.toHaveBeenCalled();
    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    // Selection cleared -> Add disabled again.
    const addButtonAfter = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    expect(addButtonAfter.props.disabled).toBe(true);
  });
});

describe("AddToProjectDialog — generic failures never fabricate success", () => {
  it("internal_error shows a message, stays open, calls neither onStaleUnfiled nor onAssigned", async () => {
    const assign = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string | null]>(async () => ({
      status: "error",
      errorCode: "internal_error",
    }));
    const { renderer, onClose, onAssigned, onStaleUnfiled } = setup(fakeAssociation({ assign }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    await act(async () => {
      await addButton.props.onClick();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onAssigned).not.toHaveBeenCalled();
    expect(onStaleUnfiled).not.toHaveBeenCalled();
    const alert = renderer.root.findByProps({ role: "alert" });
    expect(alert.children.join("")).toBeTruthy();
  });
});

describe("AddToProjectDialog — pagination (spec item 10/30)", () => {
  it("hasMore=true shows Load more, wired to the chooser's own loadMore", () => {
    const loadMore = jest.fn();
    mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_A], hasMore: true, loadMore });
    const { renderer } = setup(fakeAssociation());
    const loadMoreButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Load more")!;
    act(() => loadMoreButton.props.onClick());
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
