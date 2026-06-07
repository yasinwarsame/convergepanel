"use client";

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

  useEffect(() => {
    if (!user) {
      logoutInProgressRef.current = false;
    }
  }, [user]);

  const handleLogout = async () => {
    if (logoutInProgressRef.current) return;
    logoutInProgressRef.current = true;
    try {
      setUserMenuOpen(false);
      setMobileMenuOpen(false);
      await signOut(auth);
      router.replace("/login?signedOut=1");
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
    <header className="sticky top-0 z-50 border-b border-cp-border bg-cp-surface/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">

        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
          <Image
            src="/convergepanel-logo.png"
            alt="ConvergePanel"
            width={48}
            height={48}
            priority
            className="h-10 w-auto"
          />
          <div className="flex flex-col">
            <span className="font-serif text-2xl font-normal tracking-tight">
              <span className="text-cp-text">Converge</span>
              <span className="text-cp-accent">Panel</span>
            </span>
            <span className="hidden font-sans text-[10px] font-medium tracking-[0.18em] uppercase text-cp-text md:block">
              Research · Verify · Govern
            </span>
          </div>
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 md:flex">
          {navLinks.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className="rounded-md px-3 py-1.5 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
            >
              {label}
            </Link>
          ))}

          {!loading && user && !planLoading && isGovernanceUser && (
            <Link
              href="/governance"
              className="rounded-md px-3 py-1.5 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
            >
              Governance
            </Link>
          )}

          {!loading && (
            <div className="ml-3 flex items-center gap-2">
              {!user ? (
                <>
                  <Link
                    href="/login"
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      isLogin
                        ? "text-cp-accent"
                        : "text-cp-text hover:text-white"
                    }`}
                  >
                    Login
                  </Link>
                  <Link
                    href="/signup"
                    className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-all ${
                      isSignup
                        ? "bg-amber-400 text-cp-bg shadow-[0_0_16px_rgba(245,158,11,0.3)]"
                        : "bg-cp-accent text-cp-bg hover:bg-amber-400 hover:shadow-[0_0_16px_rgba(245,158,11,0.25)]"
                    }`}
                  >
                    Sign up
                  </Link>
                </>
              ) : (
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2 rounded-full px-2 py-1.5 transition-colors hover:bg-cp-raised"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full border border-cp-accent/40 bg-cp-raised">
                      <span className="font-mono text-xs font-semibold text-cp-accent">
                        {(user.displayName || user.email?.[0] || "U").toUpperCase()}
                      </span>
                    </div>
                    <span className="text-sm text-cp-text">
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
                    <div className="absolute right-0 mt-2 w-48 overflow-hidden rounded-lg border border-cp-border bg-cp-raised shadow-[0_8px_32px_rgba(0,0,0,0.4)] py-1">
                      <Link
                        href="/profile"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-4 py-2 text-sm text-cp-text transition-colors hover:bg-cp-surface hover:text-white"
                      >
                        Profile
                      </Link>
                      {!loading && isAdmin && (
                        <Link
                          href="/admin"
                          onClick={() => setUserMenuOpen(false)}
                          className="block px-4 py-2 text-sm text-cp-text transition-colors hover:bg-cp-surface hover:text-white"
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
                        className="block w-full px-4 py-2 text-left text-sm text-cp-text transition-colors hover:bg-cp-surface hover:text-white"
                      >
                        Logout
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mobile toggle */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="rounded-md p-2 text-cp-text transition-colors hover:bg-cp-raised hover:text-white md:hidden"
          aria-label="Toggle menu"
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

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="border-t border-cp-border bg-cp-surface px-4 pb-4 pt-3 md:hidden">
          <div className="flex flex-col gap-1">
            {navLinks.map(({ label, href }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
              >
                {label}
              </Link>
            ))}
            {!loading && user && !planLoading && isGovernanceUser && (
              <Link
                href="/governance"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
              >
                Governance
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
                      isLogin ? "text-cp-accent" : "text-cp-text hover:bg-cp-raised hover:text-white"
                    }`}
                  >
                    Login
                  </Link>
                  <Link
                    href="/signup"
                    onClick={() => setMobileMenuOpen(false)}
                    className="mt-1 rounded-lg bg-cp-accent px-3 py-2 text-center text-sm font-semibold text-cp-bg transition-colors hover:bg-amber-400"
                  >
                    Sign up free
                  </Link>
                </>
              ) : (
                <>
                  <Link
                    href="/profile"
                    onClick={() => setMobileMenuOpen(false)}
                    className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
                  >
                    Profile
                  </Link>
                  {!loading && isAdmin && (
                    <Link
                      href="/admin"
                      onClick={() => setMobileMenuOpen(false)}
                      className="rounded-md px-3 py-2 text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
                    >
                      Admin
                    </Link>
                  )}
                  <button
                    onClick={() => {
                      setMobileMenuOpen(false);
                      handleLogout();
                    }}
                    className="rounded-md px-3 py-2 text-left text-sm text-cp-text transition-colors hover:bg-cp-raised hover:text-white"
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
