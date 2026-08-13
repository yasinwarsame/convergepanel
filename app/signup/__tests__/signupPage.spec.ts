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

    it("fires after the profile setDoc, deferred via setTimeout rather than blocking the onboarding redirect", () => {
      const setDocIndex = source.indexOf('setDoc(doc(db, "users", user.uid)');
      const workspaceCallIndex = source.indexOf('authedFetch("/api/user/workspace"');
      expect(setDocIndex).toBeGreaterThan(-1);
      expect(workspaceCallIndex).toBeGreaterThan(setDocIndex);
      const precedingSetTimeout = source.lastIndexOf("setTimeout(async () => {", workspaceCallIndex);
      expect(precedingSetTimeout).toBeGreaterThan(setDocIndex);
    });
  });
});
