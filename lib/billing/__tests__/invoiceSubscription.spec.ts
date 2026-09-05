/**
 * Phase BILLING-PR145-C8.1 — the Invoice → subscription contract.
 *
 * The C8 exact-head review proved both invoice handlers were dead on the
 * pinned API version: they read `invoice.subscription`, a field that version
 * removed, through a cast that stopped TypeScript from saying so.
 */

import type Stripe from "stripe";
import { resolveInvoiceSubscription } from "../invoiceSubscription";

const invoice = (parent: unknown): Stripe.Invoice => ({ id: "in_1", parent } as unknown as Stripe.Invoice);

describe("resolveInvoiceSubscription", () => {
  it("REGRESSION: resolves the modern parent shape with a subscription id", () => {
    const r = resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: { subscription: "sub_1" } }));
    expect(r).toEqual({ kind: "subscription", subscriptionId: "sub_1" });
  });

  it("resolves an EXPANDED subscription object", () => {
    const r = resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: { subscription: { id: "sub_1", status: "active" } } }));
    expect(r).toEqual({ kind: "subscription", subscriptionId: "sub_1" });
  });

  it("REGRESSION: the removed legacy top-level field is NOT consulted", () => {
    const legacy = { id: "in_1", subscription: "sub_legacy" } as unknown as Stripe.Invoice;
    expect(resolveInvoiceSubscription(legacy)).toEqual({ kind: "not_subscription" });
  });

  it("a quote-generated invoice is not subscription-backed", () => {
    expect(resolveInvoiceSubscription(invoice({ type: "quote_details", quote_details: { quote: "qt_1" } }))).toEqual({ kind: "not_subscription" });
  });

  it("an invoice with no parent is not subscription-backed", () => {
    expect(resolveInvoiceSubscription(invoice(null))).toEqual({ kind: "not_subscription" });
    expect(resolveInvoiceSubscription(invoice(undefined))).toEqual({ kind: "not_subscription" });
  });

  it("REGRESSION: claimed subscription parentage with no usable reference is MALFORMED, never a guess", () => {
    expect(resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: null }))).toEqual({ kind: "malformed" });
    expect(resolveInvoiceSubscription(invoice({ type: "subscription_details" }))).toEqual({ kind: "malformed" });
    expect(resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: { subscription: null } }))).toEqual({ kind: "malformed" });
    expect(resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: { subscription: "" } }))).toEqual({ kind: "malformed" });
    expect(resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: { subscription: {} } }))).toEqual({ kind: "malformed" });
  });

  it("malformed is distinguishable from not_subscription, so a caller can log one and ignore the other", () => {
    const malformed = resolveInvoiceSubscription(invoice({ type: "subscription_details", subscription_details: null }));
    const notSub = resolveInvoiceSubscription(invoice(null));
    expect(malformed.kind).not.toBe(notSub.kind);
  });
});
