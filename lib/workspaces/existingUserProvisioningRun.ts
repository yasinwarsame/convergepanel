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

export interface RunProvisioningResult {
  totals: { scanned: number; eligible: number; excluded: number };
  counts: Record<string, number>;
  conflicts: PerUserRecord[];
  failures: PerUserRecord[];
  excludedRecords: PerUserRecord[];
  lastPageToken: string | null;
  pageCount: number;
}

/**
 * The single orchestration loop shared by dry-run and execute. Never
 * writes when `dryRun` is true — dispatches to `discoverUserWorkspaceStatus`
 * (read-only) instead of `provisionUserWorkspace` (the only function that
 * can write) based purely on this flag, checked once per user via a plain
 * ternary — there is no other conditional write path anywhere in this loop.
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
    const page = await options.listUsersPage(pageToken);
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

  return { totals: { scanned, eligible, excluded }, counts, conflicts, failures, excludedRecords, lastPageToken, pageCount };
}
