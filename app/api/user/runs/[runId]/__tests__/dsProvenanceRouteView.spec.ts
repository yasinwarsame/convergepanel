/**
 * Order 6 S-1b.1 — acceptance suite for the `dsProvenance` field on P1
 * (`GET /api/user/runs/[runId]`) and W1
 * (`GET /api/workspaces/[workspaceId]/runs/[runId]`).
 *
 * Both REAL route handlers run in one module graph. The parsers, the
 * authorization helpers that decide roles (`classifyRunWorkspaceBindingShape`,
 * `resolveAdaptiveRunAccess`, `classifyDecisionScopeFromPersonalDoc`,
 * `deriveTeamRunViewerRole`, `validateTeamRunRowShape`), `buildRunReadPayload`,
 * the adapter and the S-1a-min builder are real; only I/O boundaries are mocked,
 * and every I/O call is recorded in order.
 *
 * Two independent oracles:
 *   (a) `oracleA` (dsProvenanceRouteCases.ts): the literal D-11(A) table and the
 *       owner's R11-OPEN-1 ruling, from the fixture record and viewer class only.
 *   (b) `__fixtures__/dsProvenanceRouteBaseline.45df2ea.json`: every case run
 *       through the UNMODIFIED handlers at main 45df2ea (status, headers, body
 *       sha-256, the ordered I/O sequence, the logger calls, and which
 *       human-review keys the baseline body carries). Regenerate only from that
 *       commit: DS_PROVENANCE_BASELINE_CAPTURE=<out.json> with this spec and
 *       dsProvenanceRouteCases.ts copied into a 45df2ea checkout.
 * The suite fails if the two oracles disagree about any field's visibility.
 */

let mockFlag = false;
jest.mock("@/lib/env", () => ({
  WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
  get DS_PROVENANCE_ROUTE_VIEW_ENABLED() {
    return mockFlag;
  },
}));

const mockIo: string[] = [];
const mockLogs: unknown[] = [];
const mockLog = (level: string) => (...args: unknown[]) => {
  mockLogs.push([level, ...args]);
};
jest.mock("@/lib/logger", () => ({ logger: { warn: mockLog("warn"), info: mockLog("info"), error: mockLog("error"), debug: mockLog("debug") } }));

const mockIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: (...a: unknown[]) => mockLogs.push(["identityTelemetry", ...a]) }));
const mockTeamAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...a: unknown[]) => {
    mockIo.push("teamAccess");
    return mockTeamAccess(...a);
  },
}));
const mockIntegrity = jest.fn();
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: (...a: unknown[]) => {
    mockIo.push("workspaceIntegrity");
    return mockIntegrity(...a);
  },
}));
const mockGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...a: unknown[]) => {
    mockIo.push("project");
    return mockGetProject(...a);
  },
}));
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({
  resolveRunAssigneesForPage: async () => {
    mockIo.push("assignees");
    return [null];
  },
}));
const mockAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...a: unknown[]) => {
    mockIo.push("assignment");
    return mockAssignment(...a);
  },
}));
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: async () => {
    mockIo.push("loadUserAndTeam");
    return { team: { id: "legacy-team-1" } };
  },
}));
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: async () => {
    mockIo.push("teamRunProjection");
    return { status: "found", projection: { projectionVersion: 1, adaptive: true, teamId: "legacy-team-1", runId: "run-parity-1" } };
  },
}));

const mockRunDocs = new Map<string, Record<string, unknown>>();
let mockHistory: { mode: "rows"; rows: Map<string, unknown> } | { mode: "throws" } = { mode: "rows", rows: new Map() };
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: () => ({
        doc: (runId: string) => ({
          get: async () => {
            mockIo.push("runDoc");
            return { exists: mockRunDocs.has(runId), data: () => mockRunDocs.get(runId) };
          },
          collection: (name: string) => ({
            doc: (id: string) => ({
              get: async () => {
                mockIo.push(`${name}:${id}`);
                if (mockHistory.mode === "throws") throw new Error("history read failed");
                const row = mockHistory.rows.get(id);
                return { exists: row !== undefined, data: () => row };
              },
            }),
          }),
        }),
      }),
    };
  },
}));

