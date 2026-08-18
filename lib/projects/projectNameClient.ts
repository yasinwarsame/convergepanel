/**
 * Phase 7D — client-safe mirror of `lib/projects/projectName.ts`'s
 * `validateProjectName()` (that module has `import "server-only"` and
 * cannot be imported client-side). Duplicated verbatim — same bounds, same
 * control-character pattern, same trim-then-validate order — so client and
 * server never disagree about what's acceptable. This is presentation
 * convenience only (disabling Submit, showing an inline hint); the server
 * remains the sole authority and re-validates independently on every
 * request.
 */

const MIN_PROJECT_NAME_LENGTH = 1;
const MAX_PROJECT_NAME_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

export function isValidProjectNameClientSide(rawName: string): boolean {
  const trimmed = rawName.trim();
  if (trimmed.length < MIN_PROJECT_NAME_LENGTH) return false;
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return false;
  if (CONTROL_CHAR_PATTERN.test(trimmed)) return false;
  return true;
}

export const PROJECT_NAME_MAX_LENGTH = MAX_PROJECT_NAME_LENGTH;
