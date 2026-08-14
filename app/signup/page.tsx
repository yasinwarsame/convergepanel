"use client";

/**
 * Sign up: email/password registration and initial profile setup.
 */

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase/client";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { useAuth } from "@/components/AuthProvider";
import { clearServerSession } from "@/lib/client/sessionSync";
import posthog from "posthog-js";

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

const SIGNUP_FREE_LINES = [
  "8 research or verification runs per month",
  "2 AI models per run (Claude, GPT, Gemini, Grok, Perplexity)",
  "Claim verification with consensus scoring",
  "Governance status badges on every result",
  "Audit trail on every run",
  "No credit card required",
] as const;

const SIGNUP_UPGRADE_LINES = [
  "All 5 models per run",
  "150 runs per month",
  "20 video verifications per month",
  "AI-assisted video authenticity review (paid plans)",
  "Governance dashboard and peer review",
  "Approve or block flagged results",
  "Full audit log of all review decisions",
  "Sensitive domain detection",
] as const;

const FEATURE_SHOWCASE_ITEMS = [
  {
    icon: "🔍",
    title: "Multi-Model Research",
    lines: [
      "Ask a question. 5 AI models answer independently.",
      "See consensus, disagreements, and blind spots.",
    ],
  },
  {
    icon: "🛡️",
    title: "Claim Verification",
    lines: [
      "Paste any claim. Get a verdict: Confirmed, Disputed, Partially True, or Unverifiable.",
    ],
  },
  {
    icon: "🎬",
    title: "Video Verification",
    lines: [
      "Upload a video. Three AI vision models review for AI generation, synthetic edits, and manipulation.",
      "⚠️ AI-assisted authenticity review — not forensic analysis.",
    ],
  },
  {
    icon: "📊",
    title: "Consensus Scoring",
    lines: [
      "Every run scored 0-100. Know what's defensible and what needs a second look.",
    ],
  },
  {
    icon: "⚖️",
    title: "Governance Dashboard",
    lines: [
      "Set trust thresholds. Flag weak evidence automatically.",
      "Review flagged runs before they're acted on.",
    ],
  },
  {
    icon: "👥",
    title: "Peer Review",
    lines: [
      "Assign a colleague as your reviewer. They approve or block your flagged claims and research.",
    ],
  },
  {
    icon: "📋",
    title: "Audit Trail",
    lines: ["Every run and every review decision logged.", "Who checked what, when, and why."],
  },
  {
    icon: "🔐",
    title: "Sensitive Domain Detection",
    lines: [
      "Legal, medical, and financial queries automatically get stricter verification thresholds.",
    ],
  },
] as const;

