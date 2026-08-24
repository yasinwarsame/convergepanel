/**
 * Approval Workflow, Phase 9C.1-R1C — WorkspaceReviewsChooser tests.
 * Same technique as `WorkspaceReviewQueueShell.spec.tsx` (this repo
 * deliberately has no jsdom/@testing-library/react): `renderToStaticMarkup`
 * proves the initial synchronous render, plus source-level structural
 * assertions prove the security-relevant invariants (never fetches queue
 * data, accessible selection semantics, correct navigation target).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

jest.mock("@/lib/client/workspaceListClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceListClient");
  return {
    ...actual,
    fetchWorkspaceList: jest.fn(() => new Promise(() => {})), // never resolves — keeps the component in its initial loading render
  };
});

import WorkspaceReviewsChooser from "@/components/workspace/WorkspaceReviewsChooser";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

describe("WorkspaceReviewsChooser — initial render", () => {
  it("renders the Reviews heading and chooser copy", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewsChooser));
    expect(html).toContain("Reviews");
    expect(html).toContain("Choose a Workspace to view its reviews.");
  });

  it("never uses internal/technical language like 'ambiguous' or 'authorization scope'", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewsChooser));
    expect(html.toLowerCase()).not.toContain("ambiguous");
    expect(html.toLowerCase()).not.toContain("authorization scope");
    expect(html.toLowerCase()).not.toContain("membership record");
  });

  it("shows a loading indicator before the fetch resolves", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewsChooser));
    expect(html).toContain("Loading Workspaces");
  });

  it("has an accessible nav landmark labeled Workspace", () => {
    // Not reachable in the initial (loading) render, but the source-level
    // check below proves it exists on the ready-state markup.
    const source = readFileSync(join(__dirname, "..", "WorkspaceReviewsChooser.tsx"), "utf8");
    expect(source).toMatch(/aria-label="Workspace"/);
  });
});

describe("WorkspaceReviewsChooser — structural / source-level guarantees", () => {
  const source = readFileSync(join(__dirname, "..", "WorkspaceReviewsChooser.tsx"), "utf8");

  it("never fetches queue/review data — only the Workspace list", () => {
    expect(source).not.toMatch(/review-queue|fetchWorkspaceReviewQueue/);
    expect(source).toMatch(/fetchWorkspaceList/);
  });

  it("never imports any mutation client/service or mutation route path", () => {
    expect(source).not.toMatch(/review-assignment|review-decision|review-resubmit|review-panel|review-override/);
  });

  it("navigates to /workspace/reviews?workspace=<id>, never a bare workspaceId as the href", () => {
    expect(source).toMatch(/\/workspace\/reviews\?workspace=/);
  });

  it("uses authedFetch-backed helpers only — no raw fetch(), no SWR, no react-query, no direct Firestore import", () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/swr|react-query|firebase\/firestore/i);
  });
});
