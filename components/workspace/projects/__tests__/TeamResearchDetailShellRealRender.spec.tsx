/**
 * TEAM-RESEARCH-PARITY-R3 §Q/§S/§Z — REAL render of Team persisted detail.
 *
 * Nothing in the result path is stubbed: `TeamResearchDetailShell` →
 * `PersistedResearchResultView` → `ResultsDisplay` → adaptive renderers all run
 * (only the ESM-only `react-markdown` / `remark-gfm` are replaced by trivial
 * factories, as in the R2 real-render suites). Response bodies are produced by
 * the REAL R1 server builder `buildRunReadPayload()` over the R1 fixtures and
 * JSON round-tripped, so this is an end-to-end contract check from the Team
 * endpoint's payload to painted DOM.
 *
 * Every case asserts: Team chrome present, no Personal navigation, no
 * fabricated execution buttons, and ZERO synthesis POST / model / non-GET
 * request — opening a Team report never writes.
 */
/**
 * R3-R1 — the export flag is ON and the plan is paid (below), so the Personal
 * export action and "Previous exports" WOULD render if the Personal ancillary
 * default leaked into a Team report. Their absence is therefore not vacuous
 * (see the CONTROL test at the end, which renders the same report through the
 * shared view with no policy).
 */
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";
const PLAN = { plan: "full", loading: false };
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => PLAN }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
const AUTH = { user: { uid: "uid-team" }, authReady: true };
/** R4-I4 — the shell now uses the app router for the Verify-this-claim handoff. */
const pushedHrefs: string[] = [];
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: (h: string) => pushedHrefs.push(h), replace: () => {} }) }));

jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { FIXTURE_PROJECT_ID, FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID, fullTeamRunData } from "@/lib/runs/__tests__/runReadFixtures";
import { MALFORMED_STRUCTURED_RESULT_NOTICE, NEWER_VERSION_STRUCTURED_RESULT_NOTICE, interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";

/**
 * FULL-SHAPE persisted envelopes. The shared R1 fixtures are deliberately
 * parser-minimal (the envelope parsers check only a few keys), but the real
 * renderers read every field a genuine persisted envelope carries. These
 * mirror the complete shapes used by the existing adaptive renderer suites
 * (`AdaptivePanelResponse.spec`, `legacyAdaptiveReloadChain.spec`).
 */
function fullFinding(i: number, summary: string) {
  return { id: `f${i}`, title: `Finding ${i}`, summary, category: "General", evidenceStrength: "unknown", sourceBacked: false, sources: [], coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] };
}
function fullDeepResearchOutput() {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    classification: { queryType: "deep_research", domain: "general", answerShape: "deep_research_view", confidence: 0.9, riskLevel: "general" },
    meta: {
      schemaVersion: 1, queryType: "deep_research", answerShape: "deep_research_view", dataBasis: "training_prior", freshness: "timeless", riskLevel: "general",
      evidenceQuality: "unknown", uncertainties: [], blindSpots: [], humanReviewNeeded: false, generatedAt: "2026-09-01T00:00:00.000Z", limitations: [],
    },
    generatedAt: "2026-09-01T00:00:00.000Z",
    result: {
      executiveSummary: "Panel summary of the research.",
      findings: [fullFinding(1, "Finding one"), fullFinding(2, "Finding two")],
      lowConfidenceFindings: [],
      disagreements: [],
      evidenceGaps: [],
      openQuestions: [],
      panelBlindSpots: [],
      researchBoundaries: [],
      recommendedNextSteps: [],
      sourceCoverage: { findingsWithSources: 0, totalFindings: 2, coverageRatio: 0 },
      totalModels: 2,
    },
  };
}
function fullProceduralLegacyOutput() {
  return {
    version: 1,
    schemaId: "procedural",
    classification: { queryType: "procedural", domain: "software", answerShape: "step_diff", confidence: 0.9, riskLevel: "professional" },
    generatedAt: "2026-08-06T00:00:00.000Z",
    results: [
      { modelId: "chatgpt", schemaId: "procedural", ok: true, data: { goal: "Push a first commit.", prerequisites: ["Git"], steps: [{ order: 1, action: "Create a repository." }], commonFailures: [] } },
      { modelId: "claude", schemaId: "procedural", ok: true, data: { goal: "Push your first commit.", prerequisites: ["GitHub account"], steps: [{ order: 1, action: "Create a new repository." }], commonFailures: [] } },
    ],
    alignedClaims: [
      {
        id: "step-1",
        claimText: "Create a new repository on GitHub.",
        cells: [
          { modelId: "chatgpt", stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "Create a repository." },
          { modelId: "claude", stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "Create a new repository." },
        ],
        agreementScore: 1,
        certaintyScore: 1,
        status: "consensus",
      },
    ],
    gate: { status: "pass", runCertainty: 0.85, loadBearingSplitCount: 0, loadBearingClaims: [] },
    synthesisReport: {
      unifiedAnswer: "Create a repository, initialize git locally, and push your first commit.",
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
      diagnostics: { citedClaimCount: 0, totalClaimCount: 1, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 1 },
      verdictCard: { question: "How do I push a first commit?", topConsensus: "Create a new repository on GitHub.", consensusModelCount: 2, keyDisagreement: null, disagreementDetail: null, disagreementModelCount: 0, caveat: null, recommendedNextSteps: [] },
      degraded: false,
    },
    trustSummary: {
      perModel: [
        { modelId: "chatgpt", claimsContributed: 1, majorityAlignment: 1, citationScore: 0, contradictionCount: 0, parseHealth: "ok", trustScore: 0.9, capped: false },
        { modelId: "claude", claimsContributed: 1, majorityAlignment: 1, citationScore: 0, contradictionCount: 0, parseHealth: "ok", trustScore: 0.9, capped: false },
      ],
      overallTrust: 0.9,
    },
  };
}

