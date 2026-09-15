import "server-only";
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { TransientDependencyError } from "./reconciliationOutcome";

/**
 * Phase BILLING-INTEGRITY-R5 — same-uid checkout serialization.
 *
 * UID-scoped customer discovery closes the historical missing/stale-binding
 * hole, but two SIMULTANEOUS checkout requests for a uid with no binding could
 * still both observe "no customer" and both create one. Stripe search is also
 * eventually consistent, so a customer created a moment ago may not be found
 * by the next request's discovery.
 *
 * The guard is a short per-uid lease document, acquired inside a Firestore
 * transaction: whoever commits first holds it; the other request refuses with
 * `busy` and mutates nothing. The lease is released on every exit path and has
 * a short expiry so a crashed request can never wedge a user. Combined with a
 * per-uid Stripe idempotency key on customer creation and the
 * bind-if-absent write below, this gives a real same-uid guarantee without a
 * new state machine.
 */

export const CHECKOUT_LEASE_COLLECTION = "billingCheckoutLeases";
export const CHECKOUT_LEASE_TTL_MS = 60_000;

export type LeaseOutcome<T> = { kind: "held"; result: T } | { kind: "busy" };
export type CheckoutLease = { uid: string; token: string };
/** A mutation must not start with less than this much lease time left (R5-C1 lease-expiry edge). */
export const CHECKOUT_LEASE_MUTATION_MARGIN_MS = 5_000;

export async function withCheckoutIdentityLease<T>(uid: string, run: (lease: CheckoutLease) => Promise<T>, now: () => number = Date.now): Promise<LeaseOutcome<T>> {
  if (!adminDb) throw new TransientDependencyError("firestore", "checkout_lease_acquire");
  const ref = adminDb.collection(CHECKOUT_LEASE_COLLECTION).doc(uid);
  const token = randomUUID();

  let acquired: boolean;
  try {
    acquired = await adminDb.runTransaction<boolean>(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as { expiresAtMs?: number } | undefined) : undefined;
      if (data && typeof data.expiresAtMs === "number" && data.expiresAtMs > now()) return false;
      tx.set(ref, { uid, token, acquiredAtMs: now(), expiresAtMs: now() + CHECKOUT_LEASE_TTL_MS });
      return true;
    });
  } catch (err) {
    throw new TransientDependencyError("firestore", "checkout_lease_acquire", err);
  }
  if (!acquired) return { kind: "busy" };

  try {
    return { kind: "held", result: await run({ uid, token }) };
  } finally {
    // Release only our own lease; a later holder (after expiry) must not be evicted.
    try {
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? (snap.data() as { token?: string } | undefined) : undefined;
        if (data?.token === token) tx.delete(ref);
      });
    } catch {
      // Expiry is the fallback; a failed release is not a billing mutation.
    }
  }
}

/**
 * R5-C1 — re-verify, immediately before any Stripe mutation, that THIS request
 * still holds the lease with a safety margin. If a slow request outlived its
 * lease and another request took over, the slow one must refuse rather than
 * mutate: the new holder is the only request allowed to act.
 */
export async function isCheckoutLeaseStillHeld(lease: CheckoutLease, now: () => number = Date.now): Promise<boolean> {
  if (!adminDb) throw new TransientDependencyError("firestore", "checkout_lease_verify");
  const ref = adminDb.collection(CHECKOUT_LEASE_COLLECTION).doc(lease.uid);
  try {
    return await adminDb.runTransaction<boolean>(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as { token?: string; expiresAtMs?: number } | undefined) : undefined;
      return !!data && data.token === lease.token && typeof data.expiresAtMs === "number" && data.expiresAtMs - CHECKOUT_LEASE_MUTATION_MARGIN_MS > now();
    });
  } catch (err) {
    throw new TransientDependencyError("firestore", "checkout_lease_verify", err);
  }
}

export type BindOutcome = { kind: "bound" } | { kind: "already_bound" } | { kind: "conflict"; existingCustomerId: string };

/**
 * Persist `stripeCustomerId` on the user document only if no binding exists,
 * inside a transaction. A different binding appearing concurrently is a
 * conflict the caller must refuse — never overwrite one customer with another.
 */
export async function bindStripeCustomerIfAbsent(uid: string, customerId: string): Promise<BindOutcome> {
  if (!adminDb) throw new TransientDependencyError("firestore", "checkout_bind_customer");
  const ref = adminDb.collection("users").doc(uid);
  try {
    return await adminDb.runTransaction<BindOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      const existing = (snap.exists ? (snap.data() as { stripeCustomerId?: string } | undefined)?.stripeCustomerId : undefined) || null;
      if (existing === customerId) return { kind: "already_bound" };
      if (existing) return { kind: "conflict", existingCustomerId: existing };
      tx.set(ref, { stripeCustomerId: customerId }, { merge: true });
      return { kind: "bound" };
    });
  } catch (err) {
    throw new TransientDependencyError("firestore", "checkout_bind_customer", err);
  }
}
