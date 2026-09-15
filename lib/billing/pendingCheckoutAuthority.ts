import "server-only";
import type Stripe from "stripe";
import { CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY } from "./uidCustomerAuthority";
import { stripeLookup } from "./reconciliationOutcome";

/**
 * Phase BILLING-INTEGRITY-R5-C1/C2 — pending Checkout Session authority.
 *
 * The per-uid lease serializes overlapping requests, but it is released when a
 * request returns. A second request a moment later still sees no plan-bearing
 * subscription (the first Checkout Session has not been paid yet) and could
 * open Session B; both sessions can then complete into two subscriptions.
 *
 * Stripe's own Checkout Session state is the durable authority for that
 * window: a session is `open` until it completes or expires. Before creating a
 * session, checkout enumerates the canonical customer's OPEN subscription-mode
 * sessions and classifies each by its server-written uid marker. Enumeration
 * is complete and fail-closed: an error, a non-advancing cursor or a page cap
 * refuses checkout rather than falling through to `sessions.create`.
 *
 * Classification (R5-C2) of an OPEN, unexpired, subscription-mode session on
 * the canonical customer:
 *   - marker === authenticated uid       → MATCHING pending authority
 *   - non-empty marker !== uid           → IDENTITY CONFLICT: a customer proven
 *                                          to belong to uid A carrying a session
 *                                          written for uid B is contradictory
 *                                          billing state, and that session can
 *                                          still complete. Never ignored.
 *   - no marker at all                   → unrelated (another application in
 *                                          the shared Stripe account); ignored.
 *
 * Contract: exactly ONE matching session may be reused; two or more matching
 * sessions fail closed (returning one would not neutralize the other); ANY
 * identity conflict fails closed even beside a valid matching session.
 */

export const MAX_PENDING_SESSION_PAGES = 10;

export type PendingCheckoutAuthority =
  | { kind: "none"; pagesFetched: number }
  | { kind: "exactly_one"; session: Stripe.Checkout.Session; pagesFetched: number }
  | { kind: "multiple"; sessionIds: string[]; count: number; pagesFetched: number }
  | { kind: "identity_conflict"; sessionIds: string[]; count: number; matchingSessionIds: string[]; pagesFetched: number }
  | { kind: "enumeration_incomplete"; reason: "page_limit_reached" | "cursor_not_advancing"; pagesFetched: number };

export type OpenSessionClassification = "matching" | "identity_conflict" | "unrelated";

/** Can this session still complete into a subscription on the canonical customer? Independent of who it was written for. */
export function isCompletableSubscriptionSession(session: Stripe.Checkout.Session, args: { customerId: string; nowSeconds: number }): boolean {
  if (session.status !== "open") return false;
  if (session.mode !== "subscription") return false;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  if (customer !== args.customerId) return false;
  if (typeof session.expires_at !== "number" || session.expires_at <= args.nowSeconds) return false;
  return true;
}

export function classifyOpenSession(session: Stripe.Checkout.Session, args: { uid: string; customerId: string; nowSeconds: number }): OpenSessionClassification {
  if (!isCompletableSubscriptionSession(session, args)) return "unrelated";
  const marker = session.metadata?.[CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY];
  if (typeof marker !== "string" || marker.length === 0) return "unrelated";
  return marker === args.uid ? "matching" : "identity_conflict";
}

/**
 * Enumerate the canonical customer's open Checkout Sessions completely and
 * classify them. Transient Stripe failures surface as
 * `TransientDependencyError` via `stripeLookup` so the caller refuses checkout.
 */
export async function resolvePendingCheckoutAuthority(args: { stripe: Stripe; uid: string; customerId: string; now?: () => number }): Promise<PendingCheckoutAuthority> {
  const nowSeconds = Math.floor((args.now ?? Date.now)() / 1000);
  const matching: Stripe.Checkout.Session[] = [];
  const conflicting: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  const seenCursors = new Set<string>();
  let pagesFetched = 0;
  for (let page = 0; page < MAX_PENDING_SESSION_PAGES; page++) {
    const result = await stripeLookup("checkout.sessions.list", () =>
      args.stripe.checkout.sessions.list({ customer: args.customerId, status: "open", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    );
    // A list endpoint reporting the customer as missing is not proof of "no
    // sessions"; refuse rather than create.
    if (result.kind === "absent") return { kind: "enumeration_incomplete", reason: "cursor_not_advancing", pagesFetched };
    pagesFetched += 1;
    for (const s of result.value.data) {
      const c = classifyOpenSession(s, { uid: args.uid, customerId: args.customerId, nowSeconds });
      if (c === "matching") matching.push(s);
      else if (c === "identity_conflict") conflicting.push(s);
    }
    if (!result.value.has_more || result.value.data.length === 0) break;
    const next = result.value.data[result.value.data.length - 1]?.id;
    if (!next || seenCursors.has(next)) return { kind: "enumeration_incomplete", reason: "cursor_not_advancing", pagesFetched };
    seenCursors.add(next);
    startingAfter = next;
    if (page === MAX_PENDING_SESSION_PAGES - 1) return { kind: "enumeration_incomplete", reason: "page_limit_reached", pagesFetched };
  }
  if (conflicting.length > 0) {
    return { kind: "identity_conflict", sessionIds: conflicting.map((s) => s.id), count: conflicting.length, matchingSessionIds: matching.map((s) => s.id), pagesFetched };
  }
  if (matching.length === 0) return { kind: "none", pagesFetched };
  if (matching.length > 1) return { kind: "multiple", sessionIds: matching.map((s) => s.id), count: matching.length, pagesFetched };
  return { kind: "exactly_one", session: matching[0], pagesFetched };
}
