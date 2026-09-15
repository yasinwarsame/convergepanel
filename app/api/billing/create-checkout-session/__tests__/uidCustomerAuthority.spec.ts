/**
 * Phase BILLING-INTEGRITY-R5 — UID-SCOPED CUSTOMER AUTHORITY AT CHECKOUT.
 *
 * The R4 audit found that checkout resolved subscription authority inside ONE
 * Stripe customer — the one `users/{uid}.stripeCustomerId` pointed at — and,
 * when that binding was missing, created a fresh customer. A missing or stale
 * binding therefore yielded a second customer and a second plan-bearing
 * subscription for the same authenticated uid, invisible to the
 * customer-scoped C8.1 guard. The internal test population reproduced it
 * three times.
 *
 * These tests pin the wider contract: discovery of EVERY ConvergePanel
 * customer of the authenticated uid always runs, ownership is asserted only by
 * the exact `metadata.firebaseUid` marker, any topology without a
 * deterministic canonical customer fails closed with zero Stripe and zero
 * Firestore mutation, and two simultaneous checkouts for one uid cannot both
 * create billing identities.
 */

process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
process.env.STRIPE_3_MODELS_ANNUAL = "price_lite_y";
process.env.STRIPE_PRICE_5_MODELS = "price_full_m";
process.env.STRIPE_5_MODELS_ANNUAL = "price_full_y";

jest.mock("@/lib/env", () => ({
  STRIPE_PRICE_3_MODELS: "price_lite_m",
  STRIPE_3_MODELS_ANNUAL: "price_lite_y",
  STRIPE_PRICE_5_MODELS: "price_full_m",
  STRIPE_5_MODELS_ANNUAL: "price_full_y",
}));

type Cust = { id: string; metadata: Record<string, string>; deleted?: boolean; email?: string };
type Sub = Record<string, unknown> & { id: string; customer: string; status: string };

const UID = "uid_customer";
const VICTIM = "uid_victim";

let customers: Cust[] = [];
let live: Sub[] = [];
let userDoc: Record<string, unknown> = {};
let searchFails = false;
let searchPageSize = 100;
let searchExtraResults: Cust[] = []; // simulates index results that do NOT carry the exact marker
let createdCounter = 0;
const idempotencyKeys = new Map<string, Cust>();

