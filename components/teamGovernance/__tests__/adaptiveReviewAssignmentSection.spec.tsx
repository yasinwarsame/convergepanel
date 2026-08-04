/**
 * Part E3 — structural tests for AdaptiveReviewAssignmentSection's initial
 * render. Same documented limitation as elsewhere in this engagement:
 * `renderToStaticMarkup` only proves the first synchronous render (always
 * the loading state, since the fetch is async and effects never run under
 * this method) plus source-level guarantees. Interactive behavior
 * (assign/reassign/unassign submission, stale-revision handling) is
 * covered by the route-level contract tests in
 * `app/api/teams/adaptive-runs/[runId]/assignment/__tests__/adaptiveHumanReviewAssignmentRoute.spec.ts`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

import AdaptiveReviewAssignmentSection from "@/components/teamGovernance/AdaptiveReviewAssignmentSection";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

describe("AdaptiveReviewAssignmentSection — initial render", () => {
  it("renders a Reviewer heading", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewAssignmentSection, { runId: "run-1", reviewPending: true }));
    expect(html).toContain("Reviewer");
  });

  it("shows a loading state before the fetch resolves", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewAssignmentSection, { runId: "run-1", reviewPending: true }));
    expect(html).toContain("Loading reviewer assignment");
  });

  it("never renders assignment/eligible-reviewer controls on initial render (loading state has no select/buttons)", () => {
    const html = renderToStaticMarkup(createElement(AdaptiveReviewAssignmentSection, { runId: "run-1", reviewPending: true }));
    expect(html).not.toMatch(/<select/);
    expect(html).not.toMatch(/<button/);
  });
});

describe("AdaptiveReviewAssignmentSection — source-level guarantees", () => {
  const fullSource = readFileSync(join(__dirname, "../AdaptiveReviewAssignmentSection.tsx"), "utf8");
  // The file's own top-of-file doc comment intentionally lists every
  // feature this section must NOT render (per Part E3 §13's "Do not add"
  // list) — checking `fullSource` for those words would just match the
  // comment describing the rule. These guarantees check the code that
  // follows the doc comment instead.
  const source = fullSource.slice(fullSource.indexOf("*/") + 2);

  it("fetches and mutates only the assignment route, never the decision/history routes", () => {
    expect(source).toContain("/assignment");
    expect(source).not.toContain("/decision");
    expect(source).not.toContain("/history");
  });

  it("supports GET, PUT, and DELETE only — no POST", () => {
    expect(source).toMatch(/method:\s*["']GET["']/);
    expect(source).toContain('"PUT" | "DELETE"');
    expect(source).not.toMatch(/method:\s*["']POST["']/);
    expect(source).not.toMatch(/["']POST["']/);
  });

  it("never renders comments, notes, chat/discussion threads, notifications, due-date, workload, or quorum UI", () => {
    // Note: "mutationMessage" (a simple success/error status string, matching
    // the pattern already used elsewhere in this codebase) legitimately
    // contains "message" and is not a messaging/chat feature — checked for
    // separately below with a more specific pattern.
    expect(source).not.toMatch(/comment/i);
    expect(source).not.toMatch(/\bnote\b/i);
    expect(source).not.toMatch(/\bchat\b/i);
    expect(source).not.toMatch(/discussion/i);
    expect(source).not.toMatch(/notif/i);
    expect(source).not.toMatch(/due.?date/i);
    expect(source).not.toMatch(/workload/i);
    expect(source).not.toMatch(/quorum/i);
  });

  it("never renders reopening controls or a repair action", () => {
    expect(source).not.toMatch(/reopen/i);
    expect(source).not.toMatch(/repair/i);
  });

  it("never renders an avatar image element", () => {
    expect(source).not.toMatch(/<img/i);
    expect(source).not.toMatch(/avatar/i);
  });

  it("never renders multiple-reviewer controls (single select only, no multi-select or checkbox list)", () => {
    expect(source).not.toMatch(/multiple/i);
    expect(source).not.toMatch(/checkbox/i);
  });

  it("sends expectedRevision on every mutation (optimistic concurrency)", () => {
    expect(source).toContain("expectedRevision");
  });
});
