/**
 * Existing-User Personal Workspace Provisioning, Phase 2B — the discovery
 * (dry-run) and execution (mutating) layers. Both reuse the
 * already-production-proven Phase 1/2 primitives verbatim — this module
 * adds no new Firestore write path and no deterministic-id/create/
 * conflict logic of its own:
 *
 *   discovery -> getWorkspace()               (Phase 1, read-only)
 *   execution -> ensurePersonalWorkspace()     (Phase 2, the proven service)
 *
 * Structural safety invariant, enforced by construction, not convention:
 * `discoverUserWorkspaceStatus()` never imports `ensurePersonalWorkspace`
 * or `createPersonalWorkspace` — dry-run mode is incapable of writing,
 * not merely configured not to.
 */

import "server-only";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { getPersonalWorkspaceId } from "./personalWorkspaceId";
import { ensurePersonalWorkspace } from "./ensurePersonalWorkspace";
import { classifyUserEligibility, type AuthUserForEligibility } from "./provisioningEligibility";

export type DiscoveryResult =
  | { status: "missing" }
  | { status: "existing_valid" }
  | { status: "conflict"; reason: "wrong_owner" | "wrong_type" | "malformed" }
  | { status: "lookup_failed" }
  | { status: "excluded"; reason: "excluded_disabled" | "excluded_explicit" }
  | { status: "invalid_uid" };

export type ExecutionResult =
  | { status: "created" }
  | { status: "existing" }
  | { status: "conflict"; reason: "wrong_owner" | "wrong_type" | "malformed" }
  | { status: "excluded"; reason: "excluded_disabled" | "excluded_explicit" }
  | { status: "invalid_uid" }
  | { status: "failed" };

/**
 * Read-only. Classifies eligibility first (zero I/O for excluded users),
 * then — for eligible users only — performs exactly one `getWorkspace()`
 * read and classifies what it finds. Never calls anything that writes.
 */
export async function discoverUserWorkspaceStatus(user: AuthUserForEligibility, excludedUids: ReadonlySet<string>): Promise<DiscoveryResult> {
  const eligibility = classifyUserEligibility(user, excludedUids);
  if (!eligibility.eligible) {
    return { status: "excluded", reason: eligibility.reason };
  }

  const idResult = getPersonalWorkspaceId(user.uid);
  if (!idResult.ok) {
    return { status: "invalid_uid" };
  }

  const lookup = await getWorkspace(idResult.workspaceId);
  switch (lookup.status) {
    case "not_found":
      return { status: "missing" };
    case "malformed":
      return { status: "conflict", reason: "malformed" };
    case "firestore_unavailable":
    case "read_failed":
      return { status: "lookup_failed" };
    case "found": {
      const workspace = lookup.workspace;
      if (workspace.type !== "personal") {
        return { status: "conflict", reason: "wrong_type" };
      }
      if (workspace.ownerUserId !== user.uid) {
        return { status: "conflict", reason: "wrong_owner" };
      }
      return { status: "existing_valid" };
    }
  }
}

/**
 * The only function in this module that can write, and only by delegating
 * entirely to `ensurePersonalWorkspace()` — no reimplemented create/
 * conflict logic. Excluded users are filtered before that call, so an
 * excluded uid never reaches the provisioning service at all.
 */
export async function provisionUserWorkspace(user: AuthUserForEligibility, excludedUids: ReadonlySet<string>): Promise<ExecutionResult> {
  const eligibility = classifyUserEligibility(user, excludedUids);
  if (!eligibility.eligible) {
    return { status: "excluded", reason: eligibility.reason };
  }

  const result = await ensurePersonalWorkspace(user.uid);
  switch (result.status) {
    case "created":
      return { status: "created" };
    case "existing":
      return { status: "existing" };
    case "conflict":
      return { status: "conflict", reason: result.reason };
    case "invalid_uid":
      return { status: "invalid_uid" };
    case "disabled":
    case "lookup_failed":
    case "create_failed":
      // "disabled" here means PERSONAL_WORKSPACE_PROVISIONING_ENABLED was
      // off at the moment of the call — a caller/operator configuration
      // issue, not a per-user outcome. Reported as a failure for this
      // user's row so it's visible in the result artifact rather than
      // silently absorbed, but it signals "check the flag," not "this
      // user is broken."
      return { status: "failed" };
  }
}

/**
 * Minimal bounded-concurrency mapper — runs `fn` for every item in
 * `items`, never more than `concurrency` in flight at once. No external
 * dependency; simple enough to keep dependency-free and fully unit-testable
 * (tests assert the observed-in-flight count never exceeds the configured
 * limit, not just the final result set).
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
