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
import * as fs from "fs";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";

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

/** Parses a newline-delimited uid list (one uid per line, blank lines and `#`-comments ignored) into a Set — the shape `--exclude-file` reads. Pure; the CLI script does the actual file read. CRLF-safe: `.trim()` strips a trailing `\r` (and a leading UTF-8 BOM on the first line) the same as any other whitespace. Does NOT validate uid syntax — see `validateExclusionUids()`, a deliberately separate step so a malformed entry can be reported with the exact offending value rather than silently dropped here. */
export function parseExclusionList(fileContents: string): Set<string> {
  const uids = fileContents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return new Set(uids);
}

export type ExclusionValidationResult = { ok: true } | { ok: false; reason: "malformed_exclusion_uid"; invalidUids: string[]; message: string };

/**
 * An exclusion is a safety mechanism — an operator listing a uid here is
 * explicitly trusting it to be skipped. Silently ignoring a malformed
 * entry (rather than rejecting it) would mean that trust is violated
 * without any signal, which is worse than rejecting a well-formed one by
 * mistake. Reuses `getPersonalWorkspaceId()` — the same uid-shape
 * validator already used everywhere else a uid becomes a Firestore
 * document id — rather than inventing separate exclusion-specific
 * validation rules that could disagree with it.
 */
export function validateExclusionUids(uids: ReadonlySet<string>): ExclusionValidationResult {
  const invalidUids = [...uids].filter((uid) => !getPersonalWorkspaceId(uid).ok);
  if (invalidUids.length > 0) {
    return {
      ok: false,
      reason: "malformed_exclusion_uid",
      invalidUids,
      message: `Refusing to proceed: ${invalidUids.length} exclusion entr${invalidUids.length === 1 ? "y is" : "ies are"} not a well-formed uid: ${invalidUids.map((u) => JSON.stringify(u)).join(", ")}. Fix or remove ${invalidUids.length === 1 ? "it" : "them"} before continuing — an exclusion that can't be validated is never silently dropped.`,
    };
  }
  return { ok: true };
}

/**
 * Reads an exclusion file's raw contents. This is the one deliberate I/O
 * exception in an otherwise pure module — kept here (rather than left
 * inline in the CLI script) specifically so the "can't read the file ->
 * must never silently proceed with zero exclusions" behavior is
 * independently testable. Throws with a clear, non-raw-stack-trace
 * message on any read failure (missing file, permission denied, etc.);
 * the caller (the CLI script) is responsible for turning that into a
 * process abort — this function's only job is "can the intended
 * exclusion set be loaded, yes or no."
 */
export function readExclusionFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e: any) {
    throw new Error(`Could not read exclusion file "${filePath}": ${e?.code ?? e?.message ?? "unknown error"}`);
  }
}

/**
 * Builds the final exclusion Set from CLI-supplied uids plus an optional
 * exclusion file. Propagates (never swallows) `readExclusionFile()`'s
 * throw when a file is specified but unreadable — a caller passing
 * `--exclude-file` explicitly intended those uids to be excluded, so
 * failing to load them must never silently degrade to "no file-based
 * exclusions."
 */
export function loadExclusionSet(cliUids: readonly string[], filePath: string | undefined): Set<string> {
  const set = new Set<string>(cliUids);
  if (filePath) {
    const contents = readExclusionFile(filePath);
    for (const uid of parseExclusionList(contents)) set.add(uid);
  }
  return set;
}
