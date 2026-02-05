"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";

interface UserDetails {
  uid: string;
  email: string | null;
  name: string | null;
  plan: string;
  planFromStripe: string | null;
  subscriptionStatusFromStripe: string | null;
  runsThisMonth: number;
  usageMonth: string | null;
  resetDate: string | null;
  totalRuns: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  billingInterval: string | null;
  override: any;
  entitlements: any;
  isDisabled: boolean;
}

interface Entitlement {
  planEffective: string;
  runLimitMonthly: number;
  maxModelsPerRun: number;
  source: string;
}

interface StripeInfo {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  currentPriceId: string | null;
  priceIdPlan: string | null;
}

export default function AdminUserDetailsPage() {
  const { user: currentUser, loading: authLoading, authReady, isAdmin } = useAuth();
  const router = useRouter();
  const params = useParams();
  const uid = params.uid as string;

  const [userDetails, setUserDetails] = useState<UserDetails | null>(null);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [stripeInfo, setStripeInfo] = useState<StripeInfo | null>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Override form state
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overridePlan, setOverridePlan] = useState<"3_models" | "5_models">("5_models");
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideExpiresAt, setOverrideExpiresAt] = useState("");

  // Cancel subscription form
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelMode, setCancelMode] = useState<"immediate" | "period_end">("period_end");

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin || !currentUser) {
      router.push("/admin/users");
      return;
    }
    if (!uid) {
      console.error("[admin/users/[uid]] No UID in route params");
      setError("User ID is missing from URL");
      setLoading(false);
      return;
    }
    loadUserDetails();
  }, [authLoading, isAdmin, currentUser, uid]);

  const loadUserDetails = async () => {
    if (!authReady || !currentUser) return;

    try {
      setLoading(true);
      setError("");
      
      if (!uid) {
        setError("User ID is missing");
        setLoading(false);
        return;
      }

      console.log("[admin/users/[uid]] Loading details for UID:", uid);
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const response = await authedFetch(`/api/admin/users/${uid}/details`, {
        user: currentUser,
        authReady,
      });

      console.log("[admin/users/[uid]] Response status:", response.status);

      if (response.status === 401 || response.status === 403) {
        setError("Unauthorized. Please refresh and try again.");
        setLoading(false);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Unknown error" }));
        console.error("[admin/users/[uid]] API error:", data);
        throw new Error(data.error || `Failed to load user details (${response.status})`);
      }

      const data = await response.json();
      console.log("[admin/users/[uid]] Response data:", { ok: data.ok, hasUser: !!data.user });
      
      if (!data.ok) {
        throw new Error(data.error || "Failed to load user details");
      }

      if (!data.user) {
        throw new Error("User data not found in response");
      }

      setUserDetails(data.user);
      setEntitlement(data.entitlement);
      setStripeInfo(data.stripe);
      setAuditLogs(data.auditLogs || []);
    } catch (err: any) {
      console.error("[admin/users/[uid]] Error:", err);
      setError(err.message || "Failed to load user details");
    } finally {
      setLoading(false);
    }
  };

  const handleGrantOverride = async () => {
    if (!authReady || !currentUser) {
      setError("Not authenticated");
      return;
    }
    
    if (!overrideReason.trim()) {
      setError("Reason is required");
      return;
    }

    try {
      setActionLoading(true);
      setError("");
      setSuccess("");
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const response = await authedFetch(`/api/admin/users/${uid}/override`, {
        user: currentUser,
        authReady,
        method: "POST",
        body: JSON.stringify({
          plan: overridePlan,
          reason: overrideReason.trim(),
          expiresAt: overrideExpiresAt || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to grant override");
      }

      const data = await response.json();
      setSuccess(data.message || "Override granted successfully");
      setShowOverrideForm(false);
      setOverrideReason("");
      setOverrideExpiresAt("");
      await loadUserDetails();
    } catch (err: any) {
      console.error("[admin/users/[uid]] Error granting override:", err);
      setError(err.message || "Failed to grant override");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveOverride = async () => {
    if (!confirm("Remove override? User will revert to Stripe-derived entitlements or free plan.")) {
      return;
    }

    if (!authReady || !currentUser) {
      setError("Not authenticated");
      return;
    }

    try {
      setActionLoading(true);
      setError("");
      setSuccess("");
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const response = await authedFetch(`/api/admin/users/${uid}/override`, {
        user: currentUser,
        authReady,
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to remove override");
      }

      const data = await response.json();
      setSuccess(data.message || "Override removed successfully");
      await loadUserDetails();
    } catch (err: any) {
      console.error("[admin/users/[uid]] Error removing override:", err);
      setError(err.message || "Failed to remove override");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!authReady || !currentUser) {
      setError("Not authenticated");
      return;
    }

    try {
      setActionLoading(true);
      setError("");
      setSuccess("");
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const response = await authedFetch(`/api/admin/users/${uid}/stripe/cancel`, {
        user: currentUser,
        authReady,
        method: "POST",
        body: JSON.stringify({ mode: cancelMode }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to cancel subscription");
      }

      const data = await response.json();
      setSuccess(data.message || "Subscription canceled successfully");
      setShowCancelModal(false);
      await loadUserDetails();
    } catch (err: any) {
      console.error("[admin/users/[uid]] Error canceling subscription:", err);
      setError(err.message || "Failed to cancel subscription");
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivateSubscription = async () => {
    if (!confirm("Reactivate subscription? This will remove the cancellation scheduled for period end.")) {
      return;
    }

    if (!authReady || !currentUser) {
      setError("Not authenticated");
      return;
    }

    try {
      setActionLoading(true);
      setError("");
      setSuccess("");
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const response = await authedFetch(`/api/admin/users/${uid}/stripe/reactivate`, {
        user: currentUser,
        authReady,
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to reactivate subscription");
      }

      const data = await response.json();
      setSuccess(data.message || "Subscription reactivated successfully");
      await loadUserDetails();
    } catch (err: any) {
      console.error("[admin/users/[uid]] Error reactivating subscription:", err);
      setError(err.message || "Failed to reactivate subscription");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSyncStripe = async () => {
    if (!authReady || !currentUser) {
      setError("Not authenticated");
      return;
    }

    try {
      setActionLoading(true);
      setError("");
      setSuccess("");
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const response = await authedFetch(`/api/admin/users/${uid}/stripe/sync`, {
        user: currentUser,
        authReady,
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to sync from Stripe");
      }

      const data = await response.json();
      setSuccess(data.message || "Synced from Stripe successfully");
      await loadUserDetails();
    } catch (err: any) {
      console.error("[admin/users/[uid]] Error syncing Stripe:", err);
      setError(err.message || "Failed to sync from Stripe");
    } finally {
      setActionLoading(false);
    }
  };

  const formatDate = (dateValue: string | null | undefined | { toDate?: () => Date; _seconds?: number; seconds?: number }) => {
    if (!dateValue) return "Never";
    
    try {
      let date: Date;
      
      // Handle Firestore Timestamp object
      if (typeof dateValue === "object" && dateValue !== null) {
        if (typeof dateValue.toDate === "function") {
          date = dateValue.toDate();
        } else if (typeof (dateValue as any)._seconds === "number") {
          date = new Date((dateValue as any)._seconds * 1000);
        } else if (typeof (dateValue as any).seconds === "number") {
          date = new Date((dateValue as any).seconds * 1000);
        } else {
          return "Invalid Date";
        }
      } else if (typeof dateValue === "string") {
        date = new Date(dateValue);
      } else {
        return "Invalid Date";
      }
      
      if (isNaN(date.getTime())) {
        return "Invalid Date";
      }
      
      return date.toLocaleString();
    } catch {
      return "Invalid Date";
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="text-sm tracking-wide">Loading user details…</p>
      </div>
    );
  }

  if (error && error.includes("not found")) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-600 mb-2">User not found</p>
        {uid && (
          <p className="text-sm text-gray-500 mb-4">UID: {uid}</p>
        )}
        {error && error !== "User not found" && (
          <p className="text-sm text-red-600 mb-4">{error}</p>
        )}
        <Link href="/admin/users" className="text-blue-600 hover:underline mt-4 inline-block">
          Back to Users
        </Link>
      </div>
    );
  }

  if (!userDetails || !entitlement) {
    if (loading) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          <p className="text-sm tracking-wide">Loading user details…</p>
        </div>
      );
    }
    return (
      <div className="text-center py-8">
        <p className="text-gray-600 mb-2">User not found</p>
        {uid && (
          <p className="text-sm text-gray-500 mb-4">UID: {uid}</p>
        )}
        {error && (
          <p className="text-sm text-red-600 mb-4">{error}</p>
        )}
        <Link href="/admin/users" className="text-blue-600 hover:underline mt-4 inline-block">
          Back to Users
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link href="/admin/users" className="text-blue-600 hover:underline text-sm">
          ← Back to Users
        </Link>
        <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-1">
          User: {userDetails.name || userDetails.email || uid}
        </h1>
        <p className="text-sm text-gray-600">{userDetails.email || "No email"}</p>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-sm text-green-800">{success}</p>
        </div>
      )}

      {/* Firestore Entitlements Card */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Current Entitlements</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-gray-500">Effective Plan</p>
            <p className="text-lg font-medium">{entitlement.planEffective}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Run Limit (Monthly)</p>
            <p className="text-lg font-medium">{entitlement.runLimitMonthly}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Max Models Per Run</p>
            <p className="text-lg font-medium">{entitlement.maxModelsPerRun}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Source</p>
            <p className="text-lg font-medium">{entitlement.source}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Runs Used (This Month)</p>
            <p className="text-lg font-medium">{userDetails.runsThisMonth} / {entitlement.runLimitMonthly}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Reset Date</p>
            <p className="text-lg font-medium">{formatDate(userDetails.resetDate)}</p>
          </div>
        </div>
      </div>

      {/* Admin Override Controls */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Admin Override</h2>
        
        {userDetails.override?.active ? (
          <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
            <p className="font-medium text-yellow-900 mb-2">Active Override</p>
            <p className="text-sm text-yellow-800">Plan: {userDetails.override.plan}</p>
            <p className="text-sm text-yellow-800">Reason: {userDetails.override.reason}</p>
            <p className="text-sm text-yellow-800">
              Expires: {userDetails.override.expiresAt ? formatDate(userDetails.override.expiresAt) : "Never"}
            </p>
            <button
              onClick={handleRemoveOverride}
              disabled={actionLoading}
              className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              Remove Override
            </button>
          </div>
        ) : (
          <>
            {!showOverrideForm ? (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setOverridePlan("5_models");
                    setShowOverrideForm(true);
                  }}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  Grant Free Full (5-model)
                </button>
                <button
                  onClick={() => {
                    setOverridePlan("3_models");
                    setShowOverrideForm(true);
                  }}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  Grant Free 3-model
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Plan</label>
                  <select
                    value={overridePlan}
                    onChange={(e) => setOverridePlan(e.target.value as "3_models" | "5_models")}
                    className="w-full border border-gray-300 rounded px-3 py-2"
                  >
                    <option value="3_models">3-Model Plan (80 runs/month)</option>
                    <option value="5_models">Full Plan (150 runs/month)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Why is this override being granted?"
                    className="w-full border border-gray-300 rounded px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expires At (optional)
                  </label>
                  <input
                    type="datetime-local"
                    value={overrideExpiresAt}
                    onChange={(e) => setOverrideExpiresAt(e.target.value)}
                    className="w-full border border-gray-300 rounded px-3 py-2"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleGrantOverride}
                    disabled={actionLoading || !overrideReason.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    Grant Override
                  </button>
                  <button
                    onClick={() => {
                      setShowOverrideForm(false);
                      setOverrideReason("");
                      setOverrideExpiresAt("");
                    }}
                    disabled={actionLoading}
                    className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Stripe Controls */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Stripe Subscription</h2>
        
        {stripeInfo ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500">Subscription ID</p>
                <p className="text-sm font-mono">{stripeInfo.subscriptionId}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <p className="text-sm font-medium">{stripeInfo.status}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Price ID</p>
                <p className="text-sm font-mono">{stripeInfo.currentPriceId || "—"}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Plan</p>
                <p className="text-sm font-medium">{stripeInfo.priceIdPlan || "—"}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Current Period End</p>
                <p className="text-sm">{formatDate(stripeInfo.currentPeriodEnd)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Cancel at Period End</p>
                <p className="text-sm font-medium">{stripeInfo.cancelAtPeriodEnd ? "Yes" : "No"}</p>
              </div>
            </div>
            <div className="flex gap-2 pt-4 border-t">
              {stripeInfo.cancelAtPeriodEnd ? (
                <button
                  onClick={handleReactivateSubscription}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                >
                  Reactivate Subscription
                </button>
              ) : (
                <button
                  onClick={() => setShowCancelModal(true)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                >
                  Cancel Subscription
                </button>
              )}
              <button
                onClick={handleSyncStripe}
                disabled={actionLoading}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Sync from Stripe
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-gray-600 mb-4">No Stripe subscription found</p>
            {userDetails.stripeCustomerId && (
              <button
                onClick={handleSyncStripe}
                disabled={actionLoading}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Sync from Stripe
              </button>
            )}
          </div>
        )}
      </div>

      {/* Audit Logs */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Recent Audit Logs</h2>
        {auditLogs.length === 0 ? (
          <p className="text-sm text-gray-600">No audit logs found</p>
        ) : (
          <div className="space-y-2">
            {auditLogs.map((log) => (
              <div key={log.id} className="border border-gray-200 rounded p-3 text-sm">
                <div className="flex justify-between items-start mb-1">
                  <span className="font-medium">{log.actionType}</span>
                  <span className="text-gray-500">{formatDate(log.createdAt)}</span>
                </div>
                <p className="text-gray-600">Admin: {log.adminEmail || log.adminUid}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cancel Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Cancel Subscription</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Cancellation Mode</label>
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="period_end"
                      checked={cancelMode === "period_end"}
                      onChange={(e) => setCancelMode(e.target.value as "period_end")}
                      className="mr-2"
                    />
                    Cancel at Period End
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="immediate"
                      checked={cancelMode === "immediate"}
                      onChange={(e) => setCancelMode(e.target.value as "immediate")}
                      className="mr-2"
                    />
                    Cancel Immediately
                  </label>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowCancelModal(false)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCancelSubscription}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

