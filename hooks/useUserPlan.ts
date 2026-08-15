"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/AuthProvider";
import { UserPlan } from "@/lib/types";

// ─── Plan data cache ──────────────────────────────────────────────────────────
// Memory layer survives client-side navigation; sessionStorage survives page reloads.
const planMemCache = new Map<string, UserUsageData>();

function readPlanCache(uid: string): UserUsageData | null {
  if (planMemCache.has(uid)) return planMemCache.get(uid)!;
  try {
    const raw = typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(`cp_plan_${uid}`)
      : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserUsageData;
    if (typeof parsed?.plan === "string") {
      planMemCache.set(uid, parsed);
      return parsed;
    }
  } catch {}
  return null;
}

function writePlanCache(uid: string, data: UserUsageData): void {
  planMemCache.set(uid, data);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(`cp_plan_${uid}`, JSON.stringify(data));
    }
  } catch {}
}

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
  /** Paid-plan video verification quota (0 on free). */
  videoLimit: number;
  videoRunsThisMonth: number;
  billingInterval: "month" | "year" | null;
  teamId?: string | null;
  teamRole?: "owner" | "admin" | "member" | null;
  teamGovernanceEligible?: boolean;
  /** Firestore role + admin-email mapping; default "member". */
  role: string;
  /** Full (5-model) plan + admin/reviewer, or support allowlist email. */
  governanceDashboardEligible?: boolean;
  governanceDenyReason?: "wrong_plan" | "wrong_role" | null;
  /** Support allowlist only — can edit org governance policy via API. */
  governancePolicyEditable?: boolean;
  /** UIDs this user reviews for (peer assignment); drives dashboard nav eligibility. */
  governanceReviewerFor?: string[];
  governanceReviewerEnabled?: boolean;
  governanceAssignedReviewerEmail?: string | null;
  /**
   * Phase 5C — server-computed via `resolvePersonalWorkspaceUiMode()` in
   * `GET /api/user/usage`. Drives TopNav's Workspace link visibility only
   * — never an authorization decision; Phase 5B's Workspace read APIs are
   * independent of this flag. Absent/falsy must mean hidden, same as
   * every other capability flag here.
   */
  workspaceUiEnabled?: boolean;
}

interface UseUserPlanReturn {
  plan: UserPlan | null;
  runsThisMonth: number;
  monthlyLimit: number | null;
  videoLimit: number;
  videoRunsThisMonth: number;
  billingInterval: "month" | "year" | null;
  teamId: string | null;
  teamRole: "owner" | "admin" | "member" | null;
  teamGovernanceEligible: boolean;
  role: string;
  governanceDashboardEligible: boolean;
  governanceDenyReason: "wrong_plan" | "wrong_role" | null;
  governancePolicyEditable: boolean;
  governanceReviewerFor: string[];
  governanceReviewerEnabled: boolean;
  governanceAssignedReviewerEmail: string | null;
  /** Phase 5C — see `UserUsageData.workspaceUiEnabled`. Always `false` while `loading`, on error, or when signed out — never optimistically `true`. */
  workspaceUiEnabled: boolean;
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
  videoLimit: 0,
  videoRunsThisMonth: 0,
  billingInterval: null,
  teamId: null,
  teamRole: null,
  teamGovernanceEligible: false,
  role: "member",
  governanceDashboardEligible: false,
  governanceDenyReason: "wrong_plan",
  governancePolicyEditable: false,
  governanceReviewerFor: [],
  governanceReviewerEnabled: false,
  governanceAssignedReviewerEmail: null,
  workspaceUiEnabled: false,
};

