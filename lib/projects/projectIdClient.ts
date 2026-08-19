/**
 * Phase 7E-A — client-safe mirror of `validateProjectIdSyntax()`'s pure
 * shape check (`lib/projects/projectId.ts`, `"server-only"`-guarded and
 * therefore unimportable from a client hook/component). Same established
 * pattern as `updateTimeTokenClient.ts`/`projectNameClient.ts` from Phase
 * 7D: an intentional, documented duplicate of ONLY the pure syntax check —
 * the server file remains the sole authority for anything beyond shape.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const MAX_PROJECT_ID_BYTES = 1500;

export function isValidProjectIdSyntaxClientSide(projectId: unknown): projectId is string {
  if (typeof projectId !== "string") return false;
  if (projectId.length === 0) return false;
  if (projectId.trim() !== projectId) return false;
  if (CONTROL_CHAR_PATTERN.test(projectId)) return false;
  if (projectId.includes("/")) return false;
  if (projectId === "." || projectId === "..") return false;
  if (new TextEncoder().encode(projectId).length > MAX_PROJECT_ID_BYTES) return false;
  return true;
}
