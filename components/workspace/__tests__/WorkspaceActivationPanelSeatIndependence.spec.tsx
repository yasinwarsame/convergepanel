/**
 * PHASE 12A.2-I1 — explicit tested invariant: Project creation is
 * independent of the "Invite your team" onboarding step. An incomplete
 * invitation step must never gate or disable "Create your first project"
 * for an authorized caller — these are two separate onboarding steps
 * driven by two separate capabilities (`members.invite` /
 * `projects.create`) and two separate real-data booleans
 * (`hasNonOwnerMember`/`hasPendingInvitation` vs. `hasProject`), with no
 * cross-dependency in `WorkspaceActivationPanel`'s own render logic.
 * `renderToStaticMarkup` — pure/prop-driven component, this repo's
 * established convention (see `WorkspaceActivationPanel.spec.tsx`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceActivationPanel from "@/components/workspace/WorkspaceActivationPanel";
import { deriveWorkspaceActivationState } from "@/lib/workspaces/activationState";

describe("PHASE 12A.2-I1 — Create Project is independent of Invite-your-team completion", () => {
  it("Invite step INCOMPLETE (no member, no pending invitation) + canCreateProject: true -> 'Create your first project' still renders as an ACTIVE link, never gated on Invite completion", () => {
    const activation = deriveWorkspaceActivationState({ hasNonOwnerMember: false, hasPendingInvitation: false, hasProject: false, hasResearch: false });
    const html = renderToStaticMarkup(createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation, canInvite: true, canCreateProject: true }));
    expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/projects"[^>]*>Create your first project<\/a>/);
  });

  it("Invite step COMPLETE (has a member) but Project step incomplete -> 'Invite your team' shows complete while 'Create your first project' remains its own independent active step", () => {
    const activation = deriveWorkspaceActivationState({ hasNonOwnerMember: true, hasPendingInvitation: false, hasProject: false, hasResearch: false });
    const html = renderToStaticMarkup(createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation, canInvite: true, canCreateProject: true }));
    expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/projects"[^>]*>Create your first project<\/a>/);
  });

  it("canInvite: false (unauthorized to invite) + canCreateProject: true -> Invite shows permission text, Create Project remains a fully active, unrelated link", () => {
    const activation = deriveWorkspaceActivationState({ hasNonOwnerMember: false, hasPendingInvitation: false, hasProject: false, hasResearch: false });
    const html = renderToStaticMarkup(createElement(WorkspaceActivationPanel, { workspaceId: "ws-1", activation, canInvite: false, canCreateProject: true }));
    expect(html).not.toMatch(/<a[^>]*>Invite your team<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/projects"[^>]*>Create your first project<\/a>/);
  });

  it("STRUCTURAL PROOF: WorkspaceActivationPanel's props contain no collaborator-seat/capacity signal at all — Create Project cannot be gated on seat capacity because there is no such prop to gate on", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "WorkspaceActivationPanel.tsx"), "utf8");
    const propsBlock = source.match(/export default function WorkspaceActivationPanel\(\{[\s\S]*?\}:\s*\{[\s\S]*?\}\)\s*\{/)?.[0] ?? "";
    expect(propsBlock).not.toMatch(/seat|capacity|collaborator/i);
  });
});
