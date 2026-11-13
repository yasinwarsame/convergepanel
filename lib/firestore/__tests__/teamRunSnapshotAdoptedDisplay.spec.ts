/**
 * Order 41 D (owner-authorized, #314) — a Team snapshot of a Personal run carries the run's verified display record
 * (`runs/{runId}/adaptiveDisplayResults/v1`), re-bound to the snapshot's NEW run id, so a Team reader sees the adopted
 * validated result instead of #312's saved-first-answer presentation.
 *
 * THE REAL CHAIN, every unit real; only the model (runPanel's first answers and the retry connector), Firestore (the
 * codebase's transactional test double), the per-user token counter, rate limiting and two read-side enrichments
 * (assignee names, review routing) are faked:
 *   executeOrdinaryRun → persistAdaptiveDisplayResults (the source's record) →
 *   POST …/projects/{projectId}/research/snapshots → createTeamRunSnapshotFromPersonal (one transaction: Team
 *   authorization, Project, source ownership, deletion barrier, lock, then the display record verified against the
 *   source and re-bound) → GET /api/workspaces/{workspaceId}/runs/{snapshotRunId} (access gates, then
 *   loadAdaptiveDisplayResults → buildRunReadPayload → readAdoptedDisplayResults) → deleteResearchRun.
 */
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-test",
  XAI_API_KEY: "sk-test",
  PERPLEXITY_API_KEY: "sk-test",
  GEMINI_API_KEY: "sk-test",
  ADAPTIVE_VERIFICATION_ENABLED: false,
  PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED: false,
  WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
  DS_PROVENANCE_ROUTE_VIEW_ENABLED: false,
}));
const mockedLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));
const mockedRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({ runPanel: (...a: unknown[]) => mockedRunPanel(...a) }));
jest.mock("@/lib/connectors/claude", () => ({ callClaude: jest.fn() }));
jest.mock("@/lib/connectors/chatgpt", () => ({ callChatGPT: jest.fn() }));
jest.mock("@/lib/connectors/grok", () => ({ callGrok: jest.fn() }));
jest.mock("@/lib/connectors/perplexity", () => ({ callPerplexity: jest.fn() }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn(async () => ({ tokensUsedCurrentPeriod: 0, periodStart: new Date() })) }));
jest.mock("@/lib/adaptiveSchema/analytics", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/analytics");
  return Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === "function" ? jest.fn() : actual[k]]));
});
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn(async () => ({ allowed: true })) }));
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({ resolveRunAssigneesForPage: jest.fn(async () => []) }));
jest.mock("@/lib/runs/resolveRunReviewRouting", () => ({ resolveRunReviewRouting: jest.fn(async () => "not_configured") }));
import { FakeDocRef, FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
  adminAuth: null,
  FIREBASE_PROJECT_ID: "test",
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { callClaude } from "@/lib/connectors/claude";
import { callGrok } from "@/lib/connectors/grok";
import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import {
  ADAPTIVE_DISPLAY_SLOT_MAX_BYTES,
  FIRESTORE_DOCUMENT_BUDGET_BYTES,
  adaptiveDisplayDocumentBytes,
  readAdoptedDisplayResults,
  rebindAdaptiveDisplayResults,
} from "@/lib/adaptiveSchema/adoptedDisplayResults";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import { loadAdaptiveDisplayResults } from "@/lib/firestore/adaptiveDisplayResults";
import { createTeamRunSnapshotFromPersonal } from "@/lib/firestore/teamRunSnapshots";
import { deleteResearchRun } from "@/lib/firestore/researchDeletion";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { computeRunSnapshotLockId } from "@/lib/workspaces/runSnapshotLock";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import { POST as SNAPSHOT_POST } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/research/snapshots/route";
import { GET as TEAM_RUN_GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/route";
import type { ModelResult } from "@/lib/types";

const schema = SCHEMA_REGISTRY.comparison_matrix;
const CLASSIFICATION = { queryType: "comparison_matrix", confidence: 0.9 } as never;
const QUESTION = "Compare carbon taxes and regulatory standards";
const SRC = "run-11111111-1111-4111-8111-111111111111";
const OWNER = "owner-1";
const TEAM_OWNER = "team-owner-1";
const WS = "wsTeamAcme000001";
const WS_B = "wsTeamOther00002";
const MEMBER_B = "member-of-b";
const OUTSIDER = "outsider-9";
const VIEWER = "viewer-1";
const PROJECT = "projClimate00001";
const PROJECT_B = "projOtherTeam0002";
const T = Timestamp.fromDate(new Date("2026-11-01T00:00:00.000Z"));
const claude = callClaude as unknown as jest.Mock;
const grok = callGrok as unknown as jest.Mock;
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const displayPath = (runId: string) => `runs/${runId}/adaptiveDisplayResults/v1`;

const EFF = "Effectiveness";
const answer = (who: string, extra: Record<string, unknown> = {}) => ({
  cells: [
    { subject: "Carbon Taxes", attribute: EFF, value: `${who} high`, verdict: "better" },
    { subject: "Regulatory Standards", attribute: EFF, value: `${who} moderate`, verdict: "worse" },
  ],
  directConclusion: `${who}: carbon pricing leads on cost-effectiveness.`,
  tradeoffs: [`${who}: cheaper instruments are politically harder.`],
  bestUseRecommendations: [`${who}: carbon taxes when price certainty matters.`],
  uncertainties: [],
  ...extra,
});
const bare = (who: string, extra?: Record<string, unknown>) => JSON.stringify(answer(who, extra));
const CLAUDE_PROSE_WRAPPED = `Here is a structured comparison:\n\n\`\`\`json\n${JSON.stringify(answer("ClaudeFirst"), null, 2)}\n\`\`\`\n\nNote: effectiveness depends on design.`;
const GROK_PARTIAL = bare("GrokFirst", { directConclusion: 7 });
const ok = (modelId: string, rawText: string): ModelResult =>
  ({ modelId, status: "ok", rawText, latencyMs: 5, tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) as never;
const retryOk = (modelId: string, text: string) => ({ modelId, status: "ok", rawText: text, latencyMs: 5, tokenUsage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 } });

// ─── Fixtures ───────────────────────────────────────────────────────────────

function seedTeam() {
  const ws = (id: string, ownerUserId: string) => ({ schemaVersion: 1, id, type: "team", name: id, ownerUserId, createdByUserId: ownerUserId, createdAt: T, updatedAt: T });
  const member = (workspaceId: string, uid: string, role: string) => {
    const id = computeMembershipId(workspaceId, uid);
    db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: T, updatedAt: T, invitedByUserId: null, removedAt: null, removedByUserId: null });
  };
  const project = (id: string, workspaceId: string) =>
    db.seed(`projects/${id}`, { schemaVersion: 1, id, workspaceId, name: "Climate", status: "active", createdByUserId: TEAM_OWNER, createdAt: T, updatedAt: T });
  db.seed(`workspaces/${WS}`, ws(WS, TEAM_OWNER));
  db.seed(`workspaces/${WS_B}`, ws(WS_B, MEMBER_B));
  member(WS, TEAM_OWNER, "owner");
  member(WS, OWNER, "member");
  member(WS, VIEWER, "viewer");
  member(WS_B, MEMBER_B, "owner");
  project(PROJECT, WS);
  project(PROJECT_B, WS_B);
}

