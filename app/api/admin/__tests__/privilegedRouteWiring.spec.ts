/**
 * SEC-3 / S2-b — EVERY PRIVILEGED HANDLER, THROUGH THE REAL GUARD.
 *
 * Each case imports the REAL route module and calls the exported handler with a
 * NextRequest. The only doubles are at the Firebase Admin SDK boundary (Auth +
 * an in-memory Firestore that records every call; see privilegedRouteHarness)
 * and at the external Stripe client. Two in-repo modules are also replaced,
 * because they are the protected effect itself rather than an authority input:
 * the durable research-deletion workflow (`deleteResearchRun`, exercised by its
 * own suite) and the Stripe webhook handler (`handleSubscriptionChange`).
 *
 * For every handler the suite proves:
 *   - no credential → 401, ordinary user → 403, and each wrong tier → 403;
 *   - the correct tier passes the guard AND the handler's protected effect then
 *     happens (so every "zero effects on denial" assertion is falsifiable);
 *   - on every refusal NOTHING protected was touched: no Firestore call at all
 *     (not even a read), no Stripe call, no Auth mutation, and no Auth lookup of
 *     anyone but the presenting principal.
 * plus the shared matrix (disabled / de-claimed / revoked / deleted accounts,
 * outages → 503, malformed and conflicting credentials, repeated attempts,
 * audit attribution to the guard's actor).
 */

process.env.STRIPE_PRICE_3_MODELS = "price_lite_m";
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), STRIPE_PRICE_3_MODELS: "price_lite_m" }));
jest.mock("@/lib/firebase/admin", () => require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble());

const mockStripe = {
  subscriptions: {
    retrieve: jest.fn(),
    list: jest.fn(),
    cancel: jest.fn(),
    update: jest.fn(),
  },
};
jest.mock("@/lib/stripe/client", () => ({ stripe: mockStripe }));

const mockHandleSubscriptionChange = jest.fn(async (_s: unknown) => undefined);
jest.mock("@/app/api/stripe/webhook/route", () => ({ handleSubscriptionChange: (s: unknown) => mockHandleSubscriptionChange(s) }));

const mockDeleteResearchRun = jest.fn(async (a: { runId: string; actorUid: string }) => ({ status: "deleted", runId: a.runId, attempts: 1 }));
jest.mock("@/lib/firestore/researchDeletion", () => ({
  ...jest.requireActual("@/lib/firestore/researchDeletion"),
  deleteResearchRun: (a: { runId: string; actorUid: string }) => mockDeleteResearchRun(a),
  listUnfinishedResearchDeletions: async () => [],
}));

import {
  AUTH_TIME,
  EMAILS,
  UIDS,
  authCalls,
  authState,
  dbLog,
  dbStore,
  dbWrites,
  installPrivilegedHarness,
  mintCredential,
  routeRequest,
  signInAs,
  type Credentials,
  type Persona,
} from "@/lib/admin/__tests__/privilegedRouteHarness";

import * as ACCESS from "@/app/api/admin/access/route";
import * as KEYS from "@/app/api/admin/keys/route";
import * as PURGE from "@/app/api/admin/purge-runs/route";
import * as RUNS from "@/app/api/admin/runs/route";
import * as RUN from "@/app/api/admin/runs/[runId]/route";
import * as SET_ROLE from "@/app/api/admin/set-role/route";
import * as SYNC_SUB from "@/app/api/admin/sync-subscription/route";
import * as TEST_WEBHOOK from "@/app/api/admin/test-webhook/route";
import * as USERS from "@/app/api/admin/users/route";
import * as USERS_SEARCH from "@/app/api/admin/users/search/route";
import * as USER from "@/app/api/admin/users/[uid]/route";
import * as USER_DETAILS from "@/app/api/admin/users/[uid]/details/route";
import * as USER_OVERRIDE from "@/app/api/admin/users/[uid]/override/route";
import * as STRIPE_CANCEL from "@/app/api/admin/users/[uid]/stripe/cancel/route";
import * as STRIPE_REACTIVATE from "@/app/api/admin/users/[uid]/stripe/reactivate/route";
import * as STRIPE_SYNC from "@/app/api/admin/users/[uid]/stripe/sync/route";
import * as GOV_BACKFILL from "@/app/api/governance/audit/backfill/route";
import * as GOV_POLICY from "@/app/api/governance/policy/route";
import type { PrivilegedTier } from "@/lib/admin/privilegedAccess";

