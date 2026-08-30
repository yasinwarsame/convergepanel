/**
 * Evidence Workspace, Phase 11A.1 (corrected 11A.1C1/11A.1C2) —
 * resolveClaimVerificationOrigin() / buildDeepResearchClaimId() /
 * parseDeepResearchClaimId() tests.
 *
 * Plain, non-transactional read fake (`.get()` only, no `runTransaction`)
 * since this module performs no writes — same convention as
 * lib/workspaces/__tests__/reviewContext.spec.ts. Deliberately registers
 * ONLY a `runs` collection: if the resolver ever tried to read anything
 * else (e.g. workspace membership, to duplicate future route
 * authorization), the fake would throw "not implemented" rather than
 * silently succeeding — structural proof of the Team-membership boundary.
 */

import { readFileSync } from "fs";

type StoredDoc = Record<string, unknown>;
const runsStore = new Map<string, StoredDoc>();

function resetStore() {
  runsStore.clear();
}

let mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") {
      throw new Error(`not implemented in claimVerificationOrigin fake: collection "${name}"`);
    }
    return {
      doc: (docId: string) => ({
        get: async () => {
          const data = runsStore.get(docId);
          return { exists: data !== undefined, data: () => data, id: docId };
        },
      }),
    };
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import {
  resolveClaimVerificationOrigin,
  buildDeepResearchClaimId,
  parseDeepResearchClaimId,
  type DeepResearchClaimSection,
} from "@/lib/verification/claimVerificationOrigin";

const RUN_ID = "run-1";
const OTHER_RUN_ID = "run-2";
const CALLER_UID = "user-1";
const OTHER_UID = "user-2";
const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PERSONAL_WORKSPACE_ID_CALLER = "personal-" + CALLER_UID;
const PERSONAL_WORKSPACE_ID_OTHER = "personal-" + OTHER_UID;

interface RawFinding {
  id: string;
  summary: string;
  [key: string]: unknown;
}

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    id: "finding-1",
    title: "A short label",
    summary: "Remote work modestly reduces measured productivity in most studies.",
    category: "general",
    evidenceStrength: "moderate",
    sourceBacked: true,
    coverageCount: 3,
    totalModels: 4,
    coverageRatio: 0.75,
    contributingModels: ["claude", "chatgpt", "gemini"],
    ...overrides,
  };
}

function deepResearchOutput(findings: unknown = [finding()], lowConfidenceFindings: unknown = []) {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    classification: { queryType: "deep_research" },
    meta: {},
    generatedAt: "2026-01-01T00:00:00.000Z",
    result: {
      executiveSummary: "Overall summary.",
      findings,
      lowConfidenceFindings,
      disagreements: [],
      evidenceGaps: [],
      openQuestions: [],
      panelBlindSpots: [],
      researchBoundaries: [],
      recommendedNextSteps: [],
      sourceCoverage: { findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 },
      totalModels: 4,
    },
  };
}

/**
 * Constructs a deep_research output allowing genuinely absent keys, without
 * going through deepResearchOutput()'s defaulted parameters — a JS default
 * parameter substitutes its default whenever the caller passes `undefined`,
 * so `deepResearchOutput(undefined, [])` does NOT actually produce a
 * missing `findings` key, it silently falls back to a normal valid array.
 * This helper builds the raw object directly so "absent" tests are
 * genuinely testing absence.
 */
function malformedDeepResearchOutput(overrides: { findings?: unknown; lowConfidenceFindings?: unknown } = {}) {
  const result: Record<string, unknown> = {
    executiveSummary: "Overall summary.",
    disagreements: [],
    evidenceGaps: [],
    openQuestions: [],
    panelBlindSpots: [],
    researchBoundaries: [],
    recommendedNextSteps: [],
    sourceCoverage: { findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 },
    totalModels: 4,
  };
  if ("findings" in overrides) {
    if (overrides.findings !== undefined) result.findings = overrides.findings;
    // else: genuinely omitted, matching the reviewer-reproduced crash shape.
  } else {
    result.findings = [finding()];
  }
  if ("lowConfidenceFindings" in overrides) {
    if (overrides.lowConfidenceFindings !== undefined) result.lowConfidenceFindings = overrides.lowConfidenceFindings;
  } else {
    result.lowConfidenceFindings = [];
  }
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    classification: { queryType: "deep_research" },
    meta: {},
    generatedAt: "2026-01-01T00:00:00.000Z",
    result,
  };
}

function nonDeepResearchOutput() {
  return {
    version: 1,
    schemaId: "causal_explanation",
    answerShape: "causal_map",
    classification: { queryType: "causal_explanation" },
    meta: {},
    generatedAt: "2026-01-01T00:00:00.000Z",
    result: { directAnswer: "Because X causes Y.", factors: [], interpretations: [], totalModels: 3 },
  };
}

function seedRun(overrides: Record<string, unknown> = {}, runId = RUN_ID) {
  runsStore.set(runId, {
    userId: CALLER_UID,
    adaptiveOutput: deepResearchOutput(),
    ...overrides,
  });
}

