/**
 * Phase BILLING-PR145-C8.1 — resolving the subscription behind an Invoice,
 * on the API generation this application actually pins.
 *
 * `Invoice.subscription` was removed from the Stripe API. On the pinned
 * version (`2025-12-15.clover`, SDK 20.x) a subscription-generated invoice
 * carries it at `invoice.parent.subscription_details.subscription`, and
 * `invoice.parent.type` says whether the invoice came from a subscription at
 * all.
 *
 * The webhook route reached the removed field through
 * `invoice as Stripe.Invoice & { subscription?: ... }`. That cast is exactly
 * why nothing failed: TypeScript was told the field existed, so at runtime
 * `subscriptionId` was always `undefined` and BOTH invoice handlers were
 * silently dead — `invoice.payment_succeeded` reconciled nothing and
 * `invoice.payment_failed` logged `undefined`. The C8 review proved it by
 * delivering a real clover-shaped invoice.
 *
 * This resolver is deliberately typed, with no `as any` and no cast that
 * resurrects the old field, so the next API change breaks the build instead
 * of the billing.
 */

import "server-only";
import type Stripe from "stripe";

export type InvoiceSubscriptionResolution =
  /** A subscription invoice whose subscription we could identify. */
  | { kind: "subscription"; subscriptionId: string }
  /** Genuinely not subscription-backed (a one-off charge, a quote). Nothing to reconcile. */
  | { kind: "not_subscription" }
  /**
   * The invoice CLAIMS subscription parentage but carries no usable
   * subscription reference. Never guess one — an invoice is not authority to
   * pick a subscription. Callers surface this and change nothing.
   */
  | { kind: "malformed" };

export function resolveInvoiceSubscription(invoice: Stripe.Invoice): InvoiceSubscriptionResolution {
  const parent = invoice.parent;
  if (!parent || parent.type !== "subscription_details") return { kind: "not_subscription" };

  const details = parent.subscription_details;
  if (!details) return { kind: "malformed" };

  // The SDK types this as `string | Stripe.Subscription`: an id, or the
  // expanded object when the caller asked Stripe to expand it.
  const subscription = details.subscription;
  if (!subscription) return { kind: "malformed" };
  if (typeof subscription === "string") {
    return subscription ? { kind: "subscription", subscriptionId: subscription } : { kind: "malformed" };
  }
  return subscription.id ? { kind: "subscription", subscriptionId: subscription.id } : { kind: "malformed" };
}
