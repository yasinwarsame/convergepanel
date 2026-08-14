/**
 * Phase 4B — Mandatory Workspace Integrity for Workspace-Bound Run Reads.
 *
 * The single, requester-independent Layer-A primitive: "is this persisted
 * run's Workspace association internally valid?" Takes the run's own
 * canonical data ONLY — no requester uid, reviewer uid, or admin role, and
 * (as of the Phase 4B security re-review) no caller-supplied owner uid
 * either. The owning uid is derived exclusively from `runData.userId`,
 * never accepted as a separate parameter. An earlier revision took
 * `(userId, runData)`, and one real call site (the owner-history list)
 * passed the AUTHENTICATED REQUESTER's uid rather than the row's own
 * `userId` — safe only because that route's query happens to guarantee
 * the two are equal, with nothing in the function itself enforcing it. A
 * future call site copying that pattern into a context where they differ
 * would have silently validated the wrong owner. Deriving the owner
 * internally makes that class of misuse structurally impossible: there is
 * no parameter a caller could get wrong.
 *
 * Built on Phase 1's `resolveWorkspaceContextForResource()` verbatim — no
 * duplicated presence/shape/schema parsing. It adds exactly the two checks
 * Phase 1 never needed because Phase 1 had no `run` object to cross-check
 * against: (1) `run.workspaceId` must equal the deterministic id for
 * `run.userId` — a run cannot legitimately reference anyone else's Personal
 * Workspace by construction (Phase 3 never binds one there); (2) the
 * resolved Workspace's own `ownerUserId` must equal `run.userId` — defense
 * against a Workspace document's `ownerUserId` field being mutated after
 * the run was created (Phase 1's `checkWorkspaceAccess` only ever compares
 * the *requester* against the Workspace owner, never the *run* against it).
 * Both checks are independently necessary: (1) catches a corrupted
 * `run.workspaceId`; (2) catches a corrupted Workspace document — a
 * violation of one does not imply the other.
 *
 * See docs/workspaces/architecture.md's Phase 4B section and
 * docs/workspaces/phase4a-read-authorization-audit.md for the full design
 * rationale and threat model this implements.
 */

import "server-only";
import { resolveWorkspaceContextForResource } from "./workspaceResolver";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";

export type RunWorkspaceIntegrityReason =
  | "workspaces_disabled"
  | "malformed_workspace_id"
  | "run_owner_invalid"
  | "deterministic_id_mismatch"
  | "workspace_not_found"
  | "workspace_lookup_failed"
  /**
   * Covers both a structurally malformed Workspace document AND an
   * unsupported `schemaVersion` — Phase 1's `getWorkspace()` already
   * collapses both into its own single `malformed` status (confirmed by
   * direct source read: `d.schemaVersion === 1` is checked inside the same
   * guard as `id`/`type`/`ownerUserId`, with no separate outcome). Phase 4B
   * does not invent a finer split the data layer has no way to actually
   * distinguish — the same collapse-and-document approach Phase 2 already
   * used for `EnsurePersonalWorkspaceConflictReason`.
   */
  | "workspace_malformed"
  | "workspace_wrong_type"
  | "workspace_owner_mismatch";

export type RunWorkspaceIntegrityResult =
  | { classification: "legacy" }
  | { classification: "valid"; workspaceId: string }
  | { classification: "invalid"; reason: RunWorkspaceIntegrityReason };

/**
 * `runData` is the run's own already-fetched Firestore data — never a
 * reconstructed `{ userId, workspaceId }` object literal. In JavaScript, an
 * object literal with a `workspaceId:` key ALWAYS creates an own property
 * on the new object, even when the value is `undefined` because the source
 * never had the key at all — `hasOwnProperty` would then report `true` for
 * every run, and a truly legacy run would misclassify as present-but-
 * invalid. Checking presence directly on the run's own fetched document
 * (never a copy) makes that bug structurally impossible at any call site.
 */
export async function validateRunWorkspaceAssociation(runData: Record<string, unknown>): Promise<RunWorkspaceIntegrityResult> {
  const hasWorkspaceIdProperty = Object.prototype.hasOwnProperty.call(runData, "workspaceId");
  if (!hasWorkspaceIdProperty) {
    // Truly absent — the ONLY legacy trigger. No resolver call, no Firestore read.
    return { classification: "legacy" };
  }

  const rawWorkspaceId = runData.workspaceId;

  // A property that IS present but whose value is `undefined` must never
  // reach the resolver as-is: resolveWorkspaceContext()'s own legacy
  // trigger is keyed on `workspaceId === undefined` (a VALUE check), not on
  // property presence. Passing this value through would let the resolver
  // silently reclassify a present-but-invalid association as legacy —
  // exactly the property-presence-vs-value bug this primitive exists to
  // close. In real Firestore data this state can't arise (the SDK never
  // persists an `undefined` field value), but the check is defensive
  // against any in-memory construction of a run-like object that does.
  if (rawWorkspaceId === undefined) {
    return { classification: "invalid", reason: "malformed_workspace_id" };
  }

  // The owning uid is derived exclusively from the run's own canonical
  // field — never a caller-supplied parameter. A run whose own `userId`
  // isn't a valid, well-formed uid can never have a legitimately bound
  // Workspace, regardless of what workspaceId it claims.
  const ownerUserId = typeof runData.userId === "string" ? runData.userId : "";
  const expected = getPersonalWorkspaceId(ownerUserId);
  if (!expected.ok) {
    return { classification: "invalid", reason: "run_owner_invalid" };
  }

  if (typeof rawWorkspaceId !== "string" || rawWorkspaceId.trim().length === 0) {
    return { classification: "invalid", reason: "malformed_workspace_id" };
  }

  if (rawWorkspaceId !== expected.workspaceId) {
    // The run's own claimed workspaceId is not the deterministic id for
    // its own owner. Fails closed before any Firestore read — a mismatch
    // here is disqualifying regardless of what (if anything) the claimed
    // id happens to point to.
    return { classification: "invalid", reason: "deterministic_id_mismatch" };
  }

  const resolution = await resolveWorkspaceContextForResource({
    workspaceId: rawWorkspaceId,
    legacyOwnerUserId: ownerUserId,
  });

  switch (resolution.kind) {
    case "legacy":
      // Structurally unreachable: rawWorkspaceId has already been proven a
      // validated non-empty string above, and `legacy` only ever occurs for
      // `workspaceId === undefined`. Handled explicitly (fail closed, never
      // thrown) rather than asserted away, consistent with this module's
      // own "never a silent unknown-treat-as-legacy branch" principle.
      return { classification: "invalid", reason: "malformed_workspace_id" };
    case "workspaces_disabled":
      return { classification: "invalid", reason: "workspaces_disabled" };
    case "not_found":
      return { classification: "invalid", reason: "workspace_not_found" };
    case "lookup_failed":
      return { classification: "invalid", reason: "workspace_lookup_failed" };
    case "malformed":
      return { classification: "invalid", reason: "workspace_malformed" };
    case "unsupported_workspace_type":
      return { classification: "invalid", reason: "workspace_wrong_type" };
    case "resolved":
      if (resolution.context.ownerUserId !== ownerUserId) {
        return { classification: "invalid", reason: "workspace_owner_mismatch" };
      }
      return { classification: "valid", workspaceId: resolution.context.workspaceId };
  }
}
