/**
 * Approval Workflow, Phase 9C.1 — WorkspaceReviewQueueShell tests.
 *
 * This repo deliberately has no jsdom/@testing-library/react (see
 * `TopNav.spec.ts`'s own doc comment and
 * `AdaptiveReviewAssignmentSection.spec.tsx`'s doc comment for the
 * established precedent). Interactive/async behavior (fetch results
 * rendering, "Load more", filter-change race handling) is therefore
 * covered two ways, matching that exact precedent:
 *   1. The PURE helper functions this component exports
 *      (`parseQueueSearchParams`, `buildQueueHref`, `mergeUniqueQueueRows`)
 *      are unit-tested directly — no rendering needed, fully reliable.
 *   2. `renderToStaticMarkup` proves the initial (always-loading, since
 *      the fetch effect never runs under this render method) synchronous
 *      render, plus source-level regex assertions prove the mandatory
 *      read-only invariant and the required data-fetching conventions.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import { parseQueueSearchParams, buildQueueHref, mergeUniqueQueueRows } from "@/components/workspace/WorkspaceReviewQueueShell";
import type { WorkspaceReviewQueueRow } from "@/lib/client/workspaceReviewQueueClient";

function makeRow(runId: string): WorkspaceReviewQueueRow {
  return {
    runId,
    workspaceId: "ws-1",
    projectId: null,
    runLabel: `Row ${runId}`,
    reviewStatus: "unreviewed",
    createdAt: "2026-08-01T00:00:00.000Z",
    reviewedAt: null,
    assignment: { assignedReviewerUserId: null, assignedReviewerDisplayName: null, dueAt: null, state: "unassigned" },
    isAssignedToMe: false,
    isOverdue: false,
  };
}

describe("parseQueueSearchParams", () => {
  it("no view param -> defaults to assigned_to_me", () => {
    const { view } = parseQueueSearchParams(new URLSearchParams(""));
    expect(view).toBe("assigned_to_me");
  });

  it("invalid view param -> normalizes to assigned_to_me, never forwarded raw", () => {
    const { view } = parseQueueSearchParams(new URLSearchParams("view=not_a_real_view"));
    expect(view).toBe("assigned_to_me");
  });

  it("valid view param round-trips exactly", () => {
    const { view } = parseQueueSearchParams(new URLSearchParams("view=overdue"));
    expect(view).toBe("overdue");
  });

  it("no project param -> filter undefined (all Projects)", () => {
    const { projectFilter } = parseQueueSearchParams(new URLSearchParams(""));
    expect(projectFilter).toBeUndefined();
  });

  it("project=unfiled -> filter null", () => {
    const { projectFilter } = parseQueueSearchParams(new URLSearchParams("project=unfiled"));
    expect(projectFilter).toBeNull();
  });

  it("project=<id> -> filter is that literal id", () => {
    const { projectFilter } = parseQueueSearchParams(new URLSearchParams("project=proj-1"));
    expect(projectFilter).toBe("proj-1");
  });

  it("?view=overdue&project=unfiled initializes both filters exactly (URL round-trip)", () => {
    const parsed = parseQueueSearchParams(new URLSearchParams("view=overdue&project=unfiled"));
    expect(parsed).toEqual({ view: "overdue", projectFilter: null });
  });
});

describe("buildQueueHref", () => {
  it("always sets both view and project explicitly — never a partial URL", () => {
    const href = buildQueueHref("/workspace/reviews", "needs_review", "proj-1");
    expect(href).toBe("/workspace/reviews?view=needs_review&project=proj-1");
  });

  it("Unfiled filter serializes to project=unfiled", () => {
    const href = buildQueueHref("/workspace/reviews", "assigned_to_me", null);
    expect(href).toContain("project=unfiled");
  });

  it("all-Projects filter serializes to project=all, never an absent param a stale cursor could misinterpret", () => {
    const href = buildQueueHref("/workspace/reviews", "assigned_to_me", undefined);
    expect(href).toContain("project=all");
  });

  it("round-trips through parseQueueSearchParams exactly for every view", () => {
    for (const view of ["assigned_to_me", "needs_review", "changes_requested", "overdue", "recently_approved"] as const) {
      const href = buildQueueHref("/workspace/reviews", view, "proj-x");
      const qs = href.split("?")[1];
      const parsed = parseQueueSearchParams(new URLSearchParams(qs));
      expect(parsed).toEqual({ view, projectFilter: "proj-x" });
    }
  });
});

describe("mergeUniqueQueueRows", () => {
  it("appends new rows after existing ones, preserving order", () => {
    const merged = mergeUniqueQueueRows([makeRow("a"), makeRow("b")], [makeRow("c")]);
    expect(merged.map((r) => r.runId)).toEqual(["a", "b", "c"]);
  });

  it("never duplicates a runId already present — 'Load more' appends only unique rows", () => {
    const merged = mergeUniqueQueueRows([makeRow("a"), makeRow("b")], [makeRow("b"), makeRow("c")]);
    expect(merged.map((r) => r.runId)).toEqual(["a", "b", "c"]);
  });

  it("empty incoming page is a no-op", () => {
    const existing = [makeRow("a")];
    expect(mergeUniqueQueueRows(existing, [])).toEqual(existing);
  });

  it("empty existing list simply adopts the incoming page", () => {
    const merged = mergeUniqueQueueRows([], [makeRow("a"), makeRow("b")]);
    expect(merged.map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

// ── Structural / source-level guarantees ──────────────────────────────

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedUseRouter = jest.fn();
const mockedUsePathname = jest.fn();
const mockedUseSearchParams = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => mockedUseRouter(),
  usePathname: () => mockedUsePathname(),
  useSearchParams: () => mockedUseSearchParams(),
}));

jest.mock("@/lib/client/workspaceReviewQueueClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceReviewQueueClient");
  return {
    ...actual,
    fetchWorkspaceReviewQueue: jest.fn(() => new Promise(() => {})), // never resolves — keeps the component in its initial loading render
    fetchWorkspaceProjectOptions: jest.fn(() => new Promise(() => {})),
  };
});

import WorkspaceReviewQueueShell from "@/components/workspace/WorkspaceReviewQueueShell";

beforeEach(() => {
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
  mockedUseRouter.mockReturnValue({ push: jest.fn() });
  mockedUsePathname.mockReturnValue("/workspace/reviews");
  mockedUseSearchParams.mockReturnValue(new URLSearchParams(""));
});

describe("WorkspaceReviewQueueShell — initial render", () => {
  it("renders the Reviews heading", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewQueueShell, { workspaceId: "ws-1" }));
    expect(html).toContain("Reviews");
  });

  it("shows a loading indicator before the fetch resolves, never 'No reviews' prematurely", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewQueueShell, { workspaceId: "ws-1" }));
    expect(html).toContain("Loading reviews");
    expect(html).not.toContain("Nothing assigned to you");
  });

  it("defaults to the 'Assigned to me' view label when no URL param is present", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewQueueShell, { workspaceId: "ws-1" }));
    expect(html).toContain("Assigned to me");
  });

  it("renders all five view options, with accessible pressed-state semantics (aria-pressed), never color-only", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewQueueShell, { workspaceId: "ws-1" }));
    for (const label of ["Assigned to me", "Needs review", "Changes requested", "Overdue", "Recently approved"]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/aria-pressed="true"/);
  });

  it("Project filter is a labeled <select>, not a bare placeholder-only control", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewQueueShell, { workspaceId: "ws-1" }));
    expect(html).toMatch(/<label[^>]*>[\s\S]*Project[\s\S]*<select/);
    expect(html).toContain("All projects");
    expect(html).toContain("Unfiled");
  });

  it("no Load more button appears before any page has loaded", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceReviewQueueShell, { workspaceId: "ws-1" }));
    expect(html).not.toContain("Load more");
  });
});

describe("WorkspaceReviewQueueShell — read-only invariant (Phase 9C.1 §69, mandatory)", () => {
  const source = readFileSync(join(__dirname, "..", "WorkspaceReviewQueueShell.tsx"), "utf8");

  it("never imports any mutation client/service or mutation route path", () => {
    expect(source).not.toMatch(/review-assignment|review-decision|review-resubmit|review-panel|review-override/);
  });

  it("never renders Assign/Approve/Reject/Vote/Finalize/Override control text", () => {
    for (const word of ["Assign</", "Reassign</", "Approve</", "Reject</", "Request changes</", "Resubmit</", "Vote</", "Finalize</", "Override</"]) {
      expect(source).not.toContain(word);
    }
  });

  it("only imports GET-shaped queue/project fetch helpers, never a POST/PUT/DELETE mutation helper", () => {
    expect(source).toMatch(/fetchWorkspaceReviewQueue/);
    expect(source).toMatch(/fetchWorkspaceProjectOptions/);
    expect(source).not.toMatch(/submitWorkspaceReviewDecision|resubmitWorkspaceReview|workspaceReviewPanelMutations/);
  });

  it("uses authedFetch-backed helpers only — no raw fetch(), no SWR, no react-query, no direct Firestore import", () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/swr|react-query|firebase\/firestore/i);
  });

  it("does not consume review-context or reviewer-candidates in this phase (§70/§71)", () => {
    expect(source).not.toMatch(/review-context|reviewer-candidates/);
  });

  it("does not render history/audit/activity UI (§72)", () => {
    expect(source).not.toMatch(/\bHistory\b|\bAudit\b|Activity trail/);
  });
});
