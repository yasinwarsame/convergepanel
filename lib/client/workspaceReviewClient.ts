/**
 * Approval Workflow, Phase 9C.2 — client-safe typed contract + fetch
 * helpers for the Workspace single-review workflow: review-context,
 * reviewer-candidates, review-assignment (GET/PUT/DELETE),
 * review-decision, review-resubmit.
 *
 * Deliberately does NOT import `lib/workspaces/reviewContext.ts` /
 * `workspaceReviewMutations.ts` (guarded by `"server-only"`) — the types
 * below are hand-mirrored, client-safe copies of those modules' own DTOs,
 * kept in exact field-for-field sync deliberately (mirrors
 * `workspaceReviewQueueClient.ts`'s own established precedent).
 *
 * PHASE 9B.7 OCC CONTRACT (frozen, authoritative for this module):
 * `assignment` (nullable) is presentation state — whether there is
 * currently an assigned reviewer. `assignmentRevision` is an INDEPENDENT
 * field — the persisted assignment resource's true OCC version.
 * `assignment === null` does NOT imply `assignmentRevision === 0` (a
 * cleared assignment preserves its document and keeps incrementing its
 * revision). The four `build*Request` functions below are the ONLY place
 * in this codebase that construct a governance mutation request body —
 * every assignment write sources `expectedRevision` from
 * `context.assignmentRevision`, NEVER from `assignment` being null/
 * non-null, never incremented locally, never re-derived after a mutation
 * (always re-read from a fresh `getReviewContext()`/`putAssignment()`
 * response). Decision/resubmit source `expectedUpdatedAt` from
 * `context.review.governanceUpdatedAt` — a completely separate OCC
 * domain that must never be cross-wired with `assignmentRevision`.
 *
 * `authedFetch()` only — no raw `fetch`, no SWR, no React Query, no
 * direct Firestore access from the browser.
 */

"use client";

import type { User } from "firebase/auth";
import { authedFetch } from "./authedFetch";

// ============================================
// Client-safe DTO mirrors
// ============================================

export type ReviewStatus = "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

export type DecidedVia = "single_reviewer" | "multi_reviewer_panel" | "multi_reviewer_owner_override";

export interface ReviewContextReviewInfo {
  status: ReviewStatus;
  reviewedAt: string | null;
  comment?: string;
  conditions?: string[];
  decidedVia?: DecidedVia;
  /** Phase 9B.6-R1C — the canonical `governanceRecord.updatedAt` OCC token. Decision/resubmit source ONLY this value. */
  governanceUpdatedAt: string;
}

export type AssignmentState = "actionable" | "stale";

export interface ReviewContextAssignmentInfo {
  assignedReviewerUserId: string;
  assignedReviewerDisplayName: string;
  revision: number;
  assignedAt: string | null;
  updatedAt: string;
  dueAt: string | null;
  state: AssignmentState;
}

export interface ReviewContextPanelReviewer {
  uid: string;
  displayName: string;
}

export interface ReviewContextPanelVoteSummary {
  submittedCount: number;
  aggregationState: "waiting" | "deadlocked" | "ready";
}

export type PanelStatus = "open" | "cancelled" | "finalized";

export interface ReviewContextPanelInfo {
  status: PanelStatus;
  revision: number;
  reviewers: ReviewContextPanelReviewer[];
  voteSummary: ReviewContextPanelVoteSummary | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}

export interface ReviewContextViewerInfo {
  mode: "normal" | "drain";
  isCreator: boolean;
  canManageAssignment: boolean;
  canSubmitDecision: boolean;
  canResubmit: boolean;
  /** Phase 9C.3 — panel presentation/mutation UX hints, backend-authoritative like every other `can*` field. */
  canCreatePanel: boolean;
  canReconfigurePanel: boolean;
  canCancelPanel: boolean;
  canVote: boolean;
  hasVoted: boolean;
  canFinalize: boolean;
  // canOverride is intentionally NOT mirrored here — Owner Override UI is
  // out of scope through Phase 9C.3 (deferred to 9C.4), and this client
  // module should not even carry the temptation to branch on it (mirrors
  // the same discipline Phase 9C.2 already applied to this whole block).
}