const mockBuilderCalls: unknown[] = [];
let mockBuilderOverride: ((input: unknown, actual: (i: unknown) => unknown) => unknown) | null = null;
jest.mock("@/lib/adaptiveSchema/dsProvenanceViewMin", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/dsProvenanceViewMin");
  return {
    ...actual,
    buildDsProvenanceViewMin: (input: unknown) => {
      mockBuilderCalls.push(input);
      return mockBuilderOverride ? mockBuilderOverride(input, actual.buildDsProvenanceViewMin) : actual.buildDsProvenanceViewMin(input);
    },
  };
});

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET as p1Get } from "@/app/api/user/runs/[runId]/route";
import { GET as w1Get } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/route";
import { buildPersonalReviewDecisionId } from "@/lib/governance/adaptiveHumanReviewHistory";
import {
  ADAPTIVE,
  CASES,
  DS_ADAPTIVE,
  OWNER,
  PROJECT_ID,
  RECORDS,
  RESTRICTED_RECORD_VALUES,
  REVIEWER,
  RUN_ID,
  SUCCESS_VIEWERS,
  TEAM_UID,
  UNREADABLE_OR_ABSENT,
  WS_ID,
  expectedFullView,
  expectedViewerRole,
  oracleA,
  storedHumanReview,
  type RouteCase,
} from "./dsProvenanceRouteCases";

// ─── Harness ───────────────────────────────────────────────────────────────

const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function perModelRows() {
  return [
    { modelId: "chatgpt", status: "ok", rawTextTruncated: "A", tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, latencyMs: 120, wasTruncated: false, provider: "openai", requestedModel: "gpt-5" },
    { modelId: "claude", status: "substituted", rawTextTruncated: "B", tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 }, latencyMs: 340, wasTruncated: false, provider: "deepseek", requestedModel: "claude-x", substitutedFrom: "claude" },
    { modelId: "gemini", status: "error", rawTextTruncated: "", latencyMs: 10, wasTruncated: false },
  ];
}

function runDocument(c: RouteCase): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    userId: c.viewer.runKind === "personal" ? OWNER : "creator-1",
    question: "Should we proceed?",
    selectedModels: ["chatgpt", "claude", "gemini"],
    status: "complete",
    runDocument: { perModel: perModelRows() },
    createdAt: CREATED,
  };
  if (c.viewer.runKind === "team") Object.assign(doc, { workspaceId: WS_ID, projectId: PROJECT_ID });
  const adaptive = ADAPTIVE[c.adaptive]();
  if (adaptive !== undefined) doc.adaptiveOutput = adaptive;
  if (!RECORDS[c.record].absentKey) doc.governanceRecord = RECORDS[c.record].make();
  Object.assign(doc, c.viewer.runOverrides ?? {});
  for (const k of c.viewer.dropRunKeys ?? []) delete doc[k];
  return doc;
}

function historyFor(c: RouteCase): typeof mockHistory {
  const mode = c.viewer.history;
  if (mode === "throws") return { mode: "throws" };
  const rows = new Map<string, unknown>();
  if ((mode === "qualifying" || mode === "team_row") && RECORDS[c.record].parses) {
    const hr = storedHumanReview(c.record);
    if (typeof hr.reviewedAt === "string" && typeof hr.status === "string") {
      rows.set(buildPersonalReviewDecisionId(RUN_ID, hr.reviewedAt, hr.status), {
        version: 1, kind: "adaptive_human_review", runId: RUN_ID, teamId: mode === "qualifying" ? null : "team-x",
        schemaId: "decision_support", answerShape: "decision_support_view", priorStatus: "unreviewed",
        newStatus: hr.status, reviewerId: hr.reviewerId, reviewedAt: hr.reviewedAt, commentPresent: false, conditionsCount: 0,
      });
    }
  }
  return { mode: "rows", rows };
}

