/**
 * Query-Routing Redesign, Phase 1 — adaptPersistedOutputToPanelPayload()
 * tests. Proves each of the 9 schemas maps to the correct named field on
 * AdaptivePanelPayload (the same shape AdaptivePanelResponse.tsx's existing,
 * unchanged renderer routing already dispatches on for a LIVE run) — i.e.
 * history restoration reaches the correct dedicated renderer without any
 * new renderer-selection logic.
 */

import { adaptPersistedOutputToPanelPayload, adaptPersistedLegacyOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import {
  parsePersistedLegacyAdaptiveOutput,
  PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS,
  PersistedAdaptiveOutput,
  PersistedAdaptiveSchemaId,
  PersistedLegacyAdaptiveOutputV1,
  SCHEMA_ANSWER_SHAPE,
} from "@/lib/adaptiveSchema/persistedOutput";

const CLASSIFICATION = {
  queryType: "decision_support",
  domain: "test",
  answerShape: "decision_support_view",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "make_decision",
  confidence: 0.9,
  riskLevel: "professional",
  evidenceRequirement: "medium",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "test fixture",
} as PersistedAdaptiveOutput["classification"];

const META = {
  schemaVersion: 1,
  queryType: "decision_support",
  answerShape: "decision_support_view",
  dataBasis: "training_prior",
  freshness: "timeless",
  riskLevel: "professional",
  evidenceQuality: "not_applicable",
  uncertainties: [],
  blindSpots: [],
  humanReviewNeeded: false,
  generatedAt: "2026-07-28T00:00:00.000Z",
} as PersistedAdaptiveOutput["meta"];

const RESULT_FIELD_BY_SCHEMA: Record<PersistedAdaptiveSchemaId, string> = {
  ranked_enumeration: "rankedEnumeration",
  comparison_matrix: "comparisonMatrix",
  definition_explanation: "definitionExplanation",
  causal_explanation: "causalExplanation",
  checklist_taxonomy: "checklistTaxonomy",
  deep_research: "deepResearch",
  evidence_review: "evidenceReview",
  bias_blindspot_audit: "biasBlindspotAudit",
  decision_support: "decisionSupport",
};

const ALL_SCHEMA_IDS = Object.keys(SCHEMA_ANSWER_SHAPE) as PersistedAdaptiveSchemaId[];

describe("adaptPersistedOutputToPanelPayload", () => {
  it.each(ALL_SCHEMA_IDS)("%s: maps to the correct named field, matching a live run's payload shape", (schemaId) => {
    const marker = { __marker: schemaId };
    const output = {
      version: 1,
      schemaId,
      answerShape: SCHEMA_ANSWER_SHAPE[schemaId],
      classification: CLASSIFICATION,
      meta: META,
      generatedAt: META.generatedAt,
      result: marker,
    } as unknown as PersistedAdaptiveOutput;

    const payload = adaptPersistedOutputToPanelPayload(output);

    expect(payload.schemaId).toBe(schemaId);
    expect(payload.classification).toBe(CLASSIFICATION);
    // No per-model raw adaptive data is persisted — deliberate, see the
    // adapter's own module doc for why this is safe.
    expect(payload.results).toEqual([]);

    const fieldName = RESULT_FIELD_BY_SCHEMA[schemaId] as keyof typeof payload;
    expect((payload as Record<string, unknown>)[fieldName]).toBe(marker);

    // Every OTHER schema-specific field must stay unset — restoring a
    // decision_support run must never also populate rankedEnumeration, etc.
    for (const [otherSchemaId, otherFieldName] of Object.entries(RESULT_FIELD_BY_SCHEMA)) {
      if (otherSchemaId === schemaId) continue;
      expect((payload as Record<string, unknown>)[otherFieldName]).toBeUndefined();
    }
  });
});

/**
 * Phase 2 pilot history-reload fix — adaptPersistedLegacyOutputToPanelPayload()
 * tests. Proves the persisted procedural fields (results/alignedClaims/
 * gate/synthesisReport/trustSummary) survive the history adapter intact,
 * landing on the SAME AdaptivePanelPayload top-level fields a live
 * procedural run's response already populates — no new renderer-selection
 * logic, no re-derivation, no JSON string anywhere in the output.
 */
describe("adaptPersistedLegacyOutputToPanelPayload", () => {
  const LEGACY_OUTPUT = {
    version: 1,
    schemaId: "procedural",
    classification: CLASSIFICATION,
    generatedAt: "2026-08-06T00:00:00.000Z",
    results: [{ modelId: "chatgpt", schemaId: "procedural", ok: true, data: { goal: "Set up a repo.", prerequisites: ["Git"], steps: [], commonFailures: [] } }],
    alignedClaims: [{ id: "c1", claimText: "Step 1", cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
    gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] },
    synthesisReport: {
      unifiedAnswer: "Do the thing in order.",
      panelVerdict: "Panel converges.",
      gate: "pass",
      runCertainty: 0.8,
      whereModelsAgree: [],
      whereModelsDisagree: [],
      certaintyAssessment: "x",
      narrativeSections: [],
      executiveSummary: "x",
      disagreements: [],
      biasAndBlindSpots: [],
      biasEmptyReason: "insufficient_models",
      panelCoverageGaps: [],
      diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.8 },
      verdictCard: { question: "q", topConsensus: "x", consensusModelCount: 2, keyDisagreement: null, disagreementDetail: null, disagreementModelCount: 0, caveat: null, recommendedNextSteps: [] },
      degraded: false,
    },
    trustSummary: { perModel: [], overallTrust: 0.8 },
  } as unknown as PersistedLegacyAdaptiveOutputV1;

  it("maps schemaId, classification, and every claim-matrix field onto AdaptivePanelPayload's top-level fields — the SAME fields a live procedural run's response populates", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);

    expect(payload.schemaId).toBe("procedural");
    expect(payload.classification).toBe(CLASSIFICATION);
    expect(payload.results).toBe(LEGACY_OUTPUT.results);
    expect(payload.alignedClaims).toBe(LEGACY_OUTPUT.alignedClaims);
    expect(payload.gate).toBe(LEGACY_OUTPUT.gate);
    expect(payload.synthesisReport).toBe(LEGACY_OUTPUT.synthesisReport);
    expect(payload.trustSummary).toBe(LEGACY_OUTPUT.trustSummary);
    expect(payload.persistenceStatus).toBe("saved");
  });

  it("results are real per-model AdaptiveModelResult objects, not an empty placeholder — Model Responses' raw-output section needs real data to render on reload, unlike the 9-schema adapter above", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].data).toEqual({ goal: "Set up a repo.", prerequisites: ["Git"], steps: [], commonFailures: [] });
  });

  it("no field on the payload ever contains a raw JSON string — every field is the already-parsed, already-typed object the live run produced", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);
    const serialized = JSON.stringify(payload);
    // A raw, unparsed JSON-shaped model answer would show up as a doubly-
    // escaped string fragment like `\"goal\":` inside the outer JSON —
    // this proves `results[].data` is a real object, never a string.
    expect(serialized).not.toMatch(/\\"goal\\"/);
    expect(typeof payload.results[0].data).toBe("object");
  });

  it("threads humanReview/reviewRouting through when provided, same contract as the 9-schema adapter", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT, {
      humanReview: { status: "unreviewed" },
      reviewRouting: "not_configured",
    });
    expect(payload.humanReview).toEqual({ status: "unreviewed" });
    expect(payload.reviewRouting).toBe("not_configured");
  });

  it("leaves every Milestone-2-only field (rankedEnumeration, comparisonMatrix, etc.) unset — procedural must never populate a field only the 9 dedicated schemas use", () => {
    const payload = adaptPersistedLegacyOutputToPanelPayload(LEGACY_OUTPUT);
    for (const fieldName of Object.values(RESULT_FIELD_BY_SCHEMA)) {
      expect((payload as Record<string, unknown>)[fieldName]).toBeUndefined();
    }
  });
});

