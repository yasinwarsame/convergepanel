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
 */

type Rec = { uid: string; disabled: boolean; tokensValidAfterTime?: string; email?: string; emailVerified?: boolean; customClaims?: Record<string, unknown> };
const mockUsers = new Map<string, Rec | Error>();
const mockGetUser = jest.fn();
const mockReads: string[] = [];
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
  const db = {
    collection: (p: string) => colRef(p),
    collectionGroup: (p: string) => colRef(p),
    doc: (p: string) => docRef(p),
    getAll: async (...refs: Array<{ path: string }>) => refs.map((r) => (mockReads.push(`getAll ${r.path}`), snap(r.path))),
    runTransaction: async (fn: (t: unknown) => unknown) => fn(tx),
    batch: () => ({ set() {}, update() {}, delete() {}, create() {}, commit: async () => { mockWrites.push("batch-commit"); } }),
  };
  return { adminAuth: auth, adminDb: db, admin: {}, firebaseAdmin: {}, FIREBASE_PROJECT_ID: "test-proj", getInitializedFirebaseProjectId: () => "test-proj", default: {} };
});
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

const NOW = Math.floor(Date.now() / 1000);
const AUTH_TIME = NOW - 600;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (sub: string) =>
  [b64({ alg: "RS256", kid: "k1", typ: "JWT" }), b64({ sub, aud: "test-proj", iss: "https://securetoken.google.com/test-proj", iat: NOW - 60, exp: NOW + 3000, auth_time: AUTH_TIME }), "sig"].join(".");
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
};
const W = { workspaceId: "ws1", runId: "run1", uid: "other", invitationId: "inv1" };
const ROUTES: Route[] = [
  {
    name: "GET /api/user/panel-history (ordinary read)",
    kind: "inline",
    call: (r) => panelHistory(r),
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
    reached: (r) => {
      expect(r.status).toBe(200);
      expect(mockPortalCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_valid" }));
    },
  },
  {
    name: "POST /api/teams/members (team management write)",
    kind: "wrapper503",
    call: (r) => teamMembers(r),
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
    reached: () => expect(mockReads.length + mockWrites.length).toBeGreaterThan(0),
  },
  {
    name: "POST /api/workspace-invitations/[id]/accept (invitation)",
    kind: "inline",
    body: { token: "invitation-secret-token" },
    call: (r) => invitationAccept(r, { params: { invitationId: W.invitationId } }),
    reached: () => expect(mockReads).toEqual(expect.arrayContaining([expect.stringContaining("workspaceInvitations/inv1")])),
  },
  {
    name: "GET /api/workspaces/[id]/runs/[runId]/exports (export)",
    kind: "inline",
    call: (r) => exportsList(r, { params: { workspaceId: W.workspaceId, runId: W.runId } }),
    reached: () => expect(mockReads.length).toBeGreaterThan(0),
  },
  {
    name: "GET /api/workspaces/[id]/runs/[runId]/report-review (report review)",
    kind: "wrapper503",
    call: (r) => reportReview(r, { params: { workspaceId: W.workspaceId, runId: W.runId } }),
    reached: () => expect(mockReads.length).toBeGreaterThan(0),
  },
  {
    name: "GET /api/admin/access (S2-b admin, parity)",
    kind: "s2b",
    call: (r) => adminAccess(r),
    reached: (r) => expect(r.status).toBe(200),
  },
];

const DEFAULT_BODY = { email: "target@example.com", role: "member" };
function req(bearer: string, body: Record<string, unknown> = DEFAULT_BODY): NextRequest {
  return new NextRequest("http://localhost/api/x", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
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
  mockSeed.clear();
  mockUsers.clear();
  for (const id of IDS) {
    // IDENTICAL authority for every identity — only the Auth record differs.
    mockSeed.set(`users/${id}`, { email: `${id}@example.com`, teamId: `team-${id}`, stripeCustomerId: `cus_${id}` });
    mockSeed.set(`teams/team-${id}`, { name: "T", createdBy: id, members: [{ uid: id, role: "owner", email: `${id}@example.com` }] });
    mockSeed.set(`runs/run-of-${id}`, { userId: id, question: "q", createdAt: 1, status: "completed" });
    const base = { email: `${id}@example.com`, emailVerified: true, customClaims: { admin: true } };
    mockUsers.set(id, { uid: id, disabled: id === "disabled", tokensValidAfterTime: id === "revoked" ? REVOKED_AT : OLD, ...base });
  }
  mockSeed.set("users/target", { email: "target@example.com" });
  mockGetUser.mockImplementation(async (uid: string) => {
    const r = mockUsers.get(uid);
    if (r instanceof Error) throw r;
    if (!r) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    return r;
  });
});

describe.each(ROUTES)("$name", ({ kind, call, reached, body }) => {
  it("SENSITIVITY CONTROL: a valid bearer proceeds into the route's real data path / authorized action", async () => {
    reached(await run(call, req(token("valid"), body)));
  });
  it.each(["revoked", "disabled"])("%s bearer (same seeded authority) → 401, no data read, no write, no action", async (id) => {
    const r = await run(call, req(token(id), body));
    expect(r.status).toBe(401);
    expect(mockReads).toEqual([]);
    expect(mockWrites).toEqual([]);
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });
  it.each(["auth/internal-error", "app/network-error"])("live-read outage %s → fail closed (inline 401; wrapper / S2-b 503), no data access", async (code) => {
    mockUsers.set("valid", Object.assign(new Error("upstream"), { code }));
    const r = await run(call, req(token("valid"), body));
    expect(r.status).toBe(kind === "inline" ? 401 : 503);
    expect(mockReads).toEqual([]);
    expect(mockWrites).toEqual([]);
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });
});
