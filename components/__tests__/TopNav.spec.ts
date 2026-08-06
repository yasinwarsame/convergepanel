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

/**
 * Header overflow fix (tablet widths) — source-level regression tests,
 * matching this file's existing convention (`readFileSync` + regex against
 * the real component source) rather than a jsdom render: TopNav depends on
 * `useAuth()`/`useUserPlan()`/Firebase client auth with no test-double
 * seams, and this repo deliberately has no jsdom/@testing-library/react
 * (see app/api/synthesize-panel/__tests__/clientAdaptiveGuardRegression.spec.ts's
 * own doc comment) — so structural regex assertions against the source are
 * the established pattern for this exact component, not a shortcut.
 *
 * Root cause being guarded against: the desktop nav switched from hidden
 * to a full flex row at the `md` (768px) breakpoint, where the logo +
 * every nav link + auth controls didn't fit on one line, forcing
 * page-level horizontal overflow (confirmed live: document.body.scrollWidth
 * ~807px vs window.innerWidth 768px). Fix moves the cutover to `lg`
 * (1024px) since the mobile/tablet menu already has full parity.
 */
describe("TopNav — tablet-width header overflow fix", () => {
  function extractBetween(startMarker: string, endMarker: string): string {
    const startIndex = source.indexOf(startMarker);
    expect(startIndex).toBeGreaterThan(-1);
    const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
  }

  const desktopNavBlock = extractBetween(
    '<div className="hidden items-center gap-1 lg:flex">',
    "{/* Mobile/tablet toggle"
  );
  const mobileMenuBlock = extractBetween('{mobileMenuOpen && (', "</header>");
  const escapeEffectBlock = extractBetween(
    "const handleKeyDown = (event: KeyboardEvent) => {",
    "document.addEventListener(\"keydown\", handleKeyDown);"
  );

  it("cuts the desktop nav over at lg (1024px), not md (768px) — the actual overflow trigger", () => {
    expect(source).toMatch(/hidden items-center gap-1 lg:flex/);
    expect(source).not.toMatch(/hidden items-center gap-1 md:flex/);
  });

  it("shows the mobile/tablet toggle and panel below lg, matching the desktop nav's own cutover exactly", () => {
    expect(source).toMatch(/text-cp-text lg:hidden"\s*\n\s*aria-label="Toggle menu"/);
    expect(source).toMatch(/id="mobile-menu" className="border-t border-cp-border bg-cp-surface px-4 pb-4 pt-3 lg:hidden"/);
  });

  it("never reintroduces an md: breakpoint anywhere in the header (guards against regressing the fix)", () => {
    expect(source).not.toMatch(/\bmd:/);
  });

  it("keeps the full nav link set — About/Help/Contact/Pricing — reachable from both the desktop nav and the mobile/tablet menu", () => {
    // Both blocks render from the one shared navLinks array (labels are interpolated via {label},
    // not inlined per-block), so proving the array itself and both .map() call sites is the real guarantee —
    // a literal-text search here would just fail to find dynamically-rendered {label} text.
    const navLinksMatch = source.match(/const navLinks = \[([\s\S]*?)\];/);
    expect(navLinksMatch).not.toBeNull();
    const navLinksArraySource = navLinksMatch![1];
    for (const label of ["About", "Help", "Contact", "Pricing"]) {
      expect(navLinksArraySource).toContain(`"${label}"`);
    }
    expect(desktopNavBlock).toMatch(/navLinks\.map/);
    expect(mobileMenuBlock).toMatch(/navLinks\.map/);
  });

  it("keeps conditional Governance and Team Reviews links reachable from both the desktop nav and the mobile/tablet menu, still permission-gated identically", () => {
    for (const block of [desktopNavBlock, mobileMenuBlock]) {
      expect(block).toMatch(/isGovernanceUser[\s\S]{0,200}href="\/governance"/);
      expect(block).toMatch(/isTeamReviewUser[\s\S]{0,200}href="\/team\/reviews"/);
    }
  });

  it("keeps signed-out actions (Login, Sign up) reachable from both the desktop nav and the mobile/tablet menu, with active-link styling preserved", () => {
    for (const block of [desktopNavBlock, mobileMenuBlock]) {
      expect(block).toMatch(/!user \?/);
      expect(block).toMatch(/href="\/login"/);
      expect(block).toMatch(/href="\/signup"/);
      expect(block).toMatch(/isLogin/);
    }
  });

  it("keeps signed-in account actions (Profile, conditional Admin, Logout) reachable from both the desktop dropdown and the mobile/tablet menu, admin gating unchanged", () => {
    for (const block of [desktopNavBlock, mobileMenuBlock]) {
      expect(block).toMatch(/href="\/profile"/);
      expect(block).toMatch(/isAdmin[\s\S]{0,600}href="\/admin"/);
      expect(block).toMatch(/handleLogout\(\)/);
    }
  });

  it("never moves admin gating off the existing isAdmin claim check — no new role/authorization logic introduced", () => {
    const gateOccurrences = source.match(/isAdmin &&/g) || [];
    // Exactly the two pre-existing gate sites (desktop dropdown + mobile menu) — this fix must not add a third, different gating mechanism.
    expect(gateOccurrences.length).toBe(2);
    // isAdmin itself still comes from useAuth()'s claim, not a new prop/source.
    expect(source).toMatch(/const \{ user, loading, isAdmin, beginLogout \} = useAuth\(\);/);
  });

  it("gives the mobile/tablet toggle button proper disclosure ARIA wired to real state, not a static string", () => {
    expect(source).toMatch(/aria-expanded=\{mobileMenuOpen\}/);
    expect(source).toMatch(/aria-controls="mobile-menu"/);
  });

  it("gives the desktop user-menu trigger proper disclosure ARIA wired to real state, matching the panel's id", () => {
    expect(source).toMatch(/aria-expanded=\{userMenuOpen\}/);
    expect(source).toMatch(/aria-haspopup="true"/);
    expect(source).toMatch(/aria-controls="user-menu"/);
    expect(source).toMatch(/id="user-menu"/);
  });

  it("closes the mobile menu on Escape and returns focus to its own trigger button", () => {
    expect(escapeEffectBlock).toMatch(/if \(mobileMenuOpen\) \{[\s\S]*?setMobileMenuOpen\(false\)[\s\S]*?mobileMenuButtonRef\.current\?\.focus\(\)/);
  });

  it("closes the user dropdown on Escape and returns focus to its own trigger button, independent of the mobile menu's handling", () => {
    expect(escapeEffectBlock).toMatch(/if \(userMenuOpen\) \{[\s\S]*?setUserMenuOpen\(false\)[\s\S]*?userMenuButtonRef\.current\?\.focus\(\)/);
  });

  it("only listens for Escape while a menu is actually open — not a permanent global listener", () => {
    const effectStart = source.indexOf("useEffect(() => {\n    if (!mobileMenuOpen && !userMenuOpen) return;");
    expect(effectStart).toBeGreaterThan(-1);
    const depsMatch = source.slice(effectStart, effectStart + 700).match(/\}, \[mobileMenuOpen, userMenuOpen\]\);/);
    expect(depsMatch).not.toBeNull();
  });

  it("mounts the mobile/tablet menu conditionally (removed from the DOM when closed), not merely CSS-clipped while still present", () => {
    // The whole panel is gated behind `{mobileMenuOpen && (...)}` — closed means unmounted, not just visually hidden/overflow-clipped.
    expect(source).toMatch(/\{mobileMenuOpen && \(\s*\n\s*<div id="mobile-menu"/);
  });

  it("keeps the desktop nav's own trigger-less collapse (hidden lg:flex) as a pure CSS breakpoint, not a JS-mounted/unmounted panel — so desktop never depends on menu state", () => {
    expect(desktopNavBlock).not.toMatch(/mobileMenuOpen/);
  });
});
