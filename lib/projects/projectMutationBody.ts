/**
 * Project Foundation, Phase 6C — strict request-body parsing for every
 * Project mutation route. Deliberately narrow: a request body containing
 * ANY key beyond the exact allowed set is rejected outright (400), never
 * silently ignored — a client attempting to submit `workspaceId`,
 * `createdByUserId`, `id`, `status`, `schemaVersion`, `createdAt`, or
 * `updatedAt` on a create/rename call must get an explicit, loud failure,
 * not a response that quietly discarded fields it never had any
 * intention of trusting. This is enforced independently of, and in
 * addition to, the fact that no route ever reads those fields for
 * anything — belt-and-suspenders, matching this codebase's own general
 * discipline of never assuming a caller's intent from what a route
 * happens not to use.
 */

import "server-only";

export type ParseCreateProjectBodyResult = { ok: true; name: unknown } | { ok: false; reason: "invalid_body" | "unknown_field" };

const CREATE_ALLOWED_KEYS = new Set(["name"]);

export function parseCreateProjectBody(raw: unknown): ParseCreateProjectBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!CREATE_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  return { ok: true, name: body.name };
}

export type ParseRenameProjectBodyResult =
  | { ok: true; name: unknown; expectedUpdateTime: unknown }
  | { ok: false; reason: "invalid_body" | "unknown_field" };

const RENAME_ALLOWED_KEYS = new Set(["name", "expectedUpdateTime"]);

export function parseRenameProjectBody(raw: unknown): ParseRenameProjectBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!RENAME_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  return { ok: true, name: body.name, expectedUpdateTime: body.expectedUpdateTime };
}

export type ParseStatusTransitionBodyResult = { ok: true; expectedUpdateTime: unknown } | { ok: false; reason: "invalid_body" | "unknown_field" };

const STATUS_TRANSITION_ALLOWED_KEYS = new Set(["expectedUpdateTime"]);

/** Shared by both archive and restore — identical body shape, identical strictness. */
export function parseStatusTransitionBody(raw: unknown): ParseStatusTransitionBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!STATUS_TRANSITION_ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
  }
  return { ok: true, expectedUpdateTime: body.expectedUpdateTime };
}
