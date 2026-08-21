/**
 * Team Run Lists, Phase 8C-B2 — shared per-row structural validation for
 * every B2 list route. Pure, zero I/O — the caller supplies one already-
 * fetched Firestore document's data. Reused by the Team ALL/UNFILED
 * route and the Team Project-run route so the same well-formedness rules
 * are enforced identically everywhere, never re-derived per route.
 *
 * Deliberately stricter/differently-scoped than
 * `classifyProjectIdFieldState()`'s own generic semantics: for a
 * Team-bound run, `absent` and `malformed` `projectId` states both
 * collapse to a validation failure here — Team has no historical
 * missing-`projectId` compatibility debt (unlike Personal;
 * see the Phase 8C-B1.3 workstream), so there is no legacy-Unfiled
 * reinterpretation to perform.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { classifyProjectIdFieldState } from "@/lib/projects/runProjectNormalizationEligibility";

export type TeamRunRowValidationResult = { ok: true; userId: string; workspaceId: string; projectId: string | null } | { ok: false };

/**
 * Validates: `userId` (non-empty string), `workspaceId` (non-empty
 * string, exactly equal to the caller-supplied expected Workspace id —
 * never merely "some workspace"), `createdAt` (a genuine
 * `firebase-admin/firestore` `Timestamp` instance, never blind-cast),
 * and `projectId` (must be exactly `null` or a valid assigned string —
 * `absent`/`malformed` both fail closed).
 */
export function validateTeamRunRowShape(data: Record<string, unknown>, expectedWorkspaceId: string): TeamRunRowValidationResult {
  if (typeof data.userId !== "string" || data.userId.length === 0) {
    return { ok: false };
  }
  if (typeof data.workspaceId !== "string" || data.workspaceId.length === 0 || data.workspaceId !== expectedWorkspaceId) {
    return { ok: false };
  }
  if (!(data.createdAt instanceof Timestamp)) {
    return { ok: false };
  }

  const hasProjectIdField = Object.prototype.hasOwnProperty.call(data, "projectId");
  const fieldState = classifyProjectIdFieldState({ hasProjectIdField, projectIdValue: data.projectId });
  switch (fieldState) {
    case "null":
      return { ok: true, userId: data.userId, workspaceId: data.workspaceId, projectId: null };
    case "assigned":
      return { ok: true, userId: data.userId, workspaceId: data.workspaceId, projectId: data.projectId as string };
    case "absent":
    case "malformed":
      return { ok: false };
  }
}