const customersSearch = jest.fn(async (args: { query: string; limit?: number; page?: string }) => {
  if (searchFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  const uid = /metadata\['firebaseUid'\]:'([^']+)'/.exec(args.query)?.[1];
  const all = [...customers.filter((c) => c.metadata.firebaseUid === uid), ...searchExtraResults];
  const start = args.page ? Number(args.page) : 0;
  const data = all.slice(start, start + searchPageSize);
  const has_more = start + searchPageSize < all.length;
  return { data, has_more, next_page: has_more ? String(start + searchPageSize) : null };
});
const customersRetrieve = jest.fn(async (id: string) => {
  const c = customers.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 });
  return c;
});
const customersCreate = jest.fn(async (params: { email: string; metadata: Record<string, string> }, opts?: { idempotencyKey?: string }) => {
  const key = opts?.idempotencyKey;
  if (key && idempotencyKeys.has(key)) return idempotencyKeys.get(key)!;
  createdCounter += 1;
  const c: Cust = { id: `cus_new_${createdCounter}`, metadata: { ...params.metadata }, email: params.email };
  customers.push(c);
  if (key) idempotencyKeys.set(key, c);
  return c;
});
const customersUpdate = jest.fn(async () => ({}));
const subscriptionsList = jest.fn(async (args: { customer?: string; starting_after?: string; limit?: number }) => {
  const all = live.filter((s) => s.customer === args.customer);
  const limit = args.limit ?? 10;
  let start = 0;
  if (args.starting_after) start = all.findIndex((s) => s.id === args.starting_after) + 1;
  return { data: all.slice(start, start + limit), has_more: start + limit < all.length };
});
const subscriptionsUpdate = jest.fn(async (id: string, body: Record<string, unknown>) => {
  const s = live.find((x) => x.id === id)!;
  const items = body.items as Array<{ id: string; price: string }>;
  const existing = (s.items as { data: Array<Record<string, unknown>> }).data[0];
  (s.items as { data: Array<Record<string, unknown>> }).data = [{ ...existing, id: items[0].id, price: { id: items[0].price, recurring: { interval: items[0].price.endsWith("_y") ? "year" : "month", interval_count: 1 } } }];
  return s;
});
type Sess = { id: string; customer: string; mode: string; status: "open" | "complete" | "expired"; metadata: Record<string, string>; expires_at: number; url: string | null; created: number };
let sessions: Sess[] = [];
let sessionsListFails = false;
let sessionsPageSize = 100;
let sessionsCursorStuck = false;
let sessionsListHold: (() => void) | null = null; // when set, the next list call waits until released (lease-expiry test)
let sessionCounter = 0;
const sessionIdempotencyKeys = new Map<string, Sess>();
const sessionsCreate = jest.fn(async (params: { customer: string; mode: string; metadata: Record<string, string> }, opts?: { idempotencyKey?: string }) => {
  const key = opts?.idempotencyKey;
  if (key && sessionIdempotencyKeys.has(key)) return sessionIdempotencyKeys.get(key)!;
  sessionCounter += 1;
  const sess: Sess = { id: `cs_${sessionCounter}`, customer: params.customer, mode: params.mode, status: "open", metadata: { ...params.metadata }, expires_at: Math.floor(Date.now() / 1000) + 86_400, url: `https://checkout.stripe.test/cs_${sessionCounter}`, created: sessionCounter };
  sessions.push(sess);
  if (key) sessionIdempotencyKeys.set(key, sess);
  return sess;
});
const sessionsList = jest.fn(async (args: { customer?: string; status?: string; starting_after?: string; limit?: number }) => {
  if (sessionsListFails) throw Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
  // The snapshot is taken at CALL time (as Stripe would answer), then the
  // response may be held back to model a slow round trip.
  const all = sessions.filter((x) => x.customer === args.customer && (!args.status || x.status === args.status));
  let start = 0;
  if (args.starting_after) start = all.findIndex((x) => x.id === args.starting_after) + 1;
  const response = sessionsCursorStuck ? { data: all.slice(0, 1), has_more: true } : { data: all.slice(start, start + sessionsPageSize), has_more: start + sessionsPageSize < all.length };
  if (sessionsListHold) { await new Promise<void>((resolve) => { const prev = sessionsListHold!; sessionsListHold = () => { prev(); resolve(); }; }); }
  return response;
});
const pricesRetrieve = jest.fn(async (id: string) => ({ id, active: true, recurring: { interval: id.endsWith("_y") ? "year" : "month", interval_count: 1 } }));

jest.mock("@/lib/stripe/client", () => ({
  stripe: {
    customers: {
      search: (...a: unknown[]) => customersSearch(...(a as [{ query: string }])),
      retrieve: (...a: unknown[]) => customersRetrieve(...(a as [string])),
      create: (...a: unknown[]) => customersCreate(...(a as [{ email: string; metadata: Record<string, string> }, { idempotencyKey?: string }?])),
      update: (...a: unknown[]) => customersUpdate(...(a as [])),
    },
    prices: { retrieve: (...a: unknown[]) => pricesRetrieve(...(a as [string])) },
    subscriptions: { list: (...a: unknown[]) => subscriptionsList(...(a as [{ customer?: string }])), update: (...a: unknown[]) => subscriptionsUpdate(...(a as [string, Record<string, unknown>])) },
    checkout: { sessions: { create: (...a: unknown[]) => sessionsCreate(...(a as [{ customer: string; mode: string; metadata: Record<string, string> }, { idempotencyKey?: string }?])), list: (...a: unknown[]) => sessionsList(...(a as [{ customer?: string }])) } },
  },
}));