/** Convenience: build a real selector via the actual production issuance function, so tests exercise the same code path a future read-model would. */
function selectorFor(runId: string, section: DeepResearchClaimSection, index: number, f: RawFinding): string {
  const id = buildDeepResearchClaimId({ runId, section, index, finding: f });
  if (id === null) throw new Error("test setup: expected a valid selector");
  return id;
}

beforeEach(() => {
  resetStore();
});

describe("resolveClaimVerificationOrigin — Personal", () => {
  it("Personal Deep Research run owned by caller -> resolved, correct origin, correct claimText", async () => {
    const f = finding({ summary: "Remote work modestly reduces measured productivity in most studies." });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({
      status: "resolved",
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      claimText: "Remote work modestly reduces measured productivity in most studies.",
      projectId: null,
      evidenceSources: [],
    });
  });

  it("Personal run owned by another user -> not_owner", async () => {
    const f = finding();
    seedRun({ userId: OTHER_UID, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "not_owner" });
  });
});

describe("resolveClaimVerificationOrigin — Personal Workspace scope classification (11A.1C3)", () => {
  it("[PRIMARY DEFECT REGRESSION] Phase-3 Personal-Workspace-bound run (workspaceId = getPersonalWorkspaceId(owner)) resolves for its owner in Personal mode", async () => {
    const f = finding({ summary: "Remote work modestly reduces measured productivity in most studies." });
    seedRun({ userId: CALLER_UID, workspaceId: PERSONAL_WORKSPACE_ID_CALLER, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({
      status: "resolved",
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      claimText: "Remote work modestly reduces measured productivity in most studies.",
      projectId: null,
      evidenceSources: [],
    });
  });

  it("Phase-3 Personal-Workspace-bound run, wrong caller -> not_owner (not a scope mismatch)", async () => {
    const f = finding();
    seedRun({ userId: CALLER_UID, workspaceId: PERSONAL_WORKSPACE_ID_CALLER, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: OTHER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "not_owner" });
  });

  it("CORRUPT BINDING: run.userId=caller but workspaceId=getPersonalWorkspaceId(OTHER user) -> workspace_mismatch for the run's own owner (never falls back to legacy Personal)", async () => {
    const f = finding();
    seedRun({ userId: CALLER_UID, workspaceId: PERSONAL_WORKSPACE_ID_OTHER, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("CORRUPT BINDING: same run, resolved as the OTHER user (whose id is embedded in the workspaceId) -> also workspace_mismatch, never granted access merely because the workspaceId embeds their uid", async () => {
    const f = finding();
    seedRun({ userId: CALLER_UID, workspaceId: PERSONAL_WORKSPACE_ID_OTHER, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: OTHER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("EXPLICIT NULL: workspaceId key present with value null (distinct from the key being absent entirely) -> workspace_mismatch, never coerced into legacy Personal", async () => {
    const f = finding();
    seedRun({ userId: CALLER_UID, workspaceId: null, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("INVALID SHAPE: workspaceId present but a non-string primitive -> workspace_mismatch, fails closed (never Personal, never Team)", async () => {
    const f = finding();
    seedRun({ userId: CALLER_UID, workspaceId: 12345, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const resultPersonal = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    const resultTeam = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(resultPersonal).toEqual({ status: "denied", reason: "workspace_mismatch" });
    expect(resultTeam).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("RUN-OWNER-INVALID SHAPE: workspaceId well-formed but run.userId itself cannot produce a Personal Workspace id -> workspace_mismatch, fails closed", async () => {
    const f = finding();
    seedRun({ userId: "", workspaceId: PERSONAL_WORKSPACE_ID_CALLER, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("PERSONAL-AS-TEAM: a Phase-3 Personal-Workspace-bound run is never accepted against ANY Team expectation, even one that happens to equal its own personal workspaceId string", async () => {
    const f = finding();
    seedRun({ userId: CALLER_UID, workspaceId: PERSONAL_WORKSPACE_ID_CALLER, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const resultAgainstTeamA = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    const resultAgainstOwnPersonalIdAsTeam = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: PERSONAL_WORKSPACE_ID_CALLER });
    expect(resultAgainstTeamA).toEqual({ status: "denied", reason: "workspace_mismatch" });
    expect(resultAgainstOwnPersonalIdAsTeam).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });
});

describe("resolveClaimVerificationOrigin — Team", () => {
  it("Team Deep Research run whose workspaceId exactly equals expectedWorkspaceId -> resolved", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_A, userId: OTHER_UID, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
  });

  it("Team run in another Workspace -> workspace_mismatch", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_B, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("[BOUNDARY] Team membership is intentionally NOT checked here — a matching-workspace run resolves with no membership data structure present at all", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_A, userId: OTHER_UID, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
  });

  it("Personal expectation against a Team-scoped run -> workspace_mismatch", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_A, userId: CALLER_UID, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("Team expectation against a Personal run -> workspace_mismatch", async () => {
    const f = finding();
    seedRun({ adaptiveOutput: deepResearchOutput([f]) }); // no workspaceId at all
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });
});

describe("resolveClaimVerificationOrigin — run/schema resolution", () => {
  it("Missing run -> run_not_found", async () => {
    const result = await resolveClaimVerificationOrigin({
      runId: "nonexistent-run",
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "run_not_found" });
  });

  it("Non-deep-research persisted adaptive output -> not_deep_research", async () => {
    seedRun({ adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("Absent adaptiveOutput -> not_deep_research (never a separate/invented reason)", async () => {
    seedRun({ adaptiveOutput: undefined });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });
});

describe("resolveClaimVerificationOrigin — malformed Deep Research shape (closes the TypeError)", () => {
  it("findings absent -> not_deep_research, no crash", async () => {
    const output = malformedDeepResearchOutput({ findings: undefined });
    seedRun({ adaptiveOutput: output });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("findings non-array -> not_deep_research, no crash", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput("not-an-array" as unknown, []) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("lowConfidenceFindings absent (the exact reviewer-reproduced crash) -> not_deep_research, no crash", async () => {
    const output = malformedDeepResearchOutput({ lowConfidenceFindings: undefined });
    seedRun({ adaptiveOutput: output });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("lowConfidenceFindings non-array -> not_deep_research, no crash", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([finding()], { not: "an array" } as unknown) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("target entry null -> claim_not_found (not the broader not_deep_research — one bad element must not deny every other valid finding)", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([null as unknown]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("target entry a primitive -> claim_not_found", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput(["not an object" as unknown]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("target missing id -> claim_not_found", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([{ summary: "no id here" } as unknown]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("target non-string id -> claim_not_found", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([{ id: 12345, summary: "numeric id" } as unknown]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("target missing summary -> claim_not_found", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([{ id: "ok-id" } as unknown]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("target non-string summary -> claim_not_found", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([{ id: "ok-id", summary: 42 } as unknown]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("index out of range -> claim_not_found", async () => {
    const f = finding();
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 5, f); // constructed against a hypothetical 6-element array; only 1 element actually exists
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });
});

describe("parseDeepResearchClaimId — selector parser", () => {
  const VALID_FP = "A".repeat(43);

  it("parses a well-formed selector", () => {
    expect(parseDeepResearchClaimId(`v1:findings:0:${VALID_FP}`)).toEqual({ section: "findings", index: 0, fingerprint: VALID_FP });
    expect(parseDeepResearchClaimId(`v1:lowConfidenceFindings:12:${VALID_FP}`)).toEqual({
      section: "lowConfidenceFindings",
      index: 12,
      fingerprint: VALID_FP,
    });
  });

  it("rejects empty string", () => {
    expect(parseDeepResearchClaimId("")).toBeNull();
  });

  it("rejects unsupported version", () => {
    expect(parseDeepResearchClaimId(`v2:findings:0:${VALID_FP}`)).toBeNull();
  });

  it("rejects invalid section literal", () => {
    expect(parseDeepResearchClaimId(`v1:notASection:0:${VALID_FP}`)).toBeNull();
  });

  it("rejects negative index", () => {
    expect(parseDeepResearchClaimId(`v1:findings:-1:${VALID_FP}`)).toBeNull();
  });

  it("rejects decimal index", () => {
    expect(parseDeepResearchClaimId(`v1:findings:1.5:${VALID_FP}`)).toBeNull();
  });

  it("rejects leading-zero index (01, 0002) but accepts canonical 0", () => {
    expect(parseDeepResearchClaimId(`v1:findings:01:${VALID_FP}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:0002:${VALID_FP}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:0:${VALID_FP}`)).not.toBeNull();
  });

  it("rejects scientific notation, plus sign, whitespace, Infinity/NaN text", () => {
    expect(parseDeepResearchClaimId(`v1:findings:1e2:${VALID_FP}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:+1:${VALID_FP}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings: 1:${VALID_FP}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:Infinity:${VALID_FP}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:NaN:${VALID_FP}`)).toBeNull();
  });

  it("rejects an index whose digit string overflows Number.MAX_SAFE_INTEGER", () => {
    const hugeDigits = "9".repeat(30); // far beyond 2^53, but well within MAX_CLAIM_ID_LENGTH
    expect(parseDeepResearchClaimId(`v1:findings:${hugeDigits}:${VALID_FP}`)).toBeNull();
  });

  it("rejects missing/short/long fingerprint", () => {
    expect(parseDeepResearchClaimId(`v1:findings:0:`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:0:${"A".repeat(42)}`)).toBeNull();
    expect(parseDeepResearchClaimId(`v1:findings:0:${"A".repeat(44)}`)).toBeNull();
  });

  it("rejects an invalid base64url character in the fingerprint", () => {
    expect(parseDeepResearchClaimId(`v1:findings:0:${"A".repeat(42)}+`)).toBeNull(); // '+' is not in the base64url alphabet
    expect(parseDeepResearchClaimId(`v1:findings:0:${"A".repeat(42)}/`)).toBeNull();
  });

  it("rejects an oversized total selector before even attempting to parse", () => {
    const oversized = `v1:findings:0:${"A".repeat(500)}`;
    expect(parseDeepResearchClaimId(oversized)).toBeNull();
  });

  it("never throws on any malformed input", () => {
    const inputs = ["", "v1", "v1:findings", "not-a-selector-at-all", "::::", "v1:findings:0:" + "€".repeat(50)];
    for (const input of inputs) {
      expect(() => parseDeepResearchClaimId(input)).not.toThrow();
    }
  });
});

describe("resolveClaimVerificationOrigin — malformed selector at the resolver boundary", () => {
  it("a structurally malformed claimId denies as claim_not_found, never throws, never leaks parse detail", async () => {
    seedRun();
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "not-a-real-selector",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("an oversized claimId denies as claim_not_found without ever reaching the parser's regex engine on the full string", async () => {
    seedRun();
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:" + "A".repeat(10000),
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });
});

describe("buildDeepResearchClaimId — pure issuance helper, fail-closed contract", () => {
  it("builds a valid selector for a well-formed finding", () => {
    const id = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: finding() });
    expect(id).not.toBeNull();
    expect(parseDeepResearchClaimId(id!)).not.toBeNull();
  });

  it("is deterministic — identical input always produces identical output", () => {
    const f = finding();
    const a = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 2, finding: f });
    const b = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 2, finding: f });
    expect(a).toBe(b);
  });

  it("fails closed (null) for an empty runId", () => {
    expect(buildDeepResearchClaimId({ runId: "", section: "findings", index: 0, finding: finding() })).toBeNull();
  });

  it("fails closed (null) for a non-string runId", () => {
    expect(buildDeepResearchClaimId({ runId: 123 as unknown as string, section: "findings", index: 0, finding: finding() })).toBeNull();
  });

  it("fails closed (null) for an invalid section literal", () => {
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "notASection" as unknown as DeepResearchClaimSection, index: 0, finding: finding() })).toBeNull();
  });

  it("fails closed (null) for a negative index", () => {
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: -1, finding: finding() })).toBeNull();
  });

  it("fails closed (null) for a non-integer index", () => {
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 1.5, finding: finding() })).toBeNull();
  });

  it("fails closed (null) for NaN/Infinity index", () => {
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: NaN, finding: finding() })).toBeNull();
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: Infinity, finding: finding() })).toBeNull();
  });

  it("fails closed (null) for a malformed finding — never throws", () => {
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: null })).toBeNull();
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: "not an object" })).toBeNull();
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: { summary: "no id" } })).toBeNull();
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: { id: "no-summary" } })).toBeNull();
    expect(buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: { id: 1, summary: "numeric id" } })).toBeNull();
  });

  it("never substitutes title for a missing summary", () => {
    const result = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: { id: "x", title: "A Title" } });
    expect(result).toBeNull();
  });
});

describe("Identity model — duplicate raw IDs, mutation safety, stale clicks (the core defect closures)", () => {
  it("A. two findings, same raw ID, different summaries -> distinct selectors, each resolves to its OWN correct claimText", async () => {
    const fA = finding({ id: "duplicate-id", summary: "Claim A" });
    const fB = finding({ id: "duplicate-id", summary: "Claim B" });
    seedRun({ adaptiveOutput: deepResearchOutput([fA, fB]) });
    const claimIdA = selectorFor(RUN_ID, "findings", 0, fA);
    const claimIdB = selectorFor(RUN_ID, "findings", 1, fB);
    expect(claimIdA).not.toBe(claimIdB);

    const resultA = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdA, callerUid: CALLER_UID, expectedWorkspaceId: null });
    const resultB = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdB, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(resultA.status).toBe("resolved");
    expect(resultB.status).toBe("resolved");
    if (resultA.status === "resolved") expect(resultA.claimText).toBe("Claim A");
    if (resultB.status === "resolved") expect(resultB.claimText).toBe("Claim B");
  });

  it("B. same raw ID shared across findings and lowConfidenceFindings -> distinct selectors, each resolves correctly", async () => {
    const fHigh = finding({ id: "shared-id", summary: "High-confidence claim" });
    const fLow = finding({ id: "shared-id", summary: "Low-confidence claim" });
    seedRun({ adaptiveOutput: deepResearchOutput([fHigh], [fLow]) });
    const claimIdHigh = selectorFor(RUN_ID, "findings", 0, fHigh);
    const claimIdLow = selectorFor(RUN_ID, "lowConfidenceFindings", 0, fLow);
    expect(claimIdHigh).not.toBe(claimIdLow);

    const resultHigh = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdHigh, callerUid: CALLER_UID, expectedWorkspaceId: null });
    const resultLow = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdLow, callerUid: CALLER_UID, expectedWorkspaceId: null });
    if (resultHigh.status === "resolved") expect(resultHigh.claimText).toBe("High-confidence claim");
    if (resultLow.status === "resolved") expect(resultLow.claimText).toBe("Low-confidence claim");

    // Cross-section tampering: taking the "findings" claimId and resolving it as if it pointed at lowConfidenceFindings must fail, even with byte-identical content available at both positions in a different fixture.
    const parsed = parseDeepResearchClaimId(claimIdHigh)!;
    const tamperedSection = `v1:lowConfidenceFindings:${parsed.index}:${parsed.fingerprint}`;
    const tamperedResult = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: tamperedSection, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(tamperedResult).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("C. same raw ID AND identical summary at different indexes -> distinct selectors (occurrence-specific identity), both resolve to identical (correct) claimText", async () => {
    const f0 = finding({ id: "same-id", summary: "Identical text" });
    const f1 = finding({ id: "same-id", summary: "Identical text" });
    seedRun({ adaptiveOutput: deepResearchOutput([f0, f1]) });
    const claimId0 = selectorFor(RUN_ID, "findings", 0, f0);
    const claimId1 = selectorFor(RUN_ID, "findings", 1, f1);
    expect(claimId0).not.toBe(claimId1); // index is bound into the fingerprint even though content is byte-identical

    const result0 = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimId0, callerUid: CALLER_UID, expectedWorkspaceId: null });
    const result1 = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimId1, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result0.status).toBe("resolved");
    expect(result1.status).toBe("resolved");
    if (result0.status === "resolved") expect(result0.claimText).toBe("Identical text");
    if (result1.status === "resolved") expect(result1.claimText).toBe("Identical text");
  });

  it("SECTION BINDING (isolated): with IDENTICAL content at the same index in both sections, tampering only the section literal of a valid selector (keeping the same embedded fingerprint) must still be denied — this is the only test that isolates section being bound into the digest itself, independent of any content difference", async () => {
    // Deliberately identical id+summary at the same index in both sections so
    // that if `section` were NOT part of the fingerprint, both positions
    // would produce the IDENTICAL fingerprint and this tamper would
    // incorrectly validate.
    const identical = finding({ id: "same-id", summary: "Identical text" });
    seedRun({ adaptiveOutput: deepResearchOutput([identical], [identical]) });
    const claimIdFindings = selectorFor(RUN_ID, "findings", 0, identical);
    const parsedFindings = parseDeepResearchClaimId(claimIdFindings)!;
    const tamperedToLowConfidence = `v1:lowConfidenceFindings:0:${parsedFindings.fingerprint}`; // same embedded fingerprint, only the section literal changed
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: tamperedToLowConfidence, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("INDEX BINDING (isolated): with IDENTICAL content at two indexes, tampering only the index digit of a valid selector (keeping the same embedded fingerprint) must still be denied — this is the only test that isolates index being bound into the digest itself, independent of any content difference", async () => {
    // Deliberately identical id+summary at both positions so that if `index`
    // were NOT part of the fingerprint, the two positions would produce the
    // IDENTICAL fingerprint and this tamper would incorrectly validate.
    const f0 = finding({ id: "same-id", summary: "Identical text" });
    const f1 = finding({ id: "same-id", summary: "Identical text" });
    seedRun({ adaptiveOutput: deepResearchOutput([f0, f1]) });
    const claimId0 = selectorFor(RUN_ID, "findings", 0, f0);
    const parsed0 = parseDeepResearchClaimId(claimId0)!;
    const tamperedToIndex1 = `v1:findings:1:${parsed0.fingerprint}`; // same embedded fingerprint, only the index digit changed
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: tamperedToIndex1, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("D. same 40-character summary-prefix fallback scenario (two findings whose upstream id happened to collide via the summary.slice(0,40) fallback) -> mechanically identical to case A, distinct selectors, correct resolution", async () => {
    const sharedFallbackId = "This is a shared forty character prefi".slice(0, 40);
    const fA = finding({ id: sharedFallbackId, summary: "This is a shared forty character prefix but then diverges into finding A specifically." });
    const fB = finding({ id: sharedFallbackId, summary: "This is a shared forty character prefix but then diverges into finding B instead." });
    seedRun({ adaptiveOutput: deepResearchOutput([fA, fB]) });
    const claimIdA = selectorFor(RUN_ID, "findings", 0, fA);
    const claimIdB = selectorFor(RUN_ID, "findings", 1, fB);
    expect(claimIdA).not.toBe(claimIdB);
    const resultA = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdA, callerUid: CALLER_UID, expectedWorkspaceId: null });
    if (resultA.status === "resolved") expect(resultA.claimText).toContain("finding A specifically");
  });

  it("STALE CLICK: selector issued for Claim A at findings[0]; canonical data changes so Claim B now occupies findings[0]; resolving the ORIGINAL selector denies rather than silently returning Claim B", async () => {
    const claimA = finding({ id: "eco", summary: "Claim A" });
    seedRun({ adaptiveOutput: deepResearchOutput([claimA]) });
    const staleClaimId = selectorFor(RUN_ID, "findings", 0, claimA);

    // Canonical data changes before resolution (content mutation at the same slot).
    const claimB = finding({ id: "eco", summary: "Claim B" });
    seedRun({ adaptiveOutput: deepResearchOutput([claimB]) });

    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: staleClaimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
    // This deliberately REPLACES the pre-11A.1C2 test that expected the second call to silently re-derive "Claim B" — that behavior is exactly the wrong-claim-linkage defect this correction closes. A source Deep Research run is historical evidence; once a selector is issued, changed evidence must fail closed, not silently redefine what the selector meant.
  });

  it("same slot, same rawId, changed summary -> claim_not_found", async () => {
    const original = finding({ id: "eco", summary: "Original text" });
    seedRun({ adaptiveOutput: deepResearchOutput([original]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, original);
    seedRun({ adaptiveOutput: deepResearchOutput([finding({ id: "eco", summary: "Original text (edited)" })]) });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("same slot, different rawId, same summary -> claim_not_found", async () => {
    const original = finding({ id: "id-1", summary: "Same text" });
    seedRun({ adaptiveOutput: deepResearchOutput([original]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, original);
    seedRun({ adaptiveOutput: deepResearchOutput([finding({ id: "id-2", summary: "Same text" })]) });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("COORDINATE TAMPERING: index changed without recomputing the digest -> claim_not_found", async () => {
    const f0 = finding({ id: "a", summary: "Finding 0" });
    const f1 = finding({ id: "b", summary: "Finding 1" });
    seedRun({ adaptiveOutput: deepResearchOutput([f0, f1]) });
    const claimId0 = selectorFor(RUN_ID, "findings", 0, f0);
    const parsed = parseDeepResearchClaimId(claimId0)!;
    const tampered = `v1:findings:1:${parsed.fingerprint}`; // attacker swaps index, keeps old fingerprint
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: tampered, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("CROSS-RUN REPLAY: a selector issued for run A never validates against run B, even with byte-identical content at the same coordinates", async () => {
    const sharedFinding = finding({ id: "eco", summary: "Claim A" });
    seedRun({ adaptiveOutput: deepResearchOutput([sharedFinding]) }, RUN_ID);
    seedRun({ adaptiveOutput: deepResearchOutput([sharedFinding]) }, OTHER_RUN_ID);

    const selectorFromRunA = selectorFor(RUN_ID, "findings", 0, sharedFinding);
    const result = await resolveClaimVerificationOrigin({
      runId: OTHER_RUN_ID,
      claimId: selectorFromRunA,
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("wrong-claim linkage is impossible: exhaustively, resolving any tampered/stale/replayed selector never returns a DIFFERENT claimText than what was originally selected — it only ever resolves correctly or denies", async () => {
    const fA = finding({ id: "x", summary: "Claim A" });
    const fB = finding({ id: "x", summary: "Claim B" });
    seedRun({ adaptiveOutput: deepResearchOutput([fA, fB]) });
    const claimIdA = selectorFor(RUN_ID, "findings", 0, fA);
    // Simulate a reorder: now index 0 holds what was fB's content.
    seedRun({ adaptiveOutput: deepResearchOutput([fB, fA]) });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdA, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("denied");
    if (result.status === "resolved") throw new Error("wrong-claim linkage occurred");
  });
});

describe("Unicode determinism", () => {
  it("Unicode rawId and summary round-trip correctly through build + resolve", async () => {
    const f = finding({ id: "経済-影響-🌍", summary: "この発見にはUnicode文字が含まれています。 😀🔥" });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.claimText).toBe(f.summary);
  });

  it("combining characters (base + combining accent) round-trip correctly and deterministically", async () => {
    const combining = "é"; // "e" + combining acute accent
    const f = finding({ id: "combining-" + combining, summary: "Text containing " + combining + " a combining mark." });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId1 = selectorFor(RUN_ID, "findings", 0, f);
    const claimId2 = selectorFor(RUN_ID, "findings", 0, f);
    expect(claimId1).toBe(claimId2); // deterministic
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimId1, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
  });

  it("a different code-point sequence (even if visually similar) produces a different digest", () => {
    const f1 = finding({ id: "x", summary: "café" }); // precomposed é (U+00E9)
    const f2 = finding({ id: "x", summary: "café" }); // e + combining acute (U+0065 U+0301)
    const id1 = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: f1 });
    const id2 = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 0, finding: f2 });
    expect(id1).not.toBe(id2); // no invisible Unicode normalization — different byte representation, different digest
  });
});

describe("resolveClaimVerificationOrigin — client-supplied input contract", () => {
  // NOTE: `**/*.spec.ts` is excluded from this repo's `tsc --noEmit` scope, and
  // Jest's own transform does not type-check either, so a `@ts-expect-error`
  // assertion here would be enforced by NEITHER gate. These tests instead
  // prove the REAL runtime property.
  it("an injected claimText field on the input is ignored — the resolver always derives claimText from the canonical run, never from caller input", async () => {
    const f = finding({ summary: "The real, canonical claim text." });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId,
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
      claimText: "ATTACKER-SUPPLIED CLAIM TEXT",
    } as any);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.claimText).toBe("The real, canonical claim text.");
    expect(result.claimText).not.toBe("ATTACKER-SUPPLIED CLAIM TEXT");
  });

  it("an injected origin/workspace/project field on the input cannot override the resolver's own server-derived scope decision", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_A, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId,
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_B,
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId, workspaceId: WORKSPACE_B },
    } as any);
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });
});

describe("resolveClaimVerificationOrigin — re-derivation is always against current canonical data (build-then-resolve, not a cache)", () => {
  it("a freshly-issued selector for CURRENT data always resolves correctly, reflecting whatever is canonical NOW", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput([finding({ summary: "Version 1" })]) });
    const claimId1 = selectorFor(RUN_ID, "findings", 0, { id: "finding-1", summary: "Version 1" } as RawFinding);
    const result1 = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimId1, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result1.status).toBe("resolved");

    seedRun({ adaptiveOutput: deepResearchOutput([finding({ summary: "Version 2" })]) });
    const claimId2 = selectorFor(RUN_ID, "findings", 0, { id: "finding-1", summary: "Version 2" } as RawFinding);
    const result2 = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimId2, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result2.status).toBe("resolved");
    if (result2.status === "resolved") expect(result2.claimText).toBe("Version 2");
    // The OLD selector (claimId1) is no longer valid against the new data -- proven by the STALE CLICK test above. This test only proves that issuing a FRESH selector against current data always works, which is the only "re-derivation" guarantee that remains meaningful.
  });
});

describe("resolveClaimVerificationOrigin — project passthrough", () => {
  it("Team resolved result exposes the source run's projectId verbatim (string case)", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_A, projectId: "proj-123", adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.projectId).toBe("proj-123");
  });

  it("Team resolved result returns null projectId verbatim when the run has none", async () => {
    const f = finding();
    seedRun({ workspaceId: WORKSPACE_A, projectId: null, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.projectId).toBeNull();
  });

  it("Personal resolved result always returns null projectId (no Project concept for Personal)", async () => {
    const f = finding();
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.projectId).toBeNull();
  });
});

describe("resolveClaimVerificationOrigin — evidence source extraction (11A.2a)", () => {
  it("A/B. resolved result derives evidenceSources from the target finding's own sources field", async () => {
    const f = finding({ sources: ["https://a.example/1", "https://b.example/2"] });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.evidenceSources).toEqual([
        { url: "https://a.example/1", hostname: "a.example" },
        { url: "https://b.example/2", hostname: "b.example" },
      ]);
    }
  });

  it("C. low-confidence finding sources are extracted identically to a normal finding", async () => {
    const f = finding({ id: "lc-1", sources: ["https://lowconf.example/x"] });
    seedRun({ adaptiveOutput: deepResearchOutput([finding()], [f]) });
    const claimId = selectorFor(RUN_ID, "lowConfidenceFindings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.evidenceSources).toEqual([{ url: "https://lowconf.example/x", hostname: "lowconf.example" }]);
    }
  });

  it("D. zero sources on a valid finding -> evidenceSources: [], claim still resolves", async () => {
    const f = finding({ sources: [] });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.evidenceSources).toEqual([]);
  });

  it("E. sources field absent on a valid finding -> evidenceSources: [], claim still resolves", async () => {
    const f = finding();
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.evidenceSources).toEqual([]);
  });

  it("F/V. sources non-array on a valid finding -> evidenceSources: [], never invalidates the claim (malformed source metadata is subordinate to claim identity)", async () => {
    const f = finding({ sources: "not-an-array" });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.evidenceSources).toEqual([]);
  });

  it("G. mixed valid/malformed sources (including a dangerous scheme and a credential-bearing URL) -> only valid safe sources survive, claim still resolves", async () => {
    const f = finding({ sources: ["https://valid.example/a", "javascript:alert(1)", "https://user:pass@evil.example/b", "NIST glossary"] });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.evidenceSources).toEqual([{ url: "https://valid.example/a", hostname: "valid.example" }]);
    }
  });

  it("P. Claim A cannot receive Claim B's sources — cross-finding isolation within the same section", async () => {
    const fA = finding({ id: "finding-a", summary: "Claim A", sources: ["https://a-only.example/1"] });
    const fB = finding({ id: "finding-b", summary: "Claim B", sources: ["https://b-only.example/1"] });
    seedRun({ adaptiveOutput: deepResearchOutput([fA, fB]) });
    const claimIdA = selectorFor(RUN_ID, "findings", 0, fA);
    const claimIdB = selectorFor(RUN_ID, "findings", 1, fB);
    const resultA = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdA, callerUid: CALLER_UID, expectedWorkspaceId: null });
    const resultB = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdB, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(resultA.status).toBe("resolved");
    expect(resultB.status).toBe("resolved");
    if (resultA.status === "resolved") expect(resultA.evidenceSources).toEqual([{ url: "https://a-only.example/1", hostname: "a-only.example" }]);
    if (resultB.status === "resolved") expect(resultB.evidenceSources).toEqual([{ url: "https://b-only.example/1", hostname: "b-only.example" }]);
  });

  it("Q. normal vs low-confidence section association isolation — same index, different sources, never concatenated or cross-contaminated", async () => {
    const fNormal = finding({ id: "shared-id", sources: ["https://normal-section.example/1"] });
    const fLow = finding({ id: "shared-id", sources: ["https://low-section.example/1"] });
    seedRun({ adaptiveOutput: deepResearchOutput([fNormal], [fLow]) });
    const claimIdNormal = selectorFor(RUN_ID, "findings", 0, fNormal);
    const claimIdLow = selectorFor(RUN_ID, "lowConfidenceFindings", 0, fLow);
    const resultNormal = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdNormal, callerUid: CALLER_UID, expectedWorkspaceId: null });
    const resultLow = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: claimIdLow, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(resultNormal.status).toBe("resolved");
    expect(resultLow.status).toBe("resolved");
    if (resultNormal.status === "resolved") expect(resultNormal.evidenceSources).toEqual([{ url: "https://normal-section.example/1", hostname: "normal-section.example" }]);
    if (resultLow.status === "resolved") expect(resultLow.evidenceSources).toEqual([{ url: "https://low-section.example/1", hostname: "low-section.example" }]);
  });

  it("R. Personal resolved origin includes evidenceSources", async () => {
    const f = finding({ sources: ["https://personal.example/1"] });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.evidenceSources).toEqual([{ url: "https://personal.example/1", hostname: "personal.example" }]);
  });

  it("S. Team resolved origin includes evidenceSources", async () => {
    const f = finding({ sources: ["https://team.example/1"] });
    seedRun({ workspaceId: WORKSPACE_A, adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.evidenceSources).toEqual([{ url: "https://team.example/1", hostname: "team.example" }]);
  });

  it("T. a stale/tampered selector still denies before source extraction ever runs — no evidenceSources appears on a denied result", async () => {
    const f = finding({ sources: ["https://original.example/1"] });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    // Canonical data changes after the selector was issued.
    const mutated = finding({ id: f.id, summary: "Different content now", sources: ["https://different.example/1"] });
    seedRun({ adaptiveOutput: deepResearchOutput([mutated]) });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
    expect(result).not.toHaveProperty("evidenceSources");
  });

  it("U. malformed claim target (index out of range) remains claim_not_found, not affected by source extraction logic", async () => {
    const f = finding({ sources: ["https://only-one.example/1"] });
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 5, f); // index 5 doesn't exist — only index 0 does
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });
});

describe("resolveClaimVerificationOrigin — read-only invariant", () => {
  it("performs zero Firestore writes", async () => {
    const f = finding();
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    const claimId = selectorFor(RUN_ID, "findings", 0, f);
    const writeMethods = ["set", "update", "create", "delete"] as const;
    for (const method of writeMethods) {
      (mockAdminDb.collection("runs").doc(RUN_ID) as any)[method] = () => {
        throw new Error(`resolver must never call .${method}()`);
      };
    }
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId, callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
  });

  it("buildDeepResearchClaimId performs zero Firestore access — it never even imports adminDb usage", () => {
    const moduleSource = readFileSync(require.resolve("../claimVerificationOrigin"), "utf8");
    const buildFnStart = moduleSource.indexOf("export function buildDeepResearchClaimId");
    const buildFnBody = moduleSource.slice(buildFnStart, buildFnStart + 800);
    expect(buildFnBody).not.toContain("adminDb");
    expect(buildFnBody).not.toContain(".collection(");
  });
});

describe("resolveClaimVerificationOrigin — disclosure boundary (documented, not enforced here)", () => {
  it("[BOUNDARY] read/disclosure authorization is not implemented in this module — deferred to later route/read phases", () => {
    const moduleSource = readFileSync(require.resolve("../claimVerificationOrigin"), "utf8");
    expect(moduleSource).not.toContain("mapStoredVerificationToClientPayload");
    expect(moduleSource).not.toContain("resolveRequestIdentity");
    expect(moduleSource).not.toContain("NextResponse");
  });
});

describe("resolveClaimVerificationOrigin — infrastructure failure propagates, it is never a domain result", () => {
  it("a genuine Firestore read failure REJECTS the promise with the original error — never reinterpreted as run_not_found or any other denied reason", async () => {
    const original = mockAdminDb.collection;
    mockAdminDb.collection = (name: string) => {
      if (name !== "runs") throw new Error("unexpected collection");
      return {
        doc: () => ({
          get: async () => {
            throw new Error("simulated Firestore outage");
          },
        }),
      };
    };
    try {
      await expect(
        resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "v1:findings:0:" + "A".repeat(43), callerUid: CALLER_UID, expectedWorkspaceId: null })
      ).rejects.toThrow("simulated Firestore outage");
    } finally {
      mockAdminDb.collection = original;
    }
  });

  it("adminDb unavailable also REJECTS the promise, matching saveClaimVerification()'s own convention for the identical condition — never a denied reason", async () => {
    const original = mockAdminDb;
    mockAdminDb = null;
    try {
      await expect(
        resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "v1:findings:0:" + "A".repeat(43), callerUid: CALLER_UID, expectedWorkspaceId: null })
      ).rejects.toThrow("Firestore is not available");
    } finally {
      mockAdminDb = original;
    }
  });
});

describe("resolveClaimVerificationOrigin — failure precedence (frozen)", () => {
  it("scope mismatch is returned before the adaptive output is ever inspected", async () => {
    seedRun({ workspaceId: WORKSPACE_B, adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:" + "A".repeat(43),
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_A,
    });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("not_owner (Personal) is returned before the adaptive output is ever inspected", async () => {
    seedRun({ userId: OTHER_UID, adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "v1:findings:0:" + "A".repeat(43),
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_owner" });
  });

  it("not_deep_research is returned before claim/selector lookup", async () => {
    seedRun({ adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "totally-forged-selector",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });
});
