/**
 * SEC-3 / S2-b correction (owner ruling D) — SCOPE-AWARE, REVOCATION-SAFE
 * COVERAGE of the six mixed-audience governance handlers, as a FIXED inventory:
 *
 *   GET /api/governance/policy     GOVERNANCE_ADMIN or current full plan
 *   GET /api/governance/audit      GOVERNANCE_ADMIN (global) or assigned reviewer (scoped)
 *   GET /api/governance/queue      GOVERNANCE_ADMIN (global) or assigned reviewer (scoped)
 *   POST /api/governance/review    GOVERNANCE_ADMIN or assigned reviewer
 *   GET /api/governance/reviewer   full-plan self-service (no privileged capability)
 *   POST /api/governance/reviewer  full-plan self-service (no privileged capability)
 *
 * The REAL handlers, `authCheck`, the privileged-access guard's authentication,
 * `verifiedAdminIdentity` and the governance visibility resolver run. Doubles
 * live only at the Admin SDK / Firestore boundary (shared privileged harness),
 * plus the entitlement lookup (a per-uid plan table) and the audit sink.
 */

jest.mock("@/lib/firebase/admin", () => require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble());
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockPlans = new Map<string, "free" | "lite" | "full">();
const mockEntitlementCalls: string[] = [];
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async (uid: string) => {
    mockEntitlementCalls.push(uid);
    return { planId: mockPlans.get(uid) ?? "free" };
  },
}));
const mockAuditEvents: unknown[] = [];
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: async (e: unknown) => void mockAuditEvents.push(e) }));
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: async () => ({ policyVersion: 7, minConsensusToApprove: 80 }),
  saveGovernancePolicyMerge: async () => {
    throw new Error("not under test");
  },
}));

import { NextRequest } from "next/server";
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
  signInAs,
  type Credentials,
} from "@/lib/admin/__tests__/privilegedRouteHarness";
import * as POLICY from "@/app/api/governance/policy/route";
import * as AUDIT from "@/app/api/governance/audit/route";
import * as QUEUE from "@/app/api/governance/queue/route";
import * as REVIEW from "@/app/api/governance/review/route";
import * as REVIEWER from "@/app/api/governance/reviewer/route";

installPrivilegedHarness();

const REVIEWER_UID = UIDS.ordinary; // an ordinary full-plan user assigned as reviewer by OWNER_A
const GOV_UID = UIDS.governance; // a GOVERNANCE_ADMIN_EMAILS member
const OWNER_A = "uid-owner-a"; // assigns REVIEWER_UID
const OWNER_B = "uid-owner-b"; // assigns nobody: foreign to the reviewer
const NOW_ISO = new Date().toISOString();

function headers(creds: Credentials): Record<string, string> {
  const h: Record<string, string> = {};
  if (creds.authorization !== undefined) h.authorization = creds.authorization;
  else if (creds.bearer !== undefined) h.authorization = `Bearer ${creds.bearer}`;
  if (creds.cookie !== undefined) h.cookie = `__session=${creds.cookie}`;
  return h;
}
const get = (path: string, creds: Credentials) => new NextRequest(`http://localhost${path}`, { headers: headers(creds) });
const postJson = (path: string, creds: Credentials, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: "POST", headers: { ...headers(creds), "content-type": "application/json" }, body: JSON.stringify(body) });

type Route = { name: string; call: (c: Credentials) => Promise<Response> };
const ROUTES: Route[] = [
  { name: "GET /api/governance/policy", call: (c) => POLICY.GET(get("/api/governance/policy", c)) },
  { name: "GET /api/governance/audit", call: (c) => AUDIT.GET(get("/api/governance/audit", c)) },
  { name: "GET /api/governance/queue", call: (c) => QUEUE.GET(get("/api/governance/queue?status=all", c)) },
  { name: "POST /api/governance/review", call: (c) => REVIEW.POST(postJson("/api/governance/review", c, { runId: "run-a", collection: "runs", action: "approved" })) },
  { name: "GET /api/governance/reviewer", call: (c) => REVIEWER.GET(get("/api/governance/reviewer", c)) },
  { name: "POST /api/governance/reviewer", call: (c) => REVIEWER.POST(postJson("/api/governance/reviewer", c, { action: "toggle_reviewer", enabled: true })) },
];

const auditDrill = (c: Credentials, runId: string) => AUDIT.GET(get(`/api/governance/audit?runId=${runId}&collection=runs`, c));
const review = (c: Credentials, runId: string) =>
  REVIEW.POST(postJson("/api/governance/review", c, { runId, collection: "runs", action: "approved" }));