// In-memory Firestore double: `users/{uid}` is backed by `userDoc`; every other
// collection (the checkout lease) lives in `mockStore`. Transactions are
// serialized, which is how Firestore contention resolves two racing writers.
const mockStore: Record<string, Record<string, unknown>> = {};
let mockTxQueue: Promise<unknown> = Promise.resolve();
jest.mock("@/lib/firebase/admin", () => {
  type Doc = Record<string, unknown>;
  const docRef = (col: string, id: string) => ({
    path: `${col}/${id}`,
    get: async () => (col === "users" ? { exists: true, data: () => userDoc } : { exists: mockStore[`${col}/${id}`] !== undefined, data: () => mockStore[`${col}/${id}`] }),
    update: async (d: Doc) => { if (col === "users") userDoc = { ...userDoc, ...d }; else mockStore[`${col}/${id}`] = { ...(mockStore[`${col}/${id}`] ?? {}), ...d }; },
    set: async (d: Doc) => { if (col === "users") userDoc = { ...userDoc, ...d }; else mockStore[`${col}/${id}`] = { ...d }; },
  });
  type Ref = ReturnType<typeof docRef>;
  const tx = { get: async (r: Ref) => r.get(), set: (r: Ref, d: Doc) => { void r.set(d); }, update: (r: Ref, d: Doc) => { void r.update(d); }, delete: (r: Ref) => { delete mockStore[r.path]; } };
  return {
    adminDb: {
      collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
      runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => { const run = mockTxQueue.then(() => fn(tx)); mockTxQueue = run.catch(() => undefined); return run; },
    },
  };
});
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: async () => ({ status: "authenticated", uid: "uid_customer", source: "bearer" }),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/posthog-server", () => ({ getPostHogClient: () => ({ capture: jest.fn(), flush: jest.fn(async () => undefined) }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type { NextRequest } from "next/server";
import { POST } from "../route";
import { CHECKOUT_LEASE_COLLECTION, CHECKOUT_LEASE_TTL_MS } from "@/lib/billing/checkoutIdentityLease";

const A = "cus_A";
const B = "cus_B";
const AUG_2_2026 = Math.floor(Date.UTC(2026, 7, 2) / 1000);
const AUG_2_2027 = Math.floor(Date.UTC(2027, 7, 2) / 1000);

const cust = (id: string, uid = UID, extra: Partial<Cust> = {}): Cust => ({ id, metadata: { firebaseUid: uid }, email: "c@example.test", ...extra });
function sub(args: { id: string; customer: string; priceId?: string; status?: string }): Sub {
  const priceId = args.priceId ?? "price_lite_m";
  return {
    id: args.id, customer: args.customer, status: args.status ?? "active", created: 1, metadata: { firebaseUid: UID },
    current_period_start: AUG_2_2026, current_period_end: AUG_2_2027,
    items: { data: [{ id: "si_" + args.id, quantity: 1, price: { id: priceId, recurring: { interval: priceId.endsWith("_y") ? "year" : "month", interval_count: 1 } }, current_period_start: AUG_2_2026, current_period_end: AUG_2_2027 }] },
  } as unknown as Sub;
}
async function purchase(body: Record<string, unknown> = { planId: "full", interval: "month" }) {
  const req = { json: async () => body, nextUrl: { origin: "https://app.test" }, headers: { get: () => null } } as unknown as NextRequest;
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}
/** "No mutation" means exactly that: no create, no update, no session, no binding change. */
function assertZeroMutation(bindingBefore: unknown) {
  expect(customersCreate).not.toHaveBeenCalled();
  expect(customersUpdate).not.toHaveBeenCalled();
  expect(subscriptionsUpdate).not.toHaveBeenCalled();
  expect(sessionsCreate).not.toHaveBeenCalled();
  expect(userDoc.stripeCustomerId).toEqual(bindingBefore);
}
const leaseDocs = () => Object.keys(mockStore).filter((k) => k.startsWith(CHECKOUT_LEASE_COLLECTION + "/"));

beforeEach(() => {
  customers = []; live = []; searchFails = false; searchPageSize = 100; searchExtraResults = []; createdCounter = 0; idempotencyKeys.clear();
  sessions = []; sessionsListFails = false; sessionsPageSize = 100; sessionsCursorStuck = false; sessionsListHold = null; sessionCounter = 0; sessionIdempotencyKeys.clear(); sessionsList.mockClear();
  jest.restoreAllMocks();
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  customersSearch.mockClear(); customersRetrieve.mockClear(); customersCreate.mockClear(); customersUpdate.mockClear();
  subscriptionsList.mockClear(); subscriptionsUpdate.mockClear(); sessionsCreate.mockClear();
  userDoc = { email: "c@example.test" }; // NO binding by default — the historical defect's precondition
});

