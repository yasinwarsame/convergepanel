/**
 * Phase 7D — RenameProjectDialog. Interactive test via `react-test-renderer`
 * (no jsdom), same pattern as `NewProjectDialog.spec.tsx`.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { RenameProjectDialog } from "@/components/projects/RenameProjectDialog";
import type { UseProjectLifecycleResult, ProjectMutationResult } from "@/hooks/useProjectLifecycle";
import type { ProjectSummary } from "@/hooks/useProjects";

function fakeLifecycle(overrides: Partial<UseProjectLifecycleResult> = {}): UseProjectLifecycleResult {
  return {
    isProjectBusy: () => false,
    isCreating: false,
    createProject: jest.fn(),
    renameProject: jest.fn(),
    archiveProject: jest.fn(),
    restoreProject: jest.fn(),
    ...overrides,
  };
}

const PROJECT: ProjectSummary = {
  id: "proj-1",
  name: "Original Name",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  updateTime: { seconds: 1723600000, nanoseconds: 0 },
};

function setup(lifecycle: UseProjectLifecycleResult, onClose = jest.fn(), onRenamed = jest.fn(), onStaleConflict = jest.fn()) {
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(RenameProjectDialog, { project: PROJECT, triggerRef, onClose, lifecycle, onRenamed, onStaleConflict }));
  });
  return { renderer, onClose, onRenamed, onStaleConflict };
}

describe("RenameProjectDialog — pre-fills current name", () => {
  it("input's initial value is the Project's current name", () => {
    const { renderer } = setup(fakeLifecycle());
    const input = renderer.root.findByType("input");
    expect(input.props.value).toBe("Original Name");
  });
});

describe("RenameProjectDialog — cancel never mutates", () => {
  it("Cancel closes without calling renameProject", () => {
    const lifecycle = fakeLifecycle();
    const { renderer, onClose } = setup(lifecycle);
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lifecycle.renameProject).not.toHaveBeenCalled();
  });
});

describe("RenameProjectDialog — valid submit adopts the fresh token", () => {
  it("submits exactly once and calls onRenamed with the canonical returned Project (fresh updateTime, not the original)", async () => {
    const FRESH = { seconds: 1723600999, nanoseconds: 42 };
    const renameProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary, string]>(async () => ({
      status: "ok",
      project: { ...PROJECT, name: "New Name", updateTime: FRESH },
    }));
    const lifecycle = fakeLifecycle({ renameProject });
    const { renderer, onClose, onRenamed } = setup(lifecycle);

    const input = renderer.root.findByType("input");
    act(() => input.props.onChange({ target: { value: "New Name" } }));

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(renameProject).toHaveBeenCalledTimes(1);
    expect(renameProject).toHaveBeenCalledWith(PROJECT, "New Name");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRenamed).toHaveBeenCalledWith(expect.objectContaining({ updateTime: FRESH }));
  });
});

describe("RenameProjectDialog — stale conflict never auto-retries", () => {
  it("a conflict error shows the message, triggers onStaleConflict, and does NOT close or call onRenamed", async () => {
    const renameProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary, string]>(async () => ({ status: "error", errorCode: "conflict" }));
    const lifecycle = fakeLifecycle({ renameProject });
    const { renderer, onClose, onRenamed, onStaleConflict } = setup(lifecycle);

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(renameProject).toHaveBeenCalledTimes(1); // exactly once — never auto-retried
    expect(onClose).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    expect(onStaleConflict).toHaveBeenCalledTimes(1);
    const alert = renderer.root.findByProps({ role: "alert" });
    expect(alert.children.join("")).toMatch(/changed/i);
  });

  it("a non-stale error (e.g. invalid_project_name) does NOT trigger onStaleConflict", async () => {
    const renameProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary, string]>(async () => ({ status: "error", errorCode: "invalid_project_name" }));
    const lifecycle = fakeLifecycle({ renameProject });
    const { renderer, onStaleConflict } = setup(lifecycle);

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(onStaleConflict).not.toHaveBeenCalled();
  });
});

describe("RenameProjectDialog — busy state disables submit", () => {
  it("Submit is disabled while lifecycle reports this Project as busy", () => {
    const lifecycle = fakeLifecycle({ isProjectBusy: (id) => id === PROJECT.id });
    const { renderer } = setup(lifecycle);
    const submitButton = renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;
    expect(submitButton.props.disabled).toBe(true);
  });
});
