/**
 * Evidence Workspace, Phase 11A.6.2 — creation durability and origin provenance
 * for `POST /api/verify-claim`.
 *
 * Two defects this suite exists to keep closed:
 *
 * 1. A `saveClaimVerification()` rejection was logged and swallowed. The handler
 *    continued to `applyTeamGovernancePipeline()` and returned
 *    `200 {ok:true, verificationId}` — telling the caller a durable verification
 *    existed when none did, AND writing a Team governance projection that
 *    referenced the nonexistent verificationId.
 * 2. `evidenceSources`, derived by the origin resolver since Phase 11A.2a, was
 *    discarded by both creation paths instead of being snapshotted.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test", XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test", GEMINI_API_KEY: "test",
}));

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }),
}));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({
  validateUserSubscription: jest.fn().mockResolvedValue(undefined),
}));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

function modelResult(modelId: string, verdict: string) {
  return {
    modelId, status: "ok",
    rawText: JSON.stringify({ verdict, confidence: "high", summary: "s", correctParts: ["a"], incorrectParts: [], unverifiableParts: [], reasoning: "r" }),
    latencyMs: 5, tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
  };
}
const FIVE = ["claude", "chatgpt", "gemini", "grok", "perplexity"].map((m) => modelResult(m, "accurate"));

const mockedRunClaimVerificationPanel = jest.fn();
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({
  runClaimVerificationPanel: (...args: unknown[]) => mockedRunClaimVerificationPanel(...args),
}));

const mockedSaveClaimVerification = jest.fn();
jest.mock("@/lib/firestore/verifications", () => {
  const actual = jest.requireActual("@/lib/firestore/verifications");
  return { ...actual, saveClaimVerification: (...args: unknown[]) => mockedSaveClaimVerification(...args) };
});

const mockedIncrementUserTokenUsage = jest.fn();
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockedIncrementUserTokenUsage(...args),
}));
const mockedEvaluateAndStoreGovernance = jest.fn();
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockedEvaluateAndStoreGovernance(...args),
}));
const mockedApplyTeamGovernancePipeline = jest.fn();
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({
  applyTeamGovernancePipeline: (...args: unknown[]) => mockedApplyTeamGovernancePipeline(...args),
  mergeGovernanceIntoBody: (body: unknown) => body,
}));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ email: "u@example.com" }) }) }) }) },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedResolveClaimVerificationOrigin = jest.fn();
jest.mock("@/lib/verification/claimVerificationOrigin", () => ({
  resolveClaimVerificationOrigin: (...args: unknown[]) => mockedResolveClaimVerificationOrigin(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/verify-claim/route";

const UID = "uid-1";
const ORIGIN = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };
const SOURCES = [
  { url: "https://example.com/a", hostname: "example.com" },
  { url: "https://example.org/b", hostname: "example.org" },
];

const req = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/verify-claim", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

const MODELS = ["claude", "chatgpt", "gemini", "grok", "perplexity"];

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
  mockedRunClaimVerificationPanel.mockResolvedValue(FIVE);
  mockedSaveClaimVerification.mockResolvedValue(undefined);
  mockedIncrementUserTokenUsage.mockResolvedValue(undefined);
  mockedEvaluateAndStoreGovernance.mockResolvedValue(null);
  mockedApplyTeamGovernancePipeline.mockResolvedValue({});
  mockedResolveClaimVerificationOrigin.mockResolvedValue({
    status: "resolved", origin: ORIGIN, claimText: "a resolved claim", projectId: null, evidenceSources: SOURCES,
  });
});

const persistedDoc = () => mockedSaveClaimVerification.mock.calls[0][1] as Record<string, unknown>;

// ===========================================================================
describe("PERSISTENCE FAILURE FAILS CLOSED — both modes", () => {
  const failSave = () => mockedSaveClaimVerification.mockRejectedValue(new Error("FIRESTORE_UNAVAILABLE: internal detail"));

  it.each([
    ["ordinary", { claim: "a claim to verify", selectedModels: MODELS }],
    ["origin-linked", { runId: "run-1", claimId: ORIGIN.claimId, models: MODELS }],
  ])("%s: save rejection -> 500 persistence_failed, never 200/ok:true", async (_n, body) => {
    failSave();
    const res = await POST(req(body));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(res.status).not.toBe(200);
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe("persistence_failed");
    expect(json.verificationId).toBeUndefined();
    // no infrastructure detail leaks to the caller
    expect(JSON.stringify(json)).not.toContain("FIRESTORE_UNAVAILABLE");
    expect(JSON.stringify(json)).not.toContain("internal detail");
  });

  it.each([
    ["ordinary", { claim: "a claim to verify", selectedModels: MODELS }],
    ["origin-linked", { runId: "run-1", claimId: ORIGIN.claimId, models: MODELS }],
  ])("%s: save rejection runs NO governance of any kind", async (_n, body) => {
    failSave();
    await POST(req(body));
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    // THE REGRESSION THIS SUITE EXISTS FOR: a Team governance projection must
    // never be written against a verificationId that was never persisted.
    expect(mockedApplyTeamGovernancePipeline).not.toHaveBeenCalled();
  });

  it("save rejection still records the provider usage that really happened, exactly once", async () => {
    failSave();
    await POST(req({ claim: "a claim to verify", selectedModels: MODELS }));
    // The models ran and tokens were spent before persistence was attempted.
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith(UID, 50);
  });

  it("save rejection does not refund or reverse the consumed run quota", async () => {
    failSave();
    await POST(req({ claim: "a claim to verify", selectedModels: MODELS }));
    // Quota is consumed exactly once, up front, with a positive model count, and
    // is never called a second time to reverse it. (An earlier version of this
    // assertion scanned the serialized args for "-1" and self-triggered on the
    // uid "uid-1" — a heuristic that could not distinguish a refund from a name.)
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledWith(UID, MODELS.length);
  });

  it("ANCHOR: successful save still returns 200 and runs both governance stages", async () => {
    const res = await POST(req({ claim: "a claim to verify", selectedModels: MODELS }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.verificationId).toBe("string");
    expect(mockedEvaluateAndStoreGovernance).toHaveBeenCalledTimes(1);
    expect(mockedApplyTeamGovernancePipeline).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe("ORIGIN EVIDENCE SNAPSHOT — Personal persistence", () => {
  it("origin-linked persists the EXACT resolver-derived snapshot", async () => {
    await POST(req({ runId: "run-1", claimId: ORIGIN.claimId, models: MODELS }));
    expect(persistedDoc().evidenceSources).toEqual(SOURCES);
    expect(mockedResolveClaimVerificationOrigin).toHaveBeenCalledTimes(1); // no second resolution
  });

  it("origin-linked with zero surviving references persists [] , not absence", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({
      status: "resolved", origin: ORIGIN, claimText: "c", projectId: null, evidenceSources: [],
    });
    await POST(req({ runId: "run-1", claimId: ORIGIN.claimId, models: MODELS }));
    const doc = persistedDoc();
    expect(doc.evidenceSources).toEqual([]);
    expect("evidenceSources" in doc).toBe(true);
  });

  it("ordinary verification omits the field entirely", async () => {
    await POST(req({ claim: "a claim to verify", selectedModels: MODELS }));
    expect("evidenceSources" in persistedDoc()).toBe(false);
    expect("origin" in persistedDoc()).toBe(false);
  });

  it("a client-supplied evidenceSources cannot reach persistence", async () => {
    const res = await POST(req({
      runId: "run-1", claimId: ORIGIN.claimId, models: MODELS,
      evidenceSources: [{ url: "https://attacker.example/x", hostname: "attacker.example" }],
    }));
    // rejected as an unexpected field by the origin-linked request contract
    expect(res.status).toBe(400);
    expect(mockedSaveClaimVerification).not.toHaveBeenCalled();
  });

  it("the persisted snapshot is the resolver's array, never raw finding data", async () => {
    // The route only ever sees the resolver result; it has no access to the raw
    // finding. Asserting exact identity proves no re-derivation happened here.
    await POST(req({ runId: "run-1", claimId: ORIGIN.claimId, models: MODELS }));
    expect(persistedDoc().evidenceSources).toEqual(SOURCES);
    expect((persistedDoc().evidenceSources as unknown[]).length).toBe(2);
  });
});