describe("R5 — missing binding", () => {
  it("1. no binding + no Stripe customer for the uid → exactly ONE customer is created, bound, and one session opened", async () => {
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(customersCreate.mock.calls[0][1]?.idempotencyKey).toContain(UID);
    expect(customersCreate.mock.calls[0][0].metadata.firebaseUid).toBe(UID);
    expect(userDoc.stripeCustomerId).toBe("cus_new_1");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect((sessionsCreate.mock.calls[0] as unknown as [{ customer: string }])[0].customer).toBe("cus_new_1");
  });

  it("2. no binding + one matching customer with no plan-bearing subscription → that customer is REUSED, none created", async () => {
    customers = [cust(A)];
    live = [sub({ id: "s_old", customer: A, status: "canceled" })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(customersCreate).not.toHaveBeenCalled();
    expect(userDoc.stripeCustomerId).toBe(A);
    expect((sessionsCreate.mock.calls[0] as unknown as [{ customer: string }])[0].customer).toBe(A);
  });

  it("3. REGRESSION: no binding + matching customer with an ACTIVE subscription → no second customer, no second subscription (in-place path)", async () => {
    customers = [cust(A)];
    live = [sub({ id: "s_lite", customer: A, priceId: "price_lite_m" })];
    const r = await purchase({ planId: "full", interval: "month" });
    expect(r.status).toBe(200);
    expect(r.body.upgraded).toBe(true);
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(userDoc.stripeCustomerId).toBe(A);
    expect(live.filter((s) => ["active", "trialing", "past_due"].includes(s.status))).toHaveLength(1);
  });
});

describe("R5 — stale binding (the C3 shape)", () => {
  it("4. REGRESSION: stored EMPTY customer A + matching customer B with an active subscription → fail closed, zero mutation, Firestore not rewritten", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A), cust(B)];
    live = [sub({ id: "s_active_B", customer: B })];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("customer_authority_conflict");
    assertZeroMutation(A);
  });

  it("discovery ALWAYS runs even with a stored binding — skipping it is the defect", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A)];
    await purchase();
    expect(customersSearch).toHaveBeenCalledTimes(1);
    expect(customersSearch.mock.calls[0][0].query).toContain(`'${UID}'`);
  });
});

describe("R5 — cross-customer authority", () => {
  it("5. REGRESSION: two matching customers EACH with an active subscription → fail closed, zero mutation", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A), cust(B)];
    live = [sub({ id: "s_A", customer: A }), sub({ id: "s_B", customer: B })];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("cross_customer_entitlement_subscriptions");
    assertZeroMutation(A);
  });

  it("6. REGRESSION: active on one customer + past_due on another is STILL ambiguous — past_due is plan-bearing across customers too", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A), cust(B)];
    live = [sub({ id: "s_A", customer: A }), sub({ id: "s_B", customer: B, status: "past_due" })];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("cross_customer_entitlement_subscriptions");
    assertZeroMutation(A);
  });

  it("7. no binding + several matching customers with NO plan-bearing subscription → no arbitrary first-match, fail closed", async () => {
    customers = [cust(A), cust(B)];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ambiguous_billing_identity");
    assertZeroMutation(undefined);
  });

  it("7b. the stored binding is the one deterministic canonical rule: stored A + a stray EMPTY customer B proceeds on A, never on B", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A), cust(B)];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(customersCreate).not.toHaveBeenCalled();
    expect((sessionsCreate.mock.calls[0] as unknown as [{ customer: string }])[0].customer).toBe(A);
    expect(userDoc.stripeCustomerId).toBe(A);
  });
});

