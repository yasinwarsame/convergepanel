/**
 * Evidence Workspace, Phase 11A.1 — resolveClaimVerificationOrigin() tests.
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
import type { AggregatedResearchFinding, DeepResearchResult, CausalExplanationResult } from "@/lib/adaptiveSchema/types";

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

import { resolveClaimVerificationOrigin, findClaimInDeepResearchFindings } from "@/lib/verification/claimVerificationOrigin";

const RUN_ID = "run-1";
const CALLER_UID = "user-1";
const OTHER_UID = "user-2";
const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";

function finding(overrides: Partial<AggregatedResearchFinding> = {}): AggregatedResearchFinding {
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

function deepResearchOutput(overrides: Partial<DeepResearchResult> = {}, findings: AggregatedResearchFinding[] = [finding()]) {
  const result: DeepResearchResult = {
    executiveSummary: "Overall summary.",
    findings,
    lowConfidenceFindings: [],
    disagreements: [],
    evidenceGaps: [],
    openQuestions: [],
    panelBlindSpots: [],
    researchBoundaries: [],
    recommendedNextSteps: [],
    sourceCoverage: { findingsWithSources: findings.length, totalFindings: findings.length, coverageRatio: 1 },
    totalModels: 4,
    ...overrides,
  };
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
  const result: CausalExplanationResult = {
    directAnswer: "Because X causes Y.",
    factors: [],
    interpretations: [],
    totalModels: 3,
  } as unknown as CausalExplanationResult;
  return {
    version: 1,
    schemaId: "causal_explanation",
    answerShape: "causal_map",
    classification: { queryType: "causal_explanation" },
    meta: {},
    generatedAt: "2026-01-01T00:00:00.000Z",
    result,
  };
}

function seedRun(overrides: Record<string, unknown> = {}) {
  runsStore.set(RUN_ID, {
    userId: CALLER_UID,
    adaptiveOutput: deepResearchOutput(),
    ...overrides,
  });
}

beforeEach(() => {
  resetStore();
});

describe("resolveClaimVerificationOrigin — Personal", () => {
  it("1. Personal Deep Research run owned by caller -> resolved, correct origin, correct claimText", async () => {
    seedRun();
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({
      status: "resolved",
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId: "finding-1" },
      claimText: "Remote work modestly reduces measured productivity in most studies.",
      projectId: null,
    });
  });

  it("2. Personal run owned by another user -> not_owner", async () => {
    seedRun({ userId: OTHER_UID });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_owner" });
  });
});

describe("resolveClaimVerificationOrigin — Team", () => {
  it("3. Team Deep Research run whose workspaceId exactly equals expectedWorkspaceId -> resolved", async () => {
    seedRun({ workspaceId: WORKSPACE_A, userId: OTHER_UID }); // owner is irrelevant for Team scope
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_A,
    });
    expect(result.status).toBe("resolved");
  });

  it("4. Team run in another Workspace -> workspace_mismatch", async () => {
    seedRun({ workspaceId: WORKSPACE_B });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_A,
    });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("5. [BOUNDARY] Team membership is intentionally NOT checked here — a matching-workspace run resolves with no membership data structure present at all", async () => {
    // The fake registers ONLY a `runs` collection (see mockAdminDb above). If
    // the resolver ever attempted to read workspaceMemberships (or any other
    // collection) to duplicate the route's future Gate-1/Gate-2 check, this
    // test would throw "not implemented" instead of resolving successfully.
    seedRun({ workspaceId: WORKSPACE_A, userId: OTHER_UID }); // caller is NOT the run's owner and has no seeded membership anywhere
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_A,
    });
    expect(result.status).toBe("resolved");
  });

  it("18. Personal expectation against a Team-scoped run -> workspace_mismatch", async () => {
    seedRun({ workspaceId: WORKSPACE_A, userId: CALLER_UID });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("19. Team expectation against a Personal run -> workspace_mismatch", async () => {
    seedRun(); // no workspaceId field at all
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_A,
    });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });
});

describe("resolveClaimVerificationOrigin — run/schema/claim resolution", () => {
  it("6. Forged/missing claimId -> claim_not_found", async () => {
    seedRun();
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "does-not-exist",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "claim_not_found" });
  });

  it("7. Missing run -> run_not_found", async () => {
    const result = await resolveClaimVerificationOrigin({
      runId: "nonexistent-run",
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "run_not_found" });
  });

  it("8. Non-deep-research persisted adaptive output -> not_deep_research", async () => {
    seedRun({ adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("8b. Absent adaptiveOutput -> not_deep_research (never a separate/invented reason)", async () => {
    seedRun({ adaptiveOutput: undefined });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("8c. Malformed adaptiveOutput -> not_deep_research", async () => {
    seedRun({ adaptiveOutput: { version: 1, schemaId: "deep_research", answerShape: "deep_research_view" /* missing result */ } });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });

  it("9. claimText equals finding.summary, and NOT finding.title", async () => {
    seedRun({
      adaptiveOutput: deepResearchOutput({}, [finding({ title: "Short label, not a claim", summary: "The actual standalone factual claim." })]),
    });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.claimText).toBe("The actual standalone factual claim.");
    expect(result.claimText).not.toBe("Short label, not a claim");
  });

  it("finds a claim in lowConfidenceFindings too, not only findings", async () => {
    seedRun({
      adaptiveOutput: deepResearchOutput(
        { lowConfidenceFindings: [finding({ id: "low-conf-1", summary: "A lower-coverage finding." })] },
        [] // findings empty on purpose
      ),
    });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "low-conf-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.claimText).toBe("A lower-coverage finding.");
  });
});

