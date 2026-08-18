/**
 * Phase 7C — ArchivedProjectsSection. Renders via `renderToStaticMarkup`.
 * Structural mirror of ActiveProjectsSection.spec.tsx, with the additional
 * explicit "no Restore control" contract (spec item 10).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchivedProjectsSection } from "@/components/projects/ArchivedProjectsSection";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";

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
    ...overrides,
  };
}

const PROJECT_A: ProjectSummary = { id: "a", name: "Archived Project A", status: "archived", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };

function render(result: UseProjectsResult): string {
  return renderToStaticMarkup(createElement(ArchivedProjectsSection, { result }));
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
  it("renders archived Project names as plain read-only rows", () => {
    const html = render(fakeResult({ items: [PROJECT_A] }));
    expect(html).toContain("Archived Project A");
  });
});

describe("ArchivedProjectsSection — SECURITY: no Restore control anywhere in this phase (spec item 10/30)", () => {
  // "Archive" is deliberately excluded from this list — the section's own
  // heading "Archived Projects" legitimately contains that substring; a
  // literal-substring check would false-positive on copy, not a control.
  it.each(["Restore", "New Project", "Rename", "Assign", "Move", "Unassign"])("never renders a %s control in any state", (label) => {
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
