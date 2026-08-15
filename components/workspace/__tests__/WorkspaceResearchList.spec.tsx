/**
 * Phase 5D — WorkspaceResearchList + `classifyWorkspaceRunsInitialError`/
 * `isEscalatedWorkspaceRunsError`. Renders via `renderToStaticMarkup` (no
 * jsdom), matching this repo's established convention.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkspaceResearchList,
  classifyWorkspaceRunsInitialError,
  isEscalatedWorkspaceRunsError,
} from "@/components/workspace/WorkspaceResearchList";
import type { UseWorkspaceRunsResult, WorkspaceRunSummary, WorkspaceRunsErrorCode } from "@/hooks/useWorkspaceRuns";

function fakeRuns(overrides: Partial<UseWorkspaceRunsResult> = {}): UseWorkspaceRunsResult {
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

const ITEM_A: WorkspaceRunSummary = { id: "a", at: "2026-08-01T00:00:00.000Z", question: "Question A", selectedModels: ["chatgpt"] };
const ITEM_B: WorkspaceRunSummary = { id: "b", at: "2026-08-02T00:00:00.000Z", question: "Question B", selectedModels: ["chatgpt"] };

function render(result: UseWorkspaceRunsResult): string {
  return renderToStaticMarkup(createElement(WorkspaceResearchList, { result }));
}

describe("classifyWorkspaceRunsInitialError / isEscalatedWorkspaceRunsError", () => {
  const escalating: WorkspaceRunsErrorCode[] = ["workspace_missing", "workspace_invalid", "workspace_unavailable"];
  const sectionLocal: WorkspaceRunsErrorCode[] = ["unauthorized", "auth_error", "invalid_cursor", "index_required", "internal_error", "network_error"];

  it.each(escalating)("%s classifies as escalate", (code) => {
    expect(classifyWorkspaceRunsInitialError(code)).toBe("escalate");
    expect(isEscalatedWorkspaceRunsError(code)).toBe(true);
  });

  it.each(sectionLocal)("%s classifies as section-local", (code) => {
    expect(classifyWorkspaceRunsInitialError(code)).toBe("section-local");
    expect(isEscalatedWorkspaceRunsError(code)).toBe(false);
  });
});

describe("WorkspaceResearchList — loading", () => {
  it("shows a restrained loading message, no list, no empty state, no error", () => {
    const html = render(fakeRuns({ status: "loading" }));
    expect(html).toContain("Loading your research");
    expect(html).not.toContain("New research will appear here");
  });
});

describe("WorkspaceResearchList — escalated errors render nothing (parent's job)", () => {
  it.each(["workspace_missing", "workspace_invalid", "workspace_unavailable"] as const)("%s renders null, not a section-local error box", (code) => {
    const html = render(fakeRuns({ status: "error", initialErrorCode: code }));
    expect(html).toBe("");
  });
});

describe("WorkspaceResearchList — section-local initial errors", () => {
  it("unauthorized: no retry button (matches metadata's non-retryable session-loss treatment)", () => {
    const html = render(fakeRuns({ status: "error", initialErrorCode: "unauthorized" }));
    expect(html).toContain("Please sign in again");
    expect(html).not.toContain("Try again");
  });

  it("internal_error: retry button present", () => {
    const html = render(fakeRuns({ status: "error", initialErrorCode: "internal_error" }));
    expect(html).toContain("Try again");
  });
});

describe("WorkspaceResearchList — definitive empty-state condition [Revision 1]", () => {
  it("items=[] AND hasMore=false -> the single provenance-safe empty state", () => {
    const html = render(fakeRuns({ items: [], hasMore: false }));
    expect(html).toContain("New research will appear here.");
    expect(html).toContain("You can find all of your research in History.");
  });

  it("items=[] AND hasMore=true -> NEVER the empty state; Load more remains available", () => {
    const html = render(fakeRuns({ items: [], hasMore: true }));
    expect(html).not.toContain("New research will appear here.");
    expect(html).toContain("Load more");
  });

  it("items.length===0 alone (without checking hasMore) is never sufficient — status must also be 'ready'", () => {
    const html = render(fakeRuns({ status: "loading", items: [], hasMore: false }));
    expect(html).not.toContain("New research will appear here.");
  });

  it("populated list never shows the empty state even if hasMore happens to be false", () => {
    const html = render(fakeRuns({ items: [ITEM_A], hasMore: false }));
    expect(html).not.toContain("New research will appear here.");
    expect(html).toContain("Question A");
  });

  it("rejected copy never appears, even implicitly", () => {
    const html = render(fakeRuns({ items: [], hasMore: false }));
    expect(html.toLowerCase()).not.toMatch(/no research yet|you have no research|start your first research run|earlier research is in history/);
  });
});

describe("WorkspaceResearchList — populated list", () => {
  it("renders every item as a card, in order", () => {
    const html = render(fakeRuns({ items: [ITEM_A, ITEM_B] }));
    const posA = html.indexOf("Question A");
    const posB = html.indexOf("Question B");
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(posA);
  });
});

describe("WorkspaceResearchList — pagination control", () => {
  it("hasMore=true, no loadMoreErrorCode, not loading -> 'Load more' enabled", () => {
    const html = render(fakeRuns({ items: [ITEM_A], hasMore: true }));
    expect(html).toContain("Load more");
    expect(html).not.toContain("disabled=\"\"");
  });

  it("hasMore=true, loadingMore=true -> disabled 'Loading…' button, duplicate-click suppression", () => {
    const html = render(fakeRuns({ items: [ITEM_A], hasMore: true, loadingMore: true }));
    expect(html).toContain("Loading…");
    expect(html).toMatch(/disabled=""/);
  });

  it("hasMore=false -> no pagination control rendered at all", () => {
    const html = render(fakeRuns({ items: [ITEM_A], hasMore: false }));
    expect(html).not.toContain("Load more");
  });

  it("loadMoreErrorCode (non-cursor) -> 'Retry' action, existing rows preserved", () => {
    const html = render(fakeRuns({ items: [ITEM_A], hasMore: true, loadMoreErrorCode: "network_error" }));
    expect(html).toContain("Question A");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Reload");
  });

  it("loadMoreErrorCode invalid_cursor -> 'Reload' action, never the word 'cursor' shown to the user", () => {
    const html = render(fakeRuns({ items: [ITEM_A], hasMore: true, loadMoreErrorCode: "invalid_cursor" }));
    expect(html).toContain("Reload");
    expect(html.toLowerCase()).not.toMatch(/cursor/);
  });

  it("workspace_unavailable during Load more never reinterprets as an empty Workspace", () => {
    const html = render(fakeRuns({ items: [], hasMore: true, loadMoreErrorCode: "workspace_unavailable" }));
    expect(html).not.toContain("New research will appear here.");
    expect(html).toContain("Retry");
  });
});