function FeatureShowcase(props: { variant: "onDark" | "onLight" }) {
  const { variant } = props;
  const headingCls = variant === "onDark" ? "text-cp-text" : "text-cp-text";
  const titleCls = variant === "onDark" ? "text-cp-text" : "text-cp-text";
  const bodyCls = variant === "onDark" ? "text-cp-muted" : "text-cp-muted";
  const col1 = FEATURE_SHOWCASE_ITEMS.slice(0, 4);
  const col2 = FEATURE_SHOWCASE_ITEMS.slice(4);

  return (
    <section aria-labelledby="signup-why-heading" className="text-left">
      <h3 id="signup-why-heading" className={`text-base font-semibold sm:text-lg ${headingCls}`}>
        Why ConvergePanel?
      </h3>
      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2 lg:gap-y-5">
        <div className="space-y-4 lg:space-y-5">
          {col1.map((item) => (
            <div key={item.title} className="flex gap-3">
              <span className="shrink-0 text-lg leading-none" aria-hidden>
                {item.icon}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${titleCls}`}>{item.title}</p>
                {item.lines.map((line) => (
                  <p key={line} className={`mt-1 text-xs leading-snug sm:text-sm ${bodyCls}`}>
                    {line}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-4 lg:space-y-5">
          {col2.map((item) => (
            <div key={item.title} className="flex gap-3">
              <span className="shrink-0 text-lg leading-none" aria-hidden>
                {item.icon}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${titleCls}`}>{item.title}</p>
                {item.lines.map((line) => (
                  <p key={line} className={`mt-1 text-xs leading-snug sm:text-sm ${bodyCls}`}>
                    {line}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SignupValueCheckList(props: { lines: readonly string[] }) {
  return (
    <ul className="mt-2 space-y-1.5 text-sm leading-snug text-cp-text">
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

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState(""); // Optional full name field
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { syncState, user: authedUser } = useAuth();

  // Auth Lifecycle Hardening, Step 6.5 — same pending-sync pattern as
  // app/login/page.tsx: redirect only once syncState === "authenticated"
  // for THIS uid, never merely because Firebase resolved a credential.
  // `pendingSignupUid` MUST be React state, not a ref — see the detailed
  // comment in app/login/page.tsx: AuthProvider's own sync can finish
  // before this handler arms the expected uid, and only a state update
  // (not a ref mutation) re-runs the watching effect to notice.
  const [pendingSignupUid, setPendingSignupUid] = useState<string | null>(null);
  const pendingRedirectRef = useRef<string | null>(null);
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingSignup = () => {
    setPendingSignupUid(null);
    pendingRedirectRef.current = null;
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    if (!pendingSignupUid) return;
    if (syncState === "authenticated" && authedUser?.uid === pendingSignupUid) {
      const next = pendingRedirectRef.current ?? "/onboarding";
      clearPendingSignup();
      setLoading(false);
      router.push(next);
      router.refresh();
    } else if (syncState === "session_error") {
      clearPendingSignup();
      setLoading(false);
      setError("Account created, but sign-in could not be completed. Please sign in.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSignupUid, syncState, authedUser, router]);

  useEffect(() => () => clearPendingSignup(), []);

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
      // Auth Lifecycle Hardening, Step 6.6 — signing up while a DIFFERENT
      // session is already active in this browser is an account switch;
      // invalidate the old one first (same as app/login/page.tsx).
      if (auth.currentUser) {
        await clearServerSession();
        await signOut(auth);
      }

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

      // Session-cookie creation/verification now happens reactively in
      // AuthProvider's onIdTokenChanged listener — see the pending-sync
      // effect above, which waits for it before redirecting.

      posthog.identify(user.uid, { email: user.email ?? undefined, name: name.trim() || undefined });
      posthog.capture("user_signed_up", { method: "email" });

      // Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 —
      // new-user provisioning gap resolution, hardened per independent
      // review: AWAITED (not fire-and-forget) — this is the very first
      // opportunity to provision a brand-new user's Personal Workspace.
      // POST /api/user/workspace is Phase 2's existing self-provisioning
      // endpoint.
      //
      // Only a WELL-FORMED, non-"provisioning_disabled" error response
      // blocks onboarding — never a network-level failure (fetch
      // throwing). See app/login/page.tsx's identical block for the full
      // reasoning: a thrown error carries no information about whether
      // PERSONAL_WORKSPACE_PROVISIONING_ENABLED is even on server-side, so
      // treating it as a hard block would give signup a new failure
      // dependency on this one endpoint even while Phase 3 is entirely
      // dark. Logged for observability; the residual gap is fully
      // contained server-side (a first research request without a
      // Workspace still fails safely and clearly — no run, no tokens
      // spent). Provisioning is idempotent, so the correct recovery for a
      // genuine failure is "try again" (directed to sign in, which
      // re-attempts via login's own hardened self-heal), never "start
      // over" — the just-created Auth account/profile is never deleted.
      let personalWorkspaceReady = true;
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const workspaceRes = await authedFetch("/api/user/workspace", { user, authReady: true, method: "POST" });
        if (!workspaceRes.ok) {
          const workspaceBody = await workspaceRes.json().catch(() => ({}) as any);
          personalWorkspaceReady = workspaceBody?.errorCode === "provisioning_disabled";
        }
      } catch (err: any) {
        // Network-level failure — never block signup on this alone (see
        // comment above). Only surfaced in logs.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[signup] Personal Workspace provisioning request failed (non-blocking network error):", err?.message);
        }
      }
      if (!personalWorkspaceReady) {
        setError("Your account was created, but we couldn't finish setting it up. Please try signing in.");
        setLoading(false);
        return;
      }

      // Redirect to onboarding page instead of main app
      // Preserve any redirect param so the user lands on their intended page after onboarding
      const rawRedirect = searchParams.get("redirect") || searchParams.get("next");
      const postOnboardingRedirect = safeRedirect(rawRedirect, "/");
      const onboardingUrl = postOnboardingRedirect !== "/"
        ? `/onboarding?redirect=${encodeURIComponent(postOnboardingRedirect)}`
        : "/onboarding";

      pendingRedirectRef.current = onboardingUrl;
      setPendingSignupUid(user.uid);
      pendingTimeoutRef.current = setTimeout(() => {
        setPendingSignupUid((current) => {
          if (current === user.uid) {
            pendingRedirectRef.current = null;
            setLoading(false);
            setError("Account created, but sign-in is taking longer than expected. Please sign in.");
            return null;
          }
          return current;
        });
      }, 10000);
    } catch (err: any) {
      setError(err.message || "Failed to create account");
      setLoading(false);
    }
  };

  /** Sign Up: hero image + feature showcase + narrative left; form and plan summary right (showcase repeats in-card on mobile after form). */
  return (
    <main className="min-h-screen bg-cp-bg text-cp-text">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col items-stretch px-4 py-10 lg:flex-row lg:px-8 lg:py-16 lg:gap-10">
        {/* Left: image (all breakpoints), then showcase + headline (desktop only) */}
        <div className="mb-8 w-full lg:mb-0 lg:w-1/2 lg:max-w-none lg:pr-4">
          <div className="relative mb-6 aspect-[4/3] w-full overflow-hidden rounded-xl border border-cp-border bg-cp-raised shadow-sm lg:mb-8">
            <Image
              src="/research-hero.png"
              alt="AI research workspace with data visualizations, neural network graphics, and advanced analytics"
              fill
              className="object-cover"
              priority
              sizes="(max-width: 1024px) 100vw, 50vw"
              onError={(e) => {
                (e.target as HTMLElement).parentElement?.classList.add("hidden");
              }}
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-cp-bg/50 via-cp-bg/10 to-transparent" />
          </div>

          <div className="hidden lg:block">
            <FeatureShowcase variant="onLight" />
            <div className="mt-8 inline-flex items-center gap-2 rounded-full bg-cp-primary-soft px-3 py-1 text-xs font-medium text-cp-accent ring-1 ring-cp-primary/20">
              <span className="h-1.5 w-1.5 rounded-full bg-cp-primary" />
              Multi-model research · Claim verification · Video verification · Governance
            </div>
            <h1 className="mt-6 text-3xl font-semibold text-cp-text sm:text-4xl">
              Don&apos;t trust one AI.
              <span className="block text-cp-accent">Verify with five.</span>
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-cp-muted sm:text-base">
              Research and claims go to multiple models at once—with consensus, governance signals, and
              audit trails you can rely on.
            </p>
            <p className="mt-5 text-sm text-cp-faint">
              <Link
                href="/pricing"
                className="font-medium text-cp-accent underline-offset-2 hover:underline"
              >
                Compare plans
              </Link>{" "}
              — free tier includes 2 models per run; upgrade for all five and team governance.
            </p>
          </div>
        </div>

        <div className="w-full max-w-md lg:mx-0 lg:w-1/2 lg:max-w-none">
          <div className="rounded-[14px] bg-cp-surface p-6 shadow-sm border border-cp-border">
            <h2 className="text-xl font-semibold tracking-tight text-cp-text lg:text-2xl">
              Create your ConvergePanel account
            </h2>
            <p className="mt-1 text-sm text-cp-muted">
              Use the email you want for sign-in. You&apos;ll complete a short onboarding step next.
            </p>

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
                  htmlFor="name"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Full Name <span className="text-cp-faint font-normal">(optional)</span>
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="Your name"
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
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="At least 6 characters"
                />
              </div>

              <div>
                <label
                  htmlFor="confirmPassword"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
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
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
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
                className="mt-2 inline-flex w-full items-center justify-center rounded-[11px] bg-cp-primary px-4 py-2.5 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition hover:bg-cp-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cp-surface disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Creating account..." : "Create account"}
              </button>
            </form>

            <div className="mt-6 border-t border-cp-border-soft pt-6 lg:hidden">
              <FeatureShowcase variant="onLight" />
            </div>

            <div className="mt-6 space-y-5 rounded-xl border border-cp-border bg-cp-raised p-4 text-left text-sm text-cp-text">
              <div>
                <p className="font-semibold text-cp-text">Your free account includes:</p>
                <SignupValueCheckList lines={SIGNUP_FREE_LINES} />
                <p className="mt-3 text-xs leading-relaxed text-cp-muted">
                  Want video verification, governance, and all 5 models?{" "}
                  <Link href="/pricing" className="font-medium text-cp-accent underline hover:no-underline">
                    See our plans
                  </Link>
                  .
                </p>
              </div>
              <div className="border-t border-cp-border-soft pt-4">
                <p className="font-semibold text-cp-text">
                  Upgrade to the{" "}
                  <Link href="/pricing" className="text-cp-accent underline hover:no-underline">
                    5-Model plan
                  </Link>{" "}
                  for:
                </p>
                <SignupValueCheckList lines={SIGNUP_UPGRADE_LINES} />
              </div>
            </div>

            <p className="mt-6 text-center text-sm text-cp-faint">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-cp-accent hover:underline">
                Sign in
              </Link>
            </p>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-cp-faint">
              By creating an account, you agree to our{" "}
              <Link href="/terms" className="text-cp-accent underline hover:no-underline">
                Terms of Service
              </Link>
              , including that AI outputs may be inaccurate and that you alone are responsible for
              vetting and cross-checking any information. ConvergePanel disclaims liability for
              incorrect model responses.
            </p>
          </div>

          <div className="mt-10 space-y-5 border-t border-cp-border pt-8 lg:hidden">
            <div className="inline-flex items-center gap-2 rounded-full bg-cp-primary-soft px-3 py-1 text-xs font-medium text-cp-accent ring-1 ring-cp-primary/20">
              <span className="h-1.5 w-1.5 rounded-full bg-cp-primary" />
              Multi-model research · Claim verification · Video verification · Governance
            </div>
            <h1 className="text-2xl font-semibold text-cp-text sm:text-3xl">
              Don&apos;t trust one AI.
              <span className="block text-cp-accent">Verify with five.</span>
            </h1>
            <p className="text-sm leading-relaxed text-cp-muted">
              Research and claims go to multiple models at once—with consensus, governance signals, and
              audit trails you can rely on.
            </p>
            <p className="text-sm text-cp-faint">
              <Link
                href="/pricing"
                className="font-medium text-cp-accent underline-offset-2 hover:underline"
              >
                Compare plans
              </Link>{" "}
              — free tier includes 2 models per run; upgrade for all five and team governance.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

