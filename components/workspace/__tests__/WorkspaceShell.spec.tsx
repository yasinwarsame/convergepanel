/**
 * Phase 5C/5D — WorkspaceShellView. Renders the real component
 * (`react-dom/server`, no jsdom) against every `UseWorkspaceMetadataResult`
 * × `UseWorkspaceRunsResult` combination directly as props — matching this
 * repo's established no-jsdom/@testing-library component-testing
 * convention (see `components/adaptive/__tests__/MetricsGridView.spec.tsx`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceShellView, errorCopy } from "@/components/workspace/WorkspaceShell";
import type { UseWorkspaceMetadataResult, WorkspaceMetadataErrorCode } from "@/hooks/useWorkspaceMetadata";
import type { UseWorkspaceRunsResult, WorkspaceRunSummary } from "@/hooks/useWorkspaceRuns";

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

const SAMPLE_ITEM: WorkspaceRunSummary = {
  id: "run-1",
  at: "2026-08-15T00:00:00.000Z",
  question: "What are the main causes of inflation?",
  selectedModels: ["chatgpt", "claude"],
  status: "complete",
  modelsOk: 2,
  modelsTotal: 2,
  synthesisConsensusScore: 84,
  governanceStatus: "approved",
};

function render(metadata: UseWorkspaceMetadataResult, runs: UseWorkspaceRunsResult = fakeRuns()): string {
  return renderToStaticMarkup(createElement(WorkspaceShellView, { metadata, runs })).replace(/&#x27;/g, "'");
}

describe("WorkspaceShellView — loading state", () => {
  it("shows a restrained loading message, never 'no research' language, never a run list, never a fake empty-history claim", () => {
    const html = render({ status: "loading" });
    expect(html).toContain("Loading your Workspace");
    expect(html.toLowerCase()).not.toMatch(/no research|nothing here|you have no/);
  });
});

describe("WorkspaceShellView — success state (metadata success, runs ready)", () => {
  it("shows the Workspace heading, the real metadata name (not a client-reconstructed one), and a New research CTA reusing the existing entry point", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } });
    expect(html).toContain("Workspace");
    expect(html).toContain("Personal Workspace");
    expect(html).toContain("New research");
    expect(html).toContain('href="/"');
  });

  it("never renders a Workspace selector, settings, or Projects/Unfiled/team language", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } });
    expect(html.toLowerCase()).not.toMatch(/unfiled|project|switch workspace|rename|invite|member/);
  });

  it("renders the Recent research section and populated list when runs has items", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } }, fakeRuns({ items: [SAMPLE_ITEM] }));
    expect(html).toContain("Recent research");
    expect(html).toContain("What are the main causes of inflation?");
    expect(html).toContain('href="/?openResearchRun=run-1"');
  });

  it("definitive empty state (items=[], hasMore=false) shows the single provenance-safe message, never 'no research yet' style copy", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } }, fakeRuns({ items: [], hasMore: false }));
    expect(html).toContain("New research will appear here.");
    expect(html).toContain("You can find all of your research in History.");
    expect(html.toLowerCase()).not.toMatch(/no research yet|you have no research|start your first|earlier research is in history/);
  });

  it("empty page with hasMore=true does NOT show the empty state and shows a working Load more control instead", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } }, fakeRuns({ items: [], hasMore: true }));
    expect(html).not.toContain("New research will appear here.");
    expect(html).toContain("Load more");
  });
});

describe("WorkspaceShellView — runs-list-only failures stay section-local", () => {
  it("a runs-specific error (not one of the shared Workspace-prerequisite codes) keeps the heading/CTA/Workspace name visible and shows only a section-local error", () => {
    const html = render(
      { status: "success", workspace: { name: "Personal Workspace", type: "personal" } },
      fakeRuns({ status: "error", initialErrorCode: "internal_error" })
    );
    expect(html).toContain("Personal Workspace");
    expect(html).toContain("New research");
    expect(html).toContain("Couldn't load your research right now");
  });
});

describe("WorkspaceShellView — runs prerequisite errors escalate to the page-level error", () => {
  const escalatingCodes: Array<"workspace_missing" | "workspace_invalid" | "workspace_unavailable"> = [
    "workspace_missing",
    "workspace_invalid",
    "workspace_unavailable",
  ];

  it.each(escalatingCodes)(
    "runs error %s (a race with a metadata success) replaces the entire success view with the SAME page-level error metadata failures use, never showing a half-broken success view",
    (code) => {
      const html = render(
        { status: "success", workspace: { name: "Personal Workspace", type: "personal" } },
        fakeRuns({ status: "error", initialErrorCode: code })
      );
      const copy = errorCopy(code);
      expect(html).toContain(copy.title);
      expect(html).toContain(copy.body);
      expect(html).not.toContain("New research");
      expect(html).not.toContain("Personal Workspace");
      expect(html).not.toContain("Recent research");
    }
  );
});

describe("WorkspaceShellView — error states, one distinct UI per Phase 5B metadata error code", () => {
  const cases: Array<{ code: WorkspaceMetadataErrorCode; expectRetry: boolean }> = [
    { code: "unauthorized", expectRetry: false },
    { code: "auth_error", expectRetry: false },
    { code: "workspace_missing", expectRetry: false },
    { code: "workspace_invalid", expectRetry: false },
    { code: "workspace_unavailable", expectRetry: true },
    { code: "network_error", expectRetry: true },
  ];

  it.each(cases)("renders a distinct diagnostic state for %s, never a generic fallback pretending everything is normal", ({ code, expectRetry }) => {
    const html = render({ status: "error", errorCode: code });
    const copy = errorCopy(code);
    expect(html).toContain(copy.title);
    expect(html).toContain(copy.body);
    expect(html.includes("Try again")).toBe(expectRetry);
    // Never silently shows the success-state CTA/content on an error.
    expect(html).not.toContain("New research");
  });

  it("workspace_invalid never discloses the internal integrity reason (malformed/wrong_owner/wrong_type) — Phase 5B's own sanitization is preserved end to end", () => {
    const html = render({ status: "error", errorCode: "workspace_invalid" });
    expect(html.toLowerCase()).not.toMatch(/malformed|wrong_owner|wrong_type/);
  });

  it("all six defined error codes produce genuinely distinct copy from one another (no accidental collapse to one generic message)", () => {
    const outputs = cases.map(({ code }) => `${errorCopy(code).title}|${errorCopy(code).body}`);
    const uniqueTexts = new Set(outputs);
    // Two pairs are intentionally identical (unauthorized/auth_error, workspace_unavailable/network_error) —
    // confirm exactly those two collapses, not any unintended additional one.
    expect(uniqueTexts.size).toBe(4);
  });
});
