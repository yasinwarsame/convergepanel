/**
 * BEARERREV — route-level matrix through REAL route handlers, the REAL
 * resolveRequestIdentity / teamApiAuth / reportReviewCaller / S2-b guard and
 * the REAL firebase-admin BaseAuth prototype (network edges stubbed: the JWT
 * verifier decodes the synthetic token's payload; getUser serves fixtures).
 *
 * `adminDb` is a RECORDING fake Firestore seeded with IDENTICAL data for every
 * identity (valid, revoked, disabled): each owns the same team, has a Stripe
 * customer and has a run. So when a revoked/disabled bearer is refused, the
 * only difference from the valid case is the Auth record — and the
 * SENSITIVITY CONTROL proves the valid bearer really reaches each route's
 * data path or authorized action (reads recorded, Stripe portal created, team
 * member written, data returned, admin access granted). A denial therefore
 * proves the identity layer stopped a request that would otherwise proceed.
 *
 * R4: every route's control asserts a 200 AND route-specific data or an
 * authorized effect (the caller's run returned; the Stripe portal created for
 * the caller's customer; a team member / Workspace membership / invitation
 * acceptance WRITTEN; the seeded export record and report-review state
 * returned; the S2-b admin verdict). Every denial asserts that the fake
 * Firestore was not even TOUCHED (any entry point: collection / doc /
 * collectionGroup / getAll / runTransaction / batch), Stripe was not called
 * and no account lookup happened beyond the verifier's own single read.
 */

type Rec = { uid: string; disabled: boolean; tokensValidAfterTime?: string; email?: string; emailVerified?: boolean; customClaims?: Record<string, unknown> };
const mockUsers = new Map<string, Rec | Error>();
const mockGetUser = jest.fn();
const mockReads: string[] = [];
/** Every call on ANY adminDb entry point — a denial must leave this empty (stronger than reads/writes). */
const mockTouches: string[] = [];
const mockWrites: string[] = [];
const mockSeed = new Map<string, Record<string, unknown>>();
const mockPortalCreate = jest.fn(async () => ({ url: "https://billing.example.test/session" }));