export interface WorkspaceReviewContext {
  run: { runId: string; workspaceId: string; projectId: string | null; label: string };
  review: ReviewContextReviewInfo;
  assignment: ReviewContextAssignmentInfo | null;
  /** Independent from `assignment` — see module doc comment. Never 0 merely because `assignment` is null. */
  assignmentRevision: number;
  panel: ReviewContextPanelInfo | null;
  viewer: ReviewContextViewerInfo;
}

export interface ReviewerCandidate {
  uid: string;
  displayName: string;
}

export type AdaptiveReviewDecisionStatus = "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

// ============================================
// PURE request builders — the authoritative OCC-sourcing contract.
// No I/O, no React, fully unit-testable without a DOM/fetch.
// ============================================

export interface AssignmentDraft {
  assignedReviewerUserId: string;
  /** Always sent explicitly (never omitted) — correct for both first-assignment and reassignment backend branches; the same-reviewer-preserve-dueAt branch (only reachable by omitting the field) is not a case this UI needs to hit, so always-explicit is the simplest fully-correct choice. */
  dueAt: string | null;
}

export interface AssignmentPutRequestBody {
  assignedReviewerUserId: string;
  expectedRevision: number;
  dueAt: string | null;
}

/**
 * THE Phase 9B.7 invariant, enforced in exactly one place: `expectedRevision`
 * is `context.assignmentRevision`, full stop. Never `assignment?.revision`,
 * never `assignment == null ? 0 : ...`, never a locally-incremented value.
 */
export function buildAssignmentPutRequest(context: Pick<WorkspaceReviewContext, "assignmentRevision">, draft: AssignmentDraft): AssignmentPutRequestBody {
  return {
    assignedReviewerUserId: draft.assignedReviewerUserId,
    expectedRevision: context.assignmentRevision,
    dueAt: draft.dueAt,
  };
}

export interface AssignmentDeleteRequestBody {
  expectedRevision: number;
}

export function buildAssignmentDeleteRequest(context: Pick<WorkspaceReviewContext, "assignmentRevision">): AssignmentDeleteRequestBody {
  return { expectedRevision: context.assignmentRevision };
}

export interface DecisionDraft {
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
}

export interface DecisionRequestBody {
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
  expectedUpdatedAt: string;
}

/** Sources `expectedUpdatedAt` from `context.review.governanceUpdatedAt` ONLY — never `assignmentRevision`. Separate OCC domain from assignment writes. */
export function buildDecisionRequest(context: Pick<WorkspaceReviewContext, "review">, draft: DecisionDraft): DecisionRequestBody {
  return {
    status: draft.status,
    ...(draft.comment !== undefined ? { comment: draft.comment } : {}),
    ...(draft.conditions !== undefined ? { conditions: draft.conditions } : {}),
    expectedUpdatedAt: context.review.governanceUpdatedAt,
  };
}

export interface ResubmitRequestBody {
  expectedUpdatedAt: string;
}

/** Sources `expectedUpdatedAt` from `context.review.governanceUpdatedAt` ONLY — never `assignmentRevision`. Same OCC domain as decision, independent of assignment OCC. */
export function buildResubmitRequest(context: Pick<WorkspaceReviewContext, "review">): ResubmitRequestBody {
  return { expectedUpdatedAt: context.review.governanceUpdatedAt };
}

// ============================================
// Panel OCC — Phase 9C.3. A THIRD, independent concurrency domain
// alongside assignmentRevision and governanceUpdatedAt. Create/reconfigure/
// vote/cancel use ONLY panel.revision; finalize uses panel.revision AND
// governanceUpdatedAt (the backend's own `finalizeWorkspaceReviewPanel`
// contract — see `workspaceReviewPanelMutations.ts`). NEVER
// assignmentRevision, in any of the four builders below.
//
// PANEL-ABSENT SEMANTICS (deliberately NOT the same ambiguity Phase 9B.7
// fixed for assignments): `panel === null` in `WorkspaceReviewContext`
// unambiguously means no panel document has EVER been created for this
// run — cancel/finalize are terminal STATUS transitions on the same
// document (never a delete, never a "clear"; see
// `workspaceReviewPanelMutations.ts`'s own `deleteWorkspaceReviewPanel`
// doc comment: "Never a physical delete"), so a panel that once existed
// can never present as `null` again. `currentPanelRevision()` is
// therefore safe to source `0` from `panel === null` — this is NOT a
// repeat of the assignment mistake, it is the opposite, deliberately
// verified case.
// ============================================

