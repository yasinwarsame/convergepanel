/**
 * Projects Foundation, Phase 6B — domain types only. No I/O, no route
 * wiring. See docs/workspaces/architecture.md for the Phase 6A/6A.1/6A.2
 * design rationale this implements.
 *
 * Phase 6B defines the shape a Project document will have and the pure
 * logic to validate/resolve against it. It does not create any Project
 * document, does not add `projectId` to any run, and is not called from
 * any route.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";

export type ProjectStatus = "active" | "archived";

/**
 * The Project document itself, at `projects/{id}`. Personal Workspace
 * only (Phase 6) — `workspaceId` always points at a `type: "personal"`
 * Workspace; there is no team/shared Project concept yet.
 *
 * Deliberately has no `ownerUserId` — Project authorization composes
 * through the referenced Workspace's own ownership (see
 * `resolveProjectForOwner`), never a second, parallel ownership field
 * that could drift out of sync with it. `createdByUserId` is kept
 * anyway, but only as non-authoritative audit/display metadata, never
 * read by any authorization check.
 */
export interface ProjectV1 {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  name: string;
  status: ProjectStatus;
  createdByUserId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Structural guard for data read back from Firestore — never a blind
 * cast, since resolution security depends on this. Deliberately does
 * NOT check `projects/{docId}.id === docId` — that's the Firestore
 * document id, which this pure data validator has no way to know; see
 * `getProject()` (`lib/firestore/projects.ts`) for where that check is
 * enforced, mirroring exactly how `isWellFormedWorkspaceV1` vs.
 * `getWorkspace()` already split this same concern.
 *
 * Runtime-validation compatibility policy, deliberately stricter than
 * `isWellFormedWorkspaceV1` on `createdAt`/`updatedAt`: unlike Workspace
 * (where neither timestamp is ever read by an authorization decision, so
 * validating them would be over-validation for a security boundary),
 * Phase 6B's own design explicitly calls for both timestamps to be
 * validated here, so a malformed one can never be blind-cast and read
 * later as if it were a real `Timestamp`.
 * - Strictly validated: `schemaVersion` (must be the literal `1`), `id`
 *   (non-empty string), `workspaceId` (non-empty string), `status`
 *   (must be exactly `"active"` or `"archived"`), `createdByUserId`
 *   (non-empty string), `createdAt`/`updatedAt` (must be genuine
 *   `firebase-admin/firestore` `Timestamp` instances).
 * - Validated for type only, not further constrained: `name` (must be a
 *   non-empty string — full name-quality validation, e.g. length/control
 *   characters, is a separate concern owned by `validateProjectName()`
 *   in `lib/projects/projectName.ts`, applied at write time, not by this
 *   read-time structural guard).
 * - Unknown/unexpected additional fields are ACCEPTED, not rejected —
 *   matching `isWellFormedWorkspaceV1`'s own open/forward-compatible
 *   schema policy.
 */
export function isWellFormedProjectV1(data: unknown): data is ProjectV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.schemaVersion === 1 &&
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.workspaceId === "string" &&
    d.workspaceId.length > 0 &&
    typeof d.name === "string" &&
    d.name.length > 0 &&
    (d.status === "active" || d.status === "archived") &&
    typeof d.createdByUserId === "string" &&
    d.createdByUserId.length > 0 &&
    d.createdAt instanceof Timestamp &&
    d.updatedAt instanceof Timestamp
  );
}
