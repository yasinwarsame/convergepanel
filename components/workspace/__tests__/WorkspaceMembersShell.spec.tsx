/**
 * Team Workspace Self-Service Onboarding — PHASE TEAM-UI-I1C1 corrective
 * source-level regression tests for `WorkspaceMembersShell.tsx`'s invite/
 * resend delivery-outcome messaging.
 *
 * This repo has no jsdom/@testing-library/react (see `TopNav.spec.ts`'s own
 * doc comment for the established precedent) — interactive behavior here is
 * therefore proven via `readFileSync` + regex against the real component
 * source, extracting `handleInvite`/`handleResend`'s exact function bodies
 * and asserting on the branching around `result.delivered`, matching this
 * repo's existing convention rather than attempting a jsdom render.
 *
 * This closes the previously-identified gap: this component had ZERO tests
 * before the PHASE TEAM-INVITE-DELIVERY-R1 defect (the UI claimed
 * "Invitation sent" for every 2xx response, even when the backend had
 * already reported `delivered:false`) was found via live visual
 * verification, not by any test.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "WorkspaceMembersShell.tsx"), "utf8");

function extractFunctionBody(fnName: string): string {
  const match = source.match(new RegExp(`const ${fnName} = useCallback\\(\\s*async[\\s\\S]*?\\n    \\},\\n    \\[`));
  expect(match).not.toBeNull();
  return match![0];
}

describe("WorkspaceMembersShell — handleInvite delivery-outcome messaging", () => {
  const handleInvite = extractFunctionBody("handleInvite");

  it("H. create delivered:true renders the 'Invitation sent' confirmation", () => {
    expect(handleInvite).toMatch(/if \(result\.delivered\) \{\s*setInviteConfirmation\(`Invitation sent to \$\{result\.invitation\.normalizedEmail\}\.`\);/);
  });

  it("I. create delivered:false does NOT render the 'Invitation sent' confirmation — it takes the else branch", () => {
    const deliveredTrueIndex = handleInvite.indexOf("if (result.delivered) {");
    const elseIndex = handleInvite.indexOf("} else {", deliveredTrueIndex);
    expect(deliveredTrueIndex).toBeGreaterThan(-1);
    expect(elseIndex).toBeGreaterThan(deliveredTrueIndex);
    const elseBody = handleInvite.slice(elseIndex, handleInvite.indexOf("}", elseIndex + 200));
    expect(elseBody).not.toMatch(/setInviteConfirmation/);
    expect(elseBody).toMatch(/setInviteDeliveryWarning/);
  });

  it("J. create delivered:false displays truthful retry guidance mentioning Resend, without claiming the email was sent", () => {
    expect(handleInvite).toMatch(/setInviteDeliveryWarning\("Invitation created, but the email couldn't be sent\. You can try Resend\."\)/);
  });

  it("M. the pending invitation list is refreshed (and therefore remains visible/manageable) on BOTH delivered:true and delivered:false — loadInvitations() is called unconditionally inside the ok branch, not only on success", () => {
    const okBranch = handleInvite.match(/if \(result\.status === "ok"\) \{([\s\S]*?)\} else if \(result\.status === "denied"\)/);
    expect(okBranch).not.toBeNull();
    const body = okBranch![1];
    const ifDeliveredIndex = body.indexOf("if (result.delivered)");
    const loadInvitationsIndex = body.indexOf("loadInvitations();");
    expect(ifDeliveredIndex).toBeGreaterThan(-1);
    expect(loadInvitationsIndex).toBeGreaterThan(-1);
    // loadInvitations() must be OUTSIDE/AFTER the if/else delivered branch —
    // i.e. it runs regardless of which branch was taken, not duplicated
    // inside only one of them.
    const closingBraceOfIfElse = body.indexOf("}", body.lastIndexOf("setInviteDeliveryWarning"));
    expect(loadInvitationsIndex).toBeGreaterThan(closingBraceOfIfElse);
  });

  it("does not treat delivered:false as a creation failure — it stays in the 'ok' status branch, never 'denied'/'error'", () => {
    expect(handleInvite).not.toMatch(/result\.delivered[\s\S]{0,40}status === "denied"/);
  });
});

describe("WorkspaceMembersShell — handleResend delivery-outcome messaging", () => {
  const handleResend = extractFunctionBody("handleResend");

  it("K. resend delivered:true displays a resent confirmation", () => {
    expect(handleResend).toMatch(/if \(result\.delivered\) \{\s*setActionConfirmation\("Invitation resent\."\);/);
  });

  it("L. resend delivered:false does NOT display a false success message — it takes the else branch with a truthful warning, never 'Resend failed'", () => {
    const deliveredTrueIndex = handleResend.indexOf("if (result.delivered) {");
    const elseIndex = handleResend.indexOf("} else {", deliveredTrueIndex);
    expect(deliveredTrueIndex).toBeGreaterThan(-1);
    expect(elseIndex).toBeGreaterThan(deliveredTrueIndex);
    const elseBody = handleResend.slice(elseIndex, handleResend.indexOf("}", elseIndex + 200));
    expect(elseBody).not.toMatch(/setActionConfirmation/);
    expect(elseBody).toMatch(/setActionDeliveryWarning\("Email could not be sent\. Please try again\."\)/);
    expect(source).not.toMatch(/Resend failed/);
  });

  it("M. the pending invitation list is refreshed on BOTH delivered:true and delivered:false — the invitation is never hidden merely because email dispatch failed", () => {
    const okBranch = handleResend.match(/if \(result\.status === "ok"\) \{([\s\S]*?)\} else if \(result\.status === "denied"\)/);
    expect(okBranch).not.toBeNull();
    const body = okBranch![1];
    const closingBraceOfIfElse = body.indexOf("}", body.lastIndexOf("setActionDeliveryWarning"));
    const loadInvitationsIndex = body.indexOf("loadInvitations();");
    expect(loadInvitationsIndex).toBeGreaterThan(closingBraceOfIfElse);
  });
});

describe("WorkspaceMembersShell — no raw provider/internal details ever rendered", () => {
  it("never renders deliveryError, provider internals, or a raw Resend/config error string", () => {
    expect(source).not.toMatch(/deliveryError/);
    expect(source).not.toMatch(/preview_delivery_disabled/);
    expect(source).not.toMatch(/provider_rejected|provider_unavailable|configuration_missing/);
  });

  it("warning messages use the cp-orange design token, distinct from both the success (cp-accent) and error (red) styling", () => {
    expect(source).toMatch(/inviteDeliveryWarning[\s\S]{0,200}text-cp-orange/);
    expect(source).toMatch(/actionDeliveryWarning[\s\S]{0,200}text-cp-orange/);
  });
});

/**
 * PHASE TEAM-MGMT-12A-I1 — active member removal UI. Same jsdom/
 * @testing-library-free constraint as above (confirmed again directly:
 * `jest.config.ts` sets `testEnvironment: "node"`, and neither `jsdom` nor
 * `@testing-library/react` is a dependency of this repo) — adding either
 * would be an unrelated infrastructure change outside this narrow phase's
 * authorized scope, so interactive removal behavior is proven the same way
 * every other interactive behavior in this file already is: `readFileSync`
 * + regex against the real component source.
 */
