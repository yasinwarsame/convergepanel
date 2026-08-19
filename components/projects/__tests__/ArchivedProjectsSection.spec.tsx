/**
 * Phase 7C — ArchivedProjectsSection. Renders via `renderToStaticMarkup`.
 * Structural mirror of ActiveProjectsSection.spec.tsx. Phase 7D updates
 * the mutation-control contract: Rename + Restore now render; Archive and
 * "New Project" never do (spec item 14/23/30).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchivedProjectsSection } from "@/components/projects/ArchivedProjectsSection";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";

function fakeResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
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

const UPDATE_TIME = { seconds: 1723600000, nanoseconds: 0 };
const PROJECT_A: ProjectSummary = {
  id: "a",
  name: "Archived Project A",
  status: "archived",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  updateTime: UPDATE_TIME,
};

function render(
  result: UseProjectsResult,
  overrides: { lifecycle?: UseProjectLifecycleResult; onRenamed?: (p: ProjectSummary) => void; refreshSections?: () => void } = {}
): string {
  return renderToStaticMarkup(
    createElement(ArchivedProjectsSection, {
      result,
      lifecycle: overrides.lifecycle ?? fakeLifecycle(),
      onRenamed: overrides.onRenamed ?? jest.fn(),
      refreshSections: overrides.refreshSections ?? jest.fn(),
    })
  );
}

describe("ArchivedProjectsSection — heading", () => {
  it("always renders the 'Archived Projects' section heading", () => {
    expect(render(fakeResult())).toContain("Archived Projects");
  });
});

describe("ArchivedProjectsSection — definitive empty state", () => {
  it("items=[] AND hasMore=false -> 'No archived projects.'", () => {
    const html = render(fakeResult({ items: [], hasMore: false }));
    expect(html).toContain("No archived projects.");
  });

  it("items=[] AND hasMore=true -> never the empty state", () => {
    const html = render(fakeResult({ items: [], hasMore: true }));
    expect(html).not.toContain("No archived projects.");
  });

  it("initial error never fabricates 'No archived projects.'", () => {
    const html = render(fakeResult({ status: "error", initialErrorCode: "internal_error" }));
    expect(html).not.toContain("No archived projects.");
    expect(html).toContain("Try again");
  });
});

describe("ArchivedProjectsSection — populated list", () => {
  it("renders archived Project names, never as a clickable link (no Project detail route yet)", () => {
    const html = render(fakeResult({ items: [PROJECT_A] }));
    expect(html).toContain("Archived Project A");
    expect(html).not.toContain("<a ");
  });
});

describe("ArchivedProjectsSection — Phase 7D lifecycle controls: Rename + Restore, never Archive/New Project/run-association (spec item 14/23/28/30)", () => {
  it("Rename and Restore render for a populated row; Archive never does", () => {
    const html = render(fakeResult({ items: [PROJECT_A] }));
    expect(html).toContain("Rename");
    expect(html).toContain("Restore");
    // "Archive" is deliberately excluded from a literal-substring assertion
    // — this section's own error copy legitimately contains it ("Couldn't
    // load your archived Projects...") is fine, but we assert no Archive
    // *button* text appears by checking there is no button literally
    // labeled "Archive" (as opposed to "Archived Projects" heading text).
    expect(html).not.toMatch(/>Archive</);
  });

  it("'New Project' trigger never renders in the Archived section", () => {
    for (const result of [fakeResult(), fakeResult({ status: "loading" }), fakeResult({ items: [PROJECT_A] }), fakeResult({ status: "error", initialErrorCode: "internal_error" })]) {
      expect(render(result)).not.toContain("New Project");
    }
  });

  it.each(["Assign", "Move", "Unassign", "Move to Project"])("never renders a %s control (run association is out of scope for Phase 7D)", (label) => {
    for (const result of [fakeResult(), fakeResult({ status: "loading" }), fakeResult({ items: [PROJECT_A] }), fakeResult({ status: "error", initialErrorCode: "internal_error" })]) {
      expect(render(result)).not.toContain(label);
    }
  });
});

describe("ArchivedProjectsSection — pagination", () => {
  it("hasMore=false -> no pagination control", () => {
    expect(render(fakeResult({ items: [PROJECT_A], hasMore: false }))).not.toContain("Load more");
  });

  it("hasMore=true -> 'Load more' present", () => {
    expect(render(fakeResult({ items: [PROJECT_A], hasMore: true }))).toContain("Load more");
  });
});
