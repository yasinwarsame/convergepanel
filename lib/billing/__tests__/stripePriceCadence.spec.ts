/**
 * Phase BILLING-ANNUAL-C1 — `verifyStripePriceCadence()` tests. Regression
 * anchor: "$1,631.90 / year must never create a subscription on a Price that
 * recurs monthly."
 */

import { verifyStripePriceCadence } from "@/lib/billing/stripePriceCadence";

function client(price: unknown, shouldThrow = false) {
  return { prices: { retrieve: jest.fn(async () => { if (shouldThrow) throw new Error("no such price"); return price; }) } } as any;
}
const price = (overrides: Record<string, unknown> = {}) => ({ id: "price_x", active: true, unit_amount: 163190, currency: "usd", recurring: { interval: "year", interval_count: 1 }, ...overrides });

it("accepts a yearly Price for a year request and a monthly Price for a month request", async () => {
  expect(await verifyStripePriceCadence(client(price()), "price_x", "year")).toEqual({ ok: true, interval: "year" });
  expect(await verifyStripePriceCadence(client(price({ recurring: { interval: "month", interval_count: 1 } })), "price_x", "month")).toEqual({ ok: true, interval: "month" });
});

it("REGRESSION: a $1,631.90 Price that recurs MONTHLY is refused for a year request (the incident)", async () => {
  const r = await verifyStripePriceCadence(client(price({ recurring: { interval: "month", interval_count: 1 } })), "price_x", "year");
  expect(r).toEqual({ ok: false, reason: "interval_mismatch", actualInterval: "month", actualIntervalCount: 1 });
});

it("a yearly Price is refused for a month request (inverse mismatch)", async () => {
  const r = await verifyStripePriceCadence(client(price()), "price_x", "month");
  expect(r).toMatchObject({ ok: false, reason: "interval_mismatch", actualInterval: "year" });
});

it("interval_count other than 1 is refused even when the interval unit matches (e.g. every 12 months is not 'year')", async () => {
  const r = await verifyStripePriceCadence(client(price({ recurring: { interval: "month", interval_count: 12 } })), "price_x", "month");
  expect(r).toMatchObject({ ok: false, reason: "interval_mismatch", actualIntervalCount: 12 });
});

it("an inactive Price is refused", async () => {
  expect(await verifyStripePriceCadence(client(price({ active: false })), "price_x", "year")).toEqual({ ok: false, reason: "price_inactive" });
});

it("a one-time (non-recurring) Price is refused", async () => {
  expect(await verifyStripePriceCadence(client(price({ recurring: null })), "price_x", "year")).toEqual({ ok: false, reason: "not_recurring" });
});

it("a lookup failure fails closed and never throws", async () => {
  expect(await verifyStripePriceCadence(client(null, true), "price_x", "year")).toEqual({ ok: false, reason: "lookup_failed" });
});

it("retrieves exactly the Price ID it was given — read-only, one call", async () => {
  const c = client(price());
  await verifyStripePriceCadence(c, "price_exact", "year");
  expect(c.prices.retrieve).toHaveBeenCalledTimes(1);
  expect(c.prices.retrieve).toHaveBeenCalledWith("price_exact");
});