export function currentPanelRevision(context: Pick<WorkspaceReviewContext, "panel">): number {
  return context.panel === null ? 0 : context.panel.revision;
}

export interface PanelPutRequestBody {
  reviewerUserIds: string[];
  expectedRevision: number;
}

/** Used for BOTH panel creation (no current panel) and reconfiguration (existing open panel) — the backend shares one code path for both (`putWorkspaceReviewPanel`), keyed only by `expectedRevision`. */
export function buildPanelPutRequest(context: Pick<WorkspaceReviewContext, "panel">, reviewerUserIds: string[]): PanelPutRequestBody {
  return { reviewerUserIds, expectedRevision: currentPanelRevision(context) };
}

export interface PanelDeleteRequestBody {
  expectedRevision: number;
}

/** Cancel is only ever offered for an already-non-null open panel — the caller supplies `panel.revision` directly, mirroring `buildPanelVoteRequest`/`buildPanelFinalizeRequest`'s explicit-source pattern rather than re-deriving from a possibly-null context. */
export function buildPanelDeleteRequest(panel: { revision: number }): PanelDeleteRequestBody {
  return { expectedRevision: panel.revision };
}

export interface PanelVoteDraft {
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
}

export interface PanelVoteRequestBody {
  panelRevision: number;
  status: AdaptiveReviewDecisionStatus;
  comment?: string;
  conditions?: string[];
}

/**
 * `panel` here is the caller's already-non-null current panel (voting is
 * only ever possible on an OPEN panel, which is never `null`) — the
 * caller supplies `panel.revision` directly rather than this function
 * re-deriving it from a context that might be stale/absent, keeping the
 * OCC source explicit at every call site.
 */
export function buildPanelVoteRequest(panel: { revision: number }, draft: PanelVoteDraft): PanelVoteRequestBody {
  return {
    panelRevision: panel.revision,
    status: draft.status,
    ...(draft.comment !== undefined ? { comment: draft.comment } : {}),
    ...(draft.conditions !== undefined ? { conditions: draft.conditions } : {}),
  };
}

export interface PanelFinalizeRequestBody {
  expectedPanelRevision: number;
  expectedGovernanceUpdatedAt: string;
}

/** The one place both panel OCC and governance OCC are combined — deliberately takes two distinct, separately-sourced values so a divergent-token test can prove neither is ever substituted for the other, and NEITHER is ever `assignmentRevision`. */
export function buildPanelFinalizeRequest(panel: { revision: number }, review: Pick<ReviewContextReviewInfo, "governanceUpdatedAt">): PanelFinalizeRequestBody {
  return { expectedPanelRevision: panel.revision, expectedGovernanceUpdatedAt: review.governanceUpdatedAt };
}

// ============================================
// Response parsers — structural guards, never trust arbitrary JSON.
// ============================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReviewContext(data: unknown): WorkspaceReviewContext | null {
  if (!isPlainObject(data) || data.ok !== true) return null;
  const context = data.context;
  if (!isPlainObject(context)) return null;
  const run = context.run;
  const review = context.review;
  const viewer = context.viewer;
  if (!isPlainObject(run) || typeof run.runId !== "string" || typeof run.workspaceId !== "string") return null;
  if (!isPlainObject(review) || typeof review.status !== "string" || typeof review.governanceUpdatedAt !== "string") return null;
  if (!isPlainObject(viewer) || typeof viewer.mode !== "string") return null;
  if (typeof context.assignmentRevision !== "number") return null;
  return context as unknown as WorkspaceReviewContext;
}

export type FetchReviewContextResult = { status: "ok"; context: WorkspaceReviewContext } | { status: "not_found" } | { status: "error" };

