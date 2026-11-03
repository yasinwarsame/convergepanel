"use client";

/**
 * Order B, Stage B3 — the Report Review panel on the Team research page, for research WITHOUT a governed review record
 * (Generic and the other non-Milestone-2 result types). Rendered only when the server-derived `REPORT_REVIEW_ENABLED`
 * is on; while it is off the page keeps the Order A "Approval review" notice exactly as before.
 *
 * Everything shown comes from `GET …/report-review`, whose verdicts (can submit / decide / resubmit / manage assignment)
 * are computed by the same rules the mutations enforce. Those verdicts only decide which controls are offered: every
 * action is re-authorized by the server, so a hidden or disabled control is never the protection.
 *
 * The fixed disclaimer is shown wherever approval can be requested, recorded or viewed. The scope disclosure states
 * which analyses this report does NOT contain; nothing here implies a Unified Answer, consensus, citations or synthesis
 * exists or was verified.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import ReviewAssignmentCard from "@/components/workspace/ReviewAssignmentCard";
import {
  decideReportReviewRequest,
  downloadReportReviewExport,
  fetchReportReviewContext,
  resubmitReportReviewRequest,
  submitReportReviewRequest,
  type ReportReviewContext,
  type ReportReviewExportFormat,
  type ReportReviewMutationResult,
} from "@/lib/client/reportReviewClient";
import {
  MAX_DECISION_COMMENT_CHARS,
  MAX_DECISION_CONDITION_CHARS,
  MAX_DECISION_CONDITIONS,
  REPORT_REVIEW_DECISION_STATUSES,
  REPORT_REVIEW_DISCLAIMER,
  REPORT_REVIEW_INELIGIBLE_EXPLANATIONS,
  REPORT_REVIEW_NOTE_MAX_CHARS,
  REPORT_REVIEW_PURPOSES,
  REPORT_REVIEW_PURPOSE_LABELS,
  reportReviewPurposeLabel,
  reportReviewStatusLabel,
} from "@/lib/governance/reportReviewCopy";
import { APPROVAL_NOT_AVAILABLE_HEADING, APPROVAL_NOT_AVAILABLE_MESSAGE } from "@/lib/workspaces/approvalAssignmentCopy";
import { getReviewStatusBadgeClass } from "@/lib/workspaces/reviewQueuePresentation";

const CARD = "mt-6 rounded-xl border border-cp-border bg-cp-surface p-5 text-sm shadow-sm";
const BUTTON = "rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50";
const SECONDARY = "rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50";

const PANEL_DENIAL_TEXT: Record<string, string> = {
  active_panel: "This research has an open review panel, so report review is unavailable until the panel closes.",
  panel_unreadable: "Report review is unavailable for this research right now.",
};

const DECISION_DENIAL_TEXT: Record<string, string> = {
  submitter: "You submitted this report for approval, so another reviewer must decide it.",
  self_review: "You created this research, so another reviewer must decide it.",
  not_assigned: "Only the assigned reviewer can record a decision.",
  stale_assignment: "The reviewer assignment belongs to an earlier cycle. A manager must assign a reviewer for this cycle.",
  not_open: "",
};

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function charCount(s: string): number {
  return Array.from(s).length;
}

export function ReportReviewDisclaimer() {
  return (
    <p data-testid="report-review-disclaimer" className="mt-3 rounded-lg border border-cp-border-soft bg-cp-raised px-3 py-2 text-xs text-cp-muted">
      {REPORT_REVIEW_DISCLAIMER}
    </p>
  );
}

function mutationMessage(r: ReportReviewMutationResult): string | null {
  if (r.status === "ok") return null;
  if (r.status === "conflict") return r.message ?? "This review changed since you last viewed it. It has been refreshed; please check and try again.";
  if (r.status === "rejected") return r.message ?? "That request could not be accepted.";
  if (r.status === "not_found") return "This action is not available to you.";
  return "Something went wrong on our side. Nothing was changed — please try again.";
}

/** Purpose + optional note, shared by submit and resubmit. Enforces the same limits the server validates. */
function PurposeForm({ submitLabel, pending, onSubmit }: { submitLabel: string; pending: boolean; onSubmit: (purpose: { code: string; note?: string }) => void }) {
  const [code, setCode] = useState<string>("");
  const [note, setNote] = useState("");
  const tooLong = charCount(note.trim()) > REPORT_REVIEW_NOTE_MAX_CHARS;
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!code || tooLong || pending) return;
        const trimmed = note.trim();
        onSubmit(trimmed ? { code, note: trimmed } : { code });
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium text-cp-text">Purpose of this approval</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {REPORT_REVIEW_PURPOSES.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm text-cp-text">
              <input type="radio" name="report-review-purpose" value={p} checked={code === p} onChange={() => setCode(p)} />
              {REPORT_REVIEW_PURPOSE_LABELS[p]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm text-cp-text">
        Note for the reviewer (optional)
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          aria-describedby="report-review-note-count"
          className="mt-1 block w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        />
        <span id="report-review-note-count" className={`mt-1 block text-xs ${tooLong ? "text-red-600" : "text-cp-faint"}`}>
          {charCount(note.trim())} / {REPORT_REVIEW_NOTE_MAX_CHARS} characters
        </span>
      </label>
      <button type="submit" className={BUTTON} disabled={!code || tooLong || pending}>
        {pending ? "Submitting…" : submitLabel}
      </button>
    </form>
  );
}