describe("resolveClaimVerificationOrigin — client-supplied input contract", () => {
  // NOTE: `**/*.spec.ts` is excluded from this repo's `tsc --noEmit` scope
  // (tsconfig.json), and Jest's own transform does not type-check either —
  // so a `@ts-expect-error`-only assertion here would be enforced by
  // NEITHER gate and would be silently vacuous (verified directly: adding
  // `claimText?`/`origin?` to the resolver's parameter type produced zero
  // failures anywhere in this repo's actual validation pipeline). These
  // tests instead prove the REAL runtime property: even a caller that
  // bypasses TypeScript entirely (plain JS, or `as any`) and injects extra
  // fields cannot influence the resolved output — defense in depth, not
  // just a type-level promise.
  it("10. an injected claimText field on the input is ignored — the resolver always derives claimText from the canonical run, never from caller input", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput({}, [finding({ summary: "The real, canonical claim text." })]) });
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: null,
      claimText: "ATTACKER-SUPPLIED CLAIM TEXT",
    } as any);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.claimText).toBe("The real, canonical claim text.");
    expect(result.claimText).not.toBe("ATTACKER-SUPPLIED CLAIM TEXT");
  });

  it("an injected origin/workspace/project/creator field on the input cannot override the resolver's own server-derived scope decision", async () => {
    seedRun({ workspaceId: WORKSPACE_A }); // a genuine Team run in WORKSPACE_A
    const result = await resolveClaimVerificationOrigin({
      runId: RUN_ID,
      claimId: "finding-1",
      callerUid: CALLER_UID,
      expectedWorkspaceId: WORKSPACE_B, // caller claims to expect a DIFFERENT workspace
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId: "finding-1", workspaceId: WORKSPACE_B },
    } as any);
    // The injected `origin` object claims WORKSPACE_B; the resolver must still
    // compare the REAL run's workspace (WORKSPACE_A) against expectedWorkspaceId
    // (WORKSPACE_B) and deny — proving the injected field has zero effect.
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });
});

describe("resolveClaimVerificationOrigin — re-derivation, not a cache", () => {
  it("11. Mutating the source run's adaptiveOutput between two calls changes the second call's result (live derivation, not a cache)", async () => {
    seedRun({ adaptiveOutput: deepResearchOutput({}, [finding({ summary: "Original summary." })]) });
    const first = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(first.status).toBe("resolved");
    if (first.status === "resolved") expect(first.claimText).toBe("Original summary.");

    seedRun({ adaptiveOutput: deepResearchOutput({}, [finding({ summary: "Updated summary after the run changed." })]) });
    const second = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(second.status).toBe("resolved");
    if (second.status === "resolved") expect(second.claimText).toBe("Updated summary after the run changed.");

    // The IMMUTABLE historical record is the verification document's own
    // `claim` field, written once at creation time in a later phase — this
    // resolver itself has no memory and correctly reflects current data.
  });
});

