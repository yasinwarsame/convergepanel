/**
 * Phase 7E-A — UnfiledRunAssignAction. Focused on the trigger + dialog-open
 * wiring (mirrors `ProjectLifecycleRow.spec.tsx`'s scope for its own
 * trigger buttons). `AddToProjectDialog` itself is exercised in its own
 * dedicated spec, not re-tested here — this file only proves the trigger
 * renders/opens/closes it and forwards success/stale callbacks correctly.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { UseProjectsResult } from "@/hooks/useProjects";

let mockUseProjectsReturn: UseProjectsResult;
jest.mock("@/hooks/useProjects", () => {
  const actual = jest.requireActual("@/hooks/useProjects");
  return {
    ...actual,
    useProjects: () => mockUseProjectsReturn,
  };
});

import { UnfiledRunAssignAction } from "@/components/projects/UnfiledRunAssignAction";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
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
    assign: jest.fn(),
    ...overrides,
  };
}

const RUN: ProjectRunSummary = { id: "run-1", at: "2026-08-01T00:00:00.000Z", question: "Unfiled question", selectedModels: ["chatgpt"], projectId: null };

function setup(association: UseRunProjectAssociationResult, onAssignSuccess = jest.fn(), onStaleUnfiled = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(UnfiledRunAssignAction, { run: RUN, association, onAssignSuccess, onStaleUnfiled }));
  });
  return { renderer, onAssignSuccess, onStaleUnfiled };
}

beforeEach(() => {
  mockUseProjectsReturn = fakeProjectsResult();
});

describe("UnfiledRunAssignAction — trigger", () => {
  it("renders exactly one 'Add to project' button, no dialog until clicked", () => {
    const { renderer } = setup(fakeAssociation());
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((b) => b.props.children)).toEqual(["Add to project"]);
    // ProjectDialogFrame renders a role="dialog" element — absent until opened.
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
  });

  it("clicking the trigger opens the dialog", () => {
    const { renderer } = setup(fakeAssociation());
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Add to project")!;
    act(() => trigger.props.onClick());
    expect(renderer.root.findByProps({ role: "dialog" })).toBeTruthy();
  });

  it("busy (isRunBusy true for this run) disables the trigger", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: (id) => id === RUN.id }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Add to project")!;
    expect(trigger.props.disabled).toBe(true);
  });

  it("isRunBusy for a DIFFERENT run id never disables this run's trigger", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: (id) => id === "some-other-run" }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Add to project")!;
    expect(trigger.props.disabled).toBe(false);
  });
});

describe("UnfiledRunAssignAction — Cancel closes without side effects", () => {
  it("Cancel closes the dialog, calling neither onAssignSuccess nor onStaleUnfiled", () => {
    const { renderer, onAssignSuccess, onStaleUnfiled } = setup(fakeAssociation());
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Add to project")!;
    act(() => trigger.props.onClick());
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
    expect(onAssignSuccess).not.toHaveBeenCalled();
    expect(onStaleUnfiled).not.toHaveBeenCalled();
  });
});

describe("UnfiledRunAssignAction — success forwards the Project name and closes", () => {
  it("a successful Add closes the dialog and calls onAssignSuccess with the Project name", async () => {
    mockUseProjectsReturn = fakeProjectsResult({
      items: [{ id: "proj-a", name: "Project A", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }],
    });
    const assign = jest.fn(async () => ({ status: "ok" as const, runId: "run-1", projectId: "proj-a" }));
    const { renderer, onAssignSuccess } = setup(fakeAssociation({ assign }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Add to project")!;
    act(() => trigger.props.onClick());
    const option = renderer.root.findByProps({ role: "option" });
    act(() => option.props.onClick());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    await act(async () => {
      await addButton.props.onClick();
    });
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
    expect(onAssignSuccess).toHaveBeenCalledWith("Project A");
  });
});

describe("UnfiledRunAssignAction — stale-Unfiled bubbles onStaleUnfiled without closing", () => {
  it("run_not_found calls onStaleUnfiled, keeps the dialog open", async () => {
    mockUseProjectsReturn = fakeProjectsResult({
      items: [{ id: "proj-a", name: "Project A", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }],
    });
    const assign = jest.fn(async () => ({ status: "error" as const, errorCode: "run_not_found" as const }));
    const { renderer, onStaleUnfiled } = setup(fakeAssociation({ assign }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Add to project")!;
    act(() => trigger.props.onClick());
    const option = renderer.root.findByProps({ role: "option" });
    act(() => option.props.onClick());
    const addButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Add")!;
    await act(async () => {
      await addButton.props.onClick();
    });
    expect(onStaleUnfiled).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ role: "dialog" })).toBeTruthy(); // still open
  });
});
