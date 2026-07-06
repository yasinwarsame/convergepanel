"use client";

/**
 * Onboarding Page
 * 
 * This page runs once after signup to capture extra profile information:
 * - Role/background (founder, analyst, student, engineer, etc.)
 * - Primary use case (market research, strategy, academic, etc.)
 * - Expected usage frequency (few per month, few per week, daily)
 * - Referral source (optional: how they heard about ConvergePanel)
 * 
 * Flow:
 * 1. User signs up → redirected here
 * 2. User answers questions → data saved to Firestore
 * 3. onboardingCompleted flag set to true
 * 4. User redirected to main app
 * 
 * This page is guarded by:
 * - Authentication check (redirects to /login if not logged in)
 * - onboardingCompleted flag (redirects to main app if already completed)
 */

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { UserProfile } from "@/lib/types";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import posthog from "posthog-js";

// Onboarding question option types
type RoleOption = "founder_operator" | "analyst_consultant" | "student_researcher" | "engineer_datascientist" | "other";
type UseCaseOption = "market_research" | "strategy_decisions" | "academic_research" | "compare_models" | "other";
type UsageOption = "few_per_month" | "few_per_week" | "daily";
type ReferralOption = "friend" | "social" | "search" | "community" | "other";

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

export default function OnboardingPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // Form state
  const [role, setRole] = useState<RoleOption | null>(null);
  const [useCase, setUseCase] = useState<UseCaseOption | null>(null);
  const [usage, setUsage] = useState<UsageOption | null>(null);
  const [referral, setReferral] = useState<ReferralOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);

  /**
   * Check if user is authenticated and if onboarding is already completed
   * 
   * If user is not logged in → redirect to /login
   * If onboardingCompleted === true → redirect to main app
   * Otherwise → show onboarding form
   */
  useEffect(() => {
    async function checkOnboardingStatus() {
      // Wait for auth to finish loading
      if (authLoading) return;

      // If not logged in, redirect to login
      if (!user) {
        router.push("/login");
        return;
      }

      try {
        // Fetch user profile from Firestore
        const userDocRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          const userData = userDoc.data() as UserProfile;
          
          // If onboarding is already completed, redirect to intended page or main app
          if (userData.onboardingCompleted === true) {
            router.push(safeRedirect(searchParams.get("redirect"), "/"));
            return;
          }
        }

        // User exists but onboarding not completed → show form
        setCheckingOnboarding(false);
      } catch (err) {
        console.error("Error checking onboarding status:", err);
        setError("Failed to load onboarding status. Please try again.");
        setCheckingOnboarding(false);
      }
    }

    checkOnboardingStatus();
  }, [user, authLoading, router]);

  /**
   * Handle form submission
   * 
   * Validates required fields, saves to Firestore, sets onboardingCompleted flag,
   * and redirects to main app.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Validate required fields
    if (!role || !useCase || !usage) {
      setError("Please answer all required questions.");
      return;
    }

    if (!user) {
      setError("You must be logged in to complete onboarding.");
      return;
    }

    setSubmitting(true);

    try {
      // Update user profile in Firestore with onboarding responses
      // Merge with existing data to preserve email, plan, etc.
      const userDocRef = doc(db, "users", user.uid);
      // Use stripUndefined to remove undefined values before writing to Firestore.
      // Firestore does not accept undefined field values.
      await setDoc(
        userDocRef,
        stripUndefined({
          onboardingRole: role, // Onboarding role (founder, analyst, etc.) - stored as onboardingRole to avoid conflict with user role
          primaryUseCase: useCase,
          expectedUsage: usage,
          referralSource: referral || undefined, // Will be stripped if empty
          onboardingCompleted: true, // Mark onboarding as complete
          updatedAt: serverTimestamp(),
        }),
        { merge: true } // Merge with existing user document
      );

      posthog.capture("onboarding_completed", {
        role,
        use_case: useCase,
        usage_frequency: usage,
        referral_source: referral || undefined,
      });

      // Redirect to intended destination (from extension/verify flow) or main app
      const postRedirect = safeRedirect(searchParams.get("redirect"), "/");
      router.push(postRedirect);
      router.refresh();
    } catch (err: any) {
      console.error("Error saving onboarding data:", err);
      setError("Failed to save your responses. Please try again.");
      setSubmitting(false);
    }
  };

  // Show loading state while checking auth and onboarding status
  if (authLoading || checkingOnboarding) {
    return (
      <main className="min-h-screen bg-cp-bg text-cp-text flex items-center justify-center">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-cp-muted">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" />
          <p className="text-sm tracking-wide">Loading ConvergePanel…</p>
        </div>
      </main>
    );
  }

  // If not logged in, the useEffect will redirect, but show a message just in case
  if (!user) {
    return null;
  }

  return (
    <main className="min-h-screen bg-cp-bg text-cp-text">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-4 py-10 lg:px-8">
        {/* Back navigation: allows users to skip onboarding and go to main panel */}
        {/* Note: Onboarding is recommended but not strictly mandatory - users can skip and complete it later from Profile */}
        <div className="w-full max-w-xl mb-4">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="inline-flex items-center gap-2 text-sm font-medium text-cp-muted hover:text-cp-accent transition-colors"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-cp-raised ring-1 ring-cp-border">
              {/* Simple left arrow icon */}
              <span className="text-xs">&larr;</span>
            </span>
            <span>Skip for now</span>
          </button>
        </div>

        {/* Centered onboarding card */}
        <div className="w-full max-w-xl">
          <div className="rounded-[14px] bg-cp-surface p-6 shadow-sm border border-cp-border">
            {/* Header */}
            <div className="mb-6">
              <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight text-cp-text">
                Complete your setup
              </h1>
              <p className="mt-1 text-sm text-cp-muted">
                Takes 30 seconds
              </p>
            </div>

            {/* Onboarding form */}
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Question 1: Role / Background */}
              <div>
                <label className="block text-sm font-semibold text-cp-text mb-3">
                  What best describes you? <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {([
                    { value: "founder_operator", label: "Founder / Operator" },
                    { value: "analyst_consultant", label: "Analyst / Consultant" },
                    { value: "student_researcher", label: "Student / Researcher" },
                    { value: "engineer_datascientist", label: "Engineer / Data Scientist" },
                    { value: "other", label: "Other" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setRole(option.value)}
                      className={`rounded-xl border px-3 py-2 text-sm text-left transition ${
                        role === option.value
                          ? "bg-cp-primary-tint border-cp-primary text-cp-accent font-medium"
                          : "border-cp-border bg-cp-surface text-cp-text hover:border-cp-faint hover:bg-cp-raised"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Question 2: Primary Use Case */}
              <div>
                <label className="block text-sm font-semibold text-cp-text mb-3">
                  What will you mostly use ConvergePanel for? <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {([
                    { value: "market_research", label: "Market or product research" },
                    { value: "strategy_decisions", label: "Strategy / decision support" },
                    { value: "academic_research", label: "Academic / literature research" },
                    { value: "compare_models", label: "Comparing different AI model answers" },
                    { value: "other", label: "Other" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setUseCase(option.value)}
                      className={`rounded-xl border px-3 py-2 text-sm text-left transition ${
                        useCase === option.value
                          ? "bg-cp-primary-tint border-cp-primary text-cp-accent font-medium"
                          : "border-cp-border bg-cp-surface text-cp-text hover:border-cp-faint hover:bg-cp-raised"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Question 3: Expected Usage Frequency */}
              <div>
                <label className="block text-sm font-semibold text-cp-text mb-3">
                  How often do you expect to use ConvergePanel? <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {([
                    { value: "few_per_month", label: "A few times a month" },
                    { value: "few_per_week", label: "A few times a week" },
                    { value: "daily", label: "Daily" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setUsage(option.value)}
                      className={`rounded-xl border px-3 py-2 text-sm text-center transition ${
                        usage === option.value
                          ? "bg-cp-primary-tint border-cp-primary text-cp-accent font-medium"
                          : "border-cp-border bg-cp-surface text-cp-text hover:border-cp-faint hover:bg-cp-raised"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Question 4: Referral Source (Optional) */}
              <div>
                <label className="block text-sm font-semibold text-cp-text mb-3">
                  How did you hear about ConvergePanel? <span className="text-cp-faint font-normal">(optional)</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {([
                    { value: "friend", label: "Friend / colleague" },
                    { value: "social", label: "Social media" },
                    { value: "search", label: "Search" },
                    { value: "community", label: "Online community / forum" },
                    { value: "other", label: "Other" },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setReferral(option.value)}
                      className={`rounded-xl border px-3 py-2 text-sm text-left transition ${
                        referral === option.value
                          ? "bg-cp-primary-tint border-cp-primary text-cp-accent font-medium"
                          : "border-cp-border bg-cp-surface text-cp-text hover:border-cp-faint hover:bg-cp-raised"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Error message */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              {/* Submit button */}
              <button
                type="submit"
                disabled={submitting || !role || !useCase || !usage}
                className="mt-2 inline-flex w-full items-center justify-center rounded-[11px] bg-cp-primary px-4 py-2.5 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition hover:bg-cp-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cp-surface disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Saving..." : "Complete setup"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}

