import "server-only";
import type Stripe from "stripe";
import { resolveCustomerSubscriptionAuthority, type CustomerSubscriptionAuthority } from "./customerSubscriptionAuthority";
import { stripeLookup } from "./reconciliationOutcome";

/**
 * Phase BILLING-INTEGRITY-R5 — UID-scoped Stripe customer authority.
 *
 * Why this exists: `resolveCustomerSubscriptionAuthority` proves the
 * subscription set of ONE Stripe customer. Checkout used to pick that customer
 * from `users/{uid}.stripeCustomerId` and, when the binding was absent, create
 * a fresh customer. A missing or stale binding therefore produced a SECOND
 * customer — and a second plan-bearing subscription — for the same
 * authenticated uid, invisible to every customer-scoped check. The R4 audit
 * reproduced that three times in the internal test population.
 *
 * This module answers the wider question: across every ConvergePanel Stripe
 * customer that belongs to the authenticated uid, which customer (if any) may
 * checkout act on, and is there already plan-bearing authority anywhere?
 *
 * Tenant isolation: the Stripe account is shared with other applications.
 * Ownership is asserted ONLY by the exact `metadata.firebaseUid` value that
 * this application writes at customer creation. Email, card fingerprint and
 * product metadata are never used to infer ownership.
 *
 * Fail-closed posture: a discovery error, an incomplete listing, a stored
 * customer that does not belong to the uid, or any topology that has no
 * deterministic canonical customer refuses checkout with zero mutation.
 */

export const CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY = "firebaseUid";
export const MAX_CUSTOMER_DISCOVERY_PAGES = 10;

/** Firebase uids are opaque, `[A-Za-z0-9_-]`, ≤128 chars. Anything else is refused before it can reach a search query. */
const UID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
export function isPlausibleFirebaseUid(uid: string): boolean {
  return typeof uid === "string" && UID_SHAPE.test(uid);
}

export type CustomerDiscovery =
  | { ok: true; customers: Stripe.Customer[]; pagesFetched: number }
  | { ok: false; reason: "invalid_uid" | "discovery_incomplete"; pagesFetched: number };

/**
 * Enumerate every non-deleted Stripe customer whose `metadata.firebaseUid`
 * EXACTLY equals `uid`. Complete pagination; a page cap is treated as
 * incomplete, never as "nothing more". Transient Stripe failures surface as
 * `TransientDependencyError` via `stripeLookup` so callers fail closed.
 */
export async function discoverCustomersForUid(args: { stripe: Stripe; uid: string }): Promise<CustomerDiscovery> {
  if (!isPlausibleFirebaseUid(args.uid)) return { ok: false, reason: "invalid_uid", pagesFetched: 0 };
  const query = `metadata['${CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY}']:'${args.uid}'`;
  const customers: Stripe.Customer[] = [];
  let page: string | undefined;
  let pagesFetched = 0;
  for (let i = 0; i < MAX_CUSTOMER_DISCOVERY_PAGES; i++) {
    const result = await stripeLookup("customers.search", () => args.stripe.customers.search({ query, limit: 100, ...(page ? { page } : {}) }));
    // A search endpoint never reports a definitive "missing" resource; treat
    // an absent result as an incomplete discovery rather than as zero customers.
    if (result.kind === "absent") return { ok: false, reason: "discovery_incomplete", pagesFetched };
    pagesFetched += 1;
    for (const c of result.value.data) {
      if ((c as { deleted?: boolean }).deleted) continue;
      if (c.metadata?.[CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY] !== args.uid) continue; // exact match only
      customers.push(c);
    }
    if (!result.value.has_more) return { ok: true, customers, pagesFetched };
    if (!result.value.next_page) return { ok: false, reason: "discovery_incomplete", pagesFetched };
    page = result.value.next_page;
  }
  return { ok: false, reason: "discovery_incomplete", pagesFetched };
}

