/**
 * Billing / Account Page
 * 
 * Shows current plan, usage, and subscription management options.
 * Supports monthly/annual billing toggle for upgrades.
 * Requires authentication.
 */

"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { getPlanConfig, formatUsageText, PlanId, BillingInterval } from "@/lib/plans";
import posthog from "posthog-js";

/**
 * Progress bar component that uses style tag injection instead of inline styles
 * to be CSP-compliant (no inline style attributes)
 */
function UsageProgressBar({ runsThisMonth, monthlyLimit }: { runsThisMonth: number; monthlyLimit: number }) {
  const progressIdRef = useRef<string>(`progress-${Math.random().toString(36).substr(2, 9)}`);
  const progressPercent = Math.min((runsThisMonth / monthlyLimit) * 100, 100);
  
  useEffect(() => {
    const styleId = `style-${progressIdRef.current}`;
    let styleElement = document.getElementById(styleId) as HTMLStyleElement;
    
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = styleId;
      document.head.appendChild(styleElement);
    }
    
    styleElement.textContent = `
      .${progressIdRef.current} {
        width: ${progressPercent}%;
      }
    `;
    
    return () => {
      const element = document.getElementById(styleId);
      if (element) {
        element.remove();
      }
    };
  }, [progressPercent]);
  
  return (
    <div className="mt-3">
      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
        <div className={`bg-sky-600 h-2 rounded-full transition-all ${progressIdRef.current}`} />
      </div>
    </div>
  );
}

