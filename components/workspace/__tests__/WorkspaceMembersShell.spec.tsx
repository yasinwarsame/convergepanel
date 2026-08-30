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
