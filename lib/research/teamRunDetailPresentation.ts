/**
 * TEAM-RESEARCH-PARITY-R3 — pure interpretation of a SUCCESSFUL
 * `GET /api/workspaces/{workspaceId}/runs/{runId}` body for a Team research
 * DETAIL page.
 *
 * Wraps the shared R2 `interpretPersistedRunReadPayload()` (which owns the
 * canonical research-body interpretation: response run identity, status,
 * adaptive → legacy-adaptive → raw rows, restore notices, completed-but-empty)
 * with the Team envelope checks only a Team address can make:
 *
 *   - `team` must be a plain object;
 *   - `team.workspaceId` must EXACTLY equal the addressed Workspace;
 *   - `team.projectId` must be exactly `string | null`;
 *   - `viewerRole` must be `team_member` or `team_reviewer` — a Personal role
 *     (`owner`, `personal_reviewer`) is never reinterpreted as a Team role.
 * Any failure is `malformed` (fail closed).
 *
 * ROUTE CONTAINMENT (not authorization — the server and the R1 endpoint
 * already authorized the read): the run must sit exactly where the address
 * says. A Project-bound address requires `team.projectId === expectedProjectId`;
 * the Unfiled address requires `team.projectId === null`. A mismatch is
 * `out_of_scope`, which the shell renders exactly like an unavailable run so a
 * Project-bound result can never paint on the Unfiled address (or another
 * Project's address).
 *
 * Presentation metadata (Project label, assignee, dates, provenance) is parsed
 * defensively: a malformed optional field becomes `null` and never crashes or
 * blocks the research body. The source Personal run id is never read.
 *
 * No React, no network, no Firestore, no authorization, no mutation.
 */

import {
  interpretPersistedRunReadPayload,
  type PersistedResearchPresentation,
} from "@/lib/research/persistedRunPresentation";

export type TeamRunViewerRole = "team_member" | "team_reviewer";

/** `projectId: null` addresses the Unfiled route; a string addresses that Project's route. */
export type TeamRunDetailScope = { workspaceId: string; runId: string; projectId: string | null };

export type TeamRunDetailMeta = {
  workspaceId: string;
  projectId: string | null;
  project: { id: string; name: string; status: string } | null;
  assignee: { uid: string; displayName: string; state: "active" | "stale" } | null;
  createdAt: string | null;
  completedAt: string | null;
  origin: { kind: "personal_research"; sourceCreatedAt: string; sourceCompletedAt: string | null } | null;
  /**
   * R3-R1 — the R1 endpoint's read-only review summary, parsed defensively.
   * Only the presentation-safe fields R1 emits: never a reviewer id, name or
   * comment. `null` when absent or unusable.
   */
  review: TeamRunDetailReview | null;
};

export type TeamRunDetailReview = {
  humanReviewStatus: string;
  conditions: string[];
  decidedVia: string | null;
  decisionReceipt: { conclusion: string; sourceBacked: boolean; humanReviewNeeded: boolean } | null;
};

export type TeamRunDetailPresentation = PersistedResearchPresentation & { viewerRole: TeamRunViewerRole };

export type TeamRunDetailInterpretation =
  | { kind: "malformed" }
  | { kind: "out_of_scope" }
  | { kind: "in_progress"; question: string; viewerRole: TeamRunViewerRole; meta: TeamRunDetailMeta }
  | { kind: "failed"; question: string; viewerRole: TeamRunViewerRole; meta: TeamRunDetailMeta }
  | { kind: "ready"; presentation: TeamRunDetailPresentation; meta: TeamRunDetailMeta };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTeamRole(value: unknown): value is TeamRunViewerRole {
  return value === "team_member" || value === "team_reviewer";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseProject(value: unknown): TeamRunDetailMeta["project"] {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.status !== "string") return null;
  return { id: value.id, name: value.name, status: value.status };
}

/** Never returns a label without a real display name: a raw uid is never presented. */
function parseAssignee(value: unknown): TeamRunDetailMeta["assignee"] {
  if (!isPlainObject(value)) return null;
  if (typeof value.uid !== "string" || typeof value.displayName !== "string" || value.displayName.trim().length === 0) return null;
  if (value.state !== "active" && value.state !== "stale") return null;
  return { uid: value.uid, displayName: value.displayName, state: value.state };
}

/** Kind and the source's own dates only — the source Personal run id is never read. */
function parseOrigin(value: unknown): TeamRunDetailMeta["origin"] {
  if (!isPlainObject(value)) return null;
  if (value.kind !== "personal_research" || typeof value.sourceCreatedAt !== "string") return null;
  return { kind: "personal_research", sourceCreatedAt: value.sourceCreatedAt, sourceCompletedAt: stringOrNull(value.sourceCompletedAt) };
}

/** Presentation-safe review fields only; a malformed optional part degrades to null/empty rather than dropping the summary. */
function parseReview(value: unknown): TeamRunDetailMeta["review"] {
  if (!isPlainObject(value)) return null;
  if (typeof value.humanReviewStatus !== "string" || value.humanReviewStatus.length === 0) return null;
  const conditions = Array.isArray(value.conditions) ? value.conditions.filter((c): c is string => typeof c === "string" && c.trim().length > 0) : [];
  const receipt = value.decisionReceipt;
  const decisionReceipt =
    isPlainObject(receipt) && typeof receipt.conclusion === "string" && typeof receipt.sourceBacked === "boolean" && typeof receipt.humanReviewNeeded === "boolean"
      ? { conclusion: receipt.conclusion, sourceBacked: receipt.sourceBacked, humanReviewNeeded: receipt.humanReviewNeeded }
      : null;
  return { humanReviewStatus: value.humanReviewStatus, conditions, decidedVia: stringOrNull(value.decidedVia), decisionReceipt };
}

export function interpretTeamRunDetailResponse(raw: unknown, scope: TeamRunDetailScope): TeamRunDetailInterpretation {
  if (!isPlainObject(raw) || raw.ok !== true) return { kind: "malformed" };

  const team = raw.team;
  if (!isPlainObject(team)) return { kind: "malformed" };
  if (typeof team.workspaceId !== "string" || team.workspaceId !== scope.workspaceId) return { kind: "malformed" };
  if (!(team.projectId === null || typeof team.projectId === "string")) return { kind: "malformed" };

  // A Personal role is never a Team presentation, however the rest looks.
  if (!isTeamRole(raw.viewerRole)) return { kind: "malformed" };

  // Canonical research body + response run identity (shared with Personal).
  const shared = interpretPersistedRunReadPayload(raw, scope.runId);
  if (shared.kind === "malformed") return { kind: "malformed" };

  // Route containment — exactly where the address says, or not on this surface.
  if (team.projectId !== scope.projectId) return { kind: "out_of_scope" };

  const meta: TeamRunDetailMeta = {
    workspaceId: team.workspaceId,
    projectId: team.projectId,
    project: parseProject(team.project),
    assignee: parseAssignee(team.assignee),
    createdAt: stringOrNull(team.createdAt),
    completedAt: stringOrNull(team.completedAt),
    origin: parseOrigin(team.origin),
    review: parseReview(team.review),
  };

  if (shared.kind === "in_progress" || shared.kind === "failed") {
    return { kind: shared.kind, question: shared.question, viewerRole: raw.viewerRole, meta };
  }
  return { kind: "ready", presentation: { ...shared.presentation, viewerRole: raw.viewerRole }, meta };
}
