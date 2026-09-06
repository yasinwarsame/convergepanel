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

beforeEach(() => {
  authRecord = {};
  getUserThrows = false;
  plan = "free";
  userDocData = {};
  assignerDocs = [];
  getUser.mockClear();
});

// ---------------------------------------------------------------------------
describe("global governance visibility", () => {
  it("THE FIX: unverified allowlisted identity gets NO global scope", async () => {
    const vis = await resolveGovernanceVisibleUserIds("attacker", GOV, false);
    expect(globalScope(vis).visibleUserIds).not.toBeNull();
    expect(globalScope(vis).queueScope).not.toBe("admin_global");
  });

  it("verified allowlisted identity gets global scope", async () => {
    const vis = await resolveGovernanceVisibleUserIds("real", GOV, true);
    expect(globalScope(vis).ok).toBe(true);
    expect(globalScope(vis).visibleUserIds).toBeNull();
    expect(globalScope(vis).queueScope).toBe("admin_global");
  });

  it("verified but not allowlisted gets no global scope", async () => {
    const vis = await resolveGovernanceVisibleUserIds("u", OUTSIDER, true);
    expect(globalScope(vis).visibleUserIds).not.toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ['string "true"', "true"],
    ["number 1", 1],
  ])("non-boolean verification %s never yields global scope", async (_l, value) => {
    const vis = await resolveGovernanceVisibleUserIds("attacker", GOV, value as never);
    expect(globalScope(vis).visibleUserIds).not.toBeNull();
  });

  it("reviewer-scoped ordinary access is unchanged by verification state", async () => {
    plan = "full";
    userDocData = { governanceReviewerFor: ["owner-1"] };
    for (const verified of [true, false]) {
      const vis = await resolveGovernanceVisibleUserIds("reviewer", OUTSIDER, verified);
      expect(globalScope(vis).ok).toBe(true);
      expect(globalScope(vis).visibleUserIds).toEqual(["owner-1"]);
      expect(globalScope(vis).queueScope).toBe("assigners");
    }
  });

  it("a non-admin free-plan user is still plan-gated", async () => {
    const vis = await resolveGovernanceVisibleUserIds("u", OUTSIDER, true);
    expect(vis).toEqual({ ok: false, kind: "plan_required" });
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
    const first = await resolveGovernanceVisibleUserIdsCached("u1", GOV, true);
    expect(globalScope(first).visibleUserIds).toBeNull();

    // Same uid, same address, verification revoked — within the TTL.
    const second = await resolveGovernanceVisibleUserIdsCached("u1", GOV, false);
    expect(globalScope(second).visibleUserIds).not.toBeNull();
    expect(globalScope(second).queueScope).not.toBe("admin_global");
  });

  it("an unverified denial is not sticky once verification arrives", async () => {
    const first = await resolveGovernanceVisibleUserIdsCached("u2", GOV, false);
    expect(globalScope(first).visibleUserIds).not.toBeNull();
    const second = await resolveGovernanceVisibleUserIdsCached("u2", GOV, true);
    expect(globalScope(second).visibleUserIds).toBeNull();
  });

  it("a changed email cannot reuse the previous allowlisted decision", async () => {
    const admin = await resolveGovernanceVisibleUserIdsCached("u3", GOV, true);
    expect(globalScope(admin).visibleUserIds).toBeNull();
    const changed = await resolveGovernanceVisibleUserIdsCached("u3", OUTSIDER, true);
    expect(globalScope(changed).visibleUserIds).not.toBeNull();
  });

  it("the cache still caches: identical evidence does not recompute", async () => {
    plan = "full";
    userDocData = { governanceReviewerFor: ["owner-9"] };
    const a = await resolveGovernanceVisibleUserIdsCached("u4", OUTSIDER, true);
    const b = await resolveGovernanceVisibleUserIdsCached("u4", OUTSIDER, true);
    expect(b).toBe(a); // same object identity => served from cache
  });
});