installPrivilegedHarness();

const TARGET = "uid-target-user";
const SPOOF = "uid-spoofed-by-the-body";

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: "sub_x",
    object: "subscription",
    status: "active",
    customer: "cus_x",
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86_400,
    metadata: {},
    items: { data: [{ price: { id: "price_lite_m", recurring: { interval: "month" } }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] },
    ...over,
  };
}

type Handler = (req: unknown, ctx?: unknown) => Promise<Response>;
type Case = {
  name: string;
  tier: PrivilegedTier;
  /** Seeds whatever the SUCCESS path needs; never consulted by the guard. */
  seed?: () => void;
  call: (creds: Credentials) => Promise<Response>;
  /** Proves the protected effect happened (on success) — the falsifier for every denial assertion. */
  effect: () => boolean;
  /** Expected success status. */
  okStatus?: number;
};

const h = (mod: Record<string, unknown>, m: string) => mod[m] as Handler;
const wrote = (op: string, pathPrefix: string) => dbWrites().some((e) => e.op === op && e.path.startsWith(pathPrefix));
const read = (pathPrefix: string) => dbLog.some((e) => (e.op === "get" || e.op === "query.get") && e.path.startsWith(pathPrefix));
const seedDoc = (path: string, data: Record<string, unknown>) => void dbStore.set(path, data);
const runCtx = { params: { runId: "v-1" } };
const userCtx = { params: { uid: TARGET } };

