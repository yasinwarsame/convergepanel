import "server-only";

/**
 * Review & Governance report completion — a shared uid → display-name
 * resolver for the NEW `GET /api/user/runs/[runId]/governance` endpoint.
 *
 * Generalizes the identical inline pattern already duplicated three times
 * (`app/api/teams/adaptive-runs/[runId]/assignment/route.ts`,
 * `.../votes/route.ts`, `.../review-panel/route.ts`): prefer `users/{uid}.name`,
 * else fall back to a masked email (unmasked only when it matches the
 * caller's own email), else a safe, non-identifying placeholder — never a
 * raw UID and never a blank string.
 *
 * Deliberate scope boundary: the 3 existing call sites above are NOT
 * refactored to use this — they are working, tested, team-admin-gated
 * routes outside this task's scope, and touching them for zero behavior
 * change risks an unrelated regression. Only the new governance-detail
 * endpoint uses this module.
 */

import { adminDb } from "@/lib/firebase/admin";
import { maskEmail } from "@/lib/utils/maskEmail";

export const UNKNOWN_REVIEWER_LABEL = "Unknown reviewer";

/**
 * Resolves one uid to a safe display name. Never throws — a Firestore
 * read failure degrades to the email-based fallback, and a fully absent
 * name/email degrades to `UNKNOWN_REVIEWER_LABEL` rather than an empty
 * string.
 */
export async function resolveReviewerDisplayName(
  uid: string,
  fallbackEmail: string | undefined | null,
  callerEmail: string | undefined | null
): Promise<string> {
  if (adminDb) {
    try {
      const snap = await adminDb.collection("users").doc(uid).get();
      const name = typeof snap.data()?.name === "string" ? (snap.data()!.name as string).trim() : "";
      if (name) return name;
    } catch {
      // Fall through to the email-based fallback.
    }
  }
  const masked = maskEmail(fallbackEmail ?? "", callerEmail ?? undefined);
  return masked || UNKNOWN_REVIEWER_LABEL;
}

/**
 * Batched variant for resolving several reviewer uids at once (panel
 * reviewers, an assignment's `assignedByUserId`, etc.) — still N
 * individual `users/{uid}` reads under `Promise.all` (the same read
 * count/shape `review-panel/route.ts`'s own existing pattern already
 * uses), just centralizing the per-uid logic. `emailByUid` supplies each
 * uid's best-known email fallback (e.g. from a team roster) — this module
 * has no opinion on where that comes from.
 */
export async function resolveReviewerDisplayNames(
  uids: readonly string[],
  emailByUid: ReadonlyMap<string, string>,
  callerEmail: string | undefined | null
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    uids.map(async (uid) => [uid, await resolveReviewerDisplayName(uid, emailByUid.get(uid), callerEmail)] as const)
  );
  return new Map(entries);
}