export type StoredCustomerValidation =
  | { kind: "ok"; customer: Stripe.Customer; legacyUnbound: boolean }
  | { kind: "stored_customer_missing" }
  | { kind: "stored_customer_mismatch" };

/**
 * A stored `stripeCustomerId` is server-written and therefore trusted as a
 * pointer, but the customer it points at must still belong to the uid under
 * the metadata contract. A customer carrying a DIFFERENT uid is a billing
 * integrity failure. A customer carrying NO uid metadata is a legacy record
 * this application created before the marker existed; it is accepted and
 * reported as `legacyUnbound` so the caller may backfill the marker.
 */
export async function validateStoredCustomer(args: { stripe: Stripe; uid: string; storedCustomerId: string }): Promise<StoredCustomerValidation> {
  const result = await stripeLookup("customers.retrieve", () => args.stripe.customers.retrieve(args.storedCustomerId));
  if (result.kind === "absent") return { kind: "stored_customer_missing" };
  const customer = result.value;
  if ((customer as { deleted?: boolean }).deleted) return { kind: "stored_customer_missing" };
  const marker = (customer as Stripe.Customer).metadata?.[CONVERGEPANEL_CUSTOMER_UID_METADATA_KEY];
  if (typeof marker === "string" && marker.length > 0 && marker !== args.uid) return { kind: "stored_customer_mismatch" };
  return { kind: "ok", customer: customer as Stripe.Customer, legacyUnbound: !marker };
}

export type UidCustomerAuthority =
  /** The uid has no ConvergePanel customer anywhere — the ONLY outcome that may create one. */
  | { kind: "no_customer" }
  /** Exactly one usable customer and no plan-bearing subscription anywhere — reuse it. */
  | { kind: "reuse_customer"; customerId: string; source: "stored" | "discovered"; legacyUnbound: boolean }
  /** One authoritative plan-bearing subscription on the canonical customer — the existing in-place path. */
  | { kind: "exactly_one"; customerId: string; source: "stored" | "discovered"; subscription: Stripe.Subscription; legacyUnbound: boolean }
  /** Same-customer ambiguity, exactly as the customer-scoped resolver reports it. */
  | { kind: "multiple_entitlements"; customerId: string; count: number; subscriptionIds: string[] }
  /** Plan-bearing subscriptions on MORE THAN ONE customer of this uid. */
  | { kind: "cross_customer_entitlements"; customerIds: string[]; subscriptionIds: string[] }
  /** The sole plan-bearing customer is not the Firestore-bound one (or there is no binding and several customers exist). */
  | { kind: "customer_authority_conflict"; authoritativeCustomerId: string; storedCustomerId: string | null; subscriptionIds: string[] }
  /** Several customers, none plan-bearing, and no deterministic canonical rule (no stored binding). */
  | { kind: "ambiguous_customers"; customerIds: string[] }
  | { kind: "stored_customer_missing" }
  | { kind: "stored_customer_mismatch" }
  | { kind: "invalid_uid" }
  | { kind: "discovery_incomplete"; pagesFetched: number }
  | { kind: "enumeration_incomplete"; customerId: string; reason: "page_limit_reached" | "cursor_not_advancing"; pagesFetched: number };

/**
 * Resolve checkout authority for an authenticated uid across ALL of its
 * ConvergePanel customers.
 *
 * Deterministic canonical rule (the only one the codebase already has, see
 * `verifyCustomerIdentity`): the Firestore-bound customer, once validated, is
 * canonical. It is chosen when it is the sole plan-bearing customer, and when
 * nothing is plan-bearing anywhere. Every other multi-customer topology fails
 * closed. Discovery ALWAYS runs, even with a stored binding — skipping it is
 * exactly the stale-binding defect.
 */
