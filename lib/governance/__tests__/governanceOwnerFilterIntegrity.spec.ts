/**
 * Phase FIRST-ADMIN-C3 — THE OWNER FILTER IS THE SECURITY BOUNDARY, NOT THE LABEL.
 *
 * The R2 review found that every governance denial assertion in this repository
 * tested `queueScope`, a decorative string, and that the "positive" backstop
 * added in C2 to close that vacuity was itself vacuous:
 *
 *     expect(vis.visibleUserIds ?? undefined).not.toBeNull();
 *
 * `??` fires on `null` as well as `undefined`, so the exact value that means
 * "the owner filter has been removed" was converted to `undefined` before the
 * assertion, and `expect(undefined).not.toBeNull()` can never fail.
 *
 * The consequence was demonstrated: an implementation returning
 *
 *     { ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "assigners" }
 *
 * — the complete removal of the run-owner filter over every user's runs,
 * decisions and review records, wearing a NON-global label — passed the entire
 * 11,069-test suite undetected.
 *
 * `runOwnerVisibleInGovernance(null, anyUid)` returns `true` for EVERY uid.
 * That is what `visibleUserIds: null` means, and it is what these tests assert
 * against: a scoped reviewer must not be able to see a stranger's run, no
 * matter what the scope is called.
 */

const GOV_ONLY = "governance-only@test-invented.example";
const APP_ONLY = "portal-only@test-invented.example";

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

/** The reviewer under test, the two owners assigned to them, and an unrelated user. */
const REVIEWER = "reviewer-uid";
const ASSIGNED_A = "owner-a";
const ASSIGNED_B = "owner-b";
const STRANGER = "stranger-uid";

let authRecord: Record<string, unknown> = {};
let planId = "full";
let reviewerFor: string[] = [];
let reverseAssigners: string[] = [];

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { getUser: async () => authRecord },
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
      where: () => ({ get: async () => ({ docs: reverseAssigners.map((id) => ({ id })) }) }),
    }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async () => ({ planId }),
}));
jest.mock("@/lib/governance/reviewerFields", () => ({
  parseGovernanceReviewerFor: () => reviewerFor,
}));

import {
  resolveGovernanceVisibleUserIds,
  resolveGovernanceVisibleUserIdsCached,
  runOwnerVisibleInGovernance,
  type GovernanceVisibility,
} from "@/lib/governance/governanceVisibleUserIds";

beforeEach(() => {
  process.env.ADMIN_EMAILS = APP_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  authRecord = { email: "scoped-reviewer@test-invented.example", emailVerified: true };
  planId = "full";
  reviewerFor = [ASSIGNED_A];
  reverseAssigners = [ASSIGNED_B];
});

/**
 * The reusable, load-bearing denial assertion. Exported shape is a union, so
 * both branches are pinned exactly — a mutation cannot slip through by
 * switching branches.
 */
export function expectOwnerFilterActive(vis: GovernanceVisibility): void {
  expect((vis as { queueScope?: string }).queueScope).not.toBe("admin_global");
  if (vis.ok) {
    // No `??`. `null` here IS the removal of the filter.
    expect(vis.visibleUserIds).not.toBeNull();
    expect(runOwnerVisibleInGovernance(vis.visibleUserIds, STRANGER)).toBe(false);
  } else {
    expect(vis).toEqual({ ok: false, kind: expect.stringMatching(/^(plan_required|no_db)$/) });
  }
}

describe("a scoped reviewer keeps the owner filter — the C3 P1 regression", () => {
  it("THE CORE PROOF: an assignee-scoped reviewer gets a finite owner set, never null", async () => {
    const vis = await resolveGovernanceVisibleUserIds(REVIEWER);
    expect(vis.ok).toBe(true);
    if (!vis.ok) throw new Error("unreachable");
    // Exact structure, exact contents — not a truthiness check.
    expect(vis.visibleUserIds).not.toBeNull();
    expect([...(vis.visibleUserIds as string[])].sort()).toEqual([ASSIGNED_A, ASSIGNED_B]);
    expect(vis.isSupportAdmin).toBe(false);
    expect(vis.queueScope).toBe("assigners");
  });

  it("THE ESCAPE MUTATION: a stranger's runs are NOT visible to a scoped reviewer", async () => {
    const vis = await resolveGovernanceVisibleUserIds(REVIEWER);
    if (!vis.ok) throw new Error("expected a scoped grant");
    // This is the assertion the vacuous form could not make. With
    // `visibleUserIds: null` the helper returns true for every uid on earth,
    // whatever `queueScope` is called.
    expect(runOwnerVisibleInGovernance(vis.visibleUserIds, STRANGER)).toBe(false);
    expect(runOwnerVisibleInGovernance(vis.visibleUserIds, ASSIGNED_A)).toBe(true);
    expect(runOwnerVisibleInGovernance(vis.visibleUserIds, ASSIGNED_B)).toBe(true);
  });

  it("changing only the LABEL cannot hide removal of the filter", async () => {
    // Documents the property directly against the helper that consumes it:
    // the label is not consulted by anything that enforces ownership.
    expect(runOwnerVisibleInGovernance(null, STRANGER)).toBe(true);
    expect(runOwnerVisibleInGovernance([ASSIGNED_A], STRANGER)).toBe(false);
  });

  it("the reviewer's own uid is never in their own visible set", async () => {
    reviewerFor = [ASSIGNED_A, REVIEWER];
    const vis = await resolveGovernanceVisibleUserIds(REVIEWER);
    if (!vis.ok) throw new Error("expected a scoped grant");
    expect(vis.visibleUserIds).not.toContain(REVIEWER);
  });

  it("full plan with NO assigners yields an EMPTY set, not a null one", async () => {
    reviewerFor = [];
    reverseAssigners = [];
    const vis = await resolveGovernanceVisibleUserIds(REVIEWER);
    if (!vis.ok) throw new Error("expected a scoped grant");
    expect(vis.visibleUserIds).toEqual([]);
    expect(vis.queueScope).toBe("no_assigners");
    expect(runOwnerVisibleInGovernance(vis.visibleUserIds, STRANGER)).toBe(false);
  });

  it("the cached entry point keeps the filter too", async () => {
    const vis = await resolveGovernanceVisibleUserIdsCached("reviewer-cached");
    expectOwnerFilterActive(vis);
    if (!vis.ok) throw new Error("expected a scoped grant");
    expect([...(vis.visibleUserIds as string[])].sort()).toEqual([ASSIGNED_A, ASSIGNED_B]);
  });

  it("a governance admin is the ONLY identity that may receive the null owner set", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true };
    const vis = await resolveGovernanceVisibleUserIds("gov");
    if (!vis.ok) throw new Error("expected a grant");
    expect(vis.visibleUserIds).toBeNull();
    expect(vis.queueScope).toBe("admin_global");
    expect(runOwnerVisibleInGovernance(vis.visibleUserIds, STRANGER)).toBe(true);
  });

  it("a free-plan identity is refused outright, with an exact shape", async () => {
    planId = "free";
    const vis = await resolveGovernanceVisibleUserIds(REVIEWER);
    expect(vis).toEqual({ ok: false, kind: "plan_required" });
    expectOwnerFilterActive(vis);
  });
});