function seedWorld() {
  dbStore.set(`users/${OWNER_A}`, { email: "owner-a@test-invented.example", governanceReviewerUid: REVIEWER_UID, governanceReviewerEmail: EMAILS.outsider });
  dbStore.set(`users/${OWNER_B}`, { email: "owner-b@test-invented.example" });
  dbStore.set(`users/${REVIEWER_UID}`, { email: EMAILS.outsider });
  for (const [id, owner] of [["run-a", OWNER_A], ["run-b", OWNER_B]] as const) {
    dbStore.set(`runs/${id}`, {
      userId: owner, uid: owner, question: `q-${id}`, status: "complete", governanceStatus: "needs_review",
      createdAt: NOW_ISO, updatedAt: NOW_ISO, consensusScore: 50, results: [],
    });
  }
  mockPlans.clear();
  mockPlans.set(REVIEWER_UID, "full");
  mockEntitlementCalls.length = 0;
  mockAuditEvents.length = 0;
}
beforeEach(seedWorld);

/** Nothing protected was reached: no entitlement lookup, no Firestore access at all, no write. */
function expectNothingReached() {
  expect(mockEntitlementCalls).toEqual([]);
  expect(dbLog).toEqual([]);
  expect(mockAuditEvents).toEqual([]);
}
async function expectAuthDenied(res: Response, status: 401 | 503) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body).toEqual({
    ok: false,
    error: status === 401 ? { code: "unauthorized", message: "Authentication required" } : { code: "auth_unavailable", message: "Authorization is temporarily unavailable" },
  });
  if (status === 503) expect(res.headers.get("retry-after")).toBe("5");
  // No identity, tier, scope or owner data in the denial.
  const text = JSON.stringify(body);
  for (const leak of [REVIEWER_UID, GOV_UID, OWNER_A, OWNER_B, EMAILS.governance, EMAILS.outsider, "admin_global", "governance"]) {
    expect(text).not.toContain(leak);
  }
}
const revokedRecord = { tokensValidAfterTime: new Date((AUTH_TIME + 60) * 1000).toUTCString() };
const outage = () => Object.assign(new Error("socket hang up"), { code: "app/network-error" });

describe.each(ROUTES)("$name — authentication matrix", ({ call }) => {
  it("valid ordinary access (assigned reviewer on the full plan) succeeds", async () => {
    const me = signInAs("ordinary");
    const res = await call({ bearer: me.bearer });
    expect(res.status).toBe(200);
    expect(authCalls.getUser.mock.calls[0]).toEqual([REVIEWER_UID]);
  });

  it("revoked bearer (auth_time before tokensValidAfterTime) -> 401, nothing reached", async () => {
    const me = signInAs("ordinary", { record: revokedRecord });
    await expectAuthDenied(await call({ bearer: me.bearer }), 401);
    expectNothingReached();
  });

  it("revoked bearer + FRESH same-uid cookie -> 401 (no silent fallback to the cookie)", async () => {
    const me = signInAs("ordinary", { record: revokedRecord });
    const fresh = mintCredential("cookie", REVIEWER_UID);
    authState.cookies.set(fresh, { uid: REVIEWER_UID, sub: REVIEWER_UID, auth_time: AUTH_TIME + 120 });
    await expectAuthDenied(await call({ bearer: me.bearer, cookie: fresh }), 401);
    expectNothingReached();
  });

  it("revoked privileged bearer (GOVERNANCE_ADMIN) -> 401, nothing reached", async () => {
    const gov = signInAs("governance", { record: revokedRecord });
    await expectAuthDenied(await call({ bearer: gov.bearer }), 401);
    expectNothingReached();
  });

  it("disabled identity -> 401, nothing reached", async () => {
    const me = signInAs("ordinary", { record: { disabled: true } });
    await expectAuthDenied(await call({ bearer: me.bearer }), 401);
    expectNothingReached();
  });

  it.each([["not a JWS", "Bearer not-a-jws"], ["no scheme", "garbage"], ["empty bearer", "Bearer "]])(
    "malformed credential (%s) -> 401, no live read",
    async (_n, authorization) => {
      signInAs("ordinary");
      await expectAuthDenied(await call({ authorization }), 401);
      expect(authCalls.getUser).not.toHaveBeenCalled();
      expectNothingReached();
    }
  );

  it("malformed bearer beside a valid cookie -> 401 (no fallback)", async () => {
    const me = signInAs("ordinary");
    await expectAuthDenied(await call({ authorization: "Bearer not-a-jws", cookie: me.cookie }), 401);
    expectNothingReached();
  });

  it("conflicting bearer / cookie uids -> 401, neither account read", async () => {
    const me = signInAs("ordinary");
    const other = signInAs("governance");
    await expectAuthDenied(await call({ bearer: me.bearer, cookie: other.cookie }), 401);
    expect(authCalls.getUser).not.toHaveBeenCalled();
    expectNothingReached();
  });

  it("verifier outage -> 503, never a grant", async () => {
    const me = signInAs("ordinary");
    authState.tokens.set(me.bearer, outage());
    await expectAuthDenied(await call({ bearer: me.bearer }), 503);
    expectNothingReached();
  });

  it("getUser outage -> 503, never a grant", async () => {
    const me = signInAs("ordinary");
    authState.records.set(REVIEWER_UID, outage());
    await expectAuthDenied(await call({ bearer: me.bearer }), 503);
    expectNothingReached();
  });

  it("no credentials -> 401", async () => {
    await expectAuthDenied(await call({}), 401);
    expectNothingReached();
  });
});

