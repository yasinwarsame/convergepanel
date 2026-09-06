/**
 * Phase FIRESTORE-AUTHZ-P0.2 — governance authority.
 *
 * Governance is the highest-value target closed by this phase: the allowlist
 * branch returns `visibleUserIds: null`, which removes the owner filter
 * entirely — every user's runs, decisions and review records — and
 * `checkAdminOnly()` gates governance policy writes and audit backfill.
 *
 * Exercises the real resolvers. Only Firebase Admin and entitlements are doubled.
 */

process.env.ADMIN_EMAILS = "admin@test-invented.example";
process.env.GOVERNANCE_ADMIN_EMAILS = "gov@test-invented.example";

const ADMIN = "admin@test-invented.example";
const GOV = "gov@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

let authRecord: Record<string, unknown> = {};
let getUserThrows = false;
const getUser = jest.fn(async () => {
  if (getUserThrows) throw new Error("auth unavailable");
  return authRecord;
});

let plan = "free";
let userDocData: Record<string, unknown> = {};
let assignerDocs: { id: string }[] = [];

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { getUser: (...a: unknown[]) => getUser(...(a as [])) },
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => userDocData }) }),
      where: () => ({ get: async () => ({ docs: assignerDocs }) }),
    }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async () => ({ planId: plan }),
}));
jest.mock("@/lib/governance/reviewerFields", () => ({
  parseGovernanceReviewerFor: (d: Record<string, unknown> | undefined) =>
    (d?.governanceReviewerFor as string[] | undefined) ?? [],
}));

import { checkAdminOnly } from "@/lib/governance/authCheck";
import {
  resolveGovernanceVisibleUserIds,
  resolveGovernanceVisibleUserIdsCached,
} from "@/lib/governance/governanceVisibleUserIds";

const globalScope = (v: unknown) =>
  (v as { ok: boolean; visibleUserIds: string[] | null; queueScope: string });

/** Set the LIVE Auth record the resolvers will read for themselves. */
const liveRecord = (email: string, emailVerified: unknown) => {
  authRecord = { email, emailVerified };
};

beforeEach(() => {
  authRecord = {};
  getUserThrows = false;
  plan = "free";
  userDocData = {};
  assignerDocs = [];
  getUser.mockClear();
});

// ---------------------------------------------------------------------------
describe("global governance visibility — evidence is read, not accepted", () => {
  it("THE FIX: unverified allowlisted identity gets NO global scope", async () => {
    liveRecord(GOV, false);
    const vis = await resolveGovernanceVisibleUserIds("attacker");
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
    expect(globalScope(vis).visibleUserIds ?? "absent").not.toBeNull();
  });

  it("verified allowlisted identity gets global scope", async () => {
    liveRecord(GOV, true);
    const vis = await resolveGovernanceVisibleUserIds("real");
    expect(globalScope(vis).ok).toBe(true);
    expect(globalScope(vis).visibleUserIds).toBeNull();
    expect(globalScope(vis).queueScope).toBe("admin_global");
  });

  it("verified but not allowlisted gets no global scope", async () => {
    liveRecord(OUTSIDER, true);
    const vis = await resolveGovernanceVisibleUserIds("u");
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ['string "true"', "true"],
    ["number 1", 1],
  ])("non-boolean verification %s on the record never yields global scope", async (_l, value) => {
    liveRecord(GOV, value);
    const vis = await resolveGovernanceVisibleUserIds("attacker");
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
  });

  it("reviewer-scoped ordinary access is unchanged by verification state", async () => {
    plan = "full";
    userDocData = { governanceReviewerFor: ["owner-1"] };
    for (const verified of [true, false]) {
      liveRecord(OUTSIDER, verified);
      const vis = await resolveGovernanceVisibleUserIds("reviewer");
      expect(globalScope(vis).ok).toBe(true);
      expect(globalScope(vis).visibleUserIds).toEqual(["owner-1"]);
      expect(globalScope(vis).queueScope).toBe("assigners");
    }
  });

  it("a non-admin free-plan user is still plan-gated", async () => {
    liveRecord(OUTSIDER, true);
    const vis = await resolveGovernanceVisibleUserIds("u");
    expect(vis).toEqual({ ok: false, kind: "plan_required" });
  });
});

// ---------------------------------------------------------------------------
/**
 * Phase FIRESTORE-AUTHZ-P0.2-C1 — STRUCTURAL TRUST BOUNDARY.
 *
 * The independent review proved the previous exported shape could be called
 * directly to manufacture authority:
 *
 *   resolveGovernanceVisibleUserIds("never-authenticated", "admin@…", true)
 *     -> { visibleUserIds: null, queueScope: "admin_global" }, 0 getUser calls
 *
 * The public entry points now take ONLY a uid and establish their own evidence,
 * so that call shape no longer exists. These tests prove it behaviourally; the
 * arity assertions are an extra guard, never the proof on their own.
 */
