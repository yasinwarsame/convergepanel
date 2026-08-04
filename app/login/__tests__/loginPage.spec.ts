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
});
