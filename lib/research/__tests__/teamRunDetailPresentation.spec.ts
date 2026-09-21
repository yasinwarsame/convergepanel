/**
 * TEAM-RESEARCH-PARITY-R3 §D/§E/§X — `interpretTeamRunDetailResponse()`.
 *
 * Bodies are produced by the REAL R1 server builder (`buildRunReadPayload`)
 * over the same parser-valid fixtures the R1 suites use, then JSON round-tripped
 * like the wire, and given the R1 `team` block. That proves the client contract
 * against what the Team endpoint actually emits, not a hand-drawn shape.
 */
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import {
  FIXTURE_PROJECT_ID,
  FIXTURE_RUN_ID,
  FIXTURE_WORKSPACE_ID,
  comparisonMatrixAdaptiveOutput,
  fullTeamRunData,
  governanceRecord,
} from "@/lib/runs/__tests__/runReadFixtures";
import { interpretTeamRunDetailResponse, type TeamRunDetailScope } from "@/lib/research/teamRunDetailPresentation";
import { MALFORMED_STRUCTURED_RESULT_NOTICE, NEWER_VERSION_STRUCTURED_RESULT_NOTICE } from "@/lib/research/persistedRunPresentation";

const PROJECT_SCOPE: TeamRunDetailScope = { workspaceId: FIXTURE_WORKSPACE_ID, runId: FIXTURE_RUN_ID, projectId: FIXTURE_PROJECT_ID };
const UNFILED_SCOPE: TeamRunDetailScope = { workspaceId: FIXTURE_WORKSPACE_ID, runId: FIXTURE_RUN_ID, projectId: null };

function teamBlock(over: Record<string, unknown> = {}) {
  return {
    workspaceId: FIXTURE_WORKSPACE_ID,
    projectId: FIXTURE_PROJECT_ID,
    project: { id: FIXTURE_PROJECT_ID, name: "Launch Plan", status: "active" },
    assignee: { uid: "uid-bao", displayName: "Bao", state: "active" },
    createdAt: "2026-09-02T10:00:00.000Z",
    completedAt: "2026-09-02T10:05:00.000Z",
    origin: null,
    review: { humanReviewStatus: "unreviewed", conditions: null, decidedVia: null, decisionReceipt: null },
    ...over,
  };
}

/** A real R1 detail body: builder output + team block, JSON round-tripped. */
async function r1Body(opts: { data?: Record<string, unknown>; viewerRole?: RunReadViewerRole; team?: Record<string, unknown> } = {}) {
  const payload = await buildRunReadPayload({ mayReadDecisionContent: true,
    runId: FIXTURE_RUN_ID,
    data: fullTeamRunData(opts.data ?? {}),
    viewerRole: opts.viewerRole ?? "team_member",
    resolveReviewRouting: async () => "in_queue",
  });
  return JSON.parse(JSON.stringify({ ...payload, team: teamBlock(opts.team) })) as Record<string, unknown>;
}

async function ready(opts: Parameters<typeof r1Body>[0] = {}, scope = PROJECT_SCOPE) {
  const r = interpretTeamRunDetailResponse(await r1Body(opts), scope);
  if (r.kind !== "ready") throw new Error(`expected ready, got ${r.kind}`);
  return r;
}

