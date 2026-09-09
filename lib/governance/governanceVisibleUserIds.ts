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
): Promise<{ email: string; emailVerified: boolean; governanceAdmin: boolean; disabled: boolean }> {
  const scopes = await resolveVerifiedAdminScopes(uid);
  if (scopes.lookupStatus !== "resolved") {
    // A lookup we could not perform is not evidence the account is usable.
    return { email: "", emailVerified: false, governanceAdmin: false, disabled: true };
  }
  // The GOVERNANCE decision is taken by the uid-only authority resolver, which
  // reads ADMIN_EMAILS and GOVERNANCE_ADMIN_EMAILS independently. This module
  // never sees a blended answer and cannot re-blend one.
  return {
    email: scopes.email,
    emailVerified: scopes.emailVerified,
    governanceAdmin: scopes.governanceAdmin,
    disabled: scopes.disabled,
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
  // visibility over every user's runs THROUGH THE GOVERNANCE QUEUE / AUDIT /
  // REVIEW PATH simply by being an admin.
  //
  // Phase FIRST-ADMIN-C3/C5 — SCOPE OF THAT CLAIM, precisely. It is true of
  // this path only. `/api/admin/runs` (GET) and `/api/admin/runs/[runId]` (GET)
  // are ADMIN_PORTAL and still return every user's runs. Do not read this
  // comment as "ADMIN_EMAILS cannot see other users' runs".
  //
  // The MUTATIONS on that route no longer sit at this tier: Phase C4 resolved
  // FIRST_ADMIN_ENROLLMENT_BLOCKER_DECISION (2026-09-07) and moved
  // `/api/admin/runs/[runId]` PATCH and DELETE — plus
  // `/api/admin/sync-subscription` and `/api/admin/test-webhook` — to
  // SYSTEM_ADMIN. See `docs/operations/admin-authority-tiers.md`.
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

  // Phase FIRST-ADMIN-C7 — C6 replaced the owner-UID LISTS here with counts but
  // left the caller's own raw UID on this line, so every governance queue load
  // still wrote a stable per-user correlation identifier into the logs. The
  // plan and the two counts are the operational content; the uid was not.
  console.log(
    `[governance/queue] User: isAdmin: false, plan: ${userPlan}, reviewerFor: ${reviewerFor.length} users, assignersByReviewerUidField: ${assignersByReviewerField.length}`
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
    console.warn(`[governance/queue] Truncated visible owner set to 30 (requesting uid retained in request context)`);
  }
  visibleUserIds = visibleUserIds.filter((id) => id.trim() !== self);

  // Phase FIRST-ADMIN-C6 — governance diagnostics carry SHAPE, not tenant data.
// These lines ran on every governance queue load and wrote other users' owner
// UIDs, run ids, consensus scores and governance status into Production logs.
// Counts and scope type answer the same operational questions without putting
// one tenant's records in front of whoever can read the logs.
  console.log(`[governance/queue] Scoping decision: assigners scope, ${visibleUserIds.length} owner(s)`);

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
 * The key carries uid + canonical email + verification state + ACCOUNT-ENABLED
 * state, so a verified grant cannot outlive the proof it rested on: revoking
 * verification, changing the address, or DISABLING THE ACCOUNT each produce a
 * different key and force a recompute. Caching by uid alone would be wrong for
 * exactly that reason.
 *
 * Phase FIRST-ADMIN-C5 — `disabled` was the lever this key was missing. C4 made
 * a disabled account lose its email-derived authority everywhere else, but the
 * key was unchanged, so a disabled governance administrator kept a cached
 * `visibleUserIds: null` — every user's runs, decisions and review records —
 * for the remainder of the TTL. Any future addition to the authority evidence
 * must be added here in the same commit.
 */
export async function resolveGovernanceVisibleUserIdsCached(uid: string): Promise<GovernanceVisibility> {
  if (!adminDb) {
    return { ok: false, kind: "no_db" };
  }

  const identity = await resolveTrustedGovernanceIdentity(uid);
  const key = [
    uid,
    identity.email.trim().toLowerCase(),
    identity.emailVerified === true ? "verified" : "unverified",
    identity.disabled === true ? "disabled" : "enabled",
  ].join("::");
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