function DecisionForm({ pending, onDecide }: { pending: boolean; onDecide: (decision: { status: string; comment?: string; conditions?: string[] }) => void }) {
  const [status, setStatus] = useState<string>("");
  const [comment, setComment] = useState("");
  const [conditionsText, setConditionsText] = useState("");
  const conditions = conditionsText
    .split("\n")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const needsConditions = status === "approved_with_conditions";
  const conditionsInvalid = needsConditions && (conditions.length === 0 || conditions.length > MAX_DECISION_CONDITIONS || conditions.some((c) => charCount(c) > MAX_DECISION_CONDITION_CHARS));
  const commentTooLong = charCount(comment.trim()) > MAX_DECISION_COMMENT_CHARS;
  const invalid = !status || conditionsInvalid || commentTooLong;
  return (
    <form
      className="mt-3 space-y-3"
      data-testid="report-review-decision-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid || pending) return;
        const d: { status: string; comment?: string; conditions?: string[] } = { status };
        if (comment.trim()) d.comment = comment.trim();
        if (needsConditions) d.conditions = conditions;
        onDecide(d);
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium text-cp-text">Your decision</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {REPORT_REVIEW_DECISION_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-cp-text">
              <input type="radio" name="report-review-decision" value={s} checked={status === s} onChange={() => setStatus(s)} />
              {reportReviewStatusLabel(s)}
            </label>
          ))}
        </div>
      </fieldset>
      {needsConditions && (
        <label className="block text-sm text-cp-text">
          Conditions (one per line, up to {MAX_DECISION_CONDITIONS})
          <textarea
            value={conditionsText}
            onChange={(e) => setConditionsText(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          />
        </label>
      )}
      <label className="block text-sm text-cp-text">
        Comment (optional)
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          className="mt-1 block w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        />
        {commentTooLong && <span className="mt-1 block text-xs text-red-600">At most {MAX_DECISION_COMMENT_CHARS} characters.</span>}
      </label>
      <ReportReviewDisclaimer />
      <button type="submit" className={BUTTON} disabled={invalid || pending}>
        {pending ? "Recording…" : "Record decision"}
      </button>
    </form>
  );
}

type PanelState = { kind: "loading" } | { kind: "unavailable" } | { kind: "error" } | { kind: "ready"; context: ReportReviewContext };

