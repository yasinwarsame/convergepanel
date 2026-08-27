/**
 * Workspace-Scoped Team Canary, Phase 10B.1 — the target-Workspace
 * admission primitive designed across Phase 10A/10A.1/10A.2/10A.3/10A.4
 * and now implemented. Structural sibling of
 * `lib/workspaces/teamWorkspacesRollout.ts`, additive to it: this module
 * never changes `resolveTeamWorkspacesMode()`'s contract or behavior — it
 * composes that existing, unchanged, USER-scoped resolver with a new,
 * independent Workspace-scoped allowlist to answer a different question
 * ("is Team Workspace capability admitted for THIS caller acting on THIS
 * specific Workspace") without touching the original ("is Team Workspace
 * capability admitted for this uid at all").
 *
 * Precedence (frozen in Phase 10A.1, reconfirmed in every subsequent
 * phase): global always wins; else a valid uid-canary match; else a valid
 * Workspace-canary match for the requested `workspaceId`; else denied.
 * Each source's malformation is evaluated independently — a malformed
 * Workspace-canary list can never poison an otherwise-valid uid-canary
 * admission, and vice versa; only when BOTH sources fail to admit is the
 * result `denied`.
 *
 * `source` on the returned result is diagnostic only (for operator
 * telemetry/logging). No route or resolver may branch on it to grant a
 * different capability set — capabilities come only from canonical
 * Workspace membership/role, exactly as before this module existed; this
 * resolver answers admission, never authorization.
 *
 * This phase (10B.1) implements and tests this primitive in isolation
 * only. No production call site is wired to it yet — see the Phase 10B.1
 * prompt's explicit scope boundary. `TEAM_WORKSPACES_CANARY_WORKSPACE_IDS`
 * is also not configured by this phase, so Production behavior is
 * unchanged by this module's mere existence.
 */

import "server-only";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";

/** Narrow backend-capability canary, not an authorization/write mechanism on its own — mirrors `MAX_TEAM_WORKSPACES_CANARY_UIDS`. */
export const MAX_TEAM_WORKSPACE_CANARY_WORKSPACE_IDS = 10;

/**
 * Generous upper bound on one Workspace-id entry's length in the canary
 * list — well above any real Workspace id (Firestore auto-ids are exactly
 * 20 characters) but far below Firestore's own 1500-byte document-id
 * limit, so a pathological config value fails fast rather than merely
 * failing to match at Firestore-read time.
 */
const MAX_WORKSPACE_ID_ENTRY_LENGTH = 128;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Purpose-built shape check for a raw Workspace document id, deliberately
 * NOT a reuse of `getPersonalWorkspaceId()` — that helper's job is to
 * *construct* a `personal-{uid}` Personal Workspace id from a Firebase
 * uid (a different string, with a prefix this module must never add) and
 * to validate uid shape specifically. A Team Workspace id is a bare
 * Firestore auto-id with no prefix and no relationship to any uid; this
 * function validates exactly that shape, reusing only the same class of
 * underlying Firestore-document-id-safety checks (no control characters,
 * no `/`, not the reserved `.`/`..` segments, no wildcard, no empty
 * value, a sane maximum length) without transforming the input at all.
 */
function isPlausibleWorkspaceIdShape(value: string): boolean {
  if (value.length === 0) return false;
  if (value !== value.trim()) return false; // no incidental leading/trailing whitespace
  if (CONTROL_CHAR_PATTERN.test(value)) return false;
  if (value.includes("/")) return false;
  if (value === "." || value === "..") return false;
  if (value === "*") return false;
  if (Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_ID_ENTRY_LENGTH) return false;
  return true;
}

export type TeamWorkspaceCanaryWorkspaceIdsParseResult = { ok: true; workspaceIds: ReadonlySet<string> } | { ok: false; reason: "malformed_entry" | "too_many_entries" };

/**
 * Absent, empty, or whitespace-only input parses to an empty (valid, not
 * malformed) allowlist — mirrors `parseTeamWorkspacesCanaryUids()`
 * exactly. A non-empty but invalid input (any entry failing
 * `isPlausibleWorkspaceIdShape()`, or more than
 * `MAX_TEAM_WORKSPACE_CANARY_WORKSPACE_IDS` distinct entries after
 * dedupe) fails the WHOLE list, never partially — see
 * `resolveTeamWorkspaceTargetAdmission()`/`capacityControlled()` for what
 * a `false` result here actually does to eligibility (fails closed for
 * the Workspace-canary source specifically, never poisons the
 * independent uid-canary source).
 */