/** A real Personal (legacy-shaped) run, executed by the production executor; returns the live adaptive results. */
async function executeSource(results: ModelResult[]) {
  db.docs.clear();
  db.hooks = {};
  db.writeLog.length = 0;
  db.txReadLog.length = 0;
  db.seed(`runs/${SRC}`, { userId: OWNER, question: QUESTION, status: "running", createdAt: T, selectedModels: results.map((r) => r.modelId) });
  mockedRunPanel.mockResolvedValue(results);
  const res = await executeOrdinaryRun({
    uid: OWNER,
    runId: SRC,
    trimmedQuestion: QUESTION,
    context: null,
    selectedModels: results.map((r) => r.modelId) as never,
    adaptivePlan: { classification: CLASSIFICATION, schema, promptOverrides: Object.fromEntries(results.map((r) => [r.modelId, "SYSTEM PROMPT"])), routing: { kind: "active", schema } as never },
    debugRawResponseRequested: false,
    requestBudget: { startedAtMonoMs: performance.now(), budgetMs: 300_000 },
  });
  expect(res.status).toBe(200);
  expect(db.read(`runs/${SRC}`)!.status).toBe("complete");
  seedTeam();
  claude.mockReset();
  grok.mockReset();
  return { live: (res.body as any).adaptive.results as any[] };
}