export default function ReportReviewPanel({ workspaceId, runId, canCreateExport }: { workspaceId: string; runId: string; canCreateExport: boolean }) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Keyed on the signed-in uid (not the user object's identity), so a re-render can never re-trigger the read.
  const uid = user?.uid ?? null;
  const userRef = useRef(user);
  userRef.current = user;
  useEffect(() => {
    if (!authReady || !uid) return;
    const controller = new AbortController();
    void (async () => {
      const r = await fetchReportReviewContext({ workspaceId, runId, user: userRef.current, authReady, signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      setState(r.status === "ok" ? { kind: "ready", context: r.context } : r.status === "not_found" ? { kind: "unavailable" } : { kind: "error" });
    })();
    return () => controller.abort();
  }, [workspaceId, runId, uid, authReady, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  async function run(action: () => Promise<ReportReviewMutationResult>) {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const r = await action();
    if (!mounted.current) return;
    setPending(false);
    setMessage(mutationMessage(r));
    if (r.status === "ok" || r.status === "conflict") reload();
  }

  async function download(format: ReportReviewExportFormat) {
    const r = await downloadReportReviewExport({ workspaceId, runId, user, authReady, format });
    if (r.status !== "ok") {
      setMessage(r.status === "not_found" ? "Export is not available to you." : "The export could not be created. Please try again.");
      return;
    }
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const heading = (
    <h2 id="report-review-heading" className="text-sm font-semibold text-cp-text">
      {APPROVAL_NOT_AVAILABLE_HEADING}
    </h2>
  );

  if (state.kind === "loading") {
    return (
      <section aria-labelledby="report-review-heading" className={CARD} role="status">
        {heading}
        <p className="mt-1 text-cp-muted">Loading approval status…</p>
      </section>
    );
  }
  if (state.kind === "unavailable") {
    // Not authorized to read reviews here (or the run is not reviewable): the pre-B3 Order A notice, unchanged.
    return (
      <section data-testid="approval-not-available-notice" aria-labelledby="report-review-heading" className="mt-6 rounded-xl border border-cp-border bg-cp-raised p-5 text-sm">
        {heading}
        <p className="mt-1 text-cp-muted">{APPROVAL_NOT_AVAILABLE_MESSAGE}</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section aria-labelledby="report-review-heading" className={CARD} role="alert">
        {heading}
        <p className="mt-1 text-cp-muted">We couldn&apos;t load the approval status. Nothing was changed.</p>
        <button type="button" onClick={reload} className={`mt-3 ${SECONDARY}`}>
          Try again
        </button>
      </section>
    );
  }

  const ctx = state.context;
  const feedback = message ? (
    <p role="alert" className="mt-3 text-sm text-cp-orange">
      {message}
    </p>
  ) : null;

  if (ctx.state === "not_submitted") {
    const e = ctx.eligibility;
    return (
      <section data-testid="report-review-panel" aria-labelledby="report-review-heading" className={CARD}>
        {heading}
        {!e.eligible ? (
          <p data-testid="report-review-unavailable-reason" className="mt-1 text-cp-muted">
            {(REPORT_REVIEW_INELIGIBLE_EXPLANATIONS as Record<string, string>)[e.reason] ?? PANEL_DENIAL_TEXT[e.reason] ?? "This research cannot be submitted for approval."}
          </p>
        ) : ctx.viewer.canSubmit ? (
          <>
            <p className="mt-1 text-cp-muted">This research has not been submitted for approval. Choose a purpose and submit it; a manager then assigns a reviewer.</p>
            <ReportReviewDisclaimer />
            <PurposeForm submitLabel="Submit for approval" pending={pending} onSubmit={(purpose) => run(() => submitReportReviewRequest({ workspaceId, runId, user, authReady, purpose }))} />
          </>
        ) : (
          <>
            <p data-testid="report-review-unavailable-reason" className="mt-1 text-cp-muted">
              This research has not been submitted for approval. Only members who can organize research can submit it.
            </p>
            <ReportReviewDisclaimer />
          </>
        )}
        {feedback}
      </section>
    );
  }

  const { record, viewer, names } = ctx;
  const hr = record.humanReview;
  const decided = !(hr.status === "unreviewed" || hr.status === "pending");
  const absent = [record.scope.unifiedAnswer === "absent" ? "a Unified Answer" : null, record.scope.consensus === "absent" ? "a consensus summary" : null, record.scope.synthesis === "absent" ? "a synthesis" : null].filter(Boolean) as string[];
  const decisionDenial = !viewer.canDecide && viewer.denial ? (DECISION_DENIAL_TEXT[viewer.denial] ?? PANEL_DENIAL_TEXT[viewer.denial] ?? "") : "";

  return (
    <section data-testid="report-review-panel" aria-labelledby="report-review-heading" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        <span data-testid="report-review-status" className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${getReviewStatusBadgeClass(hr.status)}`}>
          {reportReviewStatusLabel(hr.status)}
        </span>
        <span className="text-xs text-cp-faint">Review cycle {record.cycle}</span>
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-cp-muted">Purpose</dt>
        <dd className="text-cp-text">
          {reportReviewPurposeLabel(record.purpose.code)}
          {record.purpose.note && <span className="block break-words text-cp-muted">“{record.purpose.note}”</span>}
        </dd>
        <dt className="text-cp-muted">Submitted</dt>
        <dd className="text-cp-text">
          {formatWhen(record.submittedAt)} by {names[record.submittedByUserId] ?? "Unknown user"}
        </dd>
        <dt className="text-cp-muted">Responses</dt>
        <dd className="text-cp-text">
          {record.scope.respondedModels} of {record.scope.requestedModels} models responded
        </dd>
      </dl>
      {absent.length > 0 && (
        <p data-testid="report-review-scope-absent" className="mt-2 text-xs text-cp-muted">
          This report does not contain {absent.join(", ")}. Approval does not add or verify them.
        </p>
      )}

      {decided && (
        <div data-testid="report-review-decision" className="mt-4 rounded-lg border border-cp-border-soft bg-cp-raised px-3 py-2">
          <p className="text-sm text-cp-text">
            <span className="font-medium">{reportReviewStatusLabel(hr.status)}</span> by {hr.reviewerId ? (names[hr.reviewerId] ?? "Unknown user") : "Unknown user"} on {formatWhen(hr.reviewedAt)}
          </p>
          {hr.conditions && hr.conditions.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-sm text-cp-text">
              {hr.conditions.map((c, i) => (
                <li key={i} className="break-words">
                  {c}
                </li>
              ))}
            </ul>
          )}
          {hr.comment && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-cp-muted">{hr.comment}</p>}
        </div>
      )}

      <ReportReviewDisclaimer />

      {!decided && (
        <ReviewAssignmentCard
          workspaceId={workspaceId}
          runId={runId}
          assignment={ctx.assignment.info}
          assignmentRevision={ctx.assignment.revision}
          canManageAssignment={viewer.canManageAssignment}
          onMutated={reload}
        />
      )}

      {viewer.canDecide && (
        <DecisionForm
          pending={pending}
          onDecide={(decision) => run(() => decideReportReviewRequest({ workspaceId, runId, user, authReady, decision, expectedCycle: record.cycle, expectedUpdatedAt: record.updatedAt }))}
        />
      )}
      {!viewer.canDecide && !decided && decisionDenial && (
        <p data-testid="report-review-decision-unavailable" className="mt-3 text-xs text-cp-muted">
          {decisionDenial}
        </p>
      )}

      {viewer.canResubmit && (
        <div className="mt-4 border-t border-cp-border-soft pt-3">
          <p className="text-sm text-cp-text">Submit again to start review cycle {record.cycle + 1}. This cycle&apos;s decision stays in the history unchanged.</p>
          <PurposeForm submitLabel="Submit again" pending={pending} onSubmit={(purpose) => run(() => resubmitReportReviewRequest({ workspaceId, runId, user, authReady, purpose, expectedCycle: record.cycle }))} />
        </div>
      )}

      {feedback}

      {ctx.previousCycles.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-cp-text">Previous review cycles</h3>
          <ul data-testid="report-review-previous-cycles" className="mt-1 space-y-1 text-sm text-cp-muted">
            {ctx.previousCycles.map((c) => (
              <li key={c.cycle}>
                Cycle {c.cycle}: <span className="text-cp-text">{reportReviewStatusLabel(c.status)}</span> ({reportReviewPurposeLabel(c.purposeCode)})
                {c.reviewerId ? ` by ${names[c.reviewerId] ?? "Unknown user"}` : ""}
                {c.reviewedAt ? ` on ${formatWhen(c.reviewedAt)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {ctx.history.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-cp-text">Review history</summary>
          <ol data-testid="report-review-history" className="mt-2 space-y-1 text-xs text-cp-muted">
            {ctx.history.map((h, i) => (
              <li key={i}>
                {formatWhen(h.at)} — cycle {h.cycle}:{" "}
                {h.type === "report_review_submitted"
                  ? `submitted by ${h.actorDisplayName}`
                  : h.type === "report_review_resubmitted"
                    ? `resubmitted by ${h.actorDisplayName}`
                    : h.type === "report_review_decided"
                      ? `${reportReviewStatusLabel(h.status ?? "")} by ${h.actorDisplayName}`
                      : h.reviewerDisplayName
                        ? `reviewer set to ${h.reviewerDisplayName} by ${h.actorDisplayName}`
                        : `reviewer removed by ${h.actorDisplayName}`}
              </li>
            ))}
          </ol>
        </details>
      )}

      {canCreateExport && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-cp-muted">Download the review record:</span>
          <button type="button" className={SECONDARY} onClick={() => download("html")}>
            Document (HTML)
          </button>
          <button type="button" className={SECONDARY} onClick={() => download("json")}>
            Data (JSON)
          </button>
        </div>
      )}
    </section>
  );
}
