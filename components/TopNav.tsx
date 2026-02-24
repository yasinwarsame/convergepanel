"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "./AuthProvider";

export default function TopNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [resourcesMenuOpen, setResourcesMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, isAdmin } = useAuth();
  const userMenuRef = useRef<HTMLDivElement>(null);
  const resourcesMenuRef = useRef<HTMLDivElement>(null);

  // Determine active mode
  const isCodeCheckMode = pathname?.startsWith("/codecheck");
  const isDeepResearchMode = pathname === "/" || (!isCodeCheckMode && !pathname?.startsWith("/admin"));

  // Highlight the correct auth link based on the current route,
  // so Login is active on /login and Sign up is active on /signup.
  const isLogin = pathname === "/login" || pathname === "/signin";
  const isSignup = pathname === "/signup";

  const logoutInProgressRef = useRef(false);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
      if (resourcesMenuRef.current && !resourcesMenuRef.current.contains(event.target as Node)) {
        setResourcesMenuOpen(false);
      }
    };

    if (userMenuOpen || resourcesMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [userMenuOpen, resourcesMenuOpen]);

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
      router.replace("/login");
      
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
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4 relative">
        {/* Logo - Left */}
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <Image
            src="/convergepanel-logo.png"
            alt="ConvergePanel"
            width={72}
            height={72}
            priority
            className="h-12 w-auto md:h-14"
          />
          <div className="flex flex-col">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              <span className="text-slate-900">Converge</span>
              <span className="text-sky-600">Panel</span>
            </h1>
            <p className="text-xs text-slate-500 hidden sm:block">
              AI-Powered Research Consensus
            </p>
          </div>
        </Link>

        {/* Mode Switcher - Center */}
        <div className="hidden md:flex items-center absolute left-1/2 -translate-x-1/2">
          <div className="flex items-center rounded-lg bg-slate-100 p-1">
            <Link
              href="/"
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
                isDeepResearchMode
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Deep Research
            </Link>
            <Link
              href="/codecheck"
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all flex items-center gap-1.5 ${
                isCodeCheckMode
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              CodeCheck
              <span className="inline-flex items-center rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                Beta
              </span>
            </Link>
          </div>
        </div>

        {/* Desktop Navigation - Right Side */}
        <div className="hidden md:flex items-center gap-3">
          {/* Resources Dropdown */}
          <div className="relative" ref={resourcesMenuRef}>
            <button
              onClick={() => setResourcesMenuOpen(!resourcesMenuOpen)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition-colors"
            >
              Help
              <svg
                className={`h-4 w-4 transition-transform ${resourcesMenuOpen ? "rotate-180" : ""}`}
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
            
            {resourcesMenuOpen && (
              <div className="absolute right-0 mt-2 w-40 rounded-lg border border-slate-200 bg-white shadow-lg py-1 z-50">
                <Link
                  href="/help"
                  onClick={() => setResourcesMenuOpen(false)}
                  className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Help Center
                </Link>
                <Link
                  href="/about"
                  onClick={() => setResourcesMenuOpen(false)}
                  className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  About
                </Link>
                <Link
                  href="/contact"
                  onClick={() => setResourcesMenuOpen(false)}
                  className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Contact
                </Link>
              </div>
            )}
          </div>

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
            {/* Mode Switcher - Prominent at top */}
            <div className="pb-3 mb-2 border-b border-slate-200">
              <p className="px-3 py-1 text-xs font-medium text-slate-500 uppercase tracking-wider">Mode</p>
              <Link
                href="/"
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center px-3 py-2.5 text-sm font-medium rounded-md transition-colors ${
                  isDeepResearchMode
                    ? "text-sky-600 bg-sky-50"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Deep Research
              </Link>
              <Link
                href="/codecheck"
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center px-3 py-2.5 text-sm font-medium rounded-md transition-colors ${
                  isCodeCheckMode
                    ? "text-sky-600 bg-sky-50"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                CodeCheck
                <span className="ml-2 inline-flex items-center rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                  Beta
                </span>
              </Link>
            </div>

            {/* Resources Section */}
            <div className="pb-2 mb-2 border-b border-slate-200">
              <p className="px-3 py-1 text-xs font-medium text-slate-500 uppercase tracking-wider">Resources</p>
              <Link
                href="/help"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors block"
              >
                Help Center
              </Link>
              <Link
                href="/about"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors block"
              >
                About
              </Link>
              <Link
                href="/contact"
                onClick={() => setMobileMenuOpen(false)}
                className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md transition-colors block"
              >
                Contact
              </Link>
            </div>

            {/* Account Section */}
            {!loading && (
              <>
                {!user ? (
                  <div className="pt-2">
                    <Link
                      href="/login"
                      onClick={() => setMobileMenuOpen(false)}
                      className={`block px-3 py-2 text-sm font-medium rounded-md transition-colors ${
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
                      className={`block mt-2 px-3 py-2 text-sm font-semibold rounded-lg text-center transition-colors ${
                        isSignup
                          ? "bg-sky-600 text-white hover:bg-sky-700"
                          : "bg-slate-100 text-slate-900 hover:bg-slate-200"
                      }`}
                    >
                      Sign up
                    </Link>
                  </div>
                ) : (
                  <div className="pt-2">
                    <p className="px-3 py-1 text-xs font-medium text-slate-500 uppercase tracking-wider">Account</p>
                    <Link
                      href="/profile"
                      onClick={() => setMobileMenuOpen(false)}
                      className="px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-md transition-colors block"
                    >
                      Profile
                    </Link>
                    {isAdmin && (
                      <Link
                        href="/admin"
                        onClick={() => setMobileMenuOpen(false)}
                        className="px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-md transition-colors block"
                      >
                        Admin
                      </Link>
                    )}
                    <button
                      onClick={() => {
                        setMobileMenuOpen(false);
                        handleLogout();
                      }}
                      className="w-full px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-md transition-colors text-left"
                    >
                      Logout
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

