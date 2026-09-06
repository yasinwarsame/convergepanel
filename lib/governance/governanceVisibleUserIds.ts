/**
 * Which run owners' documents a user may see in governance queue / audit / review.
 */

import "server-only";
import { NextResponse } from "next/server";
import { isVerifiedAdminEmail } from "@/lib/admin/config";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
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
 * Resolves Firestore `userId` values the caller may load in governance queue / audit / review.
 * - Support admins: `visibleUserIds: null` (global queue).
 * - Full plan + assigners: assigner UIDs only (from `governanceReviewerFor` + reverse lookup), never the viewer's uid.
 * - Full plan, no assigners: empty array (queue empty; policies/audit still allowed).
 * - Free / lite: plan_required.
 */
export async function resolveGovernanceVisibleUserIds(
  uid: string,
  email: string,
  emailVerified: boolean
): Promise<GovernanceVisibility> {
  if (!adminDb) {
    return { ok: false, kind: "no_db" };
  }

  // Phase FIRESTORE-AUTHZ-P0.2: this branch returns `visibleUserIds: null` —
  // no owner filter at all, i.e. every user's runs, decisions and review
  // records. An allowlisted address that the identity has not PROVEN it owns
  // must never reach it. Callers supply both fields from one live Auth record
  // (`resolveGovernanceRequestUser`), never from a token claim.
  if (isVerifiedAdminEmail({ email, emailVerified })) {
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
 * Same as {@link resolveGovernanceVisibleUserIds} but caches the result per
 * (uid, canonical email, verified state) for 2 minutes.
 *
 * Phase FIRESTORE-AUTHZ-P0.2 — THE VERIFICATION STATE IS PART OF THE KEY, and
 * that is a security requirement, not a tidiness one. The identity evidence is
 * re-read live on every request; keying only on (uid, email) would let a global
 * admin grant computed while an identity was verified continue to be served for
 * up to the TTL after verification was revoked, and would let a changed email
 * reuse a decision made for the previous address. A cached authority must never
 * outlive the proof it rested on, and TTL alone is not that proof.
 */
export async function resolveGovernanceVisibleUserIdsCached(
  uid: string,
  email: string,
  emailVerified: boolean
): Promise<GovernanceVisibility> {
  const key = `${uid}::${email.trim().toLowerCase()}::${emailVerified === true ? "verified" : "unverified"}`;
  const now = Date.now();
  const hit = governanceVisibilityCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.entry;
  }
  const entry = await resolveGovernanceVisibleUserIds(uid, email, emailVerified);
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