describe("WorkspaceMembersShell — Remove eligibility (client-side UX hint only; backend remains authoritative)", () => {
  it("AU/AV. Owner-removable role set is exactly admin/member/reviewer/viewer — never owner", () => {
    const match = source.match(/const OWNER_REMOVABLE_ROLES: readonly WorkspaceMemberRole\[\] = \[([^\]]*)\];/);
    expect(match).not.toBeNull();
    const roles = match![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(roles.sort()).toEqual(["admin", "member", "reviewer", "viewer"].sort());
  });

  it("AX/AY/AZ/BA. Admin-removable role set is exactly member/reviewer/viewer — never admin, never owner", () => {
    const match = source.match(/const ADMIN_REMOVABLE_ROLES: readonly WorkspaceMemberRole\[\] = \[([^\]]*)\];/);
    expect(match).not.toBeNull();
    const roles = match![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(roles.sort()).toEqual(["member", "reviewer", "viewer"].sort());
  });

  it("owner is structurally excluded from canRemoveMemberRole for every caller — a hard-coded early return, not merely absent from a set", () => {
    const match = source.match(/function canRemoveMemberRole\(callerRole: WorkspaceMemberRole, targetRole: WorkspaceMemberRole\): boolean \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/if \(targetRole === "owner"\) return false;/);
  });

  it("BB. AW. eligibility requires ALL of: canManageInvitations (members.manage), not canonical Owner, not self, and canRemoveMemberRole — any one being false hides Remove", () => {
    expect(source).toMatch(
      /const eligibleForRemoval = canManageInvitations && !m\.isCanonicalOwner && m\.uid !== user\?\.uid && canRemoveMemberRole\(callerRole, m\.role\);/
    );
  });

  it("BC. lower-role callers (member/reviewer/viewer) never see Remove — canRemoveMemberRole falls through to the unconditional false for any caller that isn't owner or admin", () => {
    const match = source.match(/function canRemoveMemberRole\(callerRole: WorkspaceMemberRole, targetRole: WorkspaceMemberRole\): boolean \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const body = match![1];
    // Only "owner" and "admin" branches return a role-set lookup; every other caller falls through.
    const ownerBranch = body.indexOf('if (callerRole === "owner")');
    const adminBranch = body.indexOf('if (callerRole === "admin")');
    const fallthrough = body.trim().split("\n").pop()!.trim();
    expect(ownerBranch).toBeGreaterThan(-1);
    expect(adminBranch).toBeGreaterThan(ownerBranch);
    expect(fallthrough).toBe("return false;");
  });
});

describe("WorkspaceMembersShell — handleRemove wiring and safety", () => {
  const handleRemove = extractFunctionBody("handleRemove");

  it("BF. calls removeMember exactly once per invocation, via the canonical client helper", () => {
    expect(handleRemove).toMatch(/const result = await removeMember\(\{ user, authReady, workspaceId, targetUid: member\.uid \}\);/);
    const occurrences = (handleRemove.match(/removeMember\(/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("BH. successful removal ('ok') refreshes the canonical member list via loadMembers() — never a locally-spliced member array", () => {
    const okBranch = handleRemove.match(/if \(result\.status === "ok"\) \{([\s\S]*?)\} else if \(result\.status === "denied"\)/);
    expect(okBranch).not.toBeNull();
    expect(okBranch![1]).toMatch(/loadMembers\(\);/);
    expect(okBranch![1]).not.toMatch(/setMembers\(/);
  });

  it("BI. denied/error branches never call loadMembers() with a fabricated success state, and never call setMembers directly — the member is not optimistically removed on failure", () => {
    expect(handleRemove).not.toMatch(/setMembers\(/);
  });

  it("clears confirmRemoveUid after the attempt completes, regardless of outcome — the confirmation UI does not linger after a failed attempt", () => {
    const beforeResult = handleRemove.indexOf("const result = await removeMember");
    const clearConfirm = handleRemove.indexOf("setConfirmRemoveUid(null);");
    expect(clearConfirm).toBeGreaterThan(beforeResult);
  });
});

describe("WorkspaceMembersShell — Remove confirmation UX (BD/BE/BG/BJ)", () => {
  it("BD. the Remove trigger button opens confirmation (setConfirmRemoveUid) — it does NOT call handleRemove directly; mutation only ever happens from the confirmation block", () => {
    const triggerButtonMatch = source.match(/onClick=\{\(\) => \{\s*setRemoveError\(null\);\s*setRemoveConfirmation\(null\);\s*setConfirmRemoveUid\(m\.uid\);\s*\}\}/);
    expect(triggerButtonMatch).not.toBeNull();
    // handleRemove is only invoked from the "Remove member" confirm button, never from the initial trigger.
    const handleRemoveCallSites = (source.match(/onClick=\{\(\) => handleRemove\(m\)\}/g) || []).length;
    expect(handleRemoveCallSites).toBe(1);
  });

  it("BE. Cancel inside the confirmation block only clears confirmRemoveUid — it never calls handleRemove/removeMember", () => {
    const confirmBlockMatch = source.match(/\{confirmRemoveUid === m\.uid && \(([\s\S]*?)\n\s{18}\)\}/);
    expect(confirmBlockMatch).not.toBeNull();
    const cancelButtonMatch = confirmBlockMatch![1].match(/onClick=\{\(\) => setConfirmRemoveUid\(null\)\}/);
    expect(cancelButtonMatch).not.toBeNull();
  });

  it("BG. both the trigger and the destructive confirm button are disabled while a removal is pending — prevents duplicate submission", () => {
    expect(source).toMatch(/onClick=\{\(\) => handleRemove\(m\)\}\s*disabled=\{isRemovePending\}/);
    // The initial trigger button is also disabled while pending.
    const triggerBlock = source.match(/eligibleForRemoval && confirmRemoveUid !== m\.uid && \(([\s\S]*?)\)\)\}/);
    expect(triggerBlock).not.toBeNull();
    expect(triggerBlock![1]).toMatch(/disabled=\{isRemovePending\}/);
  });

  it("BJ. confirmation copy explicitly communicates immediate, broad access loss — not a vague/generic warning", () => {
    expect(source).toMatch(/They will immediately lose access to this Workspace and its projects, research, reviews, and governance information\./);
  });

  it("confirmation identifies the specific member by display name and target Workspace, not by uid", () => {
    expect(source).toMatch(/Remove <span className="font-medium">\{m\.displayName\}<\/span> from \{workspaceName\}\?/);
  });
});

describe("WorkspaceMembersShell — canonical Owner is never offered Remove, structurally", () => {
  it("the eligibility expression itself excludes isCanonicalOwner — not merely relying on the role-policy helper's owner exclusion as a second line of defense", () => {
    expect(source).toMatch(/!m\.isCanonicalOwner/);
  });
});

describe("WorkspaceMembersShell — Workspace Audit Log, Phase TEAM-GOV-I1: nav link", () => {
  it("AP/AQ. canReadAudit truthy renders a nav link to the Audit Log page for this exact Workspace", () => {
    expect(source).toMatch(/\{canReadAudit && \(/);
    expect(source).toMatch(/\/workspace\/team\/\$\{encodeURIComponent\(workspaceId\)\}\/audit/);
    expect(source).toMatch(/Audit Log/);
  });

  it("AR/AS/AT. canReadAudit is a real conditional gate, not always-rendered — Member/Reviewer/Viewer (who never receive canReadAudit:true from the server) see no link", () => {
    const navBlock = source.match(/\{canReadAudit && \(([\s\S]*?)\)\}/);
    expect(navBlock).not.toBeNull();
    expect(navBlock![1]).toMatch(/<nav/);
  });

  it("canReadAudit is optional (backend-driven only) — an omitted prop never crashes the component", () => {
    expect(source).toMatch(/canReadAudit\?: boolean/);
  });
});