describe("STRUCTURAL: governance-global authority cannot be handed forged evidence", () => {
  it("both public entry points accept a uid and nothing else", () => {
    expect(resolveGovernanceVisibleUserIds.length).toBe(1);
    expect(resolveGovernanceVisibleUserIdsCached.length).toBe(1);
  });

  it("the resolver performs the live Auth lookup ITSELF", async () => {
    liveRecord(GOV, true);
    getUser.mockClear();
    await resolveGovernanceVisibleUserIds("real");
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getUser).toHaveBeenCalledWith("real");
  });

  it("R1 EXPLOIT SHAPE: a uid whose record is unverified gets no global scope, whatever a caller might believe", async () => {
    // The old call passed an allowlisted address and `true` alongside this uid.
    liveRecord(GOV, false);
    const vis = await resolveGovernanceVisibleUserIds("uid-that-never-authenticated");
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
    expect(getUser).toHaveBeenCalledWith("uid-that-never-authenticated");
  });

  it("a uid with no Auth record at all gets no global scope", async () => {
    getUserThrows = true;
    const vis = await resolveGovernanceVisibleUserIds("ghost");
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
  });

  it("FAIL CLOSED: Auth lookup failure denies global scope but still resolves reviewer scope", async () => {
    plan = "full";
    userDocData = { governanceReviewerFor: ["owner-2"] };
    getUserThrows = true;
    const vis = await resolveGovernanceVisibleUserIds("reviewer");
    expect(globalScope(vis).ok).toBe(true);
    expect(globalScope(vis).queueScope).toBe("assigners");
    expect(globalScope(vis).visibleUserIds).toEqual(["owner-2"]);
  });

  it("the cached entry point is equally unforgeable and also looks up live", async () => {
    liveRecord(GOV, false);
    getUser.mockClear();
    const vis = await resolveGovernanceVisibleUserIdsCached("uid-that-never-authenticated");
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
    expect(getUser).toHaveBeenCalledWith("uid-that-never-authenticated");
  });

  it("the cached entry point grants global scope only on a verified allowlisted record", async () => {
    liveRecord(GOV, true);
    const vis = await resolveGovernanceVisibleUserIdsCached("real-cached");
    expect(globalScope(vis).visibleUserIds).toBeNull();
    expect(globalScope(vis).queueScope).toBe("admin_global");
  });

  it("the module exports no helper that accepts identity evidence", async () => {
    const mod = await import("@/lib/governance/governanceVisibleUserIds");
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      if (!name.startsWith("resolveGovernanceVisibleUserIds")) continue;
      expect(value.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
describe("policy write / audit backfill (checkAdminOnly)", () => {
  it("THE FIX: unverified allowlisted identity cannot write policy", async () => {
    authRecord = { email: ADMIN, emailVerified: false };
    await expect(checkAdminOnly("attacker")).resolves.toBe(false);
  });

  it("verified allowlisted identity can", async () => {
    authRecord = { email: ADMIN, emailVerified: true };
    await expect(checkAdminOnly("real")).resolves.toBe(true);
  });

  it("verified non-allowlisted cannot", async () => {
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(checkAdminOnly("u")).resolves.toBe(false);
  });

  it("FAIL CLOSED: Auth lookup failure cannot write policy", async () => {
    getUserThrows = true;
    await expect(checkAdminOnly("u")).resolves.toBe(false);
  });

  it("takes its own live evidence — no caller-supplied email can reach it", async () => {
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(checkAdminOnly("u")).resolves.toBe(false);
    expect(getUser).toHaveBeenCalledWith("u");
    // The signature accepts a uid only; there is no email parameter to forge.
    expect(checkAdminOnly.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("visibility cache cannot outlive its proof", () => {
  it("a verified global grant is NOT served after verification becomes false", async () => {
    liveRecord(GOV, true);
    const first = await resolveGovernanceVisibleUserIdsCached("u1");
    expect(globalScope(first).visibleUserIds).toBeNull();

    // Same uid, same address, verification revoked — within the TTL.
    liveRecord(GOV, false);
    const second = await resolveGovernanceVisibleUserIdsCached("u1");
    expect(globalScope(second).queueScope).not.toBe("admin_global");
  });

  it("an unverified denial is not sticky once verification arrives", async () => {
    liveRecord(GOV, false);
    const first = await resolveGovernanceVisibleUserIdsCached("u2");
    expect(globalScope(first).queueScope).not.toBe("admin_global");
    liveRecord(GOV, true);
    const second = await resolveGovernanceVisibleUserIdsCached("u2");
    expect(globalScope(second).visibleUserIds).toBeNull();
  });

  it("a changed Auth email cannot reuse the previous allowlisted decision", async () => {
    liveRecord(GOV, true);
    const admin = await resolveGovernanceVisibleUserIdsCached("u3");
    expect(globalScope(admin).visibleUserIds).toBeNull();
    liveRecord(OUTSIDER, true);
    const changed = await resolveGovernanceVisibleUserIdsCached("u3");
    expect(globalScope(changed).queueScope).not.toBe("admin_global");
  });

  it("the cache still caches: identical trusted evidence does not recompute", async () => {
    plan = "full";
    userDocData = { governanceReviewerFor: ["owner-9"] };
    liveRecord(OUTSIDER, true);
    const a = await resolveGovernanceVisibleUserIdsCached("u4");
    const b = await resolveGovernanceVisibleUserIdsCached("u4");
    expect(b).toBe(a); // same object identity => served from cache
  });

  it("the live lookup is NOT cached — it runs on every call, ahead of the cache", async () => {
    plan = "full";
    userDocData = { governanceReviewerFor: ["owner-9"] };
    liveRecord(OUTSIDER, true);
    await resolveGovernanceVisibleUserIdsCached("u5");
    getUser.mockClear();
    await resolveGovernanceVisibleUserIdsCached("u5");
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
