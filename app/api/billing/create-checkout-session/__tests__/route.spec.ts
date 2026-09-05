/**
 * Phase BILLING-ANNUAL-C1 — `POST /api/billing/create-checkout-session`.
 * Proves the server-side billing contract end to end with Stripe mocked:
 * the client can only choose {planId, interval}; the Price is resolved from
 * configuration; the Price's REAL recurring interval must match the selected
 * cadence or NO Stripe write happens (no customer, no session, no upgrade).
 */

process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
process.env.STRIPE_3_MODELS_ANNUAL = "price_lite_y";
process.env.STRIPE_PRICE_5_MODELS = "price_full_m";
process.env.STRIPE_5_MODELS_ANNUAL = "price_full_y";

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/posthog-server", () => ({ getPostHogClient: () => ({ capture: jest.fn(), flush: jest.fn(async () => undefined) }) }));
jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

/** Stripe-side "truth" the mocked client returns for prices.retrieve — the test controls whether it matches the sold cadence. */
let priceCatalog: Record<string, { active: boolean; recurring: { interval: string; interval_count: number } | null }>;
let userDoc: Record<string, unknown>;
/** The customer's live Stripe subscriptions, as `subscriptions.list` would return them. */
let liveSubscriptions: Array<Record<string, unknown>>;
const stripeMock = {
  prices: { retrieve: jest.fn(async (id: string) => { const p = priceCatalog[id]; if (!p) throw new Error("No such price"); return { id, ...p }; }) },
  customers: { create: jest.fn(async () => ({ id: "cus_new" })), retrieve: jest.fn(async () => ({ id: "cus_1", deleted: false, metadata: { firebaseUid: "uid-1", email: "u@example.com" } })), update: jest.fn() },
  // Phase C8.1: the route no longer trusts Firestore's `stripeSubscriptionId`.
  // It enumerates the customer's live Stripe set, so the mock must offer
  // `list` exactly as the real client does. `liveSubscriptions` is the
  // fixture each test populates.
  subscriptions: {
    retrieve: jest.fn(),
    list: jest.fn(async () => ({ data: liveSubscriptions, has_more: false })),
    update: jest.fn(async () => ({ id: "sub_1", status: "active", items: { data: [{ price: { id: "price_full_y" } }] } })),
  },
  checkout: { sessions: { create: jest.fn(async () => ({ id: "cs_1", url: "https://checkout.example/cs_1" })) } },
};
jest.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ data: () => userDoc }), update: jest.fn(async () => undefined) }) }) },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/billing/create-checkout-session/route";

async function call(body: unknown) {
  const req = new NextRequest("http://localhost/api/billing/create-checkout-session", { method: "POST", body: JSON.stringify(body) });
  const res = await POST(req);
  return { status: res.status, json: await res.json() };
}
function noStripeWrites() {
  expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  expect(stripeMock.customers.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  liveSubscriptions = [];
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: "uid-1", source: "session_cookie" });
  userDoc = { email: "u@example.com", stripeCustomerId: "cus_1" };
  priceCatalog = {
    price_lite_m: { active: true, recurring: { interval: "month", interval_count: 1 } },
    price_lite_y: { active: true, recurring: { interval: "year", interval_count: 1 } },
    price_full_m: { active: true, recurring: { interval: "month", interval_count: 1 } },
    price_full_y: { active: true, recurring: { interval: "year", interval_count: 1 } },
  };
});

describe("plan/cadence → approved Price (matrix)", () => {
  it.each([
    ["lite", "month", "price_lite_m"],
    ["lite", "year", "price_lite_y"],
    ["full", "month", "price_full_m"],
    ["full", "year", "price_full_y"],
  ])("%s / %s creates a subscription checkout session for exactly %s", async (planId, interval, expected) => {
    const { status, json } = await call({ planId, interval });
    expect(status).toBe(200);
    expect(json.url).toBe("https://checkout.example/cs_1");
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const args = stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(args.mode).toBe("subscription");
    expect(args.line_items).toEqual([{ price: expected, quantity: 1 }]);
    expect(stripeMock.prices.retrieve).toHaveBeenCalledWith(expected);
  });
});

