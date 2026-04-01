"use client";

/**
 * Admin portal: research runs, claim verifications, and video verifications (list, detail, override, delete).
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useAdminPortalAccess } from "@/hooks/useAdminPortalAccess";

type RunCollection = "runs" | "verifications" | "videoVerifications";
type RunTypeFilter = "all" | "research" | "claim" | "video";

type AdminRunRow = {
  runId: string;
  collection: RunCollection;
  runType: "research" | "claim" | "video";
  question: string;
  userEmail: string;
  userId: string;
  consensusScore: number | null;
  verdict: string | null;
  governanceStatus: string | null;
  governanceReviewedBy: string | null;
  createdAt: string;
};

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 45) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return d.toLocaleDateString();
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function consensusClass(score: number | null): string {
  if (score == null) return "text-gray-500";
  if (score >= 70) return "text-emerald-700 font-semibold";
  if (score >= 40) return "text-amber-700 font-semibold";
  return "text-gray-600 font-medium";
}

function govBadgeClass(status: string | null): string {
  if (!status) return "bg-gray-100 text-gray-600 ring-1 ring-gray-200";
  const s = status.toLowerCase();
  if (s === "approved") return "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300";
  if (s === "blocked") return "bg-red-100 text-red-900 ring-1 ring-red-300";
  if (s === "needs_review") return "bg-amber-100 text-amber-900 ring-1 ring-amber-300";
  return "bg-gray-100 text-gray-700 ring-1 ring-gray-200";
}

export default function AdminRunsTab() {
  const { user, authReady } = useAuth();
  const { canAccess, gateReady } = useAdminPortalAccess();

  const [type, setType] = useState<RunTypeFilter>("all");
  const [status, setStatus] = useState<string>("all");
  const [userFilter, setUserFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchApplied, setSearchApplied] = useState("");

  const [rows, setRows] = useState<AdminRunRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const pageLimit = 25;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [detailByKey, setDetailByKey] = useState<Record<string, Record<string, unknown>>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const [overrideRow, setOverrideRow] = useState<AdminRunRow | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<"approved" | "needs_review" | "blocked">("approved");
  const [overrideComment, setOverrideComment] = useState("");
  const [overrideBusy, setOverrideBusy] = useState(false);

  const [deleteRow, setDeleteRow] = useState<AdminRunRow | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const loadRuns = useCallback(async () => {
    if (!user || !authReady || !canAccess) return;
    setLoading(true);
    setError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const q = new URLSearchParams({
        type,
        limit: String(pageLimit),
        offset: String(pageOffset),
      });
      if (searchApplied.trim()) q.set("search", searchApplied.trim());
      if (status !== "all") q.set("status", status);
      const uidTrim = userFilter.trim();
      if (uidTrim && !uidTrim.includes("@")) q.set("userId", uidTrim);

      const res = await authedFetch(`/api/admin/runs?${q}`, {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        runs?: AdminRunRow[];
        total?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to load runs");
        setRows([]);
        setTotal(0);
        return;
      }
      let list = data.runs ?? [];
      const emailSub = userFilter.trim().toLowerCase();
      if (emailSub && emailSub.includes("@")) {
        list = list.filter((r) => r.userEmail.toLowerCase().includes(emailSub));
      }
      setRows(list);
      const baseTotal = data.total ?? list.length;
      setTotal(emailSub && emailSub.includes("@") ? list.length : baseTotal);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [user, authReady, canAccess, type, status, searchApplied, userFilter, pageOffset]);

  useEffect(() => {
    if (!gateReady || !canAccess) return;
    void loadRuns();
  }, [gateReady, canAccess, loadRuns]);

  useEffect(() => {
    setPageOffset(0);
  }, [type, status]);

  const rowKey = (r: AdminRunRow) => `${r.collection}:${r.runId}`;

  const toggleExpand = async (r: AdminRunRow) => {
    const key = rowKey(r);
    let willBeOpen = false;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        willBeOpen = false;
      } else {
        next.add(key);
        willBeOpen = true;
      }
      return next;
    });
    if (!willBeOpen || !user || !authReady) return;
    if (detailByKey[key]) return;
    setDetailLoading(key);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(
        `/api/admin/runs/${encodeURIComponent(r.runId)}?collection=${r.collection}`,
        { user, authReady, method: "GET", cache: "no-store" }
      );
      const data = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> };
      if (res.ok && data.ok && data.data) {
        setDetailByKey((d) => ({ ...d, [key]: data.data! }));
      }
    } finally {
      setDetailLoading(null);
    }
  };

  const submitOverride = async () => {
    if (!overrideRow || !user || !authReady) return;
    setOverrideBusy(true);
    setError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/admin/runs/${encodeURIComponent(overrideRow.runId)}`, {
        user,
        authReady,
        method: "PATCH",
        body: JSON.stringify({
          action: "set_governance_status",
          status: overrideStatus,
          comment: overrideComment.trim() || "Admin override",
          collection: overrideRow.collection,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Override failed");
        return;
      }
      setOverrideRow(null);
      setOverrideComment("");
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Override failed");
    } finally {
      setOverrideBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteRow || deleteConfirm !== "DELETE" || !user || !authReady) return;
    setDeleteBusy(true);
    setError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(
        `/api/admin/runs/${encodeURIComponent(deleteRow.runId)}?collection=${deleteRow.collection}`,
        {
          user,
          authReady,
          method: "DELETE",
          body: JSON.stringify({ confirm: true }),
        }
      );
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Delete failed");
        return;
      }
      setDeleteRow(null);
      setDeleteConfirm("");
      setExpanded((e) => {
        const next = new Set(e);
        next.delete(rowKey(deleteRow));
        return next;
      });
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!gateReady || !canAccess) {
    return <div className="text-gray-600">Checking access…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label className="block text-xs font-medium text-gray-500">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as RunTypeFilter)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="research">Research</option>
            <option value="claim">Claims</option>
            <option value="video">Video</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="none">None</option>
            <option value="needs_review">Needs review</option>
            <option value="approved">Approved</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
        <div className="min-w-[180px] flex-1">
          <label className="block text-xs font-medium text-gray-500">User (email or UID)</label>
          <input
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Filter by email substring or exact UID"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="block text-xs font-medium text-gray-500">Search</label>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSearchApplied(search);
              }
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Question, claim, or video file name…"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setPageOffset(0);
            setSearchApplied(search);
          }}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          Search
        </button>
        <button
          type="button"
          onClick={() => void loadRuns()}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-600">Loading runs…</div>
        ) : (
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-3 py-3">User</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Summary</th>
                <th className="px-3 py-3">Consensus</th>
                <th className="px-3 py-3">Governance</th>
                <th className="px-3 py-3">Time</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                    No runs match the current filters.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const key = rowKey(r);
                  const open = expanded.has(key);
                  const detail = detailByKey[key];
                  return (
                    <Fragment key={key}>
                      <tr className="hover:bg-gray-50/80">
                        <td className="px-3 py-2">
                          <span className="max-w-[140px] truncate block" title={r.userEmail || r.userId}>
                            {truncate(r.userEmail || r.userId, 22)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {r.runType === "research" && (
                            <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800 ring-1 ring-green-200">
                              RESEARCH
                            </span>
                          )}
                          {r.runType === "claim" && (
                            <span className="inline-flex rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800 ring-1 ring-purple-200">
                              CLAIM
                            </span>
                          )}
                          {r.runType === "video" && (
                            <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800 ring-1 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-200">
                              VIDEO
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 max-w-xs">
                          <span title={r.question}>{truncate(r.question, 80)}</span>
                        </td>
                        <td className={`px-3 py-2 ${consensusClass(r.consensusScore)}`}>
                          {r.consensusScore != null ? r.consensusScore : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${govBadgeClass(
                              r.governanceStatus
                            )}`}
                          >
                            {r.governanceStatus ?? "none"}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {formatRelativeTime(r.createdAt)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() => void toggleExpand(r)}
                              className="text-sky-700 hover:underline text-xs font-medium"
                            >
                              {open ? "Hide" : "View"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOverrideRow(r);
                                setOverrideStatus(
                                  (r.governanceStatus === "blocked"
                                    ? "needs_review"
                                    : r.governanceStatus === "approved"
                                      ? "approved"
                                      : "needs_review") as typeof overrideStatus
                                );
                              }}
                              className="text-amber-800 hover:underline text-xs font-medium"
                            >
                              Override
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteRow(r)}
                              className="text-red-700 hover:underline text-xs font-medium"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-gray-50/90">
                          <td colSpan={7} className="px-4 py-4 text-sm text-gray-800">
                            {detailLoading === key && <p className="text-gray-500">Loading details…</p>}
                            {detail && (
                              <div className="space-y-2 max-w-4xl">
                                <p>
                                  <span className="font-semibold text-gray-700">Full text:</span>{" "}
                                  {String(
                                    detail.question ??
                                      detail.claim ??
                                      detail.query ??
                                      detail.fileName ??
                                      "—"
                                  )}
                                </p>
                                {(r.verdict || detail.verdict != null) && (
                                  <p>
                                    <span className="font-semibold text-gray-700">Verdict:</span>{" "}
                                    {String(r.verdict ?? detail.verdict ?? "—")}
                                  </p>
                                )}
                                <p>
                                  <span className="font-semibold text-gray-700">User:</span>{" "}
                                  {r.userEmail} <span className="text-gray-500">({r.userId})</span>
                                </p>
                                <p>
                                  <span className="font-semibold text-gray-700">Consensus:</span>{" "}
                                  {detail.consensusScore != null ? String(detail.consensusScore) : "—"}
                                  {detail.evidenceQuality != null && (
                                    <>
                                      {" "}
                                      · <span className="font-semibold">Evidence:</span>{" "}
                                      {String(detail.evidenceQuality)}
                                    </>
                                  )}
                                </p>
                                <p>
                                  <span className="font-semibold text-gray-700">Governance:</span>{" "}
                                  {String(detail.governanceStatus ?? "—")}
                                  {Array.isArray(detail.governanceReasons) &&
                                    detail.governanceReasons.length > 0 && (
                                      <>
                                        {" "}
                                        · <span className="text-gray-600">Reasons:</span>{" "}
                                        {(detail.governanceReasons as string[]).join("; ")}
                                      </>
                                    )}
                                </p>
                                <p className="text-gray-600 text-xs">
                                  Reviewed by: {String(detail.governanceReviewedBy ?? "—")} · At:{" "}
                                  {String(detail.governanceReviewedAt ?? "—")}
                                </p>
                                <p className="text-gray-600 text-xs">
                                  Created: {r.createdAt}
                                  {detail.completedAt != null && (
                                    <> · Completed: {String(detail.completedAt)}</>
                                  )}
                                </p>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Showing {rows.length} loaded (total from query: {total}). Refine filters or search to narrow results.
      </p>

      {overrideRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Override governance</h3>
            <p className="mt-2 text-sm text-gray-600 truncate" title={overrideRow.question}>
              {truncate(overrideRow.question, 120)}
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600">Status</label>
                <select
                  value={overrideStatus}
                  onChange={(e) => setOverrideStatus(e.target.value as typeof overrideStatus)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                >
                  <option value="approved">Approved</option>
                  <option value="needs_review">Needs review</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600">Comment</label>
                <textarea
                  value={overrideComment}
                  onChange={(e) => setOverrideComment(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                  placeholder="Reason for override…"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOverrideRow(null)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={overrideBusy}
                onClick={() => void submitOverride()}
                className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {overrideBusy ? "Saving…" : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-red-900">Delete run</h3>
            <p className="mt-2 text-sm text-gray-700">
              Are you sure you want to delete this run? This cannot be undone.
            </p>
            <p className="mt-2 text-xs text-gray-500 truncate" title={deleteRow.question}>
              {deleteRow.runId} · {truncate(deleteRow.question, 100)}
            </p>
            <p className="mt-4 text-sm font-medium text-gray-800">
              Type <span className="font-mono">DELETE</span> to confirm:
            </p>
            <input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="mt-2 w-full rounded-md border border-gray-300 px-2 py-2 text-sm font-mono"
              placeholder="DELETE"
              autoComplete="off"
            />
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteRow(null);
                  setDeleteConfirm("");
                }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteBusy || deleteConfirm !== "DELETE"}
                onClick={() => void submitDelete()}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleteBusy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
