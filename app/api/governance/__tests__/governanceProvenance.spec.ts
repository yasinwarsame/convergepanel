/**
 * Phase FIRST-ADMIN-C6 — GOVERNANCE AUTHORITY FOLLOWS THE LIVE RECORD, NEVER A
 * TOKEN EMAIL, AND A DISABLED ACCOUNT REACHES NOTHING.
 *
 * The C5-R2 review found a mutation that re-derived `visibleUserIds = null` from
 * the caller's email inside the queue route and survived every existing test —
 * because the suites that cover the queue mock BOTH the identity resolver and
 * the visibility resolver, so the provenance chain between a token and an
 * authority answer was never exercised end to end.
 *
 * This suite mocks ONLY `firebase-admin`. Everything between the credential and
 * the authority decision is real: resolveRequestIdentity → resolveGovernanceRequestUser
 * → resolveLiveAuthIdentity → resolveVerifiedAdminScopes → resolveGovernanceVisibleUserIds
 * → the route handlers. That is the only way a divergence between what the TOKEN
 * claims and what the LIVE RECORD says can be observed at all.
 */

const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const GOV_ADDR = "governance-admin@test-invented.example";
const ORDINARY = "ordinary@test-invented.example";
const UID = "u-provenance";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const NOW = Date.now();

/** What the CREDENTIAL asserts. */
let tokenClaims: Record<string, unknown> = {};
/** What the LIVE Firebase Auth record says. Authority must follow this. */
let liveRecord: Record<string, unknown> = {};
let planId = "full";
let reviewerFor: string[] = [];

const seedRow = (coll: string, owner: string) => ({
  id: `${coll}-${owner}`,
  data: () => ({
    userId: owner, uid: owner,
    userEmail: `${owner}@test-invented.example`,
    question: `q-${owner}`, claim: `c-${owner}`, fileName: `${owner}.mp4`,
    type: coll === "videoVerifications" ? "video_verification" : "claim_verification",
    governanceStatus: "needs_review", consensusScore: 50,
    createdAt: { toMillis: () => NOW }, timestamp: { toMillis: () => NOW }, verifiedAt: { toMillis: () => NOW },
  }),
});

const SCOPED_COLLECTIONS = ["runs", "verifications", "videoVerifications"];

function makeQuery(name: string) {
  const constraints: Array<{ f: string; v: unknown }> = [];
  const q: Record<string, unknown> = {};
  for (const m of ["orderBy", "limit", "select", "startAfter", "endBefore", "offset"]) q[m] = () => q;
  q.where = (f: string, _op: string, v: unknown) => { constraints.push({ f, v }); return q; };
  q.get = async () => {
    if (!SCOPED_COLLECTIONS.includes(name)) return { docs: [], empty: true, size: 0 };
    const owners = [OWNER_A, OWNER_B];
    const c = constraints.find((x) => x.f === "userId" || x.f === "uid");
    const allowed = c ? owners.filter((o) => (Array.isArray(c.v) ? c.v.includes(o) : c.v === o)) : owners;
    return { docs: allowed.map((o) => seedRow(name, o)), empty: allowed.length === 0, size: allowed.length };
  };
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) });
  q.add = async () => undefined;
  q.doc = () => ({
    get: async () => ({ exists: true, id: "run-1", data: () => ({ userId: OWNER_A, uid: OWNER_A, governanceReviewerFor: reviewerFor }) }),
    set: async () => undefined, update: async () => undefined,
    collection: (n: string) => makeQuery(n),
  });
  return q;
}

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: async () => tokenClaims,
    verifySessionCookie: async () => tokenClaims,
    getUser: async () => liveRecord,
  },
  adminDb: { collection: (n: string) => makeQuery(n) },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS" } } },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId }) }));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => reviewerFor }));

import { NextRequest } from "next/server";
import { checkAdminOnly } from "@/lib/governance/authCheck";
import { resolveGovernanceVisibleUserIds } from "@/lib/governance/governanceVisibleUserIds";

const bearer = (url: string) => new NextRequest(url, { headers: { authorization: "Bearer t" } });
const queue = async () => {
  const { GET } = await import("@/app/api/governance/queue/route");
  return GET(bearer("http://localhost/api/governance/queue?status=all"));
};
const rowsOf = (b: unknown) => ((b as { runs?: Array<{ userId?: string }> }).runs ?? []);

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ADDR;
  planId = "full";
  reviewerFor = [OWNER_A];
  tokenClaims = { uid: UID, email: ORDINARY, email_verified: true };
  liveRecord = { email: ORDINARY, emailVerified: true, disabled: false };
});

