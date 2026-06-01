"use client";

/**
 * Primary site navigation: branding, auth links, profile/billing/governance entry, mobile menu.
 */

import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "./AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";

export default function TopNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, isAdmin } = useAuth();
  const { governanceDashboardEligible, plan: userPlan, loading: planLoading } = useUserPlan();
  const isGovernanceUser = governanceDashboardEligible || userPlan === "full";
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Highlight the correct auth link based on the current route,
  // so Login is active on /login and Sign up is active on /signup.
  const isLogin = pathname === "/login" || pathname === "/signin";
  const isSignup = pathname === "/signup";

  const logoutInProgressRef = useRef(false);

  // Close user menu when clicking outside
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

  // Reset logout flag when user changes (e.g., after successful logout)
  // This ensures the flag is reset if logout succeeds but navigation fails
  useEffect(() => {
    if (!user) {
      logoutInProgressRef.current = false;
    }
  }, [user]);
  
  const handleLogout = async () => {
    // Prevent multiple rapid logout calls
    if (logoutInProgressRef.current) {
      console.log("[TopNav] Logout already in progress, ignoring duplicate call");
      return;
    }
    
    logoutInProgressRef.current = true;
    
    try {
      // Close the user menu immediately for better UX
      setUserMenuOpen(false);
      setMobileMenuOpen(false);
      
      // Sign out - this triggers onAuthStateChanged in AuthProvider
      // which will set user to null, allowing our useEffect above to reset the flag
      await signOut(auth);
      
      // Navigate immediately - the auth state change will propagate
      // Use replace instead of push to prevent back button issues
      router.replace("/login?signedOut=1");
      
      // Reset flag after a delay to allow navigation to complete
      // This prevents race conditions if user tries to logout again quickly
      setTimeout(() => {
        logoutInProgressRef.current = false;
      }, 1000);
    } catch (error) {
      console.error("[TopNav] Error signing out:", error);
      // Reset flag on error so user can try again
      logoutInProgressRef.current = false;
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
        {/* Logo/Title */}
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <Image
            src="/convergepanel-logo.png"
            alt="ConvergePanel"
            width={72}
            height={72}
            priority
            className="h-16 w-auto"
          />
          <div className="flex flex-col">
            <span className="text-2xl md:text-3xl font-semibold tracking-tight">
              <span className="text-slate-900">Converge</span>
              <span className="text-sky-600">Panel</span>
            </span>
            <p
              className="
                mt-1
                inline-flex
                items-center
                rounded-full
                bg-slate-50/90
                px-3
                py-1
                text-[11px] sm:text-xs
                font-medium
                tracking-[0.16em]
                text-slate-500
                uppercase
                hidden md:block
                shadow-sm
              "
            >
              Research · Claim verification · Video verification · Consensus · Governance
            </p>
          </div>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            href="/about"
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            About
          </Link>
          <Link
            href="/help"
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            Help
          </Link>
          <Link
            href="/contact"
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            Contact
          </Link>
          <Link
            href="/pricing"
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            Pricing
          </Link>
          {!loading && user && (
            planLoading ? (
              <span className="invisible px-3 py-1.5 text-sm">Governance</span>
            ) : isGovernanceUser ? (
              <Link
                href="/governance"
                className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition-colors"
              >
                Governance
              </Link>
            ) : null
          )}
          
          {!loading && (
            <>
              {!user ? (
                <>
                  <Link
                    href="/login"
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                      isLogin
                        ? "text-sky-600"
                        : "text-slate-700 hover:text-slate-900"
                    }`}
                  >
                    Login
                  </Link>
                  <Link
                    href="/signup"
                    className={`px-4 py-1.5 text-sm font-semibold rounded-lg transition-colors ${
                      isSignup
                        ? "bg-sky-600 text-white hover:bg-sky-700"
                        : "bg-slate-100 text-slate-900 hover:bg-slate-200"
                    }`}
                  >
                    Sign up
                  </Link>
                </>
              ) : (
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-full hover:bg-slate-100 transition-colors"
                  >
                    <div className="h-7 w-7 rounded-full bg-sky-100 flex items-center justify-center">
                      <span className="text-xs font-semibold text-sky-700">
                        {(user.displayName || user.email?.[0] || "U").toUpperCase()}
                      </span>
                    </div>
                    <span className="text-sm font-medium text-slate-700">
                      {user.displayName || user.email?.split("@")[0] || "User"}
                    </span>
                    <svg
                      className={`h-4 w-4 text-slate-500 transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
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
                    <div className="absolute right-0 mt-2 w-48 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
                      <Link
                        href="/profile"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        Profile
                      </Link>
                      {!loading && isAdmin && (
                        <Link
                          href="/admin"
                          onClick={() => setUserMenuOpen(false)}
                          className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                        >
                          Admin
                        </Link>
                      )}
                      <button
                        onClick={() => {
                          setUserMenuOpen(false);
                          handleLogout();
                        }}
                        className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        Logout
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Mobile Menu Button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 rounded-md text-slate-700 hover:text-slate-900 hover:bg-slate-100"
          aria-label="Toggle menu"
        >
          <svg
            className="h-6 w-6"
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

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden py-4 border-t border-slate-200 px-4">
          <div className="flex flex-col space-y-2">
            <Link
              href="/about"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors"
            >
              About
            </Link>
            <Link
              href="/help"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors"
            >
              Help
            </Link>
            <Link
              href="/contact"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors"
            >
              Contact
            </Link>
            <Link
              href="/pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors"
            >
              Pricing
            </Link>
            {!loading && user && (
              planLoading ? (
                <span className="invisible px-3 py-2 text-sm">Governance</span>
              ) : isGovernanceUser ? (
                <Link
                  href="/governance"
                  onClick={() => setMobileMenuOpen(false)}
                  className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors"
                >
                  Governance
                </Link>
              ) : null
            )}
            
            {!loading && (
              <>
                {!user ? (
                  <>
                    <Link
                      href="/login"
                      onClick={() => setMobileMenuOpen(false)}
                      className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                        isLogin
                          ? "text-sky-600 bg-sky-50"
                          : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      Login
                    </Link>
                    <Link
                      href="/signup"
                      onClick={() => setMobileMenuOpen(false)}
                      className={`px-3 py-2 text-sm font-semibold rounded-lg transition-colors ${
                        isSignup
                          ? "bg-sky-600 text-white hover:bg-sky-700"
                          : "bg-slate-100 text-slate-900 hover:bg-slate-200"
                      }`}
                    >
                      Sign up
                    </Link>
                  </>
                ) : (
                  <>
                    <Link
                      href="/profile"
                      onClick={() => setMobileMenuOpen(false)}
                      className="px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-md transition-colors"
                    >
                      Profile
                    </Link>
                    {!loading && isAdmin && (
                      <Link
                        href="/admin"
                        onClick={() => setMobileMenuOpen(false)}
                        className="px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-md transition-colors"
                      >
                        Admin
                      </Link>
                    )}
                    <button
                      onClick={() => {
                        setMobileMenuOpen(false);
                        handleLogout();
                      }}
                      className="px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-md transition-colors text-left"
                    >
                      Logout
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

