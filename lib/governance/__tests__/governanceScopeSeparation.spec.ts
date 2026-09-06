/**
 * Phase FIRST-ADMIN-C2 — the two separation mutations that survived R1.
 *
 * Both survived because the existing fixtures put ONE address on BOTH
 * allowlists, so nothing distinguished "granted by the governance list" from
 * "granted by the application list". Every fixture here is STRICTLY DISJOINT.
 *
 *   M4b  the governance resolver ORs the application predicate back in
 *   M10  the usage presentation ORs the two scopes
 */

/**
 * Phase FIRST-ADMIN-C2 test hygiene: jest workers reuse a single `process.env`
 * across the test FILES they run, so a suite that sets a privileged allowlist
 * and never restores it leaks that value into every later file in the same
 * worker. Snapshot BEFORE this file's own assignments; restore afterwards.
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

const APP_ONLY = "portal-only@test-invented.example";
const GOV_ONLY = "governance-only@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

let authRecord: Record<string, unknown> = {};
const getUser = jest.fn(async () => authRecord);
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { getUser: (...a: unknown[]) => getUser(...(a as [])) },
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async () => ({ planId: "free" }),
}));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => [] }));

import { resolveVerifiedAdminScopes } from "@/lib/admin/verifiedAdminIdentity";
import {
  resolveGovernanceVisibleUserIds,
  resolveGovernanceVisibleUserIdsCached,
} from "@/lib/governance/governanceVisibleUserIds";

beforeEach(() => {
  // Strictly disjoint: neither address appears on the other list.
  process.env.ADMIN_EMAILS = APP_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  authRecord = {};
  getUser.mockClear();
});

const scope = (v: unknown) => v as { ok: boolean; visibleUserIds: string[] | null; queueScope: string };

describe("M4b — governance-global cannot be reached from ADMIN_EMAILS", () => {
  it("USER A: verified, ADMIN_EMAILS only -> NO admin_global", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true };
    const vis = await resolveGovernanceVisibleUserIds("uid-A");
    expect(scope(vis).queueScope).not.toBe("admin_global");
    expect(scope(vis).visibleUserIds ?? undefined).not.toBeNull();
  });

  it("USER A: the cached entry point also refuses admin_global", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true };
    const vis = await resolveGovernanceVisibleUserIdsCached("uid-A-cached");
    expect(scope(vis).queueScope).not.toBe("admin_global");
  });

  it("USER G: verified, GOVERNANCE_ADMIN_EMAILS only -> admin_global", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const vis = await resolveGovernanceVisibleUserIds("uid-G");
    expect(scope(vis).ok).toBe(true);
    expect(scope(vis).visibleUserIds).toBeNull();
    expect(scope(vis).queueScope).toBe("admin_global");
  });

  it("USER G via the cached entry point -> admin_global", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const vis = await resolveGovernanceVisibleUserIdsCached("uid-G-cached");
    expect(scope(vis).visibleUserIds).toBeNull();
  });

  it("the scopes resolver reports them independently for each identity", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true };
    const a = await resolveVerifiedAdminScopes("uid-A");
    expect(a.adminPortal).toBe(true);
    expect(a.governanceAdmin).toBe(false);

    authRecord = { email: GOV_ONLY, emailVerified: true };
    const g = await resolveVerifiedAdminScopes("uid-G");
    expect(g.adminPortal).toBe(false);
    expect(g.governanceAdmin).toBe(true);
  });

  it("an outsider and an unverified list member both get neither scope", async () => {
    authRecord = { email: OUTSIDER, emailVerified: true };
    const o = await resolveVerifiedAdminScopes("uid-O");
    expect(o.adminPortal).toBe(false);
    expect(o.governanceAdmin).toBe(false);

    authRecord = { email: GOV_ONLY, emailVerified: false };
    const u = await resolveVerifiedAdminScopes("uid-U");
    expect(u.governanceAdmin).toBe(false);
    expect(u.adminPortal).toBe(false);
  });

  it("a lookup failure denies both scopes", async () => {
    getUser.mockImplementationOnce(async () => { throw new Error("auth down"); });
    const s = await resolveVerifiedAdminScopes("uid-X");
    expect(s.lookupStatus).toBe("lookup_failed");
    expect(s.adminPortal).toBe(false);
    expect(s.governanceAdmin).toBe(false);
  });
});
