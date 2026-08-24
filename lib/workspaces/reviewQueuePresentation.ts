/**
 * Approval Workflow, Phase 9C.1 — pure presentation mapping for the
 * Workspace review queue UI. No React, no I/O, no Firestore, no
 * `"server-only"` guard — this module is imported by both the client
 * shell/row components and (for the view-label/empty-copy constants) any
 * future server-rendered surface, mirroring `lib/governance/teamReviewLabels.ts`'s
 * own isomorphic-pure-mapping precedent.
 *
 * This is a NEW, Workspace-scoped module rather than an extension of
 * `teamReviewLabels.ts` — that file's `humanReviewStatusLabel()` maps the
 * same six status values but returns Title Case single-word-ish labels
 * ("Pending", "Unreviewed") tuned for the legacy Team dashboard's dense
 * table; the frozen Phase 9C.1 copy below ("Under review", "Awaiting
 * review") is a distinct, explicitly-specified UX voice for the new
 * Workspace surface. Reusing the legacy map would mean changing its
 * strings (breaking the legacy dashboard) or forking anyway — a small new
 * module is the smaller, safer diff.
 */

export type ReviewQueueView = "assigned_to_me" | "needs_review" | "changes_requested" | "overdue" | "recently_approved";

export const REVIEW_QUEUE_VIEWS: readonly ReviewQueueView[] = ["assigned_to_me", "needs_review", "changes_requested", "overdue", "recently_approved"];

export const DEFAULT_REVIEW_QUEUE_VIEW: ReviewQueueView = "assigned_to_me";

const VIEW_LABELS: Record<ReviewQueueView, string> = {
  assigned_to_me: "Assigned to me",
  needs_review: "Needs review",
  changes_requested: "Changes requested",
  overdue: "Overdue",
  recently_approved: "Recently approved",
};

export function getReviewQueueViewLabel(view: ReviewQueueView): string {
  return VIEW_LABELS[view];
}

/** Invalid/missing input normalizes safely to the default view — never sent to the backend as-is, never re-requested in a loop. */
export function normalizeReviewQueueView(raw: string | null | undefined): ReviewQueueView {
  if (raw && (REVIEW_QUEUE_VIEWS as readonly string[]).includes(raw)) return raw as ReviewQueueView;
  return DEFAULT_REVIEW_QUEUE_VIEW;
}

const EMPTY_STATE_COPY: Record<ReviewQueueView, { title: string; message: string }> = {
  assigned_to_me: { title: "Nothing assigned to you", message: "Nothing assigned to you right now." },
  needs_review: { title: "Nothing needs review", message: "No items currently need review." },
  changes_requested: { title: "No changes requested", message: "No items currently have requested changes." },
  overdue: { title: "Nothing overdue", message: "Nothing is overdue." },
  recently_approved: { title: "No recent approvals", message: "No recently approved items." },
};

export function getReviewQueueEmptyStateCopy(view: ReviewQueueView): { title: string; message: string } {
  return EMPTY_STATE_COPY[view];
}

// ── Review status presentation ──────────────────────────────────────────

export type ReviewStatus = "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

export type ReviewStatusTone = "neutral" | "info" | "positive" | "warning" | "negative";

const STATUS_LABELS: Record<ReviewStatus, string> = {
  unreviewed: "Awaiting review",
  pending: "Under review",
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

const STATUS_TONES: Record<ReviewStatus, ReviewStatusTone> = {
  unreviewed: "neutral",
  pending: "info",
  approved: "positive",
  // Deliberately distinct from plain "approved" (Phase 9C.1 §39) — same
  // positive semantic family, but never the identical tone/label pair.
  approved_with_conditions: "positive",
  changes_requested: "warning",
  rejected: "negative",
};

/** cp-* token classes only — light-theme, text-and-border badges (no color-only signal; every badge also carries its label text). */
const TONE_CLASSES: Record<ReviewStatusTone, string> = {
  neutral: "border-cp-border bg-cp-raised text-cp-muted",
  info: "border-cp-border bg-cp-primary-soft text-cp-primary",
  positive: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-cp-orange bg-cp-orange-soft text-cp-orange",
  negative: "border-red-200 bg-red-50 text-red-700",
};

export function getReviewStatusLabel(status: string): string {
  return STATUS_LABELS[status as ReviewStatus] ?? "Unknown";
}

export function getReviewStatusBadgeClass(status: string): string {
  const tone = STATUS_TONES[status as ReviewStatus] ?? "neutral";
  return TONE_CLASSES[tone];
}

/** `approved_with_conditions` renders a distinguishing secondary marker alongside the shared "Approved" family label, so the two statuses are never visually identical even though they share a tone. */
export function isApprovedWithConditions(status: string): boolean {
  return status === "approved_with_conditions";
}

// ── Assignment presentation ─────────────────────────────────────────────

export type AssignmentState = "unassigned" | "actionable" | "stale";

export interface AssignmentPresentation {
  label: string;
  secondaryLabel: string | null;
  tone: "neutral" | "positive" | "warning";
}

/**
 * `displayName` is the already server-resolved, safe label (never a raw
 * UID — see `workspaceReviewerIdentity.ts`). This function only decides
 * WHICH label/tone to show for a given assignment state; it never touches
 * identity resolution itself. A stale assignment is never presented as a
 * healthy actionable one (Phase 9C.1 §34, mandatory).
 */
export function getAssignmentPresentation(assignment: { state: AssignmentState; assignedReviewerDisplayName: string | null }): AssignmentPresentation {
  if (assignment.state === "unassigned") {
    return { label: "Unassigned", secondaryLabel: null, tone: "neutral" };
  }
  if (assignment.state === "stale") {
    const secondary = assignment.assignedReviewerDisplayName ? `Previously assigned to ${assignment.assignedReviewerDisplayName}` : null;
    return { label: "Needs reassignment", secondaryLabel: secondary, tone: "warning" };
  }
  return { label: assignment.assignedReviewerDisplayName ?? "Reviewer unavailable", secondaryLabel: null, tone: "positive" };
}

// ── Project presentation ────────────────────────────────────────────────

export const UNFILED_PROJECT_LABEL = "Unfiled";
const PROJECT_NAME_UNAVAILABLE_LABEL = "Project unavailable";

/** `projectId === null` is canonical Unfiled (matches this codebase's established convention — see `lib/projects/*` doc comments). A non-null id the caller's already-fetched Project list can't resolve falls back to a safe generic label, never the raw Project id. */
export function getProjectLabel(projectId: string | null, projectNameById: ReadonlyMap<string, string>): string {
  if (projectId === null) return UNFILED_PROJECT_LABEL;
  return projectNameById.get(projectId) ?? PROJECT_NAME_UNAVAILABLE_LABEL;
}

// ── Date presentation ────────────────────────────────────────────────────

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** `null` = no due date — never rendered as "Invalid date" or a fabricated "00:00" (Phase 9C.1 §43). */
export function formatDueDate(dueAtIso: string | null): string | null {
  if (dueAtIso === null) return null;
  const ms = Date.parse(dueAtIso);
  if (Number.isNaN(ms)) return null;
  return `Due ${DATE_FORMATTER.format(new Date(ms))}`;
}

export function formatAbsoluteDate(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return DATE_FORMATTER.format(new Date(ms));
}