describe("FIXTURE SELF-VALIDATION — the tenant rows this suite relies on really exist", () => {
  it("a genuine governance admin (live record allowlisted) sees BOTH tenants", async () => {
    // Establishes the evidence source for every exclusion assertion below: if
    // OWNER_B ever stops being present, THIS test fails first, so a negative
    // assertion can never go quietly vacuous.
    liveRecord = { email: GOV_ADDR, emailVerified: true, disabled: false };
    const body = await (await queue()).json();
    const owners = rowsOf(body).map((r) => r.userId).sort();
    expect(owners).toContain(OWNER_A);
    expect(owners).toContain(OWNER_B);
    expect((body as { queueScope?: string }).queueScope).toBe("admin_global");
  });
});

describe("TOKEN vs LIVE RECORD — authority follows the live record only", () => {
  it("THE CORE PROOF: an allowlisted TOKEN email with an ordinary LIVE record grants nothing", async () => {
    tokenClaims = { uid: UID, email: GOV_ADDR, email_verified: true }; // claims the allowlisted address
    liveRecord = { email: ORDINARY, emailVerified: true, disabled: false }; // but the record says otherwise
    await expect(checkAdminOnly(UID)).resolves.toBe(false);
    const vis = (await resolveGovernanceVisibleUserIds(UID)) as { ok: boolean; visibleUserIds?: string[] | null; queueScope?: string };
    expect(vis.visibleUserIds).not.toBeNull();
    expect(vis.queueScope).not.toBe("admin_global");
    const body = await (await queue()).json();
    expect((body as { queueScope?: string }).queueScope).not.toBe("admin_global");
    expect(rowsOf(body).some((r) => r.userId === OWNER_B)).toBe(false);
  });

  it("the reverse divergence: an ordinary TOKEN email with an allowlisted LIVE record DOES grant", async () => {
    tokenClaims = { uid: UID, email: ORDINARY, email_verified: true };
    liveRecord = { email: GOV_ADDR, emailVerified: true, disabled: false };
    await expect(checkAdminOnly(UID)).resolves.toBe(true);
    const body = await (await queue()).json();
    expect((body as { queueScope?: string }).queueScope).toBe("admin_global");
    expect(rowsOf(body).some((r) => r.userId === OWNER_B)).toBe(true);
  });

  it("a token claiming email_verified cannot rescue an unverified live record", async () => {
    tokenClaims = { uid: UID, email: GOV_ADDR, email_verified: true };
    liveRecord = { email: GOV_ADDR, emailVerified: false, disabled: false };
    await expect(checkAdminOnly(UID)).resolves.toBe(false);
    const body = await (await queue()).json();
    expect((body as { queueScope?: string }).queueScope).not.toBe("admin_global");
  });
});

describe("DISABLED accounts reach no governance route at all", () => {
  it("THE CORE PROOF: a disabled governance admin is refused outright", async () => {
    liveRecord = { email: GOV_ADDR, emailVerified: true, disabled: true };
    const res = await queue();
    expect(res.status).toBe(401);
    await expect(checkAdminOnly(UID)).resolves.toBe(false);
  });

  it("a disabled ORDINARY assigned reviewer is refused too — not just allowlisted admins", async () => {
    liveRecord = { email: ORDINARY, emailVerified: true, disabled: true };
    expect((await queue()).status).toBe(401);
  });

  it("the same ordinary reviewer ENABLED is admitted with a finite scope (the control)", async () => {
    liveRecord = { email: ORDINARY, emailVerified: true, disabled: false };
    const res = await queue();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { queueScope?: string }).queueScope).not.toBe("admin_global");
    expect(rowsOf(body).some((r) => r.userId === OWNER_A)).toBe(true);
    expect(rowsOf(body).some((r) => r.userId === OWNER_B)).toBe(false);
  });

  it("a disabled reviewer cannot reach the audit route either", async () => {
    liveRecord = { email: ORDINARY, emailVerified: true, disabled: true };
    const { GET } = await import("@/app/api/governance/audit/route");
    expect((await GET(bearer("http://localhost/api/governance/audit"))).status).toBe(401);
  });
});