describe("resolveClaimVerificationOrigin — project passthrough", () => {
  it("12/13. Team resolved result exposes the source run's projectId verbatim (string case)", async () => {
    seedRun({ workspaceId: WORKSPACE_A, projectId: "proj-123" });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.projectId).toBe("proj-123");
  });

  it("12/13. Team resolved result returns null projectId verbatim when the run has none", async () => {
    seedRun({ workspaceId: WORKSPACE_A, projectId: null });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.projectId).toBeNull();
  });

  it("Personal resolved result always returns null projectId (no Project concept for Personal)", async () => {
    seedRun();
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") expect(result.projectId).toBeNull();
  });
});

describe("resolveClaimVerificationOrigin — legacy compatibility", () => {
  it("14/15. A legacy ClaimVerificationFirestoreDoc-shaped fixture with no `origin` field remains a valid, unrelated concern to this resolver", () => {
    // This resolver never reads verification documents at all — it only
    // ever reads `runs/{runId}`. A legacy verification document (no
    // `origin` field) is untouched and unaffected by this module's
    // existence; asserted here as a structural fact about the persistence
    // type, not a resolver behavior.
    const legacyDoc: { userId: string; claim: string } = { userId: CALLER_UID, claim: "A pre-existing claim with no origin." };
    expect("origin" in legacyDoc).toBe(false);
  });
});

describe("resolveClaimVerificationOrigin — read-only invariant", () => {
  it("16. Resolver performs zero Firestore writes", async () => {
    seedRun();
    const writeMethods = ["set", "update", "create", "delete"] as const;
    for (const method of writeMethods) {
      (mockAdminDb.collection("runs").doc(RUN_ID) as any)[method] = () => {
        throw new Error(`resolver must never call .${method}()`);
      };
    }
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result.status).toBe("resolved");
  });
});

describe("resolveClaimVerificationOrigin — disclosure boundary (documented, not enforced here)", () => {
  it("17. [BOUNDARY] read/disclosure authorization is not implemented in this module — deferred to later route/read phases", () => {
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
        resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null })
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
        resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null })
      ).rejects.toThrow("Firestore is not available");
    } finally {
      mockAdminDb = original;
    }
  });
});

describe("findClaimInDeepResearchFindings — pure helper", () => {
  it("matches only by exact id, never by title/summary text or array position", () => {
    const findings = [finding({ id: "a", summary: "First" }), finding({ id: "b", summary: "Second" })];
    expect(findClaimInDeepResearchFindings(findings, "b")?.summary).toBe("Second");
    expect(findClaimInDeepResearchFindings(findings, "nonexistent")).toBeNull();
    expect(findClaimInDeepResearchFindings(findings, "First")).toBeNull(); // never matches by summary text
  });
});

describe("resolveClaimVerificationOrigin — failure precedence (frozen)", () => {
  it("scope mismatch is returned before the adaptive output is ever inspected (non-deep-research run in the wrong workspace still reports workspace_mismatch, not not_deep_research)", async () => {
    seedRun({ workspaceId: WORKSPACE_B, adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: WORKSPACE_A });
    expect(result).toEqual({ status: "denied", reason: "workspace_mismatch" });
  });

  it("not_owner (Personal) is returned before the adaptive output is ever inspected", async () => {
    seedRun({ userId: OTHER_UID, adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "finding-1", callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "not_owner" });
  });

  it("not_deep_research is returned before claim lookup (wrong schema + forged claimId still reports not_deep_research)", async () => {
    seedRun({ adaptiveOutput: nonDeepResearchOutput() });
    const result = await resolveClaimVerificationOrigin({ runId: RUN_ID, claimId: "totally-forged", callerUid: CALLER_UID, expectedWorkspaceId: null });
    expect(result).toEqual({ status: "denied", reason: "not_deep_research" });
  });
});
