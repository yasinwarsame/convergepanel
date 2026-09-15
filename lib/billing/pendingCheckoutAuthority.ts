import "server-only";
import type Stripe from "stripe";
import { CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY } from "./uidCustomerAuthority";
import { stripeLookup } from "./reconciliationOutcome";

/**
 * Phase BILLING-INTEGRITY-R5-C1 — pending Checkout Session authority.
 *
 * The per-uid lease serializes overlapping requests, but it is released when a
 * request returns. A second request a moment later still sees no plan-bearing
 * subscription (the first Checkout Session has not been paid yet) and could
 * open Session B; both sessions can then complete into two subscriptions.
 *
 * Stripe's own Checkout Session state is the durable authority for that
 * window: a session is `open` until it completes or expires. Before creating a
 * session, checkout enumerates the canonical customer's OPEN subscription-mode
 * sessions that carry this application's server-written uid marker, and reuses
 * an actionable one instead of creating another. Enumeration is complete and
 * fail-closed: an error, a non-advancing cursor or a page cap refuses checkout
 * rather than falling through to `sessions.create`.
 *
 * Ownership: only `mode === "subscription"`, the canonical customer, and the
 * exact `metadata.firebaseUid` written by this route. Another application's
 * sessions in the shared Stripe account never count, and never block.
 */

export const MAX_PENDING_SESSION_PAGES = 10;

export type PendingCheckoutAuthority =
  | { kind: "none"; pagesFetched: number }
  | { kind: "pending"; session: Stripe.Checkout.Session; count: number; pagesFetched: number }
  | { kind: "enumeration_incomplete"; reason: "page_limit_reached" | "cursor_not_advancing"; pagesFetched: number };

export function isActionableConvergePanelSession(session: Stripe.Checkout.Session, args: { uid: string; customerId: string; nowSeconds: number }): boolean {
  if (session.status !== "open") return false;
  if (session.mode !== "subscription") return false;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  if (customer !== args.customerId) return false;
  if (session.metadata?.[CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY] !== args.uid) return false;
  if (typeof session.expires_at !== "number" || session.expires_at <= args.nowSeconds) return false;
  if (!session.url) return false;
  return true;
}

/**
 * Enumerate the canonical customer's open Checkout Sessions completely and
 * return the earliest still-actionable ConvergePanel subscription session, if
 * any. Transient Stripe failures surface as `TransientDependencyError` via
 * `stripeLookup` so the caller refuses checkout.
 */
export async function resolvePendingCheckoutAuthority(args: { stripe: Stripe; uid: string; customerId: string; now?: () => number }): Promise<PendingCheckoutAuthority> {
  const nowSeconds = Math.floor((args.now ?? Date.now)() / 1000);
  const actionable: Stripe.Checkout.Session[] = [];
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
    for (const s of result.value.data) if (isActionableConvergePanelSession(s, { uid: args.uid, customerId: args.customerId, nowSeconds })) actionable.push(s);
    if (!result.value.has_more || result.value.data.length === 0) break;
    const next = result.value.data[result.value.data.length - 1]?.id;
    if (!next || seenCursors.has(next)) return { kind: "enumeration_incomplete", reason: "cursor_not_advancing", pagesFetched };
    seenCursors.add(next);
    startingAfter = next;
    if (page === MAX_PENDING_SESSION_PAGES - 1) return { kind: "enumeration_incomplete", reason: "page_limit_reached", pagesFetched };
  }
  if (actionable.length === 0) return { kind: "none", pagesFetched };
  actionable.sort((a, b) => a.created - b.created);
  return { kind: "pending", session: actionable[0], count: actionable.length, pagesFetched };
}
