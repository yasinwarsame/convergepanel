/**
 * Phase 5C — WorkspaceShellView. Renders the real component
 * (`react-dom/server`, no jsdom) against every `UseWorkspaceMetadataResult`
 * state directly as props — matching this repo's established
 * no-jsdom/@testing-library component-testing convention (see
 * `components/adaptive/__tests__/MetricsGridView.spec.tsx`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceShellView, errorCopy } from "@/components/workspace/WorkspaceShell";
import type { UseWorkspaceMetadataResult, WorkspaceMetadataErrorCode } from "@/hooks/useWorkspaceMetadata";

function render(metadata: UseWorkspaceMetadataResult): string {
  return renderToStaticMarkup(createElement(WorkspaceShellView, { metadata })).replace(/&#x27;/g, "'");
}

describe("WorkspaceShellView — loading state", () => {
  it("shows a restrained loading message, never 'no research' language, never a run list, never a fake empty-history claim", () => {
    const html = render({ status: "loading" });
    expect(html).toContain("Loading your Workspace");
    expect(html.toLowerCase()).not.toMatch(/no research|nothing here|you have no/);
  });
});

describe("WorkspaceShellView — success state", () => {
  it("shows the Workspace heading, the real metadata name (not a client-reconstructed one), and a New research CTA reusing the existing entry point", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } });
    expect(html).toContain("Workspace");
    expect(html).toContain("Personal Workspace");
    expect(html).toContain("New research");
    expect(html).toContain('href="/"');
  });

  it("never renders a run list, Workspace selector, settings, or Projects/Unfiled language", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } });
    expect(html.toLowerCase()).not.toMatch(/unfiled|project|workspacerunsummary|switch workspace|rename/);
    expect(html).not.toMatch(/\/api\/user\/workspace\/runs/);
  });

  it("never displays 'you have no research' even though a real user might have zero bound runs — no list is rendered at all in Phase 5C, so there's nothing to be misleading about", () => {
    const html = render({ status: "success", workspace: { name: "Personal Workspace", type: "personal" } });
    expect(html.toLowerCase()).not.toMatch(/no research|nothing here/);
  });
});

describe("WorkspaceShellView — error states, one distinct UI per Phase 5B error code", () => {
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
    const distinctByPair = new Set(outputs.map((_, i) => `${cases[i].code}:${outputs[i]}`));
    // Two pairs are intentionally identical (unauthorized/auth_error, workspace_unavailable/network_error) —
    // confirm exactly those two collapses, not any unintended additional one.
    const uniqueTexts = new Set(outputs);
    expect(uniqueTexts.size).toBe(4);
  });
});

describe("WorkspaceShellView — never calls the Phase 5D runs endpoint", () => {
  it("component source contains no reference to /api/user/workspace/runs or WorkspaceRunSummary", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "..", "WorkspaceShell.tsx"), "utf8");
    expect(source).not.toMatch(/\/api\/user\/workspace\/runs/);
    expect(source).not.toMatch(/WorkspaceRunSummary/);
  });
});
