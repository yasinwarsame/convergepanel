"use client";

/**
 * Org governance dashboard: review queue, policy editor, audit log.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import type { GovernancePolicy } from "@/lib/governance/evaluateGovernance";
import { getModelDisplayName } from "@/lib/modelInfo";
import {
  formatAuditRunOwnerDisplay,
  formatFullDatetime,
  formatRelativeTime,
  readApiErrorMessage,
  truncateText,
} from "./governanceUtils";
import { maskEmail } from "@/lib/utils/maskEmail";

type TabId = "queue" | "policies" | "audit";

type GovernanceQueueScope = "admin_global" | "assigners" | "no_assigners";

type QueueRow = {
  runId: string;
  collection: "runs" | "verifications" | "videoVerifications";
  runType: "research" | "verification" | "video";
  question: string;
  consensusScore: number | null;
  evidenceQuality: string | null;
  governanceStatus: "approved" | "needs_review" | "blocked";
  governanceReasons: string[];
  modelHealth: { ok: number; substituted: number; failed: number };
  verificationVerdict?: string;
  modelVerdicts?: { modelId: string; verdict: string; confidence: string; summary?: string }[];
  agreementSummary?: string;
  dissentSummary?: string;
  disagreements?: string[];
  agreementPoints?: string[];
  disagreementPoints?: string[];
  correctParts?: string[];
  incorrectParts?: string[];
  keyFindings?: string[];
  claimVerdictSummary?: string;
  createdAt: string;
  userId: string;
  userEmail: string;
  /** ISO timestamp: run owner assigned the current viewer as reviewer */
  ownerAssignedReviewerAt?: string;
  governanceReviewedBy?: string;
  governanceReviewedAt?: string;
  governanceReviewComment?: string;
};

/** Compact email for table/badge; full address via title tooltip. */
function shortenEmailForQueue(emailOrUid: string): string {
  const trimmed = emailOrUid.trim();
  if (!trimmed) return "—";
  const at = trimmed.indexOf("@");
  if (at < 0) return truncateText(trimmed, 18);
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (trimmed.length <= 22) return trimmed;
  const domShort = domain.length > 2 ? `${domain.slice(0, 2)}…` : domain;
  return `${local}@${domShort}`;
}

function formatReviewerAssignedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatQueueClaimVerdictLabel(raw: string | undefined): string {
  if (!raw) return "";
  const k = raw.toLowerCase().replace(/\s+/g, "_");
  const map: Record<string, string> = {
    confirmed: "Confirmed",
    disputed: "Disputed",
    partially_true: "Partially True",
    unverifiable: "Unverifiable",
  };
  return map[k] ?? raw.replace(/_/g, " ");
}

function queueClaimVerdictToneClass(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().replace(/\s+/g, "_");
  if (k === "confirmed") return "text-emerald-700";
  if (k === "disputed") return "text-red-700";
  if (k === "partially_true") return "text-amber-800";
  if (k === "unverifiable") return "text-slate-600";
  return "text-slate-800";
}

const videoVerdictBadge: Record<string, { label: string; colorClass: string }> = {
  authentic_captured: { label: "Camera Footage", colorClass: "bg-green-100 text-green-800" },
  authentic_produced: { label: "Produced Content", colorClass: "bg-blue-100 text-blue-800" },
  likely_manipulated: { label: "Manipulated", colorClass: "bg-red-100 text-red-800" },
  inconclusive: { label: "Inconclusive", colorClass: "bg-amber-100 text-amber-800" },
  insufficient: { label: "Insufficient", colorClass: "bg-gray-100 text-gray-800" },
  authentic: { label: "Authentic", colorClass: "bg-green-100 text-green-800" },
};

function formatQueueVideoVerdictLabel(raw: string | undefined): string {
  if (!raw) return "";
  const k = raw.toLowerCase().replace(/\s+/g, "_");
  return videoVerdictBadge[k]?.label ?? raw.replace(/_/g, " ");
}

function queueVideoVerdictBadgeClass(raw: string | undefined): string {
  const k = (raw ?? "").toLowerCase().replace(/\s+/g, "_");
  return videoVerdictBadge[k]?.colorClass ?? "bg-slate-100 text-slate-800";
}

function queueModelVerdictToneClass(verdict: string): string {
  const s = verdict.toLowerCase();
  if (s === "failed" || s.includes("parse")) return "text-slate-500";
  if (s.includes("partially")) return "text-amber-800";
  if (s.includes("inaccurate")) return "text-red-700";
  if (s.includes("accurate") && !s.includes("inaccurate")) return "text-emerald-700";
  if (s.includes("unverifiable")) return "text-slate-600";
  return "text-slate-800";
}

function queueModelVerdictBadgeClass(verdict: string): string {
  const s = verdict.toLowerCase();
  if (s === "failed" || s.includes("parse")) return "bg-slate-200 text-slate-700";
  if (s === "declined") return "bg-amber-100 text-amber-800 ring-1 ring-amber-300/60";
  if (s === "authentic_captured" || s === "authentic") return "bg-green-100 text-green-800 ring-1 ring-green-300/60";
  if (s === "authentic_produced") return "bg-blue-100 text-blue-800 ring-1 ring-blue-300/60";
  if (s === "likely_manipulated") return "bg-red-100 text-red-800 ring-1 ring-red-300/60";
  if (s === "inconclusive") return "bg-amber-100 text-amber-800 ring-1 ring-amber-300/60";
  if (s === "insufficient") return "bg-gray-100 text-gray-800 ring-1 ring-gray-300/60";
  if (s.includes("partially")) return "bg-amber-100 text-amber-900 ring-1 ring-amber-300/60";
  if (s.includes("inaccurate")) return "bg-red-100 text-red-900 ring-1 ring-red-300/60";
  if (s.includes("accurate") && !s.includes("inaccurate"))
    return "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300/60";
  if (s.includes("unverifiable")) return "bg-slate-100 text-slate-600 ring-1 ring-slate-300/60";
  return "bg-slate-100 text-slate-800 ring-1 ring-slate-300/60";
}

function queueRowUserPresentation(
  row: QueueRow,
  viewerUid: string | null | undefined,
  viewerEmail?: string | null
) {
  const isSelf = Boolean(viewerUid && row.userId && row.userId === viewerUid);
  const rawEmail = (row.userEmail || "").trim();
  const id = (row.userId || "").trim();

  if (isSelf) {
    const full = rawEmail || id || "—";
    return { isSelf, full, displayShort: "You" as const };
  }

  if (rawEmail.includes("@")) {
    const masked = maskEmail(rawEmail, viewerEmail);
    return { isSelf, full: masked, displayShort: masked };
  }

  const fallback = rawEmail || id;
  const full = fallback || "—";
  const displayShort = shortenEmailForQueue(fallback || id);
  return { isSelf, full, displayShort };
}

function queueTableEmptyCopy(params: {
  snapshotLen: number;
  displayedLen: number;
  queueScope: GovernanceQueueScope | null;
  isAdminUser: boolean;
  queueStatus: "needs_review" | "blocked" | "approved" | "all";
  queueRunType: "all" | "research" | "verification" | "video";
}): string {
  if (params.snapshotLen > 0 && params.displayedLen === 0) {
    return "No runs match the current filter. Try another status or type.";
  }
  if (params.snapshotLen === 0) {
    if (params.queueScope === "admin_global" || params.isAdminUser) {
      return "No runs in the system yet.";
    }
    if (params.queueScope === "no_assigners") {
      return "No runs to review. When another user assigns you as their reviewer, their flagged runs will appear here. You can enable reviewer availability in Account → Governance Settings.";
    }
    if (
      params.queueScope === "assigners" &&
      params.queueStatus === "needs_review" &&
      params.queueRunType === "all"
    ) {
      return "No runs need review right now. Runs that fall below policy thresholds will appear here.";
    }
    return "No runs match the current filter. Runs that fall below policy thresholds will appear here when they need review.";
  }
  return "No runs match the current filter. Runs that fall below policy thresholds will appear here when they need review.";
}

