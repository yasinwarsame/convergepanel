/**
 * Evidence Workspace, Phase 11A.1 (corrected 11A.1C1/11A.1C2/11A.1C3) — the
 * durable origin-linkage foundation for "Deep Research finding -> Verify
 * This Claim -> Claim Verification". This module is read-only derivation
 * plus one pure issuance helper: no route wiring, no UI, no persistence
 * write.
 *
 * ============== 11A.2a — EVIDENCE SOURCE-REFERENCE EXTRACTION ==============
 * The resolved result also carries `evidenceSources`, derived from the
 * SAME exact finding object the selector fingerprint already
 * cryptographically re-verified — never a second Firestore read, never a
 * re-lookup by raw id, never concatenated across sections or findings.
 * `normalizeEvidenceSourceReferences()` (`./evidenceSourceExtraction.ts`)
 * is a pure, defensive normalizer over that finding's raw `sources` field
 * (untrusted Firestore data — PR #112/Phase 10D.1's
 * `AggregatedResearchFinding.sources: string[]`): malformed/missing
 * sources degrade to `[]`, never to a denial — source-reference
 * availability is subordinate metadata, not part of claim identity. These
 * are SOURCE REFERENCES, not evidence content: surviving entries prove a
 * model cited the URL, never what it said or whether it still says it.
 *
 * ============== 11A.1C3 — PERSONAL WORKSPACE SCOPE CLASSIFICATION ==============
 * A source audit (11A.1C3A) established that this repository has TWO
 * equally-valid, permanent Personal-run representations — `workspaceId`
 * field absent ("legacy"), and `workspaceId === getPersonalWorkspaceId(run.userId)`
 * ("personal", the Phase 3 Personal Workspace write path,
 * `lib/workspaces/personalRunWorkspaceBinding.ts`) — neither of which is
 * "no workspace" or "a Team workspace." An earlier version of this
 * resolver treated ANY non-null `workspaceId` as proof of a Team-scoped
 * run, which was directly reproduced to incorrectly deny a Personal
 * Workspace-bound run's own owner with `workspace_mismatch`. Fixed by
 * reusing the existing canonical structural classifier,
 * `classifyRunWorkspaceBindingShape()` (`lib/workspaces/classifyRunWorkspaceBindingShape.ts`),
 * rather than reimplementing `"personal-" + uid` comparison a third time
 * — see `resolveClaimVerificationOrigin()`'s own scope-resolution block.
 *
 * FROZEN DATA CONTRACT — deliberately minimal. `workspaceId`, `projectId`,
 * a creator uid, a creation timestamp, and a separate claim-text snapshot
 * are NOT stored here: every one of them already has a canonical home
 * elsewhere (the verification document's own top-level `workspaceId`/
 * `projectId`/`userId`/`timestamp` fields, and — once the creation route is
 * wired in a later phase — the verification's own existing `claim: string`
 * field, which becomes the immutable historical snapshot the moment it is
 * written). Duplicating any of them inside `origin` would create a second
 * copy that could drift from the authoritative one; this type intentionally
 * cannot express that duplication.
 *
 * ============== 11A.1C2 — WHY `claimId` IS A SERVER-ISSUED SELECTOR ==============
 * Two independent reviews found real defects in earlier versions of this
 * module, both closed here:
 *
 * (1) MALFORMED SHAPE: `parsePersistedAdaptiveOutput()`'s structural check
 *     never validates `lowConfidenceFindings` (a documented, deliberate,
 *     shallow check shared across all 9 adaptive schemas — broadening it
 *     for this one stricter consumer was rejected as too large a change).
 *     A persisted `deep_research` output with `findings` present but
 *     `lowConfidenceFindings` absent/non-array previously crashed this
 *     resolver with an uncaught TypeError while spreading it. Both arrays
 *     are now independently re-validated here before any indexing happens.
 *
 * (2) IDENTITY: `AggregatedResearchFinding.id` (raw finding id) is an
 *     LLM-generated slug — or a raw summary-prefix fallback — with ZERO
 *     uniqueness guarantee anywhere in `deepResearchAlignment.ts`. Two
 *     genuinely different findings in the same run can share an `id`. The
 *     original design (`v1:<section>:<index>:<rawId>`, treating rawId as a
 *     "mutation guard") was independently proven unsound: if the array is
 *     ever reordered, or the content at a slot changes while the same
 *     duplicate `id` persists elsewhere, `section+index+rawId` can still
 *     validate against the WRONG finding — a silent wrong-claim linkage,
 *     confirmed by direct reproduction. A position-only request contract
 *     (client sends `{runId, section, index}`, server fingerprints
 *     whatever currently lives there) was ALSO proven unsound: it can't
 *     tell a genuinely stale click (user saw Claim A; canonical data
 *     changed to Claim B before the click resolved) from a normal one,
 *     because the server never has a representation of what the user
 *     actually selected.
 *
 * The fix: `claimId` is an opaque, SERVER-ISSUED durable selector,
 * `v1:<section>:<index>:<fingerprint>`, where `fingerprint` is a
 * deterministic digest over `runId + section + index + rawId + summary`
 * together — never just `rawId` alone, and never computed from an
 * untrusted bare position at resolution time. It is issued once (by
 * `buildDeepResearchClaimId()`, a pure function with no Firestore access,
 * to be called by a future phase's read-model at the moment a finding is
 * first presented to a user) and later independently re-verified against
 * whatever is CURRENTLY canonical (by `resolveClaimVerificationOrigin()`).
 * Binding all five fields closes, all confirmed by direct construction:
 *   - cross-run replay (runId is bound — a selector issued for run A can
 *     never validate against run B, even with byte-identical content);
 *   - coordinate tampering (section/index are bound — editing either
 *     without recomputing the digest invalidates it);
 *   - duplicate raw ids (index is bound — two findings sharing an id at
 *     different positions get distinct selectors; identical content at
 *     different positions deliberately still gets distinct selectors too,
 *     since occurrence, not just content, is part of the identity);
 *   - stale clicks / same-slot content mutation (summary and rawId are
 *     both bound — any change to either at that exact position invalidates
 *     a previously-issued selector for it).
 * Any mismatch of any kind denies to the existing `claim_not_found` reason
 * — no sixth denial reason, no fuzzy recovery, no scanning the run for a
 * different slot that might match instead.
 */