export default function BillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading, authReady } = useAuth();
  const { plan, runsThisMonth, monthlyLimit, billingInterval: currentBillingInterval, refresh } = useUserPlan();
  const [loading, setLoading] = useState<string | null>(null); // Track which button is loading: "lite" | "full" | "portal" | null
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");

  // Read upgraded flag from URL params
  const upgraded = searchParams.get("upgraded") === "true" || searchParams.get("upgraded") === "1";

  // Get plan and interval from URL params (for direct upgrade links)
  // Handle success/cancel messages from Stripe redirect
  useEffect(() => {
    const planParam = searchParams.get("plan");
    const intervalParam = searchParams.get("interval");
    if (planParam === "lite" || planParam === "full") {
      // Will be used when creating checkout
    }
    if (intervalParam === "month" || intervalParam === "year") {
      setBillingInterval(intervalParam);
    }

    const success = searchParams.get("success");
    const canceled = searchParams.get("canceled");
    const sessionId = searchParams.get("session_id");
    
    if (success === "true") {
      // Payment successful - manually sync plan from Stripe
      // This ensures Firestore is updated even if webhook hasn't fired yet
      const syncPlan = async () => {
        try {
          // Ensure user is loaded before attempting sync
          if (!user) {
            console.warn("[billing] User not available for sync, will retry");
            return;
          }
          
          // Get fresh ID token (may have expired)
          let idToken: string;
          try {
            idToken = await user.getIdToken(true); // Force refresh token
          } catch (tokenError: any) {
            console.error("[billing] ❌ Failed to get ID token:", tokenError?.message);
            refresh(); // Just refresh without sync
            return;
          }
          
          if (!idToken) {
            console.warn("[billing] ❌ No ID token available for sync");
            refresh(); // Just refresh without sync
            return;
          }
          
          console.log("[billing] Syncing plan from Stripe after successful checkout...");
          
          // Import authedFetch helper
          const { authedFetch } = await import("@/lib/client/authedFetch");
          
          // Call sync endpoint to manually update Firestore from Stripe
          // Note: authedFetch will get a fresh token automatically, so we don't need to force refresh
          const syncResponse = await authedFetch("/api/billing/sync-plan", {
            user,
            authReady: true, // User just completed checkout, auth is ready
            method: "POST",
            body: JSON.stringify({}),
          });
          
          if (syncResponse.ok) {
            const syncData = await syncResponse.json();
            console.log("[billing] ✅ Plan synced successfully:", syncData);
          } else {
            const errorText = await syncResponse.text();
            let errorData;
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText };
            }
            console.error("[billing] ❌ Sync failed:", {
              status: syncResponse.status,
              statusText: syncResponse.statusText,
              error: errorData,
            });
            // Still refresh to show current state
          }
        } catch (syncErr: any) {
          console.error("[billing] ❌ Error syncing plan:", {
            message: syncErr?.message,
            stack: syncErr?.stack,
          });
          // Non-critical - webhook will eventually update
        }
        
        // Always refresh plan data to show updated plan
        // Wait a bit to ensure Firestore has been updated
        setTimeout(() => {
          refresh();
        }, 1000);
      };
      
      // Wait for user to be available before syncing
      if (user) {
        syncPlan();
      } else {
        // If user not loaded yet, wait a bit then try again
        // Use a longer timeout to ensure auth state has settled
        setTimeout(() => {
          if (user) {
            syncPlan();
          } else {
            console.warn("[billing] User still not available after wait, refreshing without sync");
            refresh();
          }
        }, 1000);
      }
    }
    if (canceled === "true") {
      setError("Checkout was canceled. You can try again anytime.");
    }
  }, [searchParams, refresh]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  // Get plan config
  const planConfig = plan ? getPlanConfig(plan) : null;

  // Handle checkout
  const handleCheckout = async (planId: "lite" | "full", interval: BillingInterval) => {
    if (!authReady || !user) {
      router.push("/login");
      return;
    }

    // Confirmation step: Only show when upgrading from 3-model (lite) to 5-model (full) plan
    if (plan === "lite" && planId === "full") {
      const confirmed = window.confirm(
        "Are you sure you want to upgrade from the 3-model plan to the 5-model plan? This will change your subscription and billing plan."
      );
      if (!confirmed) {
        // User cancelled, do nothing
        return;
      }
    }

    setLoading(planId); // Set loading state for this specific plan
    setError(null);

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");

      // Create checkout session
      const response = await authedFetch("/api/billing/create-checkout-session", {
        user,
        authReady,
        method: "POST",
        body: JSON.stringify({ planId, interval }),
      });

      if (!response.ok) {
        const data = await response.json();
        const errorMessage = data.error || "Failed to create checkout session";

        // Provide user-friendly error messages
        if (errorMessage.includes("Stripe price ID not configured") ||
            errorMessage.includes("Missing environment variable")) {
          throw new Error("Billing is not fully configured yet. Please contact support or try again later.");
        }

        throw new Error(errorMessage);
      }

      const { url } = await response.json();

      // Redirect to Stripe Checkout
      if (url) {
        posthog.capture("checkout_started", { plan: planId, interval });
        window.location.href = url;
      } else {
        throw new Error("Checkout URL not returned");
      }
    } catch (err: any) {
      console.error("[billing] Checkout error:", err);
      setError(err.message || "Failed to start checkout. Please try again.");
      setLoading(null); // Clear loading state on error
    }
  };

  // Handle portal
  const handlePortal = async () => {
    if (!authReady || !user) {
      router.push("/login");
      return;
    }

    setLoading("portal"); // Set loading state for portal
    setError(null);

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");

      // Create portal session
      const response = await authedFetch("/api/billing/create-portal-session", {
        user,
        authReady,
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create portal session");
      }

      const { url } = await response.json();

      // Redirect to Stripe Customer Portal
      if (url) {
        window.location.href = url;
      } else {
        throw new Error("Portal URL not returned");
      }
    } catch (err: any) {
      console.error("[billing] Portal error:", err);
      setError(err.message || "Failed to open billing portal. Please try again.");
      setLoading(null); // Clear loading state on error
    }
  };

  // Show loading state
  if (authLoading || !user) {
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-slate-600">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          <p className="text-sm tracking-wide">Loading…</p>
        </div>
      </main>
    );
  }

  const handleBack = () => {
    router.push("/login");
  };

  return (
    <main className="min-h-screen bg-slate-50 py-12">
      <div className="max-w-4xl mx-auto px-4">
        {/* Back button */}
        <div className="mb-6">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center text-sm text-slate-600 hover:text-slate-900 transition-colors"
          >
            <span className="mr-1">←</span>
            <span>Back to login / signup</span>
          </button>
        </div>

        <h1 className="text-3xl font-bold text-slate-900 mb-8">Billing & Account</h1>

        {/* Success Message with CTA */}
        {(searchParams.get("success") === "true" || searchParams.get("upgraded") === "true") && plan && plan !== "free" && (
          <div className="mb-6 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex-1">
              <p className="text-sm text-emerald-800 font-medium mb-1">
                ✅ {upgraded ? "Upgrade successful!" : "Payment successful!"} Your plan has been {upgraded ? "upgraded" : "updated"}. You now have access to more runs and features.
              </p>
              <p className="text-xs text-emerald-700">
                You&apos;re all set. Head back to your dashboard to start running multi-model panels.
              </p>
            </div>
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 transition-colors whitespace-nowrap"
            >
              Go to Dashboard
            </Link>
          </div>
        )}
        
        {/* Success Message (fallback for free users or when plan not loaded yet) */}
        {(searchParams.get("success") === "true" || searchParams.get("upgraded") === "true") && (!plan || plan === "free") && (
          <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 p-4">
            <p className="text-sm text-emerald-800 font-medium">
              ✅ Payment successful! Your plan has been upgraded. You now have access to more runs and features.
            </p>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Current Plan Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 mb-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-4">Current Plan</h2>

          {planConfig ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-2xl font-bold text-slate-900">{planConfig.name}</p>
                  {planConfig.monthlyPriceUsd > 0 && (
                    <p className="text-lg text-slate-600">
                      {currentBillingInterval === "year" && planConfig.yearlyPriceUsd ? (
                        <>
                          ${planConfig.yearlyPriceUsd.toFixed(2)} / year
                          <span className="text-sm text-slate-500 ml-2">
                            (${(planConfig.yearlyPriceUsd / 12).toFixed(2)} / month)
                          </span>
                        </>
                      ) : (
                        <>
                          ${planConfig.monthlyPriceUsd.toFixed(2)} / month
                          {planConfig.yearlyPriceUsd && (
                            <span className="text-sm text-slate-500 ml-2">
                              (or ${planConfig.yearlyPriceUsd.toFixed(2)} / year)
                            </span>
                          )}
                        </>
                      )}
                    </p>
                  )}
                </div>
                {plan === "free" && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                    Free
                  </span>
                )}
              </div>

              {/* Usage Display */}
              <div className="mt-6 pt-6 border-t border-slate-200">
                <p className="text-sm font-medium text-slate-700 mb-2">Usage this month</p>
                <p className="text-lg text-slate-900">
                  {plan ? formatUsageText(plan, runsThisMonth) : `0 / ${monthlyLimit ?? 8} runs used this month`}
                </p>
                {monthlyLimit && (
                  <UsageProgressBar 
                    runsThisMonth={runsThisMonth} 
                    monthlyLimit={monthlyLimit} 
                  />
                )}
              </div>
            </>
          ) : (
            <p className="text-slate-600">Loading plan information…</p>
          )}
        </div>

        {/* Upgrade / Manage Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-4">
            {plan === "free" ? "Upgrade Plan" : "Manage Subscription"}
          </h2>

          {plan === "free" ? (
            <div className="space-y-4">
              <p className="text-slate-600 mb-6">
                Upgrade to unlock more panel runs and additional features.
              </p>

              {/* Monthly/Annual Toggle */}
              <div className="flex justify-center mb-6">
                <div className="inline-flex rounded-lg bg-slate-100 p-1">
                  <button
                    onClick={() => setBillingInterval("month")}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      billingInterval === "month"
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    onClick={() => setBillingInterval("year")}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      billingInterval === "year"
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Annual
                    <span className="ml-1 text-xs text-sky-600">(Save 20%)</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 3-Model Plan */}
                {(() => {
                  const liteConfig = getPlanConfig("lite");
                  return (
                    <div className="border border-slate-200 rounded-xl p-6">
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        {liteConfig.name}
                      </h3>
                      <div className="mb-4">
                        {billingInterval === "month" ? (
                          <>
                            <p className="text-2xl font-bold text-slate-900">${liteConfig.monthlyPriceUsd.toFixed(2)}</p>
                            <p className="text-sm text-slate-600">/ month</p>
                          </>
                        ) : (
                          <>
                            <p className="text-2xl font-bold text-slate-900">${liteConfig.yearlyPriceUsd!.toFixed(2)}</p>
                            <p className="text-sm text-slate-600">/ year</p>
                            <p className="text-xs text-slate-500 mt-1">${(liteConfig.yearlyPriceUsd! / 12).toFixed(2)} / month</p>
                          </>
                        )}
                      </div>
                      <button
                        onClick={() => handleCheckout("lite", billingInterval)}
                        disabled={loading !== null}
                        className="w-full rounded-xl bg-slate-900 px-6 py-3 text-base font-semibold text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loading === "lite" ? "Processing…" : "Upgrade to 3-Model Plan"}
                      </button>
                    </div>
                  );
                })()}

                {/* Full Plan */}
                {(() => {
                  const fullConfig = getPlanConfig("full");
                  return (
                    <div className="border-2 border-sky-200 bg-sky-50 rounded-xl p-6 relative">
                      <span className="absolute -top-3 left-1/2 transform -translate-x-1/2 inline-flex items-center rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white">
                        Most popular
                      </span>
                      <h3 className="text-lg font-semibold text-slate-900 mb-2">
                        {fullConfig.name}
                      </h3>
                      <div className="mb-4">
                        {billingInterval === "month" ? (
                          <>
                            <p className="text-2xl font-bold text-slate-900">${fullConfig.monthlyPriceUsd.toFixed(2)}</p>
                            <p className="text-sm text-slate-600">/ month</p>
                          </>
                        ) : (
                          <>
                            <p className="text-2xl font-bold text-slate-900">${fullConfig.yearlyPriceUsd!.toFixed(2)}</p>
                            <p className="text-sm text-slate-600">/ year</p>
                            <p className="text-xs text-slate-500 mt-1">${(fullConfig.yearlyPriceUsd! / 12).toFixed(2)} / month</p>
                          </>
                        )}
                      </div>
                      <button
                        onClick={() => handleCheckout("full", billingInterval)}
                        disabled={loading !== null}
                        className="w-full rounded-xl bg-sky-600 px-6 py-3 text-base font-semibold text-white hover:bg-sky-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loading === "full" ? "Processing…" : "Get Full Panel"}
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          ) : plan === "lite" ? (
            // User is on 3-model plan - show upgrade options to 5-model
            <div className="space-y-6">
              <div>
                <p className="text-slate-600 mb-4">
                  Upgrade to Full Panel to unlock all 5 models and 150 runs per month.
                </p>
                <p className="text-sm text-slate-500 mb-6">
                  Your current plan: {getPlanConfig("lite").name} ({currentBillingInterval === "year" ? "Yearly" : "Monthly"})
                </p>
              </div>

              {/* Monthly/Annual Toggle for upgrade */}
              <div className="flex justify-center mb-6">
                <div className="inline-flex rounded-lg bg-slate-100 p-1">
                  <button
                    onClick={() => setBillingInterval("month")}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      billingInterval === "month"
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    onClick={() => setBillingInterval("year")}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      billingInterval === "year"
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Annual
                    <span className="ml-1 text-xs text-sky-600">(Save 20%)</span>
                  </button>
                </div>
              </div>

              {/* Upgrade to Full Panel options */}
              {(() => {
                const fullConfig = getPlanConfig("full");
                return (
                  <div className="border-2 border-sky-200 bg-sky-50 rounded-xl p-6 relative">
                    <span className="absolute -top-3 left-1/2 transform -translate-x-1/2 inline-flex items-center rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white">
                      Upgrade to Full Panel
                    </span>
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">
                      {fullConfig.name}
                    </h3>
                    <div className="mb-4">
                      {billingInterval === "month" ? (
                        <>
                          <p className="text-2xl font-bold text-slate-900">${fullConfig.monthlyPriceUsd.toFixed(2)}</p>
                          <p className="text-sm text-slate-600">/ month</p>
                        </>
                      ) : (
                        <>
                          <p className="text-2xl font-bold text-slate-900">${fullConfig.yearlyPriceUsd!.toFixed(2)}</p>
                          <p className="text-sm text-slate-600">/ year</p>
                          <p className="text-xs text-slate-500 mt-1">${(fullConfig.yearlyPriceUsd! / 12).toFixed(2)} / month</p>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => handleCheckout("full", billingInterval)}
                      disabled={loading !== null}
                      className="w-full rounded-xl bg-sky-600 px-6 py-3 text-base font-semibold text-white hover:bg-sky-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {loading === "full" ? "Processing…" : `Upgrade to Full Panel ${billingInterval === "year" ? "(Yearly)" : "(Monthly)"}`}
                    </button>
                  </div>
                );
              })()}

              {/* Manage Billing button */}
              <div className="pt-4 border-t border-slate-200">
                <button
                  onClick={handlePortal}
                  disabled={loading !== null}
                  className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-6 py-3 text-base font-semibold text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading === "portal" ? "Loading…" : "Manage Billing"}
                </button>
              </div>
            </div>
          ) : (
            // User is on full plan - show manage subscription only
            <div className="space-y-4">
              <p className="text-slate-600 mb-6">
                Manage your subscription, update payment methods, and view invoices.
              </p>

              <button
                onClick={handlePortal}
                disabled={loading !== null}
                className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-6 py-3 text-base font-semibold text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading === "portal" ? "Loading…" : "Manage Billing"}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

