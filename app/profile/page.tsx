"use client";

/**
 * Profile Page: View and update user details stored in Firestore (UserProfile)
 * 
 * This page allows authenticated users to:
 * - View their current profile information (email, name, phone, address, onboarding responses)
 * - Update/edit their profile information
 * - Save changes back to Firestore
 * 
 * Flow:
 * 1. Check authentication → redirect to /login if not logged in
 * 2. Load current user profile from Firestore users/{uid}
 * 3. Display form pre-filled with existing values
 * 4. On submit → validate and save updates to Firestore
 * 
 * Edge case handling:
 * - If user doc doesn't exist, create a basic doc with email from Firebase Auth
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { UserProfile } from "@/lib/types";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import Link from "next/link";
import { useUserPlan } from "@/hooks/useUserPlan";
import EmailVerificationNotice from "@/components/EmailVerificationNotice";
import { formatPlanNameWithInterval, getPlanConfig } from "@/lib/plans";
import {
  GovernancePlanTeaser,
  GovernanceSettingsSection,
} from "@/components/profile/GovernanceSettingsSection";

export default function ProfilePage() {
  const { user, loading: authLoading, authReady, isAdmin } = useAuth();
  const router = useRouter();
  const {
    plan,
    runsThisMonth,
    monthlyLimit,
    billingInterval,
    loading: planLoading,
    refresh: refreshUsage,
  } = useUserPlan();
  
  // Form state - initialized from Firestore profile
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState({
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
  });
  const [onboardingRole, setOnboardingRole] = useState<UserProfile["onboardingRole"]>(undefined);
  const [primaryUseCase, setPrimaryUseCase] = useState<UserProfile["primaryUseCase"]>(undefined);
  const [expectedUsage, setExpectedUsage] = useState<UserProfile["expectedUsage"]>(undefined);
  const [referralSource, setReferralSource] = useState<UserProfile["referralSource"]>(undefined);
  
  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  
  // Cancel subscription dialog state
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  /**
   * Load current profile data for the authenticated user
   * 
   * Fetches the user's Firestore document and populates form fields.
   * If the document doesn't exist, creates a basic one with email.
   */
  useEffect(() => {
    async function loadProfile() {
      // Wait for auth to finish loading
      if (authLoading) return;

      // If not logged in, redirect to login
      if (!user) {
        router.push("/login");
        return;
      }

      try {
        setLoading(true);
        const userDocRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          // User document exists - load data into form
          const userData = userDoc.data() as UserProfile;
          
          setProfileEmail(userData.email || user.email || "");
          setName(userData.name || "");
          setPhone(userData.phone || "");
          setAddress({
            line1: userData.address?.line1 || "",
            line2: userData.address?.line2 || "",
            city: userData.address?.city || "",
            state: userData.address?.state || "",
            postalCode: userData.address?.postalCode || "",
            country: userData.address?.country || "",
          });
          setOnboardingRole(userData.onboardingRole || undefined);
          setPrimaryUseCase(userData.primaryUseCase || undefined);
          setExpectedUsage(userData.expectedUsage || undefined);
          setReferralSource(userData.referralSource || undefined);
        } else {
          // User doc doesn't exist - create a basic one with email
          // This handles the edge case where a user exists in Firebase Auth
          // but doesn't have a Firestore document yet
          const basicProfile = {
            email: user.email || "",
            uid: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          
          await setDoc(userDocRef, basicProfile);
          
          // Load the newly created doc
          setProfileEmail(user.email || "");
          setName("");
          setPhone("");
        }
      } catch (err: any) {
        console.error("Error loading profile:", err);
        setError("Failed to load profile. Please try again.");
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [user, authLoading, router]);

  /**
   * Handle form submission
   * 
   * Save updated profile fields back to Firestore.
   * Uses updateDoc to merge changes with existing data.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaveSuccess(false);
    setSaving(true);

    if (!user) {
      setError("You must be logged in to update your profile.");
      setSaving(false);
      return;
    }

    try {
      // Build update object with only the fields that can be edited
      // This preserves other fields like plan, runsThisMonth, etc.
      // Note: Using 'any' here because serverTimestamp() returns FieldValue, not Timestamp | string
      const updatedProfile: any = {
        name: name.trim() || undefined, // Convert empty string to undefined
        phone: phone.trim() || undefined,
        address: {
          line1: address.line1.trim() || undefined,
          line2: address.line2.trim() || undefined,
          city: address.city.trim() || undefined,
          state: address.state.trim() || undefined,
          postalCode: address.postalCode.trim() || undefined,
          country: address.country.trim() || undefined,
        },
        onboardingRole: onboardingRole || undefined,
        primaryUseCase: primaryUseCase || undefined,
        expectedUsage: expectedUsage || undefined,
        referralSource: referralSource || undefined,
        updatedAt: serverTimestamp(),
      };

      // Remove undefined values from address object
      // This prevents storing empty strings in Firestore
      if (updatedProfile.address) {
        Object.keys(updatedProfile.address).forEach((key) => {
          if (updatedProfile.address![key as keyof typeof updatedProfile.address] === undefined) {
            delete updatedProfile.address![key as keyof typeof updatedProfile.address];
          }
        });
        
        // If address object is empty, set to undefined
        if (Object.keys(updatedProfile.address).length === 0) {
          updatedProfile.address = undefined;
        }
      }

      // Update Firestore document (merge with existing data)
      const userDocRef = doc(db, "users", user.uid);
      await updateDoc(userDocRef, updatedProfile);

      // Show success message
      setSaveSuccess(true);
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        setSaveSuccess(false);
      }, 3000);
    } catch (err: any) {
      console.error("Error saving profile:", err);
      setError("Failed to save profile. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      router.replace("/login?signedOut=1");
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  /**
   * Handle cancel subscription - opens Stripe Customer Portal
   * Shows confirmation dialog first, then redirects to Stripe portal
   * Handles users without Stripe customer IDs gracefully
   */
  const handleCancelSubscription = async () => {
    if (!user) {
      router.push("/login");
      return;
    }

    setCancelLoading(true);
    setCancelError(null);

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");

      // Call existing portal session API
      const response = await authedFetch("/api/billing/create-portal-session", {
        user,
        authReady,
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        // Handle users without Stripe customer IDs
        if (response.status === 409 && data.error === "NO_STRIPE_CUSTOMER") {
          setCancelError("NO_STRIPE_CUSTOMER");
        } else {
          throw new Error(data.error || "Failed to create portal session");
        }
        setCancelLoading(false);
        return;
      }

      const { url } = await response.json();

      // Redirect to Stripe Customer Portal
      if (url) {
        window.location.assign(url);
      } else {
        throw new Error("Portal URL not returned");
      }
    } catch (err: any) {
      console.error("[profile] Cancel subscription error:", err);
      setCancelError(err.message || "Failed to open billing portal. Please try again.");
      setCancelLoading(false);
    }
  };

  // Show loading state while checking auth or loading profile
  if (authLoading || loading) {
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
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
        {/* Back navigation: takes the user from the Profile page back to the main panel screen */}
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-cp-muted hover:text-cp-accent transition-colors"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-cp-raised ring-1 ring-cp-border">
            {/* Simple left arrow icon */}
            <span className="text-xs">&larr;</span>
          </span>
          <span>Back to panel</span>
        </button>

        {/* Phase P0.2-VEMAIL-C1 — verification state + resend. Renders nothing
            for a verified identity, and never sends automatically. */}
        <div className="mb-4">
          <EmailVerificationNotice />
        </div>

        {/* Profile card */}
        <div className="rounded-[14px] bg-cp-surface p-6 shadow-sm border border-cp-border">
          {/* Header */}
          <h1 className="text-2xl font-semibold tracking-tight text-cp-text">
            Profile
          </h1>
          <p className="mt-1 text-sm text-cp-muted">
            Update your personal details and how you use ConvergePanel.
          </p>

          {/* Plan & Usage Section */}
          <div className="mt-6 mb-6 rounded-xl border border-cp-border bg-cp-raised p-5">
            <h2 className="text-sm font-medium uppercase tracking-wide text-cp-faint mb-3">
              Plan & Usage
            </h2>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex-1">
                {!planLoading && plan ? (
                  <>
                    <p className="text-lg font-semibold text-cp-text">
                      {formatPlanNameWithInterval(plan, billingInterval)}
                    </p>
                    {monthlyLimit !== null && (
                      <p className="mt-1 text-sm text-cp-muted">
                        {getPlanConfig(plan).maxModelsPerRun} models · {runsThisMonth} / {monthlyLimit} runs this month
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-cp-faint">Loading plan information...</p>
                )}
              </div>
              {/* Upgrade link - show when user can upgrade */}
              {!planLoading && plan && plan !== "full" && (
                <div className="sm:ml-4 flex-shrink-0">
                  <Link
                    href="/billing"
                    className="inline-flex items-center justify-center rounded-[11px] bg-cp-primary px-4 py-2 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] hover:bg-cp-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cp-accent transition-colors whitespace-nowrap"
                  >
                    {plan === "free" ? "Upgrade plan" : "Upgrade to Full Panel — 5 Models"}
                  </Link>
                </div>
              )}
            </div>

            {/* Cancel subscription link - show for all users, greyed out for free plan */}
            {!planLoading && (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => plan !== "free" && setShowCancelDialog(true)}
                  disabled={plan === "free"}
                  className={`text-xs underline transition-colors ${
                    plan === "free"
                      ? "text-cp-faint cursor-not-allowed no-underline"
                      : "text-cp-faint hover:text-cp-muted"
                  }`}
                  aria-label="Cancel subscription (opens Stripe portal)"
                >
                  Cancel subscription
                </button>
              </div>
            )}
          </div>

          {!planLoading && plan === "full" && user && (
            <GovernanceSettingsSection onUsageRefresh={() => refreshUsage()} />
          )}
          {!planLoading && plan && plan !== "full" && <GovernancePlanTeaser />}
          
          {/* Cancel Subscription Confirmation Dialog */}
          {showCancelDialog && (
            <div 
              className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" 
              onClick={() => !cancelLoading && setShowCancelDialog(false)}
              role="dialog"
              aria-modal="true"
              aria-labelledby="cancel-dialog-title"
              aria-describedby="cancel-dialog-description"
            >
              <div className="bg-cp-surface rounded-lg p-6 max-w-md w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-lg font-semibold text-cp-text mb-4" id="cancel-dialog-title">
                  Cancel subscription
                </h2>
                <div className="space-y-4">
                  <p className="text-sm text-cp-muted" id="cancel-dialog-description">
                    You&apos;ll be redirected to Stripe&apos;s secure portal to manage or cancel your subscription. If you don&apos;t have an active subscription, Stripe will show your current billing status.
                  </p>

                  {cancelError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <p className="text-sm text-red-800 mb-2">
                        {cancelError === "NO_STRIPE_CUSTOMER"
                          ? "No active subscription found for this account. You can manage plans on the Billing page."
                          : cancelError}
                      </p>
                      {cancelError === "NO_STRIPE_CUSTOMER" && (
                        <Link
                          href="/billing"
                          className="text-sm font-medium text-cp-accent underline"
                          onClick={() => setShowCancelDialog(false)}
                        >
                          View plans
                        </Link>
                      )}
                    </div>
                  )}

                  <div className="flex gap-3 justify-end pt-4">
                    <button
                      type="button"
                      onClick={() => {
                        setShowCancelDialog(false);
                        setCancelError(null);
                      }}
                      disabled={cancelLoading}
                      className="px-4 py-2 text-sm font-medium text-cp-text bg-cp-surface border border-cp-border rounded-lg hover:bg-cp-raised focus:outline-none focus:ring-2 focus:ring-cp-accent focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Keep subscription
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelSubscription}
                      disabled={cancelLoading}
                      className="px-4 py-2 text-sm font-medium text-white bg-cp-primary rounded-lg hover:bg-cp-accent focus:outline-none focus:ring-2 focus:ring-cp-accent focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
                    >
                      {cancelLoading ? (
                        <>
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          Opening...
                        </>
                      ) : (
                        "Continue"
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Profile form */}
          <form onSubmit={handleSubmit} className="mt-6 space-y-6">
            {/* Account Info Section */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-cp-text border-b border-cp-border-soft pb-2">
                Account info
              </h2>

              {/* Email (read-only) */}
              <div>
                <label
                  htmlFor="email"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={profileEmail}
                  disabled
                  readOnly
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-faint cursor-not-allowed"
                />
              </div>

              {/* Name (editable) */}
              <div>
                <label
                  htmlFor="name"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="Your full name"
                />
              </div>

              {/* Phone (optional) */}
              <div>
                <label
                  htmlFor="phone"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Phone <span className="text-cp-faint font-normal">(optional)</span>
                </label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="+1 (555) 123-4567"
                />
              </div>
            </div>

            {/* Address Section */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-cp-text border-b border-cp-border-soft pb-2">
                Address
              </h2>

              {/* Address Line 1 */}
              <div>
                <label
                  htmlFor="address-line1"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Address Line 1
                </label>
                <input
                  id="address-line1"
                  name="address-line1"
                  type="text"
                  autoComplete="street-address"
                  value={address.line1}
                  onChange={(e) => setAddress({ ...address, line1: e.target.value })}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="Street address"
                />
              </div>

              {/* Address Line 2 (optional) */}
              <div>
                <label
                  htmlFor="address-line2"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Address Line 2 <span className="text-cp-faint font-normal">(optional)</span>
                </label>
                <input
                  id="address-line2"
                  name="address-line2"
                  type="text"
                  autoComplete="address-line2"
                  value={address.line2}
                  onChange={(e) => setAddress({ ...address, line2: e.target.value })}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                  placeholder="Apartment, suite, etc."
                />
              </div>

              {/* City and State - side by side on larger screens */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="address-city"
                    className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                  >
                    City
                  </label>
                  <input
                    id="address-city"
                    name="address-city"
                    type="text"
                    autoComplete="address-level2"
                    value={address.city}
                    onChange={(e) => setAddress({ ...address, city: e.target.value })}
                    className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                    placeholder="City"
                  />
                </div>

                <div>
                  <label
                    htmlFor="address-state"
                    className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                  >
                    State / Region
                  </label>
                  <input
                    id="address-state"
                    name="address-state"
                    type="text"
                    autoComplete="address-level1"
                    value={address.state}
                    onChange={(e) => setAddress({ ...address, state: e.target.value })}
                    className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                    placeholder="State or region"
                  />
                </div>
              </div>

              {/* Postal Code and Country - side by side on larger screens */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="address-postal"
                    className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                  >
                    Postal Code
                  </label>
                  <input
                    id="address-postal"
                    name="address-postal"
                    type="text"
                    autoComplete="postal-code"
                    value={address.postalCode}
                    onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                    className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                    placeholder="Postal code"
                  />
                </div>

                <div>
                  <label
                    htmlFor="address-country"
                    className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                  >
                    Country
                  </label>
                  <input
                    id="address-country"
                    name="address-country"
                    type="text"
                    autoComplete="country-name"
                    value={address.country}
                    onChange={(e) => setAddress({ ...address, country: e.target.value })}
                    className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm outline-none placeholder:text-cp-faint focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                    placeholder="Country"
                  />
                </div>
              </div>
            </div>

            {/* Research Preferences Section */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-cp-text border-b border-cp-border-soft pb-2">
                How you use ConvergePanel
              </h2>

              {/* Role */}
              <div>
                <label
                  htmlFor="onboardingRole"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Role
                </label>
                <select
                  id="onboardingRole"
                  name="onboardingRole"
                  value={onboardingRole || ""}
                  onChange={(e) => setOnboardingRole(e.target.value as UserProfile["onboardingRole"] || undefined)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                >
                  <option value="">Select your role...</option>
                  <option value="founder_operator">Founder / Operator</option>
                  <option value="analyst_consultant">Analyst / Consultant</option>
                  <option value="student_researcher">Student / Researcher</option>
                  <option value="engineer_datascientist">Engineer / Data Scientist</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {/* Primary Use Case */}
              <div>
                <label
                  htmlFor="primaryUseCase"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Primary Use Case
                </label>
                <select
                  id="primaryUseCase"
                  name="primaryUseCase"
                  value={primaryUseCase || ""}
                  onChange={(e) => setPrimaryUseCase(e.target.value as UserProfile["primaryUseCase"] || undefined)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                >
                  <option value="">Select your primary use case...</option>
                  <option value="market_research">Market or product research</option>
                  <option value="strategy_decisions">Strategy / decision support</option>
                  <option value="academic_research">Academic / literature research</option>
                  <option value="compare_models">Comparing different AI model answers</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {/* Expected Usage */}
              <div>
                <label
                  htmlFor="expectedUsage"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  Expected Usage
                </label>
                <select
                  id="expectedUsage"
                  name="expectedUsage"
                  value={expectedUsage || ""}
                  onChange={(e) => setExpectedUsage(e.target.value as UserProfile["expectedUsage"] || undefined)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                >
                  <option value="">Select expected usage...</option>
                  <option value="few_per_month">A few times a month</option>
                  <option value="few_per_week">A few times a week</option>
                  <option value="daily">Daily</option>
                </select>
              </div>

              {/* Referral Source (optional) */}
              <div>
                <label
                  htmlFor="referralSource"
                  className="block text-xs font-medium uppercase tracking-wide text-cp-faint"
                >
                  How did you hear about ConvergePanel? <span className="text-cp-faint font-normal">(optional)</span>
                </label>
                <select
                  id="referralSource"
                  name="referralSource"
                  value={referralSource || ""}
                  onChange={(e) => setReferralSource(e.target.value as UserProfile["referralSource"] || undefined)}
                  className="mt-1 block w-full rounded-xl border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-text shadow-sm focus:border-cp-accent focus:bg-cp-surface focus:ring-2 focus:ring-cp-primary-soft"
                >
                  <option value="">Select referral source...</option>
                  <option value="friend">Friend / colleague</option>
                  <option value="social">Social media</option>
                  <option value="search">Search</option>
                  <option value="community">Online community / forum</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            {/* Success message */}
            {saveSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <p className="text-sm text-emerald-600">Profile updated successfully.</p>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            {/* Save button */}
            <button
              type="submit"
              disabled={saving}
              className="mt-6 inline-flex items-center justify-center rounded-[11px] bg-cp-primary px-4 py-2.5 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition hover:bg-cp-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cp-surface disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </form>

          {/* Additional actions */}
          <div className="mt-8 pt-6 border-t border-cp-border">
            {isAdmin && (
              <div className="mb-4">
                <Link
                  href="/admin"
                  className="inline-flex items-center justify-center rounded-[10px] border border-cp-border bg-cp-surface px-4 py-2 text-sm font-medium text-cp-text shadow-sm hover:bg-cp-raised transition-colors"
                >
                  Admin Dashboard
                </Link>
              </div>
            )}

            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