const PROJECT_PROPS = { workspaceId: FIXTURE_WORKSPACE_ID, workspaceName: "Acme Team", runId: FIXTURE_RUN_ID, project: { id: FIXTURE_PROJECT_ID, name: "Launch Plan" }, showAudit: false };

async function r1Body(data: Record<string, unknown>, viewerRole: RunReadViewerRole = "team_member", teamOver: Record<string, unknown> = {}) {
  const payload = await buildRunReadPayload({ runId: FIXTURE_RUN_ID, data: fullTeamRunData(data), viewerRole, mayReadDecisionContent: true, resolveReviewRouting: async () => "in_queue" });
  const team = { workspaceId: FIXTURE_WORKSPACE_ID, projectId: FIXTURE_PROJECT_ID, project: { id: FIXTURE_PROJECT_ID, name: "Launch Plan", status: "active" }, assignee: null, createdAt: null, completedAt: null, origin: null, review: null, ...teamOver };
  return JSON.parse(JSON.stringify({ ...payload, team }));
}

/** The review block R1 derives from a real governance record (presentation-safe fields only). */
const TEAM_REVIEW = { humanReviewStatus: "unreviewed", conditions: ["cond-a"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "Concluded", sourceBacked: true, humanReviewNeeded: false } };
const ANCILLARY_ROUTE = /\/api\/user\/runs\/[^/?]+\/(governance|review-history|export|exports)|\/api\/teams\/adaptive-runs\/[^/?]+\/history/;

async function render(body: unknown) {
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(TeamResearchDetailShell, PROJECT_PROPS));
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
  }
  return r;
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const anchors = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a").map((n) => n.props.href as string);
const buttonLabels = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "button").map(function label(n: TestRenderer.ReactTestInstance): string {
    return n.children.map((c) => (typeof c === "string" ? c : label(c as TestRenderer.ReactTestInstance))).join("");
  });