describe("valid privileged (GOVERNANCE_ADMIN) access — on a FREE plan, so only the live allowlist can grant", () => {
  it("policy GET -> 200 without consulting the plan", async () => {
    const gov = signInAs("governance");
    const res = await POLICY.GET(get("/api/governance/policy", { bearer: gov.bearer }));
    expect(res.status).toBe(200);
    expect(mockEntitlementCalls).toEqual([]);
  });

  it("queue GET -> admin_global", async () => {
    const gov = signInAs("governance");
    const res = await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: gov.bearer }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queueScope).toBe("admin_global");
    // Positive control for every exclusion assertion below: B's run is really there.
    expect(body.runs.map((r: { userId: string }) => r.userId).sort()).toEqual([OWNER_A, OWNER_B]);
  });

  it("audit drilldown on a FOREIGN owner's run (B) -> 200", async () => {
    const gov = signInAs("governance");
    expect((await auditDrill({ bearer: gov.bearer }, "run-b")).status).toBe(200);
  });

  it("review POST on a FOREIGN owner's run (B) -> 200 and the decision is written", async () => {
    const gov = signInAs("governance");
    const res = await review({ bearer: gov.bearer }, "run-b");
    expect(res.status).toBe(200);
    expect(dbWrites().some((w) => w.path.startsWith("runs/run-b"))).toBe(true);
  });

  it("the cookie path works for the same admin", async () => {
    const gov = signInAs("governance");
    const res = await QUEUE.GET(get("/api/governance/queue?status=all", { cookie: gov.cookie }));
    expect((await res.json()).queueScope).toBe("admin_global");
  });

  it.each([
    ["GET", () => REVIEWER.GET(get("/api/governance/reviewer", { bearer: signInAs("governance").bearer }))],
    ["POST", () => REVIEWER.POST(postJson("/api/governance/reviewer", { bearer: signInAs("governance").bearer }, { action: "toggle_reviewer", enabled: true }))],
  ])("reviewer %s confers NO privileged capability: a free-plan GOVERNANCE_ADMIN gets the plan refusal (403)", async (_m, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("plan_required");
    expect(dbWrites()).toEqual([]);
  });
});

describe("ordinary reviewer scope — never global, never another owner's items", () => {
  it("queue GET -> 'assigners' scope, not admin_global", async () => {
    const me = signInAs("ordinary");
    const body = await (await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: me.bearer }))).json();
    expect(body.queueScope).toBe("assigners");
    expect(body.runs.map((r: { userId?: string }) => r.userId)).toEqual([OWNER_A]);
  });

  it("audit drilldown: assigner's run (A) -> 200; foreign run (B) -> 403", async () => {
    const me = signInAs("ordinary");
    expect((await auditDrill({ bearer: me.bearer }, "run-a")).status).toBe(200);
    const res = await auditDrill({ bearer: me.bearer }, "run-b");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(OWNER_B);
  });

  it("review POST: assigner's run (A) -> 200; foreign run (B) refused and not written", async () => {
    const me = signInAs("ordinary");
    expect((await review({ bearer: me.bearer }, "run-a")).status).toBe(200);
    const before = dbWrites().length;
    const res = await review({ bearer: me.bearer }, "run-b");
    expect([403, 404]).toContain(res.status);
    expect(dbWrites().slice(before).some((w) => w.path.startsWith("runs/run-b"))).toBe(false);
  });

  it("a full-plan user with no assigners sees an EMPTY scope, never another owner's runs", async () => {
    mockPlans.set(OWNER_B, "full");
    const b = mintCredential("bearer", OWNER_B);
    authState.tokens.set(b, { uid: OWNER_B, sub: OWNER_B, auth_time: AUTH_TIME });
    authState.records.set(OWNER_B, { uid: OWNER_B, email: "owner-b@test-invented.example", emailVerified: true, disabled: false });
    const body = await (await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: b }))).json();
    expect(body.queueScope).toBe("no_assigners");
    expect(body.runs).toEqual([]);
    expect((await auditDrill({ bearer: b }, "run-a")).status).toBe(403);
  });

  it("a free-plan non-admin is refused by the plan gate (403), not granted anything", async () => {
    mockPlans.set(REVIEWER_UID, "free");
    const me = signInAs("ordinary");
    expect((await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: me.bearer }))).status).toBe(403);
    expect((await POLICY.GET(get("/api/governance/policy", { bearer: me.bearer }))).status).toBe(403);
  });
});