/**
 * Batch 3 persistence foundation (2C-1) — History-chain tests (Part 9-D).
 * Traces the real chain a persisted Batch 3 run goes through on History
 * reload: a raw Firestore-shaped envelope → JSON round-trip → the real
 * parsePersistedLegacyAdaptiveOutput() → the real
 * adaptPersistedLegacyOutputToPanelPayload() → the resulting panel payload.
 * Proves schema identity, aligned claims, gate, synthesis report, and trust
 * summary all survive the full chain for every one of the 8 schemas this
 * envelope now covers — not just that each function works in isolation.
 */
const CHAIN_TEST_SYNTHESIS_REPORT = {
  panelVerdict: "Panel converges.",
  gate: "pass",
  runCertainty: 0.8,
  whereModelsAgree: [],
  whereModelsDisagree: [],
  certaintyAssessment: "x",
  narrativeSections: [],
  executiveSummary: "x",
  disagreements: [],
  biasAndBlindSpots: [],
  biasEmptyReason: "insufficient_models",
  panelCoverageGaps: [],
  diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.8 },
  verdictCard: { question: "q", topConsensus: "x", consensusModelCount: 2, keyDisagreement: null, disagreementDetail: null, disagreementModelCount: 0, caveat: null, recommendedNextSteps: [] },
  degraded: false,
};

