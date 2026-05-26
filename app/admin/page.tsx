"use client";

/**
 * Admin dashboard: usage stats, runs browser, and links to admin tools.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import AdminRunsTab from "@/components/admin/AdminRunsTab";
import { useAdminPortalAccess } from "@/hooks/useAdminPortalAccess";

type AdminTab = "users" | "runs";

export default function AdminDashboard() {
  const { user, loading: authLoading, authReady } = useAuth();
  const { canAccess, gateReady } = useAdminPortalAccess();
  const [tab, setTab] = useState<AdminTab>("users");
  const [stats, setStats] = useState({
    totalUsers: 0,
    activeUsers: 0,
    disabledUsers: 0,
    modelsConfigured: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log("[admin] Dashboard auth state:", {
      hasUser: !!user,
      canAccess,
      gateReady,
      authLoading,
      userEmail: user?.email,
    });

    if (authLoading || !gateReady) {
      return;
    }

    if (!canAccess) {
      return;
    }

    const fetchStats = async () => {
      if (!authReady || !user) {
        setLoading(false);
        return;
      }

      try {
        // Import authedFetch helper
        const { authedFetch } = await import("@/lib/client/authedFetch");
        console.log("[admin] Fetching stats");

        // Get users with authentication
        const usersRes = await authedFetch("/api/admin/users", {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });

        if (!usersRes.ok) {
          const errorData = await usersRes.json().catch(() => ({}));
          console.error("[admin] Failed to load users:", {
            status: usersRes.status,
            statusText: usersRes.statusText,
            error: errorData,
          });
          setLoading(false);
          return;
        }

        const { users } = await usersRes.json();
        const total = users.length;
        const active = users.filter((u: any) => !u.isDisabled).length;
        const disabled = total - active;

        // Get keys with authentication
        const keysRes = await authedFetch("/api/admin/keys", {
          user,
          authReady,
        });
        let modelsConfigured = 0;
        if (keysRes.ok) {
          const { status } = await keysRes.json();
          modelsConfigured = Object.values(status).filter(
            (s: any) => s.configured
          ).length;
        }

        console.log("[admin] Stats loaded:", { total, active, disabled, modelsConfigured });

        setStats({
          totalUsers: total,
          activeUsers: active,
          disabledUsers: disabled,
          modelsConfigured,
        });
      } catch (error) {
        console.error("[admin] Error fetching stats:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [canAccess, gateReady, authLoading, authReady, user]);

  if (authLoading || !gateReady) {
    return <div className="text-gray-600">Checking admin access…</div>;
  }

  if (!canAccess) {
    return null;
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Admin Dashboard</h1>

      <div className="mb-8 flex gap-2 border-b border-gray-200 pb-2">
        <button
          type="button"
          onClick={() => setTab("users")}
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            tab === "users"
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          Users
        </button>
        <button
          type="button"
          onClick={() => setTab("runs")}
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
            tab === "runs"
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          Runs
        </button>
      </div>

      {tab === "users" && (
        <>
          <p className="mb-6 text-sm text-gray-600">
            <Link href="/admin/users" className="font-medium text-sky-700 hover:underline">
              Open user directory
            </Link>{" "}
            for account management, roles, and billing tools.
          </p>

          {loading ? (
            <div className="text-gray-600">Loading stats...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Total Users</h3>
                <p className="text-3xl font-bold text-gray-900">{stats.totalUsers}</p>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Active Users</h3>
                <p className="text-3xl font-bold text-green-600">{stats.activeUsers}</p>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Disabled Users</h3>
                <p className="text-3xl font-bold text-red-600">{stats.disabledUsers}</p>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-sm font-medium text-gray-500 mb-2">Models Configured</h3>
                <p className="text-3xl font-bold text-primary-600">{stats.modelsConfigured}/4</p>
              </div>
            </div>
          )}

          <div className="mt-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Data retention cleanup</h2>
            <PurgeRunsSection />
          </div>
        </>
      )}

      {tab === "runs" && <AdminRunsTab />}
    </div>
  );
}

/**
 * Purge Runs Section Component
 * 
 * Allows admins to delete Firestore run documents based on age or date range.
 * Includes dry-run preview and confirmation flow.
 * 
 * TEST PLAN:
 * 1. Dry-run test:
 *    - Select "Older than" mode, enter 30 days
 *    - Check "Dry run" checkbox
 *    - Click "Preview" button
 *    - Verify response shows matchedCount, sampleIds, and deletedCount=0
 * 
 * 2. Delete test:
 *    - After preview, uncheck "Dry run"
 *    - Type "DELETE" in confirmation field
 *    - Click "Delete" button
 *    - Verify documents are actually deleted in Firestore
 * 
 * 3. Date range test:
 *    - Select "Between dates" mode
 *    - Enter start and end dates
 *    - Run dry-run to verify date filtering works
 */
