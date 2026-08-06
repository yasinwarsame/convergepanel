/**
 * Phase 2 pilot history-reload fix — the full chain integration test.
 *
 * Every other test in this fix (persistedOutput.spec.ts,
 * adaptivePersistedOutputAdapter.spec.ts, legacyAdaptiveEnvelope.spec.ts,
 * legacyAdaptiveOutput.spec.ts, legacyAdaptiveHistoryReload.spec.ts) proves
 * one LAYER of the reload path in isolation. None of them prove the layers
 * actually compose correctly end to end — that a value shaped exactly like
 * what Firestore hands back, run through the REAL parser and the REAL
 * adapter, produces a payload the REAL AdaptivePanelResponse renderer
 * selects the procedural view for for. This file is that proof.
 *
 * Chain under test:
 *   raw Firestore-shaped value (JSON round-tripped, untyped)
 *     -> parsePersistedLegacyAdaptiveOutput()      [persistedOutput.ts]
 *     -> adaptPersistedLegacyOutputToPanelPayload() [adaptivePersistedOutputAdapter.ts]
 *     -> getResultSchema(payload.schemaId)          [schemaRegistry.ts — same call
 *                                                     site ResultsDisplay.tsx uses]
 *     -> <AdaptivePanelResponse ...payload />        [real renderer, renderToStaticMarkup]
 *
 * The acceptance bar this file exists to prove: a history-reloaded
 * procedural run renders the SAME primary content a live run does (Answer/
 * Models agree/disagree, Prerequisites, ordered Steps), never the legacy
 * Unified Answer shell, and never with raw JSON syntax anywhere in the
 * output.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { adaptPersistedLegacyOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";

/** JSON round-trip — the exact transform Firestore-stored data undergoes. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const CLASSIFICATION = {
  queryType: "procedural",
  domain: "software",
  answerShape: "step_diff",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "learn_process",
  confidence: 0.9,
  riskLevel: "professional",
  evidenceRequirement: "medium",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "test fixture",
};

/** A raw value shaped exactly like what runs/{runId}.legacyAdaptiveOutput holds on Firestore — untyped, as the API route reads it. */
function rawPersistedProceduralRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "procedural",
    classification: CLASSIFICATION,
    generatedAt: "2026-08-06T00:00:00.000Z",
    results: [
      {
        modelId: "chatgpt",
        schemaId: "procedural",
        ok: true,
        data: {
          goal: "Set up a new GitHub repository and push an initial commit.",
          prerequisites: ["Git installed", "GitHub account"],
          steps: [
            { order: 1, action: "Create a new repository on GitHub." },
            { order: 2, action: "Run git init in your project folder." },
          ],
          commonFailures: ["Forgetting to stage files before committing."],
        },
      },
      {
        modelId: "claude",
        schemaId: "procedural",
        ok: true,
        data: {
          goal: "Create a GitHub repository and push your first commit.",
          prerequisites: ["GitHub account created and logged in"],
          steps: [
            { order: 1, action: "Create new repository on GitHub via web interface" },
            { order: 2, action: "Initialize local repository with git init" },
          ],
          commonFailures: ["SSH key not configured."],
        },
      },
    ],
    alignedClaims: [
      {
        id: "step-1",
        claimText: "Create a new repository on GitHub.",
        cells: [
          { modelId: "chatgpt", stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "Create a new repository on GitHub." },
          { modelId: "claude", stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "Create new repository on GitHub via web interface" },
        ],
        agreementScore: 1,
        certaintyScore: 1,
        status: "consensus",
      },
    ],
    gate: { status: "pass", runCertainty: 0.85, loadBearingSplitCount: 0, loadBearingClaims: [] },
    synthesisReport: {
      unifiedAnswer: "Create a GitHub repository, initialize git locally, and push your first commit.",
      panelVerdict: "Panel converges on the core steps.",
      gate: "pass",
      runCertainty: 0.85,
      whereModelsAgree: ["Create a new repository on GitHub."],
      whereModelsDisagree: [],
      certaintyAssessment: "Run certainty 85% (gate: pass).",
      narrativeSections: [],
      executiveSummary: "Both models converge on the core repository setup steps.",
      disagreements: [],
      biasAndBlindSpots: [],
      biasEmptyReason: "insufficient_models",
      panelCoverageGaps: [],
      diagnostics: {
        citedClaimCount: 0,
        totalClaimCount: 1,
        evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 },
        homogeneityFlag: false,
        meanAgreement: 1,
      },
      verdictCard: {
        question: "How do I set up a GitHub repository and push an initial commit?",
        topConsensus: "Create a new repository on GitHub.",
        consensusModelCount: 2,
        keyDisagreement: null,
        disagreementDetail: null,
        disagreementModelCount: 0,
        caveat: null,
        recommendedNextSteps: [],
      },
      degraded: false,
    },
    trustSummary: {
      perModel: [
        { modelId: "chatgpt", claimsContributed: 4, majorityAlignment: 1, citationScore: 0, contradictionCount: 0, parseHealth: "ok", trustScore: 0.9, capped: false },
        { modelId: "claude", claimsContributed: 4, majorityAlignment: 1, citationScore: 0, contradictionCount: 0, parseHealth: "ok", trustScore: 0.9, capped: false },
      ],
      overallTrust: 0.9,
    },
    ...overrides,
  };
}

