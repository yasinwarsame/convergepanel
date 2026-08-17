/**
 * Run/Project Association, Phase 6D.4A — strict request-body parsing for
 * `PATCH /api/user/runs/{runId}/project`. Structural sibling of
 * `lib/projects/projectMutationBody.ts`: any key beyond the exact allowed
 * set is rejected outright (400), never silently ignored. Both `projectId`
 * and `expectedProjectId` are REQUIRED keys — this route has no meaningful
 * "expectedProjectId defaults to X" behavior, so an omitted key is a
 * caller error, not something to infer. `"key" in body` (not
 * `body.key !== undefined`) is what distinguishes "omitted" from
 * "explicitly null" here: `JSON.parse` never produces an `undefined`
 * value, so any key present in the parsed body — including one whose
 * value is `null` — passes the `in` check; a key genuinely never sent at
 * all is the only thing that fails it.
 */

import "server-only";
import { validateProjectIdSyntax } from "./projectId";

export type ParseRunProjectAssociationBodyResult =
  | { ok: true; projectId: unknown; expectedProjectId: unknown }
  | { ok: false; reason: "invalid_body" | "unknown_field" | "missing_field" };

const ALLOWED_KEYS = new Set(["projectId", "expectedProjectId"]);

export function parseRunProjectAssociationBody(raw: unknown): ParseRunProjectAssociationBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  if (!("projectId" in body) || !("expectedProjectId" in body)) {
    return { ok: false, reason: "missing_field" };
  }
  return { ok: true, projectId: body.projectId, expectedProjectId: body.expectedProjectId };
}

export type ValidateNullableProjectIdValueResult = { ok: true; value: string | null } | { ok: false };

/**
 * Semantic value validation shared by both `projectId` and
 * `expectedProjectId`: `null` is always valid (Unfiled); any non-null
 * value must pass the exact same canonical Project-id syntax check every
 * other Project route already applies — never a looser or separately
 * maintained rule.
 */
export function validateNullableProjectIdValue(value: unknown): ValidateNullableProjectIdValueResult {
  if (value === null) return { ok: true, value: null };
  const syntax = validateProjectIdSyntax(value);
  if (!syntax.ok) return { ok: false };
  return { ok: true, value: syntax.projectId };
}
