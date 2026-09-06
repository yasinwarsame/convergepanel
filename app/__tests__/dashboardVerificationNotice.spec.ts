/**
 * Phase P0.2-VEMAIL-C2 — the recovery must be on the page the user LANDS on.
 *
 * The review established the real journey and found the notice was mounted only
 * on /profile, behind the avatar menu:
 *
 *     /signup  --(page.tsx redirect)-->  /onboarding  --(redirect)-->  /
 *
 * so a user whose verification email failed could complete signup, use the
 * product, and never be told. These bind that journey to the component.
 *
 * `app/page.tsx` is a ~2600-line client dashboard whose render depends on many
 * providers, so this asserts the mount and the journey rather than rendering
 * the whole route; the component's own behaviour is covered exhaustively in
 * components/__tests__/EmailVerificationNotice.spec.tsx.
 */

import { readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..");
const dashboard = readFileSync(join(root, "app", "page.tsx"), "utf8");
const signup = readFileSync(join(root, "app", "signup", "page.tsx"), "utf8");
const onboarding = readFileSync(join(root, "app", "onboarding", "page.tsx"), "utf8");

describe("the post-signup landing page carries the verification recovery", () => {
  it("THE FIX: the dashboard imports and renders EmailVerificationNotice", () => {
    expect(dashboard).toMatch(
      /import\s+EmailVerificationNotice\s+from\s+["']@\/components\/EmailVerificationNotice["']/
    );
    expect(dashboard).toMatch(/<EmailVerificationNotice\s*\/>/);
  });

  it("it is rendered inside the main authenticated view, not behind a menu", () => {
    const mountIdx = dashboard.indexOf("<EmailVerificationNotice />");
    const mainIdx = dashboard.indexOf('<main className="max-w-6xl');
    expect(mainIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeGreaterThan(mainIdx);
    // Not nested inside a dropdown/menu container.
    const before = dashboard.slice(mainIdx, mountIdx);
    expect(before).not.toMatch(/dropdown|menuOpen|<nav/i);
  });

  it("JOURNEY: signup sends the user to onboarding", () => {
    expect(signup).toMatch(/onboardingUrl/);
    expect(signup).toMatch(/["']\/onboarding["']/);
  });

  it("JOURNEY: onboarding sends the user to the dashboard root by default", () => {
    expect(onboarding).toMatch(/safeRedirect\(\s*searchParams\.get\(["']redirect["']\)\s*,\s*["']\/["']\s*\)/);
  });

  it("REGRESSION: the notice is not ONLY on /profile any more", () => {
    const profile = readFileSync(join(root, "app", "profile", "page.tsx"), "utf8");
    expect(profile).toMatch(/<EmailVerificationNotice\s*\/>/); // retained
    expect(dashboard).toMatch(/<EmailVerificationNotice\s*\/>/); // and now here
  });
});
