/**
 * Phase 7C — UnfiledResearchSection. Renders via `renderToStaticMarkup`.
 * Confirms genuine reuse of `WorkspaceRunCard` (canonical report link,
 * governance chip) rather than a duplicate card implementation.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UnfiledResearchSection } from "@/components/projects/UnfiledResearchSection";
import type { UseUnfiledRunsResult, ProjectRunSummary } from "@/hooks/useUnfiledRuns";

function fakeResult(overrides: Partial<UseUnfiledRunsResult> = {}): UseUnfiledRunsResult {
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

const RUN_A: ProjectRunSummary = { id: "run-a", at: "2026-08-01T00:00:00.000Z", question: "Question A", selectedModels: ["chatgpt"], projectId: null };
const RUN_B: ProjectRunSummary = { id: "run-b", at: "2026-08-02T00:00:00.000Z", question: "Question B", selectedModels: ["chatgpt"], projectId: null, governanceStatus: "approved" };

function render(result: UseUnfiledRunsResult): string {
  return renderToStaticMarkup(createElement(UnfiledResearchSection, { result }));
}

describe("UnfiledResearchSection — heading", () => {
  it("always renders the 'Unfiled' section heading", () => {
    expect(render(fakeResult())).toContain("Unfiled");
  });
});

describe("UnfiledResearchSection — loading/error/empty (never fabricates empty on error)", () => {
  it("loading shows a restrained message, no empty state", () => {
    const html = render(fakeResult({ status: "loading" }));
    expect(html).toContain("Loading your unfiled research");
    expect(html).not.toContain("No unfiled research.");
  });

  it("error never fabricates 'No unfiled research.'", () => {
    const html = render(fakeResult({ status: "error", initialErrorCode: "internal_error" }));
    expect(html).toContain("Try again");
    expect(html).not.toContain("No unfiled research.");
  });

  it("definitive empty state: items=[] AND hasMore=false", () => {
    expect(render(fakeResult({ items: [], hasMore: false }))).toContain("No unfiled research.");
  });

  it("items=[] AND hasMore=true never shows the empty state", () => {
    expect(render(fakeResult({ items: [], hasMore: true }))).not.toContain("No unfiled research.");
  });
});

describe("UnfiledResearchSection — reuses WorkspaceRunCard verbatim", () => {
  it("renders the question text and the canonical /?openResearchRun= report link", () => {
    const html = render(fakeResult({ items: [RUN_A] }));
    expect(html).toContain("Question A");
    expect(html).toContain(`href="/?openResearchRun=${encodeURIComponent(RUN_A.id)}"`);
  });

  it("renders every item in order", () => {
    const html = render(fakeResult({ items: [RUN_A, RUN_B] }));
    expect(html.indexOf("Question A")).toBeLessThan(html.indexOf("Question B"));
  });

  it("renders the governance chip when present, exactly matching Workspace's own convention", () => {
    const html = render(fakeResult({ items: [RUN_B] }));
    expect(html).toMatch(/Governance: Approved/);
  });

  it("never exposes projectId, workspaceId, or userId in rendered markup", () => {
    const html = render(fakeResult({ items: [RUN_A] }));
    expect(html).not.toMatch(/"projectId"/);
    expect(html).not.toContain("workspaceId");
  });
});

describe("UnfiledResearchSection — no mutation controls (spec item 13/30)", () => {
  it.each(["Move to Project", "Assign", "New Project"])("never renders a %s control", (label) => {
    expect(render(fakeResult({ items: [RUN_A] }))).not.toContain(label);
  });
});

describe("UnfiledResearchSection — pagination", () => {
  it("hasMore=true -> 'Load more' present; hasMore=false -> absent", () => {
    expect(render(fakeResult({ items: [RUN_A], hasMore: true }))).toContain("Load more");
    expect(render(fakeResult({ items: [RUN_A], hasMore: false }))).not.toContain("Load more");
  });

  it("loadMoreErrorCode invalid_cursor -> 'Reload', never the word 'cursor'", () => {
    const html = render(fakeResult({ items: [RUN_A], hasMore: true, loadMoreErrorCode: "invalid_cursor" }));
    expect(html).toContain("Reload");
    expect(html.toLowerCase()).not.toMatch(/cursor/);
  });
});
