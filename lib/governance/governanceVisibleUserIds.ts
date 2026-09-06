/**
 * Which run owners' documents a user may see in governance queue / audit / review.
 */

import "server-only";
import { NextResponse } from "next/server";

import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { resolveVerifiedAdminScopes } from "@/lib/admin/verifiedAdminIdentity";
import { adminDb } from "@/lib/firebase/admin";
import { parseGovernanceReviewerFor } from "@/lib/governance/reviewerFields";

export type GovernanceQueueScope = "admin_global" | "assigners" | "no_assigners";

/** User IDs who set `governanceReviewerUid` to this reviewer. */
export async function getAssignerUids(reviewerUid: string): Promise<string[]> {
  if (!adminDb) return [];
  const snap = await adminDb.collection("users").where("governanceReviewerUid", "==", reviewerUid).get();
  return snap.docs.map((d) => d.id);
}

export type GovernanceVisibility =
  | { ok: true; visibleUserIds: string[] | null; isSupportAdmin: boolean; queueScope: GovernanceQueueScope }
  | { ok: false; kind: "no_db" | "plan_required" };

/**
 * Phase FIRESTORE-AUTHZ-P0.2-C1 — TRUSTED IDENTITY EVIDENCE, ESTABLISHED HERE.
 *
 * This module produces `visibleUserIds: null` / `admin_global`, which removes
 * the run-owner filter entirely: every user's runs, decisions and review
 * records. It is the highest-impact authority in the product.
 *
 * The P0.2 review found that the exported resolvers took `(uid, email,
 * emailVerified)` as loose primitives. Every caller passed honest values from
 * the live Auth resolver, so there was no live exploit — but the boundary was
 * enforced by caller discipline, and a direct call such as
 *
 *     resolveGovernanceVisibleUserIds("never-authenticated", "admin@…", true)
 *
 * returned global scope with ZERO Firebase Auth reads. A future caller reaching
 * for a session cookie's five-day-stale `email_verified` claim would have
 * reopened the exact P0 this phase closed, and it would have type-checked and
 * read correctly in review.
 *
 * The exported entry points now take ONLY the authenticated uid and establish
 * their own evidence. There is no exported governance-global function that can
 * be handed manufactured verification, and the private helper below cannot be
 * reached from outside this module.
 *
 * Resolves Firestore `userId` values the caller may load in governance queue / audit / review.
 * - Support admins: `visibleUserIds: null` (global queue).
 * - Full plan + assigners: assigner UIDs only (from `governanceReviewerFor` + reverse lookup), never the viewer's uid.
 * - Full plan, no assigners: empty array (queue empty; policies/audit still allowed).
 * - Free / lite: plan_required.
 */
export async function resolveGovernanceVisibleUserIds(uid: string): Promise<GovernanceVisibility> {
  if (!adminDb) {
    return { ok: false, kind: "no_db" };
  }
  const identity = await resolveTrustedGovernanceIdentity(uid);
  return resolveVisibilityForTrustedIdentity(uid, identity);
}

/**
 * The caller's own live Auth evidence. A failed lookup is NOT an error here: it
 * yields unverified, empty-email evidence, which denies `admin_global` (fail
 * closed on the authority) while leaving the reviewer-scoped and plan-gated
 * paths below to resolve normally (no availability regression for ordinary
 * reviewers, who never needed an email at all).
 */
async function resolveTrustedGovernanceIdentity(
  uid: string
): Promise<{ email: string; emailVerified: boolean; governanceAdmin: boolean }> {
  const scopes = await resolveVerifiedAdminScopes(uid);
  if (scopes.lookupStatus !== "resolved") {
    return { email: "", emailVerified: false, governanceAdmin: false };
  }
  // The GOVERNANCE decision is taken by the uid-only authority resolver, which
  // reads ADMIN_EMAILS and GOVERNANCE_ADMIN_EMAILS independently. This module
  // never sees a blended answer and cannot re-blend one.
  return {
    email: scopes.email,
    emailVerified: scopes.emailVerified,
    governanceAdmin: scopes.governanceAdmin,
  };
}

/**
 * PRIVATE — never exported, never re-exported. It may take the resolved
 * identity because it is unreachable from outside this module; the exported
 * wrappers above are the only way in, and they always establish the evidence
 * themselves.
 */
