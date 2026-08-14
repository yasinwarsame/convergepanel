/**
 * Phase 4B — request-scoped batching for validating many rows' Workspace
 * associations in list/bulk routes, without a validation skip and without
 * one sequential round trip per row.
 *
 * A Personal Workspace's id is deterministic per owner (`personal-{uid}`),
 * so two rows can only ever legitimately share a lookup if they share BOTH
 * the same owner AND the same claimed `workspaceId` — the cache key is
 * that pair, never either field alone (two different owners that happen to
 * carry an identical CORRUPTED `workspaceId` string must never share a
 * cached result; validating them independently is exactly what catches
 * that corruption). All distinct pairs resolve concurrently, so wall-clock
 * cost is roughly one round trip regardless of row count, and the actual
 * number of underlying Firestore reads is bounded by the number of
 * DISTINCT (owner, workspaceId) pairs on the page, not the number of rows.
 *
 * For an owner-scoped list (every row's owner is the same authenticated
 * caller), this collapses to exactly one Firestore read for the entire
 * page — every row shares the identical deterministic Workspace. For a
 * reviewer-scoped list (rows from many different owners), it collapses to
 * one read per distinct owner represented on the page, not one per row.
 *
 * Deliberately built on the unmodified `validateRunWorkspaceAssociation()`
 * — this is a caching wrapper around it, not a reimplementation. No change
 * to Phase 1's `getWorkspace()`/`resolveWorkspaceContextForResource()` was
 * needed to achieve this. Takes the same `(userId, runData)` shape as the
 * underlying primitive — never a reconstructed `{workspaceId: ...}` object
 * literal — for the exact reason documented on that primitive: reassembling
 * that shape from a source object silently defeats true-absence detection.
 */

import "server-only";
import { validateRunWorkspaceAssociation, type RunWorkspaceIntegrityResult } from "./runWorkspaceIntegrity";

export interface RunWorkspaceIntegrityBatchValidator {
  (userId: string, runData: Record<string, unknown>): Promise<RunWorkspaceIntegrityResult>;
  /** Diagnostic only — the number of distinct (owner, workspaceId) pairs actually resolved so far, never row count. */
  readonly distinctLookupCount: number;
}

function cacheKeyFor(userId: string, runData: Record<string, unknown>): string {
  const hasField = Object.prototype.hasOwnProperty.call(runData, "workspaceId");
  if (!hasField) return `${userId}::__absent__`;
  const raw = runData.workspaceId;
  const shape = typeof raw === "string" ? raw : `__nonstring__:${JSON.stringify(raw)}`;
  return `${userId}::${shape}`;
}

/** Create one batch validator per request/list-response — never share across requests, since the cache has no eviction and no isolation between different callers' data. */
export function createRunWorkspaceIntegrityBatch(): RunWorkspaceIntegrityBatchValidator {
  const cache = new Map<string, Promise<RunWorkspaceIntegrityResult>>();

  const validate = (async (userId: string, runData: Record<string, unknown>) => {
    const key = cacheKeyFor(userId, runData);
    let pending = cache.get(key);
    if (!pending) {
      pending = validateRunWorkspaceAssociation(userId, runData);
      cache.set(key, pending);
    }
    return pending;
  }) as RunWorkspaceIntegrityBatchValidator;

  Object.defineProperty(validate, "distinctLookupCount", { get: () => cache.size });

  return validate;
}