import "server-only";
import { createHash, timingSafeEqual } from "crypto";
import { adminDb } from "@/lib/firebase/admin";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { classifyRunWorkspaceBindingShape } from "@/lib/workspaces/classifyRunWorkspaceBindingShape";
import { normalizeEvidenceSourceReferences, type EvidenceSourceReference } from "./evidenceSourceExtraction";

export interface ClaimVerificationOrigin {
  type: "deep_research_claim";
  runId: string;
  claimId: string;
}

export type ClaimVerificationOriginDenialReason =
  | "run_not_found"
  | "not_deep_research"
  | "claim_not_found"
  | "not_owner"
  | "workspace_mismatch";

/**
 * `projectId` is returned alongside `origin` (not inside it, per the frozen
 * contract) so a later creation phase can derive the verification's own
 * top-level `projectId` from the source run without a second Firestore
 * read — see PROJECT CONTRACT in the 11A.0C1 closure.
 *
 * Deliberately has NO variant for a genuine infrastructure failure. This
 * union expresses exactly two things: "the domain request resolved to a
 * usable claim" or "the domain request is invalid for one of five specific
 * reasons." A Firestore outage is neither — it means the resolver could not
 * determine an answer at all, which is not a fact about the caller's
 * request. Collapsing it into either shape would let a caller mistake an
 * operational outage for an authorization/domain result. See
 * resolveClaimVerificationOrigin()'s own doc comment for how this
 * propagates instead.
 */
export type ClaimVerificationOriginResolution =
  | { status: "resolved"; origin: ClaimVerificationOrigin; claimText: string; projectId: string | null; evidenceSources: EvidenceSourceReference[] }
  | { status: "denied"; reason: ClaimVerificationOriginDenialReason };

export type DeepResearchClaimSection = "findings" | "lowConfidenceFindings";

/** A minimally-shaped finding — enough to compute/verify a fingerprint, without depending on the full `AggregatedResearchFinding` interface (which carries fields irrelevant to identity). */
interface FingerprintableFinding {
  id: string;
  summary: string;
}

function isFingerprintableFinding(value: unknown): value is FingerprintableFinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).summary === "string"
  );
}

/** Fixed domain-separation tag — prevents this exact digest contract from ever being confused with an unrelated future fingerprint elsewhere in the codebase. Bumping the locator version (see CLAIM_ID_PATTERN) would also mean bumping this tag. */
const DEEP_RESEARCH_CLAIM_ID_DOMAIN_TAG = "deep_research_claim:v1";

/**
 * Deterministic, pure. Every one of the five inputs is bound into the
 * digest via a structural `JSON.stringify` of an array (never raw string
 * concatenation, which would let e.g. `"AB"+"C"` collide with `"A"+"BC"`).
 * Output is a 32-byte SHA-256 digest, base64url-encoded (unpadded) — a
 * fixed 43-character string, safe for Firestore, JSON, and URL contexts
 * as-is.
 */