// Never throws — returns DEFAULT_USAGE on any error to prevent infinite loading states.
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
    const plan = (data.plan || "free") as UserPlan;
    const eligible = data.governanceDashboardEligible === true;
    let deny: "wrong_plan" | "wrong_role" | null = null;
    if (!eligible) {
      if (data.governanceDenyReason === "wrong_plan" || data.governanceDenyReason === "wrong_role") {
        deny = data.governanceDenyReason;
      } else {
        deny = plan !== "full" ? "wrong_plan" : "wrong_role";
      }
    }

    return {
      ok: data.ok ?? true,
      plan,
      runsThisMonth: data.runsThisMonth ?? 0,
      usageMonth: data.usageMonth || DEFAULT_USAGE.usageMonth,
      monthlyLimit: data.monthlyLimit ?? 8,
      videoLimit: typeof data.videoLimit === "number" ? data.videoLimit : 0,
      videoRunsThisMonth: typeof data.videoRunsThisMonth === "number" ? data.videoRunsThisMonth : 0,
      billingInterval: data.billingInterval || null,
      teamId: data.teamId ?? null,
      teamRole: data.teamRole ?? null,
      teamGovernanceEligible: data.teamGovernanceEligible === true,
      role: typeof data.role === "string" ? data.role : "member",
      governanceDashboardEligible: eligible,
      governanceDenyReason: deny,
      governancePolicyEditable: data.governancePolicyEditable === true,
      governanceReviewerFor: Array.isArray(data.governanceReviewerFor)
        ? data.governanceReviewerFor.filter((x: unknown) => typeof x === "string")
        : [],
      governanceReviewerEnabled: data.governanceReviewerEnabled === true,
      governanceAssignedReviewerEmail:
        typeof data.governanceAssignedReviewerEmail === "string" &&
        data.governanceAssignedReviewerEmail.trim()
          ? data.governanceAssignedReviewerEmail.trim()
          : null,
      workspaceUiEnabled: data.workspaceUiEnabled === true,
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
  const uid = user?.uid ?? null;
  const userRef = useRef(user);
  userRef.current = user;

  const [usageData, setUsageData] = useState<UserUsageData>(DEFAULT_USAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True when useLayoutEffect found a cache hit for the current uid
  const hadCacheHitRef = useRef(false);

  const refresh = useCallback(async () => {
    if (authLoading || !authReady) {
      return;
    }

    const u = userRef.current;
    if (!u?.uid) {
      setUsageData(DEFAULT_USAGE);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const data = await fetchUsage(u);
      writePlanCache(u.uid, data);
      setUsageData(data);
      if (process.env.NODE_ENV !== "production") {
        console.log("[useUserPlan] Refreshed usage:", { plan: data.plan, runsThisMonth: data.runsThisMonth });
      }
    } catch (err: unknown) {
      console.error("[useUserPlan] Unexpected error in refresh:", err);
      setUsageData(DEFAULT_USAGE);
      setError("Failed to refresh usage data");
    } finally {
      setLoading(false);
    }
  }, [authLoading, authReady]);

  // Runs before browser paint. On cache hit, apply data immediately so the Governance
  // link renders on first paint with no loading state. On cache miss, block as before.
  useLayoutEffect(() => {
    if (!authReady || !uid) return;
    const cached = readPlanCache(uid);
    if (cached) {
      hadCacheHitRef.current = true;
      setUsageData(cached);
      setLoading(false);
    } else {
      hadCacheHitRef.current = false;
      setLoading(true);
    }
  }, [authReady, uid]);

  // Fetch when auth is ready and Firebase uid changes — not when the User object reference changes
  // (token refresh), to avoid repeated /api/user/usage calls and log spam.
  useEffect(() => {
    if (authLoading || !authReady) {
      return;
    }

    if (!uid) {
      setUsageData(DEFAULT_USAGE);
      setLoading(false);
      return;
    }

    const u = userRef.current;
    if (!u) {
      setUsageData(DEFAULT_USAGE);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const wasCacheHit = hadCacheHitRef.current;

    (async () => {
      try {
        // Only show loading spinner when there's no cached data to display
        if (!wasCacheHit) {
          setLoading(true);
          setError(null);
        }

        const data = await fetchUsage(u);
        if (!cancelled) {
          writePlanCache(uid, data);
          setUsageData(data);
          if (process.env.NODE_ENV !== "production") {
            console.log("[useUserPlan] Loaded usage:", { plan: data.plan, runsThisMonth: data.runsThisMonth });
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          console.error("[useUserPlan] Unexpected error in loadUsage:", err);
          // On background refresh failure, keep the cached data visible
          if (!wasCacheHit) setUsageData(DEFAULT_USAGE);
          setError("Failed to load usage data");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, authReady, uid]);

  return {
    plan: usageData.plan,
    runsThisMonth: usageData.runsThisMonth,
    monthlyLimit: usageData.monthlyLimit,
    videoLimit: usageData.videoLimit ?? 0,
    videoRunsThisMonth: usageData.videoRunsThisMonth ?? 0,
    billingInterval: usageData.billingInterval,
    teamId: usageData.teamId ?? null,
    teamRole: usageData.teamRole ?? null,
    teamGovernanceEligible: usageData.teamGovernanceEligible === true,
    role: usageData.role ?? "member",
    governanceDashboardEligible: usageData.governanceDashboardEligible === true,
    governanceDenyReason: usageData.governanceDenyReason ?? null,
    governancePolicyEditable: usageData.governancePolicyEditable === true,
    governanceReviewerFor: Array.isArray(usageData.governanceReviewerFor)
      ? usageData.governanceReviewerFor
      : [],
    governanceReviewerEnabled: usageData.governanceReviewerEnabled === true,
    governanceAssignedReviewerEmail:
      typeof usageData.governanceAssignedReviewerEmail === "string" &&
      usageData.governanceAssignedReviewerEmail.trim()
        ? usageData.governanceAssignedReviewerEmail.trim()
        : null,
    // Fails closed on the exact same terms as every other capability
    // flag above: default object, loading state, and error/catch paths
    // all resolve through DEFAULT_USAGE (workspaceUiEnabled: false).
    workspaceUiEnabled: usageData.workspaceUiEnabled === true,
    loading: authLoading || loading,
    error,
    refresh,
  };
}

/** True when the user can open /governance (5-Model / full plan, or support allowlist admin). */
export function useIsGovernanceUser(): boolean {
  const { governanceDashboardEligible, plan } = useUserPlan();
  return governanceDashboardEligible === true || plan === "full";
}

/** True when the user can edit governance policy (support allowlist only). */
export function useIsAdmin(): boolean {
  const { governancePolicyEditable } = useUserPlan();
  return governancePolicyEditable === true;
}
