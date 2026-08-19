/**
 * Phase 7C — ProjectsShellView. Renders via `renderToStaticMarkup`, prop-
 * driven exactly like `WorkspaceShellView`'s own test convention. Confirms
 * the heading renders unconditionally (no page-level loading gate,
 * unlike Workspace, which has no separate metadata call here to escalate
 * against — see the shell's own doc comment) and that all three sections
 * are independently wired and ordered Active -> Unfiled -> Archived.
 *
 * Phase 7D adds the lifecycle hook + reconciliation handlers as required
 * props.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectsShellView } from "@/components/projects/ProjectsShell";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";
import type { UseUnfiledRunsResult, ProjectRunSummary } from "@/hooks/useUnfiledRuns";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

function fakeProjects(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
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

function fakeUnfiled(overrides: Partial<UseUnfiledRunsResult> = {}): UseUnfiledRunsResult {
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

const UPDATE_TIME = { seconds: 1723600000, nanoseconds: 0 };
const ACTIVE_PROJECT: ProjectSummary = { id: "p1", name: "My Active Project", status: "active", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", updateTime: UPDATE_TIME };
const ARCHIVED_PROJECT: ProjectSummary = { id: "p2", name: "My Archived Project", status: "archived", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", updateTime: UPDATE_TIME };
const UNFILED_RUN: ProjectRunSummary = { id: "r1", at: "2026-08-01T00:00:00.000Z", question: "My Unfiled Question", selectedModels: ["chatgpt"], projectId: null };

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

function render(active: UseProjectsResult, unfiled: UseUnfiledRunsResult, archived: UseProjectsResult): string {
  return renderToStaticMarkup(
    createElement(ProjectsShellView, {
      active,
      unfiled,
      archived,
      lifecycle: fakeLifecycle(),
      association: fakeAssociation(),
      onCreated: jest.fn(),
      onRenamed: jest.fn(),
      refreshSections: jest.fn(),
      onRunAssigned: jest.fn(),
    })
  );
}

describe("ProjectsShellView — heading renders unconditionally", () => {
  it("heading and copy render even while every section is still loading", () => {
    const html = render(fakeProjects({ status: "loading" }), fakeUnfiled({ status: "loading" }), fakeProjects({ status: "loading" }));
    expect(html).toContain("Projects");
    expect(html).toContain("Organize your Workspace research into projects.");
  });

  it("heading and copy render even when every section errors", () => {
    const html = render(
      fakeProjects({ status: "error", initialErrorCode: "internal_error" }),
      fakeUnfiled({ status: "error", initialErrorCode: "internal_error" }),
      fakeProjects({ status: "error", initialErrorCode: "internal_error" })
    );
    expect(html).toContain("Projects");
    expect(html).toContain("Organize your Workspace research into projects.");
  });
});

describe("ProjectsShellView — section order (spec item 7): Active -> Unfiled -> Archived", () => {
  it("all three headings appear in the preferred order", () => {
    const html = render(fakeProjects(), fakeUnfiled(), fakeProjects());
    const posActive = html.indexOf("Active Projects");
    const posUnfiled = html.indexOf(">Unfiled<");
    const posArchived = html.indexOf("Archived Projects");
    expect(posActive).toBeGreaterThan(-1);
    expect(posUnfiled).toBeGreaterThan(posActive);
    expect(posArchived).toBeGreaterThan(posUnfiled);
  });
});

describe("ProjectsShellView — independent section state (spec item 21/22)", () => {
  it("one section's error does not affect another section's success rendering", () => {
    const html = render(fakeProjects({ status: "error", initialErrorCode: "internal_error" }), fakeUnfiled({ items: [UNFILED_RUN] }), fakeProjects({ items: [ARCHIVED_PROJECT] }));
    expect(html).toContain("My Unfiled Question");
    expect(html).toContain("My Archived Project");
    expect(html).toContain("Try again"); // the Active section's own error
  });

  it("each section renders its own populated data independently", () => {
    const html = render(fakeProjects({ items: [ACTIVE_PROJECT] }), fakeUnfiled({ items: [UNFILED_RUN] }), fakeProjects({ items: [ARCHIVED_PROJECT] }));
    expect(html).toContain("My Active Project");
    expect(html).toContain("My Unfiled Question");
    expect(html).toContain("My Archived Project");
  });
});

describe("ProjectsShellView — no data rendered until each section's own hook resolves (never fabricated)", () => {
  it("all sections loading -> zero project/run content rendered anywhere", () => {
    const html = render(fakeProjects({ status: "loading" }), fakeUnfiled({ status: "loading" }), fakeProjects({ status: "loading" }));
    expect(html).not.toContain("My Active Project");
    expect(html).not.toContain("My Unfiled Question");
    expect(html).not.toContain("My Archived Project");
  });
});

describe("ProjectsShellView — Phase 7D: New Project trigger present, reachable from the shell", () => {
  it("'New Project' renders as part of the Active section", () => {
    const html = render(fakeProjects(), fakeUnfiled(), fakeProjects());
    expect(html).toContain("New Project");
  });
});
