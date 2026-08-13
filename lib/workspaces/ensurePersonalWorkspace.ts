/**
 * Personal Workspace Provisioning, Phase 2 — the single, centralized
 * provisioning service. Layering (per program spec):
 *
 *   getPersonalWorkspaceId (deterministic id)
 *     -> createPersonalWorkspace / getWorkspace (Firestore primitives)
 *       -> ensurePersonalWorkspace (this file — the service)
 *         -> POST /api/user/workspace (the only caller, and only when
 *            explicitly invoked — never from login/signup/session/any
 *            existing route)
 *
 * Exactly-one guarantee: relies entirely on Firestore `.create()` at the
 * deterministic `personal-{uid}` id — never a query-then-create race. Two
 * concurrent calls for the same uid: exactly one `.create()` succeeds: the
 * other observes ALREADY_EXISTS, reads the now-existing document, and
 * (once validated) returns the SAME canonical workspace. No transaction
 * needed for this property; Firestore's own `.create()` semantics provide
 * it for a single fixed document id.
 *
 * Business logic lives here, not in a route handler or component.
 */

import "server-only";
import { PERSONAL_WORKSPACE_PROVISIONING_ENABLED } from "@/lib/env";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";
import { createPersonalWorkspace, getWorkspace } from "@/lib/firestore/workspaces";
import type { EnsurePersonalWorkspaceResult } from "./types";
import { logger } from "@/lib/logger";

/**
 * Structured, safe-by-construction — an event name plus non-identifying
 * metadata only. Never logs uid (matching this codebase's established
 * convention: no existing route/lib logger call logs a raw uid anywhere),
 * email, tokens, or any content. `conflict`/`failed` events include only
 * the named reason, never the underlying Firestore error or a conflicting
 * document's owner.
 */
function logProvisioningEvent(event: "personal_workspace_created" | "personal_workspace_existing" | "personal_workspace_conflict" | "personal_workspace_failed", metadata?: Record<string, unknown>) {
  logger.info(`[personalWorkspace] ${event}`, metadata);
}

/**
 * Never throws. Every combination of (flag state, uid validity, Firestore
 * outcome, existing-document shape) maps to a named result — see
 * `EnsurePersonalWorkspaceResult`. Idempotent: calling this repeatedly for
 * the same uid, sequentially or concurrently, always converges on exactly
 * one Firestore document and never mutates it once created (no `.set()`/
 * `.update()` call exists anywhere in this function or anything it calls).
 */
export async function ensurePersonalWorkspace(uid: string): Promise<EnsurePersonalWorkspaceResult> {
  if (!PERSONAL_WORKSPACE_PROVISIONING_ENABLED) {
    // Checked before even validating uid — disabled means disabled,
    // with zero Firestore reads or writes either way.
    return { status: "disabled" };
  }

  const idResult = getPersonalWorkspaceId(uid);
  if (!idResult.ok) {
    return { status: "invalid_uid" };
  }

  const createResult = await createPersonalWorkspace(uid);

  if (createResult.status === "created") {
    logProvisioningEvent("personal_workspace_created");
    return { status: "created", workspace: createResult.workspace };
  }
  if (createResult.status === "invalid_uid") {
    // Unreachable given the getPersonalWorkspaceId check above already
    // validated uid identically — kept as an explicit, named branch
    // rather than assuming createPersonalWorkspace can never disagree
    // with its own id-derivation logic.
    return { status: "invalid_uid" };
  }
  if (createResult.status === "firestore_unavailable" || createResult.status === "create_failed") {
    logProvisioningEvent("personal_workspace_failed", { reason: createResult.status });
    return { status: createResult.status === "firestore_unavailable" ? "lookup_failed" : "create_failed" };
  }

  // createResult.status === "already_exists" — a document is already
  // sitting at this deterministic id, from this call, a concurrent call,
  // or a previous provisioning entirely. Read it back and validate it
  // strictly before treating provisioning as successful. Never assume;
  // never overwrite.
  const lookup = await getWorkspace(idResult.workspaceId);

  switch (lookup.status) {
    case "not_found":
      // ALREADY_EXISTS moments ago, gone now — an external actor deleted
      // it in the gap between create and read. Not something this
      // function repairs or retries; report as a lookup failure and let
      // the caller decide whether to invoke ensurePersonalWorkspace again.
      logProvisioningEvent("personal_workspace_failed", { reason: "not_found_after_already_exists" });
      return { status: "lookup_failed" };
    case "firestore_unavailable":
    case "read_failed":
      logProvisioningEvent("personal_workspace_failed", { reason: "lookup_failed" });
      return { status: "lookup_failed" };
    case "malformed":
      // Covers: structurally invalid document, document/request id
      // mismatch, and unsupported schemaVersion — see
      // EnsurePersonalWorkspaceConflictReason's own doc comment for why
      // these three collapse into one reason here.
      logProvisioningEvent("personal_workspace_conflict", { reason: "malformed" });
      return { status: "conflict", reason: "malformed" };
    case "found":
      break;
  }

  const workspace = lookup.workspace;
  // getWorkspace() already guarantees workspace.id === idResult.workspaceId
  // (it returns "malformed" otherwise) — no need to re-check that here.
  if (workspace.type !== "personal") {
    logProvisioningEvent("personal_workspace_conflict", { reason: "wrong_type" });
    return { status: "conflict", reason: "wrong_type" };
  }
  if (workspace.ownerUserId !== uid) {
    logProvisioningEvent("personal_workspace_conflict", { reason: "wrong_owner" });
    return { status: "conflict", reason: "wrong_owner" };
  }

  logProvisioningEvent("personal_workspace_existing");
  return { status: "existing", workspace };
}
