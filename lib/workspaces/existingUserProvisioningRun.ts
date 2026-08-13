/**
 * Existing-User Personal Workspace Provisioning, Phase 2B — the full
 * pagination + bounded-concurrency + aggregation orchestration, extracted
 * out of the CLI script (scripts/workspaces/provision-existing-personal-workspaces.ts)
 * specifically so it's testable without mocking the entire Firebase Admin
 * SDK: `listUsersPage` is dependency-injected, so tests supply a fake,
 * controlled, multi-page fixture instead. The real CLI script's only job
 * is providing the real `adminAuth.listUsers` binding, parsing argv, and
 * writing the result file — no orchestration logic lives there.
 */

import "server-only";
import { discoverUserWorkspaceStatus, provisionUserWorkspace, mapWithConcurrency } from "./existingUserProvisioning";
import type { AuthUserForEligibility } from "./provisioningEligibility";

export interface ListUsersPage {
  users: AuthUserForEligibility[];
  pageToken?: string;
}

export type ListUsersPageFn = (pageToken: string | undefined) => Promise<ListUsersPage>;

export type PerUserRecord = { uid: string; status: string; reason?: string };

export interface RunProvisioningOptions {
  dryRun: boolean;
  concurrency: number;
  excludedUids: ReadonlySet<string>;
  startPageToken?: string;
  listUsersPage: ListUsersPageFn;
  onPageComplete?: (info: { scanned: number; eligible: number; excluded: number; nextPageToken: string | undefined }) => void;
}

export interface RunFatalError {
  /** A short, stable classification — never the raw thrown error/exception, which could carry internal details (stack traces, credential-adjacent text) unsafe to persist in a result artifact. */
  code: "enumeration_failed";
  message: string;
}

export interface RunProvisioningResult {
  /**
   * "complete" only if every page was enumerated and processed —
   * `pageToken` was exhausted (`undefined`), not merely that the loop
   * stopped. "incomplete" means a fatal error interrupted enumeration
   * partway through; whatever was aggregated up to that point is still
   * returned (never discarded), but this result must never be treated as
   * proof of full coverage — see `isCompleteWithFullCoverage()` below,
   * which is the only sanctioned way to check a Phase-3-readiness gate
   * against this result.
   */
  status: "complete" | "incomplete";
  totals: { scanned: number; eligible: number; excluded: number };
  counts: Record<string, number>;
  conflicts: PerUserRecord[];
  failures: PerUserRecord[];
  excludedRecords: PerUserRecord[];
  lastPageToken: string | null;
  pageCount: number;
  fatalError?: RunFatalError;
}

/**
 * The single orchestration loop shared by dry-run and execute. Never
 * writes when `dryRun` is true — dispatches to `discoverUserWorkspaceStatus`
 * (read-only) instead of `provisionUserWorkspace` (the only function that
 * can write) based purely on this flag, checked once per user via a plain
 * ternary — there is no other conditional write path anywhere in this loop.
 *
 * Never throws for an Auth-enumeration failure (`options.listUsersPage`
 * rejecting) — that's an expected-to-happen-eventually operational fault
 * (network blip, transient Auth API error), not a bug, and a thrown
 * exception here would make the CLI script lose every already-aggregated
 * per-user result for the pages that DID succeed. Instead, the failure is
 * caught, `status: "incomplete"` plus a sanitized `fatalError` are
 * attached, and whatever was aggregated so far is returned normally so
 * the caller can still persist a result artifact. A genuinely unexpected
 * bug elsewhere (not in `listUsersPage`) is deliberately left to propagate
 * — this function only absorbs the one failure mode it knows how to
 * describe safely.
 */
export async function runExistingUserProvisioning(options: RunProvisioningOptions): Promise<RunProvisioningResult> {
  const counts: Record<string, number> = {};
  const conflicts: PerUserRecord[] = [];
  const failures: PerUserRecord[] = [];
  const excludedRecords: PerUserRecord[] = [];
  let scanned = 0;
  let eligible = 0;
  let excluded = 0;
  let lastPageToken: string | null = null;
  let pageCount = 0;

  let pageToken: string | undefined = options.startPageToken;
  do {
    let page;
    try {
      page = await options.listUsersPage(pageToken);
    } catch {
      return {
        status: "incomplete",
        totals: { scanned, eligible, excluded },
        counts,
        conflicts,
        failures,
        excludedRecords,
        lastPageToken,
        pageCount,
        fatalError: {
          code: "enumeration_failed",
          message: `Failed to list Firebase Auth users after ${pageCount} page(s) successfully processed. See script logs around this run for detail; the underlying exception is deliberately not persisted in this artifact.`,
        },
      };
    }
    pageCount += 1;
    scanned += page.users.length;

    const perUserResults = await mapWithConcurrency(page.users, options.concurrency, async (user) => {
      const result = options.dryRun
        ? await discoverUserWorkspaceStatus(user, options.excludedUids)
        : await provisionUserWorkspace(user, options.excludedUids);
      return { user, result };
    });

    for (const { user, result } of perUserResults) {
      const status = result.status;
      counts[status] = (counts[status] ?? 0) + 1;

      if (status === "excluded") {
        excluded += 1;
        excludedRecords.push({ uid: user.uid, status, reason: "reason" in result ? result.reason : undefined });
        continue;
      }
      eligible += 1;
      if (status === "conflict") {
        conflicts.push({ uid: user.uid, status, reason: "reason" in result ? result.reason : undefined });
      }
      if (status === "failed" || status === "lookup_failed" || status === "invalid_uid") {
        failures.push({ uid: user.uid, status });
      }
    }

    pageToken = page.pageToken;
    lastPageToken = pageToken ?? null;
    options.onPageComplete?.({ scanned, eligible, excluded, nextPageToken: pageToken });
  } while (pageToken);

  return { status: "complete", totals: { scanned, eligible, excluded }, counts, conflicts, failures, excludedRecords, lastPageToken, pageCount };
}

/**
 * The single sanctioned Phase-3-readiness predicate — see
 * docs/workspaces/architecture.md's "Coverage audit contract." An
 * `"incomplete"` result can never satisfy this, regardless of how clean
 * its partial counts look, because a partial enumeration cannot prove
 * `missing === 0` for users it never reached. This checks only what's
 * computable from a single provisioning run's own artifact (status,
 * conflicts, failures, and — for a dry run — `counts.missing`); it does
 * NOT check for "unexpected Workspace docs" (a Personal Workspace document
 * with no corresponding eligible Auth user), which requires a separate,
 * independent reverse audit query against the `workspaces` collection —
 * deliberately not built here, since that's a different, standalone
 * verification concern, not a property of this run's own result.
 */
export function isCompleteWithFullCoverage(result: RunProvisioningResult): boolean {
  return result.status === "complete" && (result.counts.missing ?? 0) === 0 && result.conflicts.length === 0 && result.failures.length === 0;
}