jest.mock("@/lib/firebase/admin", () => {
  const proto = Object.getPrototypeOf(require("firebase-admin/auth").Auth.prototype);
  const auth = Object.create(proto);
  const verifier = {
    verifyJWT: async (t: string) => {
      const part = String(t).split(".")[1];
      if (!part) throw Object.assign(new Error("Decoding failed."), { code: "auth/argument-error" });
      const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
      return { ...p, uid: p.sub };
    },
  };
  auth.idTokenVerifier = verifier;
  auth.sessionCookieVerifier = verifier;
  auth.getUser = (...a: unknown[]) => mockGetUser(...a);

  const snap = (path: string) => {
    const data = mockSeed.get(path);
    return { exists: data !== undefined, id: path.split("/").pop(), ref: docRef(path), data: () => (data ? { ...data } : undefined), get: (f: string) => data?.[f] };
  };
  const qsnap = (path: string, filters: Array<[string, unknown]>, lim: number | null) => {
    let docs = [...mockSeed.entries()]
      .filter(([p]) => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/"))
      .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
      .map(([p]) => snap(p));
    if (lim !== null) docs = docs.slice(0, lim);
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: (d: unknown) => void) => docs.forEach(fn) };
  };
  function docRef(path: string): Record<string, unknown> {
    return {
      path,
      id: path.split("/").pop(),
      get: async () => { mockReads.push(`get ${path}`); return snap(path); },
      collection: (n: string) => colRef(`${path}/${n}`),
      set: async () => { mockWrites.push(`set ${path}`); },
      update: async () => { mockWrites.push(`update ${path}`); },
      create: async () => { mockWrites.push(`create ${path}`); },
      delete: async () => { mockWrites.push(`delete ${path}`); },
    };
  }
  function colRef(path: string, filters: Array<[string, unknown]> = [], lim: number | null = null): Record<string, unknown> {
    const q: Record<string, unknown> = {
      path,
      id: path.split("/").pop(),
      doc: (id?: string) => docRef(`${path}/${id ?? "auto-id"}`),
      where: (f: string, op: string, v: unknown) => colRef(path, op === "==" ? [...filters, [f, v]] : filters, lim),
      orderBy: () => q,
      limit: (n: number) => colRef(path, filters, n),
      select: () => q,
      startAfter: () => q,
      count: () => ({ get: async () => { mockReads.push(`count ${path}`); return { data: () => ({ count: qsnap(path, filters, null).size }) }; } }),
      get: async () => { mockReads.push(`query ${path}`); return qsnap(path, filters, lim); },
      add: async () => { mockWrites.push(`add ${path}`); return docRef(`${path}/auto-id`); },
    };
    return q;
  }
  const tx = {
    get: async (r: { path?: string; get?: () => Promise<unknown> }) => (typeof r.path === "string" && !("where" in r) ? (mockReads.push(`tx ${r.path}`), snap(r.path)) : (r as { get: () => Promise<unknown> }).get()),
    getAll: async (...refs: Array<{ path: string }>) => refs.map((r) => (mockReads.push(`tx ${r.path}`), snap(r.path))),
    set: (r: { path: string }) => { mockWrites.push(`tx-set ${r.path}`); return tx; },
    update: (r: { path: string }) => { mockWrites.push(`tx-update ${r.path}`); return tx; },
    create: (r: { path: string }) => { mockWrites.push(`tx-create ${r.path}`); return tx; },
    delete: (r: { path: string }) => { mockWrites.push(`tx-delete ${r.path}`); return tx; },
  };
  const touch = (what: string) => mockTouches.push(what);
  const db = {
    collection: (p: string) => (touch(`collection ${p}`), colRef(p)),
    collectionGroup: (p: string) => (touch(`collectionGroup ${p}`), colRef(p)),
    doc: (p: string) => (touch(`doc ${p}`), docRef(p)),
    getAll: async (...refs: Array<{ path: string }>) => (touch("getAll"), refs.map((r) => (mockReads.push(`getAll ${r.path}`), snap(r.path)))),
    runTransaction: async (fn: (t: unknown) => unknown) => (touch("runTransaction"), fn(tx)),
    batch: () => (touch("batch"), { set() {}, update() {}, delete() {}, create() {}, commit: async () => { mockWrites.push("batch-commit"); } }),
  };
  return { adminAuth: auth, adminDb: db, admin: {}, firebaseAdmin: {}, FIREBASE_PROJECT_ID: "test-proj", getInitializedFirebaseProjectId: () => "test-proj", default: {} };
});
// Adaptive export history is dark by default; enable it so the valid path reaches the export list.
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), ADAPTIVE_RESEARCH_EXPORT_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/stripe/client", () => ({ stripe: { billingPortal: { sessions: { create: (...a: unknown[]) => mockPortalCreate(...(a as [])) } } } }));
// Report review is dark by default; activate it for ws1 so the valid path reaches workspace access.
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true, REPORT_REVIEW_WORKSPACE_ALLOWLIST: ["ws1"] }));
jest.mock("@/lib/workspaces/reportReviewDeploymentEnvironment", () => ({ isProductionDeployment: () => true }));
// Team Workspaces are dark by default; admit the target so the valid path reaches the membership read.
jest.mock("@/lib/workspaces/teamWorkspaceTargetAdmission", () => ({
  ...jest.requireActual("@/lib/workspaces/teamWorkspaceTargetAdmission"),
  resolveTeamWorkspaceTargetAdmission: () => ({ enabled: true, source: "global" }),
}));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({
  ...jest.requireActual("@/lib/workspaces/approvalWorkflowRollout"),
  resolveApprovalWorkflowAdmission: () => ({ admitted: true, source: "global", canaryMisconfigured: false }),
}));

