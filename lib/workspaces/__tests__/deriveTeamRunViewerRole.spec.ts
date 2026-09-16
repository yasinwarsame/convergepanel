/**
 * Team Research Parity, Phase R1 — `deriveTeamRunViewerRole()`: the full
 * predicate matrix. Real governance parser. This helper REFINES an
 * already-granted reader; it must never be able to produce anything other
 * than team_member / team_reviewer, and team_reviewer requires ALL of
 * reviews.submit + canonical assignment naming this uid + reviewable state.
 */
import { deriveTeamRunViewerRole } from "@/lib/workspaces/deriveTeamRunViewerRole";
import type { GetAdaptiveHumanReviewAssignmentResult } from "@/lib/firestore/runs";
import type { WorkspaceCapability } from "@/lib/workspaces/capabilities";
import { governanceRecord } from "@/lib/runs/__tests__/runReadFixtures";

const UID = "member-b";
const READ_ONLY: WorkspaceCapability[] = ["workspace.read", "research.read"];
const WITH_SUBMIT: WorkspaceCapability[] = ["workspace.read", "research.read", "reviews.submit"];
const ASSIGNED_TO_UID = { status: "found", assignment: { assignedReviewerUserId: UID } } as unknown as GetAdaptiveHumanReviewAssignmentResult;
const ASSIGNED_TO_OTHER = { status: "found", assignment: { assignedReviewerUserId: "someone-else" } } as unknown as GetAdaptiveHumanReviewAssignmentResult;
const UNASSIGNED: GetAdaptiveHumanReviewAssignmentResult = { status: "unassigned" };

describe("deriveTeamRunViewerRole", () => {
  it("team_reviewer ONLY when reviews.submit AND assignment names uid AND status is reviewable", () => {
    expect(deriveTeamRunViewerRole({ uid: UID, capabilities: WITH_SUBMIT, assignmentResult: ASSIGNED_TO_UID, governanceRecord: governanceRecord("unreviewed") })).toBe("team_reviewer");
    expect(deriveTeamRunViewerRole({ uid: UID, capabilities: WITH_SUBMIT, assignmentResult: ASSIGNED_TO_UID, governanceRecord: governanceRecord("pending") })).toBe("team_reviewer");
  });

  it("missing reviews.submit → team_member even when assigned and reviewable (a role label never substitutes for the capability)", () => {
    expect(deriveTeamRunViewerRole({ uid: UID, capabilities: READ_ONLY, assignmentResult: ASSIGNED_TO_UID, governanceRecord: governanceRecord("unreviewed") })).toBe("team_member");
  });

  it("assignment naming someone else, unassigned, or a failed assignment lookup → team_member", () => {
    for (const assignmentResult of [ASSIGNED_TO_OTHER, UNASSIGNED, { status: "firestore_unavailable" } as const, { status: "read_failed" } as const]) {
      expect(deriveTeamRunViewerRole({ uid: UID, capabilities: WITH_SUBMIT, assignmentResult, governanceRecord: governanceRecord("unreviewed") })).toBe("team_member");
    }
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"])("decided status %s → team_member even when assigned with reviews.submit", (status) => {
    expect(deriveTeamRunViewerRole({ uid: UID, capabilities: WITH_SUBMIT, assignmentResult: ASSIGNED_TO_UID, governanceRecord: governanceRecord(status) })).toBe("team_member");
  });

  it("absent or malformed governanceRecord → team_member (no reviewable state can be established)", () => {
    expect(deriveTeamRunViewerRole({ uid: UID, capabilities: WITH_SUBMIT, assignmentResult: ASSIGNED_TO_UID, governanceRecord: undefined })).toBe("team_member");
    expect(deriveTeamRunViewerRole({ uid: UID, capabilities: WITH_SUBMIT, assignmentResult: ASSIGNED_TO_UID, governanceRecord: { version: 1, humanReview: { status: "unreviewed" } } })).toBe("team_member");
  });

  it("never returns a role other than team_member / team_reviewer, whatever the inputs", () => {
    const roles = new Set<string>();
    for (const capabilities of [READ_ONLY, WITH_SUBMIT, [] as WorkspaceCapability[]]) {
      for (const assignmentResult of [ASSIGNED_TO_UID, ASSIGNED_TO_OTHER, UNASSIGNED]) {
        for (const gov of [governanceRecord("unreviewed"), governanceRecord("rejected"), undefined, "garbage"]) {
          roles.add(deriveTeamRunViewerRole({ uid: UID, capabilities, assignmentResult, governanceRecord: gov }));
        }
      }
    }
    expect([...roles].sort()).toEqual(["team_member", "team_reviewer"]);
  });
});
