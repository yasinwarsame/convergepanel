/**
 * BEARERREV — route-level matrix through REAL route handlers, the REAL
 * resolveRequestIdentity / teamApiAuth / reportReviewCaller / S2-b guard and
 * the REAL firebase-admin BaseAuth prototype (network edges stubbed: JWT
 * verifier decodes the synthetic token's payload; getUser serves fixtures).
 *
 * `adminDb` is a trap: any touch is recorded and throws. A denied credential
 * must be refused BEFORE any data access, so `dbTouched` must stay false.
 *
 * Representative routes (classification in evidence file 21-):
 *   ordinary       GET  /api/user/panel-history                       (inline resolveRequestIdentity)
 *   billing        POST /api/billing/create-portal-session            (inline resolveRequestIdentity)
 *   membership     POST /api/workspaces/[id]/members/[uid]/remove     (inline resolveRequestIdentity)
 *   invitation     POST /api/workspace-invitations/[id]/accept        (inline resolveRequestIdentity)
 *   export         GET  /api/workspaces/[id]/runs/[runId]/exports     (inline resolveRequestIdentity)
 *   team mgmt      POST /api/teams/members                            (teamApiAuth.getRequestUid → 503 on outage)
 *   report review  GET  /api/workspaces/[id]/runs/[runId]/report-review (reportReviewCaller → 503 on outage)
 *   admin (S2-b)   GET  /api/admin/access                             (already live-checked; parity)
 */

type Rec = { uid: string; disabled: boolean; tokensValidAfterTime?: string; email?: string; emailVerified?: boolean; customClaims?: Record<string, unknown> };
const mockUsers = new Map<string, Rec | Error>();
const mockGetUser = jest.fn();
let mockDbTouched = false;

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
  const trap: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      mockDbTouched = true;
      throw new Error(`adminDb touched: ${String(prop)}`);
    },
    apply() {
      mockDbTouched = true;
      throw new Error("adminDb called");
    },
  });
  return {
    adminAuth: auth,
    adminDb: trap,
    admin: {},
    firebaseAdmin: {},
    FIREBASE_PROJECT_ID: "test-proj",
    getInitializedFirebaseProjectId: () => "test-proj",
    default: {},
  };
});
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

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

type Call = (r: NextRequest) => Promise<Response>;
const W = { workspaceId: "ws1", runId: "run1", uid: "other", invitationId: "inv1" };
const ROUTES: Array<{ name: string; kind: "inline" | "wrapper503" | "s2b"; call: Call }> = [
  { name: "GET /api/user/panel-history (ordinary)", kind: "inline", call: (r) => panelHistory(r) },
  { name: "POST /api/billing/create-portal-session (billing)", kind: "inline", call: (r) => portal(r) },
  { name: "POST /api/workspaces/[id]/members/[uid]/remove (membership)", kind: "inline", call: (r) => memberRemove(r, { params: { workspaceId: W.workspaceId, uid: W.uid } }) },
  { name: "POST /api/workspace-invitations/[id]/accept (invitation)", kind: "inline", call: (r) => invitationAccept(r, { params: { invitationId: W.invitationId } }) },
  { name: "GET /api/workspaces/[id]/runs/[runId]/exports (export)", kind: "inline", call: (r) => exportsList(r, { params: { workspaceId: W.workspaceId, runId: W.runId } }) },
  { name: "POST /api/teams/members (team management)", kind: "wrapper503", call: (r) => teamMembers(r) },
  { name: "GET /api/workspaces/[id]/runs/[runId]/report-review (report review)", kind: "wrapper503", call: (r) => reportReview(r, { params: { workspaceId: W.workspaceId, runId: W.runId } }) },
  { name: "GET /api/admin/access (S2-b admin)", kind: "s2b", call: (r) => adminAccess(r) },
];

function req(bearer: string): NextRequest {
  return new NextRequest("http://localhost/api/x", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ teamId: "t1", email: "x@example.com", uid: "other" }),
  });
}

async function run(call: Call, r: NextRequest): Promise<number> {
  try {
    return (await call(r)).status;
  } catch {
    return -1; // a route that throws after reaching data is "proceeded", never an auth refusal
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  mockDbTouched = false;
  mockUsers.clear();
  const base = { email: "u@example.com", emailVerified: true };
  mockUsers.set("valid", { uid: "valid", disabled: false, tokensValidAfterTime: OLD, ...base });
  mockUsers.set("revoked", { uid: "revoked", disabled: false, tokensValidAfterTime: REVOKED_AT, ...base });
  mockUsers.set("disabled", { uid: "disabled", disabled: true, tokensValidAfterTime: OLD, ...base });
  mockGetUser.mockImplementation(async (uid: string) => {
    const r = mockUsers.get(uid);
    if (r instanceof Error) throw r;
    if (!r) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    return r;
  });
});

describe.each(ROUTES)("$name", ({ kind, call }) => {
  it("revoked bearer → 401 before any data access", async () => {
    expect(await run(call, req(token("revoked")))).toBe(401);
    expect(mockDbTouched).toBe(false);
  });
  it("disabled bearer → 401 before any data access", async () => {
    expect(await run(call, req(token("disabled")))).toBe(401);
    expect(mockDbTouched).toBe(false);
  });
  it.each(["auth/internal-error", "app/network-error"])("live-read outage %s → fail closed (wrapper/S2-b 503; inline 401), never data access", async (code) => {
    mockUsers.set("valid", Object.assign(new Error("upstream"), { code }));
    const status = await run(call, req(token("valid")));
    expect(status).toBe(kind === "inline" ? 401 : 503);
    expect(mockDbTouched).toBe(false);
  });
  it("valid bearer → NOT refused at authentication (proceeds past identity)", async () => {
    const status = await run(call, req(token("valid")));
    expect([401, 503]).not.toContain(status);
  });
});
