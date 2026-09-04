/**
 * Billing Annual Correction, Phase BILLING-ANNUAL-C1 — server-side guard that
 * a Stripe Price about to be sold actually bills on the cadence the user was
 * shown. Incident background: the Production Full Annual mapping pointed at a
 * $1,631.90 Price whose `recurring.interval` was `month`, so a customer who
 * bought "$1,631.90 / year" was charged that amount every month. Neither the
 * website copy nor the app's plan→Price mapping could see that mismatch,
 * because the app only ever passed a Price ID it trusted from configuration.
 *
 * This check closes that gap independently of configuration correctness: the
 * checkout route calls it with the interval the user selected, and refuses to
 * create a session or upgrade a subscription unless the Price's real
 * `recurring.interval` (and `interval_count === 1`) matches. Read-only; never
 * throws — every failure maps to a fail-closed result the caller turns into a
 * safe error response with no Stripe write.
 */

import "server-only";
import type Stripe from "stripe";
import type { BillingInterval } from "@/lib/plans";

export type StripePriceCadenceResult =
  | { ok: true; interval: BillingInterval }
  | { ok: false; reason: "lookup_failed" | "price_inactive" | "not_recurring" | "interval_mismatch"; actualInterval?: string; actualIntervalCount?: number };

export async function verifyStripePriceCadence(stripeClient: Pick<Stripe, "prices">, priceId: string, expectedInterval: BillingInterval): Promise<StripePriceCadenceResult> {
  let price: Stripe.Price;
  try {
    price = await stripeClient.prices.retrieve(priceId);
  } catch {
    return { ok: false, reason: "lookup_failed" };
  }
  if (!price.active) {
    return { ok: false, reason: "price_inactive" };
  }
  const recurring = price.recurring;
  if (!recurring) {
    return { ok: false, reason: "not_recurring" };
  }
  if (recurring.interval !== expectedInterval || recurring.interval_count !== 1) {
    return { ok: false, reason: "interval_mismatch", actualInterval: recurring.interval, actualIntervalCount: recurring.interval_count };
  }
  return { ok: true, interval: expectedInterval };
}