const CHAIN_TEST_PROCEDURAL_OUTPUT = {
  version: 1,
  schemaId: "procedural",
  classification: CLASSIFICATION,
  generatedAt: "2026-08-06T00:00:00.000Z",
  results: [{ modelId: "chatgpt", schemaId: "procedural", ok: true, data: { goal: "Set up a repo.", prerequisites: ["Git"], steps: [], commonFailures: [] } }],
  alignedClaims: [{ id: "c1", claimText: "Step 1", cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
  gate: { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] },
  synthesisReport: { ...CHAIN_TEST_SYNTHESIS_REPORT, unifiedAnswer: "Do the thing in order." },
  trustSummary: { perModel: [], overallTrust: 0.8 },
} as unknown as PersistedLegacyAdaptiveOutputV1;

describe("History chain — persisted envelope → parser → adapter → panel payload (Batch 3 persistence foundation, 2C-1)", () => {
  function buildRawLegacyEnvelope(schemaId: PersistedLegacyAdaptiveOutputV1["schemaId"]) {
    const base: Record<string, unknown> = {
      version: 1,
      schemaId,
      classification: { ...CLASSIFICATION, queryType: schemaId },
      generatedAt: "2026-08-08T00:00:00.000Z",
      results: [{ modelId: "chatgpt", schemaId, ok: true, data: { marker: schemaId } }],
      alignedClaims: [{ id: "c1", claimText: `Claim for ${schemaId}`, cells: [], agreementScore: 1, certaintyScore: 1, status: "consensus" }],
    };
    // creative_generative never computes gate/synthesisReport, live or
    // historical (see persistedOutput.ts's PersistedLegacyAdaptiveOutputV1
    // doc) — every other schema in the family does.
    if (schemaId !== "creative_generative") {
      base.gate = { status: "pass", runCertainty: 0.8, loadBearingSplitCount: 0, loadBearingClaims: [] };
      base.synthesisReport = { ...CHAIN_TEST_SYNTHESIS_REPORT, unifiedAnswer: `Unified answer for ${schemaId}` };
      base.trustSummary = { perModel: [], overallTrust: 0.8 };
    } else {
      base.alignedClaims = [];
    }
    return base;
  }

  it.each(PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS.map((id) => [id]))(
    "'%s': schema identity, version, and every claim-matrix field survive persisted-envelope -> JSON round-trip -> parser -> adapter -> panel payload",
    (schemaId) => {
      const raw = JSON.parse(JSON.stringify(buildRawLegacyEnvelope(schemaId)));

      const parsed = parsePersistedLegacyAdaptiveOutput(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.output.schemaId).toBe(schemaId);
      expect(parsed.output.classification.queryType).toBe(schemaId);

      const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);

      expect(payload.schemaId).toBe(schemaId);
      expect(payload.classification.queryType).toBe(schemaId);
      expect(payload.results.length).toBeGreaterThan(0);
      expect(payload.alignedClaims).toEqual(parsed.output.alignedClaims);

      if (schemaId === "creative_generative") {
        expect(payload.gate).toBeUndefined();
        expect(payload.synthesisReport).toBeUndefined();
        expect(payload.trustSummary).toBeUndefined();
      } else {
        expect(payload.gate).toEqual(parsed.output.gate);
        expect(payload.synthesisReport?.unifiedAnswer).toBe(`Unified answer for ${schemaId}`);
        expect(payload.trustSummary).toEqual(parsed.output.trustSummary);
      }

      // Every Milestone-2-only field must stay unset — a legacy-family
      // history restore must never also populate rankedEnumeration, etc.
      for (const fieldName of Object.values(RESULT_FIELD_BY_SCHEMA)) {
        expect((payload as Record<string, unknown>)[fieldName]).toBeUndefined();
      }
    }
  );

  it("an old procedural-only record (no other schema present) still parses and adapts exactly as it did before this widening — backward compatibility", () => {
    const raw = JSON.parse(JSON.stringify(CHAIN_TEST_PROCEDURAL_OUTPUT));
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    expect(payload.schemaId).toBe("procedural");
    expect(payload.gate).toEqual(CHAIN_TEST_PROCEDURAL_OUTPUT.gate);
  });
});

