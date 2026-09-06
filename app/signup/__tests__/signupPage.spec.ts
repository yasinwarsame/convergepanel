/**
 * Auth Lifecycle Hardening, Step 6.15/6.17 — source-level regression test
 * for `app/signup/page.tsx`, mirroring `app/login/__tests__/loginPage.spec.ts`.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

describe("Signup page — source-level wiring guarantees", () => {
  it("no longer makes a raw fetch to the session endpoint itself", () => {
    expect(source).not.toMatch(/fetch\(\s*["']\/api\/auth\/session["']/);
  });

  it("redirects only inside the syncState-watching effect, gated on BOTH authenticated state and the matching uid", () => {
    expect(source).toMatch(/syncState === "authenticated" && authedUser\?\.uid === pendingSignupUid/);
  });

  it("tracks the pending signup uid as React state, not a ref — same race as app/login/page.tsx", () => {
    expect(source).toMatch(/const \[pendingSignupUid, setPendingSignupUid\] = useState/);
    expect(source).not.toMatch(/pendingSignupUidRef/);
  });

  it("router.push only appears inside that effect, never directly in handleSubmit's success path", () => {
    const handleSubmitMatch = source.match(/const handleSubmit = async[\s\S]*?\n  \};/);
    expect(handleSubmitMatch).not.toBeNull();
    expect(handleSubmitMatch![0]).not.toMatch(/router\.push/);
  });

  it("invalidates an existing session before starting a new sign-up — signing up while a different account is active is an account switch", () => {
    const handleSubmitMatch = source.match(/const handleSubmit = async[\s\S]*?\n  \};/);
    const body = handleSubmitMatch![0];
    const currentUserCheckIndex = body.indexOf("auth.currentUser");
    const createUserIndex = body.indexOf("createUserWithEmailAndPassword(");
    expect(currentUserCheckIndex).toBeGreaterThan(-1);
    expect(createUserIndex).toBeGreaterThan(-1);
    expect(currentUserCheckIndex).toBeLessThan(createUserIndex);
  });

  it("arms a bounded timeout rather than waiting forever for sync to complete", () => {
    expect(source).toMatch(/setTimeout\(/);
    expect(source).toMatch(/10000/);
  });

  describe("Phase P0.1-R4 — the profile write must MERGE, never replace", () => {
    /**
     * The Firestore rules deny a destructive replace of `users/{uid}`, because
     * removing server-owned keys puts them in `affectedKeys()`. A server
     * bootstrap can create that document before signup's own write lands, so a
     * bare `setDoc` strands the user: the Auth account exists, the profile
     * write is refused, and the handler does not redirect.
     *
     * This assertion lives here, in the ordinary unit suite, because it is the
     * one guard that runs WITHOUT the Firestore emulator. The rules spec models
     * this call, and a model can only stay honest if something checks it
     * against the real source.
     */
    it("passes { merge: true } to the users/{uid} setDoc", () => {
      const setDocIndex = source.indexOf('setDoc(doc(db, "users", user.uid)');
      expect(setDocIndex).toBeGreaterThan(-1);
      const call = source.slice(setDocIndex, setDocIndex + 600);
      expect(call).toMatch(/\}\)\s*,\s*\{\s*merge:\s*true\s*\}\s*\)/);
    });

    it("REGRESSION: the write is not a bare two-argument setDoc", () => {
      // `setDoc(ref, payload)` with no options is the pre-R4 shape that a
      // server-bootstrapped document refuses.
      const setDocIndex = source.indexOf('setDoc(doc(db, "users", user.uid)');
      const call = source.slice(setDocIndex, setDocIndex + 600);
      expect(call).not.toMatch(/\}\)\s*\)\s*;/);
    });
  });

  describe("Phase 3 — Personal Workspace provisioning trigger on signup", () => {
    it("calls POST /api/user/workspace via authedFetch", () => {
      expect(source).toMatch(/authedFetch\(\s*["']\/api\/user\/workspace["']/);
    });

    it("is wrapped in its own try/catch, isolated from the rest of the signup flow", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      expect(workspaceCallIndex).toBeGreaterThan(-1);
      const surroundingBlock = source.slice(Math.max(0, workspaceCallIndex - 400), workspaceCallIndex + 200);
      expect(surroundingBlock).toMatch(/try\s*{/);
      expect(surroundingBlock).toMatch(/catch/);
    });

    it("fires after the profile setDoc, and is AWAITED (not fire-and-forget) — hardened per independent review", () => {
      const setDocIndex = source.indexOf('setDoc(doc(db, "users", user.uid)');
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      expect(setDocIndex).toBeGreaterThan(-1);
      expect(workspaceCallIndex).toBeGreaterThan(setDocIndex);
      expect(source).toMatch(/await authedFetch\(\s*["']\/api\/user\/workspace["']/);
      // No longer fire-and-forget: this call must NOT be wrapped in a
      // setTimeout closure — a setTimeout callback's own promise is never
      // awaited by the surrounding handleSubmit, which is exactly the
      // race the hardening closes.
      const surroundingBlock = source.slice(Math.max(0, workspaceCallIndex - 600), workspaceCallIndex);
      expect(surroundingBlock).not.toMatch(/setTimeout\(async \(\) => \{[\s\S]*$/);
    });

    it("a genuine provisioning failure (not provisioning_disabled) blocks the redirect and surfaces a retryable error, rather than continuing into onboarding", () => {
      expect(source).toMatch(/errorCode === ["']provisioning_disabled["']/);
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      const afterCall = source.slice(workspaceCallIndex, workspaceCallIndex + 1200);
      expect(afterCall).toMatch(/if \(!personalWorkspaceReady\)/);
      expect(afterCall).toMatch(/setError\(/);
      expect(afterCall).toMatch(/return;/);
    });

    it("does not delete or otherwise touch the just-created Firebase Auth account on provisioning failure", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      const afterCall = source.slice(workspaceCallIndex, workspaceCallIndex + 1200);
      expect(afterCall).not.toMatch(/deleteUser/);
      expect(afterCall).not.toMatch(/signOut/);
    });

    it("a network-level failure (fetch throwing) does NOT block signup — only a well-formed non-disabled error response does. A prior version of this hardening regressed this: any thrown error unconditionally blocked signup even while Phase 3 is entirely dark", () => {
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      const tryBlockStart = source.lastIndexOf("try {", workspaceCallIndex);
      const catchBlockEnd = source.indexOf("if (!personalWorkspaceReady)", workspaceCallIndex);
      const tryCatchBlock = source.slice(tryBlockStart, catchBlockEnd);
      const catchIndex = tryCatchBlock.indexOf("} catch (err: any) {");
      expect(catchIndex).toBeGreaterThan(-1);
      const catchBody = tryCatchBlock.slice(catchIndex);
      expect(catchBody).not.toMatch(/personalWorkspaceReady\s*=\s*false/);
    });
  });

  describe("Phase FIRESTORE-AUTHZ-P0.2 — mailbox ownership proof", () => {
    /**
     * Signup previously created accounts and never sent a verification email,
     * and the app has no OAuth provider — so every account was permanently
     * `emailVerified: false`. That was the enabling condition for the P0.2
     * vulnerability, and once verification became REQUIRED for allowlist-derived
     * authority it would also have left a legitimate administrator with no
     * product path to ever become verified.
     */
    it("requests a Firebase verification email after account creation", () => {
      expect(source).toMatch(/import \{[^}]*sendEmailVerification[^}]*\} from "firebase\/auth"/);
      expect(source).toMatch(/await sendEmailVerification\(user\)/);
      const createIndex = source.indexOf("createUserWithEmailAndPassword(");
      const sendIndex = source.indexOf("sendEmailVerification(user)");
      expect(sendIndex).toBeGreaterThan(createIndex);
    });

    it("does not resend when the identity is already verified", () => {
      const sendIndex = source.indexOf("sendEmailVerification(user)");
      const before = source.slice(Math.max(0, sendIndex - 300), sendIndex);
      expect(before).toMatch(/if \(!user\.emailVerified\)/);
    });

    it("delivery failure is caught and never converts a created account into a signup failure", () => {
      const sendIndex = source.indexOf("sendEmailVerification(user)");
      const region = source.slice(Math.max(0, sendIndex - 300), sendIndex + 300);
      expect(region).toMatch(/try\s*\{/);
      expect(region).toMatch(/catch/);
      // No error surfaced, no redirect blocked, no rollback of the account.
      expect(region).not.toMatch(/setError\(/);
      expect(region).not.toMatch(/return;/);
      expect(region).not.toMatch(/deleteUser/);
      expect(region).not.toMatch(/signOut/);
    });

    it("does not log the verification link or any credential material", () => {
      const sendIndex = source.indexOf("sendEmailVerification(user)");
      const region = source.slice(Math.max(0, sendIndex - 300), sendIndex + 300);
      expect(region).not.toMatch(/console\.(log|warn|error)/);
    });

    it("REGRESSION: the P0.1 merge semantics of the profile write are untouched", () => {
      const setDocIndex = source.indexOf('setDoc(doc(db, "users", user.uid)');
      const call = source.slice(setDocIndex, setDocIndex + 600);
      expect(call).toMatch(/\}\)\s*,\s*\{\s*merge:\s*true\s*\}\s*\)/);
    });
  });
});
