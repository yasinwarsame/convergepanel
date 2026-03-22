/**
 * useUserPlan Hook (Temporary MVP Version)
 * 
 * TODO: Re-enable real usage tracking after MVP validation.
 * 
 * This hook is intentionally defensive and never throws.
 * If usage cannot be fetched, it assumes a free plan so the UI stays usable.
 * This allows the core product (multi-LLM panel) to be tested without worrying about quotas or auth.
 */

"use client";

import { useState, useEffect, useLayoutEffect, useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import { UserPlan } from "@/lib/types";

/**
 * Firestore User Schema (for reference):
 * - plan: "free" | "lite" | "full"
 * - runsThisMonth: number (panel runs used this month)
 * - usageMonth: string (YYYY-MM format, e.g., "2025-01")
 * - billingCycleStart: string (ISO timestamp)
 */

interface UserUsageData {
  ok: boolean;
  plan: UserPlan;
  runsThisMonth: number;
  usageMonth: string;
  monthlyLimit: number | null;
  billingInterval: "month" | "year" | null;
}

interface UseUserPlanReturn {
  plan: UserPlan | null;
  runsThisMonth: number;
  monthlyLimit: number | null;
  billingInterval: "month" | "year" | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// Default usage object used when /api/user/usage fails or returns an error.
// This keeps the app usable even if the backend usage API has issues.
const DEFAULT_USAGE: UserUsageData = {
  ok: true,
  plan: "free" as const,
  runsThisMonth: 0,
  usageMonth: new Date().toISOString().slice(0, 7),
  monthlyLimit: 8, // FREE_MONTHLY_LIMIT
  billingInterval: null,
};

/**
 * Fetch user usage from API
 * 
 * This function is intentionally defensive and never throws.
 * On any error or non-OK response, it returns safe default free plan data.
 * This ensures the UI always has data to display, even if the backend fails.
 */
/**
 * Fetch user usage from API
 * 
 * This function is intentionally defensive and never throws.
 * On any error or non-OK response, it returns safe default free plan data.
 * This ensures the UI always has data to display, even if the backend fails.
 * 
 * IMPORTANT: This function never throws - it always returns DEFAULT_USAGE on error
 * to prevent infinite loading states.
 */
async function fetchUsage(user: any): Promise<UserUsageData> {
  try {
    // Import authedFetch helper
    const { authedFetch } = await import("@/lib/client/authedFetch");
    
    // Call the usage API with authenticated headers
    // authReady check happens at the hook level, so user is guaranteed to be available here
    const apiUrl = "/api/user/usage";
    let res = await authedFetch(apiUrl, {
      user,
      authReady: true, // authReady check already done at hook level
      method: "GET",
      cache: "no-store",
    });

    // Retry with force token refresh if we get 401 (stale token edge case)
    if (res.status === 401 && user) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[useUserPlan] Got 401, retrying with force token refresh");
      }
      res = await authedFetch(apiUrl, {
        user,
        authReady: true,
        forceTokenRefresh: true,
        method: "GET",
        cache: "no-store",
      });
    }

    // If the response is still not OK after retry, log it and return defaults.
    if (!res.ok) {
      // Only log non-401 errors (401s are expected during auth transitions, already handled)
      if (res.status !== 401) {
        console.error(
          "[useUserPlan] Non-OK response from /api/user/usage:",
          res.status,
          res.statusText
        );
      }
      return DEFAULT_USAGE;
    }

    // Try to parse JSON. If parsing fails, log and return defaults.
    const data = await res.json().catch((err) => {
      console.error(
        "[useUserPlan] Failed to parse JSON from /api/user/usage:",
        err
      );
      return null;
    });

    // If the payload is missing or indicates an error, fall back to defaults.
    if (!data || data.ok === false) {
      console.error("[useUserPlan] Error in usage payload:", data);
      return DEFAULT_USAGE;
    }

    // If everything looks good, return the actual usage data.
    // Ensure it has all required fields, falling back to defaults if missing.
    return {
      ok: data.ok ?? true,
      plan: data.plan || "free",
      runsThisMonth: data.runsThisMonth ?? 0,
      usageMonth: data.usageMonth || DEFAULT_USAGE.usageMonth,
      monthlyLimit: data.monthlyLimit ?? 8,
      billingInterval: data.billingInterval || null,
    };
  } catch (err) {
    // Any network or unexpected error leads to default usage, no throwing.
    // This prevents the hook from getting stuck in a loading state.
    console.error("[useUserPlan] Error fetching usage data:", err);
    return DEFAULT_USAGE;
  }
}

