/**
 * Phase 7E-B — AssignedRunActions. Focused on the trigger + dialog-open
 * wiring (mirrors `UnfiledRunAssignAction.spec.tsx`'s scope). Move/Remove
 * dialogs themselves are exercised in their own dedicated specs.
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

import { AssignedRunActions } from "@/components/projects/AssignedRunActions";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
import type { ProjectRunSummary } from "@/hooks/useProjectRuns";

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

const P1 = "proj-source";
const RUN: ProjectRunSummary = { id: "run-1", at: "2026-08-01T00:00:00.000Z", question: "Assigned question", selectedModels: ["chatgpt"], projectId: P1 };

function setup(association: UseRunProjectAssociationResult, onMoved = jest.fn(), onRemoved = jest.fn(), onStaleAssociation = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(AssignedRunActions, { run: RUN, sourceProjectId: P1, association, onMoved, onRemoved, onStaleAssociation }));
  });
  return { renderer, onMoved, onRemoved, onStaleAssociation };
}

beforeEach(() => {
  mockUseProjectsReturn = fakeProjectsResult();
});

describe("AssignedRunActions — triggers", () => {
  it("renders exactly Move and Remove from project, no dialog until clicked", () => {
    const { renderer } = setup(fakeAssociation());
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map((b) => b.props.children)).toEqual(["Move", "Remove from project"]);
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
  });

  it("never renders 'Add to project' on an assigned row", () => {
    const { renderer } = setup(fakeAssociation());
    const buttons = renderer.root.findAllByType("button").map((b) => b.props.children);
    expect(buttons).not.toContain("Add to project");
  });

  it("clicking Move opens the Move dialog", () => {
    const { renderer } = setup(fakeAssociation());
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    act(() => trigger.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.findByType("h2").children.join("")).toBe("Move to project");
  });

  it("clicking Remove from project opens the Remove confirmation dialog", () => {
    const { renderer } = setup(fakeAssociation());
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    act(() => trigger.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.findByType("h2").children.join("")).toBe("Remove from project?");
  });

  it("busy disables both triggers, with STATIC labels — neither ever shows a busy verb (spec item 31)", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: () => true, getBusyOperation: () => "move" }));
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    const removeButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    expect(moveButton.props.disabled).toBe(true);
    expect(removeButton.props.disabled).toBe(true);
    // MUTATION-TARGETED: labels never change based on busy state — proves
    // neither trigger could ever falsely claim the other's operation.
    expect(moveButton.props.children).toBe("Move");
    expect(removeButton.props.children).toBe("Remove from project");
  });

  it("isRunBusy for a DIFFERENT run never disables this run's triggers", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: (id) => id === "some-other-run" }));
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    expect(moveButton.props.disabled).toBe(false);
  });
});

describe("AssignedRunActions — Cancel closes without side effects", () => {
  it("Move dialog Cancel calls neither onMoved nor onStaleAssociation", () => {
    const { renderer, onMoved, onStaleAssociation } = setup(fakeAssociation());
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    act(() => trigger.props.onClick());
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
    expect(onMoved).not.toHaveBeenCalled();
    expect(onStaleAssociation).not.toHaveBeenCalled();
  });

  it("Remove dialog Cancel calls neither onRemoved nor onStaleAssociation", () => {
    const { renderer, onRemoved, onStaleAssociation } = setup(fakeAssociation());
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    act(() => trigger.props.onClick());
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onStaleAssociation).not.toHaveBeenCalled();
  });
});

describe("AssignedRunActions — success forwards through and closes", () => {
  it("a successful Move closes the dialog and calls onMoved with the target Project's name", async () => {
    mockUseProjectsReturn = fakeProjectsResult({
      items: [{ id: "proj-2", name: "Project Two", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }],
    });
    const move = jest.fn(async () => ({ status: "ok" as const, runId: "run-1", projectId: "proj-2" }));
    const { renderer, onMoved } = setup(fakeAssociation({ move }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    act(() => trigger.props.onClick());
    const dialog1 = renderer.root.findByProps({ role: "dialog" });
    const option = dialog1.findByProps({ role: "option" });
    act(() => option.props.onClick());
    const dialog2 = renderer.root.findByProps({ role: "dialog" });
    const moveButton = dialog2.findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveButton.props.onClick();
    });
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
    expect(onMoved).toHaveBeenCalledWith("Project Two");
  });

  it("a successful Remove closes the dialog and calls onRemoved", async () => {
    const remove = jest.fn(async () => ({ status: "ok" as const, runId: "run-1", projectId: null }));
    const { renderer, onRemoved } = setup(fakeAssociation({ remove }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    act(() => trigger.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    const confirmButton = dialog.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });
    expect(() => renderer.root.findByProps({ role: "dialog" })).toThrow();
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});

describe("AssignedRunActions — stale-source bubbles onStaleAssociation without closing", () => {
  it("Move: run_not_found calls onStaleAssociation, keeps the dialog open", async () => {
    mockUseProjectsReturn = fakeProjectsResult({
      items: [{ id: "proj-2", name: "Project Two", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }],
    });
    const move = jest.fn(async () => ({ status: "error" as const, errorCode: "run_not_found" as const }));
    const { renderer, onStaleAssociation } = setup(fakeAssociation({ move }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    act(() => trigger.props.onClick());
    const dialog1 = renderer.root.findByProps({ role: "dialog" });
    const option = dialog1.findByProps({ role: "option" });
    act(() => option.props.onClick());
    const dialog2 = renderer.root.findByProps({ role: "dialog" });
    const moveButton = dialog2.findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveButton.props.onClick();
    });
    expect(onStaleAssociation).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ role: "dialog" })).toBeTruthy();
  });

  it("Remove: run_not_found calls onStaleAssociation, keeps the dialog open", async () => {
    const remove = jest.fn(async () => ({ status: "error" as const, errorCode: "run_not_found" as const }));
    const { renderer, onStaleAssociation } = setup(fakeAssociation({ remove }));
    const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    act(() => trigger.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    const confirmButton = dialog.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });
    expect(onStaleAssociation).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ role: "dialog" })).toBeTruthy();
  });
});