const CASES: Case[] = [
  {
    name: "GET /api/admin/access",
    tier: "ADMIN_PORTAL",
    call: (c) => h(ACCESS, "GET")(routeRequest("/api/admin/access", { creds: c })),
    effect: () => true, // a read-only probe: the effect is the grant body, asserted below
  },
  {
    name: "GET /api/admin/keys",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc("appConfig/modelKeys", { chatgpt: "sk-test-invented-1234567890" }),
    call: (c) => h(KEYS, "GET")(routeRequest("/api/admin/keys", { creds: c })),
    effect: () => read("appConfig/modelKeys"),
  },
  {
    name: "POST /api/admin/keys",
    tier: "SYSTEM_ADMIN",
    call: (c) => h(KEYS, "POST")(routeRequest("/api/admin/keys", { method: "POST", body: { chatgpt: "sk-test-invented-abcdefghij" }, creds: c })),
    effect: () => wrote("set", "appConfig/modelKeys"),
  },
  {
    name: "POST /api/admin/purge-runs",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc("runs/old-1", { createdAt: "old", status: "complete" }),
    call: (c) => h(PURGE, "POST")(routeRequest("/api/admin/purge-runs", { method: "POST", body: { mode: "olderThan", days: 30, dryRun: false }, creds: c })),
    effect: () => mockDeleteResearchRun.mock.calls.length > 0,
  },
  {
    name: "GET /api/admin/runs",
    tier: "ADMIN_PORTAL",
    seed: () => seedDoc("verifications/v-1", { userId: "owner", claim: "c" }),
    call: (c) => h(RUNS, "GET")(routeRequest("/api/admin/runs", { creds: c })),
    effect: () => read("runs") || read("verifications"),
  },
  {
    name: "GET /api/admin/runs/[runId]",
    tier: "ADMIN_PORTAL",
    seed: () => seedDoc("verifications/v-1", { userId: "owner", claim: "c" }),
    call: (c) => h(RUN, "GET")(routeRequest("/api/admin/runs/v-1?collection=verifications", { creds: c }), runCtx),
    effect: () => read("verifications/v-1"),
  },
  {
    name: "PATCH /api/admin/runs/[runId]",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc("verifications/v-1", { userId: "owner", claim: "c", governanceStatus: "approved" }),
    call: (c) =>
      h(RUN, "PATCH")(
        routeRequest("/api/admin/runs/v-1", { method: "PATCH", body: { action: "set_governance_status", collection: "verifications", status: "blocked", byUid: SPOOF }, creds: c }),
        runCtx
      ),
    effect: () => wrote("set", "verifications/v-1") && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "DELETE /api/admin/runs/[runId]",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc("verifications/v-1", { userId: "owner", claim: "c" }),
    call: (c) => h(RUN, "DELETE")(routeRequest("/api/admin/runs/v-1?collection=verifications", { method: "DELETE", body: { confirm: true }, creds: c }), runCtx),
    effect: () => wrote("delete", "verifications/v-1") && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "POST /api/admin/set-role",
    tier: "SYSTEM_ADMIN",
    seed: () => void authState.records.set(TARGET, { uid: TARGET, email: EMAILS.outsider, emailVerified: true, disabled: false, customClaims: {} }),
    call: (c) => h(SET_ROLE, "POST")(routeRequest("/api/admin/set-role", { method: "POST", body: { uid: TARGET, role: "admin" }, creds: c })),
    effect: () => authCalls.setCustomUserClaims.mock.calls.length > 0 && wrote("set", `users/${TARGET}`),
  },
  {
    name: "POST /api/admin/sync-subscription",
    tier: "SYSTEM_ADMIN",
    seed: () => {
      seedDoc(`users/${TARGET}`, { stripeCustomerId: "cus_x" });
      mockStripe.subscriptions.retrieve.mockResolvedValue(subscription());
    },
    call: (c) => h(SYNC_SUB, "POST")(routeRequest("/api/admin/sync-subscription", { method: "POST", body: { subscriptionId: "sub_x" }, creds: c })),
    effect: () => wrote("set", `users/${TARGET}`),
  },
  {
    name: "POST /api/admin/test-webhook",
    tier: "SYSTEM_ADMIN",
    seed: () => void mockStripe.subscriptions.retrieve.mockResolvedValue(subscription()),
    call: (c) => h(TEST_WEBHOOK, "POST")(routeRequest("/api/admin/test-webhook", { method: "POST", body: { subscriptionId: "sub_x" }, creds: c })),
    effect: () => mockHandleSubscriptionChange.mock.calls.length > 0,
  },
  {
    name: "GET /api/admin/users",
    tier: "ADMIN_PORTAL",
    seed: () => seedDoc(`users/${TARGET}`, { email: "someone@test-invented.example" }),
    call: (c) => h(USERS, "GET")(routeRequest("/api/admin/users", { creds: c })),
    effect: () => read("users"),
  },
  {
    name: "GET /api/admin/users/search",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc(`users/${TARGET}`, { email: "someone@test-invented.example" }),
    call: (c) => h(USERS_SEARCH, "GET")(routeRequest(`/api/admin/users/search?uid=${TARGET}`, { creds: c })),
    effect: () => read(`users/${TARGET}`),
  },
  {
    name: "PATCH /api/admin/users/[uid]",
    tier: "SYSTEM_ADMIN",
    call: (c) => h(USER, "PATCH")(routeRequest(`/api/admin/users/${TARGET}`, { method: "PATCH", body: { isDisabled: false }, creds: c }), userCtx),
    effect: () => authCalls.updateUser.mock.calls.length > 0 && wrote("set", `users/${TARGET}`),
  },
  {
    name: "DELETE /api/admin/users/[uid]",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc(`users/${TARGET}`, { email: "someone@test-invented.example" }),
    call: (c) => h(USER, "DELETE")(routeRequest(`/api/admin/users/${TARGET}`, { method: "DELETE", creds: c }), userCtx),
    effect: () => authCalls.deleteUser.mock.calls.length > 0 && wrote("delete", `users/${TARGET}`),
  },
  {
    name: "GET /api/admin/users/[uid]/details",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc(`users/${TARGET}`, { email: "someone@test-invented.example" }),
    call: (c) => h(USER_DETAILS, "GET")(routeRequest(`/api/admin/users/${TARGET}/details`, { creds: c }), userCtx),
    effect: () => read(`users/${TARGET}`),
  },
  {
    name: "POST /api/admin/users/[uid]/override",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc(`users/${TARGET}`, { email: "someone@test-invented.example", plan: "free" }),
    call: (c) =>
      h(USER_OVERRIDE, "POST")(
        routeRequest(`/api/admin/users/${TARGET}/override`, { method: "POST", body: { plan: "3_models", reason: "support", adminUid: SPOOF }, creds: c }),
        userCtx
      ),
    effect: () => wrote("update", `users/${TARGET}`) && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "DELETE /api/admin/users/[uid]/override",
    tier: "SYSTEM_ADMIN",
    seed: () => seedDoc(`users/${TARGET}`, { email: "someone@test-invented.example", plan: "lite", override: { active: true, plan: "3_models" } }),
    call: (c) => h(USER_OVERRIDE, "DELETE")(routeRequest(`/api/admin/users/${TARGET}/override`, { method: "DELETE", creds: c }), userCtx),
    effect: () => wrote("update", `users/${TARGET}`) && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "POST /api/admin/users/[uid]/stripe/cancel",
    tier: "SYSTEM_ADMIN",
    seed: () => {
      seedDoc(`users/${TARGET}`, { stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x" });
      mockStripe.subscriptions.update.mockResolvedValue(subscription({ cancel_at_period_end: true }));
    },
    call: (c) => h(STRIPE_CANCEL, "POST")(routeRequest(`/api/admin/users/${TARGET}/stripe/cancel`, { method: "POST", body: { mode: "period_end" }, creds: c }), userCtx),
    effect: () => mockStripe.subscriptions.update.mock.calls.length > 0 && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "POST /api/admin/users/[uid]/stripe/reactivate",
    tier: "SYSTEM_ADMIN",
    seed: () => {
      seedDoc(`users/${TARGET}`, { stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x" });
      mockStripe.subscriptions.retrieve.mockResolvedValue(subscription({ cancel_at_period_end: true }));
      mockStripe.subscriptions.update.mockResolvedValue(subscription());
    },
    call: (c) => h(STRIPE_REACTIVATE, "POST")(routeRequest(`/api/admin/users/${TARGET}/stripe/reactivate`, { method: "POST", body: {}, creds: c }), userCtx),
    effect: () => mockStripe.subscriptions.update.mock.calls.length > 0 && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "POST /api/admin/users/[uid]/stripe/sync",
    tier: "SYSTEM_ADMIN",
    seed: () => {
      seedDoc(`users/${TARGET}`, { stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x" });
      mockStripe.subscriptions.retrieve.mockResolvedValue(subscription());
    },
    call: (c) => h(STRIPE_SYNC, "POST")(routeRequest(`/api/admin/users/${TARGET}/stripe/sync`, { method: "POST", body: {}, creds: c }), userCtx),
    effect: () => wrote("update", `users/${TARGET}`) && wrote("add", "admin_audit_logs/"),
  },
  {
    name: "POST /api/governance/audit/backfill",
    tier: "GOVERNANCE_ADMIN",
    seed: () => {
      seedDoc("verifications/v-1", { userId: "owner", governanceStatus: "approved", claim: "c" });
      seedDoc("verifications/v-1/governanceEvents/e-1", { action: "approved", byUid: "reviewer", at: "2026-11-01T00:00:00.000Z" });
    },
    call: (c) => h(GOV_BACKFILL, "POST")(routeRequest("/api/governance/audit/backfill", { method: "POST", creds: c })),
    effect: () => wrote("set", "admin_audit_logs/backfill__verifications__v-1__e-1"),
  },
  {
    name: "POST /api/governance/policy",
    tier: "GOVERNANCE_ADMIN",
    call: (c) => h(GOV_POLICY, "POST")(routeRequest("/api/governance/policy", { method: "POST", body: { minConsensusToApprove: 71, comment: "c" }, creds: c })),
    effect: () => dbWrites().some((e) => e.path.startsWith("appConfig/") || e.path.includes("olicy")) && wrote("add", "admin_audit_logs/"),
  },
];

/** Who holds which tier (live). */
const HOLDS: Record<PrivilegedTier, Persona[]> = {
  SYSTEM_ADMIN: ["system", "systemPlusGovernance"],
  ADMIN_PORTAL: ["system", "systemPlusGovernance", "portal"],
  GOVERNANCE_ADMIN: ["governance", "systemPlusGovernance"],
};
const ALL_PERSONAS: Persona[] = ["system", "portal", "governance", "ordinary", "systemPlusGovernance"];
/** The canonical holder used for success / matrix cases. */
const HOLDER: Record<PrivilegedTier, Persona> = { SYSTEM_ADMIN: "system", ADMIN_PORTAL: "portal", GOVERNANCE_ADMIN: "governance" };

function snapshotEffects() {
  return {
    db: dbLog.length,
    stripe: Object.values(mockStripe.subscriptions).reduce((n, f) => n + f.mock.calls.length, 0),
    webhook: mockHandleSubscriptionChange.mock.calls.length,
    researchDeletion: mockDeleteResearchRun.mock.calls.length,
    authMutations: authCalls.setCustomUserClaims.mock.calls.length + authCalls.updateUser.mock.calls.length + authCalls.deleteUser.mock.calls.length,
  };
}
const NOTHING = { db: 0, stripe: 0, webhook: 0, researchDeletion: 0, authMutations: 0 };

/** The guard performs at most ONE live read, of the presenting principal only. */
function expectNoProtectedAccess(presentingUid?: string) {
  expect(snapshotEffects()).toEqual(NOTHING);
  const looked = authCalls.getUser.mock.calls.map((c) => c[0]);
  expect(looked.length).toBeLessThanOrEqual(1);
  if (presentingUid !== undefined) for (const u of looked) expect(u).toBe(presentingUid);
}

async function expectDenied(res: Response, status: number, reason?: string) {
  const body = (await res.json()) as { error?: unknown; reason?: unknown };
  expect({ status: res.status, reason: reason === undefined ? undefined : body.reason }).toEqual({ status, reason });
  expect(res.headers.get("cache-control")).toBe("no-store");
}

beforeEach(() => {
  for (const f of Object.values(mockStripe.subscriptions)) f.mockReset();
  mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
  mockHandleSubscriptionChange.mockClear();
  mockDeleteResearchRun.mockClear();
});

it("the inventory is complete: 21 app/api/admin handlers + 2 pure GOVERNANCE_ADMIN handlers", () => {
  expect(CASES).toHaveLength(23);
  expect(new Set(CASES.map((c) => c.name)).size).toBe(23);
  expect(CASES.filter((c) => c.tier === "SYSTEM_ADMIN")).toHaveLength(17);
  expect(CASES.filter((c) => c.tier === "ADMIN_PORTAL")).toHaveLength(4);
  expect(CASES.filter((c) => c.tier === "GOVERNANCE_ADMIN")).toHaveLength(2);
});

describe.each(CASES)("$name [$tier]", (c) => {
  const seedAndCall = async (creds: Credentials) => {
    c.seed?.();
    return c.call(creds);
  };

  it("no credential → 401, nothing protected touched", async () => {
    await expectDenied(await seedAndCall({}), 401, "missing_credentials");
    expectNoProtectedAccess();
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });

  it("an ordinary signed-in user → 403, nothing protected touched", async () => {
    const me = signInAs("ordinary");
    await expectDenied(await seedAndCall({ bearer: me.bearer }), 403, "tier_not_held");
    expectNoProtectedAccess(me.uid);
  });

  it.each(ALL_PERSONAS)("persona %s: granted exactly when it holds the tier live", async (p) => {
    const me = signInAs(p);
    const res = await seedAndCall({ bearer: me.bearer });
    if (HOLDS[c.tier].includes(p)) {
      expect(res.status).toBe(c.okStatus ?? 200);
      expect(c.effect()).toBe(true);
    } else {
      await expectDenied(res, 403, "tier_not_held");
      expectNoProtectedAccess(me.uid);
    }
  });

  it("the correct tier passes the guard and ONLY THEN the protected effect happens", async () => {
    c.seed?.();
    const before = dbLog.length;
    expect(c.effect()).toBe(c.name === "GET /api/admin/access"); // nothing yet (access has no effect)
    const me = signInAs(HOLDER[c.tier]);
    const res = await c.call({ bearer: me.bearer });
    expect(res.status).toBe(c.okStatus ?? 200);
    expect(c.effect()).toBe(true);
    expect(before).toBe(0);
  });

  if (c.tier === "SYSTEM_ADMIN") {
    it("SYSTEM_ADMIN is bearer-only: the claim holder's session cookie alone → 401", async () => {
      const me = signInAs("system");
      await expectDenied(await seedAndCall({ cookie: me.cookie }), 401, "cookie_not_accepted_for_tier");
      expectNoProtectedAccess();
      expect(authCalls.verifySessionCookie).not.toHaveBeenCalled();
    });

    it("the token still claims admin but the LIVE claim was removed → 403", async () => {
      const me = signInAs("ordinary", { tokenClaimAdmin: true });
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 403, "tier_not_held");
      expectNoProtectedAccess(me.uid);
    });

    it("a stale-but-valid token WITHOUT the claim is granted once the live claim exists (live wins, SP-1)", async () => {
      const me = signInAs("system", { tokenClaimAdmin: false });
      const res = await seedAndCall({ bearer: me.bearer });
      expect(res.status).toBe(c.okStatus ?? 200);
      expect(c.effect()).toBe(true);
    });
  } else {
    it("a cookie-only session for a holder is accepted for this tier", async () => {
      const me = signInAs(HOLDER[c.tier]);
      const res = await seedAndCall({ cookie: me.cookie });
      expect(res.status).toBe(c.okStatus ?? 200);
      expect(c.effect()).toBe(true);
    });

    it("a REVOKED session cookie → 401 (revocation is read from the live snapshot, not the SDK flag)", async () => {
      const me = signInAs(HOLDER[c.tier], { record: { tokensValidAfterTime: new Date((AUTH_TIME + 1) * 1000).toUTCString() } });
      await expectDenied(await seedAndCall({ cookie: me.cookie }), 401, "credential_revoked");
      expectNoProtectedAccess(me.uid);
      expect(authCalls.verifySessionCookie.mock.calls.map((x) => x[1])).toEqual([false]);
    });

    it("a DISABLED holder's session cookie → 401", async () => {
      const me = signInAs(HOLDER[c.tier], { record: { disabled: true } });
      await expectDenied(await seedAndCall({ cookie: me.cookie }), 401, "account_disabled");
      expectNoProtectedAccess(me.uid);
    });
  }

  if (c.tier === "GOVERNANCE_ADMIN") {
    it("the SYSTEM_ADMIN claim alone → 403 (the claim never confers governance)", async () => {
      const me = signInAs("system");
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 403, "tier_not_held");
      expectNoProtectedAccess(me.uid);
    });
  }

  describe("shared matrix", () => {
    const holder = HOLDER[c.tier];

    it("a DISABLED holder → 401", async () => {
      const me = signInAs(holder, { record: { disabled: true } });
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 401, "account_disabled");
      expectNoProtectedAccess(me.uid);
    });

    it("a revoked credential (auth_time before tokensValidAfterTime) → 401", async () => {
      const me = signInAs(holder, { record: { tokensValidAfterTime: new Date((AUTH_TIME + 1) * 1000).toUTCString() } });
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 401, "credential_revoked");
      expectNoProtectedAccess(me.uid);
    });

    it("a deleted account (getUser → user-not-found) → 401", async () => {
      const me = signInAs(holder);
      authState.records.delete(me.uid);
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 401, "account_not_found");
      expectNoProtectedAccess(me.uid);
    });

    it("a getUser outage → 503", async () => {
      const me = signInAs(holder);
      authState.records.set(me.uid, Object.assign(new Error("socket hang up"), { code: "app/network-error" }));
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 503, "auth_unavailable");
      expectNoProtectedAccess(me.uid);
    });

    it("a verifier outage (public-key fetch failure) → 503", async () => {
      const me = signInAs(holder);
      authState.tokens.set(me.bearer, Object.assign(new Error("Error while making request: connect ECONNREFUSED"), { code: "app/network-error" }));
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 503, "auth_unavailable");
      expectNoProtectedAccess();
      expect(authCalls.getUser).not.toHaveBeenCalled();
    });

    it("the Admin SDK is uninitialised → 503", async () => {
      const me = signInAs(holder);
      authState.available = false;
      await expectDenied(await seedAndCall({ bearer: me.bearer }), 503, "admin_sdk_uninitialized");
      expectNoProtectedAccess();
    });

    it.each([
      ["not a JWS", "Bearer not-a-jwt"],
      ["empty bearer", "Bearer "],
      ["wrong scheme", "Basic abc"],
      ["wrong audience", `Bearer ${mintCredential("bearer", "uid-system-admin", { aud: "another-project" })}`],
      ["expired", `Bearer ${mintCredential("bearer", "uid-system-admin", { exp: Math.floor(Date.now() / 1000) - 10 })}`],
      ["unsigned by Google (unregistered)", `Bearer ${mintCredential("bearer", "uid-system-admin")}`],
    ])("a malformed / invalid credential (%s) → 401", async (_l, authorization) => {
      signInAs(holder);
      await expectDenied(await seedAndCall({ authorization }), 401, "invalid_credential");
      expectNoProtectedAccess();
      expect(authCalls.getUser).not.toHaveBeenCalled();
    });

    it("a bearer and a cookie naming DIFFERENT uids → 401 (SP-5), even when the bearer alone would pass", async () => {
      const me = signInAs(holder);
      const other = signInAs("ordinary");
      await expectDenied(await seedAndCall({ bearer: me.bearer, cookie: other.cookie }), 401, "credential_mismatch");
      expectNoProtectedAccess();
      expect(authCalls.getUser).not.toHaveBeenCalled();
    });

    it("a valid bearer with a broken cookie never falls back to the bearer → 401", async () => {
      const me = signInAs(holder);
      await expectDenied(await seedAndCall({ bearer: me.bearer, cookie: "garbage" }), 401, "invalid_credential");
      expectNoProtectedAccess();
    });

    it("repeated unauthorized attempts are ALL refused and nothing is ever touched", async () => {
      const ordinary = signInAs("ordinary");
      const disabled = signInAs(holder, { record: { disabled: true } });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await seedAndCall({ bearer: ordinary.bearer })).status);
        statuses.push((await seedAndCall({ bearer: disabled.bearer })).status);
        statuses.push((await seedAndCall({})).status);
      }
      expect(statuses).toEqual(Array.from({ length: 5 }, () => [403, 401, 401]).flat());
      expect(snapshotEffects()).toEqual(NOTHING);
      expect(dbWrites()).toEqual([]);
    });
  });
});

