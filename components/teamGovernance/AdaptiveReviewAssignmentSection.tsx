"use client";

/**
 * Part E3 — Single-Reviewer Assignment for Adaptive Human Review. A
 * compact "Reviewer" section on the adaptive review detail page
 * (docs/governance-decision-receipts-design.md §28.13). Every viewer of
 * this page is already `isTeamAdmin` (owner|admin) — the SAME permission
 * this route requires to mutate assignment — so there is no third
 * "can view but not manage" tier in this codebase's actual authorization
 * model (confirmed in the Part E3 audit); this section always shows both
 * the current assignment and, while the review is pending, the management
 * controls. It always clearly indicates when the review is assigned to
 * the CURRENT viewer.
 *
 * Never renders: multiple-reviewer controls, comments, notes, messaging,
 * notifications, due dates, workload info, quorum controls, reopening
 * controls, or a repair button (the repair service is internal-only).
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";

type EligibleReviewer = { userId: string; displayName: string };

type AssignmentPayload = {
  assignedReviewerUserId: string | null;
  assignedReviewerDisplayName: string | null;
  assignedAt: string | null;
  assignedByUserId: string | null;
  revision: number;
};

function formatDatetime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function AdaptiveReviewAssignmentSection({ runId, reviewPending }: { runId: string; reviewPending: boolean }) {
  const { user, authReady } = useAuth();
  const [assignment, setAssignment] = useState<AssignmentPayload | null>(null);
  const [eligibleReviewers, setEligibleReviewers] = useState<EligibleReviewer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedReviewerId, setSelectedReviewerId] = useState("");
  const [mutating, setMutating] = useState(false);
  const [mutationMessage, setMutationMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!user || !authReady) return;
    setLoading(true);
    setLoadError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/assignment`, {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError("Reviewer assignment is temporarily unavailable.");
        return;
      }
      const json = await res.json();
      if (json.ok) {
        setAssignment(json.assignment);
        setEligibleReviewers(json.eligibleReviewers ?? []);
      } else {
        setLoadError("Reviewer assignment is temporarily unavailable.");
      }
    } catch {
      setLoadError("Reviewer assignment is temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }, [user, authReady, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitMutation = async (method: "PUT" | "DELETE", body: Record<string, unknown>) => {
    if (!user || !authReady || mutating) return;
    setMutating(true);
    setMutationMessage(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/assignment`, {
        user,
        authReady,
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 409 && json?.error?.code === "stale_revision") {
          setMutationMessage({ kind: "error", text: "This assignment changed since you last viewed it. Reloading…" });
          await load();
          return;
        }
        if (res.status === 409 && json?.error?.code === "not_pending") {
          setMutationMessage({ kind: "error", text: "This review is no longer pending — assignment can no longer be changed." });
          await load();
          return;
        }
        setMutationMessage({ kind: "error", text: "Could not update the reviewer assignment. Please try again." });
        return;
      }
      setAssignment(json.assignment);
      setEligibleReviewers(json.eligibleReviewers ?? eligibleReviewers);
      setSelectedReviewerId("");
      setMutationMessage({ kind: "success", text: "Reviewer assignment updated." });
    } catch {
      setMutationMessage({ kind: "error", text: "Could not update the reviewer assignment. Please try again." });
    } finally {
      setMutating(false);
    }
  };

  const handleAssign = () => {
    if (!selectedReviewerId || !assignment) return;
    void submitMutation("PUT", { assignedReviewerUserId: selectedReviewerId, expectedRevision: assignment.revision });
  };

  const handleUnassign = () => {
    if (!assignment) return;
    void submitMutation("DELETE", { expectedRevision: assignment.revision });
  };

  return (
    <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h2 className="text-base font-bold text-cp-text">Reviewer</h2>

      {loading ? (
        <div className="mt-3 text-sm text-cp-muted" aria-live="polite">
          Loading reviewer assignment…
        </div>
      ) : loadError ? (
        <p className="mt-3 text-sm text-cp-muted" role="status">
          {loadError}
        </p>
      ) : assignment ? (
        <div className="mt-3 space-y-3">
          {assignment.assignedReviewerUserId ? (
            <div className="rounded-lg border border-cp-border bg-cp-raised p-3 text-sm">
              <p className="font-semibold text-cp-text">
                {assignment.assignedReviewerDisplayName ?? "Assigned reviewer"}
                {assignment.assignedReviewerUserId === user?.uid ? (
                  <span className="ml-2 rounded bg-cp-primary-soft px-2 py-0.5 text-xs font-bold text-cp-primary">Assigned to you</span>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-cp-muted">Assigned {formatDatetime(assignment.assignedAt)}</p>
              {assignment.assignedReviewerUserId !== user?.uid ? (
                <p className="mt-2 text-xs text-cp-muted">
                  This run is assigned to another reviewer. Only that reviewer, or a team owner, may submit a decision.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-cp-muted">No reviewer assigned.</p>
          )}

          {!reviewPending ? (
            <p className="rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted" role="status">
              This review is complete — the assignment is now read-only.
            </p>
          ) : eligibleReviewers.length === 0 ? (
            <p className="text-xs text-cp-muted">No eligible team members are available to assign.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="adaptive-review-assignment-select">
                Select a reviewer
              </label>
              <select
                id="adaptive-review-assignment-select"
                value={selectedReviewerId}
                onChange={(e) => setSelectedReviewerId(e.target.value)}
                disabled={mutating}
                className="rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent disabled:opacity-60"
              >
                <option value="">Select a reviewer…</option>
                {eligibleReviewers.map((r) => (
                  <option key={r.userId} value={r.userId}>
                    {r.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAssign}
                disabled={mutating || !selectedReviewerId}
                className="rounded-lg bg-cp-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
              >
                {assignment.assignedReviewerUserId ? "Reassign" : "Assign"}
              </button>
              {assignment.assignedReviewerUserId ? (
                <button
                  type="button"
                  onClick={handleUnassign}
                  disabled={mutating}
                  className="rounded-lg border border-cp-border px-3 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  Unassign
                </button>
              ) : null}
            </div>
          )}

          {mutationMessage ? (
            <p
              className={`text-xs font-medium ${mutationMessage.kind === "success" ? "text-emerald-400" : "text-red-400"}`}
              role={mutationMessage.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {mutationMessage.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
