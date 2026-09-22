/**
 * TEAM-RESEARCH-PARITY-R3-P0 §J/§K/§L/§P/§T — the REAL shared adaptive stack.
 *
 * `PersistedResearchResultView` → `ResultsDisplay` → `AdaptivePanelResponse`
 * → `TopSummaryBar` / `ReviewGovernanceSection` / export components all run
 * unstubbed (only the ESM-only `react-markdown` / `remark-gfm` are trivial
 * factories). Reports come from the REAL R1 server builder over full-shape
 * persisted envelopes. The export flag is ON and the plan is paid, so the
 * Personal export surfaces genuinely render — their absence in delegated mode
 * is therefore not vacuous.
 *
 * §T — this is the minimal generic form of the two R3 real-render cases that
 * fail on main (a persisted adaptive and a persisted legacy-adaptive report
 * rendered without Personal ancillary behaviour). They pass under P0.
 */
process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";

jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
const AUTH = { user: { uid: "uid-p0" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const PLAN = { plan: "full", loading: false };
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => PLAN }));
const requests: string[] = [];
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (url: string, init?: { method?: string }) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return new Promise(() => {});
  },
}));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload, type PersistedResearchPresentation } from "@/lib/research/persistedRunPresentation";
import { FIXTURE_RUN_ID, fullTeamRunData } from "@/lib/runs/__tests__/runReadFixtures";
import type { AdaptiveAncillaryPresentation } from "@/components/adaptive/adaptiveAncillaryPresentation";

function finding(i: number, summary: string) {
  return { id: `f${i}`, title: `Finding ${i}`, summary, category: "General", evidenceStrength: "unknown", sourceBacked: false, sources: [], coverageCount: 2, totalModels: 2, coverageRatio: 1, contributingModels: ["chatgpt", "claude"] };
}
const deepResearch = () => ({
  version: 1,
  schemaId: "deep_research",
  answerShape: "deep_research_view",
  classification: { queryType: "deep_research", domain: "general", answerShape: "deep_research_view", confidence: 0.9, riskLevel: "general" },
  meta: { schemaVersion: 1, queryType: "deep_research", answerShape: "deep_research_view", dataBasis: "training_prior", freshness: "timeless", riskLevel: "general", evidenceQuality: "unknown", uncertainties: [], blindSpots: [], humanReviewNeeded: false, generatedAt: "2026-09-01T00:00:00.000Z", limitations: [] },
  generatedAt: "2026-09-01T00:00:00.000Z",
  result: { executiveSummary: "Panel summary of the research.", findings: [finding(1, "Finding one"), finding(2, "Finding two")], lowConfidenceFindings: [], disagreements: [], evidenceGaps: [], openQuestions: [], panelBlindSpots: [], researchBoundaries: [], recommendedNextSteps: [], sourceCoverage: { findingsWithSources: 0, totalFindings: 2, coverageRatio: 0 }, totalModels: 2 },
});
const proceduralLegacy = () => ({
  version: 1,
  schemaId: "procedural",
  classification: { queryType: "procedural", domain: "software", answerShape: "step_diff", confidence: 0.9, riskLevel: "professional" },
  generatedAt: "2026-08-06T00:00:00.000Z",
  results: [
    { modelId: "chatgpt", schemaId: "procedural", ok: true, data: { goal: "Push a first commit.", prerequisites: ["Git"], steps: [{ order: 1, action: "Create a repository." }], commonFailures: [] } },
    { modelId: "claude", schemaId: "procedural", ok: true, data: { goal: "Push your first commit.", prerequisites: ["GitHub account"], steps: [{ order: 1, action: "Create a new repository." }], commonFailures: [] } },
  ],
  alignedClaims: [
    { id: "step-1", claimText: "Create a new repository on GitHub.", cells: [{ modelId: "chatgpt", stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "Create a repository." }, { modelId: "claude", stance: "agrees", rawStance: "asserts", confidence: "majority_view", excerpt: "Create a new repository." }], agreementScore: 1, certaintyScore: 1, status: "consensus" },
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
});

const REPORTS = {
  "persisted adaptive (deep_research)": { data: { adaptiveOutput: deepResearch(), legacyAdaptiveOutput: undefined }, content: "Finding one" },
  "persisted legacy-adaptive (procedural)": { data: { adaptiveOutput: undefined, governanceRecord: undefined, legacyAdaptiveOutput: proceduralLegacy() }, content: "Create a repository, initialize git locally, and push your first commit." },
} as const;

async function presentationFor(data: Record<string, unknown>, viewerRole: RunReadViewerRole = "team_member"): Promise<PersistedResearchPresentation> {
  const body = JSON.parse(JSON.stringify(await buildRunReadPayload({ runId: FIXTURE_RUN_ID, data: fullTeamRunData(data), viewerRole, mayReadDecisionContent: true, resolveReviewRouting: async () => "in_queue" })));
  const interpreted = interpretPersistedRunReadPayload(body, FIXTURE_RUN_ID);
  if (interpreted.kind !== "ready") throw new Error(`fixture not ready: ${interpreted.kind}`);
  return interpreted.presentation;
}

async function mount(presentation: PersistedResearchPresentation, adaptiveAncillaryPresentation?: AdaptiveAncillaryPresentation) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(PersistedResearchResultView, { presentation, ...(adaptiveAncillaryPresentation !== undefined ? { adaptiveAncillaryPresentation } : {}) }));
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
  }
  return r;
}