/**
 * Batch 3 persistence foundation (2C-1), Part 7/9-F — factual_lookup
 * regression protection. Proves the persisted structured result still
 * represents the actual direct answer — not a generic "Answer" or
 * "Jurisdiction" placeholder label — after the FULL chain: a real
 * `alignScalarField`-shaped claim row (id: "answer", claimText: the real
 * model answer text — see fieldAlignment.ts's own doc on why claimText is
 * never the label) → JSON round-trip → parser → adapter → panel payload.
 * DirectAnswerCard.tsx's headline logic is
 * `alignedClaims?.find(c => c.id === "answer")?.claimText || ok[0]?.data?.answer`
 * — this test proves that lookup still resolves to the real answer after
 * reload, the exact regression the historical "Answer"/"Jurisdiction" label
 * bug this fix must never reintroduce.
 */
describe("factual_lookup — Claim Text regression protection (Batch 3 persistence foundation, 2C-1)", () => {
  const FACTUAL_LOOKUP_OUTPUT = {
    version: 1,
    schemaId: "factual_lookup",
    classification: { ...CLASSIFICATION, queryType: "factual_lookup" },
    generatedAt: "2026-08-08T00:00:00.000Z",
    results: [
      { modelId: "chatgpt", schemaId: "factual_lookup", ok: true, data: { answer: "The Eiffel Tower is 330 meters tall.", source: "widely cited reference", caveat: "none" } },
      { modelId: "claude", schemaId: "factual_lookup", ok: true, data: { answer: "The Eiffel Tower is 330 meters tall.", source: "widely cited reference", caveat: "none" } },
    ],
    // Real alignScalarField output shape: id is the row id ("answer"), never
    // the display label ("Answer") — claimText is the real model text.
    alignedClaims: [
      {
        id: "answer",
        claimText: "The Eiffel Tower is 330 meters tall.",
        cells: [],
        agreementScore: 1,
        certaintyScore: 1,
        status: "consensus",
      },
    ],
    gate: { status: "pass", runCertainty: 0.9, loadBearingSplitCount: 0, loadBearingClaims: [] },
    synthesisReport: { ...CHAIN_TEST_SYNTHESIS_REPORT, unifiedAnswer: "The Eiffel Tower is 330 meters tall." },
    trustSummary: { perModel: [], overallTrust: 0.9 },
  } as unknown as PersistedLegacyAdaptiveOutputV1;

  it("the real answer text survives persisted-envelope -> JSON round-trip -> parser -> adapter, at the exact id ('answer') DirectAnswerCard looks up", () => {
    const raw = JSON.parse(JSON.stringify(FACTUAL_LOOKUP_OUTPUT));
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);

    // The exact lookup DirectAnswerCard.tsx performs.
    const answerRow = payload.alignedClaims?.find((c) => c.id === "answer");
    const headlineAnswer = answerRow?.claimText || (payload.results[0]?.data as Record<string, unknown> | undefined)?.["answer"];

    expect(headlineAnswer).toBe("The Eiffel Tower is 330 meters tall.");
  });

  it("regression pin: the reconstructed headline never falls back to the generic 'Answer' or 'Jurisdiction' labels — the historical bug this fix must not reintroduce", () => {
    const raw = JSON.parse(JSON.stringify(FACTUAL_LOOKUP_OUTPUT));
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    const answerRow = payload.alignedClaims?.find((c) => c.id === "answer");
    const headlineAnswer = answerRow?.claimText || (payload.results[0]?.data as Record<string, unknown> | undefined)?.["answer"];

    expect(headlineAnswer).not.toBe("Answer");
    expect(headlineAnswer).not.toBe("Jurisdiction");
    expect(String(headlineAnswer)).not.toMatch(/^(Answer|Jurisdiction)$/);
  });

  it("schema identity ('factual_lookup') and the full claims-matrix shape survive the chain intact, same guarantee every other Batch 3 schema gets", () => {
    const raw = JSON.parse(JSON.stringify(FACTUAL_LOOKUP_OUTPUT));
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.output.schemaId).toBe("factual_lookup");
    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    expect(payload.schemaId).toBe("factual_lookup");
    expect(payload.gate).toEqual(FACTUAL_LOOKUP_OUTPUT.gate);
    expect(payload.synthesisReport?.unifiedAnswer).toBe("The Eiffel Tower is 330 meters tall.");
  });
});