describe("Full chain: persisted record -> parse -> adapt -> renderer selection (procedural)", () => {
  it("a well-formed persisted record survives the full chain and renders the procedural view, not the legacy Unified Answer shell", () => {
    // Step 1: parse — exactly what GET /api/user/runs/[runId] does.
    const raw = roundTrip(rawPersistedProceduralRecord());
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // schemaId survives reload.
    expect(parsed.output.schemaId).toBe("procedural");

    // Step 2: adapt — exactly what app/page.tsx's openHistoryItem does.
    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    expect(payload.schemaId).toBe("procedural");
    // The adapter returns the SAME shape the live /api/run-panel response
    // uses — same top-level fields, not a different or partial contract.
    expect(payload.results).toBe(parsed.output.results);
    expect(payload.alignedClaims).toBe(parsed.output.alignedClaims);
    expect(payload.gate).toBe(parsed.output.gate);
    expect(payload.synthesisReport).toBe(parsed.output.synthesisReport);
    expect(payload.trustSummary).toBe(parsed.output.trustSummary);

    // Step 3: renderer selection — the exact call site
    // components/ResultsDisplay.tsx uses: schema={getResultSchema(adaptive.schemaId)}.
    const schema = getResultSchema(payload.schemaId);
    expect(schema.id).toBe("procedural");
    expect(schema.renderHint).toBe("step_diff");

    // Step 4: render with the REAL AdaptivePanelResponse component.
    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification: payload.classification,
        results: payload.results,
        alignedClaims: payload.alignedClaims,
        gate: payload.gate,
        synthesisReport: payload.synthesisReport,
        trustSummary: payload.trustSummary,
        question: "How do I set up a GitHub repository and push an initial commit?",
        runId: "run-123",
      })
    );

    // The procedural primary view rendered — PrimarySynthesisStrip's
    // Answer + Models agree/disagree, and StepDiffView's Prerequisites +
    // ordered steps — proving the procedural renderer was actually
    // selected, not merely that getResultSchema returned "procedural".
    expect(html).toMatch(/create a github repository, initialize git locally/i);
    expect(html).toMatch(/prerequisites/i);
    expect(html).toMatch(/git installed/i);
    expect(html).toMatch(/create a new repository on github/i);

    // The legacy Unified Answer shell never rendered — this is the exact
    // pre-fix symptom this test would have caught. These markers are
    // scoped to their exact legacy-shell heading tags (ResultsDisplay.tsx
    // lines ~1258/1383/1453/1330) precisely because "consensus"/"trust" as
    // bare words legitimately also appear in the new TopSummaryBar/Panel
    // Evidence content (e.g. a "Strong consensus" badge value) — a loose
    // substring match would false-positive against the correct new UI.
    expect(html).not.toMatch(/<h2[^>]*>\s*Unified Answer\s*<\/h2>/i);
    expect(html).not.toMatch(/<h4[^>]*>\s*Strong Consensus\s*<\/h4>/i);
    expect(html).not.toMatch(/<h4[^>]*>\s*Contested Areas\s*<\/h4>/i);
    expect(html).not.toMatch(/single-model \/ uncertain points/i);

    // No raw JSON syntax anywhere in the output — the literal JSON-leak
    // bug this fix exists to prevent. A real JSON.stringify of the raw
    // per-model data would contain `"goal":` (with the colon) verbatim;
    // the real renderer only ever displays goal/prerequisites/steps as
    // prose/list items, never as a serialized object.
    expect(html).not.toMatch(/"goal"\s*:/);
    expect(html).not.toMatch(/\{\s*"order"/);
  });

  it("secondary sections (Model Responses, Panel Evidence, Review & Governance) are present and collapsed after the full chain, matching live rendering", () => {
    const raw = roundTrip(rawPersistedProceduralRecord());
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    if (!parsed.ok) throw new Error("fixture must parse");
    const payload = adaptPersistedLegacyOutputToPanelPayload(parsed.output);
    const schema = getResultSchema(payload.schemaId);

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification: payload.classification,
        results: payload.results,
        alignedClaims: payload.alignedClaims,
        gate: payload.gate,
        synthesisReport: payload.synthesisReport,
        trustSummary: payload.trustSummary,
        question: "How do I set up a GitHub repository and push an initial commit?",
        runId: "run-123",
      })
    );

    expect(html).toMatch(/model responses/i);
    expect(html).toMatch(/panel evidence/i);
    expect(html).toMatch(/review.{0,10}governance/i);
    // Collapsed by default — no <details open> anywhere.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);

    // Raw model output is present (real per-model data, not a placeholder)
    // and explicitly labeled as raw/unreviewed.
    expect(html).toMatch(/raw model output/i);
  });

  it("malformed persisted data fails safely at the parse step — never reaches the adapter or renderer, never throws", () => {
    const malformed = roundTrip({ version: 1, schemaId: "procedural", classification: {}, generatedAt: "x" }); // missing results/alignedClaims/gate/synthesisReport
    expect(() => parsePersistedLegacyAdaptiveOutput(malformed)).not.toThrow();
    const parsed = parsePersistedLegacyAdaptiveOutput(malformed);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("malformed");
    // The chain stops here in production code (app/page.tsx only calls the
    // adapter when status === "valid") — proven by the source-level guard
    // regression test in app/__tests__/legacyAdaptiveHistoryReload.spec.ts.
  });

  it("absent persisted data (every procedural run made before this fix shipped) fails safely — never throws, never fabricates a payload", () => {
    expect(() => parsePersistedLegacyAdaptiveOutput(undefined)).not.toThrow();
    expect(parsePersistedLegacyAdaptiveOutput(undefined)).toEqual({ ok: false, reason: "absent" });
    expect(parsePersistedLegacyAdaptiveOutput(null)).toEqual({ ok: false, reason: "absent" });
  });

  it("a version this parser doesn't recognize fails safely as 'unsupported_version', never crashing the chain", () => {
    const futureVersion = roundTrip(rawPersistedProceduralRecord({ version: 2 }));
    const parsed = parsePersistedLegacyAdaptiveOutput(futureVersion);
    expect(parsed).toEqual({ ok: false, reason: "unsupported_version" });
  });
});