describe("R5 — stored-customer identity validation", () => {
  it("8. REGRESSION: a stored customer whose uid marker belongs to ANOTHER uid → fail closed, zero mutation, marker never rewritten", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A, VICTIM)];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("billing_identity_mismatch");
    assertZeroMutation(A);
    expect(customers.find((c) => c.id === A)!.metadata.firebaseUid).toBe(VICTIM);
  });

  it("a stored customer that no longer exists in Stripe → fail closed, no replacement customer is created", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: "cus_gone" };
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("stored_customer_missing");
    assertZeroMutation("cus_gone");
  });

  it("R5-C1 REGRESSION: a stored customer with NO uid marker is never auto-claimed — fail closed, zero mutation, no marker written", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [{ id: A, metadata: {}, email: "c@example.test" }];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("billing_identity_unestablished");
    assertZeroMutation(A);
    expect(customers.find((c) => c.id === A)!.metadata.firebaseUid).toBeUndefined();
  });

  it("an unmarked customer surfaced by discovery for some other reason is likewise never claimed", async () => {
    searchExtraResults = [{ id: "cus_unmarked_shared", metadata: {} }];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(customersUpdate).not.toHaveBeenCalled();
    expect(userDoc.stripeCustomerId).toBe("cus_new_1");
  });
});

describe("R5 — discovery must fail closed", () => {
  it("9. REGRESSION: a Stripe discovery error refuses checkout — it is NEVER a reason to create a customer", async () => {
    searchFails = true;
    const r = await purchase();
    expect(r.status).toBe(503);
    assertZeroMutation(undefined);
  });

  it("10. REGRESSION: paginated discovery considers EVERY page — a plan-bearing customer on page two is not missed", async () => {
    searchPageSize = 1;
    customers = [cust(A), cust(B)];
    live = [sub({ id: "s_B", customer: B })];
    const r = await purchase();
    expect(customersSearch).toHaveBeenCalledTimes(2);
    expect(customersSearch.mock.calls[1][0].page).toBe("1");
    expect(r.status).toBe(409); // no binding, B is plan-bearing, A is a second customer → conflict, not a fresh session
    expect(r.body.code).toBe("customer_authority_conflict");
    assertZeroMutation(undefined);
  });

  it("11. REGRESSION: customers of OTHER applications (no exact `firebaseUid` marker) are ignored, never reused, never mutated", async () => {
    searchExtraResults = [
      { id: "cus_other_app_1", metadata: { firebase_uid: UID } },
      { id: "cus_other_app_2", metadata: { id: UID, tenant_id: "b4dd" } },
      { id: "cus_deleted", metadata: { firebaseUid: UID }, deleted: true },
    ];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(userDoc.stripeCustomerId).toBe("cus_new_1");
    expect(customersUpdate).not.toHaveBeenCalled();
  });

  it("12. REGRESSION: a client-supplied uid cannot steer discovery or reuse another user's customer", async () => {
    customers = [cust("cus_victim", VICTIM)];
    live = [sub({ id: "s_victim", customer: "cus_victim" })];
    const r = await purchase({ planId: "full", interval: "month", uid: VICTIM, firebaseUid: VICTIM, customerId: "cus_victim" });
    expect(r.status).toBe(200);
    for (const call of customersSearch.mock.calls) {
      expect(call[0].query).toContain(`'${UID}'`);
      expect(call[0].query).not.toContain(VICTIM);
    }
    expect(subscriptionsUpdate).not.toHaveBeenCalled(); // the victim's subscription is untouched
    expect(userDoc.stripeCustomerId).toBe("cus_new_1"); // a customer for the AUTHENTICATED uid
    expect(customersCreate.mock.calls[0][0].metadata.firebaseUid).toBe(UID);
  });
});

describe("R5 — same-uid concurrency", () => {
  it("13. REGRESSION: two simultaneous checkouts with no binding → at most ONE customer, one binding, one session; the other refuses", async () => {
    const [r1, r2] = await Promise.all([purchase(), purchase()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = r1.status === 409 ? r1 : r2;
    expect(refused.body.code).toBe("checkout_in_progress");
    expect(customersCreate).toHaveBeenCalledTimes(1);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(userDoc.stripeCustomerId).toBe("cus_new_1");
  });

  it("the lease is released on success AND on refusal, so a later checkout is not wedged", async () => {
    await purchase();
    expect(leaseDocs()).toHaveLength(0);
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A, VICTIM)];
    await purchase();
    expect(leaseDocs()).toHaveLength(0);
  });

  it("a retried create for the same uid reuses the per-uid idempotency key", async () => {
    await purchase();
    const key = customersCreate.mock.calls[0][1]?.idempotencyKey;
    expect(key).toBe(`billing-customer-create-${UID}`);
  });
});