function PurgeRunsSection() {
  const { user, authReady } = useAuth();
  const [mode, setMode] = useState<"olderThan" | "between">("olderThan");
  const [days, setDays] = useState<string>("30");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [status, setStatus] = useState<"any" | "success" | "failed">("any");
  const [dryRun, setDryRun] = useState<boolean>(true);
  const [confirmation, setConfirmation] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [lastPreview, setLastPreview] = useState<{
    scannedCount: number;
    matchedCount: number;
    deletedCount: number;
    errorsCount: number;
    sampleIds: string[];
    capped?: boolean;
  } | null>(null);
  const [result, setResult] = useState<{
    scannedCount: number;
    matchedCount: number;
    deletedCount: number;
    errorsCount: number;
    sampleIds: string[];
    capped?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clear preview when inputs change
  useEffect(() => {
    setLastPreview(null);
  }, [mode, days, startDate, endDate, status]);

  // Delete button enabled condition: all safety gates must pass
  const canDelete =
    !loading &&
    dryRun === false &&
    confirmation === "DELETE" &&
    (lastPreview?.matchedCount ?? 0) > 0;

  const handlePreview = async () => {
    if (!user) {
      setError("Not authenticated");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const requestBody: any = {
        mode,
        dryRun: true,
        status,
      };

      if (mode === "olderThan") {
        const daysNum = parseInt(days, 10);
        if (isNaN(daysNum) || daysNum < 1 || daysNum > 3650) {
          setError("Days must be between 1 and 3650");
          setLoading(false);
          return;
        }
        requestBody.days = daysNum;
      } else {
        if (!startDate || !endDate) {
          setError("Start and end dates are required");
          setLoading(false);
          return;
        }
        requestBody.start = startDate;
        requestBody.end = endDate;
      }

      const res = await authedFetch("/api/admin/purge-runs", {
        user,
        authReady,
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Request failed");
        setLoading(false);
        return;
      }

      // Store preview results separately to persist across dryRun toggle
      const previewResult = {
        scannedCount: data.scannedCount,
        matchedCount: data.matchedCount,
        deletedCount: data.deletedCount,
        errorsCount: data.errorsCount,
        sampleIds: data.sampleIds || [],
        capped: data.capped,
      };
      setLastPreview(previewResult);
      setResult(previewResult);
    } catch (err: any) {
      setError(err?.message || "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!canDelete || !user) {
      return;
    }

    if (!confirm("Are you sure you want to delete these runs? This action cannot be undone.")) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Import authedFetch helper
      const { authedFetch } = await import("@/lib/client/authedFetch");

      const requestBody: any = {
        mode,
        dryRun: false,
        status,
      };

      if (mode === "olderThan") {
        const daysNum = parseInt(days, 10);
        if (isNaN(daysNum) || daysNum < 1 || daysNum > 3650) {
          setError("Days must be between 1 and 3650");
          setLoading(false);
          return;
        }
        requestBody.days = daysNum;
      } else {
        if (!startDate || !endDate) {
          setError("Start and end dates are required");
          setLoading(false);
          return;
        }
        requestBody.start = startDate;
        requestBody.end = endDate;
      }

      const res = await authedFetch("/api/admin/purge-runs", {
        user,
        authReady,
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Delete failed");
        setLoading(false);
        return;
      }

      setResult({
        scannedCount: data.scannedCount,
        matchedCount: data.matchedCount,
        deletedCount: data.deletedCount,
        errorsCount: data.errorsCount,
        sampleIds: data.sampleIds || [],
        capped: data.capped,
      });

      // Reset confirmation and clear preview after successful delete
      setConfirmation("");
      setLastPreview(null);
    } catch (err: any) {
      setError(err?.message || "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="space-y-4">
        {/* Mode selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Mode
          </label>
          <div className="flex gap-4">
            <label className="flex items-center">
              <input
                type="radio"
                name="mode"
                value="olderThan"
                checked={mode === "olderThan"}
                onChange={(e) => setMode(e.target.value as "olderThan")}
                className="mr-2"
              />
              Older than
            </label>
            <label className="flex items-center">
              <input
                type="radio"
                name="mode"
                value="between"
                checked={mode === "between"}
                onChange={(e) => setMode(e.target.value as "between")}
                className="mr-2"
              />
              Between dates
            </label>
          </div>
        </div>

        {/* Days input (olderThan mode) */}
        {mode === "olderThan" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Days
            </label>
            <input
              type="number"
              min="1"
              max="3650"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter number of days"
            />
            <p className="mt-1 text-xs text-gray-500">Between 1 and 3650 days</p>
          </div>
        )}

        {/* Date range inputs (between mode) */}
        {mode === "between" && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Start date/time
              </label>
              <input
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                End date/time
              </label>
              <input
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {/* Status filter */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Status filter
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "any" | "success" | "failed")}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="any">Any</option>
            <option value="success">Success (complete)</option>
            <option value="failed">Failed (error)</option>
          </select>
        </div>

        {/* Dry run checkbox */}
        <div>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="mr-2"
            />
            <span className="text-sm font-medium text-gray-700">Dry run (preview only)</span>
          </label>
        </div>

        {/* Confirmation input (only when not dry run) */}
        {!dryRun && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Type &quot;DELETE&quot; to confirm
            </label>
            <input
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="DELETE"
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-4">
          <button
            onClick={handlePreview}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {loading ? "Loading..." : "Preview"}
          </button>
          <button
            onClick={handleDelete}
            disabled={loading || !canDelete}
            className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {loading ? "Deleting..." : "Delete"}
          </button>
        </div>

        {/* Error display */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Results display */}
        {result && (
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-md">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Results</h3>
            <div className="space-y-1 text-sm text-gray-700">
              <p>Scanned: {result.scannedCount}</p>
              <p>Matched: {result.matchedCount}</p>
              <p>Deleted: {result.deletedCount}</p>
              {result.errorsCount > 0 && <p className="text-red-600">Errors: {result.errorsCount}</p>}
              {result.capped && <p className="text-amber-600">⚠️ Hit maximum delete limit (2000 docs)</p>}
              {result.sampleIds.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium">Sample IDs (up to 10):</p>
                  <ul className="list-disc list-inside text-xs text-gray-600 mt-1">
                    {result.sampleIds.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
