"use client";

/**
 * Sign up: email/password registration and initial profile setup.
 */

import { useState } from "react";
import Image from "next/image";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "@/lib/firebase/client";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * Strips keys with undefined values from an object.
 * Preserves false, 0, "", and null - only removes undefined.
 * Firestore does not accept undefined values in documents.
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined)
  ) as Partial<T>;
}

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState(""); // Optional full name field
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    try {
      // Sign up with Firebase Auth (client-side only for MVP)
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );
      const user = userCredential.user;

      // After Firebase Auth creates the user, initialize a user profile doc in Firestore
      // and send them to the onboarding flow to capture extra information.
      // 
      // We set onboardingCompleted: false so the app will redirect them to /onboarding
      // where they can provide role, use case, usage frequency, and referral source.
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
      // Use stripUndefined to remove undefined values before writing to Firestore.
      // Firestore does not accept undefined field values.
      await setDoc(doc(db, "users", user.uid), stripUndefined({
        uid: user.uid,
        email: user.email,
        name: name.trim() || undefined, // Will be stripped if empty
        role: "user", // User role (not onboarding role)
        plan: "free", // Default plan for all new users
        runsThisMonth: 0, // Start with zero runs
        usageMonth: currentMonth, // Track which month the counter applies to
        tokensUsedCurrentPeriod: 0, // Initialize token counter for current billing period
        totalRuns: 0, // Initialize lifetime run counter
        onboardingCompleted: false, // User must complete onboarding before using the app
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
        isDisabled: false,
      }));

      // Redirect to onboarding page instead of main app
      // The onboarding page will capture role, use case, usage frequency, and referral source
      router.push("/onboarding");
      router.refresh(); // Refresh to update auth state
    } catch (err: any) {
      setError(err.message || "Failed to create account");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sign Up Page - 2-column hero + auth layout
   * 
   * This page uses the same standardized design system as Sign In:
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
          {/* Research Image - positioned on top */}
          <div className="relative w-full aspect-[4/3] rounded-xl overflow-hidden shadow-2xl border border-slate-800/50 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 mb-6">
            <Image
              src="/research-hero.png"
              alt="AI research workspace with data visualizations, neural network graphics, and advanced analytics"
              fill
              className="object-cover"
              priority
              sizes="(max-width: 1024px) 100vw, 50vw"
              // Fallback if image doesn't exist yet
              onError={(e) => {
                // Hide image container if image fails to load
                (e.target as HTMLElement).parentElement?.classList.add('hidden');
              }}
            />
            {/* Overlay gradient for better visual integration with dark background */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/20 to-transparent pointer-events-none" />
          </div>

          {/* Small pill/tag at top for brand positioning */}
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-900/60 px-3 py-1 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            Consensus · Audit trail · Governance on 5-Model plan
          </div>

          <h1 className="mt-6 text-3xl font-semibold text-white sm:text-4xl">
            Don&apos;t trust one AI.
            <span className="block text-sky-300">Verify with five.</span>
          </h1>
          <p className="mt-3 text-sm text-slate-200 sm:text-base leading-relaxed">
            Same workflow as the product: research questions and pasted claims go to multiple models at
            once. You keep the structured synthesis, the claim verdict, and the record of what was
            checked.
          </p>

          <p className="mt-4 text-sm font-semibold text-slate-100">Your free account includes:</p>
          <ul className="mt-2 space-y-2 text-sm text-slate-200">
            <li>• Up to 8 research or verification runs per month</li>
            <li>• 2 AI models per run</li>
            <li>• Claim verification with consensus scoring</li>
            <li>• Audit trails on every run</li>
            <li>• No credit card required</li>
          </ul>

          <p className="mt-4 text-sm text-slate-400">
            Want structured review, optional peer review, and all five models?{" "}
            <Link href="/pricing" className="font-medium text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline">
              See our plans
            </Link>
            .
          </p>
        </div>

        {/* Right column: actual authentication card */}
        {/* On desktop: takes up half width with max-width constraint */}
        {/* On mobile: full width */}
        <div className="w-full max-w-md lg:w-1/2">
          {/* Welcome info panel above the auth card */}
          {/* Provides context about what users get when they sign up */}
          {/* Card styling: bg-slate-50 with slate-200 ring for subtle brand feel */}
          <div className="rounded-2xl bg-white/95 p-6 shadow-xl ring-1 ring-slate-900/5">
            <h2 className="text-xl lg:text-2xl font-semibold tracking-tight text-slate-900">
              Create your ConvergePanel account
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Use the email you want for sign-in. You&apos;ll complete a short onboarding step next.
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
                  htmlFor="name"
                  className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Full Name <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500"
                  placeholder="Your name"
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
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500"
                  placeholder="At least 6 characters"
                />
              </div>

              <div>
                <label
                  htmlFor="confirmPassword"
                  className="block text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500"
                  placeholder="Confirm your password"
                />
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
                {loading ? "Creating account..." : "Create account"}
              </button>
            </form>

            <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Your free account includes:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>8 research or claim runs per month</li>
                <li>2 AI models per run (choose from Claude, GPT, Gemini, Grok, Perplexity)</li>
                <li>Claim verification with consensus scoring</li>
                <li>Audit trails on results (view, copy JSON, download where offered)</li>
                <li>No credit card required</li>
              </ul>
            </div>

            <p className="mt-6 text-center text-sm text-slate-500">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-sky-600 hover:text-sky-700">
                Sign in
              </Link>
            </p>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
              By creating an account, you agree to our{" "}
              <Link href="/terms" className="text-sky-600 underline hover:text-sky-700">
                Terms of Service
              </Link>
              , including that AI outputs may be inaccurate and that you alone are responsible for
              vetting and cross-checking any information. ConvergePanel disclaims liability for
              incorrect model responses.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

