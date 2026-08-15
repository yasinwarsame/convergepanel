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

export default function TopNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, isAdmin, beginLogout } = useAuth();
  const { governanceDashboardEligible, plan: userPlan, loading: planLoading, teamRole, workspaceUiEnabled } = useUserPlan();
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

  const isLogin = pathname === "/login" || pathname === "/signin";
  const isSignup = pathname === "/signup";

  const logoutInProgressRef = useRef(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    if (userMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [userMenuOpen]);

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

  const navLinks = [
    { label: "About", href: "/about" },
    { label: "Help", href: "/help" },
    { label: "Contact", href: "/contact" },
    { label: "Pricing", href: "/pricing" },
  ];

  return (
    <header className="sticky top-0 z-50 h-[74px] border-b border-cp-border bg-cp-surface/95 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
          <span className="relative flex h-14 w-14 shrink-0 items-center justify-center">
            <Image src="/logo-mark.png" alt="ConvergePanel logo" width={56} height={56} className="h-14 w-14" priority />
          </span>
          <span className="flex flex-col justify-center leading-tight">
            <span className="text-2xl font-normal tracking-tight">
              <span className="text-cp-text">Converge</span>
              <span className="text-cp-orange">Panel</span>
            </span>
            <span className="text-[11px] font-medium tracking-wider text-cp-muted">
              RESEARCH • VERIFY • GOVERN
            </span>
          </span>
        </Link>

        {/* Desktop nav — lg (1024px), not md (768px): at 768px the logo
            (56px mark + wordmark + tagline) plus every nav link, the
            Governance/Team Reviews conditionals, and the auth controls
            don't fit on one row and force page-level horizontal overflow.
            The mobile menu below is already complete (same links + auth
            actions), so moving the cutover to lg is the smallest fix —
            no links hidden, no text shrunk, no overflow-hidden hacks. */}
        <div className="hidden items-center gap-1 lg:flex">
          {navLinks.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className="rounded-md px-3 py-1.5 text-[15px] font-medium text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text"
            >
              {label}
            </Link>
          ))}

          {!loading && user && !planLoading && isGovernanceUser && (
            <Link
              href="/governance"
              className="rounded-md px-3 py-1.5 text-[15px] font-medium text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text"
            >
              Governance
            </Link>
          )}

          {!loading && user && !planLoading && isTeamReviewUser && (
            <Link
              href="/team/reviews"
              className="rounded-md px-3 py-1.5 text-[15px] font-medium text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text"
            >
              Team Reviews
            </Link>
          )}

          {!loading && user && !planLoading && workspaceUiEnabled && (
            <Link
              href="/workspace"
              aria-current={pathname === "/workspace" ? "page" : undefined}
              className="rounded-md px-3 py-1.5 text-[15px] font-medium text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text"
            >
              Workspace
            </Link>
          )}

          {!loading && user && (
            <Link
              href="/reviews"
              className="rounded-md px-3 py-1.5 text-[15px] font-medium text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text"
            >
              My Reviews
            </Link>
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
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
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
                    <span className="text-[15px] font-medium text-cp-text">
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

        {/* Mobile/tablet toggle — shown below lg, matching the desktop nav's own lg:flex cutover above */}
        <button
          ref={mobileMenuButtonRef}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="rounded-md p-2 text-cp-muted transition-colors hover:bg-cp-raised hover:text-cp-text lg:hidden"
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

      {/* Mobile/tablet menu — below lg, mirrors the desktop nav's own lg:flex cutover */}
      {mobileMenuOpen && (
        <div id="mobile-menu" className="border-t border-cp-border bg-cp-surface px-4 pb-4 pt-3 lg:hidden">
          <div className="flex flex-col gap-1">
            {navLinks.map(({ label, href }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
              >
                {label}
              </Link>
            ))}
            {!loading && user && !planLoading && isGovernanceUser && (
              <Link
                href="/governance"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
              >
                Governance
              </Link>
            )}
            {!loading && user && !planLoading && isTeamReviewUser && (
              <Link
                href="/team/reviews"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
              >
                Team Reviews
              </Link>
            )}
            {!loading && user && !planLoading && workspaceUiEnabled && (
              <Link
                href="/workspace"
                aria-current={pathname === "/workspace" ? "page" : undefined}
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-cp-text"
              >
                Workspace
              </Link>
            )}
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
