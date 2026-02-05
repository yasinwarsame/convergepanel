"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";
import Link from "next/link";

interface User {
  id: string;
  email?: string;
  name?: string;
  uid?: string;
  role?: string;
  plan?: string;
  subscriptionStatus?: string;
  createdAt?: any;
  lastLoginAt?: any;
  isDisabled?: boolean;
  runsCount?: number; // Lifetime total of panel runs
  tokensUsedCurrentPeriod?: number | null; // Tokens used in current billing period
  maxModelsPerRun?: number | null; // Max models per run for plan display
}

export default function AdminUsersPage() {
  const { user: currentUser, loading: authLoading, authReady, isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingRoles, setUpdatingRoles] = useState<Set<string>>(new Set());

  useEffect(() => {
    console.log("[admin/users] Auth state:", {
      hasUser: !!currentUser,
      isAdmin,
      authLoading,
      userEmail: currentUser?.email,
    });

    // Wait for auth to finish loading
    if (authLoading) {
      console.log("[admin/users] Auth still loading, waiting...");
      return;
    }

    // Only load users if user is admin
    if (!isAdmin) {
      console.log("[admin/users] User is not admin, not loading users");
      setLoading(false);
      return;
    }

    if (!currentUser) {
      console.error("[admin/users] No user available");
      setError("Not authenticated. Please sign in.");
      setLoading(false);
      return;
    }

    console.log("[admin/users] User is admin, loading users");
    loadUsers();
  }, [isAdmin, authLoading, currentUser]);

  const loadUsers = async () => {
    if (!currentUser) {
      setError("Not authenticated. Please sign in.");
      setLoading(false);
      return;
    }

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");
      console.log("[admin/users] Fetching users");

      const response = await authedFetch("/api/admin/users", {
        user: currentUser,
        authReady,
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[admin/users] Unauthorized:", errorData);
        setError("Your session may have expired. Please refresh the page or sign in again.");
        setLoading(false);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to load users");
      }

      const data = await response.json();
      setUsers(data.users || []);
      setError(""); // Clear any previous errors
      console.log(`[admin/users] Loaded ${data.users?.length || 0} users`);
      // Debug: Log first user to verify runsCount and tokensUsedCurrentPeriod are present
      if (data.users && data.users.length > 0) {
        console.log("[admin/users] Sample user data:", {
          email: data.users[0].email,
          runsCount: data.users[0].runsCount,
          tokensUsedCurrentPeriod: data.users[0].tokensUsedCurrentPeriod,
          totalRuns: data.users[0].totalRuns,
        });
      }
    } catch (err: any) {
      console.error("[admin/users] Error loading users:", err);
      setError(err.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleDisable = async (uid: string, currentState: boolean) => {
    if (!authReady || !currentUser) {
      setError("Not authenticated. Please sign in.");
      return;
    }

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const response = await authedFetch(`/api/admin/users/${uid}`, {
        user: currentUser,
        authReady,
        method: "PATCH",
        body: JSON.stringify({ isDisabled: !currentState }),
      });

      if (response.status === 401) {
        setError("Your session may have expired. Please refresh the page or sign in again.");
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to update user");
      }

      await loadUsers();
    } catch (err: any) {
      console.error("[admin/users] Error toggling user disable:", err);
      alert(err.message || "Failed to update user");
    }
  };

  const handleRoleChange = async (uid: string, newRole: "user" | "admin") => {
    if (!authReady || !currentUser) {
      setError("Not authenticated. Please sign in.");
      return;
    }

    // Prevent admins from removing their own admin status
    if (currentUser.uid === uid && newRole === "user") {
      alert("You cannot remove your own admin status");
      return;
    }

    setUpdatingRoles((prev) => new Set(prev).add(uid));

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const response = await authedFetch("/api/admin/set-role", {
        user: currentUser,
        authReady,
        method: "POST",
        body: JSON.stringify({ uid, role: newRole }),
      });

      if (response.status === 401 || response.status === 403) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[admin/users] Unauthorized/Forbidden:", {
          status: response.status,
          error: errorData,
        });
        setError("Your session may have expired or you don't have permission. Please refresh the page or sign in again.");
        setUpdatingRoles((prev) => {
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("[admin/users] Error response:", {
          status: response.status,
          error: errorData,
        });
        throw new Error(errorData.error || "Failed to update role");
      }

      console.log(`[admin] Updated role for uid=${uid} to ${newRole}`);
      
      // Optimistically update the UI
      setUsers((prevUsers) =>
        prevUsers.map((u) => {
          const userUid = u.uid || u.id;
          if (userUid === uid) {
            return { ...u, role: newRole };
          }
          return u;
        })
      );
    } catch (err: any) {
      console.error("[admin] Error updating role:", err);
      alert(err.message || "Failed to update role");
      // Reload users to get correct state
      await loadUsers();
    } finally {
      setUpdatingRoles((prev) => {
        const next = new Set(prev);
        next.delete(uid);
        return next;
      });
    }
  };

  const handleDelete = async (uid: string) => {
    if (!confirm("Are you sure you want to delete this user? This action cannot be undone.")) {
      return;
    }

    if (!currentUser) {
      setError("Not authenticated. Please sign in.");
      return;
    }

    try {
      // Get ID token for authentication
      const idToken = await currentUser.getIdToken();
      const response = await fetch(`/api/admin/users/${uid}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });

      if (response.status === 401) {
        setError("Your session may have expired. Please refresh the page or sign in again.");
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to delete user");
      }

      await loadUsers();
    } catch (err: any) {
      console.error("[admin/users] Error deleting user:", err);
      alert(err.message || "Failed to delete user");
    }
  };

  const formatDate = (timestamp: string | null | undefined) => {
    if (!timestamp) return "Never";
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return "Invalid Date";
      }
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (error) {
      console.error("[admin/users] Error formatting date:", timestamp, error);
      return "Invalid Date";
    }
  };

  // Show loading while auth is being determined
  if (authLoading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="text-sm tracking-wide">Checking admin access…</p>
      </div>
    );
  }

  // If not admin, layout will handle redirect, but show nothing here
  if (!isAdmin) {
    return null;
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="text-sm tracking-wide">Loading users…</p>
      </div>
    );
  }

  const formatPlan = (plan?: string, subscriptionStatus?: string, maxModelsPerRun?: number) => {
    if (!plan || plan === "free") {
      return "Free (2 models)";
    }
    // Show plan name with model count: Lite = 3 models, Full = 5 models
    let planLabel = "";
    if (plan === "lite") {
      planLabel = "3-Model Plan";
    } else if (plan === "full") {
      planLabel = "5-Model Plan";
    } else {
      // Fallback: use maxModelsPerRun if available, otherwise just capitalize plan name
      planLabel = maxModelsPerRun ? `${maxModelsPerRun}-Model Plan` : plan.charAt(0).toUpperCase() + plan.slice(1);
    }
    const status = subscriptionStatus ? ` (${subscriptionStatus})` : "";
    return `${planLabel}${status}`;
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Admin – User Management</h1>
      <p className="text-sm text-gray-600 mb-6">View and manage ConvergePanel users</p>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Plan / Subscription
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Runs
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" title="Tokens used in current subscription period">
                  Tokens Used (Current Period)
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-sm text-gray-500">
                    No users found
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const uid = user.uid || user.id;
                  const isDisabled = user.isDisabled || false;
                  const isUpdating = updatingRoles.has(uid);
                  const currentRole = (user.role || "user") as "user" | "admin";
                  
                  return (
                    <tr key={uid} className={isDisabled ? "opacity-50" : ""}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {user.name || user.email?.split("@")[0] || "—"}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {user.email || "N/A"}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                              currentRole === "admin"
                                ? "bg-purple-100 text-purple-800"
                                : "bg-gray-100 text-gray-800"
                            }`}
                          >
                            {currentRole}
                          </span>
                          {isUpdating ? (
                            <span className="text-xs text-gray-500">Saving...</span>
                          ) : (
                            <select
                              value={currentRole}
                              onChange={(e) => handleRoleChange(uid, e.target.value as "user" | "admin")}
                              disabled={isUpdating || (currentUser?.uid === uid && currentRole === "admin")}
                              className="text-xs border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value="user">user</option>
                              <option value="admin">admin</option>
                            </select>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatPlan(user.plan, user.subscriptionStatus, user.maxModelsPerRun ?? undefined) || "—"}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                        {typeof user.runsCount === "number" ? user.runsCount : 0}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                        {Number(user.tokensUsedCurrentPeriod ?? 0).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                        <Link
                          href={`/admin/users/${uid}`}
                          className="text-blue-600 hover:text-blue-900 underline"
                        >
                          View Details
                        </Link>
                        <button
                          onClick={() => handleToggleDisable(uid, isDisabled)}
                          disabled={isUpdating}
                          className={`${
                            isDisabled
                              ? "text-green-600 hover:text-green-900"
                              : "text-yellow-600 hover:text-yellow-900"
                          } disabled:opacity-50 disabled:cursor-not-allowed ml-2`}
                        >
                          {isDisabled ? "Enable" : "Disable"}
                        </button>
                        <button
                          onClick={() => handleDelete(uid)}
                          disabled={isUpdating}
                          className="text-red-600 hover:text-red-900 disabled:opacity-50 disabled:cursor-not-allowed ml-2"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