describe("losing GOVERNANCE_ADMIN ends global scope on the NEXT request, and an ordinary entitlement does not restore it", () => {
  beforeEach(() => mockPlans.set(GOV_UID, "full")); // the admin ALSO holds a full plan

  it("removed from GOVERNANCE_ADMIN_EMAILS (live): global first, then ONLY the full-plan scope — even with a warm cache", async () => {
    const gov = signInAs("governance");
    const first = await (await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: gov.bearer }))).json();
    expect(first.queueScope).toBe("admin_global"); // warms the 2-minute visibility cache
    process.env.GOVERNANCE_ADMIN_EMAILS = "someone-else@test-invented.example";
    const after = await (await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: gov.bearer }))).json();
    expect(first.runs.map((r: { userId: string }) => r.userId).sort()).toEqual([OWNER_A, OWNER_B]);
    expect(after.queueScope).toBe("no_assigners");
    expect(after.runs).toEqual([]);
    // The audit trail and review write follow the same live decision.
    expect((await auditDrill({ bearer: gov.bearer }, "run-b")).status).toBe(403);
    const res = await review({ bearer: gov.bearer }, "run-b");
    expect([403, 404]).toContain(res.status);
    expect(dbWrites().some((w) => w.path.startsWith("runs/run-b"))).toBe(false);
    // The full plan still reads the policy (that audience is unchanged).
    expect((await POLICY.GET(get("/api/governance/policy", { bearer: gov.bearer }))).status).toBe(200);
  });

  it("tokens revoked: global first, then 401 on every handler — the full plan does not rescue it", async () => {
    const gov = signInAs("governance");
    expect((await (await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: gov.bearer }))).json()).queueScope).toBe("admin_global");
    authState.records.set(GOV_UID, { ...(authState.records.get(GOV_UID) as object), ...revokedRecord });
    mockEntitlementCalls.length = 0;
    dbLog.length = 0;
    for (const r of ROUTES) await expectAuthDenied(await r.call({ bearer: gov.bearer }), 401);
    expectNothingReached();
  });

  it("disabled: global first, then 401 — even with a warm cache", async () => {
    const gov = signInAs("governance");
    expect((await (await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: gov.bearer }))).json()).queueScope).toBe("admin_global");
    authState.records.set(GOV_UID, { ...(authState.records.get(GOV_UID) as object), disabled: true });
    await expectAuthDenied(await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: gov.bearer })), 401);
  });

  // M-2 (owner authorization 2026-11-14): invariants 2, 5 and 6 on ALL SIX handlers.
  const warmGlobal = async (creds: Credentials) =>
    expect((await (await QUEUE.GET(get("/api/governance/queue?status=all", creds))).json()).queueScope).toBe("admin_global");
  const resetReached = () => {
    mockEntitlementCalls.length = 0;
    dbLog.length = 0;
  };

  it("disabled with a warm global cache: 401 on EVERY handler, nothing reached", async () => {
    const gov = signInAs("governance");
    await warmGlobal({ bearer: gov.bearer });
    authState.records.set(GOV_UID, { ...(authState.records.get(GOV_UID) as object), disabled: true });
    resetReached();
    for (const r of ROUTES) await expectAuthDenied(await r.call({ bearer: gov.bearer }), 401);
    expectNothingReached();
  });

  it("live-record outage with a warm global cache: 503 on EVERY handler — the cached global scope is never served", async () => {
    const gov = signInAs("governance");
    await warmGlobal({ bearer: gov.bearer });
    authState.records.set(GOV_UID, outage());
    resetReached();
    for (const r of ROUTES) await expectAuthDenied(await r.call({ bearer: gov.bearer }), 503);
    expectNothingReached();
  });

  it("token-verifier outage with a warm global cache: 503 on EVERY handler", async () => {
    const gov = signInAs("governance");
    await warmGlobal({ bearer: gov.bearer });
    authState.tokens.set(gov.bearer, outage());
    resetReached();
    for (const r of ROUTES) await expectAuthDenied(await r.call({ bearer: gov.bearer }), 503);
    expectNothingReached();
  });

  it("revoked: the pre-revocation COOKIE alone (warm cache via that cookie) is 401 on EVERY handler — a previously valid credential cannot recover global scope", async () => {
    const gov = signInAs("governance");
    await warmGlobal({ cookie: gov.cookie });
    authState.records.set(GOV_UID, { ...(authState.records.get(GOV_UID) as object), ...revokedRecord });
    resetReached();
    for (const r of ROUTES) await expectAuthDenied(await r.call({ cookie: gov.cookie }), 401);
    expectNothingReached();
  });
});