export function parseTeamWorkspaceCanaryWorkspaceIds(raw: string | undefined): TeamWorkspaceCanaryWorkspaceIdsParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, workspaceIds: new Set() };
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const workspaceIds = new Set(entries); // exact-string dedupe — duplicate entries collapse deterministically, never counted twice against the max

  if (workspaceIds.size > MAX_TEAM_WORKSPACE_CANARY_WORKSPACE_IDS) {
    return { ok: false, reason: "too_many_entries" };
  }
  const anyInvalid = [...workspaceIds].some((id) => !isPlausibleWorkspaceIdShape(id));
  if (anyInvalid) {
    return { ok: false, reason: "malformed_entry" };
  }
  return { ok: true, workspaceIds };
}

export type TeamWorkspaceTargetAdmissionSource = "global" | "uid_canary" | "workspace_canary" | "denied";

export interface TeamWorkspaceTargetAdmissionResult {
  enabled: boolean;
  /** Diagnostic only — see module doc comment. Never branch authorization logic on this. */
  source: TeamWorkspaceTargetAdmissionSource;
}

/**
 * The single target-Workspace admission decision point for the
 * Workspace-scoped Team canary. Composes the existing, unchanged
 * `resolveTeamWorkspacesMode()` (user-scoped: global or uid-canary) with
 * the new Workspace-canary list, evaluated only if the user-scoped
 * resolver did not already admit. Each source's malformed-list handling
 * is fully independent — `resolveTeamWorkspacesMode()` already fails
 * closed on its own malformed uid list internally (returning
 * `enabled:false` unless global), so this function's own Workspace-list
 * parse is only ever reached, and only ever matters, once that
 * independent user-scoped path has already failed to admit.
 */
export function resolveTeamWorkspaceTargetAdmission(args: {
  uid: string;
  workspaceId: string;
  globalEnabled: boolean;
  canaryUidsRaw: string | undefined;
  canaryWorkspaceIdsRaw: string | undefined;
}): TeamWorkspaceTargetAdmissionResult {
  const userMode = resolveTeamWorkspacesMode({ uid: args.uid, globalEnabled: args.globalEnabled, canaryUidsRaw: args.canaryUidsRaw });
  if (userMode.enabled) {
    return { enabled: true, source: userMode.source === "global" ? "global" : "uid_canary" };
  }

  const workspaceParsed = parseTeamWorkspaceCanaryWorkspaceIds(args.canaryWorkspaceIdsRaw);
  if (workspaceParsed.ok && workspaceParsed.workspaceIds.has(args.workspaceId)) {
    return { enabled: true, source: "workspace_canary" };
  }

  return { enabled: false, source: "denied" };
}

/**
 * Pure predicate: does capacity accounting apply to this Workspace right
 * now. Frozen in Phase 10A.3/10A.4: capacity is a property of the target
 * Workspace's OWN Workspace-canary admission, evaluated independently of
 * how the acting caller happens to be admitted — a uid-canary-admitted
 * Owner of a Workspace-canary-admitted Workspace is still
 * capacity-controlled (this predicate deliberately takes no `uid`/
 * `canaryUidsRaw` at all, so it is structurally incapable of considering
 * the actor's own admission source). Capacity becomes fully inert the
 * instant `globalEnabled` is true, for every Workspace, regardless of
 * `reservedCount` — a Tier-2 containment mechanism must never silently
 * become a permanent GA team-size limit. A malformed Workspace-canary
 * list means no Workspace becomes capacity-controlled through that
 * source (fails closed, never fails open).
 */
export function capacityControlled(args: { workspaceId: string; globalEnabled: boolean; canaryWorkspaceIdsRaw: string | undefined }): boolean {
  if (args.globalEnabled) return false;
  const parsed = parseTeamWorkspaceCanaryWorkspaceIds(args.canaryWorkspaceIdsRaw);
  return parsed.ok && parsed.workspaceIds.has(args.workspaceId);
}