function project(kind: RouteCase["viewer"]["project"]) {
  switch (kind) {
    case "found": return { status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Launch", status: "active" }, documentUpdateTime: CREATED };
    case "other_workspace": return { status: "found", project: { id: PROJECT_ID, workspaceId: "anotherTeamWorkspace00001", name: "Other", status: "active" }, documentUpdateTime: CREATED };
    case "read_failed": return { status: "read_failed" };
    default: return { status: "not_found" };
  }
}

interface Observation {
  status: number;
  headers: string;
  text: string;
  io: string[];
  logs: string;
  builderCalls: number;
}

async function observe(c: RouteCase, flag: boolean): Promise<Observation> {
  const v = c.viewer;
  mockFlag = flag;
  mockIo.length = 0;
  mockLogs.length = 0;
  mockBuilderCalls.length = 0;
  mockRunDocs.clear();
  if (!v.runAbsent) mockRunDocs.set(RUN_ID, runDocument(c));
  mockHistory = historyFor(c);
  mockIdentity.mockResolvedValue(v.uid === null ? { status: "unauthenticated", reason: "missing_credentials" } : { status: "authenticated", uid: v.uid, source: "session_cookie" });
  mockTeamAccess.mockResolvedValue(v.teamAccess ?? { granted: true, workspace: { id: WS_ID, type: "team" }, membership: { role: "member" }, capabilities: v.capabilities ?? [] });
  mockIntegrity.mockResolvedValue(v.integrity ?? { classification: "legacy" });
  mockGetProject.mockResolvedValue(project(v.project));
  mockAssignment.mockResolvedValue(
    v.runKind === "personal"
      ? { status: "found", assignment: { version: 1, runId: RUN_ID, teamId: null, assignedReviewerUserId: REVIEWER, assignedByUserId: OWNER, assignedAt: "2026-08-01T00:00:00.000Z", revision: 1 } }
      : v.assignedTeamReviewer
        ? { status: "found", assignment: { assignedReviewerUserId: TEAM_UID } }
        : { status: "unassigned" },
  );

  const headers = { "x-vercel-id": "vid-1" };
  const res =
    v.route === "P1"
      ? await p1Get(new NextRequest(`http://localhost/api/user/runs/${RUN_ID}`, { headers }), { params: Promise.resolve({ runId: RUN_ID }) })
      : await w1Get(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}${v.query ?? ""}`, { headers }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
  const text = await res.text();
  return {
    status: res.status,
    headers: JSON.stringify([...res.headers.entries()].sort()),
    text,
    io: [...mockIo],
    logs: JSON.stringify(mockLogs),
    builderCalls: mockBuilderCalls.length,
  };
}

interface Baseline {
  status: number;
  headers: string;
  bodySha256: string;
  io: string[];
  logsSha256: string;
  /** Keys of `adaptive.humanReview` in the baseline body (null when absent or not a 200). */
  humanReviewKeys: string[] | null;
  /** W1 only: keys of `team.review`. */
  teamReviewKeys: string[] | null;
}

function baselineOf(o: Observation): Baseline {
  const body = o.status === 200 ? JSON.parse(o.text) : null;
  const hr = body?.adaptive?.humanReview;
  const tr = body?.team?.review;
  return {
    status: o.status,
    headers: o.headers,
    bodySha256: sha(o.text),
    io: o.io,
    logsSha256: sha(o.logs),
    humanReviewKeys: hr ? Object.keys(hr).sort() : null,
    teamReviewKeys: tr ? Object.keys(tr).sort() : null,
  };
}

const CAPTURE = process.env.DS_PROVENANCE_BASELINE_CAPTURE;
const BASELINE_PATH = join(__dirname, "__fixtures__", "dsProvenanceRouteBaseline.45df2ea.json");
const BASELINE: { baseCommit: string; cases: Record<string, Baseline> } = CAPTURE ? { baseCommit: "", cases: {} } : JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

// ─── Per-case assertions (flag ON) ─────────────────────────────────────────

const VIEW_KEYS = ["kind", "version", "surfaceId", "l1", "l2", "l3", "l4", "humanReview", "useAuthorization"];
const SLOT_KEYS = ["slotId", "status", "requestedModel", "answeredByProvider", "substitutedFrom", "contributedRecommendation"];
const L2_KEYS = ["recommendation", "dispatchedModels", "recommendingModels", "largestAgreeingGroup", "dispatchedModelsLabel", "recommendingModelsLabel", "largestAgreeingGroupLabel", "denominatorStatement", "humanReviewNeeded", "rules", "computedAt"];
const L3_KEYS = ["sourcesListedByModels", "modelSelfReportedEvidenceStrength", "modelSelfReportedEvidenceStrengthLabel", "sourceCheck", "freshness"];
const NUMERIC_PATHS = new Set(["version", "l2.dispatchedModels", "l2.recommendingModels", "l2.largestAgreeingGroup", "l2.rules.envelopeVersion", "l3.sourcesListedByModels.count"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const IDENTITY_KEY = /reviewer|finaliz|recorded|assign|panel|supporting|override|justification|comment|name$|actor|uid/i;

function leaves(v: unknown, path = "", out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, path, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  else out.push([path, v]);
  return out;
}
function keyPaths(v: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keyPaths(x, path, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const p = path ? `${path}.${k}` : k; out.push(p); keyPaths(x, p, out); }
  return out;
}

/** Splits a flag-on 200 body into the baseline-shaped body and the appended view, asserting the view is the last key and nothing else changed. */
function splitView(text: string): { base: string; view: Record<string, any> | null } {
  const parsed = JSON.parse(text);
  if (!Object.prototype.hasOwnProperty.call(parsed, "dsProvenance")) return { base: text, view: null };
  const suffix = `,"dsProvenance":${JSON.stringify(parsed.dsProvenance)}}`;
  expect(text.endsWith(suffix)).toBe(true);
  expect(Object.keys(parsed).pop()).toBe("dsProvenance");
  return { base: text.slice(0, text.length - suffix.length) + "}", view: parsed.dsProvenance };
}

function assertFlagOn(c: RouteCase, on: Observation, b: Baseline): void {
  const a = oracleA(c);
  // Denials, reads, logs and headers: byte-identical to the 45df2ea handlers.
  expect(on.status).toBe(b.status);
  expect(on.headers).toBe(b.headers);
  expect(on.io).toEqual(b.io);
  expect(sha(on.logs)).toBe(b.logsSha256);

  const authorized = c.viewer.role !== null;
  const reviewInProjection = authorized && c.adaptive !== "malformed" && c.adaptive !== "absent" && RECORDS[c.record].parses;
  expect(on.builderCalls).toBe(reviewInProjection ? 1 : 0);

  if (on.status !== 200) {
    expect(sha(on.text)).toBe(b.bodySha256);
    expect(a.built).toBe(false);
    return;
  }
  const { base, view } = splitView(on.text);
  expect(sha(base)).toBe(b.bodySha256);
  if (!a.built) {
    expect(view).toBeNull();
    return;
  }
  expect(view).not.toBeNull();
  const body = JSON.parse(base);

  // Oracle (a): shape and the D-11(A) humanReview, exactly.
  expect(Object.keys(view!)).toEqual(VIEW_KEYS);
  expect(view!.kind).toBe("ds_provenance_min");
  expect(view!.version).toBe(1);
  expect(view!.surfaceId).toBe(a.surfaceId);
  expect(view!.useAuthorization).toBe("not_authorized_no_policy");
  expect(view!.humanReview).toEqual(a.humanReview);
  expect(body.viewerRole).toBe(expectedViewerRole(c));
  // The whole view, at every depth, equals oracle (a): no key beyond the contract can ride along (R1 M-1).
  expect(view).toStrictEqual(expectedFullView(a, body));

  // Oracle (a) ↔ oracle (b): the baseline body releases a human-review field to this viewer exactly when (a) allows it.
  const hr = storedHumanReview(c.record);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(hr, k) && hr[k] !== undefined;
  expect(b.humanReviewKeys).not.toBeNull();
  expect(b.humanReviewKeys!.includes("decidedVia")).toBe(a.decidedViaAllowed && has("decidedVia"));
  expect(b.humanReviewKeys!.includes("reviewedAt")).toBe(a.contentAllowed && typeof hr.reviewedAt === "string");
  expect(b.humanReviewKeys!.includes("conditions")).toBe(a.contentAllowed && has("conditions"));

  // L1–L3 come only from this same response: slot facts from `results`, counts and text from `adaptive.output`.
  const results = body.results as Array<Record<string, unknown>>;
  expect(view!.l1).toHaveLength(results.length);
  (view!.l1 as Array<Record<string, unknown>>).forEach((slot, i) => {
    expect(Object.keys(slot).every((k) => SLOT_KEYS.includes(k))).toBe(true);
    expect(slot.slotId).toBe(results[i].modelId);
    expect(slot.requestedModel).toBe(results[i].requestedModel ?? "not_recorded");
    expect(slot.answeredByProvider).toBe(results[i].provider ?? "not_recorded");
  });
  const output = body.adaptive.output;
  expect(Object.keys(view!.l2)).toEqual(L2_KEYS);
  expect(Object.keys(view!.l3)).toEqual(L3_KEYS);
  expect(view!.l2.computedAt).toBe(output.generatedAt);
  expect(view!.l2.dispatchedModels).toBe(output.result.totalModels);
  expect(view!.l2.recommendingModels).toBe(output.result.recommendation.totalModelsWithRecommendation);
  expect(view!.l2.largestAgreeingGroup).toBe(output.result.recommendation.supportCount);
  expect(view!.l2.recommendation.action).toBe(output.result.recommendation.action);
  expect(view!.l3.sourcesListedByModels.list).toEqual(output.result.sources);

  // Every copied string is a value this response already carries; nothing else is data-bearing.
  const responseStrings = new Set(leaves(body).filter(([, x]) => typeof x === "string").map(([, x]) => x as string));
  for (const [p, x] of leaves({ l1: view!.l1, l2: view!.l2, l3: view!.l3 })) {
    if (typeof x !== "string") continue;
    if (/^l1\.(slotId|requestedModel|answeredByProvider|substitutedFrom)$|^l2\.(recommendation\.(action|recommendedOptionId)|computedAt)$|^l3\.(sourcesListedByModels\.list|modelSelfReportedEvidenceStrength\.\w+)$/.test(p)) {
      if (x !== "unknown" && x !== "not_recorded") expect([p, responseStrings.has(x)]).toEqual([p, true]);
    }
  }
  // Disclosure ceiling: no identity, count or timestamp beyond the allowed paths.
  for (const [p, x] of leaves(view)) {
    expect([p, RESTRICTED_RECORD_VALUES.includes(x as string)]).toEqual([p, false]);
    if (typeof x === "number") expect([p, NUMERIC_PATHS.has(p)]).toEqual([p, true]);
    if (typeof x === "string" && ISO.test(x)) expect([p, p === "l2.computedAt" || p === "humanReview.reviewedAt"]).toEqual([p, true]);
  }
  for (const p of keyPaths(view)) expect([p, IDENTITY_KEY.test(p.split(".").pop()!)]).toEqual([p, false]);
}

// ─── Run every case once per flag state ───────────────────────────────────

const observations = new Map<string, { off: Observation; on: Observation }>();

beforeAll(async () => {
  for (const c of CASES) observations.set(c.id, { off: await observe(c, false), on: await observe(c, true) });
  mockFlag = false;
  if (CAPTURE) {
    const cases: Record<string, Baseline> = {};
    for (const c of CASES) cases[c.id] = baselineOf(observations.get(c.id)!.off);
    // The committed layout: one case per line.
    const lines = Object.entries(cases).map(([id, b]) => `${JSON.stringify(id)}: ${JSON.stringify(b)}`);
    writeFileSync(CAPTURE, `{\n"baseCommit": ${JSON.stringify(process.env.DS_PROVENANCE_BASELINE_COMMIT ?? "")},\n"cases": {\n${lines.join(",\n")}\n}\n}\n`);
  }
});

const run = CAPTURE ? describe.skip : describe;

run("frozen baseline (oracle b)", () => {
  it("was captured from main 45df2ea and covers exactly this case matrix", () => {
    expect(BASELINE.baseCommit).toBe("45df2eafed50806efe564e99dc2a25382bdf0f50");
    expect(Object.keys(BASELINE.cases).sort()).toEqual(CASES.map((c) => c.id).sort());
    // Not vacuous: real 200s, real denials of every status, and real DS reviews in the matrix.
    const statuses = new Set(Object.values(BASELINE.cases).map((b) => b.status));
    for (const s of [200, 401, 403, 404, 500, 503]) expect(statuses.has(s)).toBe(true);
    expect(CASES.filter((c) => oracleA(c).built).length).toBe(200);
  });
});

run("flag OFF (AC-1): byte-identical to 45df2ea, builder never called", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const { off } = observations.get(c.id)!;
    const b = BASELINE.cases[c.id];
    expect(off.status).toBe(b.status);
    expect(off.headers).toBe(b.headers);
    expect(sha(off.text)).toBe(b.bodySha256);
    expect(off.io).toEqual(b.io);
    expect(sha(off.logs)).toBe(b.logsSha256);
    expect(off.builderCalls).toBe(0);
    expect(off.text).not.toContain("dsProvenance");
    if (off.status === 200) expect(JSON.parse(off.text).viewerRole).toBe(expectedViewerRole(c));
  });
});

run("flag ON (AC-2..AC-6): denials frozen, reads and logs unchanged, view per oracle (a)", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    assertFlagOn(c, observations.get(c.id)!.on, BASELINE.cases[c.id]);
  });
});

run("R11-OPEN-1 (AC-8): absent and unreadable records are indistinguishable with the flag on", () => {
  for (const viewer of SUCCESS_VIEWERS) {
    for (const adaptive of Object.keys(ADAPTIVE)) {
      it(`${viewer.key} × ${adaptive}`, () => {
        const texts = UNREADABLE_OR_ABSENT.map((r) => observations.get(`${viewer.key}|${r}|${adaptive}`)!.on.text);
        expect(new Set(texts).size).toBe(1);
        expect(texts[0]).not.toContain("dsProvenance");
        expect(texts[0]).not.toContain("humanReviewUnavailable");
      });
    }
  }
});

run("per-surface identity: P1 and W1 build their own view, never a shared one", () => {
  it("the Team-path P1 view and the W1 view for the same run differ only in surfaceId", () => {
    let compared = 0;
    for (const c of CASES.filter((x) => x.viewer.key === "p1.team.member" && oracleA(x).built)) {
      const p1 = JSON.parse(observations.get(c.id)!.on.text).dsProvenance;
      const w1 = JSON.parse(observations.get(`w1.member|${c.record}|${c.adaptive}`)!.on.text).dsProvenance;
      expect(p1.surfaceId).toBe("P1");
      expect(w1.surfaceId).toBe("W1");
      expect({ ...w1, surfaceId: "P1" }).toEqual(p1);
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("the shared payload is untouched: `adaptive` never carries the view", () => {
    for (const c of CASES) {
      const o = observations.get(c.id)!.on;
      if (o.status !== 200) continue;
      const body = JSON.parse(o.text);
      expect(JSON.stringify(body.adaptive ?? null)).not.toContain("ds_provenance_min");
      if (body.team) expect(JSON.stringify(body.team)).not.toContain("ds_provenance_min");
    }
  });
});

// ─── Field-level disclosure (owner qualification) ─────────────────────────

const builtViews = () =>
  CASES.filter((c) => oracleA(c).built).map((c) => ({ c, view: JSON.parse(observations.get(c.id)!.on.text).dsProvenance as Record<string, any> }));

run("field-level disclosure ceiling", () => {
  it("never a reviewer, finalizer or overriding-owner identity, nor any review comment or justification", () => {
    for (const { c, view } of builtViews()) {
      const values = leaves(view).map(([, x]) => x);
      for (const r of RESTRICTED_RECORD_VALUES) expect([c.id, r, values.includes(r)]).toEqual([c.id, r, false]);
      expect(JSON.stringify(view)).not.toMatch(/OWNER-JUSTIFICATION|Rita Recorder|uid-admin|uid-ws-owner/);
    }
  });

  it("a personal reviewer never receives decidedVia, under any key or value", () => {
    const views = builtViews().filter(({ c }) => c.viewer.role === "personal_reviewer");
    expect(views.length).toBeGreaterThan(30);
    for (const { c, view } of views) {
      expect([c.id, "decidedVia" in view.humanReview]).toEqual([c.id, false]);
      expect(JSON.stringify(view)).not.toMatch(/single_reviewer|multi_reviewer|single_or_legacy|made_up_path/);
    }
  });

  it("a personal reviewer receives reviewedAt / conditions only for a decision proven Personal", () => {
    for (const { c, view } of builtViews().filter(({ c }) => c.viewer.role === "personal_reviewer")) {
      const proven = c.viewer.history === "qualifying" && !["team_panel_awc", "team_override_awc"].includes(c.record);
      if (!proven) {
        expect([c.id, "reviewedAt" in view.humanReview, "conditions" in view.humanReview]).toEqual([c.id, false, false]);
      }
    }
    // Positive control: the proven Personal decision does release them.
    const own = JSON.parse(observations.get("p1.rev.qualifying_row|personal_self_awc|ds_split")!.on.text).dsProvenance;
    expect(own.humanReview).toEqual({ state: "decided", decision: "approved_with_conditions", reviewedContent: "run_result_by_id_only", reviewedAt: "2026-10-24T15:09:30.143Z", conditions: ["COND-RITA-PERSONAL"] });
  });

  it("Team panel and owner-override decisions never reach a personal reviewer as content", () => {
    for (const record of ["team_panel_awc", "team_override_awc"]) {
      for (const h of ["qualifying_row", "absent_row", "team_row", "read_throws"]) {
        const view = JSON.parse(observations.get(`p1.rev.${h}|${record}|ds_split`)!.on.text).dsProvenance;
        expect(view.humanReview).toEqual({ state: "decided", decision: "approved_with_conditions", reviewedContent: "run_result_by_id_only" });
      }
    }
  });

  it("no reviewer or panel count and no panel revision appears; the only numbers are model and source counts", () => {
    for (const { c, view } of builtViews()) {
      for (const [p, x] of leaves(view)) if (typeof x === "number") expect([c.id, p, NUMERIC_PATHS.has(p)]).toEqual([c.id, p, true]);
      expect(JSON.stringify(view)).not.toMatch(/supportingReviewerCount|panelRevision|aggregationPolicyVersion/);
    }
  });

  it("the only timestamps are the output's generatedAt and a reviewedAt the viewer may already read", () => {
    for (const { c, view } of builtViews()) {
      for (const [p, x] of leaves(view)) {
        if (typeof x === "string" && ISO.test(x)) expect([c.id, p]).toEqual([c.id, p === "humanReview.reviewedAt" ? p : "l2.computedAt"]);
      }
      if (!oracleA(c).built || !(oracleA(c) as { contentAllowed: boolean }).contentAllowed) expect(view.humanReview.reviewedAt).toBeUndefined();
    }
  });

  it("Team viewers see decidedVia on P1 and W1 (positive control for the ceiling assertions)", () => {
    const view = JSON.parse(observations.get("p1.team.member|team_override_awc|ds_split")!.on.text).dsProvenance;
    expect(view.humanReview.decidedVia).toBe("multi_reviewer_owner_override");
    const w1 = JSON.parse(observations.get("w1.reviewer|team_panel_awc|ds_sources")!.on.text).dsProvenance;
    expect(w1.humanReview).toEqual({ state: "decided", decision: "approved_with_conditions", reviewedContent: "run_result_by_id_only", decidedVia: "multi_reviewer_panel", reviewedAt: "2026-10-02T00:00:00.000Z", conditions: ["COND-uid-pan-a", "COND-uid-pan-b"] });
  });
});

// ─── The suite detects the R3 defect class (AC-9) ──────────────────────────

run("R3-style flawed variants fail the acceptance assertions", () => {
  const personalBuilt = () => CASES.filter((c) => c.viewer.role === "personal_reviewer" && oracleA(c).built && (oracleA(c) as { humanReview: { state: string } }).humanReview.state === "decided");

  it("a response that hands decidedVia to a personal reviewer is rejected (every such case)", () => {
    const cases = personalBuilt();
    expect(cases.length).toBeGreaterThan(30);
    for (const c of cases) {
      const on = observations.get(c.id)!.on;
      const parsed = JSON.parse(on.text);
      parsed.dsProvenance.humanReview.decidedVia = "multi_reviewer_panel";
      expect(() => assertFlagOn(c, { ...on, text: JSON.stringify(parsed) }, BASELINE.cases[c.id])).toThrow();
    }
  });

  it("a view carrying any key beyond the contract is rejected, at any depth (R1 M-1: M6 / M12)", () => {
    const additions: Array<[string, (v: Record<string, any>) => void]> = [
      ["l4.decision_team_scoped", (v) => (v.l4.decision_team_scoped = true)],
      ["l2.recommendation.reviewHadConditions", (v) => (v.l2.recommendation.reviewHadConditions = true)],
      ["l2.rules.extra", (v) => (v.l2.rules.extra = "not_recorded")],
      ["l1[0].extra", (v) => (v.l1[0].extra = "unknown")],
      ["l3.sourcesListedByModels.extra", (v) => (v.l3.sourcesListedByModels.extra = false)],
      ["humanReview.extra", (v) => (v.humanReview.extra = false)],
    ];
    const cases = CASES.filter((c) => oracleA(c).built);
    for (const [name, add] of additions) {
      for (const c of cases) {
        const on = observations.get(c.id)!.on;
        const parsed = JSON.parse(on.text);
        add(parsed.dsProvenance);
        expect([name, c.id, (() => { try { assertFlagOn(c, { ...on, text: JSON.stringify(parsed) }, BASELINE.cases[c.id]); return "accepted"; } catch { return "rejected"; } })()]).toEqual([name, c.id, "rejected"]);
      }
    }
  });

  it("a response that emits the unavailable marker or a view for an unreadable record is rejected", () => {
    const c = CASES.find((x) => x.id === "p1.owner|malformed_status|ds_split")!;
    const on = observations.get(c.id)!.on;
    const leaked = on.text.slice(0, -1) + ',"dsProvenance":{"kind":"ds_provenance_min","humanReviewUnavailable":true}}';
    expect(() => assertFlagOn(c, { ...on, text: leaked }, BASELINE.cases[c.id])).toThrow();
  });

  it("the route-level R3 variant (adapter passes the owner context for a personal reviewer) fails the suite", async () => {
    mockBuilderOverride = (input, actual) => {
      const i = input as { surfaceRequest: Record<string, unknown> };
      return actual({ ...i, surfaceRequest: i.surfaceRequest.role === "personal_reviewer" ? { ...i.surfaceRequest, role: "owner", mayReadDecisionContent: true } : i.surfaceRequest });
    };
    try {
      let failures = 0;
      for (const c of personalBuilt()) {
        const flawed = await observe(c, true);
        try { assertFlagOn(c, flawed, BASELINE.cases[c.id]); } catch { failures++; }
      }
      expect(failures).toBe(personalBuilt().length);
    } finally {
      mockBuilderOverride = null;
    }
  });
});

it("the case matrix includes every DS output, every record state and every viewer class", () => {
  expect(new Set(CASES.map((c) => c.adaptive))).toEqual(new Set(Object.keys(ADAPTIVE)));
  expect(new Set(CASES.map((c) => c.record))).toEqual(new Set(Object.keys(RECORDS)));
  expect(CASES.some((c) => DS_ADAPTIVE.has(c.adaptive) && c.viewer.route === "W1" && oracleA(c).built)).toBe(true);
});
