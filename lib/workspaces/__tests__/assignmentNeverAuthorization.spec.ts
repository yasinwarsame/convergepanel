/**
 * Project/Research Assignment — STRUCTURAL invariants (brief §3/§6.11):
 *   1. No authorization module reads an assignment field.
 *   2. No assignment module imports the seat / quota / billing machinery.
 *   3. The D8 overlap reader never imports review eligibility or review
 *      routes, and never writes.
 * Regex against real source, with positive controls that the files
 * inspected are the real ones (they contain what they must contain).
 */

import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
/** Comments are documentation, not behavior — structural claims are made against CODE only. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const AUTH_MODULES = ["lib/workspaces/resolveWorkspaceAccess.ts", "lib/workspaces/authorizeTeamWorkspaceMutationInTransaction.ts", "lib/workspaces/capabilities.ts", "lib/workspaces/workspaceReviewEligibility.ts"];

const ASSIGNMENT_MODULES = [
  "lib/workspaces/assignmentNormalization.ts",
  "lib/workspaces/assignmentTargetEligibility.ts",
  "lib/workspaces/assigneePresentation.ts",
  "lib/workspaces/teamProjectAssigneeEnrichment.ts",
  "lib/workspaces/teamRunAssigneeEnrichment.ts",
  "lib/workspaces/runAssignmentReviewOverlap.ts",
  "lib/workspaces/assigneeFilterResolution.ts",
  "lib/workspaces/projectAssignmentRollout.ts",
  "lib/projects/setTeamRunAssignee.ts",
  "lib/projects/assignmentBody.ts",
  "lib/projects/assignmentErrorResponse.ts",
  "app/api/workspaces/[workspaceId]/projects/[projectId]/assignees/route.ts",
  "app/api/workspaces/[workspaceId]/runs/[runId]/assignee/route.ts",
];

describe("assignment is not authorization", () => {
  it.each(AUTH_MODULES)("%s never references assigneeUid / assigneeUids", (p) => {
    const src = read(p);
    expect(src.length).toBeGreaterThan(200); // positive control: a real file
    expect(src).not.toMatch(/assigneeUids?/);
  });

  it("positive control — the assignment primitives DO reference the fields (the regex is live)", () => {
    expect(read("lib/projects/setTeamRunAssignee.ts")).toMatch(/assigneeUid/);
    expect(read("lib/firestore/teamProjects.ts")).toMatch(/assigneeUids/);
  });

  it("the primitives authorize ONLY through authorizeTeamWorkspaceMutationInTransaction with the frozen capabilities", () => {
    expect(read("lib/projects/setTeamRunAssignee.ts")).toMatch(/requiredCapability: "research\.organize"/);
    expect(read("lib/projects/setTeamRunAssignee.ts")).not.toMatch(/run(Data)?\.userId\s*===/);
    expect(read("lib/firestore/teamProjects.ts")).toMatch(/requiredCapability: "projects\.manage"/);
  });
});

describe("seat / quota independence (structural ban)", () => {
  const BANNED = [/teamWorkspaceSeatAdmission/, /lib\/stripe\/usageCheck/, /checkAndIncrementUsageForRun/, /lib\/plans/, /lib\/billing/];
  it.each(ASSIGNMENT_MODULES)("%s imports nothing from the seat/quota/billing machinery", (p) => {
    const src = read(p);
    for (const re of BANNED) expect(src).not.toMatch(re);
  });
  it("positive control — the ban list matches the real seat module import path", () => {
    expect(read("lib/workspaces/teamWorkspaceSeatAdmission.ts").length).toBeGreaterThan(0);
  });
});

describe("D8 — overlap reader is read-only presentation, independent of review machinery", () => {
  const src = stripComments(read("lib/workspaces/runAssignmentReviewOverlap.ts"));
  it("positive control — the stripped source still contains the real reads", () => {
    expect(src).toMatch(/humanReviewAssignment/);
    expect(src).toMatch(/humanReviewPanel/);
    expect(src).toMatch(/getAll\(/);
  });
  it("never imports review eligibility, review parsers, or Approval Workflow rollout", () => {
    expect(src).not.toMatch(/workspaceReviewEligibility|approvalWorkflowRollout|APPROVAL_WORKFLOW|reviewQueue|humanReviewAssignmentParser|reviewerAssignment/);
    expect(src.match(/^import .*$/gm) ?? []).toEqual(['import "server-only";', 'import { adminDb } from "@/lib/firebase/admin";']);
  });
  it("never writes: no transaction, no batch, no ref set/update/create/delete", () => {
    expect(src).not.toMatch(/runTransaction|\.batch\(|\.(set|update|create|delete)\(/);
  });
  it("the assignee routes never touch a review route module", () => {
    expect(stripComments(read("app/api/workspaces/[workspaceId]/runs/[runId]/assignee/route.ts"))).not.toMatch(/\/reviews?\/|reviewEligibility|humanReview/);
  });
});
