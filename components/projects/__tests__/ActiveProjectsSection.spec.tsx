/**
 * Phase 7C — ActiveProjectsSection. Renders via `renderToStaticMarkup` (no
 * jsdom), matching this repo's established convention (see
 * `WorkspaceResearchList.spec.tsx`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveProjectsSection } from "@/components/projects/ActiveProjectsSection";
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

const PROJECT_A: ProjectSummary = { id: "a", name: "Project A", status: "active", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
const PROJECT_B: ProjectSummary = { id: "b", name: "Project B", status: "active", createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" };

function render(result: UseProjectsResult): string {
  return renderToStaticMarkup(createElement(ActiveProjectsSection, { result }));
}

describe("ActiveProjectsSection — heading", () => {
  it("always renders the 'Active Projects' section heading", () => {
    expect(render(fakeResult())).toContain("Active Projects");
  });
});

describe("ActiveProjectsSection — loading", () => {
  it("shows a loading message, no list, no empty state, no error", () => {
    const html = render(fakeResult({ status: "loading" }));
    expect(html).toContain("Loading your Projects");
    expect(html).not.toContain("No active projects yet.");
  });
});

describe("ActiveProjectsSection — initial error (item 22: never fabricates empty)", () => {
  it("unauthorized: no retry button, and crucially never 'No active projects yet.'", () => {
    const html = render(fakeResult({ status: "error", initialErrorCode: "unauthorized" }));
    expect(html).toContain("Please sign in again");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("No active projects yet.");
  });

  it("internal_error: retry button present, never fabricates empty", () => {
    const html = render(fakeResult({ status: "error", initialErrorCode: "internal_error" }));
    expect(html).toContain("Try again");
    expect(html).not.toContain("No active projects yet.");
  });

  it("projects_disabled: section-local retryable error, not silently empty", () => {
    const html = render(fakeResult({ status: "error", initialErrorCode: "projects_disabled" }));
    expect(html).toContain("Try again");
    expect(html).not.toContain("No active projects yet.");
  });
});

describe("ActiveProjectsSection — definitive empty state", () => {
  it("items=[] AND hasMore=false -> 'No active projects yet.', no Create Project control", () => {
    const html = render(fakeResult({ items: [], hasMore: false }));
    expect(html).toContain("No active projects yet.");
    expect(html).not.toMatch(/create project/i);
  });

  it("items=[] AND hasMore=true -> never the empty state", () => {
    const html = render(fakeResult({ items: [], hasMore: true }));
    expect(html).not.toContain("No active projects yet.");
    expect(html).toContain("Load more");
  });

  it("loading with items=[] never shows the empty state", () => {
    const html = render(fakeResult({ status: "loading", items: [], hasMore: false }));
    expect(html).not.toContain("No active projects yet.");
  });
});

describe("ActiveProjectsSection — populated list", () => {
  it("renders every Project name, in order, as a plain read-only row (no link, no button)", () => {
    const html = render(fakeResult({ items: [PROJECT_A, PROJECT_B] }));
    const posA = html.indexOf("Project A");
    const posB = html.indexOf("Project B");
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(posA);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
  });

  it("never exposes workspaceId/createdByUserId even if present on the summary object", () => {
    const html = render(fakeResult({ items: [{ ...PROJECT_A, workspaceId: "personal-x", createdByUserId: "x" } as unknown as ProjectSummary] }));
    expect(html).not.toContain("workspaceId");
    expect(html).not.toContain("personal-x");
  });
});

describe("ActiveProjectsSection — pagination", () => {
  it("hasMore=true, not loading -> 'Load more' enabled", () => {
    const html = render(fakeResult({ items: [PROJECT_A], hasMore: true }));
    expect(html).toContain("Load more");
    expect(html).not.toContain('disabled=""');
  });

  it("hasMore=true, loadingMore=true -> disabled 'Loading…' button", () => {
    const html = render(fakeResult({ items: [PROJECT_A], hasMore: true, loadingMore: true }));
    expect(html).toContain("Loading…");
    expect(html).toMatch(/disabled=""/);
  });

  it("hasMore=false -> no pagination control at all", () => {
    const html = render(fakeResult({ items: [PROJECT_A], hasMore: false }));
    expect(html).not.toContain("Load more");
  });

  it("loadMoreErrorCode invalid_cursor -> 'Reload' action, never the word 'cursor'", () => {
    const html = render(fakeResult({ items: [PROJECT_A], hasMore: true, loadMoreErrorCode: "invalid_cursor" }));
    expect(html).toContain("Reload");
    expect(html.toLowerCase()).not.toMatch(/cursor/);
  });

  it("loadMoreErrorCode (non-cursor) -> 'Retry' action, existing rows preserved", () => {
    const html = render(fakeResult({ items: [PROJECT_A], hasMore: true, loadMoreErrorCode: "internal_error" }));
    expect(html).toContain("Project A");
    expect(html).toContain("Retry");
  });
});

describe("ActiveProjectsSection — no mutation controls anywhere (spec item 30)", () => {
  it.each(["New Project", "Rename", "Archive", "Restore", "Assign", "Move", "Unassign"])("never renders a %s control in any state", (label) => {
    for (const result of [fakeResult(), fakeResult({ status: "loading" }), fakeResult({ items: [PROJECT_A] }), fakeResult({ status: "error", initialErrorCode: "internal_error" })]) {
      expect(render(result)).not.toContain(label);
    }
  });
});