describe("M-2 invariant 4 — a reviewer assignment never confers global scope, even when the assigner IS a Governance Admin", () => {
  // The visibility cache is module-level and keyed on (uid, live email, …); it
  // caches refusals such as an earlier test's plan_required for this uid. A
  // distinct live email gives this describe its own key (order-independent).
  const ME = { record: { email: "inv4-reviewer@test-invented.example" } };
  beforeEach(() => {
    // GOV_UID (a GOVERNANCE_ADMIN_EMAILS member) assigns REVIEWER_UID (an ordinary full-plan user).
    dbStore.set(`users/${GOV_UID}`, { email: EMAILS.governance, governanceReviewerUid: REVIEWER_UID, governanceReviewerEmail: EMAILS.outsider });
  });

  it("queue: 'assigners' scope, never admin_global, and no run of an owner who did not assign the reviewer", async () => {
    const me = signInAs("ordinary", ME);
    const res = await QUEUE.GET(get("/api/governance/queue?status=all", { bearer: me.bearer }));
    const body = await res.json();
    expect([res.status, body.queueScope, body.error]).toEqual([200, "assigners", undefined]);
    expect(body.runs.map((r: { userId: string }) => r.userId)).not.toContain(OWNER_B);
  });

  it("audit drilldown and review on a run whose owner did not assign the reviewer: refused, nothing written", async () => {
    const me = signInAs("ordinary", ME);
    expect((await auditDrill({ bearer: me.bearer }, "run-b")).status).toBe(403);
    const res = await review({ bearer: me.bearer }, "run-b");
    expect([403, 404]).toContain(res.status);
    expect(dbWrites().some((w) => w.path.startsWith("runs/run-b"))).toBe(false);
  });
});

describe("reviewer GET/POST: legitimate users see exactly the same behaviour", () => {
  it("GET returns the caller's own settings and assigners, with ONE live Auth read", async () => {
    const me = signInAs("ordinary");
    const res = await REVIEWER.GET(get("/api/governance/reviewer", { bearer: me.bearer }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, reviewerEnabled: false, assignedReviewer: null });
    expect(body.reviewingFor.map((r: { uid: string }) => r.uid)).toEqual([OWNER_A]);
    expect(authCalls.getUser.mock.calls).toEqual([[REVIEWER_UID]]);
  });

  it("POST assign_reviewer still refuses self-assignment (email from the same live read, case-insensitive) with no extra getUser", async () => {
    // The LIVE record stores a mixed-case address; the request uses another casing.
    const me = signInAs("ordinary", { record: { email: " Outsider@Test-Invented.EXAMPLE " } });
    const res = await REVIEWER.POST(
      postJson("/api/governance/reviewer", { bearer: me.bearer }, { action: "assign_reviewer", reviewerEmail: `  ${EMAILS.outsider.toUpperCase()} ` })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("You can't assign yourself as your own reviewer.");
    expect(authCalls.getUser.mock.calls).toEqual([[REVIEWER_UID]]);
    expect(dbWrites()).toEqual([]);
  });

  it("POST toggle_reviewer writes only the caller's own document", async () => {
    const me = signInAs("ordinary");
    const res = await REVIEWER.POST(postJson("/api/governance/reviewer", { bearer: me.bearer }, { action: "toggle_reviewer", enabled: true }));
    expect(res.status).toBe(200);
    expect(dbWrites().map((w) => w.path)).toEqual([`users/${REVIEWER_UID}`]);
  });
});