describe("server-side authority over the Price", () => {
  it("an arbitrary client-supplied priceId / amount / currency is ignored — the configured Price is still used", async () => {
    const { status } = await call({ planId: "full", interval: "year", priceId: "price_attacker", amount: 1, currency: "usd" });
    expect(status).toBe(200);
    expect(stripeMock.checkout.sessions.create.mock.calls[0][0].line_items).toEqual([{ price: "price_full_y", quantity: 1 }]);
    expect(stripeMock.prices.retrieve).not.toHaveBeenCalledWith("price_attacker");
  });

  it.each([
    [{ planId: "enterprise", interval: "year" }],
    [{ planId: "full", interval: "yearly" }],
    [{ planId: "full" }],
    [{ interval: "year" }],
    [{ planId: "free", interval: "month" }],
  ])("invalid plan/interval %j is rejected with 400 and no Stripe call", async (body) => {
    const { status } = await call(body);
    expect(status).toBe(400);
    noStripeWrites();
    expect(stripeMock.prices.retrieve).not.toHaveBeenCalled();
  });

  it("unauthenticated -> 401, no Stripe call", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { status } = await call({ planId: "full", interval: "year" });
    expect(status).toBe(401);
    noStripeWrites();
  });
});

describe("REGRESSION — $1,631.90 / year must never create a monthly subscription", () => {
  it("Full annual whose configured Price recurs MONTHLY is refused with a safe 500 and ZERO Stripe writes (no customer, no session, no upgrade)", async () => {
    priceCatalog.price_full_y = { active: true, recurring: { interval: "month", interval_count: 1 } }; // the incident configuration
    const { status, json } = await call({ planId: "full", interval: "year" });
    expect(status).toBe(500);
    expect(json.error).toBe("Billing configuration error. This plan cannot be purchased right now. Please contact support.");
    expect(json.error).not.toMatch(/price_/);
    noStripeWrites();
  });

  it("the guard also protects the in-place UPGRADE path (lite -> full annual) — no subscriptions.update on a cadence mismatch", async () => {
    userDoc = { email: "u@example.com", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" };
    liveSubscriptions = [{ id: "sub_1", customer: "cus_1", status: "active", metadata: {}, items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_lite_m", recurring: { interval: "month", interval_count: 1 } } }] } }];
    priceCatalog.price_full_y = { active: true, recurring: { interval: "month", interval_count: 1 } };
    const { status } = await call({ planId: "full", interval: "year" });
    expect(status).toBe(500);
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("with a correctly yearly Price, the lite -> full annual upgrade updates the existing subscription item to the annual Price", async () => {
    userDoc = { email: "u@example.com", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" };
    liveSubscriptions = [{ id: "sub_1", customer: "cus_1", status: "active", metadata: {}, items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_lite_m", recurring: { interval: "month", interval_count: 1 } } }] } }];
    const { status, json } = await call({ planId: "full", interval: "year" });
    expect(status).toBe(200);
    expect(json.upgraded).toBe(true);
    expect(stripeMock.subscriptions.update.mock.calls[0][1].items).toEqual([{ id: "si_1", price: "price_full_y" }]);
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("monthly plan whose Price recurs YEARLY is refused too (inverse mismatch)", async () => {
    priceCatalog.price_full_m = { active: true, recurring: { interval: "year", interval_count: 1 } };
    const { status } = await call({ planId: "full", interval: "month" });
    expect(status).toBe(500);
    noStripeWrites();
  });

  it("an inactive or unknown configured Price is refused before any write", async () => {
    priceCatalog.price_full_y = { active: false, recurring: { interval: "year", interval_count: 1 } };
    expect((await call({ planId: "full", interval: "year" })).status).toBe(500);
    delete priceCatalog.price_lite_y;
    expect((await call({ planId: "lite", interval: "year" })).status).toBe(500);
    noStripeWrites();
  });
});