function textOf(r: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === "string") out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") ((n as { children?: unknown[] }).children ?? []).forEach(walk);
  };
  walk(r.toJSON());
  return out.join(" ");
}

const ANCILLARY_ROUTE = /\/api\/user\/runs\/[^/]+\/(governance|review-history|export|exports)|\/api\/teams\/adaptive-runs\/[^/]+\/history/;

beforeEach(() => {
  requests.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
    throw new Error("no direct fetch from the shared renderer");
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

describe.each(Object.entries(REPORTS))("%s", (_name, report) => {
  it("PERSONAL DEFAULT (policy absent): export action, Previous exports and Review & Governance all mount, and the Personal governance request is made (§L)", async () => {
    const r = await mount(await presentationFor(report.data, "owner"));
    const text = textOf(r);
    expect(text).toContain(report.content);
    expect(text).toContain("Report type");
    expect(r.root.findAll((n) => n.type === "button" && typeof n.props["aria-label"] === "string" && n.props["aria-label"].startsWith("Export this report"))).toHaveLength(1);
    expect(text).toContain("Previous exports");
    expect(text).toContain("Review & Governance");
    expect(requests).toContain(`GET /api/user/runs/${FIXTURE_RUN_ID}/governance`);
  });

  it("DELEGATED READ-ONLY, no surfaces: the report and summary bar render with NO export action, NO Previous exports, NO governance artifact, and ZERO requests (§J/§K)", async () => {
    const r = await mount(await presentationFor(report.data), { kind: "delegated_read_only" });
    const text = textOf(r);
    expect(text).toContain(report.content);
    expect(text).toContain("Report type");
    expect(r.root.findAll((n) => n.type === "button" && typeof n.props["aria-label"] === "string" && n.props["aria-label"].startsWith("Export this report"))).toHaveLength(0);
    expect(text).not.toContain("Previous exports");
    expect(text).not.toContain("Review & Governance");
    expect(text).not.toContain("Review status");
    expect(text).not.toContain("Review history");
    expect(text).not.toContain("Loading review status");
    expect(requests).toEqual([]);
    expect(requests.some((q) => ANCILLARY_ROUTE.test(q))).toBe(false);
    expect(requests.some((q) => q.includes("/api/synthesize-panel"))).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("DELEGATED READ-ONLY with a caller governance surface: rendered exactly once with the caller's link, still ZERO requests (§K)", async () => {
    const surface = createElement("a", { href: "/workspace/reviews/run-123", "data-testid": "caller-governance" }, "Open this review");
    const r = await mount(await presentationFor(report.data), { kind: "delegated_read_only", reviewGovernanceSurface: surface });
    const links = r.root.findAll((n) => n.props["data-testid"] === "caller-governance");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("/workspace/reviews/run-123");
    expect(textOf(r)).not.toContain("Review & Governance");
    expect(requests).toEqual([]);
  });

  it("DELEGATED READ-ONLY with a caller export surface: rendered exactly once in place of the Personal export surfaces, ZERO requests", async () => {
    const surface = createElement("span", { "data-testid": "caller-export" }, "Caller export");
    const r = await mount(await presentationFor(report.data), { kind: "delegated_read_only", exportSurface: surface });
    expect(r.root.findAll((n) => n.props["data-testid"] === "caller-export")).toHaveLength(1);
    expect(textOf(r)).not.toContain("Previous exports");
    expect(requests).toEqual([]);
  });

  it("NO ROLE INFERENCE: a team_member presentation with NO policy still gets the Personal default (the caller must choose) (§P)", async () => {
    const r = await mount(await presentationFor(report.data, "team_member"));
    expect(textOf(r)).toContain("Review & Governance");
    expect(textOf(r)).toContain("Previous exports");
    expect(requests).toContain(`GET /api/user/runs/${FIXTURE_RUN_ID}/governance`);
  });
});
