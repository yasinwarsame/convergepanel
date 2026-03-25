"use client";

/**
 * Profile: peer-to-peer governance reviewer availability and assign-one-reviewer UI.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";

type ReviewingForRow = { uid: string; email: string; assignedAt: string };

type ReviewerGetResponse = {
  ok?: boolean;
  reviewerEnabled?: boolean;
  reviewingFor?: ReviewingForRow[];
  assignedReviewer?: { email: string; uid: string; assignedAt: string } | null;
};

function formatAssignedDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function GovernanceSettingsSection(props: { onUsageRefresh: () => Promise<void> }) {
  const { user, authReady } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewerEnabled, setReviewerEnabled] = useState(false);
  const [reviewingFor, setReviewingFor] = useState<ReviewingForRow[]>([]);
  const [assignedReviewer, setAssignedReviewer] = useState<ReviewerGetResponse["assignedReviewer"]>(null);

  const [emailInput, setEmailInput] = useState("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [toggleNote, setToggleNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user || !authReady) return;
    setLoading(true);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch("/api/governance/reviewer", {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      const data = (await res.json()) as ReviewerGetResponse;
      if (!res.ok || !data.ok) {
        setReviewerEnabled(false);
        setReviewingFor([]);
        setAssignedReviewer(null);
        return;
      }
      setReviewerEnabled(data.reviewerEnabled === true);
      setReviewingFor(Array.isArray(data.reviewingFor) ? data.reviewingFor : []);
      setAssignedReviewer(data.assignedReviewer ?? null);
    } catch {
      setReviewerEnabled(false);
      setReviewingFor([]);
      setAssignedReviewer(null);
    } finally {
      setLoading(false);
    }
  }, [user, authReady]);

  useEffect(() => {
    void load();
  }, [load]);

  const postAction = async (body: Record<string, unknown>): Promise<Response> => {
    if (!user || !authReady) {
      return new Response(JSON.stringify({ ok: false }), { status: 401 });
    }
    const { authedFetch } = await import("@/lib/client/authedFetch");
    return authedFetch("/api/governance/reviewer", {
      user,
      authReady,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  const onToggle = async (enabled: boolean) => {
    if (!user || !authReady) return;
    if (!enabled && reviewingFor.length > 0) {
      const ok = window.confirm(
        `You're still reviewing for ${reviewingFor.length} user${reviewingFor.length === 1 ? "" : "s"}. Turning this off prevents new assignments but doesn't remove existing ones. Continue?`
      );
      if (!ok) return;
    }
    setSaving(true);
    setToggleNote(null);
    try {
      const res = await postAction({ action: "toggle_reviewer", enabled });
      const data = (await res.json()) as { ok?: boolean; comment?: string; message?: string };
      if (!res.ok) {
        setToggleNote(data?.message || "Could not update availability.");
        return;
      }
      setReviewerEnabled(enabled);
      if (typeof data.comment === "string") setToggleNote(data.comment);
      await props.onUsageRefresh();
      await load();
    } finally {
      setSaving(false);
    }
  };

  const onAssign = async () => {
    if (!user || !authReady) return;
    setAssignError(null);
    setAssignSuccess(null);
    setSaving(true);
    try {
      const res = await postAction({ action: "assign_reviewer", reviewerEmail: emailInput.trim() });
      const data = (await res.json()) as { ok?: boolean; error?: { message?: string }; message?: string; assignedReviewer?: unknown };
      if (!res.ok) {
        setAssignError(data?.error?.message || data?.message || "Assignment failed.");
        return;
      }
      const ar = data.assignedReviewer as { email?: string } | undefined;
      const em = ar?.email || emailInput.trim();
      setAssignSuccess(`✓ Reviewer assigned. ${em} can now review your flagged runs.`);
      setEmailInput("");
      await props.onUsageRefresh();
      await load();
    } finally {
      setSaving(false);
    }
  };

  const onRemove = async () => {
    if (!user || !authReady) return;
    setSaving(true);
    setAssignError(null);
    try {
      const res = await postAction({ action: "remove_reviewer" });
      const data = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!res.ok) {
        setAssignError(data?.error?.message || "Could not remove reviewer.");
        return;
      }
      setRemoveConfirm(false);
      setAssignSuccess(null);
      await props.onUsageRefresh();
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-5">
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500 mb-1">Governance Settings</h2>
      <p className="text-xs text-slate-500 mb-4">
        Control reviewer availability and who can review your flagged research and claim runs.
      </p>

      {loading ? (
        <p className="text-sm text-slate-500">Loading governance settings…</p>
      ) : (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900">Reviewer Availability</h3>
            <p className="mt-2 text-sm text-slate-600">
              Make yourself available as a reviewer for other users. When enabled, other 5-Model plan users can assign
              you to review their flagged research and claim runs.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-slate-700">Available as reviewer:</span>
              <button
                type="button"
                role="switch"
                aria-checked={reviewerEnabled}
                disabled={saving}
                onClick={() => void onToggle(!reviewerEnabled)}
                className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                  reviewerEnabled ? "bg-emerald-600" : "bg-slate-300"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition ${
                    reviewerEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
              <span className="text-sm text-slate-600">{reviewerEnabled ? "On" : "Off"}</span>
            </div>
            {toggleNote && <p className="mt-2 text-xs text-amber-800">{toggleNote}</p>}

            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Currently reviewing for</p>
            {reviewingFor.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No one has assigned you as their reviewer yet.</p>
            ) : (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {reviewingFor.map((r) => (
                  <li key={r.uid}>
                    {r.email || r.uid}{" "}
                    <span className="text-slate-500">(since {formatAssignedDate(r.assignedAt)})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900">Your Reviewer</h3>
            <p className="mt-2 text-sm text-slate-600">
              Assign someone to review your flagged runs. They must be on the 5-Model plan with reviewer availability
              enabled. You can assign one reviewer at a time.
            </p>

            {assignedReviewer ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-slate-800">
                  <span className="font-semibold text-emerald-700">✓</span> Reviewer:{" "}
                  <span className="font-medium">{assignedReviewer.email}</span>
                </p>
                <p className="text-sm text-slate-600">
                  Assigned: {formatAssignedDate(assignedReviewer.assignedAt)}
                </p>
                {!removeConfirm ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setRemoveConfirm(true)}
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
                  >
                    Remove reviewer
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-slate-700">Are you sure?</span>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void onRemove()}
                      className="rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
                    >
                      Yes, remove
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setRemoveConfirm(false)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                <label className="block text-sm font-medium text-slate-700" htmlFor="reviewer-email-input">
                  Reviewer email
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <input
                    id="reviewer-email-input"
                    type="email"
                    autoComplete="email"
                    value={emailInput}
                    onChange={(e) => {
                      setEmailInput(e.target.value);
                      setAssignError(null);
                    }}
                    placeholder="colleague@company.com"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 sm:max-w-md"
                  />
                  <button
                    type="button"
                    disabled={saving || !emailInput.trim()}
                    onClick={() => void onAssign()}
                    className="inline-flex items-center justify-center rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 disabled:opacity-50"
                  >
                    {saving ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Assigning…
                      </span>
                    ) : (
                      "Assign"
                    )}
                  </button>
                </div>
                {assignError && <p className="text-sm text-red-600">{assignError}</p>}
                {assignSuccess && <p className="text-sm text-emerald-700">{assignSuccess}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function GovernancePlanTeaser() {
  return (
    <div className="mt-8 rounded-xl border border-dashed border-slate-300 bg-slate-50/80 p-4 text-sm text-slate-600">
      Governance features are available on the 5-Model plan.{" "}
      <Link href="/pricing" className="font-semibold text-sky-600 hover:text-sky-700">
        Upgrade →
      </Link>
    </div>
  );
}