export async function getReviewContext(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; signal?: AbortSignal }): Promise<FetchReviewContextResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-context`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    const context = parseReviewContext(json);
    if (!context) return { status: "error" };
    return { status: "ok", context };
  } catch {
    return { status: "error" };
  }
}

function parseReviewerCandidates(data: unknown): ReviewerCandidate[] | null {
  if (!isPlainObject(data) || data.ok !== true || !Array.isArray(data.reviewers)) return null;
  const out: ReviewerCandidate[] = [];
  for (const raw of data.reviewers) {
    if (!isPlainObject(raw) || typeof raw.uid !== "string" || typeof raw.displayName !== "string") return null;
    out.push({ uid: raw.uid, displayName: raw.displayName });
  }
  return out;
}

export type FetchReviewerCandidatesResult = { status: "ok"; candidates: ReviewerCandidate[] } | { status: "not_found" } | { status: "error" };

export async function getReviewerCandidates(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; signal?: AbortSignal }): Promise<FetchReviewerCandidatesResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/reviewer-candidates`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    const candidates = parseReviewerCandidates(json);
    if (!candidates) return { status: "error" };
    return { status: "ok", candidates };
  } catch {
    return { status: "error" };
  }
}

// ============================================
// Mutations — every 409 maps to "conflict", never auto-retried by this
// module or any caller. Recovery is always "caller refetches
// review-context and requires an explicit new user action."
// ============================================

export type MutationResult = { status: "ok" } | { status: "conflict" } | { status: "not_found" } | { status: "validation_error" } | { status: "error" };

async function runMutation(url: string, args: { method: "PUT" | "DELETE" | "POST"; user: User | null; authReady: boolean; body?: unknown }): Promise<MutationResult> {
  try {
    const res = await authedFetch(url, {
      user: args.user,
      authReady: args.authReady,
      method: args.method,
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      cache: "no-store",
    });
    if (res.status === 409) return { status: "conflict" };
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "not_found" };
    if (res.status === 400) return { status: "validation_error" };
    if (!res.ok) return { status: "error" };
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}

export async function putAssignment(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: AssignmentPutRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-assignment`, {
    method: "PUT",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function deleteAssignment(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: AssignmentDeleteRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-assignment`, {
    method: "DELETE",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function submitDecision(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: DecisionRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-decision`, {
    method: "POST",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function resubmitReview(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: ResubmitRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-resubmit`, {
    method: "POST",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function putPanel(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: PanelPutRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-panel`, {
    method: "PUT",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function deletePanel(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: PanelDeleteRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-panel`, {
    method: "DELETE",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function submitPanelVote(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: PanelVoteRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-panel/vote`, {
    method: "POST",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

export async function finalizePanel(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; body: PanelFinalizeRequestBody }): Promise<MutationResult> {
  return runMutation(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/runs/${encodeURIComponent(args.runId)}/review-panel/finalize`, {
    method: "POST",
    user: args.user,
    authReady: args.authReady,
    body: args.body,
  });
}

// ============================================
// Shared copy
// ============================================

export const CONFLICT_MESSAGE = "This review changed while you were editing. We refreshed the latest version.";
export const GENERIC_CONTEXT_ERROR_MESSAGE = "We couldn't load review details. Try again.";
export const GENERIC_CANDIDATES_ERROR_MESSAGE = "We couldn't load eligible reviewers. Try again.";
export const GENERIC_MUTATION_ERROR_MESSAGE = "Something went wrong. Try again.";
export const ACTION_UNAVAILABLE_MESSAGE = "This review changed and this action is no longer available.";
export const REVIEW_UNAVAILABLE_MESSAGE = "This review is no longer available.";
export const NO_ELIGIBLE_REVIEWERS_MESSAGE = "No eligible reviewers are available.";
/** Phase 9C.3 — deliberately distinct wording from CONFLICT_MESSAGE so a panel conflict never reads as a single-review one. No OCC/revision/transaction jargon. */
export const PANEL_CONFLICT_MESSAGE = "This panel changed while you were editing. We refreshed the latest version. Review your changes before submitting again.";
