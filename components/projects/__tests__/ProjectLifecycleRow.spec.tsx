/**
 * Phase 7D — ProjectLifecycleRow. Focused on the Restore path specifically
 * (the one lifecycle action with no confirmation dialog — spec item 14) and
 * variant-based control visibility. Rename/Archive dialog behavior itself
 * is covered by `RenameProjectDialog.spec.tsx`/`ArchiveProjectDialog.spec.tsx`.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ProjectLifecycleRow } from "@/components/projects/ProjectLifecycleRow";
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

const ACTIVE_PROJECT: ProjectSummary = {
  id: "proj-1",
  name: "Active One",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  updateTime: { seconds: 1723600000, nanoseconds: 0 },
};

const ARCHIVED_PROJECT: ProjectSummary = { ...ACTIVE_PROJECT, id: "proj-2", name: "Archived One", status: "archived" };

function setup(project: ProjectSummary, variant: "active" | "archived", lifecycle: UseProjectLifecycleResult, onRenamed = jest.fn(), refreshSections = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ProjectLifecycleRow, { project, variant, lifecycle, onRenamed, refreshSections }));
  });
  return { renderer, onRenamed, refreshSections };
}

describe("ProjectLifecycleRow — variant-based control visibility", () => {
  it("active variant: Rename + Archive, never Restore", () => {
    const { renderer } = setup(ACTIVE_PROJECT, "active", fakeLifecycle());
    const labels = renderer.root.findAllByType("button").map((b) => b.props.children);
    expect(labels).toContain("Rename");
    expect(labels).toContain("Archive");
    expect(labels.join("")).not.toMatch(/Restore/);
  });

  it("archived variant: Rename + Restore, never Archive", () => {
    const { renderer } = setup(ARCHIVED_PROJECT, "archived", fakeLifecycle());
    const labels = renderer.root.findAllByType("button").map((b) => (typeof b.props.children === "string" ? b.props.children : b.props.children?.join?.("")));
    expect(labels).toContain("Rename");
    expect(labels.some((l) => l === "Restore")).toBe(true);
    expect(labels.some((l) => l === "Archive")).toBe(false);
  });
});

describe("ProjectLifecycleRow — Restore has no confirmation dialog, dispatches directly on click", () => {
  it("clicking Restore calls restoreProject exactly once with the exact Project, then refreshSections on success", async () => {
    const restoreProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary]>(async () => ({ status: "ok", project: { ...ARCHIVED_PROJECT, status: "active" } }));
    const lifecycle = fakeLifecycle({ restoreProject });
    const { renderer, refreshSections } = setup(ARCHIVED_PROJECT, "archived", lifecycle);

    const restoreButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Restore")!;
    await act(async () => {
      await restoreButton.props.onClick();
    });

    expect(restoreProject).toHaveBeenCalledTimes(1);
    expect(restoreProject).toHaveBeenCalledWith(ARCHIVED_PROJECT);
    expect(refreshSections).toHaveBeenCalledTimes(1);
  });

  it("a stale conflict on Restore shows an inline error and still triggers refreshSections, never treated as success", async () => {
    const restoreProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary]>(async () => ({ status: "error", errorCode: "conflict" }));
    const lifecycle = fakeLifecycle({ restoreProject });
    const { renderer, refreshSections } = setup(ARCHIVED_PROJECT, "archived", lifecycle);

    const restoreButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Restore")!;
    await act(async () => {
      await restoreButton.props.onClick();
    });

    expect(refreshSections).toHaveBeenCalledTimes(1); // stale -> read refresh, not a retry
    const alert = renderer.root.findByProps({ role: "alert" });
    expect(alert.children.join("")).toMatch(/changed/i);
  });

  it("a non-stale Restore error does NOT trigger refreshSections", async () => {
    const restoreProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary]>(async () => ({ status: "error", errorCode: "internal_error" }));
    const lifecycle = fakeLifecycle({ restoreProject });
    const { refreshSections } = setup(ARCHIVED_PROJECT, "archived", lifecycle);
    const renderer = TestRenderer.create(createElement(ProjectLifecycleRow, { project: ARCHIVED_PROJECT, variant: "archived", lifecycle, onRenamed: jest.fn(), refreshSections }));
    const restoreButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Restore")!;
    await act(async () => {
      await restoreButton.props.onClick();
    });
    expect(refreshSections).not.toHaveBeenCalled();
  });

  it("archived Project idle: Restore button is enabled and reads exactly \"Restore\"", () => {
    const lifecycle = fakeLifecycle();
    const { renderer } = setup(ARCHIVED_PROJECT, "archived", lifecycle);
    const restoreButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.includes("Restor"))!;
    expect(restoreButton.props.disabled).toBe(false);
    expect(restoreButton.props.children).toBe("Restore");
  });

  it("Phase 7D.3B regression — archived Project rename in flight: Restore is disabled but its label must stay \"Restore\", never \"Restoring…\"", () => {
    // The shared per-Project lock is held (isProjectBusy true) by a Rename,
    // not a Restore — getBusyOperation must be consulted for the label, not
    // isProjectBusy alone, or the Restore button falsely claims to be the
    // operation that's actually running.
    const lifecycle = fakeLifecycle({
      isProjectBusy: (id) => id === ARCHIVED_PROJECT.id,
      getBusyOperation: (id) => (id === ARCHIVED_PROJECT.id ? "rename" : null),
    });
    const { renderer } = setup(ARCHIVED_PROJECT, "archived", lifecycle);
    const restoreButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.includes("Restor"))!;
    expect(restoreButton.props.disabled).toBe(true);
    expect(restoreButton.props.children).toBe("Restore");
  });

  it("archived Project restore in flight: Restore is disabled and its label is \"Restoring…\"", () => {
    const lifecycle = fakeLifecycle({
      isProjectBusy: (id) => id === ARCHIVED_PROJECT.id,
      getBusyOperation: (id) => (id === ARCHIVED_PROJECT.id ? "restore" : null),
    });
    const { renderer } = setup(ARCHIVED_PROJECT, "archived", lifecycle);
    const restoreButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.includes("Restor"))!;
    expect(restoreButton.props.disabled).toBe(true);
    expect(restoreButton.props.children).toBe("Restoring…");
  });

  it("a busy Restore click is a no-op (defensive — button is disabled, but guard exists regardless)", async () => {
    const restoreProject = jest.fn<Promise<ProjectMutationResult>, [ProjectSummary]>(async () => ({ status: "ok", project: { ...ARCHIVED_PROJECT, status: "active" } }));
    const lifecycle = fakeLifecycle({ restoreProject, isProjectBusy: () => true });
    const { renderer } = setup(ARCHIVED_PROJECT, "archived", lifecycle);
    const restoreButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.includes("Restor"))!;
    await act(async () => {
      await restoreButton.props.onClick();
    });
    expect(restoreProject).not.toHaveBeenCalled();
  });
});

describe("ProjectLifecycleRow — Phase 7D.3B: active-side equivalent has no analogous defect (protective regression)", () => {
  it("active Project rename in flight: Archive trigger is disabled but its label stays exactly \"Archive\", never a false archiving-progress claim", () => {
    const lifecycle = fakeLifecycle({
      isProjectBusy: (id) => id === ACTIVE_PROJECT.id,
      getBusyOperation: (id) => (id === ACTIVE_PROJECT.id ? "rename" : null),
    });
    const { renderer } = setup(ACTIVE_PROJECT, "active", lifecycle);
    const archiveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Archive")!;
    expect(archiveButton.props.disabled).toBe(true);
    expect(archiveButton.props.children).toBe("Archive");
  });
});