export function useUserPlan(): UseUserPlanReturn {
  const { user, loading: authLoading, authReady } = useAuth();
  const [usageData, setUsageData] = useState<UserUsageData>(DEFAULT_USAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Refresh usage data
   * 
   * Public function that components can call to manually refresh
   * usage data (e.g., after a panel run).
   * This function never throws - it always sets safe defaults on error.
   */
  const refresh = useCallback(async () => {
    // Wait for auth to be ready
    if (authLoading) {
      return;
    }

    // If no user, set default usage
    if (!user) {
      setUsageData(DEFAULT_USAGE);
      setLoading(false);
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      
      // Fetch usage with auth - this function never throws, always returns safe defaults
      const data = await fetchUsage(user);
      setUsageData(data);
      if (process.env.NODE_ENV !== "production") {
        console.log("[useUserPlan] Refreshed usage:", { plan: data.plan, runsThisMonth: data.runsThisMonth });
      }
    } catch (err: any) {
      // This should never happen since fetchUsage never throws, but just in case
      console.error("[useUserPlan] Unexpected error in refresh:", err);
      setUsageData(DEFAULT_USAGE);
      setError("Failed to refresh usage data");
    } finally {
      setLoading(false);
    }
  }, [user, authReady]);

  /**
   * When a user becomes available, usage still reflects DEFAULT_USAGE (free) until /api/user/usage
   * returns. Without flipping loading to true before paint, plan-dependent UI (e.g. "Upgrade plan")
   * can flash for paid users for one frame. useLayoutEffect runs before browser paint.
   */
  useLayoutEffect(() => {
    if (!authReady || !user) {
      return;
    }
    setLoading(true);
  }, [authReady, user?.uid]);

  // Fetch usage when component mounts or user changes
  // IMPORTANT: Wait for auth to be ready before fetching
  // IMPORTANT: Always set loading to false eventually, even on error, to prevent infinite loading
  useEffect(() => {
    async function loadUsage() {
      // Wait for auth to be ready (first onAuthStateChanged callback has executed)
      if (!authReady) {
        return;
      }
      
      // If no user, set default usage
      if (!user) {
        setUsageData(DEFAULT_USAGE);
        setLoading(false);
        return;
      }
      
      try {
        setLoading(true);
        setError(null);
        
        // Fetch usage with auth - this function never throws, always returns safe defaults
        const data = await fetchUsage(user);
        setUsageData(data);
        if (process.env.NODE_ENV !== "production") {
          console.log("[useUserPlan] Loaded usage:", { plan: data.plan, runsThisMonth: data.runsThisMonth });
        }
      } catch (err: any) {
        // This should never happen since fetchUsage never throws, but just in case
        console.error("[useUserPlan] Unexpected error in loadUsage:", err);
        setUsageData(DEFAULT_USAGE);
        setError("Failed to load usage data");
      } finally {
        // CRITICAL: Always set loading to false to prevent infinite loading
        setLoading(false);
      }
    }
    
    loadUsage();
  }, [authLoading, authReady, user]);

  return {
    plan: usageData.plan,
    runsThisMonth: usageData.runsThisMonth,
    monthlyLimit: usageData.monthlyLimit,
    billingInterval: usageData.billingInterval,
    loading: authLoading || loading,
    error,
    refresh,
  };
}