function computeDeepResearchClaimFingerprint(args: {
  runId: string;
  section: DeepResearchClaimSection;
  index: number;
  rawId: string;
  summary: string;
}): string {
  const canonical = JSON.stringify([DEEP_RESEARCH_CLAIM_ID_DOMAIN_TAG, args.runId, args.section, args.index, args.rawId, args.summary]);
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * Constant-time comparison of two same-length fingerprint strings. Both
 * sides of every real comparison in this module are always exactly
 * 43-character base64url strings (one freshly computed here, one already
 * regex-validated by `parseDeepResearchClaimId`), so the length check
 * below is defensive only — it exists so this function can never itself
 * throw, never so it needs to handle a real length mismatch.
 */
function fingerprintsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "base64url");
  const bufB = Buffer.from(b, "base64url");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Hard bound checked BEFORE parsing — the fingerprint segment is fixed-length, but the index segment is attacker-controlled text, so an unbounded string must never reach the regex engine or `Number()`. Real selectors are ~60 characters; 128 is generous headroom without being unbounded. */
const MAX_CLAIM_ID_LENGTH = 128;

/**
 * `v1:<section>:<index>:<fingerprint>`. The index alternation
 * `(0|[1-9]\d*)` structurally rejects leading zeros ("01", "0002"),
 * a leading minus sign, decimal points, scientific notation, and
 * whitespace — all fail the anchored match outright, never reaching
 * `Number()`. The fingerprint segment is exactly 43 base64url characters
 * (no more, no less) — anything else fails to match.
 */
const CLAIM_ID_PATTERN = /^v1:(findings|lowConfidenceFindings):(0|[1-9]\d*):([A-Za-z0-9_-]{43})$/;

interface ParsedDeepResearchClaimId {
  section: DeepResearchClaimSection;
  index: number;
  fingerprint: string;
}

/**
 * Pure. Returns `null` for anything malformed — never throws, so a caller
 * never needs its own try/catch around a hostile `claimId` string.
 * `Number.isSafeInteger` guards against a digit string long enough to
 * overflow `Number.MAX_SAFE_INTEGER` (the regex alone only proves "digits,
 * no leading zero," not "fits in a safe integer").
 */
export function parseDeepResearchClaimId(claimId: string): ParsedDeepResearchClaimId | null {
  if (typeof claimId !== "string" || claimId.length === 0 || claimId.length > MAX_CLAIM_ID_LENGTH) return null;
  const match = CLAIM_ID_PATTERN.exec(claimId);
  if (!match) return null;
  const [, section, indexText, fingerprint] = match;
  const index = Number(indexText);
  if (!Number.isSafeInteger(index)) return null;
  return { section: section as DeepResearchClaimSection, index, fingerprint };
}

/**
 * Phase 11A.5B — pure, zero-I/O re-verification of a persisted `claimId`
 * against ALREADY-LOADED, CURRENT `findings`/`lowConfidenceFindings`
 * arrays. This is the exact same fingerprint check
 * `resolveClaimVerificationOrigin()` performs internally, factored out so
 * a READ-time caller (e.g. a stored-verification's durable source-link
 * resolver) can reuse it without duplicating the digest algorithm and
 * without misusing `resolveClaimVerificationOrigin()` itself as a
 * general read-authorization grant — that function's own contract is
 * scoped to the creation flow (see its TEAM MEMBERSHIP BOUNDARY comment
 * above). This function performs no Firestore access and grants no
 * authorization of any kind: the caller remains fully responsible for
 * having already authorized itself to read the run this data came from.
 * Returns `false` for anything malformed — never throws.
 */
export function verifyDeepResearchClaimFingerprint(args: {
  runId: string;
  claimId: string;
  findings: unknown;
  lowConfidenceFindings: unknown;
}): boolean {
  const parsed = parseDeepResearchClaimId(args.claimId);
  if (!parsed) return false;
  const { section, index, fingerprint } = parsed;

  const candidates = section === "findings" ? args.findings : args.lowConfidenceFindings;
  if (!Array.isArray(candidates)) return false;
  const target = candidates[index];
  if (!isFingerprintableFinding(target)) return false;

  const expectedFingerprint = computeDeepResearchClaimFingerprint({
    runId: args.runId,
    section,
    index,
    rawId: target.id,
    summary: target.summary,
  });
  return fingerprintsMatch(fingerprint, expectedFingerprint);
}