import { NextRequest } from "next/server";
import { GET as panelHistory } from "@/app/api/user/panel-history/route";
import { POST as portal } from "@/app/api/billing/create-portal-session/route";
import { POST as memberRemove } from "@/app/api/workspaces/[workspaceId]/members/[uid]/remove/route";
import { POST as invitationAccept } from "@/app/api/workspace-invitations/[invitationId]/accept/route";
import { GET as exportsList } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/exports/route";
import { POST as teamMembers } from "@/app/api/teams/members/route";
import { GET as reportReview } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route";
import { GET as adminAccess } from "@/app/api/admin/access/route";
import { Timestamp } from "firebase-admin/firestore";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { hashWorkspaceInvitationToken } from "@/lib/workspaces/invitationToken";
import { computeWorkspaceInvitationKey } from "@/lib/workspaces/invitationKey";

const NOW = Math.floor(Date.now() / 1000);
const AUTH_TIME = NOW - 600;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (sub: string, iss = "https://securetoken.google.com/test-proj") =>
  [b64({ alg: "RS256", kid: "k1", typ: "JWT" }), b64({ sub, aud: "test-proj", iss, iat: NOW - 60, exp: NOW + 3000, auth_time: AUTH_TIME }), "sig"].join(".");
/** Session-cookie-shaped token (S2-b pre-validates the issuer per credential kind). */
const cookieToken = (sub: string) => token(sub, "https://session.firebase.google.com/test-proj");
const REVOKED_AT = new Date((AUTH_TIME + 60) * 1000).toUTCString();
const OLD = new Date((AUTH_TIME - 3600) * 1000).toUTCString();
const IDS = ["valid", "revoked", "disabled"] as const;

type Res = { status: number; body: string };
type Call = (r: NextRequest) => Promise<Response>;
type Route = {
  name: string;
  /** Request body the route accepts (strict-body routes refuse unknown fields before identity-independent work). */
  body?: Record<string, unknown>;
  kind: "inline" | "wrapper503" | "s2b";
  call: Call;
  /** SENSITIVITY CONTROL: what the VALID bearer must achieve, proving the route proceeds past identity into real data / action. */
  reached: (r: Res) => void;
  /** Firebase Auth `getUser` reads for ONE successful bearer-only request (verifier + any the route itself makes). */
  lookups: number;
};
const OTHER_MEMBERSHIP = () => computeMembershipId("ws1", "other");
const W = { workspaceId: "ws1", runId: "run1", uid: "other", invitationId: "inv1" };
const ROUTES: Route[] = [
  {
    name: "GET /api/user/panel-history (ordinary read)",
    kind: "inline",
    call: (r) => panelHistory(r),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(r.body).toContain("run-of-valid"); // the caller's own seeded run is returned
      expect(mockReads).toEqual(expect.arrayContaining(["query runs"]));
    },
  },
  {
    name: "POST /api/billing/create-portal-session (Stripe portal)",
    kind: "inline",
    call: (r) => portal(r),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(mockPortalCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_valid" }));
    },
  },
  {
    name: "POST /api/teams/members (team management write)",
    kind: "wrapper503",
    call: (r) => teamMembers(r),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(mockWrites).toEqual(expect.arrayContaining(["update teams/team-valid"]));
    },
  },
  {
    name: "POST /api/workspaces/[id]/members/[uid]/remove (membership)",
    kind: "inline",
    body: {},
    call: (r) => memberRemove(r, { params: { workspaceId: W.workspaceId, uid: W.uid } }),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true, removed: true });
      // the target's membership was removed and the removal event written, in the transaction
      expect(mockWrites).toEqual(expect.arrayContaining([`tx-update workspaceMemberships/${OTHER_MEMBERSHIP()}`, "tx-set workspaceMembershipEvents/auto-id"]));
    },
  },
  {
    name: "POST /api/workspace-invitations/[id]/accept (invitation)",
    kind: "inline",
    body: { token: "invitation-secret-token" },
    call: (r) => invitationAccept(r, { params: { invitationId: W.invitationId } }),
    lookups: 2, // the verifier's read + the route's own verified-email getUser
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ ok: true, workspaceId: "ws1" });
      expect(mockWrites).toEqual(expect.arrayContaining(["tx-update workspaceInvitations/inv1"])); // invitation consumed
    },
  },
  {
    name: "GET /api/workspaces/[id]/runs/[runId]/exports (export)",
    kind: "inline",
    call: (r) => exportsList(r, { params: { workspaceId: W.workspaceId, runId: W.runId } }),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).exports).toEqual([expect.objectContaining({ exportId: "exp-seeded" })]); // the seeded export record
      expect(mockReads).toEqual(expect.arrayContaining(["query runs/run1/exports"]));
    },
  },
  {
    name: "GET /api/workspaces/[id]/runs/[runId]/report-review (report review)",
    kind: "wrapper503",
    call: (r) => reportReview(r, { params: { workspaceId: W.workspaceId, runId: W.runId } }),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ ok: true, state: "not_submitted" }); // the run's report-review state
      expect(mockReads).toEqual(expect.arrayContaining(["get runs/run1", "get runs/run1/humanReviewPanel/current"]));
    },
  },
  {
    name: "GET /api/admin/access (S2-b admin, parity)",
    kind: "s2b",
    call: (r) => adminAccess(r),
    lookups: 1,
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ ok: true, systemAdmin: true }); // S2-b's live verdict from the admin claim
    },
  },
];

