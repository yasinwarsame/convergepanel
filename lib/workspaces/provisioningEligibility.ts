/**
 * Existing-User Personal Workspace Provisioning, Phase 2B — pure
 * eligibility classification. No I/O: takes an already-fetched Auth user
 * record plus an already-built exclusion set, returns a verdict. Kept
 * separate from the discovery/execution layer so eligibility rules can be
 * unit-tested without mocking Firebase Auth or Firestore at all.
 *
 * Eligibility source decision (audited, not assumed — see
 * docs/workspaces/architecture.md "Phase 2B — Existing-User Provisioning"):
 * Firebase Auth is canonical, NOT `users/{uid}`. Firestore profile
 * creation is client-side and non-atomic with Auth account creation
 * (`app/signup/page.tsx`: `createUserWithEmailAndPassword` then a
 * separate `setDoc` call) — an interrupted signup leaves a real Auth user
 * with no Firestore profile at all, and `ensurePersonalWorkspace()`
 * already has zero dependency on `users/{uid}` (Phase 2's own design).
 * Enumerating Firestore instead of Auth would silently skip exactly the
 * accounts this phase most needs to cover. A `users/{uid}` document with
 * no matching Auth user (an orphan profile) is never provisioned — it
 * simply never appears in the population at all, because the population
 * is built by enumerating Auth, never by enumerating Firestore.
 */

import "server-only";

export type UserEligibility = { eligible: true } | { eligible: false; reason: "excluded_disabled" | "excluded_explicit" };

/**
 * The minimal shape this function needs from a Firebase Auth `UserRecord`
 * — never the full SDK type, so this stays trivially fakeable in tests.
 */
export interface AuthUserForEligibility {
  uid: string;
  /** Firebase Auth's own native field — the one that actually blocks sign-in. Authoritative; Firestore's separate `UserProfile.isDisabled` is not consulted here (see the module doc comment: Auth is the sole source of truth for this phase's population). */
  disabled: boolean;
}

/**
 * `excludedUids` is operator-supplied (CLI `--exclude-uid`/`--exclude-file`
 * — see scripts/workspaces/provision-existing-personal-workspaces.ts).
 * Deliberately never a hardcoded email/uid list in production code — no
 * service/test/internal account identity is baked into this module.
 */
export function classifyUserEligibility(user: AuthUserForEligibility, excludedUids: ReadonlySet<string>): UserEligibility {
  if (user.disabled) {
    return { eligible: false, reason: "excluded_disabled" };
  }
  if (excludedUids.has(user.uid)) {
    return { eligible: false, reason: "excluded_explicit" };
  }
  return { eligible: true };
}

/** Parses a newline-delimited uid list (one uid per line, blank lines and `#`-comments ignored) into a Set — the shape `--exclude-file` reads. Pure; the CLI script does the actual file read. */
export function parseExclusionList(fileContents: string): Set<string> {
  const uids = fileContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return new Set(uids);
}
