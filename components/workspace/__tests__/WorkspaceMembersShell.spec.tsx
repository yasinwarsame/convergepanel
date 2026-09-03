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

/**
 * Ownership Transfer UI, Phase TEAM-MGMT-12C — same jsdom-free,
 * `readFileSync` + regex approach as every other interactive-behavior test
 * in this file (see the module-level doc comment above).
 */
describe("WorkspaceMembersShell — Transfer ownership eligibility (client-side UX hint only; backend remains authoritative)", () => {
  it("callerIsCanonicalOwner is derived from the caller's OWN row in members via m.isCanonicalOwner — never the coarser callerRole prop", () => {
    expect(source).toMatch(/const callerIsCanonicalOwner = members\.some\(\(m\) => m\.uid === user\?\.uid && m\.isCanonicalOwner\);/);
  });

  it("canTransferOwnershipTo requires callerIsCanonicalOwner as a hard early-return — a non-Owner caller can never pass this check, structurally", () => {
    const match = source.match(/function canTransferOwnershipTo\(callerIsCanonicalOwner: boolean, targetRole: WorkspaceMemberRole\): boolean \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/if \(!callerIsCanonicalOwner\) return false;/);
  });

  it("canTransferOwnershipTo excludes role === \"owner\" targets — mirrors the backend's exact eligibility rule (role !== \"owner\")", () => {
    const match = source.match(/function canTransferOwnershipTo\(callerIsCanonicalOwner: boolean, targetRole: WorkspaceMemberRole\): boolean \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/if \(targetRole === "owner"\) return false;/);
  });

  it("eligibility for each row requires canTransferOwnershipTo(...) AND excludes the caller's own row (m.uid !== user?.uid)", () => {
    expect(source).toMatch(/const eligibleForTransfer = canTransferOwnershipTo\(callerIsCanonicalOwner, m\.role\) && m\.uid !== user\?\.uid;/);
  });
});

