/**
 * SEC-3 / S2-b correction — REVOCATION CUTOFF ON THE BEARER PATH of the
 * mixed-audience governance handlers that authenticate through
 * `resolveGovernanceRequestUser` (policy GET, audit GET, queue GET, review POST).
 *
 * The cookie path is verified with `checkRevoked = true`; `verifyIdToken` is
 * not. Before the correction a revoked-but-enabled GOVERNANCE_ADMIN_EMAILS
 * member kept global queue/audit reads and cross-tenant review writes for the
 * rest of the ID token's life. `resolveGovernanceRequestUser` now compares the
 * verified bearer's `auth_time` with the live record's `tokensValidAfterTime`
 * from the read it already performs (no second lookup).
 *
 * The REAL route handlers, `authCheck`, `resolveRequestIdentity`,
 * `lib/firebase/auth`, `lib/firebase/auth-helpers` and `verifiedAdminIdentity`
 * run. Only the Admin SDK, Firestore, the visibility resolver, entitlements and
 * the policy store are faked, and every one of them records whether it was
 * reached.
 */

const GOV_ADMIN_EMAIL = "gov-admin@test-invented.example";
const __ENV = process.env.GOVERNANCE_ADMIN_EMAILS;
process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ADMIN_EMAIL;
afterAll(() => {
  if (__ENV === undefined) delete process.env.GOVERNANCE_ADMIN_EMAILS;
  else process.env.GOVERNANCE_ADMIN_EMAILS = __ENV;
});

const UID = "gov-caller";
const NOW_S = Math.floor(Date.now() / 1000);

type Rec = { email: string; emailVerified: boolean; disabled: boolean; tokensValidAfterTime?: unknown };
let record: Rec;
const tokens = new Map<string, Record<string, unknown>>();
const cookies = new Map<string, Record<string, unknown> | "revoked">();
const calls = {
  getUser: [] as string[],
  verifyIdToken: [] as unknown[][],
  verifySessionCookie: [] as unknown[][],
  db: [] as string[],
  visibility: [] as string[],
  entitlements: [] as string[],
  loadPolicy: 0,
};

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/firebase/admin", () => {
  const db = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        calls.db.push(String(prop));
        throw new Error(`Firestore must not be reached: ${String(prop)}`);
      },
    }
  );
  return {
    adminDb: db,
    FIREBASE_PROJECT_ID: "test-project",
    adminAuth: {
      getUser: async (uid: string) => {
        calls.getUser.push(uid);
        return { uid, ...record };
      },
      verifyIdToken: async (t: string, c?: boolean) => {
        calls.verifyIdToken.push([t, c]);
        const d = tokens.get(t);
        if (!d) throw Object.assign(new Error("bad token"), { code: "auth/argument-error" });
        return d;
      },
      verifySessionCookie: async (t: string, c?: boolean) => {
        calls.verifySessionCookie.push([t, c]);
        const d = cookies.get(t);
        if (d === "revoked") throw Object.assign(new Error("revoked"), { code: "auth/session-cookie-revoked" });
        if (!d) throw Object.assign(new Error("bad cookie"), { code: "auth/argument-error" });
        return d;
      },
    },
  };
});
jest.mock("@/lib/governance/governanceVisibleUserIds", () => {
  const actual = jest.requireActual("@/lib/governance/governanceVisibleUserIds");
  const vis = async (uid: string) => {
    calls.visibility.push(uid);
    return { ok: false, kind: "plan_required" };
  };
  return { ...actual, resolveGovernanceVisibleUserIds: vis, resolveGovernanceVisibleUserIdsCached: vis };
});
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async (uid: string) => {
    calls.entitlements.push(uid);
    return { planId: "full" };
  },
}));
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: async () => {
    calls.loadPolicy += 1;
    return { policyVersion: 7, minConsensusToApprove: 80 };
  },
  saveGovernancePolicyMerge: async () => {
    throw new Error("policy must not be written");
  },
}));
jest.mock("@/lib/governance/auditLog", () => ({
  writeAuditEvent: async () => {
    throw new Error("audit must not be written");
  },
}));

import { NextRequest } from "next/server";
import { GET as policyGET } from "@/app/api/governance/policy/route";
import { GET as auditGET } from "@/app/api/governance/audit/route";
import { GET as queueGET } from "@/app/api/governance/queue/route";
import { POST as reviewPOST } from "@/app/api/governance/review/route";

type Route = { name: string; call: (headers: Record<string, string>) => Promise<Response> };
const ROUTES: Route[] = [
  { name: "GET /api/governance/policy", call: (h) => policyGET(new NextRequest("https://app.test/api/governance/policy", { headers: h })) },
  { name: "GET /api/governance/audit", call: (h) => auditGET(new NextRequest("https://app.test/api/governance/audit", { headers: h })) },
  { name: "GET /api/governance/queue", call: (h) => queueGET(new NextRequest("https://app.test/api/governance/queue", { headers: h })) },
  {
    name: "POST /api/governance/review",
    call: (h) =>
      reviewPOST(
        new NextRequest("https://app.test/api/governance/review", {
          method: "POST",
          headers: { "content-type": "application/json", ...h },
          body: JSON.stringify({ runId: "run-x", collection: "runs", action: "approved" }),
        })
      ),
  },
];

