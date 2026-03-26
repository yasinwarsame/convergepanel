"use client";

/**
 * Login Page
 * 
 * Performance optimizations:
 * - No heavy imports (panel components, charts, etc.) - only auth essentials
 * - No blocking API calls before render - form renders immediately
 * - AuthProvider sets loading=false immediately, then checks admin status async
 * - Minimal dependencies to ensure fast first paint
 */

import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const signedOut = searchParams.get("signedOut") === "1" || searchParams.get("signedOut") === "true";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Sign in with Firebase Auth (client-side only for MVP)
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;

      // Update user document in Firestore
      const { doc, setDoc, getDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase/client");
      
      // Get user's role from token
      const tokenResult = await user.getIdTokenResult();
      const role = tokenResult.claims.admin ? "admin" : "user";
      
      // Check if user doc exists, initialize plan/usage if not
      const userDocRef = doc(db, "users", user.uid);
      const userDoc = await getDoc(userDocRef);
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
      
      const updateData: any = {
        uid: user.uid,
        email: user.email,
        role,
        lastLoginAt: serverTimestamp(),
      };
      
      // Initialize plan and usage if user doc doesn't exist or missing fields
      if (!userDoc.exists() || !userDoc.data()?.plan) {
        updateData.plan = "free";
        updateData.runsThisMonth = 0;
        updateData.usageMonth = currentMonth;
        updateData.tokensUsedCurrentPeriod = 0; // Initialize token counter
        updateData.totalRuns = 0; // Initialize lifetime run counter
      }
      
      await setDoc(userDocRef, updateData, { merge: true });

      // Validate subscription status for paid plans (best-effort, non-blocking)
      // This ensures Firestore stays in sync with Stripe even if webhooks fail
      // Check the actual userDoc data (after merge) to see if user has a paid plan
      const finalUserDoc = await getDoc(userDocRef);
      if (finalUserDoc.exists()) {
        const finalUserData = finalUserDoc.data();
        if (finalUserData?.plan && finalUserData.plan !== "free" && finalUserData.stripeCustomerId) {
          // Call validation API asynchronously - don't block login
          // User just signed in, so authReady should be true, but check to be safe
          // Use a small delay to ensure auth state has propagated
          setTimeout(async () => {
            try {
              const { authedFetch } = await import("@/lib/client/authedFetch");
              let res = await authedFetch("/api/billing/validate-subscription", {
                user,
                authReady: true, // User just signed in, auth should be ready
                method: "POST",
              });
              
              // Retry with force token refresh if we get 401 (stale token edge case)
              if (res.status === 401 && user) {
                res = await authedFetch("/api/billing/validate-subscription", {
                  user,
                  authReady: true,
                  forceTokenRefresh: true,
                  method: "POST",
                });
              }
            } catch (err: any) {
              // Log but don't block - validation is best-effort
              if (process.env.NODE_ENV !== "production") {
                console.warn("[login] Subscription validation request failed (non-blocking):", err?.message);
              }
            }
          }, 100); // Small delay to ensure auth state propagation
        }
      }

      // Redirect to the page user was trying to access (or home)
      const next = searchParams.get("next") || "/";
      router.push(next);
      router.refresh(); // Refresh to update auth state
    } catch (err: any) {
      console.error("Login error:", err);
      setError(err.message || "Failed to sign in");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sign In Page - 2-column hero + auth layout
   * 
   * This page uses a standardized design system with:
   * - Colors: Dark slate gradient background, sky-600/700 for buttons, sky-400 for accent text
   * - Typography: Clear hierarchy (hero > card title > body > labels)
   * - Layout: 2-column on desktop (marketing left, auth card right), stacks on mobile
   * 
   * Design system colors:
   * - Background: slate-950/900 gradient
   * - Accent/Brand: sky-600 (buttons), sky-400 (accent text)
   * - Text: slate-100/200/300 (hero), slate-600/700 (card), slate-400 (muted)
   */
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* Centered flex container: stacks on mobile, side-by-side on desktop */}
      {/* lg:flex-row enables the 2-column layout on large screens */}
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col items-center px-4 py-10 lg:flex-row lg:px-8 lg:py-16">
        {/* Left column: product narrative and benefit bullets */}
        {/* On desktop: takes up half width with right padding for spacing */}
        {/* On mobile: full width with bottom margin */}
        <div className="w-full lg:w-1/2 lg:pr-12 mb-10 lg:mb-0">
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-900/60 px-3 py-1 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            Research · Claim verification · Governance
          </div>

          <h1 className="mt-6 text-3xl font-semibold text-white sm:text-4xl">
            Don&apos;t trust one AI.
            <span className="block text-sky-300">Verify with five.</span>
          </h1>
          <p className="mt-3 text-sm text-slate-200 sm:text-base leading-relaxed">
            Run questions and claims through Claude, GPT, Gemini, Grok, and Perplexity in one place. See
            consensus, splits, and a score you can explain — before you act.
          </p>

          <ul className="mt-4 space-y-2 text-sm text-slate-200">
            <li>• Multi-model research panel with synthesized briefs</li>
            <li>• Claim verification with verdicts and per-model evidence</li>
            <li>• Consensus scoring and compact audit trails</li>
          </ul>

          <p className="mt-4 text-sm text-slate-400">
            For analysts, researchers, product teams, and anyone who ships decisions on AI output.
          </p>
        </div>

        {/* Right column: actual authentication card */}
        {/* On desktop: takes up half width with max-width constraint */}
        {/* On mobile: full width */}
        <div className="w-full max-w-md lg:w-1/2">
          <div className="rounded-2xl bg-white/95 p-6 shadow-xl ring-1 ring-slate-900/5">
            <h2 className="text-xl lg:text-2xl font-semibold tracking-tight text-slate-900">
              Sign in to ConvergePanel
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Multi-model research, claim verification, and governance
            </p>

            {signedOut && (
              <div
                className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700"
                role="status"
              >
                <p className="font-medium text-slate-900">You&apos;ve been signed out.</p>
                <p className="mt-1 text-slate-600">Thanks for using ConvergePanel. Sign back in below.</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500"
                  placeholder="you@email.com"
                  autoFocus
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500"
                  placeholder="Enter your password"
                />
              </div>

              <div className="flex items-center justify-between text-xs">
                <Link
                  href="/reset-password"
                  className="text-sky-600 hover:text-sky-700"
                >
                  Forgot password?
                </Link>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mt-2 inline-flex w-full items-center justify-center rounded-full bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-slate-600">
              New to ConvergePanel?{" "}
              <Link href="/signup" className="font-medium text-sky-600 hover:text-sky-700">
                Sign up free
              </Link>{" "}
              — 8 runs per month on the free plan, no credit card required.
            </p>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
              By signing in, you agree to our{" "}
              <Link href="/terms" className="text-sky-600 underline hover:text-sky-700">
                Terms of Service
              </Link>
              , including that AI-generated outputs may be wrong and that you are solely responsible
              for verifying information before relying on it. ConvergePanel is not liable for errors
              in model outputs.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