describe("valid Team results", () => {
  it("team_member ordinary result (adaptive absent, raw rows) → ready with full rows and the canonical presentation", async () => {
    const r = await ready({ data: { adaptiveOutput: undefined, legacyAdaptiveOutput: undefined, governanceRecord: undefined } });
    expect(r.presentation.viewerRole).toBe("team_member");
    expect(r.presentation.runId).toBe(FIXTURE_RUN_ID);
    expect(r.presentation.adaptive).toBeNull();
    expect(r.presentation.results).toHaveLength(2);
    expect(r.presentation.results[0]).toHaveProperty("tokenUsage");
  });

  it("team_reviewer result keeps the server's redaction (no tokenUsage / latencyMs on any row)", async () => {
    const r = await ready({ viewerRole: "team_reviewer" });
    expect(r.presentation.viewerRole).toBe("team_reviewer");
    for (const row of r.presentation.results as unknown as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty("tokenUsage");
      expect(row).not.toHaveProperty("latencyMs");
    }
  });

  it("adaptive (deep_research) → adapted structured presentation", async () => {
    const r = await ready();
    expect(r.presentation.adaptive?.schemaId).toBe("deep_research");
    expect(r.presentation.adaptive?.humanReview).toEqual({ status: "unreviewed", conditions: ["cond-a"], decidedVia: "workspace_review" });
  });

  it("legacy adaptive (adaptive absent) → legacy structured presentation", async () => {
    const r = await ready({ data: { adaptiveOutput: undefined, governanceRecord: undefined } });
    expect(r.presentation.adaptive?.schemaId).toBe("procedural");
  });

  it("malformed structured envelope → malformed restore notice + raw rows", async () => {
    const r = await ready({ data: { adaptiveOutput: { version: 1, schemaId: "deep_research" }, legacyAdaptiveOutput: undefined } });
    expect(r.presentation.adaptive).toBeNull();
    expect(r.presentation.restoreNotice).toBe(MALFORMED_STRUCTURED_RESULT_NOTICE);
    expect(r.presentation.results.length).toBeGreaterThan(0);
  });

  it("unsupported-version structured envelope → newer-version notice + raw rows", async () => {
    const r = await ready({ data: { adaptiveOutput: { version: 2 }, legacyAdaptiveOutput: undefined } });
    expect(r.presentation.restoreNotice).toBe(NEWER_VERSION_STRUCTURED_RESULT_NOTICE);
  });

  it.each(["queued", "running"])("status %s → in_progress with question, role and meta", async (status) => {
    const r = interpretTeamRunDetailResponse(await r1Body({ data: { status } }), PROJECT_SCOPE);
    expect(r).toMatchObject({ kind: "in_progress", question: "What should we build?", viewerRole: "team_member" });
  });

  it.each(["failed", "error"])("status %s → failed", async (status) => {
    const r = interpretTeamRunDetailResponse(await r1Body({ data: { status } }), PROJECT_SCOPE);
    expect(r.kind).toBe("failed");
  });

  it("persisted synthesis passes through; governance and org status pass through", async () => {
    const r = await ready();
    expect(r.presentation.synthesisReport).toEqual({ headline: "Report" });
    expect(r.presentation.orgGovernanceStatus).toBe("needs_review");
    expect(r.presentation.governance).toMatchObject({ governanceReviewRequired: true, policyFlags: ["pii"] });
  });

  it("a decided comparison_matrix run is ready too (schema-generic)", async () => {
    const r = await ready({ data: { adaptiveOutput: comparisonMatrixAdaptiveOutput(), governanceRecord: governanceRecord("approved", { schemaId: "comparison_matrix", answerShape: "comparison_grid" }) } });
    expect(r.presentation.adaptive?.schemaId).toBe("comparison_matrix");
  });
});

describe("Team metadata (defensive)", () => {
  it("assignee active / stale / null", async () => {
    expect((await ready()).meta.assignee).toEqual({ uid: "uid-bao", displayName: "Bao", state: "active" });
    expect((await ready({ team: { assignee: { uid: "uid-bao", displayName: "Bao", state: "stale" } } })).meta.assignee?.state).toBe("stale");
    expect((await ready({ team: { assignee: null } })).meta.assignee).toBeNull();
  });

  it.each([
    [{ uid: "uid-bao" }],
    [{ uid: "uid-bao", displayName: "", state: "active" }],
    [{ uid: "uid-bao", displayName: "Bao", state: "weird" }],
    ["uid-bao"],
  ])("a malformed assignee %p becomes null (a raw uid is never a label) and never blocks the body", async (assignee) => {
    const r = await ready({ team: { assignee } });
    expect(r.meta.assignee).toBeNull();
    expect(r.presentation.results.length).toBeGreaterThan(0);
  });

  it("Project metadata valid → kept; null or malformed → null (body still ready)", async () => {
    expect((await ready()).meta.project).toEqual({ id: FIXTURE_PROJECT_ID, name: "Launch Plan", status: "active" });
    expect((await ready({ team: { project: null } })).meta.project).toBeNull();
    expect((await ready({ team: { project: { id: 5 } } })).meta.project).toBeNull();
  });

  it("origin present → kind + dates only (never the source run id, even if a body carried one); absent → null", async () => {
    const r = await ready({ team: { origin: { kind: "personal_research", sourceCreatedAt: "2026-08-01T00:00:00.000Z", sourceCompletedAt: null, runId: "SECRET-source" } } });
    expect(r.meta.origin).toEqual({ kind: "personal_research", sourceCreatedAt: "2026-08-01T00:00:00.000Z", sourceCompletedAt: null });
    expect(JSON.stringify(r.meta)).not.toContain("SECRET-source");
    expect((await ready({ team: { origin: null } })).meta.origin).toBeNull();
    expect((await ready({ team: { origin: { kind: "other", sourceCreatedAt: "x" } } })).meta.origin).toBeNull();
  });

  it("review present → presentation-safe fields only (conditions filtered to non-empty strings); partial receipt → null receipt; missing status → null review", async () => {
    const full = await ready({ team: { review: { humanReviewStatus: "approved_with_conditions", conditions: ["Cite", "", 4, "Scope"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "OK", sourceBacked: false, humanReviewNeeded: true }, reviewerUid: "SECRET-uid", comment: "SECRET-comment" } } });
    expect(full.meta.review).toEqual({ humanReviewStatus: "approved_with_conditions", conditions: ["Cite", "Scope"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "OK", sourceBacked: false, humanReviewNeeded: true } });
    expect(JSON.stringify(full.meta)).not.toContain("SECRET");
    const partial = await ready({ team: { review: { humanReviewStatus: "pending", conditions: null, decidedVia: null, decisionReceipt: { conclusion: "x" } } } });
    expect(partial.meta.review).toEqual({ humanReviewStatus: "pending", conditions: [], decidedVia: null, decisionReceipt: null });
    expect((await ready({ team: { review: { conditions: ["c"] } } })).meta.review).toBeNull();
    expect((await ready({ team: { review: null } })).meta.review).toBeNull();
  });

  it("review present or absent never changes readiness (read-only metadata)", async () => {
    expect((await ready({ team: { review: null } })).kind).toBe("ready");
    expect((await ready({ team: { review: "garbage" } })).kind).toBe("ready");
  });

  it("malformed dates become null", async () => {
    const r = await ready({ team: { createdAt: 5, completedAt: { at: 1 } } });
    expect(r.meta.createdAt).toBeNull();
    expect(r.meta.completedAt).toBeNull();
  });
});

