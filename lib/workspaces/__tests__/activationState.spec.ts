import { deriveWorkspaceActivationState } from "@/lib/workspaces/activationState";

function inputs(overrides: Partial<Parameters<typeof deriveWorkspaceActivationState>[0]> = {}) {
  return {
    hasNonOwnerMember: false,
    hasPendingInvitation: false,
    hasProject: false,
    hasResearch: false,
    ...overrides,
  };
}

describe("deriveWorkspaceActivationState", () => {
  it("a brand-new Workspace (Owner only, no invites, no projects, no research) is only workspace_created", () => {
    const state = deriveWorkspaceActivationState(inputs());
    expect(state.workspaceCreated).toBe(true);
    expect(state.teamInvited).toBe(false);
    expect(state.projectCreated).toBe(false);
    expect(state.researchStarted).toBe(false);
    expect(state.nextStep).toBe("invite_team");
    expect(state.isFullyActive).toBe(false);
  });

  it("Owner-only membership does NOT falsely complete the invite step", () => {
    // hasNonOwnerMember stays false even though the Owner themself is a member —
    // this input is the caller's responsibility to compute correctly, but the
    // derivation must never treat "any member at all" as sufficient.
    const state = deriveWorkspaceActivationState(inputs({ hasNonOwnerMember: false, hasPendingInvitation: false }));
    expect(state.teamInvited).toBe(false);
  });

  it("a pending invitation alone completes the invite step, before acceptance", () => {
    const state = deriveWorkspaceActivationState(inputs({ hasPendingInvitation: true }));
    expect(state.teamInvited).toBe(true);
    expect(state.nextStep).toBe("create_project");
  });

  it("an accepted (active, non-owner) member alone completes the invite step", () => {
    const state = deriveWorkspaceActivationState(inputs({ hasNonOwnerMember: true }));
    expect(state.teamInvited).toBe(true);
    expect(state.nextStep).toBe("create_project");
  });

  it("invitation is not required before Project progression — a Project can complete even with no team activity", () => {
    const state = deriveWorkspaceActivationState(inputs({ hasProject: true }));
    // teamInvited is still false, but projectCreated is independently true —
    // the derivation never requires teamInvited as a precondition for projectCreated.
    expect(state.teamInvited).toBe(false);
    expect(state.projectCreated).toBe(true);
  });

  it("a Workspace with a Project but no research surfaces start_research as next", () => {
    const state = deriveWorkspaceActivationState(inputs({ hasNonOwnerMember: true, hasProject: true }));
    expect(state.projectCreated).toBe(true);
    expect(state.researchStarted).toBe(false);
    expect(state.nextStep).toBe("start_research");
  });

  it("a Workspace with research present is fully active regardless of the other steps' own literal completion", () => {
    const state = deriveWorkspaceActivationState(inputs({ hasNonOwnerMember: true, hasProject: true, hasResearch: true }));
    expect(state.nextStep).toBeNull();
    expect(state.isFullyActive).toBe(true);
  });

  it("research existing is itself proof of real activity — isFullyActive/nextStep are priority-based on research, not gated on invite/project also being individually complete (e.g. Unfiled research with no explicit invite yet)", () => {
    const state = deriveWorkspaceActivationState(inputs({ hasResearch: true }));
    expect(state.teamInvited).toBe(false);
    expect(state.projectCreated).toBe(false);
    expect(state.researchStarted).toBe(true);
    expect(state.nextStep).toBeNull();
    expect(state.isFullyActive).toBe(true);
  });

  it("is a pure function — identical inputs always produce identical, independent output objects", () => {
    const a = deriveWorkspaceActivationState(inputs({ hasNonOwnerMember: true }));
    const b = deriveWorkspaceActivationState(inputs({ hasNonOwnerMember: true }));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
