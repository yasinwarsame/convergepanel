/**
 * Project/Research Assignment — strict request-body parsers for the two
 * assignment mutation routes. Same discipline as `projectMutationBody.ts`:
 * ANY key outside the exact allowed set is rejected as `unknown_field`
 * (400), never silently ignored. Shape of the accepted values is checked
 * here only as far as "is this the right JSON type"; canonicalization and
 * the 20-unique cap live in `lib/workspaces/assignmentNormalization.ts`
 * and are enforced by the primitive itself, so correctness never depends
 * on this route layer.
 */

import "server-only";

/** A coarse, route-only ceiling on the RAW array so an absurd payload is rejected before the primitive canonicalizes it — correctness does not depend on this. */
export const MAX_RAW_ASSIGNEE_UIDS = 200;

export type ParseProjectAssigneesBodyResult =
  | { ok: true; assigneeUids: unknown[]; expectedUpdateTime: unknown }
  | { ok: false; reason: "invalid_body" | "unknown_field" | "oversized" };

const PROJECT_ASSIGNEES_ALLOWED_KEYS = new Set(["assigneeUids", "expectedUpdateTime"]);

export function parseProjectAssigneesBody(raw: unknown): ParseProjectAssigneesBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!PROJECT_ASSIGNEES_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  if (!("assigneeUids" in body) || !("expectedUpdateTime" in body)) {
    return { ok: false, reason: "invalid_body" };
  }
  if (!Array.isArray(body.assigneeUids)) {
    return { ok: false, reason: "invalid_body" };
  }
  if (body.assigneeUids.length > MAX_RAW_ASSIGNEE_UIDS) {
    return { ok: false, reason: "oversized" };
  }
  return { ok: true, assigneeUids: body.assigneeUids, expectedUpdateTime: body.expectedUpdateTime };
}

export type ParseRunAssigneeBodyResult =
  | { ok: true; assigneeUid: string | null; expectedAssigneeUid: string | null }
  | { ok: false; reason: "invalid_body" | "unknown_field" };

const RUN_ASSIGNEE_ALLOWED_KEYS = new Set(["assigneeUid", "expectedAssigneeUid"]);

/**
 * Both keys are REQUIRED (`"key" in body`, distinguishing omitted from an
 * explicit `null`), mirroring `parseRunProjectAssociationBody()`. Each
 * must be `null` or a non-empty string; uid-shape validity is the
 * primitive's concern.
 */
export function parseRunAssigneeBody(raw: unknown): ParseRunAssigneeBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!RUN_ASSIGNEE_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  if (!("assigneeUid" in body) || !("expectedAssigneeUid" in body)) {
    return { ok: false, reason: "invalid_body" };
  }
  const a = body.assigneeUid;
  const e = body.expectedAssigneeUid;
  const validNullable = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0);
  if (!validNullable(a) || !validNullable(e)) {
    return { ok: false, reason: "invalid_body" };
  }
  return { ok: true, assigneeUid: a, expectedAssigneeUid: e };
}
