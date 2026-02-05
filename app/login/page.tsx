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
import { aboutCopy } from "@/lib/content/aboutCopy";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

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
          {/* Small pill/tag at top for brand positioning */}
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-900/60 px-3 py-1 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            Multi-LLM Expert Panel · Trust your answers
          </div>

          {/* Auth hero: position ConvergePanel as a deep-research, multi-LLM expert panel
              that highlights consensus, disagreement, and bias. */}
          {/* Highlight "Deep Research" with the same accent color as "biases and blind spots"
              so users immediately recognize these as core ideas of ConvergePanel. */}
          {/* Main headline with sky accent color for emphasis */}
          {/* Typography hierarchy: Hero headline uses largest size (text-4xl sm:text-5xl) */}
          <h1 className="mt-6 text-3xl font-semibold text-white sm:text-4xl">
            {aboutCopy.headline.before}
            <span className="block text-sky-300">{aboutCopy.headline.accent}</span>
          </h1>
          <p className="mt-3 text-sm text-slate-200 sm:text-base">
            {aboutCopy.subheadline.before}
            <span className="font-semibold text-sky-300">{aboutCopy.subheadline.accent}</span>
            {aboutCopy.subheadline.after}
          </p>

          {/* Bullet list of key benefits */}
          {/* Auth hero copy: emphasize that ConvergePanel is not just about consensus,
              but also about exposing potential model bias and missing perspectives. */}
          {/* Hero body text: text-slate-200 with relaxed leading */}
          <ul className="mt-4 space-y-1 text-sm text-slate-200">
            {aboutCopy.benefits.map((benefit, index) => {
              if (benefit.accent) {
                const parts = benefit.text.split(benefit.accent);
                return (
                  <li key={index}>
                    • {parts[0]}
                    <span className="font-semibold text-sky-300">{benefit.accent}</span>
                    {parts[1]}
                  </li>
                );
              }
              return <li key={index}>• {benefit.text}</li>;
            })}
          </ul>

          {/* Final line emphasizing use cases */}
          {/* Muted text: text-slate-400 for subtle emphasis */}
          <p className="mt-4 text-sm text-slate-300">
            {aboutCopy.useCaseDescription}
          </p>
        </div>

        {/* Right column: actual authentication card */}
        {/* On desktop: takes up half width with max-width constraint */}
        {/* On mobile: full width */}
        <div className="w-full max-w-md lg:w-1/2">
          {/* Welcome info panel above the auth card */}
          {/* Provides context about what users get when they sign up */}
          {/* Card styling: bg-slate-50 with slate-200 ring for subtle brand feel */}
          <div className="mb-6 rounded-2xl bg-slate-50 p-5 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-xl sm:text-2xl font-bold text-sky-600 mb-2">
              Welcome to ConvergePanel
            </h2>
            <p className="text-xs sm:text-sm text-slate-600">
              Sign in to run multi-LLM panels, view agreement maps,
              and revisit your past research.
            </p>
          </div>

          {/* Main auth card with elevated styling */}
          {/* bg-white/95 provides slight transparency for depth */}
          {/* shadow-xl and ring create a premium, floating effect */}
          <div className="rounded-2xl bg-white/95 p-6 shadow-xl ring-1 ring-slate-900/5">
            {/* Card title: Second level in hierarchy (text-xl lg:text-2xl) */}
            <h2 className="text-xl lg:text-2xl font-semibold tracking-tight text-slate-900">
              Sign In
            </h2>
            {/* Card subtitle: Body text in card (text-slate-600) */}
            <p className="mt-1 text-sm text-slate-600">
              Sign in to your ConvergePanel account
            </p>

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

            {/* Footer text: Muted text (text-slate-400) with sky-600 link */}
            <p className="mt-6 text-center text-xs text-slate-400">
              Don&apos;t have an account?{" "}
              <Link
                href="/signup"
                className="font-medium text-sky-600 hover:text-sky-700"
              >
                Sign up
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

