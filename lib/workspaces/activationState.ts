/**
 * Team Workspace Activation Flow, Phase 12A.1 — pure derivation of a
 * Workspace's activation progress from EXISTING authoritative data. No
 * onboarding record, no numeric step counter, no client-only state: every
 * input here is something the caller already reads from real Workspace
 * data (membership list, pending invitations, Project existence, research
 * existence), so the derived state is correct on first load, after a
 * refresh, after logout/login, and from a different device/session — see
 * PHASE 12A.1 Section F/M/P.
 *
 * Deliberately zero I/O, zero React, zero Firestore/HTTP — a plain
 * function over booleans, so it is unit-testable without any test
 * harness beyond plain Jest.
 */

export interface WorkspaceActivationInputs {
  /** True if at least one ACTIVE member of this Workspace is not the canonical Owner. */
  hasNonOwnerMember: boolean;
  /** True if at least one pending (non-expired-or-not) invitation currently exists. */
  hasPendingInvitation: boolean;
  /** True if this Workspace has at least one Project (any status the caller can see). */
  hasProject: boolean;
  /** True if this Workspace has at least one Team research run. */
  hasResearch: boolean;
}

export type WorkspaceActivationStep = "invite_team" | "create_project" | "start_research";

export interface WorkspaceActivationState {
  /** Always true — reaching this derivation at all means the Workspace exists and is readable. */
  workspaceCreated: true;
  /**
   * Phase 12A.1's frozen rule (Section G): the Owner alone never
   * completes this step. Completed by EITHER a real non-owner member
   * already being active, OR a pending invitation existing — whichever
   * happens first, so progress advances immediately on a successful
   * invite without waiting for acceptance.
   */
  teamInvited: boolean;
  projectCreated: boolean;
  researchStarted: boolean;
  /** The single next incomplete step to surface as the primary CTA, or `null` once every step is complete. */
  nextStep: WorkspaceActivationStep | null;
  /** True once every step is complete — callers may collapse/hide the setup panel entirely (Section N). */
  isFullyActive: boolean;
}

export function deriveWorkspaceActivationState(inputs: WorkspaceActivationInputs): WorkspaceActivationState {
  const teamInvited = inputs.hasNonOwnerMember || inputs.hasPendingInvitation;
  const projectCreated = inputs.hasProject;
  const researchStarted = inputs.hasResearch;

  // Priority-based, not strictly sequential: research existing is itself
  // proof the Workspace is genuinely in use (Section N), regardless of
  // whether invite/project happen to also be individually complete —
  // e.g. research created via "Unfiled" with no explicit Project yet is
  // still real activity, not a reason to keep nudging toward "Invite."
  const nextStep: WorkspaceActivationStep | null = researchStarted
    ? null
    : projectCreated
      ? "start_research"
      : teamInvited
        ? "create_project"
        : "invite_team";

  return {
    workspaceCreated: true,
    teamInvited,
    projectCreated,
    researchStarted,
    nextStep,
    isFullyActive: researchStarted,
  };
}
