/**
 * Auth Lifecycle Hardening, Step 6.15/6.17 — source-level regression test
 * for `app/login/page.tsx`. Root cause this closes: the redirect after
 * `signInWithEmailAndPassword` previously fired immediately, before the
 * (best-effort, unchecked) session-cookie POST had any chance to complete
 * or be verified — "login is not application-complete until server
 * session uid equals Firebase client uid" was not enforced anywhere.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

describe("Login page — source-level wiring guarantees", () => {
  it("no longer makes a raw fetch to the session endpoint itself — synchronization is owned by AuthProvider", () => {
    expect(source).not.toMatch(/fetch\(\s*["']\/api\/auth\/session["']/);
  });

  it("redirects only inside the syncState-watching effect, gated on BOTH authenticated state and the matching uid", () => {
    expect(source).toMatch(/syncState === "authenticated" && authedUser\?\.uid === pendingLoginUid/);
  });

  it("tracks the pending login uid as React state, not a ref — a ref mutation would not re-run the watching effect if AuthProvider's own sync already settled before it was armed", () => {
    expect(source).toMatch(/const \[pendingLoginUid, setPendingLoginUid\] = useState/);
    expect(source).not.toMatch(/pendingLoginUidRef/);
  });

  it("router.push only appears inside that effect, never directly in handleSubmit's success path", () => {
    const handleSubmitMatch = source.match(/const handleSubmit = async[\s\S]*?\n  \};/);
    expect(handleSubmitMatch).not.toBeNull();
    expect(handleSubmitMatch![0]).not.toMatch(/router\.push/);
  });

  it("invalidates an existing session (clearServerSession + signOut) before starting a new sign-in — account-switch handling", () => {
    const handleSubmitMatch = source.match(/const handleSubmit = async[\s\S]*?\n  \};/);
    const body = handleSubmitMatch![0];
    const currentUserCheckIndex = body.indexOf("auth.currentUser");
    const signInIndex = body.indexOf("signInWithEmailAndPassword(");
    expect(currentUserCheckIndex).toBeGreaterThan(-1);
    expect(signInIndex).toBeGreaterThan(-1);
    expect(currentUserCheckIndex).toBeLessThan(signInIndex);
    expect(body).toMatch(/await clearServerSession\(\)/);
    expect(body).toMatch(/await signOut\(auth\)/);
  });

  it("arms a bounded timeout rather than waiting forever for sync to complete", () => {
    expect(source).toMatch(/setTimeout\(/);
    expect(source).toMatch(/10000/);
  });

  it("surfaces an explicit error and re-enables the form on session_error, rather than silently retrying", () => {
    expect(source).toMatch(/syncState === "session_error"/);
    expect(source).toMatch(/setLoading\(false\)/);
  });

  describe("Phase 3 — Personal Workspace self-heal on login", () => {
    it("calls POST /api/user/workspace via authedFetch", () => {
      expect(source).toMatch(/authedFetch\(\s*["']\/api\/user\/workspace["']/);
    });

    it("is wrapped in its own try/catch, isolated from the rest of the login flow", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      expect(workspaceCallIndex).toBeGreaterThan(-1);
      const surroundingBlock = source.slice(Math.max(0, workspaceCallIndex - 400), workspaceCallIndex + 200);
      expect(surroundingBlock).toMatch(/try\s*{/);
      expect(surroundingBlock).toMatch(/catch/);
    });

    it("is AWAITED before the redirect-arming call (setPendingLoginUid), not fire-and-forget — hardened per independent review", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      expect(source).toMatch(/await authedFetch\(\s*["']\/api\/user\/workspace["']/);
      const pendingLoginArmIndex = source.indexOf("setPendingLoginUid(user.uid)");
      expect(pendingLoginArmIndex).toBeGreaterThan(workspaceCallIndex);
      // Must not be wrapped in a setTimeout closure — a setTimeout
      // callback's own promise is never awaited by the surrounding
      // handleSubmit, which is exactly the race the hardening closes.
      const surroundingBlock = source.slice(Math.max(0, workspaceCallIndex - 600), workspaceCallIndex);
      expect(surroundingBlock).not.toMatch(/setTimeout\(async \(\) => \{[\s\S]*$/);
    });

    it("a genuine provisioning failure (not provisioning_disabled) blocks the redirect and surfaces a retryable error, rather than continuing to sign the user in", () => {
      expect(source).toMatch(/errorCode === ["']provisioning_disabled["']/);
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      const afterCall = source.slice(workspaceCallIndex, workspaceCallIndex + 1200);
      expect(afterCall).toMatch(/if \(!personalWorkspaceReady\)/);
      expect(afterCall).toMatch(/setError\(/);
      expect(afterCall).toMatch(/return;/);
      // The failure branch must precede arming the redirect.
      const failureBranchIndex = source.indexOf("if (!personalWorkspaceReady)");
      const pendingLoginArmIndex = source.indexOf("setPendingLoginUid(user.uid)");
      expect(failureBranchIndex).toBeGreaterThan(-1);
      expect(pendingLoginArmIndex).toBeGreaterThan(failureBranchIndex);
    });

    it("does not sign the user out or clear the session on provisioning failure — the Firebase Auth session remains valid for a retry", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      const afterCall = source.slice(workspaceCallIndex, workspaceCallIndex + 1200);
      expect(afterCall).not.toMatch(/clearServerSession\(\)/);
      expect(afterCall).not.toMatch(/signOut\(auth\)/);
    });

    it("a network-level failure (fetch throwing) does NOT block login — only a well-formed non-disabled error response does. A prior version of this hardening regressed this: any thrown error unconditionally blocked login even while Phase 3 is entirely dark", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      const tryBlockStart = source.lastIndexOf("try {", workspaceCallIndex);
      const catchBlockEnd = source.indexOf("if (!personalWorkspaceReady)", workspaceCallIndex);
      const tryCatchBlock = source.slice(tryBlockStart, catchBlockEnd);
      const catchIndex = tryCatchBlock.indexOf("} catch (err: any) {");
      expect(catchIndex).toBeGreaterThan(-1);
      const catchBody = tryCatchBlock.slice(catchIndex);
      // The catch body must not assign personalWorkspaceReady = false —
      // only the !workspaceRes.ok branch (a real HTTP response) may do
      // that, and only when errorCode !== "provisioning_disabled".
      expect(catchBody).not.toMatch(/personalWorkspaceReady\s*=\s*false/);
    });
  });
});
