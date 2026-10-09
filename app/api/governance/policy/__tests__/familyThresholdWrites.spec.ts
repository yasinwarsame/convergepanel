/**
 * Step 6 D5.2A — policy API contract for score-type review thresholds.
 *
 * - GOVERNANCE_FAMILY_THRESHOLDS_WRITE_ENABLED off (the default): any family-map
 *   mutation — set, clear, valid or malformed — is rejected 403 before it reaches
 *   the store; legacy fields remain writable.
 * - Flag on: validated video / research set and clear reach the store in
 *   mutation form, with dotted change names; claim and malformed values are 400.
 * - GET reports the stored map as-is plus the write capability.
 * Authorization is stubbed (allowed admin); the flag is a per-test getter.
 */
let flagOn = false;
jest.mock("@/lib/env", () => ({
  get GOVERNANCE_FAMILY_THRESHOLDS_WRITE_ENABLED() {
    return flagOn;
  },
}));
jest.mock("@/lib/firebase/admin", () => ({ adminDb: {} }));
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: "gov-admin", email: "gov-admin@test-invented.example" }),
  checkAdminOnly: async () => true,
  checkGovernancePolicyReadAccess: async () => "allowed",
}));
const loadPolicy = jest.fn();
const savePolicy = jest.fn(async (..._a: unknown[]) => ({ policyVersion: 2 }));
jest.mock("@/lib/governance/governancePolicyStore", () => ({
  loadGovernancePolicy: () => loadPolicy(),
  saveGovernancePolicyMerge: (...a: unknown[]) => savePolicy(...a),
}));
const auditEvents: Record<string, unknown>[] = [];
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: async (e: Record<string, unknown>) => void auditEvents.push(e) }));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/governance/policy/route";

const URL_ = "https://app.test/api/governance/policy";
const post = (body: unknown) =>
  POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  flagOn = false;
  loadPolicy.mockReset();
  savePolicy.mockClear();
  auditEvents.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("flag OFF (default)", () => {
  it.each([
    ["set video", { video_agreement_v1: 75 }],
    ["set research", { research_synthesis_v1: 75 }],
    ["clear video", { video_agreement_v1: null }],
    ["malformed", { claim_verification_v1: "x" }],
  ])("%s → 403 family_thresholds_write_disabled, nothing saved", async (_l, map) => {
    const res = await post({ scoreFamilyReviewThresholds: map });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("family_thresholds_write_disabled");
    expect(savePolicy).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
  });

  it("a mixed legacy + family body is rejected whole (not partially applied)", async () => {
    const res = await post({ minConsensusToAvoidReview: 65, scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    expect(res.status).toBe(403);
    expect(savePolicy).not.toHaveBeenCalled();
  });

  it("legacy policy changes still work", async () => {
    const res = await post({ minConsensusToAvoidReview: 65 });
    expect(res.status).toBe(200);
    expect(savePolicy).toHaveBeenCalledTimes(1);
    expect(savePolicy.mock.calls[0][0]).toEqual({ minConsensusToAvoidReview: 65 });
    expect(savePolicy.mock.calls[0][4]).toEqual(["minConsensusToAvoidReview"]);
  });

  it("the legacy approval value stays accepted by the API for compatibility", async () => {
    const res = await post({ minConsensusToApprove: 85 });
    expect(res.status).toBe(200);
    expect(savePolicy.mock.calls[0][0]).toEqual({ minConsensusToApprove: 85 });
  });
});

describe("flag ON", () => {
  beforeEach(() => {
    flagOn = true;
  });

  it("set video → store receives the mutation and a dotted change name", async () => {
    const res = await post({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    expect(res.status).toBe(200);
    expect(savePolicy).toHaveBeenCalledTimes(1);
    expect(savePolicy.mock.calls[0][0]).toEqual({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    expect(savePolicy.mock.calls[0][4]).toEqual(["scoreFamilyReviewThresholds.video_agreement_v1"]);
    expect(auditEvents[0].changes).toEqual(["scoreFamilyReviewThresholds.video_agreement_v1"]);
  });

  it("set research + clear video in one save", async () => {
    const res = await post({ scoreFamilyReviewThresholds: { research_synthesis_v1: 64, video_agreement_v1: null } });
    expect(res.status).toBe(200);
    expect(savePolicy.mock.calls[0][0]).toEqual({ scoreFamilyReviewThresholds: { research_synthesis_v1: 64, video_agreement_v1: null } });
    expect(savePolicy.mock.calls[0][4]).toEqual([
      "scoreFamilyReviewThresholds.video_agreement_v1",
      "scoreFamilyReviewThresholds.research_synthesis_v1",
    ]);
  });

  it.each([
    ["claim key", { claim_verification_v1: 80 }],
    ["unknown key", { other_v1: 80 }],
    ["string", { video_agreement_v1: "75" }],
    ["-1", { video_agreement_v1: -1 }],
    ["101", { research_synthesis_v1: 101 }],
    ["array map", [75]],
    ["null map", null],
    ["empty map", {}],
  ])("%s → 400 validation_error, nothing saved", async (_l, map) => {
    const res = await post({ scoreFamilyReviewThresholds: map });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
    expect(savePolicy).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("returns the stored family map and the write capability (off)", async () => {
    loadPolicy.mockResolvedValue({ policyVersion: 3, minConsensusToAvoidReview: 70, scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } });
    const res = await GET(new NextRequest(URL_));
    expect(await res.json()).toEqual({
      ok: true,
      policy: { policyVersion: 3, minConsensusToAvoidReview: 70, scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } },
      capabilities: { familyReviewThresholdWritesEnabled: false },
    });
  });
  it("reports the capability on when the flag is on", async () => {
    flagOn = true;
    loadPolicy.mockResolvedValue({ policyVersion: 1 });
    const res = await GET(new NextRequest(URL_));
    expect((await res.json()).capabilities).toEqual({ familyReviewThresholdWritesEnabled: true });
  });
});