const DEFAULT_BODY = { email: "target@example.com", role: "member" };
function req(bearer: string, body: Record<string, unknown> = DEFAULT_BODY, cookie?: string): NextRequest {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, "content-type": "application/json", origin: "http://localhost" };
  if (cookie) headers.cookie = `__session=${cookie}`;
  return new NextRequest("http://localhost/api/x", { method: "POST", headers, body: JSON.stringify(body) });
}

async function run(call: Call, r: NextRequest): Promise<Res> {
  try {
    const res = await call(r);
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: -1, body: String(e) };
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  mockReads.length = 0;
  mockWrites.length = 0;
  mockTouches.length = 0;
  mockSeed.clear();
  mockUsers.clear();
  for (const id of IDS) {
    // IDENTICAL authority for every identity — only the Auth record differs.
    mockSeed.set(`users/${id}`, { email: `${id}@example.com`, teamId: `team-${id}`, stripeCustomerId: `cus_${id}` });
    mockSeed.set(`teams/team-${id}`, { name: "T", createdBy: id, members: [{ uid: id, role: "owner", email: `${id}@example.com` }] });
    mockSeed.set(`runs/run-of-${id}`, { userId: id, question: "q", createdAt: 1, status: "completed" });
    // Same verified Auth email for every identity, so the email-bound invitation is equally acceptable to all three.
    const base = { email: "invitee@example.com", emailVerified: true, customClaims: { admin: true } };
    mockUsers.set(id, { uid: id, disabled: id === "disabled", tokensValidAfterTime: id === "revoked" ? REVOKED_AT : OLD, ...base });
  }
  mockSeed.set("users/target", { email: "target@example.com" });
  // Team Workspace ws1: owner0 owns it; valid / revoked / disabled are IDENTICAL admins; "other" is a plain member.
  const ts = Timestamp.fromMillis(1_700_000_000_000);
  mockSeed.set("workspaces/ws1", { schemaVersion: 1, id: "ws1", type: "team", name: "W", ownerUserId: "owner0", createdByUserId: "owner0", createdAt: ts, updatedAt: ts });
  const member = (uid: string, role: string) => {
    const id = computeMembershipId("ws1", uid);
    mockSeed.set(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: "ws1", uid, role, status: "active", createdAt: ts, updatedAt: ts, invitedByUserId: null, removedAt: null, removedByUserId: null });
  };
  member("owner0", "owner");
  member("other", "member");
  for (const id of IDS) member(id, "admin");
  // A pending invitation to ws1 for the shared verified email, and its current-invitation guard.
  mockSeed.set("workspaceInvitations/inv1", {
    schemaVersion: 1, id: "inv1", workspaceId: "ws1", normalizedEmail: "invitee@example.com", role: "member", status: "pending",
    tokenHash: hashWorkspaceInvitationToken("invitation-secret-token"), expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
    createdAt: ts, updatedAt: ts, invitedByUserId: "owner0", acceptedAt: null, acceptedByUserId: null, revokedAt: null, revokedByUserId: null,
    deliveryVersion: 1, lastDeliveryAttemptAt: null, lastDeliveryStatus: null, lastDeliveryVersion: null, providerMessageId: null,
  });
  mockSeed.set(`workspaceInvitationKeys/${computeWorkspaceInvitationKey("ws1", "invitee@example.com")}`, { workspaceId: "ws1", normalizedEmail: "invitee@example.com", currentInvitationId: "inv1", updatedAt: ts });
  // A Team run in ws1 with one export record.
  mockSeed.set("runs/run1", { userId: "owner0", workspaceId: "ws1", createdAt: ts, projectId: null, question: "q", status: "completed" });
  mockSeed.set("runs/run1/exports/exp-seeded", { exportId: "exp-seeded", runId: "run1", reportVersion: 1, schemaId: "generic", schemaFamily: "generic", format: "pdf", artifactStatus: "ready", createdAt: ts });
  mockGetUser.mockImplementation(async (uid: string) => {
    const r = mockUsers.get(uid);
    if (r instanceof Error) throw r;
    if (!r) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    return r;
  });
});