async function resolveVisibilityForTrustedIdentity(
  uid: string,
  identity: { email: string; emailVerified: boolean; governanceAdmin: boolean }
): Promise<GovernanceVisibility> {
  if (!adminDb) {
    return { ok: false, kind: "no_db" };
  }

  const { email, emailVerified } = identity;

  // This branch returns `visibleUserIds: null` — no owner filter at all. The
  // evidence reaching it was read from the live Firebase Auth record by this
  // module, not supplied by a caller.
  //
  // Phase FIRST-ADMIN-C1: gated on `GOVERNANCE_ADMIN_EMAILS` ONLY. An
  // application administrator (`ADMIN_EMAILS`) no longer receives global
  // visibility over every user's runs simply by being an admin.
  if (identity.governanceAdmin) {
    console.log(`[governance/queue] Admin: global access (visibleUserIds = null)`);
    return { ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" };
  }

  const entitlements = await getEffectiveEntitlements(uid);
  const userPlan = entitlements.planId;

  const userDoc = await adminDb.collection("users").doc(uid).get();
  const userData = userDoc.data() as Record<string, unknown> | undefined;
  const reviewerFor = parseGovernanceReviewerFor(userData);
  const assignersByReviewerField = await getAssignerUids(uid);

  console.log(
    `[governance/queue] User: ${uid}, isAdmin: false, plan: ${userPlan}, reviewerFor: ${reviewerFor.length} users, assignersByReviewerUidField: ${assignersByReviewerField.length}`
  );

  if (userPlan !== "full") {
    console.log(`[governance/queue] Scoping decision: plan_required (not full)`);
    return { ok: false, kind: "plan_required" };
  }

  const self = uid.trim();
  const allAssigners = [...new Set([...reviewerFor, ...assignersByReviewerField])].filter(
    (id) => id.trim() !== self
  );

  if (allAssigners.length === 0) {
    console.log(`[governance/queue] Scoping decision: full plan, no assigners (empty queue scope)`);
    return { ok: true, visibleUserIds: [], isSupportAdmin: false, queueScope: "no_assigners" };
  }

  let visibleUserIds = allAssigners;
  if (visibleUserIds.length > 30) {
    visibleUserIds = visibleUserIds.slice(0, 30);
    console.warn(`[governance/queue] Truncated visibleUserIds to 30 for user ${uid}`);
  }
  visibleUserIds = visibleUserIds.filter((id) => id.trim() !== self);

  console.log(`[governance/queue] Scoping decision: visibleUserIds = [${visibleUserIds.join(", ")}]`);

  return { ok: true, visibleUserIds, isSupportAdmin: false, queueScope: "assigners" };
}

/** In-memory cache so queue / audit list loads skip repeat assigner lookups (TTL 2 minutes). */
const GOVERNANCE_VISIBILITY_CACHE_TTL_MS = 120_000;
const governanceVisibilityCache = new Map<string, { entry: GovernanceVisibility; expiresAt: number }>();

/**
 * Same as {@link resolveGovernanceVisibleUserIds}, but caches the resolved
 * visibility for 2 minutes. Use for read-heavy list endpoints; prefer the
 * uncached resolver when correctness must be immediate (e.g. review).
 *
 * Phase FIRESTORE-AUTHZ-P0.2-C1 — TRUSTED CACHE IDENTITY.
 *
 * This entry point takes ONLY the authenticated uid, exactly like the uncached
 * one. The live Auth lookup happens on EVERY call and BEFORE the cache is
 * consulted, so the cache key is built from evidence this module read rather
 * than from anything a caller supplied. The lookup is deliberately not cached:
 * it is the security boundary, and the expensive part being saved here is the
 * Firestore work below it (entitlements, the user document, and the reverse
 * assigner query), which is what the cache actually exists for.
 *
 * The key still carries uid + canonical email + verification state, so a
 * verified grant cannot outlive the proof it rested on: revoking verification
 * or changing the address produces a different key and forces a recompute.
 * Caching by uid alone would be wrong for exactly that reason.
 */
export async function resolveGovernanceVisibleUserIdsCached(uid: string): Promise<GovernanceVisibility> {
  if (!adminDb) {
    return { ok: false, kind: "no_db" };
  }

  const identity = await resolveTrustedGovernanceIdentity(uid);
  const key = `${uid}::${identity.email.trim().toLowerCase()}::${identity.emailVerified === true ? "verified" : "unverified"}`;
  const now = Date.now();
  const hit = governanceVisibilityCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.entry;
  }
  const entry = await resolveVisibilityForTrustedIdentity(uid, identity);
  governanceVisibilityCache.set(key, { entry, expiresAt: now + GOVERNANCE_VISIBILITY_CACHE_TTL_MS });
  return entry;
}

export function runOwnerVisibleInGovernance(visibleUserIds: string[] | null, runOwnerUid: string): boolean {
  if (visibleUserIds === null) return true;
  return visibleUserIds.includes(runOwnerUid);
}

export function governanceQueuePlanForbiddenResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "forbidden",
        message: "Governance queue requires a 5-Model plan.",
      },
    },
    { status: 403 }
  );
}

/** Legacy: full-plan users without assigners no longer receive 403 from the queue; kept for any older clients. */
export function governanceQueueNotReviewerResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "not_reviewer",
        message:
          "No runs to review. You need to be assigned as a reviewer by another user on the 5-Model plan.",
      },
    },
    { status: 403 }
  );
}