async function snapshot(uid = OWNER, workspaceId = WS, projectId = PROJECT, sourceRunId = SRC) {
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid, source: "session_cookie" });
  const res = await SNAPSHOT_POST(
    new NextRequest(`http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/research/snapshots`, {
      method: "POST",
      body: JSON.stringify({ source: { sourceType: "personal_research", runId: sourceRunId } }),
      headers: { "content-type": "application/json" },
    }),
    { params: { workspaceId, projectId } }
  );
  return { status: res.status, body: (await res.json()) as any };
}
function snapshotRunId(): string {
  const ids = db.paths("runs/").map((p) => p.split("/")[1]).filter((id) => id !== SRC);
  const unique = [...new Set(ids)];
  expect(unique).toHaveLength(1);
  return unique[0];
}

/** Every path a direct (non-transactional) document read touched — the route loader reads the display doc this way. */
let directReads: string[] = [];
async function teamRead(uid: string, runId: string, workspaceId = WS) {
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid, source: "session_cookie" });
  const res = await TEAM_RUN_GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${runId}`, { method: "GET" }), { params: { workspaceId, runId } });
  return { status: res.status, text: await res.text() };
}
async function readPayload(runId: string) {
  const data = db.read(`runs/${runId}`)!;
  const adaptiveDisplayResults = await loadAdaptiveDisplayResults(runId);
  return roundTrip(await buildRunReadPayload({ runId, data, viewerRole: "team_member", mayReadDecisionContent: true, resolveReviewRouting: async () => "not_configured", adaptiveDisplayResults })) as any;
}
const origins = (payload: any) => Object.fromEntries((payload.adaptive.modelResults ?? []).map((m: any) => [m.modelId, m.savedResultOrigin ?? null]));
const rowsOf = (runId: string) => runDocumentToPublicResults(db.read(`runs/${runId}`)!.runDocument as never);

jest.setTimeout(60_000);
beforeEach(() => {
  claude.mockReset();
  grok.mockReset();
  mockedRunPanel.mockReset();
  mockedLogger.warn.mockClear();
  mockedLogger.error.mockClear();
  directReads = [];
  const realGet = FakeDocRef.prototype.get;
  jest.spyOn(FakeDocRef.prototype, "get").mockImplementation(function (this: FakeDocRef) {
    directReads.push(this.path);
    return realGet.call(this);
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── Source outcomes ────────────────────────────────────────────────────────

describe("the snapshot carries the source's verified display record, re-bound to the new run id", () => {
  async function expectParity(expectedOrigins: Record<string, string | null>) {
    const sourceRecord = db.read(displayPath(SRC))!;
    const sourceBefore = JSON.stringify(db.read(`runs/${SRC}`));
    const r = await snapshot();
    expect(r.status).toBe(201);
    const id = snapshotRunId();
    expect(r.body.runId ?? r.body.snapshot?.runId ?? JSON.stringify(r.body)).toContain(id);
    expect(id).not.toBe(SRC);
    const copy = db.read(displayPath(id))!;
    // Requirement 2: ONLY runId changes; every other byte of the record is the source's.
    expect(copy).toEqual({ ...sourceRecord, runId: id });
    // The source is untouched (record and run document).
    expect(db.read(displayPath(SRC))).toEqual(sourceRecord);
    expect(JSON.stringify(db.read(`runs/${SRC}`))).toBe(sourceBefore);
    // The snapshot's reader accepts it: the Team reader sees exactly the source reader's model results.
    const src = await readPayload(SRC);
    const snap = await readPayload(id);
    expect(origins(snap)).toEqual(expectedOrigins);
    expect(snap.adaptive.modelResults).toEqual(src.adaptive.modelResults);
    // Control: without the record, the snapshot would show #312 (no savedResultOrigin anywhere).
    db.docs.delete(displayPath(id));
    const without = await readPayload(id);
    expect(Object.values(origins(without)).every((o) => o === null)).toBe(true);
    db.seed(displayPath(id), copy);
    return { id, copy, sourceRecord, src, snap };
  }

  it("original accepted result: copied, shown as original_accepted", async () => {
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", bare("Claude"))]);
    await expectParity({ chatgpt: "original_accepted", claude: "original_accepted" });
  });

  it("adopted full retry: the Team snapshot shows the RETRY's validated result, not the saved first answer", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { live } = await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(live.find((x) => x.modelId === "claude").retryOutcome).toBe("adopted_full");
    const { snap, id } = await expectParity({ chatgpt: "original_accepted", claude: "retry_adopted_full" });
    const c = snap.adaptive.modelResults.find((m: any) => m.modelId === "claude");
    expect(c.data.directConclusion).toBe("ClaudeRetry: carbon pricing leads on cost-effectiveness.");
    // The saved first answer is still the snapshot's saved copy.
    expect(rowsOf(id).find((x: any) => x.modelId === "claude")!.rawText).toBe(CLAUDE_PROSE_WRAPPED);
    // And through the real Team route, for an authorized member.
    const read = await teamRead(OWNER, id);
    expect(read.status).toBe(200);
    const body = JSON.parse(read.text);
    expect(body.adaptive.modelResults.find((m: any) => m.modelId === "claude")).toMatchObject({ savedResultOrigin: "retry_adopted_full", data: { directConclusion: "ClaudeRetry: carbon pricing leads on cost-effectiveness." } });
    expect(read.text).not.toContain("adaptiveDisplayResults");
  });

  it("adopted partial retry: the merged validated data is carried over", async () => {
    grok.mockResolvedValueOnce(retryOk("grok", bare("GrokRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("grok", GROK_PARTIAL)]);
    const { snap } = await expectParity({ chatgpt: "original_accepted", grok: "retry_adopted_partial" });
    const g = snap.adaptive.modelResults.find((m: any) => m.modelId === "grok");
    expect(g.data.cells[0].value).toBe("GrokFirst high");
    expect(g.data.directConclusion).toBe("GrokRetry: carbon pricing leads on cost-effectiveness.");
  });

  it("exact provenance correspondence: per slot, model id, slot index, executed status, origin, retry outcome and data are identical; schema version and schema id are kept; only runId differs", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    grok.mockResolvedValueOnce(retryOk("grok", bare("GrokRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED), ok("grok", GROK_PARTIAL)]);
    const { id, copy, sourceRecord } = await expectParity({ chatgpt: "original_accepted", claude: "retry_adopted_full", grok: "retry_adopted_partial" });
    const s = sourceRecord as any;
    const c = copy as any;
    expect([c.schemaVersion, c.schemaId, c.runId]).toEqual([s.schemaVersion, s.schemaId, id]);
    expect([s.schemaVersion, s.schemaId, s.runId]).toEqual([1, "comparison_matrix", SRC]);
    expect(Object.keys(c.bySlot)).toEqual(Object.keys(s.bySlot));
    for (const m of Object.keys(s.bySlot)) {
      for (const f of ["availability", "slotIndex", "executedStatus", "origin", "retryOutcome", "data", "invalidFields", "truncatedFields"]) {
        expect([m, f, c.bySlot[m][f]]).toEqual([m, f, s.bySlot[m][f]]);
      }
    }
    // Each slot still names the SAME panel row of the snapshot (same index, model and status) as of the source.
    const srcRows = rowsOf(SRC).map((r: any) => [r.modelId, r.status]);
    expect(rowsOf(id).map((r: any) => [r.modelId, r.status])).toEqual(srcRows);
    for (const m of Object.keys(c.bySlot)) expect(srcRows[c.bySlot[m].slotIndex]).toEqual([m, c.bySlot[m].executedStatus]);
    expect(s.bySlot).toMatchObject({ chatgpt: { origin: "original_accepted", retryOutcome: null }, claude: { origin: "retry_adopted_full", retryOutcome: "adopted_full" }, grok: { origin: "retry_adopted_partial", retryOutcome: "adopted_partial" } });
    // The re-binding matters: the source record verbatim would be rejected by the snapshot's reader as foreign.
    expect(readAdoptedDisplayResults(sourceRecord, { runId: id, schemaId: "comparison_matrix", rows: rowsOf(id) })).toMatchObject({ status: "foreign" });
    expect(readAdoptedDisplayResults(copy, { runId: id, schemaId: "comparison_matrix", rows: rowsOf(id) }).slots.size).toBe(3);
  });

  it("an unavailable slot (retry failed) is not copied; the verified slots are", async () => {
    claude.mockResolvedValueOnce({ modelId: "claude", status: "error", rawText: null, errorMessage: "overloaded", latencyMs: 5 });
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect((db.read(displayPath(SRC)) as any).bySlot.claude).toMatchObject({ availability: "unavailable", retryOutcome: "failed_call" });
    await snapshot();
    const id = snapshotRunId();
    expect(Object.keys((db.read(displayPath(id)) as any).bySlot)).toEqual(["chatgpt"]);
    expect(origins(await readPayload(id))).toEqual(origins(await readPayload(SRC)));
  });
});

// ─── Fallbacks: the snapshot is created WITHOUT a display document ──────────

describe("absent, invalid, foreign or oversized source records: snapshot created, no display document (#312), not an error", () => {
  async function expectCreatedWithoutDisplay(reason?: string) {
    const r = await snapshot();
    expect(r.status).toBe(201);
    const id = snapshotRunId();
    expect(db.read(`runs/${id}`)).toBeDefined();
    expect(db.read(displayPath(id))).toBeUndefined();
    expect(db.paths(`runs/${id}/`)).toEqual([]);
    expect(Object.values(origins(await readPayload(id))).every((o) => o === null)).toBe(true);
    if (reason) expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Source display record not copied"), expect.objectContaining({ reason }));
    else expect(mockedLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Source display record not copied"), expect.anything());
    return id;
  }
  async function adoptedSource() {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    return db.read(displayPath(SRC)) as any;
  }

  it("missing record (every run before #313)", async () => {
    await adoptedSource();
    db.docs.delete(displayPath(SRC));
    await expectCreatedWithoutDisplay();
  });

  it("malformed record (unknown top-level key)", async () => {
    const rec = await adoptedSource();
    db.seed(displayPath(SRC), { ...rec, extra: "x" });
    await expectCreatedWithoutDisplay("malformed");
  });

  it("future schema version", async () => {
    const rec = await adoptedSource();
    db.seed(displayPath(SRC), { ...rec, schemaVersion: 2 });
    await expectCreatedWithoutDisplay("unsupported_version");
  });

  it("foreign record (bound to another run)", async () => {
    const rec = await adoptedSource();
    db.seed(displayPath(SRC), { ...rec, runId: "run-someone-elses-run" });
    await expectCreatedWithoutDisplay("foreign");
  });

  it("foreign schema", async () => {
    const rec = await adoptedSource();
    db.seed(displayPath(SRC), { ...rec, schemaId: "ranked_list" });
    await expectCreatedWithoutDisplay("foreign");
  });

  it("every slot fails verification (tampered model text) → nothing invented", async () => {
    const rec = await adoptedSource();
    const tampered = roundTrip(rec);
    for (const m of Object.keys(tampered.bySlot)) tampered.bySlot[m].data.injected = "not a schema field";
    db.seed(displayPath(SRC), tampered);
    await expectCreatedWithoutDisplay("no_verified_slots");
  });

  it("one slot tampered: only the verified slot is copied, verbatim", async () => {
    const rec = await adoptedSource();
    const tampered = roundTrip(rec);
    tampered.bySlot.claude.data.injected = "INJECTED-MODEL-TEXT";
    db.seed(displayPath(SRC), tampered);
    await snapshot();
    const id = snapshotRunId();
    expect(db.read(displayPath(id))).toEqual({ ...rec, runId: id, bySlot: { chatgpt: rec.bySlot.chatgpt } });
    expect(JSON.stringify(db.read(displayPath(id)))).not.toContain("INJECTED-MODEL-TEXT");
  });

  it("slot over the per-slot bound (64 KiB) → dropped by verification", async () => {
    const rec = await adoptedSource();
    const big = roundTrip(rec);
    big.bySlot.chatgpt.data.directConclusion = "x".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES);
    big.bySlot.claude.data.directConclusion = "y".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES);
    db.seed(displayPath(SRC), big);
    await expectCreatedWithoutDisplay("no_verified_slots");
  });

  it("record over the 256 KiB record bound (each slot within its own bound) → omitted", async () => {
    const results = ["chatgpt", "claude", "grok", "perplexity", "gemini"].map((m) => ok(m, bare(m, { directConclusion: "z".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES - 1_500) })));
    await executeSource(results);
    const rec = db.read(displayPath(SRC)) as any;
    // The live builder already capped the source; re-admit every slot (each verifies on its own) to exceed the record bound.
    const over = roundTrip(rec);
    for (const m of Object.keys(over.bySlot)) {
      if (over.bySlot[m].availability !== "available") {
        const idx = over.bySlot[m].slotIndex;
        over.bySlot[m] = { availability: "available", slotIndex: idx, executedStatus: "ok", origin: "original_accepted", retryOutcome: null, data: answer(m, { directConclusion: "z".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES - 1_500) }) };
      }
    }
    expect(readAdoptedDisplayResults(over, { runId: SRC, schemaId: "comparison_matrix", rows: rowsOf(SRC) }).slots.size).toBe(5);
    db.seed(displayPath(SRC), over);
    await expectCreatedWithoutDisplay("oversized");
  });

  it("a non-adaptive source never reads a display document", async () => {
    await adoptedSource();
    const src = db.read(`runs/${SRC}`)!;
    delete src.adaptiveOutput;
    db.seed(`runs/${SRC}`, src);
    db.txReadLog.length = 0;
    await expectCreatedWithoutDisplay();
    expect(db.txReadLog).not.toContain(displayPath(SRC));
  });
});

// ─── The document ceiling, recomputed for the NEW run id ────────────────────

describe("rebindAdaptiveDisplayResults: exact document size for the TARGET id, 950,000-byte ceiling", () => {
  it("measures the target document (name included) and refuses one byte over the budget", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const rec = db.read(displayPath(SRC))!;
    const rows = rowsOf(SRC);
    const target = `run-${"t".repeat(200)}`;
    const args = { sourceRunId: SRC, targetRunId: target, schemaId: "comparison_matrix", sourceRows: rows, targetRows: rows };
    const done = rebindAdaptiveDisplayResults(rec, args);
    if (!done.ok) throw new Error(done.reason);
    const exact = adaptiveDisplayDocumentBytes(target, done.record as never);
    expect(done.documentBytes).toBe(exact);
    // The target id is longer than the source's: the size is the target document's, not the source's.
    expect(exact).toBeGreaterThan(adaptiveDisplayDocumentBytes(SRC, { ...done.record, runId: SRC } as never) + 300);
    expect(rebindAdaptiveDisplayResults(rec, { ...args, documentBudgetBytes: exact }).ok).toBe(true);
    expect(rebindAdaptiveDisplayResults(rec, { ...args, documentBudgetBytes: exact - 1 })).toEqual({ ok: false, reason: "oversized" });
    // A caller budget can only tighten the ceiling, never raise it.
    expect(rebindAdaptiveDisplayResults(rec, { ...args, documentBudgetBytes: FIRESTORE_DOCUMENT_BUDGET_BYTES * 10 }).ok).toBe(true);
    expect(FIRESTORE_DOCUMENT_BUDGET_BYTES).toBe(950_000);
  });

  it("postcondition: target rows that do not match the source's → nothing copied", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const rec = db.read(displayPath(SRC))!;
    const rows = rowsOf(SRC);
    const swapped = [rows[1], rows[0]];
    expect(rebindAdaptiveDisplayResults(rec, { sourceRunId: SRC, targetRunId: "run-new", schemaId: "comparison_matrix", sourceRows: rows, targetRows: swapped })).toEqual({ ok: false, reason: "rebind_mismatch" });
    expect(rebindAdaptiveDisplayResults(rec, { sourceRunId: SRC, targetRunId: "", schemaId: "comparison_matrix", sourceRows: rows, targetRows: rows })).toEqual({ ok: false, reason: "rebind_mismatch" });
    expect(rebindAdaptiveDisplayResults(rec, { sourceRunId: SRC, targetRunId: "run-new", schemaId: "comparison_matrix", sourceRows: rows, targetRows: rows }).ok).toBe(true);
  });
});

// ─── Idempotency and the snapshot lock ──────────────────────────────────────

describe("repeat requests and the snapshot lock", () => {
  beforeEach(async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
  });

  it("a repeated request returns the same snapshot (already_exists): no second run, no second display write, no display read", async () => {
    const first = await snapshot();
    expect(first.status).toBe(201);
    const id = snapshotRunId();
    const copy = db.read(displayPath(id));
    db.txReadLog.length = 0;
    const second = await snapshot();
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.body)).toContain(id);
    expect(snapshotRunId()).toBe(id);
    expect(db.writeLog.filter((w) => w.path.endsWith("/adaptiveDisplayResults/v1") && w.path !== displayPath(SRC))).toHaveLength(1);
    expect(db.read(displayPath(id))).toEqual(copy);
    expect(db.txReadLog).not.toContain(displayPath(SRC));
    // Control: the first request did read it.
    db.docs.delete(`runSnapshotLocks/${computeRunSnapshotLockId({ sourceRunId: SRC, workspaceId: WS, projectId: PROJECT })}`);
    db.txReadLog.length = 0;
    expect((await snapshot()).status).toBe(201);
    expect(db.txReadLog).toContain(displayPath(SRC));
  });

  it("a corrupt lock fails closed (integrity failure): no run and no display document written", async () => {
    db.seed(`runSnapshotLocks/${computeRunSnapshotLockId({ sourceRunId: SRC, workspaceId: WS, projectId: PROJECT })}`, { version: 1, junk: true });
    const before = db.writeLog.length;
    const r = await snapshot();
    expect(r.status).toBe(500);
    expect(db.writeLog.length).toBe(before);
    expect(db.paths("runs/").filter((p) => !p.startsWith(`runs/${SRC}`))).toEqual([]);
  });

  it("a racing same-tuple request that commits first: our attempt re-runs into the lock; exactly one snapshot and one display copy", async () => {
    let raced = false;
    db.hooks.afterTxReads = async () => {
      if (raced) return;
      raced = true;
      await createTeamRunSnapshotFromPersonal({ uid: OWNER, workspaceId: WS, projectId: PROJECT, sourceRunId: SRC });
    };
    const r = await snapshot();
    expect(r.status).toBe(200); // already_exists: the other request's snapshot
    const id = snapshotRunId();
    expect(db.paths("runs/").filter((p) => p.endsWith("/adaptiveDisplayResults/v1") && p !== displayPath(SRC))).toEqual([displayPath(id)]);
    expect((db.read(displayPath(id)) as any).runId).toBe(id);
  });
});

// ─── Atomicity: an injected failure commits nothing ─────────────────────────

describe("a failed write commits nothing (one transaction: run, lock, audit event and display record)", () => {
  beforeEach(async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
  });
  const nonSource = () => db.paths("").filter((p) => p.startsWith("runs/") ? !p.startsWith(`runs/${SRC}`) : p.startsWith("runSnapshotLocks/") || p.startsWith("workspaceMembershipEvents/"));

  it.each([
    ["the display record's create", (p: string) => p.startsWith("runs/") && p.endsWith("/adaptiveDisplayResults/v1") && !p.includes(SRC)],
    ["the snapshot lock's create", (p: string) => p.startsWith("runSnapshotLocks/")],
    ["the run's create", (p: string) => /^runs\/[^/]+$/.test(p) && !p.includes(SRC)],
  ])("%s fails → transaction_failed (500), no run, lock, event or display document; the retry creates the complete snapshot", async (_label, match) => {
    let injected = 0;
    db.hooks.failWrite = (w) => {
      if (match(w.path)) {
        injected += 1;
        throw new Error("UNAVAILABLE: injected");
      }
    };
    const r = await snapshot();
    expect(injected).toBe(1);
    expect(r.status).toBe(500);
    expect(nonSource()).toEqual([]);
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("transaction failed"), expect.anything());
    // Retry (no failure): the complete snapshot, display record included.
    db.hooks.failWrite = undefined;
    const retry = await snapshot();
    expect(retry.status).toBe(201);
    const id = snapshotRunId();
    expect((db.read(displayPath(id)) as any).runId).toBe(id);
    expect(origins(await readPayload(id))).toEqual({ chatgpt: "original_accepted", claude: "retry_adopted_full" });
  });
});

// ─── Authorization and tenancy ──────────────────────────────────────────────

describe("authorized access only; no cross-team disclosure", () => {
  let id: string;
  beforeEach(async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect((await snapshot()).status).toBe(201);
    id = snapshotRunId();
    directReads = [];
  });

  it("control: a member of the Team reads the adopted result through the Team route, which reads the display document once", async () => {
    const r = await teamRead(VIEWER, id);
    expect(r.status).toBe(200);
    expect(r.text).toContain("ClaudeRetry: carbon pricing");
    expect(directReads.filter((p) => p === displayPath(id))).toHaveLength(1);
  });

  it("a signed-in non-member gets the concealed 404 and the display document is never read", async () => {
    const r = await teamRead(OUTSIDER, id);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("ClaudeRetry");
    expect(directReads).not.toContain(displayPath(id));
  });

  it("a member of ANOTHER Team, through their own Workspace: concealed 404, display never read", async () => {
    const r = await teamRead(MEMBER_B, id, WS_B);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("ClaudeRetry");
    expect(directReads).not.toContain(displayPath(id));
  });

  it("snapshot creation by someone who is not the source's owner reads no display document and writes nothing", async () => {
    db.txReadLog.length = 0;
    const before = db.writeLog.length;
    const r = await snapshot(TEAM_OWNER);
    expect(r.status).toBe(404);
    expect(db.txReadLog).toContain(`runs/${SRC}`);
    expect(db.txReadLog).not.toContain(displayPath(SRC));
    expect(db.writeLog.length).toBe(before);
  });

  it("snapshot into a Team the caller does not belong to (cross-tenant) reads no display document and writes nothing", async () => {
    db.txReadLog.length = 0;
    const before = db.writeLog.length;
    const r = await snapshot(OWNER, WS_B, PROJECT_B);
    expect([403, 404]).toContain(r.status);
    expect(db.txReadLog).not.toContain(displayPath(SRC));
    expect(db.writeLog.length).toBe(before);
    expect(db.paths("runs/").filter((p) => p.endsWith("/adaptiveDisplayResults/v1"))).toEqual([displayPath(SRC), displayPath(id)]);
  });

  it("a Team viewer (no research.create) cannot snapshot; no display document is read", async () => {
    db.txReadLog.length = 0;
    const r = await snapshot(VIEWER);
    expect([403, 404]).toContain(r.status);
    expect(db.txReadLog).not.toContain(displayPath(SRC));
  });
});

// ─── Deletion ───────────────────────────────────────────────────────────────

describe("deletion", () => {
  beforeEach(async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await executeSource([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
  });

  it("a source being deleted (deletion mark) is never copied: concealed 404, display not read, nothing written", async () => {
    db.seed(`runs/${SRC}`, { ...db.read(`runs/${SRC}`)!, deletion: { state: "pending", requestedAt: "x", requestedByUserId: "sys" } });
    db.txReadLog.length = 0;
    const before = db.writeLog.length;
    const r = await snapshot();
    expect(r.status).toBe(404);
    expect(db.txReadLog).not.toContain(displayPath(SRC));
    expect(db.writeLog.length).toBe(before);
  });

  it("a deleted source (real deleteResearchRun) is never copied", async () => {
    expect(await deleteResearchRun({ runId: SRC, actorUid: "sysadmin", reason: "admin_delete" })).toMatchObject({ status: "deleted" });
    expect(db.paths(`runs/${SRC}`)).toEqual([]);
    const r = await snapshot();
    expect(r.status).toBe(404);
    expect(db.paths("runs/")).toEqual([]);
  });

  it("deleting the snapshot (real deleteResearchRun) removes its display document with its subtree; the source keeps its own", async () => {
    expect((await snapshot()).status).toBe(201);
    const id = snapshotRunId();
    const sourceRecord = db.read(displayPath(SRC));
    expect(db.read(displayPath(id))).toBeDefined();
    expect(await deleteResearchRun({ runId: id, actorUid: "sysadmin", reason: "admin_delete" })).toMatchObject({ status: "deleted", runId: id });
    expect(db.read(displayPath(id))).toBeUndefined();
    expect(db.paths(`runs/${id}`)).toEqual([]);
    expect(db.read(displayPath(SRC))).toEqual(sourceRecord);
    // The deleted snapshot reads as absent to an authorized member.
    expect((await teamRead(OWNER, id)).status).toBe(404);
  });
});
