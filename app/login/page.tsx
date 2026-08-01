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

import { useEffect, useRef, useState } from "react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { useAuth } from "@/components/AuthProvider";
import { clearServerSession } from "@/lib/client/sessionSync";
import posthog from "posthog-js";

const LOGIN_VALUE_LINES = [
  "Run research across 5 AI models simultaneously",
  "Verify claims with multi-model consensus scoring",
  "Video verification with AI vision models (paid plans)",
  "See where models agree and disagree",
  "Governance dashboard with peer review",
  "Approve or block flagged claims and research",
  "Full audit trail on every run and review decision",
  "Sensitive domain detection (legal, medical, financial)",
  "Assign a peer reviewer for your work",
] as const;

function ValueFeatureList(props: { lines: readonly string[]; className?: string }) {
  return (
    <ul className={`space-y-2 text-sm leading-snug ${props.className ?? ""}`}>
      {props.lines.map((line) => (
        <li key={line} className="flex gap-2.5">
          <span className="text-emerald-600/90 shrink-0 font-medium" aria-hidden>
            ✓
          </span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const signedOut = searchParams.get("signedOut") === "1" || searchParams.get("signedOut") === "true";
  const { syncState, user: authedUser } = useAuth();

  /**
   * Auth Lifecycle Hardening, Step 6.5 — "login is not application-complete
   * until server session uid equals Firebase client uid." Session
   * synchronization itself now happens reactively in `AuthProvider`
   * (`components/AuthProvider.tsx`, driven by `onIdTokenChanged`); this
   * effect just waits for THAT specific sign-in's uid to reach
   * `syncState === "authenticated"` before redirecting. Checking `uid`
   * (not just `syncState`) is what makes this safe even if a stale
   * `"authenticated"` state from a PREVIOUS session is still settling when
   * this new sign-in starts — a mismatched uid never triggers the redirect.
   *
   * `pendingLoginUid` MUST be React state, not a ref: `AuthProvider`'s own
   * sync runs independently of (and can finish before) this handler's own
   * Firestore work below, so `syncState` can already have reached
   * `"authenticated"` by the time this uid is armed. A ref mutation does
   * not re-run the watching effect, so an already-settled `syncState`
   * would never be re-checked — the redirect would simply never fire,
   * silently, until the bounded timeout below force-fails it. `setState`
   * triggers a fresh render (and thus a fresh effect run) at the moment
   * it's armed, evaluating against whatever `syncState` already is right
   * then, closing that race regardless of which side finishes first.
   */
  const [pendingLoginUid, setPendingLoginUid] = useState<string | null>(null);
  const pendingRedirectRef = useRef<string | null>(null);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingLogin = () => {
    setPendingLoginUid(null);
    pendingRedirectRef.current = null;
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (!pendingLoginUid) return;
    if (syncState === "authenticated" && authedUser?.uid === pendingLoginUid) {
      const next = pendingRedirectRef.current ?? "/";
      clearPendingLogin();
      setLoading(false);
      router.push(next);
      router.refresh();
    } else if (syncState === "session_error") {
      clearPendingLogin();
      setLoading(false);
      setError("Sign-in could not be completed. Please try again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLoginUid, syncState, authedUser, router]);

  // Unmount safety only — the bounded wait itself is armed explicitly in
  // handleSubmit (see below).
  useEffect(() => () => clearPendingLogin(), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Auth Lifecycle Hardening, Step 6.6 — if a DIFFERENT session is
      // already active in this browser, invalidate it (server cookie +
      // Firebase client) BEFORE starting the new sign-in, rather than
      // relying solely on AuthProvider's reactive uid-change fallback.
      if (auth.currentUser) {
        await clearServerSession();
        await signOut(auth);
      }

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

      // Session-cookie creation/verification is no longer done here — it now
      // happens reactively in AuthProvider's onIdTokenChanged listener
      // (lib/client/sessionSync.ts's establishServerSession), which is the
      // single place that call is made from. This handler waits for that to
      // reach syncState === "authenticated" for THIS uid (see effect above)
      // before redirecting.

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

      posthog.identify(user.uid, { email: user.email ?? undefined });
      posthog.capture("user_logged_in", { method: "email" });

      // Redirect to the page user was trying to access (or home) — deferred
      // until the effect above confirms syncState === "authenticated" for
      // THIS uid. `loading` stays true (button disabled) until then.
      const rawRedirect = searchParams.get("redirect") || searchParams.get("next");
      const next = safeRedirect(rawRedirect, "/");

      if (process.env.NODE_ENV !== "production") {
        console.debug("[login] Awaiting session sync before redirect:", { rawRedirect, resolved: next });
      }

      pendingRedirectRef.current = next;
      setPendingLoginUid(user.uid);
      // Bounded wait — never hang the button forever if sync stalls
      // (network partition, a hung fetch). No retry loop here; a single
      // fail-closed timeout surfaces an error and lets the user submit
      // again, consistent with "no infinite retry."
      pendingTimeoutRef.current = setTimeout(() => {
        setPendingLoginUid((current) => {
          if (current === user.uid) {
            pendingRedirectRef.current = null;
            setLoading(false);
            setError("Sign-in is taking longer than expected. Please try again.");
            return null;
          }
          return current;
        });
      }, 10000);
    } catch (err: any) {
      console.error("Login error:", err);
      setError(err.message || "Failed to sign in");
      setLoading(false);
    }
  };

  /**
   * Sign In: auth card + value summary (stacked on mobile, side-by-side from lg).
   */
  return (
    <main className="min-h-screen bg-cp-bg text-cp-text">
      {/* Centered flex container: stacks on mobile, side-by-side on desktop */}
      {/* lg:flex-row enables the 2-column layout on large screens */}
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col items-stretch justify-center gap-10 px-4 py-10 lg:flex-row lg:items-start lg:gap-12 lg:px-8 lg:py-16">
        {/* Auth card first; value summary follows on mobile, sits beside on lg+ */}
        <div className="w-full max-w-md shrink-0 lg:mx-0 mx-auto">
          <div className="rounded-[14px] bg-cp-surface p-6 shadow-sm border border-cp-border">
            <h2 className="text-xl lg:text-2xl font-semibold tracking-tight text-cp-text">
              Sign in to ConvergePanel
            </h2>

            {signedOut && (
              <div
                className="mt-4 rounded-xl border border-cp-border bg-cp-raised px-3 py-3 text-sm text-cp-muted"
                role="status"
              >
                <p className="font-medium text-cp-text">You&apos;ve been signed out.</p>
                <p className="mt-1 text-cp-muted">Thanks for using ConvergePanel. Sign back in below.</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
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
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="you@email.com"
                  autoFocus
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
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
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="Enter your password"
                />
              </div>

              <div className="flex items-center justify-between text-xs">
                <Link
                  href="/reset-password"
                  className="text-cp-accent hover:underline"
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
                className="mt-2 inline-flex w-full items-center justify-center rounded-[11px] bg-cp-primary px-4 py-2.5 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition hover:bg-cp-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cp-surface disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-cp-muted">
              New to ConvergePanel?{" "}
              <Link
                href={
                  searchParams.get("redirect")
                    ? `/signup?redirect=${encodeURIComponent(searchParams.get("redirect")!)}`
                    : "/signup"
                }
                className="font-medium text-cp-accent hover:underline"
              >
                Sign up free
              </Link>{" "}
              — 8 runs per month on the free plan, no credit card required.
            </p>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-cp-faint">
              By signing in, you agree to our{" "}
              <Link href="/terms" className="text-cp-accent underline hover:no-underline">
                Terms of Service
              </Link>
              , including that AI-generated outputs may be wrong and that you are solely responsible
              for verifying information before relying on it. ConvergePanel is not liable for errors
              in model outputs.
            </p>
          </div>
        </div>

        <div className="w-full min-w-0 lg:max-w-md lg:pt-1 xl:max-w-lg">
          <p className="text-sm font-semibold leading-snug text-cp-text">
            ConvergePanel — Multi-model research, claim verification, video verification, and governance
          </p>
          <ValueFeatureList lines={LOGIN_VALUE_LINES} className="mt-4 text-cp-muted" />
        </div>
      </div>
    </main>
  );
}