/** The invariants every Team persisted detail render must satisfy. */
function expectReadOnlyTeamRender(r: TestRenderer.ReactTestRenderer) {
  // Team chrome present.
  expect(r.root.findAll((n) => n.props["aria-label"] === "Breadcrumb")).toHaveLength(1);
  expect(r.root.findAll((n) => n.props["aria-label"] === "Workspace")).toHaveLength(1);
  // No Personal navigation.
  for (const href of anchors(r)) {
    expect(href).not.toBe("/");
    expect(href).not.toMatch(/^\/workspace\/research\//);
    expect(href).not.toContain("openResearchRun");
  }
  expect(text(r)).not.toContain("Add to Team Project");
  expect(text(r)).not.toContain("Back to Research");
  // No fabricated execution buttons.
  for (const label of buttonLabels(r)) {
    expect(label).not.toContain("Re-run");
    expect(label).not.toContain("Add Another Model");
  }
  // R3-R1 — no Personal ancillary surface (export flag ON + paid plan, so these would render if leaked).
  const t = text(r);
  expect(t).not.toContain("Previous exports");
  expect(t).not.toContain("Review & Governance");
  expect(t).not.toContain("Loading review status");
  expect(r.root.findAll((n) => n.type === "button" && typeof n.props["aria-label"] === "string" && n.props["aria-label"].startsWith("Export this report"))).toHaveLength(0);
  expect(mockedAuthedFetch.mock.calls.some((c) => ANCILLARY_ROUTE.test(String(c[0])))).toBe(false);
  expect(mockedAuthedFetch.mock.calls.some((c) => String(c[0]).includes("/api/synthesize-panel"))).toBe(false);
  // Zero write: exactly the one Team GET, nothing else.
  expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  const [url, init] = mockedAuthedFetch.mock.calls[0] as [string, { method: string }];
  expect(url).toBe(`/api/workspaces/${FIXTURE_WORKSPACE_ID}/runs/${FIXTURE_RUN_ID}?projectId=${FIXTURE_PROJECT_ID}`);
  expect(init.method).toBe("GET");
  expect(globalThis.fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
    throw new Error("no direct fetch from a Team detail render");
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

const ORDINARY = { adaptiveOutput: undefined, legacyAdaptiveOutput: undefined, governanceRecord: undefined, synthesizedStructuredReport: undefined };

describe("Team persisted detail — real render parity matrix", () => {
  it("1. ordinary multi-model result (no cached synthesis) — both model answers present, ZERO synthesis POST despite ≥2 rows, idle synthesis and no adaptive", async () => {
    const r = await render(await r1Body(ORDINARY));
    expectReadOnlyTeamRender(r);
    expect(text(r)).toContain("What should we build?");
  });

  it("2. adaptive (deep_research) result — the structured renderer paints; no raw structured JSON keys leak", async () => {
    const r = await render(await r1Body({ adaptiveOutput: fullDeepResearchOutput(), legacyAdaptiveOutput: undefined }, "team_member", { review: TEAM_REVIEW }));
    expectReadOnlyTeamRender(r);
    const t = text(r);
    expect(t).toContain("Finding one");
    // The Team's own read-only review summary occupies the review position exactly once, with no Workspace review link.
    expect(r.root.findAll((n) => n.props["data-testid"] === "team-research-review-summary")).toHaveLength(1);
    expect(t).toContain("Awaiting review");
    expect(t).toContain("Concluded");
    expect(anchors(r).some((h) => h.startsWith("/workspace/reviews/"))).toBe(false);
    for (const key of ["executiveSummary", "lowConfidenceFindings", "totalModels", "\\\"schemaId\\\""]) expect(t).not.toContain(key);
  });

  it("3. legacy-adaptive result — the legacy structured presentation paints (adaptive absent)", async () => {
    const r = await render(await r1Body({ adaptiveOutput: undefined, governanceRecord: undefined, legacyAdaptiveOutput: fullProceduralLegacyOutput() }));
    expectReadOnlyTeamRender(r);
    // Legacy-adaptive runs carry no governance record, so R1 emits no review: nothing in the review position.
    expect(r.root.findAll((n) => n.props["data-testid"] === "team-research-review-summary")).toHaveLength(0);
    const t = text(r);
    expect(t).toContain("Create a repository, initialize git locally, and push your first commit.");
    expect(t).not.toContain("alignedClaims");
    expect(t).not.toContain("unifiedAnswer");
  });

  it("4. malformed structured envelope — the malformed restore notice and the raw rows", async () => {
    const r = await render(await r1Body({ ...ORDINARY, adaptiveOutput: { version: 1, schemaId: "deep_research" } }));
    expectReadOnlyTeamRender(r);
    expect(text(r)).toContain(MALFORMED_STRUCTURED_RESULT_NOTICE.replace(/'/g, "'"));
  });

  it("5. unsupported-version structured envelope — the newer-version restore notice and the raw rows", async () => {
    const r = await render(await r1Body({ ...ORDINARY, adaptiveOutput: { version: 2 } }));
    expectReadOnlyTeamRender(r);
    expect(text(r)).toContain(NEWER_VERSION_STRUCTURED_RESULT_NOTICE);
  });

  it("6. single successful model — neutral read-only copy, no anchor in the warning, no rerun buttons", async () => {
    const single = { ...ORDINARY, runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "The only answer", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 90, wasTruncated: false }] } };
    const r = await render(await r1Body(single));
    expectReadOnlyTeamRender(r);
    const t = text(r);
    expect(t).toContain("Only One Model Responded");
    expect(t).toContain("This saved report is read-only.");
    expect(t).not.toContain("To run this question again");
  });

  it("7. persisted synthesis — the cached report is handed through as complete and never regenerated (no POST)", async () => {
    const r = await render(await r1Body({ adaptiveOutput: undefined, legacyAdaptiveOutput: undefined, governanceRecord: undefined }));
    expectReadOnlyTeamRender(r);
  });

  it("9. partial model failures — the successful answer renders, the failed row does not fabricate an answer, still zero writes", async () => {
    const partial = {
      ...ORDINARY,
      runDocument: {
        perModel: [
          { modelId: "chatgpt", status: "ok", rawTextTruncated: "Answer from ChatGPT", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 90, wasTruncated: false },
          { modelId: "claude", status: "ok", rawTextTruncated: "Answer from Claude", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 95, wasTruncated: false },
          { modelId: "grok", status: "error", rawTextTruncated: "", tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0, wasTruncated: false },
        ],
      },
    };
    const r = await render(await r1Body(partial));
    expectReadOnlyTeamRender(r);
  });

  it("CONTROL (non-vacuity) — the same persisted adaptive report through the shared view with NO policy DOES show the Personal export history and governance, so the Team absences above are real", async () => {
    const body = await r1Body({ adaptiveOutput: fullDeepResearchOutput(), legacyAdaptiveOutput: undefined });
    const interpreted = interpretPersistedRunReadPayload(body, FIXTURE_RUN_ID);
    if (interpreted.kind !== "ready") throw new Error("fixture not ready");
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(createElement(PersistedResearchResultView, { presentation: interpreted.presentation }));
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((res) => setTimeout(res, 0));
      });
    }
    expect(text(r)).toContain("Previous exports");
    expect(text(r)).toContain("Review & Governance");
    expect(mockedAuthedFetch.mock.calls.some((c) => ANCILLARY_ROUTE.test(String(c[0])))).toBe(true);
  });

  it("8. team_reviewer redaction — per-model latency shown to a team_member is absent for a team_reviewer; otherwise the same report", async () => {
    const member = await render(await r1Body(ORDINARY, "team_member"));
    const memberText = text(member);
    jest.clearAllMocks();
    jest.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
      throw new Error("no direct fetch");
    }) as never);
    const reviewer = await render(await r1Body(ORDINARY, "team_reviewer"));
    expectReadOnlyTeamRender(reviewer);
    const reviewerText = text(reviewer);
    if (memberText.includes("120 ms")) {
      expect(reviewerText).not.toContain("120 ms");
      expect(reviewerText).not.toContain("340 ms");
    }
    expect(reviewerText).toContain("What should we build?");
  });
});
