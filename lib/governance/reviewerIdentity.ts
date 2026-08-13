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
 * A known, canonical assignment/decision points at a real uid — a failed
 * NAME lookup for that uid is a resolution gap, not evidence the reviewer
 * is unidentified. Callers resolving an already-known reviewer/assignee
 * uid (assignment, single-reviewer decision, panel seat, override actor,
 * legacy reviewedBy) should prefer this over `UNKNOWN_REVIEWER_LABEL` for
 * their terminal fallback — reserving "Unknown reviewer" for genuinely
 * unresolved-identity contexts (e.g. this module's own reuse for
 * OWNER name resolution in `GET /api/user/reviews`, where the "reviewer"
 * framing doesn't apply at all).
 */
export const REVIEWER_UNAVAILABLE_LABEL = "Reviewer unavailable";

/**
 * Resolves one uid to a safe display name. Never throws — a Firestore
 * read failure degrades to the email-based fallback, and a fully absent
 * name/email degrades to `unresolvedLabel` (default `UNKNOWN_REVIEWER_LABEL`)
 * rather than an empty string.
 *
 * Email fallback has two independent sources, tried in order: (1) the
 * SAME `users/{uid}` doc's own `email` field — always available for any
 * uid that has ever signed up/logged in (set at `app/signup/page.tsx` and
 * re-synced at every `app/login/page.tsx`), regardless of whether the
 * caller shares a team with that uid; (2) `fallbackEmail`, the caller-
 * supplied roster/context email (e.g. a team roster entry). Source (1) is
 * what fixes personal (non-team) reviewer identity — a personal reviewer
 * is, by construction, never on the run owner's team roster, so relying
 * on `fallbackEmail` alone left every such reviewer permanently
 * unresolvable down to their masked email whenever they hadn't set a
 * Firestore `name`. Revealing this uid's OWN email (masked) is safe here
 * specifically because every caller of this resolver already supplies a
 * uid drawn from a canonical governance record for THIS run (an
 * assignment, decision, panel seat, or history row) — never an arbitrary
 * uid — so the caller already has a legitimate, run-scoped reason to see
 * who that uid is.
 */
export async function resolveReviewerDisplayName(
  uid: string,
  fallbackEmail: string | undefined | null,
  callerEmail: string | undefined | null,
  unresolvedLabel: string = UNKNOWN_REVIEWER_LABEL
): Promise<string> {
  let ownEmail = "";
  if (adminDb) {
    try {
      const snap = await adminDb.collection("users").doc(uid).get();
      const data = snap.data();
      const name = typeof data?.name === "string" ? (data.name as string).trim() : "";
      if (name) return name;
      ownEmail = typeof data?.email === "string" ? (data.email as string).trim() : "";
    } catch {
      // Fall through to the email-based fallback.
    }
  }
  const masked = maskEmail(ownEmail || fallbackEmail || "", callerEmail ?? undefined);
  return masked || unresolvedLabel;
}

/**
 * Batched variant for resolving several reviewer uids in ONE Firestore
 * round-trip via `db.getAll(...refs)` — the same batching primitive
 * already established in this codebase for the identical "resolve N user
 * docs by uid" shape (`app/api/admin/runs/route.ts`,
 * `app/api/governance/audit/route.ts`), reused here rather than issuing N
 * independent `Promise.all`-parallelized-but-still-N-round-trip reads
 * (the pattern `review-panel/route.ts`'s own inline resolver uses — fine
 * at that route's own call site, but a genuine batch primitive already
 * exists and is preferred here). Chunked at 10 per `getAll()` call purely
 * for consistency with the existing precedent; a real panel is bounded at
 * `MAX_ADAPTIVE_PANEL_REVIEWERS` (9) so this endpoint never needs more
 * than one chunk in practice.
 *
 * `emailByUid` supplies each uid's best-known email fallback (e.g. from a
 * team roster) — this module has no opinion on where that comes from.
 * Deduplicates `uids` internally so a uid appearing in multiple roles
 * (e.g. both a panel reviewer and the override actor) is only read once.
 */
export async function resolveReviewerDisplayNames(
  uids: readonly string[],
  emailByUid: ReadonlyMap<string, string>,
  callerEmail: string | undefined | null,
  unresolvedLabel: string = UNKNOWN_REVIEWER_LABEL
): Promise<Map<string, string>> {
  const uniqueUids = Array.from(new Set(uids));
  const result = new Map<string, string>();

  if (!adminDb || uniqueUids.length === 0) {
    for (const uid of uniqueUids) {
      const masked = maskEmail(emailByUid.get(uid) ?? "", callerEmail ?? undefined);
      result.set(uid, masked || unresolvedLabel);
    }
    return result;
  }

  const db = adminDb;
  const CHUNK_SIZE = 10;
  for (let i = 0; i < uniqueUids.length; i += CHUNK_SIZE) {
    const chunk = uniqueUids.slice(i, i + CHUNK_SIZE);
    try {
      const snaps = await db.getAll(...chunk.map((uid) => db.collection("users").doc(uid)));
      for (let j = 0; j < chunk.length; j++) {
        const uid = chunk[j];
        const data = snaps[j]?.data();
        const name = typeof data?.name === "string" ? (data.name as string).trim() : "";
        if (name) {
          result.set(uid, name);
        } else {
          // See resolveReviewerDisplayName's doc comment — the uid's OWN
          // email (source 1) takes precedence over the caller-supplied
          // roster email (source 2), since it's always authoritative and
          // never scoped to team membership.
          const ownEmail = typeof data?.email === "string" ? (data.email as string).trim() : "";
          const masked = maskEmail(ownEmail || emailByUid.get(uid) || "", callerEmail ?? undefined);
          result.set(uid, masked || unresolvedLabel);
        }
      }
    } catch {
      // Whole-chunk read failure degrades every uid in it to its
      // email-based fallback — never throws, mirrors the single-uid
      // resolver's own degrade-on-read-failure behavior.
      for (const uid of chunk) {
        const masked = maskEmail(emailByUid.get(uid) ?? "", callerEmail ?? undefined);
        result.set(uid, masked || unresolvedLabel);
      }
    }
  }
  return result;
}
