/**
 * Order B, Stage B1 — defence layers that are redundant under TODAY's tables, pinned so they keep holding if those
 * tables change (mutation survivors X4 and A1 made killable):
 *   - A legacy envelope naming a Milestone-2 schema id is rejected even if the legacy-id allowlist ever (wrongly)
 *     accepted it.
 *   - Submission requires research.read as well as research.organize, even for a (hypothetical future) role that holds
 *     organize without read.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/workspaces/reportReviewDeploymentEnvironment", () => ({ isProductionDeployment: () => true })); // Production-only guard: these specs exercise report review as deployed in Production
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true, REPORT_REVIEW_WORKSPACE_ALLOWLIST: ["wsD"] }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const legacyAllowlistAcceptsEverything = { on: false };
jest.mock("@/lib/adaptiveSchema/persistedOutput", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/persistedOutput");
  return { ...actual, isPersistedLegacyAdaptiveSchemaId: (id: unknown) => (legacyAllowlistAcceptsEverything.on ? typeof id === "string" : actual.isPersistedLegacyAdaptiveSchemaId(id)) };
});
const memberLacksResearchRead = { on: false };
jest.mock("@/lib/workspaces/capabilities", () => {
  const actual = jest.requireActual("@/lib/workspaces/capabilities");
  return {
    ...actual,
    roleHasCapability: (role: string, cap: string) => (memberLacksResearchRead.on && role === "member" && cap === "research.read" ? false : actual.roleHasCapability(role, cap)),
  };
});

import { evaluateReportReviewEligibility, GOVERNED_SCHEMA_IDS } from "@/lib/governance/reportReview";
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { computeMembershipId } from "@/lib/workspaces/membershipId";

const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const run = (schemaId: string) => ({ status: "complete", createdAt: NOW, legacyAdaptiveOutput: { version: 1, schemaId } });

afterEach(() => {
  legacyAllowlistAcceptsEverything.on = false;
  memberLacksResearchRead.on = false;
});

it("X4: every Milestone-2 id is rejected as evidence even if the legacy allowlist accepted any string", () => {
  legacyAllowlistAcceptsEverything.on = true;
  for (const id of GOVERNED_SCHEMA_IDS) expect(evaluateReportReviewEligibility(run(id))).toEqual({ eligible: false, reason: "no_review_information" });
  expect(evaluateReportReviewEligibility(run("made_up")).eligible).toBe(true); // control: the mock is live
});

it("A1: a role holding research.organize but not research.read cannot submit", async () => {
  const W = "wsD";
  const U = "uid-m";
  db.docs.clear();
  db.seed(`workspaces/${W}`, { schemaVersion: 1, id: W, type: "team", name: "T", ownerUserId: "o", createdByUserId: "o", createdAt: NOW, updatedAt: NOW });
  const oid = computeMembershipId(W, "o");
  db.seed(`workspaceMemberships/${oid}`, { schemaVersion: 1, id: oid, workspaceId: W, uid: "o", role: "owner", status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
  const id = computeMembershipId(W, U);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: W, uid: U, role: "member", status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
  db.seed("runs/r1", { userId: "creator", workspaceId: W, projectId: null, status: "complete", createdAt: NOW, legacyAdaptiveOutput: { version: 1, schemaId: "generic" } });
  const submit = () => submitReportReview({ uid: U, workspaceId: W, runId: "r1", purpose: { code: "other" } });
  memberLacksResearchRead.on = true;
  expect(await submit()).toEqual({ ok: false, reason: "insufficient_capability" });
  expect(db.read("runs/r1")!.reportReview).toBeUndefined();
  memberLacksResearchRead.on = false;
  expect((await submit()).ok).toBe(true); // control
});
