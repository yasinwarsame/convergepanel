/**
 * Doc 14 PR-1, R4 (owner ruling 2026-11-18, MAJOR-1): closed-world claim sentence inventory — the GOVERNANCE QUEUE
 * (real GET route → real dashboard expanded row) and the Personal HISTORY row suffix, full space, same independent oracle.
 * See ./claimStatementInventory.harness.tsx and ./claimStatementInventoryGov.helpers.tsx.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" }),
}));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: async () => ({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" }),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/firebase/admin", () => {
  const { govQuery } = jest.requireActual("./claimStatementInventoryGov.db");
  return {
    adminDb: {
      collection: (name: string) =>
        name === "runs" || name === "verifications" || name === "videoVerifications" ? govQuery(name, null) : { doc: () => ({ get: async () => ({ exists: false }) }) },
      getAll: async (...refs: unknown[]) => refs.map(() => ({ exists: false, data: () => undefined })),
    },
  };
});
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

import { expectSurfaceClean, inventoryCases, unhitTemplates, type Case } from "./claimStatementInventory.harness";
import { installGovProducer } from "./claimStatementInventoryGov.helpers";

/** This file runs shard 0 of 2 (the other half: claimStatementInventoryGovB.spec.tsx) — a file split only. */
const SHARD = 0;
let CASES: Case[] = [];
beforeAll(async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  CASES = inventoryCases([1, 2, 3, 4, 5], [SHARD, 2]);
  await installGovProducer(CASES);
}, 1_800_000);

describe("closed-world claim sentence inventory (R4): governance queue + Personal history", () => {
  it("every governance-queue unit is inventoried and its semantic claim holds for the independent oracle (shard 0/2)", () => {
    expectSurfaceClean("gov", CASES);
    expect(unhitTemplates("gov")).toEqual([]);
  }, 1_800_000);
  it("every Personal history suffix is inventoried and its semantic claim holds for the independent oracle", () => {
    expectSurfaceClean("history", CASES);
    expect(unhitTemplates("history")).toEqual([]);
  }, 900_000);
});
