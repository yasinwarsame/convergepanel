/**
 * Query-Routing Redesign, Phase 2A — read-only isolation for the
 * QUEUE surface only. Originally written in Part E1 (§25.24) for the
 * ENTIRE `components/teamGovernance/` tree, back when none of it had any
 * mutation capability at all. Part E2 (§26) deliberately and correctly
 * added a real decision form to the DETAIL page — so a blanket
 * "nothing in this directory ever mutates" assertion is no longer the
 * right invariant to check; it would now fail on legitimate, intended
 * code, not a regression.
 *
 * The invariant that STILL holds, and is checked here: the QUEUE-browsing
 * surface (the list page and its own components — never the detail page)
 * remains strictly read-only. The decision form's OWN isolation guarantees
 * (exactly one POST call site, no auto-retry, etc.) are covered separately
 * in `adaptiveReviewDecisionFormIsolation.spec.ts` (Part E2).
 *
 * Same honest-source-level-test caveat as before: this proves SOURCE
 * absence, not runtime behavior — no DOM/RTL environment exists in this
 * repo (`jest.config.ts` uses `testEnvironment: "node"`).
 */

import { readFileSync } from "fs";
import { join } from "path";

const QUEUE_ONLY_FILES = [
  "TeamReviewQueue.tsx",
  "TeamReviewFilters.tsx",
  "TeamReviewListItem.tsx",
  "AdaptiveReviewListItem.tsx",
  "LegacyReviewListItem.tsx",
  "GovernanceStatusBadge.tsx",
  "HumanReviewStatusBadge.tsx",
  "ReviewEmptyState.tsx",
  "ReviewErrorState.tsx",
].map((f) => join(__dirname, "..", f));

const QUEUE_PAGE_FILE = join(__dirname, "../../../app/team/reviews/page.tsx");

function readAll(paths: string[]): string {
  return paths.map((p) => readFileSync(p, "utf8")).join("\n");
}

describe("Team review QUEUE surface — strict read-only isolation (source-level)", () => {
  const queueSource = readAll([...QUEUE_ONLY_FILES, QUEUE_PAGE_FILE]);

  it("never references the decision-mutation route path", () => {
    expect(queueSource).not.toContain("/decision");
  });

  it("never issues a POST request", () => {
    expect(queueSource).not.toMatch(/method:\s*["']POST["']/);
  });

  it("never renders a decision/mutation button label", () => {
    for (const forbidden of ["Approve with Conditions", ">Approve<", "Request Changes", "Reject</button>", "Submit Decision", "Submit Review"]) {
      expect(queueSource).not.toContain(forbidden);
    }
  });

  it("never renders a comment input or conditions editor", () => {
    expect(queueSource).not.toMatch(/<textarea/);
    expect(queueSource).not.toMatch(/AdaptiveReviewConditionsEditor/);
  });

  it("never references reviewer assignment or pending-state mutation", () => {
    expect(queueSource).not.toMatch(/assignReviewer/i);
    expect(queueSource).not.toMatch(/setPending/i);
  });

  it("does not import the decision form or submission service", () => {
    expect(queueSource).not.toMatch(/AdaptiveReviewDecisionForm/);
    expect(queueSource).not.toMatch(/adaptiveReviewSubmission/);
  });
});