/**
 * Pure issuance helper — no Firestore access, no I/O. Computes the durable
 * selector for one specific finding occurrence. Intended to be called by a
 * FUTURE read-model (Phase 11A.4/11A.5), at the moment a finding is first
 * presented to a user, from data that read-model already trusts (the same
 * canonical run it's about to render). NOT called by this phase's own
 * resolver, and not called by anything else yet — no route/UI wiring
 * exists in 11A.1.
 *
 * Fails closed (`null`) rather than throwing on any malformed input —
 * `runId` non-empty, `section` one of the two literals, `index` a safe
 * non-negative integer, and `finding` shaped like `{id: string, summary:
 * string}` are all required. Never substitutes `title` for a missing
 * `summary`, never fabricates an empty string — a caller that can't
 * produce a valid selector for a given finding gets `null` and must not
 * offer a "Verify this claim" affordance for it at all.
 */
export function buildDeepResearchClaimId(args: {
  runId: string;
  section: DeepResearchClaimSection;
  index: number;
  finding: unknown;
}): string | null {
  if (typeof args.runId !== "string" || args.runId.length === 0) return null;
  if (args.section !== "findings" && args.section !== "lowConfidenceFindings") return null;
  if (!Number.isSafeInteger(args.index) || args.index < 0) return null;
  if (!isFingerprintableFinding(args.finding)) return null;

  const fingerprint = computeDeepResearchClaimFingerprint({
    runId: args.runId,
    section: args.section,
    index: args.index,
    rawId: args.finding.id,
    summary: args.finding.summary,
  });
  return `v1:${args.section}:${args.index}:${fingerprint}`;
}

/**
 * Read-only. Performs exactly one Firestore document read (`runs/{runId}`)
 * and zero writes. Never accepts claim text, workspace/project/creator
 * metadata, or a raw section/index from the caller — `claimId` is the only
 * claim-identifying input, and it is expected to be a selector this same
 * module's `buildDeepResearchClaimId()` issued at some earlier point (by a
 * future phase's read-model); this function's entire job is to
 * independently re-verify that selector against whatever is CURRENTLY
 * canonical, never to manufacture a new identity from a bare position.
 *
 * TEAM MEMBERSHIP BOUNDARY (deliberate, see 11A.0C1 Part H): for a Team
 * expectation, this function checks only whether the canonical run's own
 * structural binding (via `classifyRunWorkspaceBindingShape()`) equals
 * `expectedWorkspaceId` — it does NOT check whether `callerUid` currently
 * has membership/capability in that workspace. That is the responsibility
 * of the existing Team route's Gate-1/Gate-2 authorization (already
 * required, and already re-derived independently, for every Team
 * verification creation) when a later phase wires this resolver into it.
 * Importing `resolveWorkspaceAccess`/`resolveTeamRunWorkspaceAccess`/
 * `roleHasCapability` here would duplicate that check against a boundary
 * this module has no business owning.
 *
 * FAILURE PRECEDENCE (frozen, tested): run_not_found -> workspace_mismatch
 * -> not_owner (Personal only) -> not_deep_research -> claim_not_found.
 * Scope is always resolved before the adaptive output is ever inspected,
 * and the adaptive output's own array-level shape is always resolved
 * before any selector parsing/lookup, so a scope-mismatched or
 * wrong-schema caller never learns anything about the run's claim/selector
 * contents.
 *
 * INFRASTRUCTURE FAILURE (deliberate, see ClaimVerificationOriginResolution's
 * own doc comment): a genuine Firestore outage is not a domain result and is
 * never caught/converted into one — this function lets it propagate as a
 * rejected promise, exactly like `saveClaimVerification()`
 * (lib/firestore/verifications.ts) throws `Error("Firestore is not
 * available")` for the identical `!adminDb` condition rather than returning
 * a structured failure. A caller of this resolver is expected to treat a
 * thrown/rejected error as "we could not determine the answer," distinct
 * from every `denied` reason above, which all mean "we determined the
 * answer, and it is no."
 */