const iso = (s: number) => new Date(s * 1000).toUTCString();
function bearer(authTime: unknown): Record<string, string> {
  const t = `tok-${tokens.size + 1}`;
  tokens.set(t, authTime === undefined ? { uid: UID } : { uid: UID, auth_time: authTime });
  return { authorization: `Bearer ${t}` };
}

beforeEach(() => {
  record = { email: GOV_ADMIN_EMAIL, emailVerified: true, disabled: false };
  tokens.clear();
  cookies.clear();
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) {
    if (k === "loadPolicy") calls.loadPolicy = 0;
    else (calls[k] as unknown[]).length = 0;
  }
});

function expectNothingReachedPastAuth() {
  expect(calls.getUser).toEqual([UID]); // the resolver's own single live read, nothing more
  expect(calls.visibility).toEqual([]);
  expect(calls.entitlements).toEqual([]);
  expect(calls.loadPolicy).toBe(0);
  expect(calls.db).toEqual([]);
}

describe.each(ROUTES)("$name", ({ call }) => {
  it("a revoked-but-enabled GOVERNANCE_ADMIN_EMAILS member's bearer (auth_time < tokensValidAfterTime) -> 401, nothing read or written", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    const res = await call(bearer(NOW_S - 3600));
    expect(res.status).toBe(401);
    expectNothingReachedPastAuth();
    expect(calls.verifyIdToken).toHaveLength(1);
  });

  it("an unparseable tokensValidAfterTime is treated as revoked -> 401", async () => {
    record.tokensValidAfterTime = "not a date";
    const res = await call(bearer(NOW_S - 60));
    expect(res.status).toBe(401);
    expectNothingReachedPastAuth();
  });

  it("with a cutoff set, a bearer without a usable auth_time is treated as revoked -> 401", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    const res = await call(bearer(undefined));
    expect(res.status).toBe(401);
    expectNothingReachedPastAuth();
  });

  it("a revoked bearer is refused even alongside a valid same-uid cookie", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    cookies.set("fresh-cookie", { uid: UID, auth_time: NOW_S - 10 });
    const res = await call({ ...bearer(NOW_S - 3600), cookie: "__session=fresh-cookie" });
    expect(res.status).toBe(401);
    expectNothingReachedPastAuth();
  });

  it("a revoked session cookie is still 401 (verified with checkRevoked = true)", async () => {
    cookies.set("old-cookie", "revoked");
    const res = await call({ cookie: "__session=old-cookie" });
    expect(res.status).toBe(401);
    expect(calls.verifySessionCookie).toEqual([["old-cookie", true]]);
    expect(calls.getUser).toEqual([]);
    expect(calls.visibility).toEqual([]);
    expect(calls.db).toEqual([]);
  });

  it("a fresh bearer (auth_time after the cutoff) passes authentication", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    const res = await call(bearer(NOW_S - 10));
    expect(res.status).not.toBe(401);
    expect(calls.verifyIdToken).toEqual([[expect.any(String), false]]);
  });

  it("a fresh bearer alongside a fresh same-uid cookie passes (the bearer's auth_time is carried for the matched pair)", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    cookies.set("fresh-cookie", { uid: UID, auth_time: NOW_S - 10 });
    const res = await call({ ...bearer(NOW_S - 10), cookie: "__session=fresh-cookie" });
    expect(res.status).not.toBe(401);
  });

  it("auth_time EQUAL to the cutoff is not revoked", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    const res = await call(bearer(NOW_S - 100));
    expect(res.status).not.toBe(401);
  });

  it("an ordinary (non-allowlisted) reviewer / full-plan bearer with no cutoff on the record is unaffected", async () => {
    record = { email: "reviewer@test-invented.example", emailVerified: true, disabled: false };
    const res = await call(bearer(NOW_S - 3000));
    expect(res.status).not.toBe(401);
  });
});

describe("the fresh caller actually reaches the handler body", () => {
  it("policy GET: fresh GOVERNANCE_ADMIN bearer -> 200 with the policy", async () => {
    record.tokensValidAfterTime = iso(NOW_S - 100);
    const res = await policyGET(new NextRequest("https://app.test/api/governance/policy", { headers: bearer(NOW_S - 10) }));
    expect(res.status).toBe(200);
    expect(calls.loadPolicy).toBe(1);
  });

  it("policy GET: ordinary full-plan bearer (not allowlisted, tokens revoked BEFORE sign-in) -> 200", async () => {
    record = { email: "member@test-invented.example", emailVerified: true, disabled: false, tokensValidAfterTime: iso(NOW_S - 5000) };
    const res = await policyGET(new NextRequest("https://app.test/api/governance/policy", { headers: bearer(NOW_S - 60) }));
    expect(res.status).toBe(200);
    expect(calls.entitlements).toEqual([UID]);
  });

  it.each(ROUTES.filter((r) => r.name !== "GET /api/governance/policy"))(
    "$name: fresh bearer reaches the visibility decision with the caller's uid",
    async ({ call }) => {
      record.tokensValidAfterTime = iso(NOW_S - 100);
      const res = await call(bearer(NOW_S - 10));
      expect(res.status).toBe(403); // the faked visibility answer, i.e. past authentication
      expect(calls.visibility).toEqual([UID]);
    }
  );
});