export async function resolveUidCustomerAuthority(args: { stripe: Stripe; uid: string; storedCustomerId: string | null | undefined }): Promise<UidCustomerAuthority> {
  if (!isPlausibleFirebaseUid(args.uid)) return { kind: "invalid_uid" };
  const storedId = args.storedCustomerId || null;

  let stored: StoredCustomerValidation | null = null;
  if (storedId) {
    stored = await validateStoredCustomer({ stripe: args.stripe, uid: args.uid, storedCustomerId: storedId });
    if (stored.kind !== "ok") return { kind: stored.kind };
  }

  const discovery = await discoverCustomersForUid({ stripe: args.stripe, uid: args.uid });
  if (!discovery.ok) return discovery.reason === "invalid_uid" ? { kind: "invalid_uid" } : { kind: "discovery_incomplete", pagesFetched: discovery.pagesFetched };

  // Candidate set = discovered ∪ stored (the stored customer may predate the
  // metadata marker, or the search index may lag behind a just-created customer).
  const candidateIds: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => { if (!seen.has(id)) { seen.add(id); candidateIds.push(id); } };
  if (stored?.kind === "ok") push(stored.customer.id);
  for (const c of discovery.customers) push(c.id);

  if (candidateIds.length === 0) return { kind: "no_customer" };

  const authorities: Array<{ customerId: string; authority: CustomerSubscriptionAuthority }> = [];
  for (const customerId of candidateIds) {
    const authority = await resolveCustomerSubscriptionAuthority({ stripe: args.stripe, verifiedCustomerId: customerId });
    if (authority.kind === "enumeration_incomplete") return { kind: "enumeration_incomplete", customerId, reason: authority.reason, pagesFetched: authority.pagesFetched };
    if (authority.kind === "customer_missing" || authority.kind === "unverified_customer") {
      // A discovered customer that vanished mid-flight is not proof of anything; refuse rather than guess.
      return { kind: "discovery_incomplete", pagesFetched: discovery.pagesFetched };
    }
    authorities.push({ customerId, authority });
  }

  const planBearing = authorities.filter((a) => a.authority.kind === "exactly_one" || a.authority.kind === "multiple_entitlements");

  if (planBearing.length > 1) {
    return {
      kind: "cross_customer_entitlements",
      customerIds: planBearing.map((a) => a.customerId),
      subscriptionIds: planBearing.flatMap((a) => (a.authority.kind === "exactly_one" ? [a.authority.subscription.id] : a.authority.kind === "multiple_entitlements" ? a.authority.subscriptionIds : [])),
    };
  }

  if (planBearing.length === 1) {
    const holder = planBearing[0];
    if (holder.authority.kind === "multiple_entitlements") {
      return { kind: "multiple_entitlements", customerId: holder.customerId, count: holder.authority.count, subscriptionIds: holder.authority.subscriptionIds };
    }
    const subscription = holder.authority.kind === "exactly_one" ? holder.authority.subscription : null;
    if (!subscription) return { kind: "discovery_incomplete", pagesFetched: discovery.pagesFetched }; // unreachable by construction; fail closed anyway
    if (storedId) {
      if (holder.customerId === storedId) return { kind: "exactly_one", customerId: storedId, source: "stored", subscription, legacyUnbound: stored?.kind === "ok" ? stored.legacyUnbound : false };
      return { kind: "customer_authority_conflict", authoritativeCustomerId: holder.customerId, storedCustomerId: storedId, subscriptionIds: [subscription.id] };
    }
    if (candidateIds.length === 1) return { kind: "exactly_one", customerId: holder.customerId, source: "discovered", subscription, legacyUnbound: false };
    return { kind: "customer_authority_conflict", authoritativeCustomerId: holder.customerId, storedCustomerId: null, subscriptionIds: [subscription.id] };
  }

  // Nothing plan-bearing anywhere.
  if (storedId && stored?.kind === "ok") return { kind: "reuse_customer", customerId: storedId, source: "stored", legacyUnbound: stored.legacyUnbound };
  if (candidateIds.length === 1) return { kind: "reuse_customer", customerId: candidateIds[0], source: "discovered", legacyUnbound: false };
  return { kind: "ambiguous_customers", customerIds: candidateIds };
}