describe("GET /api/admin/access reports the LIVE tiers", () => {
  it.each([
    ["system", true],
    ["portal", false],
  ] as const)("%s → systemAdmin %s", async (p, systemAdmin) => {
    const me = signInAs(p);
    const res = await ACCESS.GET(routeRequest("/api/admin/access", { creds: { bearer: me.bearer } }) as never);
    expect(await res.json()).toEqual({ ok: true, adminPortal: true, systemAdmin });
  });

  it("a de-claimed administrator whose token still says admin is reported as NOT system admin", async () => {
    const me = signInAs("portal", { tokenClaimAdmin: true });
    const res = await ACCESS.GET(routeRequest("/api/admin/access", { creds: { bearer: me.bearer } }) as never);
    expect(await res.json()).toEqual({ ok: true, adminPortal: true, systemAdmin: false });
  });
});

describe("audit attribution comes from the guard's actor, never the request body", () => {
  const auditRows = () =>
    [...dbStore.entries()].filter(([k]) => k.startsWith("admin_audit_logs/")).map(([, v]) => v as Record<string, unknown>);

  it("PATCH /api/admin/runs/[runId]: byUid / byEmail are the actor's (same live snapshot)", async () => {
    const me = signInAs("system");
    const c = CASES.find((x) => x.name === "PATCH /api/admin/runs/[runId]") as Case;
    c.seed?.();
    expect((await c.call({ bearer: me.bearer })).status).toBe(200);
    expect(auditRows()).toEqual([expect.objectContaining({ byUid: UIDS.system, byEmail: EMAILS.system, action: "admin_override" })]);
    expect(dbStore.get("verifications/v-1")).toMatchObject({ governanceReviewedBy: UIDS.system });
    expect(JSON.stringify(auditRows())).not.toContain(SPOOF);
  });

  it("DELETE /api/admin/runs/[runId]: byUid is the actor's", async () => {
    const me = signInAs("system");
    const c = CASES.find((x) => x.name === "DELETE /api/admin/runs/[runId]") as Case;
    c.seed?.();
    expect((await c.call({ bearer: me.bearer })).status).toBe(200);
    expect(auditRows()).toEqual([expect.objectContaining({ byUid: UIDS.system, byEmail: EMAILS.system, action: "admin_deleted" })]);
  });

  it.each([
    "POST /api/admin/users/[uid]/override",
    "DELETE /api/admin/users/[uid]/override",
    "POST /api/admin/users/[uid]/stripe/cancel",
    "POST /api/admin/users/[uid]/stripe/reactivate",
    "POST /api/admin/users/[uid]/stripe/sync",
  ])("%s: adminUid is the actor's", async (name) => {
    const me = signInAs("system");
    const c = CASES.find((x) => x.name === name) as Case;
    c.seed?.();
    expect((await c.call({ bearer: me.bearer })).status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ adminUid: UIDS.system, targetUid: TARGET });
    expect(JSON.stringify(rows)).not.toContain(SPOOF);
  });

  it("POST /api/admin/purge-runs: the deletion workflow is attributed to the actor", async () => {
    const me = signInAs("system");
    const c = CASES.find((x) => x.name === "POST /api/admin/purge-runs") as Case;
    c.seed?.();
    expect((await c.call({ bearer: me.bearer })).status).toBe(200);
    expect(mockDeleteResearchRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "old-1", actorUid: UIDS.system }));
  });

  it("POST /api/governance/policy: byUid / byEmail are the governance actor's", async () => {
    const me = signInAs("governance");
    const c = CASES.find((x) => x.name === "POST /api/governance/policy") as Case;
    expect((await c.call({ bearer: me.bearer })).status).toBe(200);
    expect(auditRows()).toEqual([expect.objectContaining({ byUid: UIDS.governance, byEmail: EMAILS.governance, action: "policy_updated" })]);
  });

  it("POST /api/admin/set-role: the self-demotion check compares against the ACTOR uid", async () => {
    const me = signInAs("system");
    const res = await SET_ROLE.POST(routeRequest("/api/admin/set-role", { method: "POST", body: { uid: me.uid, role: "user" }, creds: { bearer: me.bearer } }) as never);
    expect(res.status).toBe(400);
    expect(authCalls.setCustomUserClaims).not.toHaveBeenCalled();
  });
});

describe("every inventoried route module keeps the Node.js runtime", () => {
  it.each([
    ACCESS, KEYS, PURGE, RUNS, RUN, SET_ROLE, SYNC_SUB, TEST_WEBHOOK, USERS, USERS_SEARCH, USER, USER_DETAILS,
    USER_OVERRIDE, STRIPE_CANCEL, STRIPE_REACTIVATE, STRIPE_SYNC, GOV_BACKFILL, GOV_POLICY,
  ].map((m, i) => [i, m] as const))("module #%d", (_i, mod) => {
    expect((mod as { runtime?: string }).runtime).toBe("nodejs");
  });
});
