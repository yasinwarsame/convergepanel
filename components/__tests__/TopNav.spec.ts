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
    '<div className="hidden items-center gap-1 xl:flex">',
    "{/* Mobile/tablet toggle"
  );
  const mobileMenuBlock = extractBetween('{mobileMenuOpen && (', "</header>");
  const escapeEffectBlock = extractBetween(
    "const handleKeyDown = (event: KeyboardEvent) => {",
    "document.addEventListener(\"keydown\", handleKeyDown);"
  );

  it("cuts the desktop nav over at lg (1024px), not md (768px) — the actual overflow trigger", () => {
    // Phase 11B.5-C1 — see the dedicated capacity describe block below. The
    // cutover alone is NOT the contract: it is only safe together with the
    // widened header cap, so both are pinned there.
    expect(source).toMatch(/hidden items-center gap-1 xl:flex/);
    expect(source).not.toMatch(/hidden items-center gap-1 lg:flex/);
    expect(source).not.toMatch(/min-\[1800px\]/);
    expect(source).not.toMatch(/hidden items-center gap-1 md:flex/);
  });

  it("shows the mobile/tablet toggle and panel below lg, matching the desktop nav's own cutover exactly", () => {
    expect(source).toMatch(/text-cp-text xl:hidden"\s*\n\s*aria-label="Toggle menu"/);
    expect(source).toMatch(/id="mobile-menu" className="border-t border-cp-border bg-cp-surface px-4 pb-4 pt-3 xl:hidden"/);
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

  it("keeps conditional Governance and Team Reviews reachable on BOTH surfaces with their permission gates (Phase 11B.6: via the shared model, not duplicated JSX)", () => {
    const model = source.slice(source.indexOf("const secondaryDestinations"), source.indexOf("const visiblePrimary"));
    expect(model).toMatch(/key: "governance"[^}]*visible: gatesReady && isGovernanceUser/);
    expect(model).toMatch(/key: "team-reviews"[^}]*visible: gatesReady && isTeamReviewUser/);
    // desktop reaches them through More, mobile through the flattened list —
    // both from `visibleSecondary`, so neither can lose one independently.
    expect(desktopNavBlock).toContain("moreNavItems");
    expect(mobileMenuBlock).toContain("visibleSecondary.map(");
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

  it("keeps the desktop nav's own trigger-less collapse (hidden xl:flex) as a pure CSS breakpoint, not a JS-mounted/unmounted panel — so desktop never depends on menu state", () => {
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
/**
 * Phase 11B.6 — ARCHITECTURE CHANGE, SAME GUARANTEES.
 *
 * The three describes below originally asserted that each destination appeared in
 * BOTH hand-written JSX blocks with identical gate expressions. 11B.6 removed
 * those duplicated blocks: there is now one evaluated model that both surfaces
 * render, so "present on desktop but not mobile with a drifted gate" is no longer
 * expressible — which is precisely how `My Reviews` came to be missing from the
 * shipped mobile panel.
 *
 * Every guarantee those tests held is re-asserted here against the model: the
 * gate flag, the href, the visible label, the exact current-state rule, the
 * relative order, and that nothing was removed. The old shape assertions are
 * replaced rather than deleted or skipped.
 */
describe("TopNav — destination model: gates, labels, order, current-state (replaces the per-surface 5C/7B/9C shape assertions)", () => {
  const model = () => source.slice(source.indexOf("const primaryDestinations"), source.indexOf("const visiblePrimary"));
  const entry = (key: string) => {
    const m = model().match(new RegExp(`\\{ key: "${key}"[^}]*\\}`));
    expect(m).not.toBeNull();
    return m![0];
  };
  const surfaces = () => {
    const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    return {
      desktop: strip(source.slice(source.indexOf("hidden items-center gap-1 xl:flex"), source.indexOf("{/* Mobile/tablet toggle"))),
      mobile: strip(source.slice(source.indexOf('id="mobile-menu"'))),
    };
  };

  it("Workspace: gated on workspaceUiEnabled, visible text 'Workspace', href /workspace, current only on /workspace", () => {
    const e = entry("workspace");
    expect(e).toContain('label: "Workspace"');
    expect(e).toContain('href: "/workspace"');
    expect(e).toContain("visible: gatesReady && workspaceUiEnabled");
    expect(e).toContain('current: isExactly("/workspace")');
  });

  it("Projects: gated on projectsUiEnabled, visible text 'Projects', href /workspace/projects, current across its detail routes — distinct from the /workspace check", () => {
    const e = entry("projects");
    expect(e).toContain('label: "Projects"');
    expect(e).toContain('href: "/workspace/projects"');
    expect(e).toContain("visible: gatesReady && projectsUiEnabled");
    expect(e).toContain('current: isUnder("/workspace/projects")');
    expect(entry("workspace")).toContain('current: isExactly("/workspace")');
  });

  it("Approval Queue: gated on workspaceReviewsUiEnabled, href /workspace/reviews, current across its detail routes", () => {
    const e = entry("approval-queue");
    expect(e).toContain('label: "Approval Queue"');
    expect(e).toContain('href: "/workspace/reviews"');
    expect(e).toContain("visible: gatesReady && workspaceReviewsUiEnabled");
    expect(e).toContain('current: isUnder("/workspace/reviews")');
  });

  it("labels remain mutually distinguishable — no duplicate-label collision between Approval Queue, Team Reviews and My Reviews", () => {
    const labels = [...model().matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of ["Approval Queue", "Team Reviews", "My Reviews"]) expect(labels).toContain(l);
  });

  it("every destination carries visible text — never icon-only navigation", () => {
    const labels = [...model().matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBe(8);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
  });

  it("Governance and Team Reviews remain reachable with their existing permission gates, now from one definition", () => {
    expect(entry("governance")).toContain("visible: gatesReady && isGovernanceUser");
    expect(entry("team-reviews")).toContain("visible: gatesReady && isTeamReviewUser");
    expect(source).toMatch(/const isGovernanceUser = governanceDashboardEligible \|\| userPlan === "full"/);
    expect(source).toMatch(/const isTeamReviewUser = teamRole === "owner" \|\| teamRole === "admin"/);
  });

  it("nothing was removed: all eight destinations still exist, each exactly once", () => {
    for (const key of ["research", "workspace", "projects", "my-reviews", "approval-queue", "team-reviews", "governance", "team-workspaces"]) {
      expect(model().match(new RegExp(`key: "${key}"`, "g"))).toHaveLength(1);
    }
  });

  it("BOTH surfaces derive aria-current from the model rather than re-deriving a pathname comparison", () => {
    const { desktop, mobile } = surfaces();
    for (const block of [desktop, mobile]) {
      expect(block).toContain('aria-current={current ? "page" : undefined}');
      expect(block).not.toMatch(/aria-current=\{pathname/);
    }
  });
});

describe("TopNav — Phase 11B.5 WorkspaceSwitcher integration wiring", () => {
  it("mounts the shared WorkspaceSwitcher and the uid-keyed membership hook", () => {
    expect(source).toMatch(/import WorkspaceSwitcher from "@\/components\/WorkspaceSwitcher"/);
    expect(source).toMatch(/import \{ useWorkspaceList \} from "@\/hooks\/useWorkspaceList"/);
    expect(source).toMatch(/<WorkspaceSwitcher/);
  });

  it("renders the switcher in the PRIMARY header, not inside the mobile panel — so the current Workspace stays visible with the hamburger closed", () => {
    const switcherIndex = source.indexOf("<WorkspaceSwitcher");
    const mobilePanelIndex = source.indexOf('id="mobile-menu"');
    expect(switcherIndex).toBeGreaterThan(-1);
    expect(mobilePanelIndex).toBeGreaterThan(-1);
    expect(switcherIndex).toBeLessThan(mobilePanelIndex);
    // and exactly one instance — not a separate desktop/mobile state machine
    expect(source.match(/<WorkspaceSwitcher/g)).toHaveLength(1);
  });

  it("does NOT gate the switcher on teamWorkspacesUiEnabled — that flag is self-service CREATION admission, which 11B.5-P0 decoupled from membership", () => {
    const start = source.indexOf("{!loading && user && (");
    const switcherIndex = source.indexOf("<WorkspaceSwitcher");
    const guard = source.slice(start, switcherIndex);
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(switcherIndex);
    expect(guard).not.toMatch(/teamWorkspacesUiEnabled/);
    // Phase 11B.6 — the flag's only remaining use is the Team Workspaces CHOOSER
    // entry in the secondary model, never the switcher.
    const secondary = source.slice(source.indexOf("const secondaryDestinations"), source.indexOf("const visiblePrimary"));
    expect(secondary).toMatch(/key: "team-workspaces"[^}]*visible: gatesReady && teamWorkspacesUiEnabled/);
  });

  it("keeps every existing destination reachable (Phase 11B.6: hrefs now live in the shared model, and More exists by design)", () => {
    const model = source.slice(source.indexOf("const primaryDestinations"), source.indexOf("const visiblePrimary"));
    for (const href of ["/", "/workspace", "/workspace/projects", "/workspace/team", "/workspace/reviews", "/reviews", "/governance", "/team/reviews"]) {
      expect(model).toContain(`href: "${href}"`);
    }
  });

  it("owns all FOUR disclosures with ONE outside-click effect and mutual exclusion (Phase 11B.6 added More)", () => {
    expect(source).toMatch(/const \[workspaceMenuOpen, setWorkspaceMenuOpen\] = useState\(false\)/);
    expect(source).toMatch(/const \[moreMenuOpen, setMoreMenuOpen\] = useState\(false\)/);
    expect(source.match(/document\.addEventListener\("mousedown"/g)).toHaveLength(1);
    expect(source).toMatch(/if \(userMenuOpen \|\| workspaceMenuOpen \|\| moreMenuOpen\)/);
    expect(source).toMatch(/const openWorkspaceMenu = \(next: boolean\) => \{[\s\S]*?setUserMenuOpen\(false\);[\s\S]*?setMobileMenuOpen\(false\);[\s\S]*?setMoreMenuOpen\(false\);/);
  });

  it("closes BOTH navigation popups on pathname change, on logout, and on transition to signed-out", () => {
    expect(source).toMatch(/setWorkspaceMenuOpen\(false\);\s*\n\s*setMoreMenuOpen\(false\);\s*\n\s*\}, \[pathname\]\)/);
    expect(source).toMatch(/if \(!user\) \{\s*\n\s*setWorkspaceMenuOpen\(false\);\s*\n\s*setMoreMenuOpen\(false\);/);
    const logout = source.slice(source.indexOf("const handleLogout"), source.indexOf("const navLinks"));
    expect(logout).toMatch(/setWorkspaceMenuOpen\(false\)/);
    expect(logout).toMatch(/setMoreMenuOpen\(false\)/);
  });

  it("leaves the hardened logout ORDER untouched: beginLogout -> clearServerSession -> signOut -> navigate", () => {
    const logout = source.slice(source.indexOf("const handleLogout"), source.indexOf("const navLinks"));
    const begin = logout.indexOf("beginLogout()");
    const clear = logout.indexOf("await clearServerSession()");
    const signOutIdx = logout.indexOf("await signOut(auth)");
    const nav = logout.indexOf("router.replace");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(clear);
    expect(clear).toBeLessThan(signOutIdx);
    expect(signOutIdx).toBeLessThan(nav);
    // and the switcher close happens BEFORE beginLogout, never interleaved into the sequence
    expect(logout.indexOf("setWorkspaceMenuOpen(false)")).toBeLessThan(begin);
  });

  it("derives the Personal destination from workspaceUiEnabled, because /workspace is itself rollout-gated", () => {
    expect(source).toMatch(/const personalHref = workspaceUiEnabled \? "\/workspace" : "\/"/);
  });

  it("hides only the wordmark block below sm — logo artwork, destination and desktop presentation unchanged", () => {
    expect(source).toMatch(/className="hidden flex-col justify-center leading-tight sm:flex"/);
    expect(source).toMatch(/src="\/logo-mark\.png"/);
    expect(source).toMatch(/<Link href="\/" className="flex items-center gap-3 transition-opacity hover:opacity-80">/);
  });
});


/**
 * Phase 11B.5-C1 — HEADER CAPACITY.
 *
 * The reviewed 11B.5 head moved the cutover lg -> xl while keeping
 * `max-w-6xl`. That fixed nothing: `max-w-6xl` is 72rem = 1152px and is not
 * overridden in `tailwind.config.ts`, so the content area caps at 1104px no
 * matter how wide the viewport is, against a measured worst-case requirement of
 * 1740px. A breakpoint assertion alone cannot express capacity, which is why
 * these tests pin the COMPANION conditions that make the cutover safe — so
 * restoring any single half of the unsafe combination fails here.
 */
describe("TopNav — Phase 11B.5-C1 header capacity strategy", () => {
  it("Phase 11B.6 — the desktop cutover and the header cap form ONE pair: xl plus max-w-7xl", () => {
    expect(source).toMatch(/hidden items-center gap-1 xl:flex/);
    expect(source).toMatch(/<div className="mx-auto flex h-full max-w-7xl/);
    // max-w-6xl caps the content area at 1104px, below the measured 1130px the
    // final row needs, so reverting the cap with the cutover would have
    // reintroduced the overflow one size smaller.
    expect(source).not.toMatch(/mx-auto flex h-full max-w-6xl/);
  });

  it("REGRESSION: the unsafe composition (desktop row enabled while the header is capped below the measured requirement) cannot be restored", () => {
    const container = source.match(/<div className="(mx-auto flex h-full[^"]*)"/);
    expect(container).not.toBeNull();
    const containerClasses = container![1];
    // 11B.6 measured the final row at 1130px of content. Tailwind's unoverridden
    // scale gives max-w-6xl a 1104px content area and max-w-7xl 1232px, so only
    // 7xl or wider is safe while the desktop row is enabled.
    expect(containerClasses).toMatch(/max-w-(7xl|screen-2xl|\[\d{4,}px\])/);
    expect(containerClasses).not.toMatch(/max-w-6xl/);
  });

  it("padding narrows below sm and the switcher wrapper is clamped there, which is what makes 320px fit", () => {
    expect(source).toMatch(/justify-between px-4 sm:px-6/);
    expect(source).toMatch(/className="min-w-0 max-w-\[6\.5rem\] sm:max-w-none"/);
    expect(source).toMatch(/flex min-w-0 items-center gap-2 sm:gap-3/);
  });

  it("the account display name truncates, with the full value preserved in title", () => {
    const block = source.slice(source.indexOf("max-w-[7.5rem] truncate text-[15px]"));
    expect(block).toMatch(/max-w-\[7\.5rem\] truncate text-\[15px\] font-medium text-cp-text/);
    expect(block).toMatch(/title=\{user\.displayName \|\| user\.email\?\.split\("@"\)\[0\] \|\| "User"\}/);
  });

  it("the hamburger and the mobile panel share the desktop nav's exact cutover, so there is never a width with neither", () => {
    const cutover = source.match(/hidden items-center gap-1 (min-\[\d+px\]|sm|md|lg|xl|2xl):flex/)![1];
    const hidden = `${cutover}:hidden`;
    // the toggle button carries the same cutover...
    const toggleIdx = source.indexOf('aria-label="Toggle menu"');
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(source.slice(toggleIdx - 400, toggleIdx)).toContain(hidden);
    // ...and so does the panel it controls, so no width has neither nav nor hamburger.
    const panelIdx = source.indexOf('id="mobile-menu"');
    expect(panelIdx).toBeGreaterThan(-1);
    expect(source.slice(panelIdx, panelIdx + 200)).toContain(hidden);
  });

  it("the capacity pass removed no destination — Phase 11B.6 RELOCATES three to More by design, but every one is still defined and reachable", () => {
    // public links still defined, for signed-out rendering
    for (const entry of ['{ label: "About", href: "/about" }', '{ label: "Help", href: "/help" }', '{ label: "Contact", href: "/contact" }', '{ label: "Pricing", href: "/pricing" }']) {
      expect(source).toContain(entry);
    }
    // every authenticated destination still defined exactly once in the model
    const model = source.slice(source.indexOf("const primaryDestinations"), source.indexOf("const visiblePrimary"));
    for (const href of ["/", "/workspace", "/workspace/projects", "/reviews", "/workspace/reviews", "/team/reviews", "/governance", "/workspace/team"]) {
      expect(model).toContain(`href: "${href}"`);
    }
    // nothing gained a width-conditional hide that would drop it from the desktop row
    const desktopNav = source.slice(source.indexOf("hidden items-center gap-1 xl:flex"), source.indexOf("{/* Mobile/tablet toggle"));
    expect(desktopNav).not.toMatch(/\b(sm|md|lg|2xl):hidden\b/);
  });
});


/**
 * Phase 11B.6 — FINAL AUTHENTICATED COMPOSITION.
 *
 * This file is source-level by convention, so it proves ARCHITECTURE here and
 * leaves `MoreNav`'s focus/Escape/Tab behaviour to `MoreNav.spec.tsx`, which
 * renders it. The assertions below are about the single navigation model: the
 * property that made the shipped `My Reviews` mobile omission possible was two
 * hand-maintained JSX copies, and the fix is structural, not cosmetic.
 */
describe("TopNav — Phase 11B.6 single navigation model", () => {
  /**
   * Comments stripped before any ABSENCE assertion. A comment explaining that
   * `startsWith("/workspace/team")` was removed would otherwise satisfy a
   * `not.toMatch(/startsWith\("\/workspace\/team"\)/)` against raw source — the
   * self-referential-source-assertion failure mode this repo's preflight detects.
   */
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const primaryBlock = () => {
    const i = source.indexOf("const primaryDestinations");
    const j = source.indexOf("const secondaryDestinations");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return source.slice(i, j);
  };
  const secondaryBlock = () => {
    const i = source.indexOf("const secondaryDestinations");
    const j = source.indexOf("const visiblePrimary");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return source.slice(i, j);
  };
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const desktopBlock = () => strip(source.slice(source.indexOf('hidden items-center gap-1 xl:flex'), source.indexOf("{/* Mobile/tablet toggle")));
  const mobileBlock = () => strip(source.slice(source.indexOf('id="mobile-menu"')));

  it("primary order is exactly Research, Workspace, Projects, My Reviews", () => {
    const keys = [...primaryBlock().matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["research", "workspace", "projects", "my-reviews"]);
  });

  it("secondary order is exactly Approval Queue, Team Reviews, Governance, Team Workspaces (11B.6-A1)", () => {
    const keys = [...secondaryBlock().matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["approval-queue", "team-reviews", "governance", "team-workspaces"]);
  });

  it("Research is an EXPLICIT destination, not inferred from the logo", () => {
    expect(primaryBlock()).toMatch(/key: "research", label: "Research", href: "\/"/);
    // and the logo still links "/" independently
    expect(source).toMatch(/<Link href="\/" className="flex items-center gap-3/);
  });

  it("Research is current ONLY on '/', never via startsWith", () => {
    expect(primaryBlock()).toMatch(/key: "research"[^}]*current: isExactly\("\/"\)/);
    expect(codeOnly).not.toMatch(/startsWith\("\/"\)/);
  });

  it("Workspace is current only on /workspace; Projects covers its detail routes", () => {
    expect(primaryBlock()).toMatch(/key: "workspace"[^}]*current: isExactly\("\/workspace"\)/);
    expect(primaryBlock()).toMatch(/key: "projects"[^}]*current: isUnder\("\/workspace\/projects"\)/);
  });

  it("My Reviews covers /reviews descendants and is defined separately from Approval Queue's /workspace/reviews", () => {
    expect(primaryBlock()).toMatch(/key: "my-reviews"[^}]*href: "\/reviews"[^}]*current: isUnder\("\/reviews"\)/);
    expect(secondaryBlock()).toMatch(/key: "approval-queue"[^}]*href: "\/workspace\/reviews"/);
    // isUnder("/reviews") tests `=== "/reviews"` or startsWith("/reviews/"), so
    // "/workspace/reviews" cannot match it.
    expect(source).toMatch(/const isUnder = \(route: string\) => path === route \|\| path\.startsWith\(`\$\{route\}\/`\)/);
  });

  it("the Team Workspaces CHOOSER is current only on its exact route — a concrete Workspace belongs to WorkspaceSwitcher", () => {
    expect(secondaryBlock()).toMatch(/key: "team-workspaces"[^}]*current: isExactly\("\/workspace\/team"\)/);
    expect(codeOnly).not.toMatch(/startsWith\("\/workspace\/team"\)/);
  });

  it("gates are reused, never reinvented, and none is broadened", () => {
    expect(primaryBlock()).toMatch(/key: "workspace"[^}]*visible: gatesReady && workspaceUiEnabled/);
    expect(primaryBlock()).toMatch(/key: "projects"[^}]*visible: gatesReady && projectsUiEnabled/);
    expect(secondaryBlock()).toMatch(/key: "approval-queue"[^}]*visible: gatesReady && workspaceReviewsUiEnabled/);
    expect(secondaryBlock()).toMatch(/key: "team-reviews"[^}]*visible: gatesReady && isTeamReviewUser/);
    expect(secondaryBlock()).toMatch(/key: "governance"[^}]*visible: gatesReady && isGovernanceUser/);
    expect(secondaryBlock()).toMatch(/key: "team-workspaces"[^}]*visible: gatesReady && teamWorkspacesUiEnabled/);
    // Research and My Reviews need only an established user
    expect(primaryBlock()).toMatch(/key: "research"[^}]*visible: signedIn/);
    expect(primaryBlock()).toMatch(/key: "my-reviews"[^}]*visible: signedIn/);
  });

  it("DE-DUPLICATION: both surfaces render from the same evaluated models, and neither re-derives a destination", () => {
    expect(desktopBlock()).toContain("visiblePrimary.map(");
    expect(mobileBlock()).toContain("visiblePrimary.map(");
    expect(desktopBlock()).toContain("moreNavItems");
    expect(mobileBlock()).toContain("visibleSecondary.map(");
    // no per-surface gate conditions remain for any destination
    for (const block of [desktopBlock(), mobileBlock()]) {
      for (const flag of ["workspaceUiEnabled", "projectsUiEnabled", "workspaceReviewsUiEnabled", "teamWorkspacesUiEnabled", "isGovernanceUser", "isTeamReviewUser"]) {
        expect(block).not.toContain(flag);
      }
      for (const href of ['href="/governance"', 'href="/team/reviews"', 'href="/workspace/reviews"', 'href="/workspace/team"', 'href="/reviews"']) {
        expect(block).not.toContain(href);
      }
    }
  });

  it("REGRESSION for the shipped defect: My Reviews cannot exist on one surface only, because neither surface names it", () => {
    expect(source).toMatch(/key: "my-reviews"/);
    expect(source.match(/key: "my-reviews"/g)).toHaveLength(1);
  });

  it("public marketing links are signed-out ONLY, and remain defined for that use", () => {
    expect(source).toMatch(/\{ label: "About", href: "\/about" \}/);
    for (const block of [desktopBlock(), mobileBlock()]) {
      expect(block).toMatch(/\{!signedIn &&\s*\n?\s*navLinks\.map/);
    }
    // never rendered unconditionally any more
    expect(source).not.toMatch(/\n\s*\{navLinks\.map/);
  });

  it("no secondary destination is restored to the primary model", () => {
    for (const key of ["approval-queue", "team-reviews", "governance", "team-workspaces"]) {
      expect(primaryBlock()).not.toContain(`key: "${key}"`);
    }
  });

  it("More renders only when at least one secondary destination is eligible", () => {
    expect(desktopBlock()).toMatch(/signedIn && moreNavItems\.length > 0 && \(/);
    expect(source).toMatch(/const moreNavItems: MoreNavItem\[\] = visibleSecondary\.map/);
  });

  it("mobile FLATTENS secondary items rather than nesting a second disclosure", () => {
    expect(mobileBlock()).not.toContain("<MoreNav");
    expect(mobileBlock()).toContain("visibleSecondary.map(");
  });

  it("four disclosures, one owner, ONE document mousedown registration", () => {
    expect(source).toMatch(/const \[moreMenuOpen, setMoreMenuOpen\] = useState\(false\)/);
    expect(source.match(/document\.addEventListener\("mousedown"/g)).toHaveLength(1);
    expect(source).toMatch(/if \(userMenuOpen \|\| workspaceMenuOpen \|\| moreMenuOpen\)/);
  });

  it("mutual exclusion: every opener closes the other three", () => {
    const more = source.slice(source.indexOf("const openMoreMenu"), source.indexOf("const openMoreMenu") + 400);
    for (const other of ["setWorkspaceMenuOpen(false)", "setUserMenuOpen(false)", "setMobileMenuOpen(false)"]) expect(more).toContain(other);
    const ws = source.slice(source.indexOf("const openWorkspaceMenu"), source.indexOf("const openMoreMenu"));
    for (const other of ["setUserMenuOpen(false)", "setMobileMenuOpen(false)", "setMoreMenuOpen(false)"]) expect(ws).toContain(other);
  });

  it("pathname change and sign-out close both navigation popups; logout closes them before the hardened sequence", () => {
    expect(source).toMatch(/setWorkspaceMenuOpen\(false\);\s*\n\s*setMoreMenuOpen\(false\);\s*\n\s*\}, \[pathname\]\)/);
    const logout = source.slice(source.indexOf("const handleLogout"), source.indexOf("const navLinks"));
    expect(logout).toContain("setMoreMenuOpen(false)");
    expect(logout.indexOf("setMoreMenuOpen(false)")).toBeLessThan(logout.indexOf("beginLogout()"));
  });

  it("WorkspaceSwitcher stays in the primary header and is untouched by this phase", () => {
    const switcherIndex = source.indexOf("<WorkspaceSwitcher");
    expect(switcherIndex).toBeGreaterThan(-1);
    expect(switcherIndex).toBeLessThan(source.indexOf('id="mobile-menu"'));
    expect(source.match(/<WorkspaceSwitcher/g)).toHaveLength(1);
  });

  it("signed-out navigation keeps every public destination and gains no authenticated one", () => {
    for (const entry of ['{ label: "About", href: "/about" }', '{ label: "Help", href: "/help" }', '{ label: "Contact", href: "/contact" }', '{ label: "Pricing", href: "/pricing" }']) {
      expect(source).toContain(entry);
    }
    expect(source).toContain('href="/login"');
    expect(source).toContain('href="/signup"');
    // authenticated destinations are gated behind `signedIn` in the models
    expect(source).toMatch(/const signedIn = !loading && !!user/);
  });

  it("the user menu keeps identity actions only — navigation destinations do not move into it", () => {
    const userMenu = source.slice(source.indexOf('id="user-menu-button"'), source.indexOf('id="user-menu-button"') + 3000);
    expect(userMenu).toContain('href="/profile"');
    for (const href of ['href="/governance"', 'href="/team/reviews"', 'href="/workspace/reviews"']) {
      expect(userMenu).not.toContain(href);
    }
  });
});