describe("Full chain: comparison_matrix (Milestone-2 path) is untouched by this fix", () => {
  it("comparison_matrix's own envelope/adapter/renderer chain still works, proving this fix's new procedural-only code path never interferes with the pre-existing Milestone-2 path", async () => {
    const { parsePersistedAdaptiveOutput } = await import("@/lib/adaptiveSchema/persistedOutput");
    const { adaptPersistedOutputToPanelPayload } = await import("@/lib/user/adaptivePersistedOutputAdapter");

    const raw = roundTrip({
      version: 1,
      schemaId: "comparison_matrix",
      answerShape: "comparison_grid",
      classification: { ...CLASSIFICATION, queryType: "comparison_matrix", answerShape: "comparison_grid" },
      meta: {
        schemaVersion: 1,
        queryType: "comparison_matrix",
        answerShape: "comparison_grid",
        dataBasis: "training_prior",
        freshness: "timeless",
        riskLevel: "professional",
        evidenceQuality: "not_applicable",
        uncertainties: [],
        blindSpots: [],
        humanReviewNeeded: false,
        generatedAt: "2026-08-06T00:00:00.000Z",
      },
      generatedAt: "2026-08-06T00:00:00.000Z",
      result: {
        subjects: [],
        lowConfidenceSubjects: [],
        attributes: [],
        lowConfidenceAttributes: [],
        cells: [],
        hasVerifiedSourceData: false,
        totalModels: 2,
        directConclusion: "Neither option is universally better.",
        tradeoffs: [],
        bestUseRecommendations: [],
        uncertainties: [],
      },
    });

    const parsed = parsePersistedAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const payload = adaptPersistedOutputToPanelPayload(parsed.output);
    const schema = getResultSchema(payload.schemaId);

    const html = renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema,
        classification: payload.classification,
        results: payload.results,
        comparisonMatrix: payload.comparisonMatrix,
        question: "Compare X and Y",
        runId: "run-456",
      })
    );

    expect(html).toMatch(/neither option is universally better/i);
    // The Milestone-2 chain is a totally separate code path from
    // legacyAdaptiveOutput/parsePersistedLegacyAdaptiveOutput — this test
    // exercises none of the new code this fix added.
  });
});