describe("R5 — C8.1 same-customer behavior is unchanged", () => {
  it("14. stored customer with one active lite subscription → full is an in-place change, no session, no new customer", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A)];
    live = [sub({ id: "s_lite", customer: A, priceId: "price_lite_m" })];
    const r = await purchase({ planId: "full", interval: "month" });
    expect(r.status).toBe(200);
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(customersCreate).not.toHaveBeenCalled();
  });

  it("same-customer ambiguity is still refused with the C8.1 code", async () => {
    userDoc = { email: "c@example.test", stripeCustomerId: A };
    customers = [cust(A)];
    live = [sub({ id: "s1", customer: A }), sub({ id: "s2", customer: A, priceId: "price_full_y" })];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("multiple_entitlement_subscriptions");
    assertZeroMutation(A);
  });
});

describe("R5-C1 — pending Checkout Session authority (sequential requests)", () => {
  const openSession = (customer: string, uid = UID, extra: Partial<Sess> = {}): Sess => ({ id: `cs_pre_${sessions.length + 1}`, customer, mode: "subscription", status: "open", metadata: { firebaseUid: uid }, expires_at: Math.floor(Date.now() / 1000) + 3600, url: `https://checkout.stripe.test/${customer}_pre`, created: 0, ...extra });

  it("A1 REGRESSION: a second sequential request before the first session is paid does NOT create Session B — it reuses A", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    const r1 = await purchase();
    expect(r1.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const r2 = await purchase({ planId: "lite", interval: "year" }); // a different plan does not justify a second completable session
    expect(r2.status).toBe(200);
    expect(r2.body.pending).toBe(true);
    expect(r2.body.url).toBe(r1.body.url);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(sessions.filter((x) => x.status === "open")).toHaveLength(1);
  });

  it("A2 exactly ONE actionable matching session is reused with no new mutation", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { id: "cs_only", created: 2, url: "https://checkout.stripe.test/only" })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: "https://checkout.stripe.test/only", pending: true });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(customersCreate).not.toHaveBeenCalled();
  });

  it("C2-1 REGRESSION: TWO matching actionable sessions → fail closed, no new session, neither existing session touched", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { id: "cs_x", created: 1 }), openSession(A, UID, { id: "cs_y", created: 2 })];
    const before = JSON.stringify(sessions);
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("multiple_pending_checkout_sessions");
    assertZeroMutation(A);
    expect(JSON.stringify(sessions)).toBe(before);
  });

  it("C2-2 REGRESSION: ONE matching + ONE actionable DIFFERENT-uid session on the canonical customer → identity conflict, the matching one is NOT merely reused", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { id: "cs_mine" }), openSession(A, VICTIM, { id: "cs_theirs" })];
    const before = JSON.stringify(sessions);
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("pending_checkout_identity_conflict");
    assertZeroMutation(A);
    expect(JSON.stringify(sessions)).toBe(before);
  });

  it("C2-3 REGRESSION: ZERO matching + ONE actionable DIFFERENT-uid session on the canonical customer → fail closed, no new session", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, VICTIM)];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("pending_checkout_identity_conflict");
    assertZeroMutation(A);
  });

  it("C2-4/5/6 a different-uid session that is completed, expired, or past its expiry timestamp does not block", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, VICTIM, { status: "complete" }), openSession(A, VICTIM, { status: "expired" }), openSession(A, VICTIM, { expires_at: Math.floor(Date.now() / 1000) - 1 })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(r.body.pending).toBeUndefined();
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("C2-7 an open subscription session with NO uid marker stays unrelated shared-account traffic — ignored, not a conflict", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { metadata: {} }), openSession(A, UID, { metadata: { id: "other-app" } })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("C2-8 a NON-subscription session carrying another uid does not block", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, VICTIM, { mode: "payment" })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("C2-9 an open session on a DIFFERENT customer carrying another uid is not this customer's conflict", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession("cus_someone_else", VICTIM)];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("C2-10 the one matching session without a resumable URL still blocks creation (it can complete) but cannot be reused", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { url: null })];
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("pending_checkout_not_resumable");
    assertZeroMutation(A);
  });

  it("A4 another application's session (no uid marker / not subscription mode) never blocks ConvergePanel", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { metadata: { id: UID } }), openSession(A, UID, { mode: "payment" })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("A5 completed, expired, and already-expired-by-time sessions are not actionable", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, UID, { status: "complete" }), openSession(A, UID, { status: "expired" }), openSession(A, UID, { expires_at: Math.floor(Date.now() / 1000) - 1 })];
    const r = await purchase();
    expect(r.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(sessionsList.mock.calls[0][0]).toMatchObject({ customer: A, status: "open" });
  });

  it("A6 REGRESSION: a pending-session enumeration error refuses checkout and creates nothing", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessionsListFails = true;
    const r = await purchase();
    expect(r.status).toBe(503);
    assertZeroMutation(A);
  });

  it("A7 REGRESSION: a non-advancing cursor is an incomplete enumeration — refuse, do not create", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessions = [openSession(A, VICTIM)];
    sessionsCursorStuck = true;
    const r = await purchase();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("pending_checkout_enumeration_incomplete");
    assertZeroMutation(A);
  });

  it("A8 REGRESSION: multi-page enumeration finds an actionable session on a later page", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    sessionsPageSize = 1;
    sessions = [openSession(A, UID, { id: "cs_p1", created: 1, metadata: {} }), openSession(A, UID, { id: "cs_p2", created: 2, url: "https://checkout.stripe.test/p2" })];
    const r = await purchase();
    expect(sessionsList).toHaveBeenCalledTimes(2);
    expect(r.body).toEqual({ url: "https://checkout.stripe.test/p2", pending: true });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("A9 REGRESSION: sessions.create carries an idempotency key unique to this lease, so an SDK-level retry cannot mint a second session", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    await purchase();
    const key = sessionsCreate.mock.calls[0][1]?.idempotencyKey as string;
    expect(key).toMatch(new RegExp(`^billing-checkout-session-${UID}-`));
    // a replay with the same key returns the same session, never a second one
    const replay = await sessionsCreate(sessionsCreate.mock.calls[0][0], { idempotencyKey: key });
    expect(replay.id).toBe(sessions[0].id);
    expect(sessions).toHaveLength(1);
    // and a user-level retry (new request, new lease) is answered by enumeration, not by a new session
    const r2 = await purchase();
    expect(r2.body.pending).toBe(true);
    expect(sessions).toHaveLength(1);
  });

  it("A10 REGRESSION: if request A outlives its lease and B takes over, A refuses before creating — never two completable sessions", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    const realNow = Date.now;
    let offset = 0;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    // Hold A inside its pending-session enumeration (after it acquired the lease).
    let release: () => void = () => undefined;
    sessionsListHold = () => undefined;
    const pA = purchase();
    await new Promise((r) => setTimeout(r, 20)); // A has acquired the lease and is parked in sessions.list
    release = sessionsListHold!;
    offset = CHECKOUT_LEASE_TTL_MS + 1_000; // A's lease has now expired
    sessionsListHold = null;
    const rB = await purchase(); // B acquires a fresh lease and creates the one session
    expect(rB.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    release(); // A resumes
    const rA = await pA;
    expect(rA.status).toBe(409);
    expect(rA.body.code).toBe("checkout_in_progress");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(sessions.filter((x) => x.status === "open")).toHaveLength(1);
  });

  it("A11 simultaneous requests remain protected by the lease (one session, one refusal)", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    const [r1, r2] = await Promise.all([purchase(), purchase()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("the in-place plan change also re-verifies the lease before mutating", async () => {
    customers = [cust(A)]; userDoc = { email: "c@example.test", stripeCustomerId: A };
    live = [sub({ id: "s_lite", customer: A, priceId: "price_lite_m" })];
    const r = await purchase({ planId: "full", interval: "month" });
    expect(r.status).toBe(200);
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(leaseDocs()).toHaveLength(0);
  });
});
