/**
 * Team Workspace Activation Flow, Phase 12A.1 — tests for
 * `WorkspaceActivationPanel`. Pure/prop-driven, no hooks/effects, so
 * `renderToStaticMarkup` exercises its real render logic directly (no
 * jsdom/@testing-library/react in this repo).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceActivationPanel from "@/components/workspace/WorkspaceActivationPanel";
import { deriveWorkspaceActivationState, type WorkspaceActivationState } from "@/lib/workspaces/activationState";

function activation(overrides: Parameters<typeof deriveWorkspaceActivationState>[0]): WorkspaceActivationState {
  return deriveWorkspaceActivationState(overrides);
}

const BRAND_NEW = activation({ hasNonOwnerMember: false, hasPendingInvitation: false, hasProject: false, hasResearch: false });

describe("WorkspaceActivationPanel", () => {
  it("a brand-new Workspace shows all four steps, with only 'Workspace created' complete", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: true, canCreateProject: true })
    );
    expect(html).toContain("Set up your Workspace");
    expect(html).toContain("Workspace created");
    expect(html).toContain("Invite your team");
    expect(html).toContain("Create your first project");
    expect(html).toContain("Start research");
    // Only one checkmark glyph: Workspace created.
    expect((html.match(/>✓</g) ?? []).length).toBe(1);
  });

  it("canInvite: true renders an active link to this exact Workspace's Members page", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: true, canCreateProject: true })
    );
    expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/members"[^>]*>Invite your team<\/a>/);
  });

  it("canInvite: false never shows an actionable Invite control — status text only, no link", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: false, canCreateProject: true })
    );
    expect(html).not.toMatch(/<a[^>]*>Invite your team<\/a>/);
    expect(html).toContain("Owner/Admin only");
  });

  it("Research step is never rendered as a link — no fake navigation to a route that doesn't exist yet (12A.3 boundary)", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: true, canCreateProject: true })
    );
    expect(html).not.toMatch(/<a[^>]*>Start research<\/a>/);
    expect(html).toContain("Coming soon");
  });

  describe("Phase 12A.2 — 'Create your first project' capability gating", () => {
    it("canCreateProject: true renders an active link to this exact Workspace's Projects page", () => {
      const html = renderToStaticMarkup(
        createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: true, canCreateProject: true })
      );
      expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/projects"[^>]*>Create your first project<\/a>/);
    });

    it("canCreateProject: false never shows an actionable create control — status text only, no link", () => {
      const html = renderToStaticMarkup(
        createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: true, canCreateProject: false })
      );
      expect(html).not.toMatch(/<a[^>]*>Create your first project<\/a>/);
      expect(html).toContain("Owner/Admin/Member only");
    });
  });

  it("teamInvited: true marks Invite complete and hides its action, even though later steps remain incomplete", () => {
    const state = activation({ hasNonOwnerMember: true, hasPendingInvitation: false, hasProject: false, hasResearch: false });
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: state, canInvite: true, canCreateProject: true })
    );
    expect(html).not.toMatch(/<a[^>]*>Invite your team<\/a>/);
    expect((html.match(/>✓</g) ?? []).length).toBe(2); // Workspace created + Invite
  });

  it("projectCreated: true (a Project now exists) marks the step complete and removes its action link", () => {
    const state = activation({ hasNonOwnerMember: false, hasPendingInvitation: false, hasProject: true, hasResearch: false });
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: state, canInvite: true, canCreateProject: true })
    );
    expect(html).not.toMatch(/<a[^>]*>Create your first project<\/a>/);
    expect((html.match(/>✓</g) ?? []).length).toBe(2); // Workspace created + Project (priority-based: invite still incomplete, but Project independently complete)
  });

  it("isFullyActive (research exists) renders nothing at all", () => {
    const state = activation({ hasNonOwnerMember: true, hasPendingInvitation: false, hasProject: true, hasResearch: true });
    expect(state.isFullyActive).toBe(true);
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: state, canInvite: true, canCreateProject: true })
    );
    expect(html).toBe("");
  });

  it("progress is never communicated by color alone — each step has an accessible complete/incomplete text label", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation: BRAND_NEW, canInvite: true, canCreateProject: true })
    );
    expect(html).toContain("(complete)");
    expect(html).toContain("(not yet complete)");
  });
});
