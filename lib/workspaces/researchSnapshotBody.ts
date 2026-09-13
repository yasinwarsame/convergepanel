/**
 * ADD-TO-TEAM-PROJECT §B — request-body parser for
 * `POST /api/workspaces/{workspaceId}/projects/{projectId}/research/snapshots`.
 *
 * The body carries exactly ONE thing: a typed source identity. The
 * destination (`workspaceId`, `projectId`) is owned by the path and is
 * never read from the body; a body that tries to supply it — or any run
 * content (`question`, `results`, `adaptiveOutput`, `governance`,
 * `userId`, `runDocument`, ...) — is rejected as `unknown_field` before
 * anything else happens. The server reconstructs the snapshot exclusively
 * from the persisted source.
 *
 *   { source: { sourceType: "personal_research", runId: string } }
 *
 * `sourceType` is a discriminator, not decoration: the destination refuses
 * to guess whether an id names a run, a verification, or a Team artifact.
 * Only `"personal_research"` is accepted in v1.
 *
 * Pure, zero I/O, never throws.
 */

import { validateRunIdSyntax } from "@/lib/projects/runIdSyntax";

export const RESEARCH_SNAPSHOT_SOURCE_TYPE = "personal_research" as const;

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["source"]);
const ALLOWED_SOURCE_KEYS: ReadonlySet<string> = new Set(["sourceType", "runId"]);

export type ParseResearchSnapshotBodyResult =
  | { ok: true; sourceRunId: string }
  /** Structurally wrong body (not an object, missing `source`, non-string `runId`, ...). Maps to 400 `invalid_request_body`. */
  | { ok: false; reason: "invalid" }
  /** A key outside the allow-list, at either level. Maps to 400 `unexpected_field`. */
  | { ok: false; reason: "unknown_field" }
  /** `sourceType` present but not `"personal_research"`. Maps to 400 `invalid_request_body`. */
  | { ok: false; reason: "unsupported_source_type" }
  /**
   * `runId` is a string but fails run-id syntax (blank, untrimmed, control
   * characters, `/`, `.`/`..`, oversized). Maps to the SAME concealed 404
   * a well-formed-but-foreign source gets — never a distinguishable 400,
   * which would itself be an oracle (mirrors the run→Project association
   * routes).
   */
  | { ok: false; reason: "invalid_run_id" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResearchSnapshotBody(raw: unknown): ParseResearchSnapshotBodyResult {
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid" };
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) return { ok: false, reason: "unknown_field" };
  }
  const source = raw.source;
  if (!isPlainObject(source)) return { ok: false, reason: "invalid" };
  for (const key of Object.keys(source)) {
    if (!ALLOWED_SOURCE_KEYS.has(key)) return { ok: false, reason: "unknown_field" };
  }
  if (typeof source.sourceType !== "string") return { ok: false, reason: "invalid" };
  if (source.sourceType !== RESEARCH_SNAPSHOT_SOURCE_TYPE) return { ok: false, reason: "unsupported_source_type" };
  if (typeof source.runId !== "string") return { ok: false, reason: "invalid" };
  const syntax = validateRunIdSyntax(source.runId);
  if (!syntax.ok) return { ok: false, reason: "invalid_run_id" };
  return { ok: true, sourceRunId: syntax.runId };
}