export async function resolveClaimVerificationOrigin(args: {
  runId: string;
  claimId: string;
  callerUid: string;
  expectedWorkspaceId: string | null;
}): Promise<ClaimVerificationOriginResolution> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }

  const snap = await adminDb.collection("runs").doc(args.runId).get();
  if (!snap.exists) {
    return { status: "denied", reason: "run_not_found" };
  }
  const raw = snap.data();

  if (!raw) {
    return { status: "denied", reason: "run_not_found" };
  }

  // Personal Workspace Scope Correction, 11A.1C3 — the repository has TWO
  // equally-valid Personal representations (see classifyRunWorkspaceBindingShape's
  // own doc comment): `workspaceId` field absent entirely ("legacy"), or
  // `workspaceId === getPersonalWorkspaceId(run.userId)` ("personal", the
  // Phase 3 write path). Neither is "no workspace" nor "a Team workspace" —
  // both must be treated as Personal-origin-eligible here. Reuses the
  // existing canonical structural classifier verbatim rather than
  // reimplementing `"personal-" + uid` comparison a third time in this
  // module. `hasWorkspaceIdField` is computed explicitly so an explicit
  // `workspaceId: null` is never silently coerced into "field absent" —
  // the classifier treats a present-but-non-string value as `invalid`,
  // and that must fail closed, not fall back to legacy Personal.
  const hasWorkspaceIdField = Object.prototype.hasOwnProperty.call(raw, "workspaceId");
  const shape = classifyRunWorkspaceBindingShape({
    hasWorkspaceIdField,
    workspaceIdValue: raw.workspaceId,
    userId: raw.userId,
  });

  if (args.expectedWorkspaceId === null) {
    // Caller expects a Personal-origin claim. Both `legacy` and `personal`
    // are valid Personal shapes; `non_personal_bound` (a real Team
    // workspace, or any other explicit binding) and `invalid` (malformed
    // or owner-inconsistent) can never satisfy a Personal expectation,
    // regardless of who owns it — no fallback, no fuzzy recovery.
    if (shape.kind !== "legacy" && shape.kind !== "personal") {
      return { status: "denied", reason: "workspace_mismatch" };
    }
    const owner = typeof raw.userId === "string" ? raw.userId : "";
    if (owner !== args.callerUid) {
      return { status: "denied", reason: "not_owner" };
    }
  } else {
    // Caller expects a Team-origin claim for a specific workspace. A
    // Personal shape (`legacy` or `personal`) never satisfies a Team
    // expectation, and neither does `invalid` — only `non_personal_bound`
    // can, and only when it exactly equals the expected workspace.
    if (shape.kind !== "non_personal_bound" || shape.workspaceId !== args.expectedWorkspaceId) {
      return { status: "denied", reason: "workspace_mismatch" };
    }
    // No ownership/membership check here by design — see TEAM MEMBERSHIP
    // BOUNDARY above.
  }

  const parsed = parsePersistedAdaptiveOutput(raw.adaptiveOutput);
  if (!parsed.ok || parsed.output.schemaId !== "deep_research") {
    return { status: "denied", reason: "not_deep_research" };
  }

  // parsePersistedAdaptiveOutput()'s shared structural check does not
  // validate lowConfidenceFindings at all (see file header) — both arrays
  // are independently re-checked here, before either is ever indexed.
  const result = parsed.output.result;
  if (!Array.isArray(result.findings) || !Array.isArray(result.lowConfidenceFindings)) {
    return { status: "denied", reason: "not_deep_research" };
  }

  const parsedClaimId = parseDeepResearchClaimId(args.claimId);
  if (!parsedClaimId) {
    return { status: "denied", reason: "claim_not_found" };
  }
  const { section, index, fingerprint } = parsedClaimId;

  // Exactly one array, chosen by the selector's own section — never a
  // concatenation of both, which would make an index ambiguous.
  const candidates = section === "findings" ? result.findings : result.lowConfidenceFindings;
  const target = candidates[index];
  if (!isFingerprintableFinding(target)) {
    // Covers both "index out of range" (target is undefined) and "the
    // element at this position is malformed" — a single bad element must
    // not invalidate every other valid finding in the same run, so this
    // is claim_not_found, never the broader not_deep_research.
    return { status: "denied", reason: "claim_not_found" };
  }

  const expectedFingerprint = computeDeepResearchClaimFingerprint({
    runId: args.runId,
    section,
    index,
    rawId: target.id,
    summary: target.summary,
  });
  if (!fingerprintsMatch(fingerprint, expectedFingerprint)) {
    // Any drift between the issued selector and current canonical data —
    // changed summary, changed rawId, a reordered/replaced slot, a forged
    // digest, a tampered section/index, or a selector replayed against a
    // different run — denies here. No fuzzy recovery: never scan the run
    // for some other slot that might match instead.
    return { status: "denied", reason: "claim_not_found" };
  }

  const projectId = typeof raw.projectId === "string" ? raw.projectId : null;

  // Derived from the SAME `target` the fingerprint above just
  // cryptographically re-verified — no second Firestore read, no
  // re-lookup by raw id, no cross-section/cross-finding concatenation.
  const evidenceSources = normalizeEvidenceSourceReferences(target.sources);

  return {
    status: "resolved",
    origin: { type: "deep_research_claim", runId: args.runId, claimId: args.claimId },
    claimText: target.summary,
    projectId,
    evidenceSources,
  };
}
