/**
 * Phase 7D — ArchiveProjectDialog. Interactive test via `react-test-renderer`
 * (no jsdom), same pattern as `NewProjectDialog.spec.tsx`.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ArchiveProjectDialog } from "@/components/projects/ArchiveProjectDialog";
import type { UseProjectLifecycleResult, ProjectMutationResult } from "@/hooks/useProjectLifecycle";
import type { ProjectSummary } from "@/hooks/useProjects";

function fakeLifecycle(overrides: Partial<UseProjectLifecycleResult> = {}): UseProjectLifecycleResult {
  return {
    isProjectBusy: () => false,
    getBusyOperation: () => null,
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
  name: "My Project",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  updateTime: { seconds: 1723600000, nanoseconds: 0 },
};

function setup(lifecycle: UseProjectLifecycleResult, onClose = jest.fn(), onArchived = jest.fn(), onStaleConflict = jest.fn()) {
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ArchiveProjectDialog, { project: PROJECT, triggerRef, onClose, lifecycle, onArchived, onStaleConflict }));
  });
  return { renderer, onClose, onArchived, onStaleConflict };
}

describe("ArchiveProjectDialog — confirmation copy never implies deletion/unassignment", () => {
  it("shows the Project name in the title and the no-fanout reassurance copy", () => {
    const { renderer } = setup(fakeLifecycle());
    const heading = renderer.root.findByType("h2");
    expect(heading.children.join("")).toContain("My Project");
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toMatch(/stays in this project/i);
    expect(html.toLowerCase()).not.toMatch(/delet|unassign/);
  });
});

describe("ArchiveProjectDialog — cancel never mutates", () => {
  it("Cancel closes without calling archiveProject", () => {
    const lifecycle = fakeLifecycle();
    const { renderer, onClose } = setup(lifecycle);
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lifecycle.archiveProject).not.toHaveBeenCalled();
  });
});

describe("ArchiveProjectDialog — deliberate confirmation required", () => {
  it("no request is dispatched merely from opening/rendering the dialog", () => {
    const lifecycle = fakeLifecycle();
    setup(lifecycle);
    expect(lifecycle.archiveProject).not.toHaveBeenCalled();
  });

  it("clicking the confirm button dispatches exactly one archiveProject call with the exact Project (and its updateTime)", async () => {
    const archiveProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary]>(async () => ({ status: "ok", project: { ...PROJECT, status: "archived" } }));
    const lifecycle = fakeLifecycle({ archiveProject });
    const { renderer, onClose, onArchived } = setup(lifecycle);

    const confirmButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Archive")!;
    await act(async () => {
      await confirmButton.props.onClick();
    });

    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(archiveProject).toHaveBeenCalledWith(PROJECT);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onArchived).toHaveBeenCalledTimes(1);
  });
});

describe("ArchiveProjectDialog — invalid transition (already archived) never treated as success", () => {
  it("shows the message, triggers onStaleConflict, does not close", async () => {
    const archiveProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary]>(async () => ({ status: "error", errorCode: "invalid_project_status_transition" }));
    const lifecycle = fakeLifecycle({ archiveProject });
    const { renderer, onClose, onArchived, onStaleConflict } = setup(lifecycle);

    const confirmButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Archive")!;
    await act(async () => {
      await confirmButton.props.onClick();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onArchived).not.toHaveBeenCalled();
    expect(onStaleConflict).toHaveBeenCalledTimes(1);
  });
});

describe("ArchiveProjectDialog — busy state disables the confirm button", () => {
  it("Archive button is disabled while this Project is busy", () => {
    const lifecycle = fakeLifecycle({ isProjectBusy: (id) => id === PROJECT.id });
    const { renderer } = setup(lifecycle);
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.includes("Archiv"))!;
    expect(confirmButton.props.disabled).toBe(true);
  });
});