function BackToPanelNav({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center gap-2 text-sm font-medium text-slate-600 transition-colors hover:text-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 rounded ${className}`}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
      Back to research and claim verification
    </Link>
  );
}

type AuditEvent = {
  id: string;
  action: string;
  byUid: string;
  byEmail: string;
  at: string;
  comment?: string;
  prevStatus?: string;
  nextStatus?: string;
  reasons?: string[];
  policyVersion?: number;
  changes?: string[];
  runId?: string;
  collection?: string;
  runType?: string;
  runOwnerUid?: string;
  runOwnerEmail?: string;
  question?: string;
  consensusScore?: number | null;
};

type AuditInlineTrailState = {
  eventId: string;
  runId: string;
  collection: "runs" | "verifications" | "videoVerifications";
  events: AuditEvent[];
  loading: boolean;
  error: string | null;
} | null;

function auditActionBadgeLg(action: string): string {
  const base =
    "inline-flex items-center rounded-md px-3 py-1 text-xs font-bold uppercase tracking-wide";
  switch (action) {
    case "approved":
      return `${base} bg-emerald-600 text-white`;
    case "blocked":
      return `${base} bg-red-600 text-white`;
    case "changes_requested":
      return `${base} bg-amber-400 text-amber-950`;
    case "policy_updated":
      return `${base} bg-sky-600 text-white`;
    default:
      return `${base} bg-slate-200 text-slate-800`;
  }
}

function auditActionBadgeSm(action: string): string {
  const base =
    "inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide";
  switch (action) {
    case "approved":
      return `${base} bg-emerald-600 text-white`;
    case "blocked":
      return `${base} bg-red-600 text-white`;
    case "changes_requested":
      return `${base} bg-amber-400 text-amber-950`;
    case "policy_updated":
      return `${base} bg-sky-600 text-white`;
    default:
      return `${base} bg-slate-200 text-slate-800`;
  }
}

function auditCardLeftBorder(action: string): string {
  switch (action) {
    case "approved":
      return "border-l-emerald-500";
    case "blocked":
      return "border-l-red-500";
    case "changes_requested":
      return "border-l-amber-500";
    case "policy_updated":
      return "border-l-sky-600";
    default:
      return "border-l-slate-400";
  }
}

function auditConsensusDisplayClass(score: number): string {
  if (score > 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function actorByLabelForAction(action: string): string {
  switch (action) {
    case "approved":
      return "Reviewed by";
    case "blocked":
      return "Blocked by";
    case "changes_requested":
      return "Feedback by";
    case "policy_updated":
      return "Updated by";
    default:
      return "By";
  }
}

function renderGovernanceStatusToken(status: string) {
  const s = status.trim();
  const cls =
    s === "approved"
      ? "font-semibold text-emerald-600"
      : s === "blocked"
        ? "font-semibold text-red-600"
        : s === "needs_review"
          ? "font-semibold text-amber-600"
          : "font-semibold text-slate-600";
  return <span className={cls}>{s}</span>;
}

function governanceTransitionArrowClass(status: string): string {
  const s = status.trim();
  if (s === "approved") return "text-emerald-600";
  if (s === "blocked") return "text-red-600";
  if (s === "needs_review") return "text-amber-600";
  return "text-slate-400";
}

function AuditResultBlock({ ev }: { ev: AuditEvent }) {
  if (ev.action === "policy_updated") return null;
  const prev = ev.prevStatus?.trim();
  const next = ev.nextStatus?.trim();
  if (prev && next && prev === next) {
    return (
      <p className="text-sm text-slate-800">
        <span className="font-medium text-slate-600">Decision:</span>{" "}
        {renderGovernanceStatusToken(next)}
        <span className="ml-1 text-xs font-normal text-slate-500">
          (no status change — likely duplicate or legacy row)
        </span>
      </p>
    );
  }
  if (prev && next) {
    return (
      <p className="text-sm text-slate-800">
        <span className="font-medium text-slate-600">Decision:</span>{" "}
        {renderGovernanceStatusToken(prev)}
        <span className={`mx-1 font-semibold ${governanceTransitionArrowClass(next)}`}>→</span>
        {renderGovernanceStatusToken(next)}
        {ev.action === "changes_requested" && prev === "needs_review" && next === "needs_review" ? (
          <span className="text-slate-500"> (changes requested)</span>
        ) : null}
      </p>
    );
  }
  if (next) {
    return (
      <p className="text-sm text-slate-800">
        <span className="font-medium text-slate-600">Decision:</span>{" "}
        <span className={`font-semibold ${governanceTransitionArrowClass(next)}`}>→</span>{" "}
        {renderGovernanceStatusToken(next)}
      </p>
    );
  }
  return null;
}

function AuditLogEventCard(props: {
  ev: AuditEvent;
  inlineTrail: AuditInlineTrailState;
  onToggleTrail: () => void;
  currentUserEmail?: string | null;
}) {
  const { ev, inlineTrail, onToggleTrail, currentUserEmail } = props;
  const expanded = inlineTrail?.eventId === ev.id;
  const trail = expanded ? inlineTrail : null;
  const rt = runTypeAuditBadge(ev.runType);
  const runByRaw = formatAuditRunOwnerDisplay(ev.runOwnerEmail);
  const runBy =
    runByRaw.includes("@") ? maskEmail(runByRaw, currentUserEmail) : runByRaw;
  const actorLabel = actorByLabelForAction(ev.action);
  const actorDisplay = auditActorDisplay(ev, currentUserEmail);
  const border = auditCardLeftBorder(ev.action);
  const score =
    typeof ev.consensusScore === "number" && Number.isFinite(ev.consensusScore)
      ? Math.round(ev.consensusScore)
      : null;
  const showTrailBtn = Boolean(ev.runId && ev.runId !== "policy");
  const actionLabel = ev.action.replace(/_/g, " ").toUpperCase();

  return (
    <li className={`rounded-xl border border-slate-200 bg-white shadow-sm border-l-4 ${border}`}>
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 gap-y-2">
          <span className={auditActionBadgeLg(ev.action)}>{actionLabel}</span>
          {rt ? (
            <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${rt.cls}`}>{rt.label}</span>
          ) : null}
          {score != null ? (
            <span
              className={`text-sm font-bold tabular-nums ${auditConsensusDisplayClass(score)}`}
            >
              {score}/100
            </span>
          ) : null}
          <time
            className="ml-auto shrink-0 text-sm text-slate-500"
            title={formatFullDatetime(ev.at)}
            dateTime={ev.at}
          >
            {formatRelativeTime(ev.at)}
          </time>
        </div>

        {ev.action === "policy_updated" ? (
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium text-slate-600">Updated by:</span>{" "}
              <span className="text-slate-800">{actorDisplay}</span>
            </p>
            {typeof ev.policyVersion === "number" ? (
              <p>
                <span className="font-medium text-slate-600">Policy version:</span>{" "}
                <span className="text-slate-800">
                  {ev.policyVersion > 1
                    ? `v${ev.policyVersion - 1} → v${ev.policyVersion}`
                    : `v${ev.policyVersion}`}
                </span>
              </p>
            ) : null}
            {ev.comment?.trim() ? (
              <p>
                <span className="font-medium text-slate-600">Comment:</span>{" "}
                <span className="italic text-slate-700">&quot;{ev.comment}&quot;</span>
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {ev.question ? (
              <p className="text-sm leading-snug text-slate-800">&quot;{ev.question}&quot;</p>
            ) : null}
            <div className="space-y-1.5 text-sm">
              <p>
                <span className="font-medium text-slate-600">Run by:</span>{" "}
                <span className="text-slate-800">{runBy}</span>
              </p>
              <p>
                <span className="font-medium text-slate-600">{actorLabel}:</span>{" "}
                <span className="text-slate-800">{actorDisplay}</span>
              </p>
              <AuditResultBlock ev={ev} />
              {ev.comment?.trim() ? (
                <p>
                  <span className="font-medium text-slate-600">Comment:</span>{" "}
                  <span className="italic text-slate-700">&quot;{ev.comment}&quot;</span>
                </p>
              ) : null}
            </div>
          </>
        )}

        {ev.action !== "policy_updated" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
            {typeof ev.policyVersion === "number" ? (
              <span className="text-xs text-slate-500">Policy: v{ev.policyVersion}</span>
            ) : (
              <span />
            )}
            {showTrailBtn ? (
              <button
                type="button"
                className="text-sm font-semibold text-sky-700 hover:underline"
                onClick={onToggleTrail}
              >
                {expanded ? "Hide trail" : "Open trail →"}
              </button>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </div>

      {expanded && trail ? (
        <div className="border-t border-slate-200 bg-slate-50/90 px-4 py-3 sm:px-5">
          {trail.loading ? (
            <p className="text-sm text-slate-500">Loading event history…</p>
          ) : null}
          {trail.error ? <p className="text-sm text-red-600">{trail.error}</p> : null}
          {!trail.loading && !trail.error && trail.events.length === 0 ? (
            <p className="text-sm text-slate-500">No additional events found for this run.</p>
          ) : null}
          {!trail.loading && !trail.error && trail.events.length > 0 ? (
            <ul className="space-y-2">
              {trail.events.map((e) => (
                <li
                  key={e.id}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className={auditActionBadgeSm(e.action)}>
                      {e.action.replace(/_/g, " ").toUpperCase()}
                    </span>
                    <time
                      className="text-slate-400"
                      title={formatFullDatetime(e.at)}
                      dateTime={e.at}
                    >
                      {formatRelativeTime(e.at)}
                    </time>
                  </div>
                  {auditStatusLine(e) ? (
                    <p className="mt-1 text-slate-600">{auditStatusLine(e)}</p>
                  ) : null}
                  <p className="mt-0.5 text-slate-500">by {auditActorDisplay(e, currentUserEmail)}</p>
                  {e.comment?.trim() ? (
                    <p className="mt-1 italic text-slate-600">&quot;{e.comment}&quot;</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function auditActorDisplay(ev: AuditEvent, currentUserEmail?: string | null): string {
  if (
    ev.byUid === "system" ||
    ev.byEmail === "system@convergepanel.com" ||
    ev.byEmail === "system"
  ) {
    return "System";
  }
  const email = (ev.byEmail || "").trim();
  if (email.includes("@")) return maskEmail(email, currentUserEmail);
  return (ev.byUid || "—").trim() || "—";
}

function auditStatusLine(ev: AuditEvent): string | null {
  if (ev.action === "policy_updated") {
    if (typeof ev.policyVersion === "number") return `Policy v${ev.policyVersion}`;
    return null;
  }
  const prev = ev.prevStatus?.trim();
  const next = ev.nextStatus?.trim();
  if (prev && next && prev === next) return `${next} (no change)`;
  if (prev && next) return `${prev} → ${next}`;
  if (next) return `→ ${next}`;
  if (prev) return `${prev} →`;
  return null;
}

function runTypeAuditBadge(runType: string | undefined): { label: string; cls: string } | null {
  if (runType === "claim") return { label: "CLAIM", cls: "bg-violet-100 text-violet-900" };
  if (runType === "video") return { label: "VIDEO", cls: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300" };
  if (runType === "research") return { label: "RESEARCH", cls: "bg-slate-200 text-slate-800" };
  return null;
}

const VERDICTS: { key: string; label: string }[] = [
  { key: "Disputed", label: "Disputed" },
  { key: "Unverifiable", label: "Unverifiable" },
  { key: "Partially True", label: "Partially True" },
  { key: "Confirmed", label: "Confirmed" },
];

function statusChipClasses(status: string): { wrap: string; label: string } {
  if (status === "blocked") {
    return {
      wrap: "bg-red-600 text-white",
      label: "Blocked",
    };
  }
  if (status === "approved") {
    return {
      wrap: "bg-emerald-100 text-emerald-900",
      label: "Approved",
    };
  }
  return {
    wrap: "bg-amber-100 text-amber-950",
    label: "Review",
  };
}

function consensusColor(score: number | null): string {
  if (score == null) return "text-slate-400";
  if (score > 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function evidenceChip(eq: string | null): { text: string; cls: string } {
  if (!eq) return { text: "—", cls: "bg-slate-100 text-slate-500" };
  const l = eq.toLowerCase();
  if (l === "strong") return { text: "Strong", cls: "bg-emerald-100 text-emerald-800" };
  if (l === "weak") return { text: "Weak", cls: "bg-red-100 text-red-800" };
  return { text: "Mixed", cls: "bg-amber-100 text-amber-900" };
}

function modelHealthDisplay(mh: QueueRow["modelHealth"]): { text: string; cls: string; title: string } {
  const total = mh.ok + mh.substituted + mh.failed;
  const problems = mh.substituted + mh.failed;
  const title = `OK: ${mh.ok}, substituted: ${mh.substituted}, failed: ${mh.failed}`;
  if (total === 0) return { text: "—", cls: "text-slate-400", title };
  if (problems === 0) return { text: `${mh.ok}/${total}`, cls: "text-emerald-600 font-semibold", title };
  if (problems === 1) return { text: `${mh.ok}/${total}`, cls: "text-amber-600 font-semibold", title };
  return { text: `${mh.ok}/${total}`, cls: "text-red-600 font-semibold", title };
}

type ReviewModalMode = "blocked" | "changes_requested" | null;

function ReviewModal(props: {
  mode: ReviewModalMode;
  row: QueueRow | null;
  onClose: () => void;
  onSubmit: (comment: string) => Promise<void>;
}) {
  const { mode, row, onClose, onSubmit } = props;
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setComment("");
    setErr(null);
    setBusy(false);
  }, [mode, row?.runId]);

  if (!mode || !row) return null;

  const isBlock = mode === "blocked";
  const title = isBlock ? "Block this run" : "Request changes on this run";
  const consensus =
    row.consensusScore == null ? "—" : `${Math.round(row.consensusScore)}/100`;
  const statusLabel =
    row.governanceStatus === "needs_review"
      ? "Needs Review"
      : row.governanceStatus === "blocked"
        ? "Blocked"
        : "Approved";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gov-review-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <h2 id="gov-review-modal-title" className="text-lg font-bold text-slate-900">
          {title}
        </h2>
        <div className="mt-4 space-y-2 text-sm text-slate-600">
          <p>
            <span className="font-medium text-slate-700">Run:</span>{" "}
            {truncateText(row.question, 120)}
          </p>
          <p>
            <span className="font-medium text-slate-700">Current status:</span> {statusLabel}
          </p>
          <p>
            <span className="font-medium text-slate-700">Consensus:</span> {consensus}
          </p>
        </div>
        <label className="mt-4 block text-sm font-medium text-slate-700">
          Comment (required)
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            placeholder="Explain the decision for the audit trail…"
          />
        </label>
        <p className="mt-2 text-xs text-slate-500">
          {isBlock
            ? "This will mark the run as blocked in the governance audit trail."
            : "This will keep the run in the review queue with your feedback attached."}
        </p>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!comment.trim() || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onSubmit(comment.trim());
                onClose();
              } catch (e) {
                setErr(e instanceof Error ? e.message : "Request failed");
              } finally {
                setBusy(false);
              }
            }}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
              isBlock ? "bg-red-600 hover:bg-red-700" : "bg-amber-500 hover:bg-amber-600"
            }`}
          >
            {busy ? "…" : isBlock ? "Confirm Block" : "Submit Feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function GovernanceDashboard() {
  const router = useRouter();
  const { user, loading: authLoading, authReady } = useAuth();
  const { loading: planLoading, governanceDashboardEligible, governancePolicyEditable } = useUserPlan();
  const isAdminUser = governancePolicyEditable === true;

  const [tab, setTab] = useState<TabId>("queue");

  const [queueStatus, setQueueStatus] = useState<"needs_review" | "blocked" | "approved" | "all">(
    "needs_review"
  );
  const [queueRunType, setQueueRunType] = useState<"all" | "research" | "verification" | "video">("all");
  /** Last full snapshot from a single `/api/governance/queue` call (status=all; stats derived client-side). */
  const [queueSnapshot, setQueueSnapshot] = useState<QueueRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [queueScope, setQueueScope] = useState<GovernanceQueueScope | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const [toast, setToast] = useState<string | null>(null);
  const [reviewModal, setReviewModal] = useState<{
    mode: ReviewModalMode;
    row: QueueRow | null;
  }>({ mode: null, row: null });

  const [policy, setPolicy] = useState<GovernancePolicy | null>(null);
  const [policyBaseline, setPolicyBaseline] = useState<GovernancePolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyFormError, setPolicyFormError] = useState<string | null>(null);
  const [policySaveNote, setPolicySaveNote] = useState("");
  const [showPolicyNote, setShowPolicyNote] = useState(false);

  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditViewMode, setAuditViewMode] = useState<"recent" | "search">("recent");
  const [auditFromDate, setAuditFromDate] = useState("");
  const [auditToDate, setAuditToDate] = useState("");
  const [auditSearchRunType, setAuditSearchRunType] = useState<"all" | "claim" | "research" | "video">("all");
  const [auditInlineTrail, setAuditInlineTrail] = useState<AuditInlineTrailState>(null);

  const [approveFlash, setApproveFlash] = useState<Record<string, string>>({});

  /** Auto queue fetches only; manual Refresh resets retry counter. */
  const queueAutoFailureCountRef = useRef(0);
  /** One automatic snapshot load per queue-tab visit (per login); reset on manual Refresh. */
  const queueFetchedRef = useRef(false);
  /** One automatic audit load per audit-tab visit (per login); reset when user changes. */
  const auditFetchedRef = useRef(false);
  const MAX_QUEUE_AUTO_RETRIES = 2;
  /** Prevents duplicate POSTs to /api/governance/review (double-click / rapid actions). */
  const reviewInFlightRef = useRef<string | null>(null);
  const [reviewBusyKey, setReviewBusyKey] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  const loadQueueSnapshot = useCallback(
    async (options?: { manual?: boolean }) => {
      if (!user || !authReady) return;

      if (options?.manual) {
        queueFetchedRef.current = false;
        queueAutoFailureCountRef.current = 0;
        setQueueError(null);
        setQueueNotice(null);
      } else if (queueAutoFailureCountRef.current >= MAX_QUEUE_AUTO_RETRIES) {
        setQueueError("Queue is temporarily unavailable. Please try again later.");
        return;
      }

      setQueueLoading(true);
      if (!options?.manual) {
        setQueueError(null);
        setQueueNotice(null);
      }
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const q = new URLSearchParams({
          status: "all",
          runType: "all",
          limit: "50",
          offset: "0",
        });
        const res = await authedFetch(`/api/governance/queue?${q}`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        if (!res.ok) {
          queueAutoFailureCountRef.current += 1;
          const msg = await readApiErrorMessage(res, "Could not load queue.");
          setQueueError(
            queueAutoFailureCountRef.current >= MAX_QUEUE_AUTO_RETRIES
              ? "Queue is temporarily unavailable. Please try again later."
              : msg
          );
          setQueueSnapshot([]);
          setQueueNotice(null);
          setQueueScope(null);
          return;
        }
        const data = (await res.json()) as {
          ok?: boolean;
          runs?: QueueRow[];
          queueNotice?: string;
          queueScope?: string;
        };
        if (!data.ok) {
          queueAutoFailureCountRef.current += 1;
          setQueueError(
            queueAutoFailureCountRef.current >= MAX_QUEUE_AUTO_RETRIES
              ? "Queue is temporarily unavailable. Please try again later."
              : "Could not load queue."
          );
          setQueueSnapshot([]);
          setQueueNotice(null);
          setQueueScope(null);
          return;
        }
        queueAutoFailureCountRef.current = 0;
        setQueueSnapshot(data.runs ?? []);
        setQueueError(null);
        setQueueNotice(typeof data.queueNotice === "string" && data.queueNotice.trim() ? data.queueNotice : null);
        const qs = data.queueScope;
        setQueueScope(
          qs === "admin_global" || qs === "assigners" || qs === "no_assigners" ? qs : null
        );
        if (options?.manual) queueFetchedRef.current = true;
      } catch {
        queueAutoFailureCountRef.current += 1;
        setQueueError(
          queueAutoFailureCountRef.current >= MAX_QUEUE_AUTO_RETRIES
            ? "Queue is temporarily unavailable. Please try again later."
            : "Could not load queue."
        );
        setQueueNotice(null);
        setQueueScope(null);
      } finally {
        setQueueLoading(false);
      }
    },
    [user, authReady]
  );

  const queueStats = useMemo(() => {
    let needs = 0;
    let blocked = 0;
    let approved = 0;
    for (const r of queueSnapshot) {
      if (r.governanceStatus === "needs_review") needs += 1;
      else if (r.governanceStatus === "blocked") blocked += 1;
      else if (r.governanceStatus === "approved") approved += 1;
    }
    return {
      needs,
      blocked,
      approved,
      total: queueSnapshot.length,
    };
  }, [queueSnapshot]);

  const displayedQueueRows = useMemo(() => {
    let rows = queueSnapshot;
    if (queueRunType !== "all") {
      rows = rows.filter((r) => {
        if (queueRunType === "research") return r.runType === "research";
        if (queueRunType === "verification") return r.runType === "verification";
        return r.runType === "video";
      });
    }
    if (queueStatus !== "all") {
      rows = rows.filter((r) => r.governanceStatus === queueStatus);
    }
    return rows.slice(0, 50);
  }, [queueSnapshot, queueRunType, queueStatus]);

  const fetchPolicy = useCallback(async () => {
    if (!user || !authReady) return;
    setPolicyLoading(true);
    setPolicyError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch("/api/governance/policy", {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        setPolicyError(await readApiErrorMessage(res, "Could not load policy."));
        return;
      }
      const data = (await res.json()) as { ok?: boolean; policy?: GovernancePolicy };
      if (process.env.NODE_ENV !== "production") {
        console.log("[governance/policies] API response:", data);
      }
      if (data.ok && data.policy) {
        setPolicy(data.policy);
        setPolicyBaseline(data.policy);
        if (process.env.NODE_ENV !== "production") {
          console.log("[governance/policies] Fetched policy:", data.policy);
        }
      } else {
        setPolicyError("Could not load policy.");
      }
    } catch {
      setPolicyError("Could not load policy.");
    } finally {
      setPolicyLoading(false);
    }
  }, [user, authReady]);

  const fetchAuditRecent = useCallback(async () => {
    if (!user || !authReady) return;
    setAuditInlineTrail(null);
    setAuditLoading(true);
    setAuditError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch("/api/governance/audit?limit=20", {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        setAuditError(await readApiErrorMessage(res, "Could not load audit log."));
        return;
      }
      const data = (await res.json()) as { ok?: boolean; events?: AuditEvent[] };
      if (process.env.NODE_ENV !== "production") {
        console.log("[audit tab] API response:", { ok: data.ok, count: data.events?.length });
      }
      if (data.ok && Array.isArray(data.events)) {
        setAuditEvents(data.events);
        setAuditViewMode("recent");
      } else {
        setAuditError("Could not load audit log.");
      }
    } catch {
      setAuditError("Could not load audit log.");
    } finally {
      setAuditLoading(false);
    }
  }, [user, authReady]);

  const runAuditDateSearch = useCallback(async () => {
    if (!user || !authReady) return;
    setAuditInlineTrail(null);
    setAuditLoading(true);
    setAuditError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const from =
        auditFromDate.trim() !== "" ? new Date(auditFromDate).toISOString() : "";
      const to =
        auditToDate.trim() !== ""
          ? new Date(`${auditToDate}T23:59:59`).toISOString()
          : "";
      const q = new URLSearchParams({ limit: "50" });
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (auditSearchRunType !== "all") q.set("runType", auditSearchRunType);
      const res = await authedFetch(`/api/governance/audit?${q}`, {
        user,
        authReady,
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) {
        setAuditError(await readApiErrorMessage(res, "Search failed."));
        return;
      }
      const data = (await res.json()) as { ok?: boolean; events?: AuditEvent[] };
      if (data.ok && Array.isArray(data.events)) {
        setAuditEvents(data.events);
        setAuditViewMode("search");
      } else {
        setAuditError("Search failed.");
      }
    } catch {
      setAuditError("Search failed.");
    } finally {
      setAuditLoading(false);
    }
  }, [user, authReady, auditFromDate, auditToDate, auditSearchRunType]);

  useEffect(() => {
    if (tab !== "queue" || !user || !authReady || queueFetchedRef.current) return;
    queueFetchedRef.current = true;
    void loadQueueSnapshot();
  }, [tab, user, authReady, loadQueueSnapshot]);

  useEffect(() => {
    if (tab === "policies" && user && authReady) {
      void fetchPolicy();
    }
  }, [tab, user, authReady, fetchPolicy]);

  useEffect(() => {
    if (tab !== "policies" || process.env.NODE_ENV === "production") return;
    console.log("[governance/policies] Loading:", policyLoading, "Error:", policyError, "policy:", policy);
  }, [tab, policyLoading, policyError, policy]);

  /* Auto-load recent audit events when the Audit tab is active (no runId required). */
  useEffect(() => {
    if (tab !== "audit" || !user || !authReady || auditFetchedRef.current) return;
    auditFetchedRef.current = true;
    void fetchAuditRecent();
  }, [tab, user, authReady, fetchAuditRecent]);

  useEffect(() => {
    if (tab !== "audit") setAuditInlineTrail(null);
  }, [tab]);

  useEffect(() => {
    if (authLoading || !authReady) return;
    if (!user) {
      router.push("/login");
    }
  }, [authLoading, authReady, user, router]);

  useEffect(() => {
    queueAutoFailureCountRef.current = 0;
    queueFetchedRef.current = false;
    auditFetchedRef.current = false;
    setQueueError(null);
    setQueueNotice(null);
  }, [user?.uid]);

  const policyDirty = useMemo(() => {
    if (!policy || !policyBaseline) return false;
    return JSON.stringify(policy) !== JSON.stringify(policyBaseline);
  }, [policy, policyBaseline]);

  const policyValidationError = useMemo(() => {
    if (!policy) return null;
    if (policy.minConsensusToApprove < policy.minConsensusToAvoidReview) {
      return "Auto-approve threshold must be greater than or equal to the review threshold.";
    }
    if (policy.sensitiveDomainsEnabled) {
      if (policy.sensitiveMinConsensusToApprove < policy.sensitiveMinConsensusToAvoidReview) {
        return "Sensitive approval threshold must be ≥ sensitive review threshold.";
      }
    }
    return null;
  }, [policy]);

  const updateRowAfterReview = (row: QueueRow, newStatus: QueueRow["governanceStatus"], comment: string) => {
    setQueueSnapshot((prev) =>
      prev.map((r) =>
        r.runId === row.runId && r.collection === row.collection
          ? {
              ...r,
              governanceStatus: newStatus,
              governanceReviewedBy: user?.uid,
              governanceReviewedAt: new Date().toISOString(),
              governanceReviewComment: comment,
            }
          : r
      )
    );
  };

  const submitReview = async (
    row: QueueRow,
    action: "approved" | "blocked" | "changes_requested",
    comment: string
  ) => {
    if (!user || !authReady) throw new Error("Sign in required.");
    const k = `${row.collection}:${row.runId}`;
    if (reviewInFlightRef.current) {
      throw new Error("A review is already in progress. Please wait.");
    }
    reviewInFlightRef.current = k;
    setReviewBusyKey(k);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch("/api/governance/review", {
        user,
        authReady,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: row.runId,
          collection: row.collection,
          action,
          comment,
        }),
      });
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, "Review action failed."));
      }
      const data = (await res.json()) as { newStatus?: string };
      const ns = (data.newStatus as QueueRow["governanceStatus"]) || row.governanceStatus;
      updateRowAfterReview(row, ns, comment);
      if (action === "approved") {
        setApproveFlash((f) => ({ ...f, [k]: "Approved by you just now" }));
        window.setTimeout(() => {
          setApproveFlash((f) => {
            const n = { ...f };
            delete n[k];
            return n;
          });
        }, 8000);
      }
      showToast("Updated");
    } finally {
      if (reviewInFlightRef.current === k) reviewInFlightRef.current = null;
      setReviewBusyKey((cur) => (cur === k ? null : cur));
    }
  };

  const handleApproveRow = async (row: QueueRow) => {
    try {
      await submitReview(
        row,
        "approved",
        "Approved via governance dashboard"
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Approve failed");
    }
  };

  const policyPatchPayload = (): Record<string, unknown> => {
    if (!policy || !policyBaseline) return {};
    const patch: Record<string, unknown> = {};
    (Object.keys(policyBaseline) as (keyof GovernancePolicy)[]).forEach((k) => {
      if (k === "policyVersion") return;
      if (JSON.stringify(policy[k]) !== JSON.stringify(policyBaseline[k])) {
        patch[k] = policy[k];
      }
    });
    return patch;
  };

  const savePolicy = async () => {
    if (!user || !authReady || !policy || !isAdminUser) return;
    if (policyValidationError) {
      setPolicyFormError(policyValidationError);
      return;
    }
    const patch = policyPatchPayload();
    if (Object.keys(patch).length === 0) return;
    setPolicySaving(true);
    setPolicyFormError(null);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const body: Record<string, unknown> = { ...patch };
      if (policySaveNote.trim()) body.comment = policySaveNote.trim();
      const res = await authedFetch("/api/governance/policy", {
        user,
        authReady,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await readApiErrorMessage(res, "Could not save policy.");
        setPolicyFormError(msg);
        return;
      }
      const data = (await res.json()) as { ok?: boolean; policy?: GovernancePolicy };
      if (data.ok && data.policy) {
        setPolicy(data.policy);
        setPolicyBaseline(data.policy);
        setPolicySaveNote("");
        setShowPolicyNote(false);
        showToast(`Policy updated to v${data.policy.policyVersion}`);
      }
    } finally {
      setPolicySaving(false);
    }
  };

  const toggleAuditInlineTrail = useCallback(
    async (ev: AuditEvent) => {
      if (!user || !authReady) return;
      if (!ev.runId || ev.runId === "policy") return;
      const coll =
        (ev.collection as "runs" | "verifications" | "videoVerifications") ||
        ("runs" as const);

      if (auditInlineTrail?.eventId === ev.id) {
        setAuditInlineTrail(null);
        return;
      }

      setAuditInlineTrail({
        eventId: ev.id,
        runId: ev.runId,
        collection: coll,
        events: [],
        loading: true,
        error: null,
      });

      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const q = new URLSearchParams({ runId: ev.runId, collection: coll, limit: "100" });
        const res = await authedFetch(`/api/governance/audit?${q}`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        if (!res.ok) {
          const errMsg = await readApiErrorMessage(res, "Could not load run events.");
          setAuditInlineTrail((cur) =>
            cur?.eventId === ev.id ? { ...cur, loading: false, error: errMsg } : cur
          );
          return;
        }
        const data = (await res.json()) as { ok?: boolean; events?: AuditEvent[] };
        const evs = (data.events ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
        setAuditInlineTrail((cur) =>
          cur?.eventId === ev.id ? { ...cur, events: evs, loading: false, error: null } : cur
        );
      } catch {
        setAuditInlineTrail((cur) =>
          cur?.eventId === ev.id
            ? { ...cur, loading: false, error: "Could not load run events." }
            : cur
        );
      }
    },
    [user, authReady, auditInlineTrail?.eventId]
  );

  if (authLoading || !authReady) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <BackToPanelNav className="mb-8" />
        <div className="py-12 text-center text-slate-500">
          <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
          <p className="mt-4 text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <BackToPanelNav className="mb-8" />
        <div className="py-8 text-center text-slate-500">
          <p className="text-sm">Redirecting to sign in…</p>
          <p className="mt-4 text-sm">
            <Link href="/login" className="font-semibold text-sky-700 underline hover:text-sky-800">
              Go to sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (!planLoading && !governanceDashboardEligible) {
    return (
      <div className="mx-auto max-w-lg px-4 py-8">
        <BackToPanelNav className="mb-6" />
        <div className="rounded-2xl border border-sky-200 bg-gradient-to-b from-sky-50 to-white p-8 shadow-md ring-1 ring-sky-100">
          <div className="text-4xl" aria-hidden>
            📊
          </div>
          <h1 className="mt-4 text-xl font-bold text-slate-900">Governance Dashboard</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            Governance features are available on the 5-Model plan.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Get policy enforcement, review queue, and audit trails to govern how your team uses AI research and
            claims.
          </p>
          <ul className="mt-5 space-y-2 text-left text-sm text-slate-700">
            <li className="flex gap-2">
              <span className="font-semibold text-emerald-600">✓</span>
              <span>Set consensus thresholds for auto-approval</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-emerald-600">✓</span>
              <span>Flag weak evidence and disputed claims for review</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-emerald-600">✓</span>
              <span>Review and approve team runs before they&apos;re acted on</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-emerald-600">✓</span>
              <span>Export audit trails for compliance</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-emerald-600">✓</span>
              <span>Detect sensitive domains (legal, medical, financial)</span>
            </li>
          </ul>
          <Link
            href="/pricing"
            className="mt-8 inline-flex w-full items-center justify-center rounded-lg bg-sky-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-sky-700"
          >
            Upgrade to 5-Model Plan →
          </Link>
        </div>
      </div>
    );
  }

  const tabBtn = (id: TabId, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => {
        setTab(id);
      }}
      className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl border-2 px-5 py-3.5 text-lg font-bold tracking-tight transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 md:text-xl sm:min-w-[160px] sm:flex-none ${
        tab === id
          ? "border-sky-800 bg-sky-600 text-white shadow-md ring-2 ring-sky-500/40"
          : "border-slate-300 bg-white text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 pb-24">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[110] -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <BackToPanelNav className="mb-6" />

      <header className="mb-8 border-b border-slate-200 pb-6">
        <h1 className="text-2xl font-bold text-slate-900 md:text-3xl">Governance Dashboard</h1>
        <p className="mt-2 text-slate-600">
          Review runs, manage policies, and track governance activity
        </p>
      </header>

      <div
        className="mb-8 rounded-xl border-2 border-slate-200 bg-gradient-to-b from-slate-50 to-slate-100/80 p-2 shadow-sm"
        role="tablist"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {tabBtn("queue", "Review Queue")}
          {tabBtn("policies", "Policies")}
          {tabBtn("audit", "Audit Log")}
        </div>
      </div>

      {tab === "queue" && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-6 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <div>
              <span className="text-slate-500">Needs Review:</span>{" "}
              <span className="font-bold text-amber-600">
                {queueLoading ? "…" : queueStats.needs}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Blocked:</span>{" "}
              <span className="font-bold text-red-600">{queueLoading ? "…" : queueStats.blocked}</span>
            </div>
            <div>
              <span className="text-slate-500">Approved:</span>{" "}
              <span className="font-bold text-emerald-600">
                {queueLoading ? "…" : queueStats.approved}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Total:</span>{" "}
              <span className="font-bold text-slate-800">
                {queueLoading ? "…" : queueStats.total}
              </span>
            </div>
          </div>

          {queueNotice && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 shadow-sm">
              {queueNotice}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              Status
              <select
                value={queueStatus}
                onChange={(e) =>
                  setQueueStatus(e.target.value as typeof queueStatus)
                }
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="needs_review">Needs Review</option>
                <option value="blocked">Blocked</option>
                <option value="approved">Approved</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              Type
              <select
                value={queueRunType}
                onChange={(e) =>
                  setQueueRunType(e.target.value as typeof queueRunType)
                }
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="all">All</option>
                <option value="research">Research</option>
                <option value="verification">Claims</option>
                <option value="video">Video</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void loadQueueSnapshot({ manual: true })}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              ↻ Refresh
            </button>
          </div>

          {queueError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {queueError}{" "}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => void loadQueueSnapshot({ manual: true })}
              >
                Retry
              </button>
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            {queueLoading ? (
              <div className="space-y-2 p-4">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded bg-slate-100" />
                ))}
              </div>
            ) : displayedQueueRows.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-500">
                {queueTableEmptyCopy({
                  snapshotLen: queueSnapshot.length,
                  displayedLen: displayedQueueRows.length,
                  queueScope,
                  isAdminUser,
                  queueStatus,
                  queueRunType,
                })}
              </p>
            ) : (
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Status</th>
                    <th className="hidden px-3 py-2 md:table-cell">User</th>
                    <th className="px-3 py-2">Query/Claim</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Consensus</th>
                    <th className="hidden px-3 py-2 md:table-cell">Evidence</th>
                    <th className="hidden px-3 py-2 md:table-cell">Models</th>
                    <th className="hidden px-3 py-2 md:table-cell">Reasons</th>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayedQueueRows.map((row) => {
                    const chip = statusChipClasses(row.governanceStatus);
                    const mh = modelHealthDisplay(row.modelHealth);
                    const ev = evidenceChip(row.evidenceQuality);
                    const exp = expanded.has(`${row.collection}:${row.runId}`);
                    const reasons = row.governanceReasons ?? [];
                    const firstReason = reasons[0] ?? "—";
                    const more = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : "";
                    return (
                      <FragmentRow
                        key={`${row.collection}:${row.runId}`}
                        row={row}
                        currentUserUid={user?.uid}
                        currentUserEmail={user?.email}
                        chip={chip}
                        mh={mh}
                        ev={ev}
                        exp={exp}
                        firstReason={firstReason}
                        more={more}
                        consensusColor={consensusColor}
                        expanded={expanded}
                        setExpanded={setExpanded}
                        approveHint={approveFlash[`${row.collection}:${row.runId}`]}
                        reviewBusyKey={reviewBusyKey}
                        onApprove={() => void handleApproveRow(row)}
                        onBlock={() => setReviewModal({ mode: "blocked", row })}
                        onChanges={() => setReviewModal({ mode: "changes_requested", row })}
                      />
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === "policies" && (
        <div className="space-y-6">
          {policyError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              Failed to load policy.{" "}
              <button type="button" className="font-semibold underline" onClick={() => void fetchPolicy()}>
                Retry
              </button>
            </div>
          )}
          {policyLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : policy ? (
            <>
              {!isAdminUser && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  Only admins can modify governance policies. You have read-only access.
                </p>
              )}
              <div className="space-y-6">
                <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Consensus Thresholds</h2>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="text-sm text-slate-700">
                      Auto-approve above
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={!isAdminUser}
                        value={policy.minConsensusToApprove}
                        onChange={(e) =>
                          setPolicy((p) =>
                            p ? { ...p, minConsensusToApprove: Number(e.target.value) } : p
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-100"
                      />
                      <span className="text-slate-500"> /100</span>
                    </label>
                    <label className="text-sm text-slate-700">
                      Flag for review below
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={!isAdminUser}
                        value={policy.minConsensusToAvoidReview}
                        onChange={(e) =>
                          setPolicy((p) =>
                            p ? { ...p, minConsensusToAvoidReview: Number(e.target.value) } : p
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-100"
                      />
                      <span className="text-slate-500"> /100</span>
                    </label>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Runs scoring between these values are auto-approved. Runs below the review threshold go to
                    the Review Queue.
                  </p>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-slate-900">Sensitive Domain Detection</h2>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        disabled={!isAdminUser}
                        checked={policy.sensitiveDomainsEnabled}
                        onChange={(e) =>
                          setPolicy((p) =>
                            p ? { ...p, sensitiveDomainsEnabled: e.target.checked } : p
                          )
                        }
                      />
                      ON/OFF
                    </label>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">
                    Apply stricter thresholds for legal, medical, and financial queries.
                  </p>
                  <div
                    className={`mt-4 grid gap-4 sm:grid-cols-2 ${!policy.sensitiveDomainsEnabled ? "opacity-40" : ""}`}
                  >
                    <label className="text-sm text-slate-700">
                      Approval threshold
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={!isAdminUser || !policy.sensitiveDomainsEnabled}
                        value={policy.sensitiveMinConsensusToApprove}
                        onChange={(e) =>
                          setPolicy((p) =>
                            p ? { ...p, sensitiveMinConsensusToApprove: Number(e.target.value) } : p
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-100"
                      />
                    </label>
                    <label className="text-sm text-slate-700">
                      Review threshold
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={!isAdminUser || !policy.sensitiveDomainsEnabled}
                        value={policy.sensitiveMinConsensusToAvoidReview}
                        onChange={(e) =>
                          setPolicy((p) =>
                            p ? { ...p, sensitiveMinConsensusToAvoidReview: Number(e.target.value) } : p
                          )
                        }
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-100"
                      />
                    </label>
                  </div>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">Evidence &amp; Model Quality</h2>
                  <div className="mt-4 space-y-3 text-sm text-slate-800">
                    {(
                      [
                        ["reviewIfEvidenceQualityWeak", "Flag if evidence quality is weak"],
                        [
                          "blockIfSourceBackedMissingSources",
                          "Block if source-backed run has missing sources",
                        ],
                        ["reviewIfAnyModelSubstituted", "Flag if any model was substituted"],
                        ["reviewIfAnyModelFailed", "Flag if any model failed"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          disabled={!isAdminUser}
                          className="mt-1"
                          checked={!!policy[key]}
                          onChange={(e) =>
                            setPolicy((p) => (p ? { ...p, [key]: e.target.checked } : p))
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">
                    Claim verdicts that require review
                  </h2>
                  <div className="mt-4 space-y-2 text-sm">
                    {VERDICTS.map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          disabled={!isAdminUser}
                          checked={policy.reviewIfVerificationVerdictIn.includes(key)}
                          onChange={(e) => {
                            setPolicy((p) => {
                              if (!p) return p;
                              const set = new Set(p.reviewIfVerificationVerdictIn);
                              if (e.target.checked) set.add(key);
                              else set.delete(key);
                              return {
                                ...p,
                                reviewIfVerificationVerdictIn: Array.from(set),
                              };
                            });
                          }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Claims with these verdicts will be sent to the Review Queue.
                  </p>
                </section>
              </div>

              {(policyFormError || policyValidationError) && (
                <p className="text-sm text-red-600">{policyFormError || policyValidationError}</p>
              )}

              <div className="sticky bottom-0 z-10 flex flex-col gap-3 border-t border-slate-200 bg-slate-50/95 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-slate-600">
                  Policy version:{" "}
                  <span className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-xs font-semibold">
                    v{policy.policyVersion}
                  </span>
                </div>
                {isAdminUser && (
                  <div className="flex flex-col gap-2 sm:items-end">
                    {showPolicyNote && (
                      <label className="w-full max-w-md text-xs text-slate-600">
                        Add a note about this change (optional)
                        <input
                          value={policySaveNote}
                          onChange={(e) => setPolicySaveNote(e.target.value)}
                          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                        />
                      </label>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowPolicyNote((s) => !s)}
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-white"
                      >
                        {showPolicyNote ? "Hide note" : "Add note"}
                      </button>
                      <button
                        type="button"
                        disabled={!policyDirty || !!policyValidationError || policySaving}
                        onClick={() => void savePolicy()}
                        className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
                      >
                        {policySaving ? "Saving…" : "Save Policy"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
              {policyError
                ? "Policy data did not load. Use Retry above or check the browser Network tab for /api/governance/policy."
                : "No policy data yet. Try Refresh or sign in again."}
            </div>
          )}
        </div>
      )}

      {tab === "audit" && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-slate-900">
              {auditViewMode === "search" ? "Search results" : "Recent Governance Activity"}
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              {auditViewMode === "search" ? (
                <button
                  type="button"
                  disabled={auditLoading}
                  onClick={() => void fetchAuditRecent()}
                  className="text-sm font-semibold text-sky-700 hover:underline disabled:opacity-50"
                >
                  Clear search / Show recent
                </button>
              ) : null}
              <button
                type="button"
                disabled={auditLoading}
                onClick={() =>
                  void (auditViewMode === "search" ? runAuditDateSearch() : fetchAuditRecent())
                }
                className="self-start text-sm font-semibold text-sky-700 hover:underline disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {auditViewMode === "search"
              ? "Events matching your date range and type filter (your review decisions and policy updates you applied)."
              : "Latest review decisions and policy updates (scoped to your governance access)."}
          </p>
          {auditError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {auditViewMode === "search" ? "Search failed. " : "Failed to load audit log. "}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() =>
                  void (auditViewMode === "search" ? runAuditDateSearch() : fetchAuditRecent())
                }
              >
                Retry
              </button>
            </div>
          )}
          {auditLoading ? (
            <div className="mt-6 space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-100" />
              ))}
            </div>
          ) : auditEvents.length === 0 ? (
            <p className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
              {auditViewMode === "search"
                ? "No events matched your search."
                : "No governance activity yet. Approve or block a run from the Review Queue."}
            </p>
          ) : (
            <ul className="mt-6 space-y-4">
              {auditEvents.map((ev) => (
                <AuditLogEventCard
                  key={ev.id}
                  ev={ev}
                  inlineTrail={auditInlineTrail}
                  onToggleTrail={() => void toggleAuditInlineTrail(ev)}
                  currentUserEmail={user?.email}
                />
              ))}
            </ul>
          )}

          <div className="my-8 border-t border-slate-200" aria-hidden />

          <h3 className="text-sm font-semibold text-slate-800">Search past events</h3>
          <p className="mt-1 text-sm text-slate-600">
            Filter by date range and run type. Results replace the list above until you clear the search.
          </p>
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">From</span>
                <input
                  type="date"
                  value={auditFromDate}
                  onChange={(e) => setAuditFromDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">To</span>
                <input
                  type="date"
                  value={auditToDate}
                  onChange={(e) => setAuditToDate(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Type</span>
                <select
                  value={auditSearchRunType}
                  onChange={(e) =>
                    setAuditSearchRunType(e.target.value as "all" | "claim" | "research" | "video")
                  }
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="all">All</option>
                  <option value="claim">Claims only</option>
                  <option value="research">Research only</option>
                  <option value="video">Video only</option>
                </select>
              </label>
              <button
                type="button"
                disabled={auditLoading}
                onClick={() => void runAuditDateSearch()}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50 sm:mb-0.5"
              >
                Search
              </button>
            </div>
          </div>
        </div>
      )}

      <ReviewModal
        mode={reviewModal.mode}
        row={reviewModal.row}
        onClose={() => setReviewModal({ mode: null, row: null })}
        onSubmit={async (comment) => {
          if (!reviewModal.row || !reviewModal.mode) return;
          await submitReview(reviewModal.row, reviewModal.mode, comment);
        }}
      />
    </div>
  );
}

function FragmentRow(props: {
  row: QueueRow;
  currentUserUid?: string;
  currentUserEmail?: string | null;
  chip: { wrap: string; label: string };
  mh: { text: string; cls: string; title: string };
  ev: { text: string; cls: string };
  exp: boolean;
  firstReason: string;
  more: string;
  consensusColor: (n: number | null) => string;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  approveHint?: string;
  reviewBusyKey: string | null;
  onApprove: () => void;
  onBlock: () => void;
  onChanges: () => void;
}) {
  const {
    row,
    currentUserUid,
    currentUserEmail,
    chip,
    mh,
    ev,
    exp,
    firstReason,
    more,
    consensusColor,
    expanded,
    setExpanded,
    approveHint,
    reviewBusyKey,
    onApprove,
    onBlock,
    onChanges,
  } = props;
  const key = `${row.collection}:${row.runId}`;
  const reviewBusyThisRow = reviewBusyKey === key;
  const { isSelf, full: userFullLabel, displayShort: userDisplayShort } = queueRowUserPresentation(
    row,
    currentUserUid,
    currentUserEmail
  );

  return (
    <>
      <tr
        className={`cursor-pointer hover:bg-slate-50/80 ${isSelf ? "bg-sky-50/50" : ""}`}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("button,a")) return;
          setExpanded((prev) => {
            const n = new Set(prev);
            if (n.has(key)) n.delete(key);
            else n.add(key);
            return n;
          });
        }}
      >
        <td className="px-3 py-2">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${chip.wrap}`}>
            {chip.label}
          </span>
        </td>
        <td
          className={`hidden max-w-[160px] px-3 py-2 md:table-cell ${isSelf ? "bg-sky-100/60" : ""}`}
          title={isSelf ? `You (${userFullLabel})` : userFullLabel}
        >
          {isSelf ? (
            <span className="inline-flex rounded-full bg-sky-200/80 px-2 py-0.5 text-xs font-semibold text-sky-950">
              You
            </span>
          ) : (
            <span className="block truncate font-medium text-slate-800">{userDisplayShort}</span>
          )}
        </td>
        <td className="max-w-[200px] px-3 py-2 text-slate-800" title={row.question}>
          <div className="mb-1 flex flex-wrap items-center gap-2 md:hidden">
            {isSelf ? (
              <span className="inline-flex rounded-full bg-sky-200/80 px-2 py-0.5 text-xs font-semibold text-sky-950">
                You
              </span>
            ) : (
              <span
                className="max-w-[min(100%,14rem)] truncate rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800"
                title={userFullLabel}
              >
                {userDisplayShort}
              </span>
            )}
          </div>
          {truncateText(row.question, 80)}
        </td>
        <td className="px-3 py-2">
          {row.runType === "video" ? (
            <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">
              VIDEO
            </span>
          ) : (
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                row.runType === "research"
                  ? "border-sky-400 text-sky-800"
                  : "border-purple-400 text-purple-800"
              }`}
            >
              {row.runType === "research" ? "RESEARCH" : "CLAIM"}
            </span>
          )}
        </td>
        <td className={`px-3 py-2 font-semibold ${consensusColor(row.consensusScore)}`}>
          {row.consensusScore == null ? "—" : Math.round(row.consensusScore)}
        </td>
        <td className="hidden px-3 py-2 md:table-cell">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ev.cls}`}>
            {ev.text}
          </span>
        </td>
        <td className={`hidden px-3 py-2 font-medium md:table-cell ${mh.cls}`} title={mh.title}>
          {mh.text}
        </td>
        <td className="hidden max-w-[180px] px-3 py-2 text-xs text-slate-600 md:table-cell">
          {firstReason}
          {more && <span className="text-slate-400">{more}</span>}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-slate-500">
          {formatRelativeTime(row.createdAt)}
        </td>
        <td className="px-3 py-2">
          {row.governanceStatus === "approved" ? (
            <div className="text-xs text-slate-500">
              {approveHint ? (
                <span className="font-medium text-emerald-700">{approveHint}</span>
              ) : row.governanceReviewedAt ? (
                <span>Reviewed · {formatRelativeTime(row.governanceReviewedAt)}</span>
              ) : (
                <span>Approved</span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                title="Approve"
                disabled={Boolean(reviewBusyKey)}
                aria-busy={reviewBusyThisRow}
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove();
                }}
                className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {reviewBusyThisRow ? "…" : "✓"}
              </button>
              <button
                type="button"
                title="Block"
                disabled={Boolean(reviewBusyKey)}
                onClick={(e) => {
                  e.stopPropagation();
                  onBlock();
                }}
                className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                ✗
              </button>
              <button
                type="button"
                title="Request changes"
                disabled={Boolean(reviewBusyKey)}
                onClick={(e) => {
                  e.stopPropagation();
                  onChanges();
                }}
                className="rounded bg-amber-500 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
              >
                ↻
              </button>
            </div>
          )}
        </td>
      </tr>
      {exp && (
        <tr className="bg-slate-50">
          <td colSpan={10} className="px-4 py-4 text-sm text-slate-700">
            <p className="font-medium text-slate-900">Run owner</p>
            <p className="mt-1 text-slate-800">
              {isSelf ? (
                <>
                  <span className="font-semibold text-sky-900">You</span>
                  {userFullLabel && userFullLabel !== "—" && (
                    <span className="text-slate-600"> · {userFullLabel}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="break-all font-medium">{userFullLabel}</span>
                  {row.userId && (
                    <span className="mt-1 block text-xs text-slate-500">User ID: {row.userId}</span>
                  )}
                </>
              )}
            </p>
            {!isSelf && row.ownerAssignedReviewerAt && (
              <p className="mt-2 text-sm text-slate-600">
                Assigned you as reviewer on {formatReviewerAssignedDate(row.ownerAssignedReviewerAt)}
              </p>
            )}
            <p className="mt-3 font-medium text-slate-900">Full text</p>
            <p className="mt-1 whitespace-pre-wrap">{row.question}</p>

            {row.runType === "research" && row.keyFindings && row.keyFindings.length > 0 ? (
              <div className="mt-4 rounded-r-lg border-l-4 border-emerald-500 bg-emerald-50/80 pl-3 pr-3 py-3">
                <p className="text-sm font-semibold text-emerald-900">Key findings (synthesis)</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-emerald-950/90">
                  {row.keyFindings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {row.runType === "research" && row.disagreementPoints && row.disagreementPoints.length > 0 ? (
              <div className="mt-4 rounded-r-lg border-l-4 border-amber-600 bg-amber-50/90 pl-3 pr-3 py-3">
                <p className="text-sm font-semibold text-amber-950">Where synthesis flags disagreements</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-950/90">
                  {row.disagreementPoints.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {row.runType === "verification" && row.verificationVerdict ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-2.5">
                <p className="text-sm text-slate-800">
                  <span className="font-semibold text-slate-900">Claim verdict: </span>
                  <span className={`font-semibold ${queueClaimVerdictToneClass(row.verificationVerdict)}`}>
                    {formatQueueClaimVerdictLabel(row.verificationVerdict)}
                  </span>
                </p>
                {row.claimVerdictSummary ? (
                  <p className="mt-1.5 text-sm leading-snug text-slate-700">{row.claimVerdictSummary}</p>
                ) : null}
              </div>
            ) : null}

            {row.runType === "video" && row.verificationVerdict ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-2.5">
                <p className="text-sm text-slate-800 flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">Video verdict: </span>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${queueVideoVerdictBadgeClass(row.verificationVerdict)}`}
                  >
                    {formatQueueVideoVerdictLabel(row.verificationVerdict)}
                  </span>
                </p>
                {row.claimVerdictSummary ? (
                  <p className="mt-1.5 text-sm leading-snug text-slate-700">{row.claimVerdictSummary}</p>
                ) : null}
              </div>
            ) : null}

            {row.modelVerdicts && row.modelVerdicts.length > 0 ? (
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
                <p className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
                  Model verdicts
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[280px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-2">Model</th>
                        <th className="px-3 py-2">Verdict</th>
                        <th className="px-3 py-2">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.modelVerdicts.map((m, i) => (
                        <tr key={`${m.modelId}-${i}`} className="border-b border-slate-100 last:border-0">
                          <td className="px-3 py-2 font-medium text-slate-800 align-top">
                            {getModelDisplayName(m.modelId)}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${queueModelVerdictBadgeClass(m.verdict)}`}
                            >
                              {row.runType === "video"
                                ? formatQueueVideoVerdictLabel(m.verdict)
                                : m.verdict}
                            </span>
                          </td>
                          <td className={`px-3 py-2 align-top ${queueModelVerdictToneClass(m.verdict)}`}>
                            {m.confidence ? (
                              <span className="text-slate-700">{m.confidence}</span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {row.modelVerdicts.some((m) => m.summary) ? (
                  <ul className="space-y-2 border-t border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600">
                    {row.modelVerdicts.map(
                      (m, i) =>
                        m.summary && (
                          <li key={`sum-${m.modelId}-${i}`}>
                            <span className="font-semibold text-slate-700">{getModelDisplayName(m.modelId)}: </span>
                            {m.summary}
                          </li>
                        )
                    )}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {(row.runType === "verification" || row.runType === "video") &&
            ((row.agreementPoints && row.agreementPoints.length > 0) || row.agreementSummary) ? (
              <div className="mt-4 rounded-r-lg border-l-4 border-emerald-500 bg-emerald-50/70 pl-3 pr-3 py-3">
                <p className="text-sm font-semibold text-emerald-900">Where models agree</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-emerald-950/90">
                  {(row.agreementPoints && row.agreementPoints.length > 0
                    ? row.agreementPoints
                    : row.agreementSummary
                      ? [row.agreementSummary]
                      : []
                  ).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {row.runType === "verification" || row.runType === "video"
              ? (() => {
                  const disagreeLines: string[] = [
                    ...(row.disagreementPoints ?? []),
                    ...(row.disagreementPoints?.length ? [] : row.dissentSummary ? [row.dissentSummary] : []),
                    ...(row.disagreements ?? []),
                  ];
                  if (disagreeLines.length === 0) return null;
                  return (
                    <div className="mt-4 rounded-r-lg border-l-4 border-red-500 bg-red-50/60 pl-3 pr-3 py-3">
                      <p className="text-sm font-semibold text-red-900">Where models disagree</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-950/90">
                        {disagreeLines.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })()
              : null}

            {row.runType === "verification" && row.correctParts && row.correctParts.length > 0 ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-emerald-800">What&apos;s correct</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-emerald-900/90">
                  {row.correctParts.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {row.runType === "verification" && row.incorrectParts && row.incorrectParts.length > 0 ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-red-800">What&apos;s incorrect or imprecise</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-red-900/90">
                  {row.incorrectParts.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {row.disagreements && row.disagreements.length > 0 && row.runType === "research" ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-slate-900">Key disagreements</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-slate-700">
                  {row.disagreements.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="mt-3 font-medium text-slate-900">Governance reasons</p>
            <ul className="mt-1 list-disc pl-5">
              {(row.governanceReasons ?? []).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            {(row.governanceReviewedAt || row.governanceReviewComment) && (
              <div className="mt-3 text-xs text-slate-600">
                {row.governanceReviewedAt && <p>Reviewed at: {row.governanceReviewedAt}</p>}
                {row.governanceReviewComment && <p>Comment: {row.governanceReviewComment}</p>}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
