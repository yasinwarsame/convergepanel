/**
 * Auth Lifecycle Hardening, Step 6.15/6.17 — source-level regression test
 * for `TopNav.tsx`'s logout flow. This is the exact root-cause site for
 * the "logout never clears the server session" half of the desync bug:
 * `handleLogout` previously called ONLY `signOut(auth)` (the Firebase
 * CLIENT SDK), never `DELETE /api/auth/session`, leaving the server
 * `__session` cookie valid for up to its full 5-day lifetime after the UI
 * showed "signed out."
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "TopNav.tsx"), "utf8");

describe("TopNav — logout source-level wiring guarantees", () => {
  it("imports and calls clearServerSession from the shared sessionSync module", () => {
    expect(source).toMatch(/import\s*\{\s*clearServerSession\s*\}\s*from\s*["']@\/lib\/client\/sessionSync["']/);
    expect(source).toMatch(/await clearServerSession\(\)/);
  });

  it("awaits clearServerSession — never fire-and-forget", () => {
    const handleLogoutMatch = source.match(/const handleLogout = async \(\) => \{[\s\S]*?\n  \};/);
    expect(handleLogoutMatch).not.toBeNull();
    const body = handleLogoutMatch![0];
    expect(body).toMatch(/await clearServerSession\(\)/);
    expect(body).toMatch(/await signOut\(auth\)/);
  });

  it("calls beginLogout() to disable protected mutation UI before any async work starts", () => {
    const handleLogoutMatch = source.match(/const handleLogout = async \(\) => \{([\s\S]*?)\n  \};/);
    expect(handleLogoutMatch).not.toBeNull();
    const body = handleLogoutMatch![1];
    const beginLogoutIndex = body.indexOf("beginLogout()");
    const clearServerSessionIndex = body.indexOf("clearServerSession()");
    expect(beginLogoutIndex).toBeGreaterThan(-1);
    expect(clearServerSessionIndex).toBeGreaterThan(-1);
    expect(beginLogoutIndex).toBeLessThan(clearServerSessionIndex);
  });

  it("does not present a clean signed-out redirect when the server session clear fails", () => {
    expect(source).toMatch(/if \(!cleared\)/);
    expect(source).toMatch(/sessionClearFailed/);
  });
});
