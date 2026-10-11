/**
 * Order 4, Slice 2a — pure, fail-closed Source Standing resolution.
 *
 * Nothing here reads Firestore: callers supply a lookup that answers, for a
 * source id hash in ONE Workspace, "absent", "present (raw data)" or "not
 * loaded yet". A "not loaded" answer makes the resolver return `needs`, so the
 * Firestore layer can batch exact-document reads level by level — never a
 * query, never a cross-Workspace path.
 *
 * Fail-closed rules (never a first-match / last-write / array-order winner):
 *   - malformed or unknown-version records             → unresolved
 *   - SUPERSEDED whose successor chain has a missing or malformed record,
 *     a cycle (visited set includes the source), or more than
 *     MAX_SUCCESSOR_CHAIN_DEPTH edges                    → unresolved
 *   - absence is absence — never ACCEPTED, never "provisional".
 * The same chain walk validates SUPERSEDED writes, so read and write agree.
 */
import { MAX_SUCCESSOR_CHAIN_DEPTH, parseSourceStandingCurrent, type SourceStandingCurrentV1, type SourceStandingMalformedReason, type SourceStandingPresentationV1 } from "./standingTypes";

export type StandingLookupAnswer = { state: "absent" } | { state: "present"; data: unknown } | { state: "not_loaded" };
export type StandingLookup = (idHash: string) => StandingLookupAnswer;

export type ChainFailure = "successor_missing" | "successor_malformed" | "cycle" | "chain_too_deep";
export type ChainWalk = { ok: true; immediateSuccessor: SourceStandingCurrentV1 } | { ok: false; reason: ChainFailure } | { ok: "needs"; idHash: string };

/**
 * Walk from `sourceIdHash` → `firstSuccessorIdHash` → … until a non-SUPERSEDED
 * record. Edge 1 is source → first successor; more than MAX edges fails.
 */
export function walkSuccessorChain(workspaceId: string, sourceIdHash: string, firstSuccessorIdHash: string, lookup: StandingLookup): ChainWalk {
  const visited = new Set<string>([sourceIdHash]);
  let next = firstSuccessorIdHash;
  let immediate: SourceStandingCurrentV1 | null = null;
  for (let edges = 1; ; edges += 1) {
    if (visited.has(next)) return { ok: false, reason: "cycle" };
    if (edges > MAX_SUCCESSOR_CHAIN_DEPTH) return { ok: false, reason: "chain_too_deep" };
    const answer = lookup(next);
    if (answer.state === "not_loaded") return { ok: "needs", idHash: next };
    if (answer.state === "absent") return { ok: false, reason: "successor_missing" };
    const parsed = parseSourceStandingCurrent(answer.data, { expectedWorkspaceId: workspaceId, docId: next });
    if (!parsed.ok) return { ok: false, reason: "successor_malformed" };
    if (immediate === null) immediate = parsed.current;
    visited.add(next);
    if (parsed.current.status !== "SUPERSEDED") return { ok: true, immediateSuccessor: immediate };
    next = parsed.current.successorIdHash as string;
  }
}

export type SourceStandingResolution =
  | { kind: "absent" }
  | { kind: "resolved"; current: SourceStandingCurrentV1; successorCanonicalUrl?: string }
  | { kind: "unresolved"; reason: SourceStandingMalformedReason | ChainFailure }
  | { kind: "needs"; idHash: string };

export function resolveSourceStanding(workspaceId: string, idHash: string, lookup: StandingLookup): SourceStandingResolution {
  const answer = lookup(idHash);
  if (answer.state === "not_loaded") return { kind: "needs", idHash };
  if (answer.state === "absent") return { kind: "absent" };
  const parsed = parseSourceStandingCurrent(answer.data, { expectedWorkspaceId: workspaceId, docId: idHash });
  if (!parsed.ok) return { kind: "unresolved", reason: parsed.reason };
  return resolveFromParsedHead(workspaceId, parsed.current, lookup);
}

/**
 * Resolution starting from a head that has ALREADY been read and parsed. The
 * lookup is consulted only for successors — never for the head itself — so a
 * caller holding one head snapshot never re-reads it (Slice 2a.1, P3).
 */
export function resolveFromParsedHead(workspaceId: string, head: SourceStandingCurrentV1, lookup: StandingLookup): Exclude<SourceStandingResolution, { kind: "absent" }> {
  if (head.status !== "SUPERSEDED") return { kind: "resolved", current: head };
  const walk = walkSuccessorChain(workspaceId, head.identity.idHash, head.successorIdHash as string, lookup);
  if (walk.ok === "needs") return { kind: "needs", idHash: walk.idHash };
  if (!walk.ok) return { kind: "unresolved", reason: walk.reason };
  return { kind: "resolved", current: head, successorCanonicalUrl: walk.immediateSuccessor.identity.canonicalUrl };
}

/** Allow-listed client projection. Absent → null (no `standing` key at all). No actor, reason, revision or history. */
export function toStandingPresentation(resolution: Exclude<SourceStandingResolution, { kind: "needs" }>): SourceStandingPresentationV1 | null {
  if (resolution.kind === "absent") return null;
  if (resolution.kind === "unresolved") return { status: "UNRESOLVED" };
  const base = { status: resolution.current.status, asOf: resolution.current.updatedAt.toDate().toISOString() };
  return resolution.current.status === "SUPERSEDED" && resolution.successorCanonicalUrl !== undefined ? { ...base, successorUrl: resolution.successorCanonicalUrl } : base;
}