/** A denial must not reach ANY data or privileged lookup: no Firestore entry point, no Stripe, and no account read beyond the verifier's own. */
function expectNoAccessAfterDenial() {
  expect(mockTouches).toEqual([]);
  expect(mockReads).toEqual([]);
  expect(mockWrites).toEqual([]);
  expect(mockPortalCreate).not.toHaveBeenCalled();
  expect(mockGetUser).toHaveBeenCalledTimes(1);
}

/** Infrastructure failures of the live lookup (firebase-admin 12.x codes). */
const OUTAGE_CODES = ["auth/internal-error", "app/network-error", "auth/quota-exceeded", "app/unable-to-parse-response", "auth/insufficient-permission"];

describe.each(ROUTES)("$name", ({ kind, call, reached, body, lookups }) => {
  it("SENSITIVITY CONTROL: a valid bearer proceeds into the route's real data path / authorized action", async () => {
    reached(await run(call, req(token("valid"), body)));
  });
  it(`LOOKUP COUNT: a successful bearer-only request makes exactly ${lookups} Auth getUser read(s)`, async () => {
    await run(call, req(token("valid"), body));
    expect(mockGetUser).toHaveBeenCalledTimes(lookups);
  });
  it("LOOKUP COUNT: cookie + bearer for the same uid → the same success, one more getUser read on resolveRequestIdentity routes", async () => {
    const r = await run(call, req(token("valid"), body, cookieToken("valid")));
    reached(r);
    expect(mockGetUser).toHaveBeenCalledTimes(kind === "s2b" ? lookups : lookups + 1);
  });
  it.each(["revoked", "disabled"])("%s bearer (same seeded authority) → 401, no data touched, no write, no action, no further lookup", async (id) => {
    const r = await run(call, req(token(id), body));
    expect(r.status).toBe(401);
    expectNoAccessAfterDenial();
  });
  it.each(OUTAGE_CODES)("live-read outage %s → fail closed (inline 401; wrapper / S2-b 503 with a generic body), no data access", async (code) => {
    mockUsers.set("valid", Object.assign(new Error("upstream detail: Exceeded quota for project test-proj"), { code }));
    const r = await run(call, req(token("valid"), body));
    expect(r.status).toBe(kind === "inline" ? 401 : 503);
    // no internal detail reaches the client: neither the SDK code, its message, the project nor the uid
    for (const leak of [code, "upstream", "quota", "test-proj"]) expect(r.body.toLowerCase()).not.toContain(leak);
    expect(r.body).not.toMatch(/\bvalid\b/); // the uid
    expectNoAccessAfterDenial();
  });
});
