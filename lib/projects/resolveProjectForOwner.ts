/**
 * Projects Foundation, Phase 6B — full canonical Project resolution for
 * the authenticated caller's own uid. Structural sibling of
 * `resolvePersonalWorkspaceForOwner()`, and reuses it verbatim for the
 * caller's-own-Workspace half of the check.
 *
 * Read order (frozen by Phase 6A.2, do not reorder):
 *   1. validate `projectId` syntax
 *   2. read `projects/{projectId}`
 *   3. validate `ProjectV1` shape + embedded id === document id
 *      (both enforced inside `getProject()`, collapsed into `malformed`)
 *   4. compute `expectedWorkspaceId = getPersonalWorkspaceId(uid)` — pure,
 *      no I/O
 *   5. if `project.workspaceId !== expectedWorkspaceId` -> `workspace_mismatch`,
 *      STOP. Deliberately never fetches the Workspace the Project actually
 *      references when it isn't the caller's own deterministic Personal
 *      Workspace id — there is nothing to prove by reading another
 *      tenant's Workspace document merely to confirm it isn't the
 *      caller's. This is the concrete efficiency and tenant-boundary gain
 *      Phase 6A.1 introduced: zero extra reads for a foreign Project,
 *      down from one.
 *   6. only once the id matches: resolve/validate the caller's OWN
 *      Workspace via `resolvePersonalWorkspaceForOwner(uid)` (Phase 5B,
 *      reused unmodified) — this is NOT redundant with step 5. A
 *      deterministic id match alone never proves the document at that id
 *      is trustworthy: it could be missing, malformed, or — the case that
 *      matters most — genuinely present but corrupted/tampered so its own
 *      `ownerUserId` field disagrees with what the id implies. Step 6 is
 *      what catches that; a corrupt `personal-{uid}` document must never
 *      become authorized merely because its document id happens to be
 *      deterministic.
 *
 * Every outcome below is grounded in an actual status
 * `resolvePersonalWorkspaceForOwner()`/`getProject()` can really return —
 * none are aspirational. Phase 6B has no API route yet, so nothing here
 * decides an HTTP status; the public-concealment mapping (existence/
 * authorization failures -> 404 `project_not_found`; `lookup_failed` ->
 * 503) is Phase 6C's job.
 *
 * Phase 6C addition: the `found` outcome now also carries
 * `documentUpdateTime` (Firestore's native document `updateTime`,
 * unmodified pass-through from `getProject()`) — additive only, read
 * order and every other outcome are unchanged from Phase 6B. This is what
 * lets the rename/archive/restore routes use `expectedUpdateTime` OCC
 * without a second Firestore read.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import { getProject } from "@/lib/firestore/projects";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { validateProjectIdSyntax } from "./projectId";
import type { ProjectV1 } from "./types";

export type ResolveProjectForOwnerResult =
  // `documentUpdateTime` is additive (Phase 6C) — Firestore's native
  // document `updateTime` at the point of read, passed through
  // unmodified from `getProject()`. Never derived from `project.updatedAt`;
  // see `lib/projects/updateTimeToken.ts`. Existing Phase 6B callers that
  // only destructure `{status, project}` are unaffected.
  | { status: "found"; project: ProjectV1; documentUpdateTime: Timestamp }
  | { status: "invalid_project_id" }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "workspace_mismatch" }
  | { status: "workspaces_disabled" }
  | { status: "workspace_missing" }
  | { status: "workspace_invalid" }
  | { status: "unsupported_workspace" }
  | { status: "lookup_failed" };

export async function resolveProjectForOwner(uid: string, projectId: string): Promise<ResolveProjectForOwnerResult> {
  const idSyntax = validateProjectIdSyntax(projectId);
  if (!idSyntax.ok) {
    return { status: "invalid_project_id" };
  }

  const lookup = await getProject(idSyntax.projectId);
  switch (lookup.status) {
    case "not_found":
      return { status: "not_found" };
    case "malformed":
      return { status: "malformed" };
    case "firestore_unavailable":
    case "read_failed":
      return { status: "lookup_failed" };
    case "found":
      break;
  }
  const project = lookup.project;
  const documentUpdateTime = lookup.documentUpdateTime;

  // Step 4-5: compare against the caller's own deterministic Personal
  // Workspace id BEFORE ever reading any Workspace document. A mismatch
  // here is conclusive on its own — the Project cannot belong to the
  // caller regardless of what its referenced Workspace turns out to be.
  const expectedWorkspaceIdResult = getPersonalWorkspaceId(uid);
  if (!expectedWorkspaceIdResult.ok) {
    // Defensive only: an invalid `uid` reaching this point would mean a
    // caller-identity bug upstream of this resolver (every route-level
    // identity resolver already validates the authenticated uid before
    // it gets here). Fails closed rather than silently proceeding.
    return { status: "lookup_failed" };
  }
  if (project.workspaceId !== expectedWorkspaceIdResult.workspaceId) {
    return { status: "workspace_mismatch" };
  }

  // Step 6: only reached once the Project's workspaceId matches the
  // caller's own deterministic id. Reuses the full canonical Personal
  // Workspace resolver unmodified — never re-implements ownership/type
  // validation here.
  const workspaceResult = await resolvePersonalWorkspaceForOwner(uid);
  switch (workspaceResult.status) {
    case "found":
      return { status: "found", project, documentUpdateTime };
    case "workspaces_disabled":
      return { status: "workspaces_disabled" };
    case "not_found":
      return { status: "workspace_missing" };
    case "malformed":
    case "wrong_owner":
      // Both collapse to the same outcome here: a document exists at the
      // caller's own deterministic Workspace id but cannot be trusted as
      // theirs — whether because it's structurally malformed, or because
      // it's well-formed but its own `ownerUserId` disagrees with what
      // the deterministic id implies (a corrupt/tampered document). A
      // deterministic id match is never sufficient authorization on its
      // own; this is precisely the case Phase 6A.2 flagged as the one
      // that must fail closed rather than being silently trusted.
      return { status: "workspace_invalid" };
    case "wrong_type":
      return { status: "unsupported_workspace" };
    case "invalid_uid":
      // Structurally unreachable in practice: `getPersonalWorkspaceId(uid)`
      // already succeeded above using this same uid, so
      // `resolvePersonalWorkspaceForOwner`'s own internal call to it
      // cannot fail here. Handled anyway, fail-closed, rather than left
      // as an unchecked case.
      return { status: "lookup_failed" };
    case "lookup_failed":
      return { status: "lookup_failed" };
  }
}
