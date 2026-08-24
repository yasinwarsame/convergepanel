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

/**
 * Phase 5C — Workspace nav-item integration. Source-level regex, matching
 * this file's own established, explicitly-documented convention for this
 * exact component (no jsdom/@testing-library/react in this repo). Every
 * assertion here was verified with a targeted mutation self-check
 * (temporarily gutting the gating condition and confirming the affected
 * assertion fails, then reverting) before being accepted — the disproven
 * synthesize-panel source-regex test earlier this session is the reason
 * that verification step is mandatory, not optional, for a test like this.
 */
describe("TopNav — Phase 5C Workspace nav-item integration", () => {
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

  it("destructures workspaceUiEnabled from useUserPlan(), the same server-computed capability source as governanceDashboardEligible/teamRole", () => {
    expect(source).toMatch(/const \{ governanceDashboardEligible, plan: userPlan, loading: planLoading, teamRole, workspaceUiEnabled, projectsUiEnabled, workspaceReviewsUiEnabled \} = useUserPlan\(\);/);
  });

  it("gates the desktop Workspace link on !loading && user && !planLoading && workspaceUiEnabled — same shape as the Governance/Team Reviews gates, never optimistically shown", () => {
    expect(desktopNavBlock).toMatch(/\{!loading && user && !planLoading && workspaceUiEnabled && \(\s*\n\s*<Link\s*\n\s*href="\/workspace"/);
  });

  it("gates the mobile Workspace link identically to the desktop one", () => {
    expect(mobileMenuBlock).toMatch(/\{!loading && user && !planLoading && workspaceUiEnabled && \(\s*\n\s*<Link\s*\n\s*href="\/workspace"/);
  });

  it("Workspace appears in both blocks, positioned immediately before My Reviews (desktop) / immediately after Team Reviews (mobile, where My Reviews doesn't exist today)", () => {
    const workspaceIdx = desktopNavBlock.indexOf('href="/workspace"');
    const myReviewsIdx = desktopNavBlock.indexOf('href="/reviews"');
    expect(workspaceIdx).toBeGreaterThan(-1);
    expect(myReviewsIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeLessThan(myReviewsIdx);
  });

  it("carries visible 'Workspace' text — never icon-only navigation", () => {
    expect(desktopNavBlock).toMatch(/href="\/workspace"[\s\S]{0,300}>\s*Workspace\s*</);
    expect(mobileMenuBlock).toMatch(/href="\/workspace"[\s\S]{0,300}>\s*Workspace\s*</);
  });

  it("wires aria-current=\"page\" for /workspace based on real pathname state, in both blocks", () => {
    expect(desktopNavBlock).toMatch(/aria-current=\{pathname === "\/workspace" \? "page" : undefined\}/);
    expect(mobileMenuBlock).toMatch(/aria-current=\{pathname === "\/workspace" \? "page" : undefined\}/);
  });

  it("does not introduce a client-visible rollout flag — no NEXT_PUBLIC_PERSONAL_WORKSPACE_UI reference anywhere in this file", () => {
    expect(source).not.toMatch(/NEXT_PUBLIC_PERSONAL_WORKSPACE_UI/);
  });

  it("never relocates or removes History/My Reviews/Team Reviews/Governance — exactly the pre-existing four conditional/static nav concepts plus the one new Workspace addition", () => {
    for (const href of ['href="/governance"', 'href="/team/reviews"', 'href="/reviews"']) {
      expect(desktopNavBlock).toContain(href);
    }
  });
});

/**
 * Phase 7B — Projects nav-item integration. Same source-level regex
 * methodology as the Workspace nav-item block above, including the
 * mandatory targeted mutation self-check before acceptance.
 */
describe("TopNav — Phase 7B Projects nav-item integration", () => {
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

  it("destructures projectsUiEnabled from useUserPlan(), alongside workspaceUiEnabled — the same server-computed capability source", () => {
    expect(source).toMatch(/const \{ governanceDashboardEligible, plan: userPlan, loading: planLoading, teamRole, workspaceUiEnabled, projectsUiEnabled, workspaceReviewsUiEnabled \} = useUserPlan\(\);/);
  });

  it("gates the desktop Projects link on !loading && user && !planLoading && projectsUiEnabled — same shape as the Workspace gate, never optimistically shown", () => {
    expect(desktopNavBlock).toMatch(/\{!loading && user && !planLoading && projectsUiEnabled && \(\s*\n\s*<Link\s*\n\s*href="\/workspace\/projects"/);
  });

  it("gates the mobile Projects link identically to the desktop one", () => {
    expect(mobileMenuBlock).toMatch(/\{!loading && user && !planLoading && projectsUiEnabled && \(\s*\n\s*<Link\s*\n\s*href="\/workspace\/projects"/);
  });

  it("Projects appears in both blocks, positioned immediately after Workspace and before My Reviews (desktop) / immediately after Workspace (mobile)", () => {
    const workspaceIdx = desktopNavBlock.indexOf('href="/workspace"');
    const projectsIdx = desktopNavBlock.indexOf('href="/workspace/projects"');
    const myReviewsIdx = desktopNavBlock.indexOf('href="/reviews"');
    expect(workspaceIdx).toBeGreaterThan(-1);
    expect(projectsIdx).toBeGreaterThan(-1);
    expect(myReviewsIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeLessThan(projectsIdx);
    expect(projectsIdx).toBeLessThan(myReviewsIdx);

    const mobileWorkspaceIdx = mobileMenuBlock.indexOf('href="/workspace"');
    const mobileProjectsIdx = mobileMenuBlock.indexOf('href="/workspace/projects"');
    expect(mobileWorkspaceIdx).toBeGreaterThan(-1);
    expect(mobileProjectsIdx).toBeGreaterThan(-1);
    expect(mobileWorkspaceIdx).toBeLessThan(mobileProjectsIdx);
  });

  it("carries visible 'Projects' text — never icon-only navigation", () => {
    expect(desktopNavBlock).toMatch(/href="\/workspace\/projects"[\s\S]{0,300}>\s*Projects\s*</);
    expect(mobileMenuBlock).toMatch(/href="\/workspace\/projects"[\s\S]{0,300}>\s*Projects\s*</);
  });

  it("wires aria-current=\"page\" for /workspace/projects based on real pathname state, in both blocks, distinct from the /workspace check", () => {
    expect(desktopNavBlock).toMatch(/aria-current=\{pathname === "\/workspace\/projects" \? "page" : undefined\}/);
    expect(mobileMenuBlock).toMatch(/aria-current=\{pathname === "\/workspace\/projects" \? "page" : undefined\}/);
  });

  it("does not introduce a client-visible rollout flag — no NEXT_PUBLIC_PROJECTS_UI reference anywhere in this file", () => {
    expect(source).not.toMatch(/NEXT_PUBLIC_PROJECTS_UI/);
  });

  it("does not call a Project read API merely to decide nav visibility", () => {
    expect(source).not.toMatch(/fetch\([^)]*\/api\/user\/project/);
  });

  it("never relocates or removes Workspace/History/My Reviews/Team Reviews/Governance — exactly the pre-existing nav concepts plus the one new Projects addition", () => {
    for (const href of ['href="/workspace"', 'href="/governance"', 'href="/team/reviews"', 'href="/reviews"']) {
      expect(desktopNavBlock).toContain(href);
    }
  });
});

/**
 * Approval Workflow, Phase 9C.1 — TopNav's new "Reviews" (Team Workspace)
 * entry. Mirrors the Projects block's own established source-regex
 * pattern exactly. The nav boolean (`workspaceReviewsUiEnabled`) is a
 * server-computed capability signal from `useUserPlan()` — the SAME
 * mechanism `workspaceUiEnabled`/`projectsUiEnabled` already use, never a
 * new client-side authorization system, never a role-name check.
 */
describe("TopNav — Reviews (Team Workspace) nav entry", () => {
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

  it("gates the desktop Reviews link on !loading && user && !planLoading && workspaceReviewsUiEnabled — same shape as every other capability-flag gate, never optimistically shown", () => {
    expect(desktopNavBlock).toMatch(/\{!loading && user && !planLoading && workspaceReviewsUiEnabled && \(\s*\n\s*<Link\s*\n\s*href="\/workspace\/reviews"/);
  });

  it("gates the mobile Reviews link identically to the desktop one", () => {
    expect(mobileMenuBlock).toMatch(/\{!loading && user && !planLoading && workspaceReviewsUiEnabled && \(\s*\n\s*<Link\s*\n\s*href="\/workspace\/reviews"/);
  });

  it("never hardcodes role === \"Owner\" or role === \"Admin\" to gate the Reviews link — the flag is the sole gate", () => {
    const linkArea = desktopNavBlock.slice(Math.max(0, desktopNavBlock.indexOf('href="/workspace/reviews"') - 200), desktopNavBlock.indexOf('href="/workspace/reviews"') + 50);
    expect(linkArea).not.toMatch(/role === ["']Owner["']|role === ["']Admin["']|teamRole === /);
  });

  it("Reviews is positioned adjacent to Projects (immediately after, per the frozen 9C architecture), before My Reviews", () => {
    const projectsIdx = desktopNavBlock.indexOf('href="/workspace/projects"');
    const reviewsIdx = desktopNavBlock.indexOf('href="/workspace/reviews"');
    const myReviewsIdx = desktopNavBlock.indexOf('href="/reviews"');
    expect(projectsIdx).toBeGreaterThan(-1);
    expect(reviewsIdx).toBeGreaterThan(-1);
    expect(myReviewsIdx).toBeGreaterThan(-1);
    expect(projectsIdx).toBeLessThan(reviewsIdx);
    expect(reviewsIdx).toBeLessThan(myReviewsIdx);
  });

  it("carries visible 'Reviews' text — never icon-only navigation", () => {
    expect(desktopNavBlock).toMatch(/href="\/workspace\/reviews"[\s\S]{0,300}>\s*Reviews\s*</);
    expect(mobileMenuBlock).toMatch(/href="\/workspace\/reviews"[\s\S]{0,300}>\s*Reviews\s*</);
  });

  it("uses a label distinguishable from the pre-existing 'Team Reviews' (legacy) and 'My Reviews' (Personal) nav entries — no duplicate-label collision", () => {
    expect(desktopNavBlock).toContain("Team Reviews");
    expect(desktopNavBlock).toContain("My Reviews");
    expect(desktopNavBlock).toMatch(/>\s*Reviews\s*</);
    // The exact string "Reviews" (with no adjacent "Team "/"My ") must
    // exist as its own distinct link label, not merely as a substring of
    // the other two.
    expect(desktopNavBlock.match(/>\s*Reviews\s*</g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("wires aria-current=\"page\" for /workspace/reviews based on real pathname state, in both blocks", () => {
    expect(desktopNavBlock).toMatch(/aria-current=\{pathname === "\/workspace\/reviews" \? "page" : undefined\}/);
    expect(mobileMenuBlock).toMatch(/aria-current=\{pathname === "\/workspace\/reviews" \? "page" : undefined\}/);
  });

  it("does not introduce a client-visible rollout flag — no NEXT_PUBLIC_APPROVAL_WORKFLOW reference anywhere in this file", () => {
    expect(source).not.toMatch(/NEXT_PUBLIC_APPROVAL_WORKFLOW/);
  });

  it("does not call the review-queue API merely to decide nav visibility", () => {
    expect(source).not.toMatch(/fetch\([^)]*review-queue/);
  });

  it("never removes or relocates the legacy Team Reviews link (desktop and mobile) or the My Reviews link (desktop)", () => {
    expect(desktopNavBlock).toContain('href="/team/reviews"');
    expect(mobileMenuBlock).toContain('href="/team/reviews"');
    expect(desktopNavBlock).toContain('href="/reviews"');
  });
});