describe("WorkspaceMembersShell — handleTransfer wiring and safety", () => {
  const handleTransfer = extractFunctionBody("handleTransfer");

  it("calls transferWorkspaceOwnership exactly once per invocation, via the canonical client helper, with the target uid as newOwnerUid", () => {
    expect(handleTransfer).toMatch(/const result = await transferWorkspaceOwnership\(\{/);
    expect(handleTransfer).toMatch(/newOwnerUid: member\.uid,/);
    const occurrences = (handleTransfer.match(/transferWorkspaceOwnership\(/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("passes all three OCC tokens through: the Workspace-level token and each membership's own updateTimeToken", () => {
    expect(handleTransfer).toMatch(/expectedWorkspaceUpdateTime: workspaceUpdateToken,/);
    expect(handleTransfer).toMatch(/expectedOldOwnerMembershipUpdateTime: callerMember\.updateTimeToken,/);
    expect(handleTransfer).toMatch(/expectedNewOwnerMembershipUpdateTime: member\.updateTimeToken,/);
  });

  it("successful transfer ('ok') refreshes the canonical member list via loadMembers() — never a locally-computed role swap", () => {
    const okBranch = handleTransfer.match(/if \(result\.status === "ok"\) \{([\s\S]*?)\} else if \(result\.status === "denied" && result\.errorCode === "conflict"\)/);
    expect(okBranch).not.toBeNull();
    expect(okBranch![1]).toMatch(/loadMembers\(\);/);
    expect(okBranch![1]).not.toMatch(/setMembers\(/);
  });

  it("never calls setMembers directly anywhere — no optimistic client-side role mutation on success or failure", () => {
    expect(handleTransfer).not.toMatch(/setMembers\(/);
  });

  it("a stale-OCC/'conflict' denial shows a specific refresh-oriented message, distinct from the generic denied branch", () => {
    expect(handleTransfer).toMatch(/result\.status === "denied" && result\.errorCode === "conflict"/);
    expect(handleTransfer).toMatch(/setTransferError\("The Workspace changed before the transfer completed\. Refresh and try again\."\);/);
  });

  it("a generic denial surfaces the server's own already-sanitized message, never raw backend detail", () => {
    const genericDeniedBranch = handleTransfer.match(/\} else if \(result\.status === "denied"\) \{([\s\S]*?)\} else \{/);
    expect(genericDeniedBranch).not.toBeNull();
    expect(genericDeniedBranch![1]).toMatch(/setTransferError\(result\.message\);/);
  });

  it("clears confirmTransferUid after the attempt completes, regardless of outcome", () => {
    const beforeResult = handleTransfer.indexOf("const result = await transferWorkspaceOwnership");
    // The FIRST setConfirmTransferUid(null) call is inside the early
    // missing-token guard clause (before any request is even sent); the
    // one that matters here — clearing confirmation after a completed
    // attempt — is the LAST occurrence in the function body.
    const clearConfirmAfterAttempt = handleTransfer.lastIndexOf("setConfirmTransferUid(null);");
    expect(clearConfirmAfterAttempt).toBeGreaterThan(beforeResult);
  });

  it("guards against a missing caller row or missing workspaceUpdateToken (fails closed with a generic message, never proceeds to call the API with undefined tokens)", () => {
    expect(handleTransfer).toMatch(/if \(!callerMember \|\| !workspaceUpdateToken\) \{/);
  });
});

describe("WorkspaceMembersShell — Transfer ownership confirmation UX", () => {
  it("the Transfer ownership trigger button opens confirmation (setConfirmTransferUid) — it does NOT call handleTransfer directly; mutation only ever happens from the confirmation block", () => {
    const triggerButtonMatch = source.match(/onClick=\{\(\) => \{\s*setTransferError\(null\);\s*setTransferConfirmation\(null\);\s*setConfirmTransferUid\(m\.uid\);\s*\}\}/);
    expect(triggerButtonMatch).not.toBeNull();
    const handleTransferCallSites = (source.match(/onClick=\{\(\) => handleTransfer\(m\)\}/g) || []).length;
    expect(handleTransferCallSites).toBe(1);
  });

  it("Cancel inside the transfer confirmation block clears confirmTransferUid via its own distinct onClick handler (never handleTransfer's)", () => {
    const confirmBlockMatch = source.match(/\{confirmTransferUid === m\.uid && \(([\s\S]*?)\n\s{18}\)\}/);
    expect(confirmBlockMatch).not.toBeNull();
    const cancelButtonMatch = confirmBlockMatch![1].match(/onClick=\{\(\) => setConfirmTransferUid\(null\)\}/);
    expect(cancelButtonMatch).not.toBeNull();
    // Exactly one call site in the whole component invokes handleTransfer
    // (the mutating confirm button, asserted separately above) — the
    // Cancel button's own onClick is the distinct, literal
    // setConfirmTransferUid(null) string just matched, never a call to
    // handleTransfer.
    expect(cancelButtonMatch![0]).not.toMatch(/handleTransfer/);
  });

  it("both the trigger and the confirm button are disabled while a transfer is pending — prevents duplicate submission", () => {
    expect(source).toMatch(/onClick=\{\(\) => handleTransfer\(m\)\}\s*disabled=\{isTransferPending\}/);
    const triggerBlock = source.match(/eligibleForTransfer && confirmTransferUid !== m\.uid && \(([\s\S]*?)\)\)\}/);
    expect(triggerBlock).not.toBeNull();
    expect(triggerBlock![1]).toMatch(/disabled=\{isTransferPending\}/);
  });

  it("confirmation copy names the target and explains the exact role consequences — never a vague 'Confirm' button", () => {
    expect(source).toMatch(/Transfer ownership to <span className="font-medium">\{m\.displayName\}<\/span>\?/);
    expect(source).toMatch(/will become the Workspace Owner\./);
    expect(source).toMatch(/You will become an Admin\./);
    expect(source).toMatch(/Only the new Owner will be able to transfer ownership again\./);
    expect(source).not.toMatch(/>Confirm<\/button>/);
  });

  it("the confirm button's own label is never a vague 'Confirm' — it explicitly reads 'Transfer ownership'", () => {
    expect(source).toMatch(/\{isTransferPending \? "…" : "Transfer ownership"\}/);
  });
});

describe("WorkspaceMembersShell — canonical Owner and self are never offered Transfer ownership, structurally", () => {
  it("targetRole === \"owner\" is excluded inside canTransferOwnershipTo itself, not merely relying on the caller-side member list never containing a second Owner row", () => {
    const match = source.match(/function canTransferOwnershipTo\(callerIsCanonicalOwner: boolean, targetRole: WorkspaceMemberRole\): boolean \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/targetRole === "owner"/);
  });

  it("the eligibility expression itself excludes the caller's own row (m.uid !== user?.uid)", () => {
    expect(source).toMatch(/canTransferOwnershipTo\(callerIsCanonicalOwner, m\.role\) && m\.uid !== user\?\.uid/);
  });
});

/**
 * Active Member Role Management, Phase 12B — same jsdom-free, `readFileSync`
 * + regex approach as every other interactive-behavior test in this file
 * (see the module-level doc comment above).
 */

describe("WorkspaceMembersShell — Change role eligibility (client-side UX hint only; backend remains authoritative)", () => {
  it("canManageMemberRoleTarget delegates to canRemoveMemberRole — the same target-authority matrix, not a re-duplicated role set", () => {
    expect(source).toMatch(/function canManageMemberRoleTarget\(callerRole: WorkspaceMemberRole, targetRole: WorkspaceMemberRole\): boolean \{\s*return canRemoveMemberRole\(callerRole, targetRole\);\s*\}/);
  });

  it("Owner-assignable destination role set is exactly admin/member/reviewer/viewer — never owner", () => {
    const match = source.match(/const OWNER_ASSIGNABLE_ROLES: readonly MembershipDestinationRole\[\] = \[([^\]]*)\];/);
    expect(match).not.toBeNull();
    const roles = match![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(roles.sort()).toEqual(["admin", "member", "reviewer", "viewer"].sort());
  });

  it("Admin-assignable destination role set is exactly member/reviewer/viewer — never admin, never owner", () => {
    const match = source.match(/const ADMIN_ASSIGNABLE_ROLES: readonly MembershipDestinationRole\[\] = \[([^\]]*)\];/);
    expect(match).not.toBeNull();
    const roles = match![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(roles.sort()).toEqual(["member", "reviewer", "viewer"].sort());
  });

  it("assignableDestinationRoles falls through to an empty array for any caller that isn't owner or admin — lower roles are structurally offered nothing", () => {
    const match = source.match(/function assignableDestinationRoles\(callerRole: WorkspaceMemberRole\): readonly MembershipDestinationRole\[\] \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const fallthrough = match![1].trim().split("\n").pop()!.trim();
    expect(fallthrough).toBe("return [];");
  });

  it("roleChangeOptionsFor excludes the target's own current role from the offered destinations — never offered as a 'new' role", () => {
    expect(source).toMatch(/function roleChangeOptionsFor\(callerRole: WorkspaceMemberRole, targetRole: WorkspaceMemberRole\): MembershipDestinationRole\[\] \{\s*return assignableDestinationRoles\(callerRole\)\.filter\(\(r\) => r !== targetRole\);\s*\}/);
  });

  it("eligibility requires ALL of: canManageInvitations (members.manage), not canonical Owner, not self, target-authority, AND at least one legal destination role", () => {
    expect(source).toMatch(
      /const roleChangeOptions = roleChangeOptionsFor\(callerRole, m\.role\);\s*const eligibleForRoleChange = canManageInvitations && !m\.isCanonicalOwner && m\.uid !== user\?\.uid && canManageMemberRoleTarget\(callerRole, m\.role\) && roleChangeOptions\.length > 0;/
    );
  });
});

describe("WorkspaceMembersShell — handleRoleChange wiring and safety", () => {
  const handleRoleChange = extractFunctionBody("handleRoleChange");

  it("calls changeMemberRole exactly once per invocation, via the canonical client helper, with the target uid and the requested destination role", () => {
    expect(handleRoleChange).toMatch(/const result = await changeMemberRole\(\{ user, authReady, workspaceId, targetUid: member\.uid, role: destinationRole \}\);/);
    const occurrences = (handleRoleChange.match(/changeMemberRole\(/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("a genuine change (result.changed === true) refreshes the canonical member list via loadMembers() — never a locally-computed role swap", () => {
    const changedBranch = handleRoleChange.match(/if \(result\.changed\) \{([\s\S]*?)\} else \{/);
    expect(changedBranch).not.toBeNull();
    expect(changedBranch![1]).toMatch(/loadMembers\(\);/);
    expect(changedBranch![1]).not.toMatch(/setMembers\(/);
  });

  it("a same-role no-op (result.changed === false) does NOT call loadMembers() — nothing actually moved on the server", () => {
    const noopBranch = handleRoleChange.match(/\} else \{\s*setRoleChangeConfirmation\(`\$\{member\.displayName\} already has that role\.`\);\s*\}/);
    expect(noopBranch).not.toBeNull();
    expect(noopBranch![0]).not.toMatch(/loadMembers\(\);/);
  });

  it("never calls setMembers directly anywhere — no optimistic client-side role mutation on success or failure", () => {
    expect(handleRoleChange).not.toMatch(/setMembers\(/);
  });

  it("a denied response surfaces the server's own already-sanitized message, never raw backend detail", () => {
    expect(handleRoleChange).toMatch(/\} else if \(result\.status === "denied"\) \{\s*setRoleChangeError\(result\.message\);\s*\}/);
  });

  it("clears confirmRoleChangeUid and selectedDestinationRole after the attempt completes, regardless of outcome", () => {
    const beforeResult = handleRoleChange.indexOf("const result = await changeMemberRole");
    const clearConfirm = handleRoleChange.indexOf("setConfirmRoleChangeUid(null);");
    const clearSelection = handleRoleChange.indexOf("setSelectedDestinationRole(null);");
    expect(clearConfirm).toBeGreaterThan(beforeResult);
    expect(clearSelection).toBeGreaterThan(beforeResult);
  });
});

describe("WorkspaceMembersShell — Change role confirmation UX", () => {
  it("the Change role trigger button opens confirmation (setConfirmRoleChangeUid) and pre-selects the first legal destination — it does NOT call handleRoleChange directly; mutation only ever happens from the confirmation block", () => {
    const triggerButtonMatch = source.match(
      /onClick=\{\(\) => \{\s*setRoleChangeError\(null\);\s*setRoleChangeConfirmation\(null\);\s*setSelectedDestinationRole\(roleChangeOptions\[0\] \?\? null\);\s*setConfirmRoleChangeUid\(m\.uid\);\s*\}\}/
    );
    expect(triggerButtonMatch).not.toBeNull();
    const handleRoleChangeCallSites = (source.match(/onClick=\{\(\) => selectedDestinationRole && handleRoleChange\(m, selectedDestinationRole\)\}/g) || []).length;
    expect(handleRoleChangeCallSites).toBe(1);
  });

  it("Cancel inside the confirmation block only clears confirmRoleChangeUid/selectedDestinationRole — its own onClick never calls handleRoleChange/changeMemberRole", () => {
    const confirmBlockMatch = source.match(/\{confirmRoleChangeUid === m\.uid && \(([\s\S]*?)\n\s{18}\)\}/);
    expect(confirmBlockMatch).not.toBeNull();
    const cancelButtonMatch = confirmBlockMatch![1].match(/onClick=\{\(\) => \{\s*setConfirmRoleChangeUid\(null\);\s*setSelectedDestinationRole\(null\);\s*\}\}/);
    expect(cancelButtonMatch).not.toBeNull();
    expect(cancelButtonMatch![0]).not.toMatch(/handleRoleChange/);
  });

  it("the destination <select> is populated exclusively from roleChangeOptions for this row — never a hard-coded/static role list", () => {
    const confirmBlockMatch = source.match(/\{confirmRoleChangeUid === m\.uid && \(([\s\S]*?)\n\s{18}\)\}/);
    expect(confirmBlockMatch).not.toBeNull();
    expect(confirmBlockMatch![1]).toMatch(/\{roleChangeOptions\.map\(\(r\) => \(/);
  });

  it("the confirm button is disabled when no destination role is selected, in addition to while pending — never submits with an empty selection", () => {
    expect(source).toMatch(/onClick=\{\(\) => selectedDestinationRole && handleRoleChange\(m, selectedDestinationRole\)\}\s*disabled=\{isRoleChangePending \|\| !selectedDestinationRole\}/);
  });

  it("confirmation copy names the target, shows their current role, and explicitly warns permissions change immediately — never a vague 'Confirm'", () => {
    expect(source).toMatch(/Change <span className="font-medium">\{m\.displayName\}<\/span>&apos;s role\?/);
    expect(source).toMatch(/Current role: <span className="font-medium">\{ROLE_LABEL\[m\.role\]\}<\/span>/);
    expect(source).toMatch(/Their Workspace permissions will change immediately\./);
  });

  it("the confirm button's own label is never a vague 'Confirm' — it explicitly reads 'Change role'", () => {
    expect(source).toMatch(/\{isRoleChangePending \? "…" : "Change role"\}/);
  });
});

describe("WorkspaceMembersShell — canonical Owner and self are never offered Change role, structurally", () => {
  it("the eligibility expression itself excludes isCanonicalOwner and the caller's own row", () => {
    expect(source).toMatch(/const eligibleForRoleChange = canManageInvitations && !m\.isCanonicalOwner && m\.uid !== user\?\.uid/);
  });

  it("owner is structurally excluded as a destination — MembershipDestinationRole cannot express it, and the assignable-role constants never contain the string \"owner\"", () => {
    const ownerMatch = source.match(/const OWNER_ASSIGNABLE_ROLES[\s\S]*?const ADMIN_ASSIGNABLE_ROLES: readonly MembershipDestinationRole\[\] = \[([^\]]*)\];/);
    expect(ownerMatch).not.toBeNull();
    expect(ownerMatch![0]).not.toMatch(/"owner"/);
  });
});

describe("WorkspaceMembersShell — Workspace Audit Log, Phase TEAM-GOV-I1/12A.1: nav link", () => {
  it("Phase 12A.1 — renders the shared WorkspaceNav, passing canReadAudit straight through as showAudit (not a locally-duplicated tab strip)", () => {
    expect(source).toMatch(/import WorkspaceNav from ["']@\/components\/workspace\/WorkspaceNav["'];/);
    expect(source).toMatch(/<WorkspaceNav workspaceId=\{workspaceId\} active="members" showAudit=\{!!canReadAudit\} \/>/);
    // The old locally-duplicated <nav> markup must be gone — WorkspaceNav owns it now.
    expect(source).not.toMatch(/<nav className="mb-6 flex gap-4/);
  });

  it("canReadAudit is optional (backend-driven only) — an omitted prop never crashes the component (coerced to boolean before reaching WorkspaceNav)", () => {
    expect(source).toMatch(/canReadAudit\?: boolean/);
    expect(source).toMatch(/showAudit=\{!!canReadAudit\}/);
  });
});