describe("route containment (§F/§H)", () => {
  it("Project address: exact projectId → ready", async () => {
    expect((await ready()).kind).toBe("ready");
  });

  it("Project address: a different Project → out_of_scope; an Unfiled run → out_of_scope", async () => {
    expect(interpretTeamRunDetailResponse(await r1Body({ team: { projectId: "otherProject" } }), PROJECT_SCOPE)).toEqual({ kind: "out_of_scope" });
    expect(interpretTeamRunDetailResponse(await r1Body({ team: { projectId: null } }), PROJECT_SCOPE)).toEqual({ kind: "out_of_scope" });
  });

  it("Unfiled address: projectId null → ready; ANY Project-bound run → out_of_scope (never painted on the Unfiled address)", async () => {
    const r = interpretTeamRunDetailResponse(await r1Body({ team: { projectId: null, project: null } }), UNFILED_SCOPE);
    expect(r.kind).toBe("ready");
    expect(interpretTeamRunDetailResponse(await r1Body(), UNFILED_SCOPE)).toEqual({ kind: "out_of_scope" });
  });

  it("an in-progress run is still contained (out_of_scope wins over status)", async () => {
    expect(interpretTeamRunDetailResponse(await r1Body({ data: { status: "running" } }), UNFILED_SCOPE)).toEqual({ kind: "out_of_scope" });
  });
});

describe("response identity (§E) — fail closed", () => {
  it("wrong runId → malformed", async () => {
    const body = await r1Body();
    expect(interpretTeamRunDetailResponse({ ...body, runId: "run-other" }, PROJECT_SCOPE)).toEqual({ kind: "malformed" });
  });

  it("wrong team.workspaceId → malformed (not out_of_scope)", async () => {
    expect(interpretTeamRunDetailResponse(await r1Body({ team: { workspaceId: "anotherWorkspace" } }), PROJECT_SCOPE)).toEqual({ kind: "malformed" });
  });

  it.each([
    ["missing team", (b: Record<string, unknown>) => { delete b.team; return b; }],
    ["team is null", (b: Record<string, unknown>) => ({ ...b, team: null })],
    ["team is an array", (b: Record<string, unknown>) => ({ ...b, team: [] })],
    ["team.projectId is a number", (b: Record<string, unknown>) => ({ ...b, team: { ...(b.team as object), projectId: 7 } })],
    ["team.projectId is missing", (b: Record<string, unknown>) => { const t = { ...(b.team as Record<string, unknown>) }; delete t.projectId; return { ...b, team: t }; }],
    ["ok is not true", (b: Record<string, unknown>) => ({ ...b, ok: "true" })],
  ])("%s → malformed", async (_name, mutate) => {
    expect(interpretTeamRunDetailResponse(mutate(await r1Body()), PROJECT_SCOPE)).toEqual({ kind: "malformed" });
  });

  it.each(["owner", "personal_reviewer", undefined, "admin", ""])("viewerRole %p is not a Team presentation → malformed (never reinterpreted)", async (role) => {
    const body = await r1Body();
    expect(interpretTeamRunDetailResponse({ ...body, viewerRole: role }, PROJECT_SCOPE)).toEqual({ kind: "malformed" });
  });

  it.each([null, undefined, "x", 3, []])("non-object body %p → malformed", (raw) => {
    expect(interpretTeamRunDetailResponse(raw, PROJECT_SCOPE)).toEqual({ kind: "malformed" });
  });

  it("completed with no structured result and no rows → malformed", async () => {
    const body = await r1Body({ data: { adaptiveOutput: undefined, legacyAdaptiveOutput: undefined, runDocument: undefined, results: undefined } });
    expect(interpretTeamRunDetailResponse(body, PROJECT_SCOPE)).toEqual({ kind: "malformed" });
  });

  it("does not mutate its input", async () => {
    const body = await r1Body();
    const before = JSON.stringify(body);
    interpretTeamRunDetailResponse(body, PROJECT_SCOPE);
    expect(JSON.stringify(body)).toBe(before);
  });
});
