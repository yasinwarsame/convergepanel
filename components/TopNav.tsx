"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "./AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { clearServerSession } from "@/lib/client/sessionSync";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { useWorkspaceList } from "@/hooks/useWorkspaceList";
import MoreNav, { type MoreNavItem } from "@/components/MoreNav";

export default function TopNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  /**
   * Phase 11B.5 — TopNav owns all three disclosure states so ONE component
   * arbitrates mutual exclusion, outside-click and Escape. WorkspaceSwitcher is
   * controlled via `open`/`onOpenChange` rather than adding a second
   * document-level listener that would race this one.
   */
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  /** Phase 11B.6 — the fourth disclosure. TopNav owns all four. */
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, isAdmin, beginLogout } = useAuth();
  const { governanceDashboardEligible, plan: userPlan, loading: planLoading, teamRole, workspaceUiEnabled, projectsUiEnabled, workspaceReviewsUiEnabled, teamWorkspacesUiEnabled } = useUserPlan();
  const isGovernanceUser = governanceDashboardEligible || userPlan === "full";
  /**
   * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — `teamRole` is
   * already reliable, existing role context from `useUserPlan()` (backed
   * by `users/{uid}.teamRole`), so this reuses it directly rather than
   * duplicating role-checking logic client-side.
   */
  const isTeamReviewUser = teamRole === "owner" || teamRole === "admin";
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceSwitcherRef = useRef<HTMLDivElement>(null);
  const workspaceSwitcherButtonRef = useRef<HTMLButtonElement>(null);
  const moreNavRef = useRef<HTMLDivElement>(null);
  const moreNavButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Membership discovery is keyed on uid inside the hook, NOT on pathname —
   * TopNav is mounted once by the root layout and persists across client
   * navigation, so switching routes must not refetch the Workspace list.
   *
   * Visibility is deliberately NOT gated on `teamWorkspacesUiEnabled`: that flag
   * is self-service CREATION admission. Phase 11B.5-P0 established that a
   * legitimate member can hold an active membership while not being admitted to
   * self-service, and such a member must still get a switcher.
   */
  const { items: workspaceItems, status: workspaceListStatus, retry: retryWorkspaceList } = useWorkspaceList();
  /**
   * `/workspace` is itself gated by `resolvePersonalWorkspaceUiMode()`, so
   * sending a non-admitted caller there would navigate them into a notFound().
   * `workspaceUiEnabled` is exactly that admission signal, already on hand.
   */
  const personalHref = workspaceUiEnabled ? "/workspace" : "/";

  const isLogin = pathname === "/login" || pathname === "/signin";
  const isSignup = pathname === "/signup";

  const logoutInProgressRef = useRef(false);

  /**
   * Phase 11B.5 — ONE outside-click effect for both desktop disclosures. Two
   * independent document `mousedown` listeners would race and could close the
   * disclosure the user just opened.
   */
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (userMenuOpen && userMenuRef.current && !userMenuRef.current.contains(target)) {
        setUserMenuOpen(false);
      }
      if (workspaceMenuOpen && workspaceSwitcherRef.current && !workspaceSwitcherRef.current.contains(target)) {
        setWorkspaceMenuOpen(false);
      }
      if (moreMenuOpen && moreNavRef.current && !moreNavRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    if (userMenuOpen || workspaceMenuOpen || moreMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [userMenuOpen, workspaceMenuOpen, moreMenuOpen]);

  /**
   * MUTUAL EXCLUSION — at most one disclosure open. Each opener closes the
   * others, so Escape and outside-click never have to arbitrate between two
   * simultaneously-open popups.
   */
  const openWorkspaceMenu = (next: boolean) => {
    setWorkspaceMenuOpen(next);
    if (next) {
      setUserMenuOpen(false);
      setMobileMenuOpen(false);
      setMoreMenuOpen(false);
    }
  };

  const openMoreMenu = (next: boolean) => {
    setMoreMenuOpen(next);
    if (next) {
      setWorkspaceMenuOpen(false);
      setUserMenuOpen(false);
      setMobileMenuOpen(false);
    }
  };

  /** A route change closes both navigation popups: they must not outlive their page. */
  useEffect(() => {
    setWorkspaceMenuOpen(false);
    setMoreMenuOpen(false);
  }, [pathname]);

  /** Logout, or any transition to signed-out, closes them too. */
  useEffect(() => {
    if (!user) {
      setWorkspaceMenuOpen(false);
      setMoreMenuOpen(false);
    }
  }, [user]);

  /**
   * Header overflow fix, tablet-width responsive pass — Escape closes
   * whichever disclosure (mobile nav panel or the desktop user dropdown) is
   * open and returns focus to its own trigger button, per WAI-ARIA
   * disclosure-pattern expectations. Outside-click close (above) doesn't
   * need this: the user's click already moved focus somewhere on the page.
   */
  useEffect(() => {
    if (!mobileMenuOpen && !userMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (mobileMenuOpen) {
        setMobileMenuOpen(false);
        mobileMenuButtonRef.current?.focus();
      }
      if (userMenuOpen) {
        setUserMenuOpen(false);
        userMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen, userMenuOpen]);

  useEffect(() => {
    if (!user) {
      logoutInProgressRef.current = false;
    }
  }, [user]);

  /**
   * Auth Lifecycle Hardening, Step 6.7 — this previously called ONLY
   * `signOut(auth)` (the Firebase CLIENT SDK), never clearing the server
   * `__session` cookie at all. Since every protected API route checks that
   * cookie before falling back to a request's bearer token
   * (`getRequestUid()`, `lib/teams/teamApiAuth.ts`), the cookie stayed
   * valid — for up to its full 5-day lifetime — even after the UI showed
   * "signed out," and would silently authorize a LATER sign-in on the same
   * browser as the wrong identity if that sign-in's own session-sync
   * happened to race (see `AuthProvider.tsx`'s module doc for the full
   * root-cause writeup). Required sequence now: disable protected UI
   * immediately (`beginLogout`) → await the server cookie's deletion →
   * sign the Firebase client out → navigate. If the server clear fails,
   * this does NOT present a signed-out state while the cookie may still
   * authorize requests — it stays on the current page with an error
   * instead of navigating to a page that would look safely logged out.
   */
  const handleLogout = async () => {
    if (logoutInProgressRef.current) return;
    logoutInProgressRef.current = true;
    setUserMenuOpen(false);
    setMobileMenuOpen(false);
    // Phase 11B.5/11B.6 — dismiss both navigation popups too. The hardened
    // sequence below (beginLogout -> clearServerSession -> signOut -> navigate)
    // is deliberately untouched; this only closes UI before it starts.
    setWorkspaceMenuOpen(false);
    setMoreMenuOpen(false);
    beginLogout();
    try {
      const cleared = await clearServerSession();
      await signOut(auth);
      if (!cleared) {
        // Fail safely: the Firebase client is signed out (so the UI won't
        // show stale protected content), but do NOT claim a clean
        // sign-out via the normal redirect — surface it as an error so
        // the user (or support) knows the server session may not have
        // been fully revoked, rather than silently trusting it.
        console.error("[TopNav] Server session could not be cleared during logout");
        router.replace("/login?signedOut=1&sessionClearFailed=1");
      } else {
        router.replace("/login?signedOut=1");
      }
      setTimeout(() => {
        logoutInProgressRef.current = false;
      }, 1000);
    } catch (error) {
      console.error("[TopNav] Error signing out:", error);
      logoutInProgressRef.current = false;
    }
  };

  /**
   * Public marketing links. Phase 11B.6 — these are for SIGNED-OUT rendering
   * only. Authenticated users no longer carry them as primary peers (they cost
   * ~291px the authenticated row cannot spare, and the global footer in
   * `app/layout.tsx` already lists About/Help/Pricing/Contact on every page, so
   * nothing becomes unreachable). Deliberately NOT reused in the signed-in model.
   */
  const navLinks = [
    { label: "About", href: "/about" },
    { label: "Help", href: "/help" },
    { label: "Contact", href: "/contact" },
    { label: "Pricing", href: "/pricing" },
  ];

  /* ------------------------------------------------------------------ *
   * Phase 11B.6 — ONE EVALUATED NAVIGATION MODEL.
   *
   * Desktop and mobile previously each hard-coded their own copy of every
   * destination's href, gate and current-state. They drifted: `My Reviews`
   * shipped on desktop and was simply missing from the mobile panel. Markup may
   * still differ per surface; destination DEFINITIONS may not.
   *
   * Current-state rules are exact, and each exists because the looser version is
   * wrong:
   *   - Research is `/` ONLY — never `startsWith("/")`, which is every route.
   *   - Workspace is `/workspace` ONLY — `/workspace/projects`, `/workspace/team`
   *     and `/workspace/reviews` belong to other destinations.
   *   - Projects covers its detail routes, which previously had no current state.
   *   - My Reviews covers `/reviews/**` and must NOT match `/workspace/reviews`,
   *     a different destination whose path merely ends the same way.
   *   - Team Workspaces is the CHOOSER, so it is the exact route only: a concrete
   *     `/workspace/team/{id}/**` is active Team context and belongs to
   *     WorkspaceSwitcher. The previous `startsWith("/workspace/team")` claimed
   *     all of them.
   * ------------------------------------------------------------------ */
  type NavDestination = { key: string; label: string; href: string; visible: boolean; current: boolean };

  const path = pathname ?? "";
  const isExactly = (route: string) => path === route;
  const isUnder = (route: string) => path === route || path.startsWith(`${route}/`);
  const signedIn = !loading && !!user;
  /** Rollout/capability-dependent items wait for plan state so nothing flashes. */
  const gatesReady = signedIn && !planLoading;

  const primaryDestinations: NavDestination[] = [
    { key: "research", label: "Research", href: "/", visible: signedIn, current: isExactly("/") },
    { key: "workspace", label: "Workspace", href: "/workspace", visible: gatesReady && workspaceUiEnabled, current: isExactly("/workspace") },
    { key: "projects", label: "Projects", href: "/workspace/projects", visible: gatesReady && projectsUiEnabled, current: isUnder("/workspace/projects") },
    { key: "my-reviews", label: "My Reviews", href: "/reviews", visible: signedIn, current: isUnder("/reviews") },
  ];

  const secondaryDestinations: NavDestination[] = [
    { key: "approval-queue", label: "Approval Queue", href: "/workspace/reviews", visible: gatesReady && workspaceReviewsUiEnabled, current: isUnder("/workspace/reviews") },
    { key: "team-reviews", label: "Team Reviews", href: "/team/reviews", visible: gatesReady && isTeamReviewUser, current: isUnder("/team/reviews") },
    { key: "governance", label: "Governance", href: "/governance", visible: gatesReady && isGovernanceUser, current: isExactly("/governance") },
    // Phase 11B.6-A1 (approved amendment) — the Team Workspaces CHOOSER keeps its
    // only application entry point, behind the SAME `teamWorkspacesUiEnabled`
    // self-service admission it has always used. A P6 member (active membership,
    // no self-service admission) must not be offered a page concealed from them;
    // their WorkspaceSwitcher entries stay independent of this flag.
    { key: "team-workspaces", label: "Team Workspaces", href: "/workspace/team", visible: gatesReady && teamWorkspacesUiEnabled, current: isExactly("/workspace/team") },
  ];

  const visiblePrimary = primaryDestinations.filter((d) => d.visible);
  const visibleSecondary = secondaryDestinations.filter((d) => d.visible);
  const moreNavItems: MoreNavItem[] = visibleSecondary.map(({ key, label, href, current }) => ({ key, label, href, current }));

  return (
    <header className="sticky top-0 z-50 h-[74px] border-b border-cp-border bg-cp-surface/95 backdrop-blur-sm">
      {/*
        Phase 11B.6 — MEASURED capacity pair: cutover `xl` (1280px) and header cap
        `max-w-7xl` (80rem = 1280px). Both halves are load-bearing and neither works
        alone.

        The 11B.5 row needed 1687px of content because it carried eleven
        destinations, which is why the cutover sat at a temporary 1800px. The frozen
        11B.6 composition — four primary destinations plus one `More` trigger, the
        marketing links gone from the authenticated bar — needs 1123px.

        `max-w-6xl` is 72rem = 1152px, so its content area is 1104px: still BELOW
        the new requirement, at any viewport. Reverting the cap along with the
        cutover would therefore have reintroduced the overflow one size smaller,
        so the cap moves to `max-w-7xl` (content area 1232px) and the pair is
        pinned together in the spec. */}
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">

        {/* Logo + Workspace context. Grouped so the outer row keeps exactly the
            three children it had before (left group / desktop nav / hamburger)
            and `justify-between` distributes them unchanged.

            Phase 11B.5 — the switcher sits HERE, in the primary header, not
            inside `#mobile-menu`: the current Workspace must be visible on
            mobile with the hamburger closed. One shared instance serves both
            breakpoints, so there is no second state machine to drift. */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
            <span className="relative flex h-14 w-14 shrink-0 items-center justify-center">
              <Image src="/logo-mark.png" alt="ConvergePanel logo" width={56} height={56} className="h-14 w-14" priority />
            </span>
            {/* Below `sm` the wordmark/tagline block is hidden so the mark, the
                context switcher and the hamburger fit at 320px. The artwork, the
                link destination and the desktop presentation are unchanged. */}
            <span className="hidden flex-col justify-center leading-tight sm:flex">
              <span className="text-2xl font-normal tracking-tight">
                <span className="text-cp-text">Converge</span>
                <span className="text-cp-orange">Panel</span>
              </span>
              <span className="text-[11px] font-medium tracking-wider text-cp-muted">
                RESEARCH • VERIFY • GOVERN
              </span>
            </span>
          </Link>

          {/* The switcher is clamped HERE rather than inside WorkspaceSwitcher so
              that approved component stays byte-identical; its label already
              truncates, so a narrower wrapper simply shortens it below sm. */}
          {!loading && user && (
            <div ref={workspaceSwitcherRef} className="min-w-0 max-w-[6.5rem] sm:max-w-none">
              <WorkspaceSwitcher
                pathname={pathname}
                items={workspaceItems}
                status={workspaceListStatus}
                personalHref={personalHref}
                open={workspaceMenuOpen}
                onOpenChange={openWorkspaceMenu}
                onRetry={retryWorkspaceList}
                triggerRef={workspaceSwitcherButtonRef}
              />
            </div>
          )}
        </div>

        {/* Desktop nav — `xl` (1280px), recovered from 11B.5's temporary 1800px
            now that de-duplication has freed the width. Measured below. */}
        <div className="hidden items-center gap-1 xl:flex">
          {/* Signed-out: the public marketing links. Signed-in users get the
              frozen four primary destinations instead; the footer keeps these
              reachable on every page. */}
          {!signedIn &&
            navLinks.map(({ label, href }) => (
              <Link
                key={href}
                href={href}
                className="rounded-md px-3 py-1.5 text-[15px] font-medium text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text"
              >
                {label}
              </Link>
            ))}

          {/* Signed-in primary — rendered from the SAME evaluated model the
              mobile panel uses, so a destination cannot exist on one surface
              and not the other. */}
          {visiblePrimary.map(({ key, label, href, current }) => (
            <Link
              key={key}
              href={href}
              aria-current={current ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-[15px] font-medium transition-colors hover:bg-cp-raised hover:text-cp-text ${
                current ? "text-cp-text" : "text-cp-muted"
              }`}
            >
              {label}
            </Link>
          ))}

          {/* Secondary destinations live behind one disclosure. The trigger is
              absent entirely when the caller is eligible for none of them. */}
          {signedIn && moreNavItems.length > 0 && (
            <div ref={moreNavRef}>
              <MoreNav
                items={moreNavItems}
                open={moreMenuOpen}
                onOpenChange={openMoreMenu}
                triggerRef={moreNavButtonRef}
              />
            </div>
          )}

          {!loading && (
            <div className="ml-3 flex items-center gap-3">
              {!user ? (
                <>
                  <Link
                    href="/login"
                    className={`rounded-md px-3 py-1.5 text-[15px] font-medium transition-colors ${
                      isLogin
                        ? "text-cp-accent"
                        : "text-cp-muted hover:text-cp-text"
                    }`}
                  >
                    Login
                  </Link>
                  <Link
                    href="/signup"
                    className={`rounded-[11px] px-4 py-1.5 text-sm font-semibold transition-colors ${
                      isSignup
                        ? "bg-cp-primary text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)]"
                        : "bg-cp-primary text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] hover:bg-cp-accent"
                    }`}
                  >
                    Sign up
                  </Link>
                </>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="h-5 w-px bg-cp-border" aria-hidden />
                  <div className="relative" ref={userMenuRef}>
                  <button
                    id="user-menu-button"
                    ref={userMenuButtonRef}
                    onClick={() => {
                      const next = !userMenuOpen;
                      setUserMenuOpen(next);
                      // Mutual exclusion — opening the user menu closes the Workspace switcher.
                      if (next) {
                        setWorkspaceMenuOpen(false);
                        setMoreMenuOpen(false);
                      }
                    }}
                    aria-expanded={userMenuOpen}
                    aria-haspopup="true"
                    aria-controls="user-menu"
                    className="flex items-center gap-2 rounded-full px-2 py-1.5 transition-colors hover:bg-cp-raised"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-cp-orange bg-cp-orange-soft">
                      <span className="font-mono text-xs font-semibold text-cp-orange">
                        {(user.displayName || user.email?.[0] || "U").toUpperCase()}
                      </span>
                    </div>
                    {/* Truncated for header capacity; the full value stays in
                        `title` so it remains available to the user and to AT. */}
                    <span
                      className="max-w-[7.5rem] truncate text-[15px] font-medium text-cp-text"
                      title={user.displayName || user.email?.split("@")[0] || "User"}
                    >
                      {user.displayName || user.email?.split("@")[0] || "User"}
                    </span>
                    <svg
                      className={`h-3.5 w-3.5 text-cp-muted transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {userMenuOpen && (
                    // Deliberately no role="menu": these are plain links/a
                    // logout action, not an application menu widget, and
                    // role="menu" per WAI-ARIA APG implies arrow-key/Home/
                    // End keyboard navigation this component doesn't
                    // implement — aria-expanded/aria-controls on the
                    // trigger is the correct disclosure-pattern contract.
                    <div
                      id="user-menu"
                      className="absolute right-0 mt-2 w-48 overflow-hidden rounded-lg border border-cp-border bg-cp-surface shadow-[0_8px_32px_rgba(0,0,0,0.12)] py-1"
                    >
                      <Link
                        href="/profile"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-4 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised"
                      >
                        Profile
                      </Link>
                      {!loading && isAdmin && (
                        <Link
                          href="/admin"
                          onClick={() => setUserMenuOpen(false)}
                          className="block px-4 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised"
                        >
                          Admin
                        </Link>
                      )}
                      <div className="my-1 border-t border-cp-border" />
                      <button
                        onClick={() => {
                          setUserMenuOpen(false);
                          handleLogout();
                        }}
                        className="block w-full px-4 py-2 text-left text-sm text-cp-text transition-colors hover:bg-cp-raised"
                      >
                        Logout
                      </button>
                    </div>
                  )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mobile/tablet toggle — shown below the desktop cutover, matching the desktop nav's own xl:flex above */}
        <button
          ref={mobileMenuButtonRef}
          onClick={() => {
            const next = !mobileMenuOpen;
            setMobileMenuOpen(next);
            // Mutual exclusion: opening the panel closes the other disclosures.
            if (next) {
              setWorkspaceMenuOpen(false);
              setUserMenuOpen(false);
              setMoreMenuOpen(false);
            }
          }}
          className="rounded-md p-2 text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text xl:hidden"
          aria-label="Toggle menu"
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-menu"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            {mobileMenuOpen ? (
              <path d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile/tablet menu — below the desktop cutover, mirrors the desktop nav's own xl:flex */}
      {mobileMenuOpen && (
        <div id="mobile-menu" className="border-t border-cp-border bg-cp-surface px-4 pb-4 pt-3 xl:hidden">
          <div className="flex flex-col gap-1">
            {/* Signed-out: public marketing links, unchanged. */}
            {!signedIn &&
              navLinks.map(({ label, href }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
                >
                  {label}
                </Link>
              ))}

            {/* Signed-in primary — the SAME evaluated model the desktop row
                renders. This is what permanently fixes the shipped defect where
                `My Reviews` existed on desktop and was absent here. */}
            {visiblePrimary.map(({ key, label, href, current }) => (
              <Link
                key={key}
                href={href}
                aria-current={current ? "page" : undefined}
                onClick={() => setMobileMenuOpen(false)}
                className={`rounded-md px-3 py-2 text-sm transition-colors hover:bg-cp-raised hover:text-cp-text ${
                  current ? "font-semibold text-cp-text" : "text-cp-text"
                }`}
              >
                {label}
              </Link>
            ))}

            {/* Secondary destinations are FLATTENED here rather than nested
                behind a second disclosure: a disclosure inside an already-open
                panel costs an extra interaction for no gain. Same evaluated
                list as desktop `More`, so eligibility cannot diverge. */}
            {visibleSecondary.length > 0 && <div className="my-2 border-t border-cp-border-soft" />}
            {visibleSecondary.map(({ key, label, href, current }) => (
              <Link
                key={key}
                href={href}
                aria-current={current ? "page" : undefined}
                onClick={() => setMobileMenuOpen(false)}
                className={`rounded-md px-3 py-2 text-sm transition-colors hover:bg-cp-raised hover:text-cp-text ${
                  current ? "font-semibold text-cp-text" : "text-cp-text"
                }`}
              >
                {label}
              </Link>
            ))}

            <div className="my-2 border-t border-cp-border" />
            {!loading && (
              !user ? (
                <>
                  <Link
                    href="/login"
                    onClick={() => setMobileMenuOpen(false)}
                    className={`rounded-md px-3 py-2 text-sm transition-colors ${
                      isLogin ? "text-cp-accent" : "text-cp-text hover:bg-cp-raised hover:text-cp-text"
                    }`}
                  >
                    Login
                  </Link>
                  <Link
                    href="/signup"
                    onClick={() => setMobileMenuOpen(false)}
                    className="mt-1 rounded-[11px] bg-cp-primary px-3 py-2 text-center text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition-colors hover:bg-cp-accent"
                  >
                    Sign up free
                  </Link>
                </>
              ) : (
                <>
                  <Link
                    href="/profile"
                    onClick={() => setMobileMenuOpen(false)}
                    className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
                  >
                    Profile
                  </Link>
                  {!loading && isAdmin && (
                    <Link
                      href="/admin"
                      onClick={() => setMobileMenuOpen(false)}
                      className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
                    >
                      Admin
                    </Link>
                  )}
                  <button
                    onClick={() => {
                      setMobileMenuOpen(false);
                      handleLogout();
                    }}
                    className="rounded-md px-3 py-2 text-left text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
                  >
                    Logout
                  </button>
                </>
              )
            )}
          </div>
        </div>
      )}
    </header>
  );
}
