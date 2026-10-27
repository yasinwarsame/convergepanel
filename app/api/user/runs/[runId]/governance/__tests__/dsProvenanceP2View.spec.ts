/**
 * Order 6 S-1b.2 — acceptance suite for the `dsProvenance` field on P2
 * (`GET /api/user/runs/[runId]/governance`).
 *
 * The REAL P2 handler and the REAL P1 handler (`GET /api/user/runs/[runId]`)
 * run in one module graph. The parsers, `validateRunWorkspaceAssociation`,
 * `classifyRunWorkspaceBindingShape`, `resolveAdaptiveRunAccess`, the
 * personal-review scope helpers, `buildReviewGovernanceViewModel`,
 * `buildRunReadPayload`, the adapter and the S-1a-min builder are real; only
 * I/O boundaries are mocked, and every I/O call is recorded in order.
 *
 * Three oracles:
 *   (a) `oracleA` (dsProvenanceP2Cases.ts): the literal P2 table, from the
 *       fixture record and viewer class only.
 *   (b) `__fixtures__/dsProvenanceP2Baseline.0b540a7.json`: every case run
 *       through the UNMODIFIED P2 handler at main 0b540a7 (status, headers, body
 *       sha-256, ordered I/O, logger calls, parser call counts, and the
 *       baseline's own `governance.singleReviewer.reviewedAt`). Regenerate only
 *       from that commit: DS_PROVENANCE_BASELINE_CAPTURE=<out.json> with this
 *       spec and dsProvenanceP2Cases.ts copied into a 0b540a7 checkout.
 *   (c) the real P1 handler on the same run document and caller: the D-P2-X
 *       condition. Every P2 viewer who receives the view must get a P1 200 that
 *       carries the same valid Decision Support output and a usable review.
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

let mockWorkspaceMode: string = "resolved";
jest.mock("@/lib/workspaces/workspaceResolver", () => ({
  ...jest.requireActual("@/lib/workspaces/workspaceResolver"),
  resolveWorkspaceContextForResource: async (args: { workspaceId: string; legacyOwnerUserId: string }) => {
    mockIo.push("workspaceResolve");
    switch (mockWorkspaceMode) {
      case "resolved":
        return { kind: "resolved", context: { mode: "workspace", workspaceId: args.workspaceId, workspaceType: "personal", ownerUserId: args.legacyOwnerUserId } };
      case "owner_mismatch":
        return { kind: "resolved", context: { mode: "workspace", workspaceId: args.workspaceId, workspaceType: "personal", ownerUserId: "uid-someone-else" } };
      case "lookup_failed":
        return { kind: "lookup_failed" };
      default:
        return { kind: "not_found" };
    }
  },
}));
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: async () => {
    mockIo.push("teamAccess");
    return { granted: false, reason: "membership_not_found" };
  },
}));
jest.mock("@/lib/firestore/projects", () => ({
  getProject: async () => {
    mockIo.push("project");
    return { status: "not_found" };
  },
}));
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({
  resolveRunAssigneesForPage: async () => {
    mockIo.push("assignees");
    return [null];
  },
}));

const mockAssignment = jest.fn();
const mockPanel = jest.fn();
const mockVote = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...a: unknown[]) => {
    mockIo.push("assignment");
    return mockAssignment(...a);
  },
  getAdaptiveHumanReviewPanel: (...a: unknown[]) => {
    mockIo.push("panel");
    return mockPanel(...a);
  },
  getAdaptiveHumanReviewVote: (...a: unknown[]) => {
    mockIo.push(`vote:${String(a[2])}`);
    return mockVote(...a);
  },
}));
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: async () => {
    mockIo.push("loadUserAndTeam");
    return { user: { email: "caller@example.test" }, team: { id: "legacy-team-1", members: [] } };
  },
}));
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: async () => {
    mockIo.push("teamRunProjection");
    return { status: "found", projection: { projectionVersion: 1, adaptive: true, teamId: "legacy-team-1", runId: "run-parity-1" } };
  },
}));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: async (uids: string[]) => {
    mockIo.push(`displayNames:${JSON.stringify([...uids].sort())}`);
    return new Map(uids.map((u) => [u, `Name-${u}`]));
  },
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
  REVIEWER_UNAVAILABLE_LABEL: "Reviewer unavailable",
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

// Parser call counts: with the flag off P2 must make exactly the baseline's calls (the adapter parses nothing).
const mockParseCounts = { governance: 0, output: 0 };
jest.mock("@/lib/adaptiveSchema/governanceRecordParser", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/governanceRecordParser");
  return { ...actual, parseGovernanceRecord: (r: unknown) => (mockParseCounts.governance++, actual.parseGovernanceRecord(r)) };
});
jest.mock("@/lib/adaptiveSchema/persistedOutput", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/persistedOutput");
  return { ...actual, parsePersistedAdaptiveOutput: (o: unknown) => (mockParseCounts.output++, actual.parsePersistedAdaptiveOutput(o)) };
});

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
import { GET as p2Get } from "@/app/api/user/runs/[runId]/governance/route";
import { GET as p1Get } from "@/app/api/user/runs/[runId]/route";
import { buildPersonalReviewDecisionId } from "@/lib/governance/adaptiveHumanReviewHistory";
import {
  ADAPTIVE,
  CASES,
  DENIAL_VIEWERS,
  DS_ADAPTIVE,
  OWNER,
  P2_RESTRICTED_VALUES,
  RECORDS,
  REVIEWER,
  RUN_ID,
  SUCCESS_VIEWERS,
  expectedP2View,
  identityAllowed,
  oracleA,
  storedHumanReview,
  type P2Case,
} from "./dsProvenanceP2Cases";

const { parsePersistedAdaptiveOutput: realParseOutput } = jest.requireActual("@/lib/adaptiveSchema/persistedOutput");
const GOLDENS = JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/fixtures/dsProvenanceViewMin.goldens.json"), "utf-8"));
const FLAG_TEXT: string = GOLDENS.semantics.flagText;
const HISTORY_TEXT: string = GOLDENS.semantics.historyText;

// ─── Harness ───────────────────────────────────────────────────────────────

const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function runDocument(c: P2Case): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    userId: OWNER,
    question: "Should we proceed?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    runDocument: {
      perModel: [
        { modelId: "chatgpt", status: "ok", rawTextTruncated: "A", latencyMs: 120, wasTruncated: false, provider: "openai", requestedModel: "gpt-5" },
        { modelId: "claude", status: "error", rawTextTruncated: "", latencyMs: 10, wasTruncated: false },
      ],
    },
    createdAt: CREATED,
  };
  if (c.viewer.workspace) doc.workspaceId = c.viewer.workspace.workspaceId;
  const adaptive = ADAPTIVE[c.adaptive]();
  if (adaptive !== undefined) doc.adaptiveOutput = adaptive;
  if (!RECORDS[c.record].absentKey) doc.governanceRecord = RECORDS[c.record].make();
  Object.assign(doc, c.viewer.runOverrides ?? {});
  return doc;
}

function historyFor(c: P2Case): typeof mockHistory {
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

function assignmentFor(c: P2Case) {
  const personal = { version: 1, runId: RUN_ID, teamId: null, assignedReviewerUserId: REVIEWER, assignedByUserId: OWNER, assignedAt: "2026-08-01T00:00:00.000Z", revision: 1 };
  switch (c.viewer.assignment ?? "personal") {
    case "team": return { status: "found", assignment: { ...personal, teamId: "team-1" } };
    case "unassigned": return { status: "unassigned" };
    case "read_failed": return { status: "read_failed" };
    default: return { status: "found", assignment: personal };
  }
}

const PANEL = {
  schemaVersion: 1, kind: "adaptive_review_panel", teamId: "team-1", runId: RUN_ID, mode: "majority_quorum",
  reviewerUserIds: ["reviewer-1", "reviewer-2"], requiredReviewerCount: 2, quorum: 2, status: "open", revision: 1,
  createdAt: "2026-08-12T10:00:00.000Z", createdByUserId: "admin-1", updatedAt: "2026-08-12T10:00:00.000Z", updatedByUserId: "admin-1",
};

function arrange(c: P2Case, flag: boolean): void {
  const v = c.viewer;
  mockFlag = flag;
  mockIo.length = 0;
  mockLogs.length = 0;
  mockBuilderCalls.length = 0;
  mockParseCounts.governance = 0;
  mockParseCounts.output = 0;
  mockRunDocs.clear();
  if (!v.runAbsent) mockRunDocs.set(RUN_ID, runDocument(c));
  mockHistory = historyFor(c);
  mockWorkspaceMode = v.workspace?.mode ?? "resolved";
  mockIdentity.mockResolvedValue(v.uid === null ? { status: "unauthenticated", reason: v.identityFailure } : { status: "authenticated", uid: v.uid, source: "session_cookie" });
  mockAssignment.mockResolvedValue(assignmentFor(c));
  mockPanel.mockResolvedValue(v.panel ? { status: "found", panel: PANEL } : { status: "absent" });
  mockVote.mockImplementation(async (_r: string, _rev: number, reviewerId: string) =>
    reviewerId === "reviewer-1"
      ? { status: "found", vote: { schemaVersion: 1, kind: "adaptive_human_review_vote", teamId: "team-1", runId: RUN_ID, panelRevision: 1, reviewerUserId: "reviewer-1", status: "approved", commentPresent: false, conditionsCount: 0, submittedAt: "2026-08-12T10:44:00.000Z" } }
      : { status: "absent" },
  );
}

interface Observation {
  status: number;
  headers: string;
  text: string;
  io: string[];
  logs: string;
  builderCalls: number;
  parseGovernance: number;
  parseOutput: number;
}

async function observe(c: P2Case, flag: boolean): Promise<Observation> {
  arrange(c, flag);
  const runId = c.viewer.runIdParam ?? RUN_ID;
  const res = await p2Get(new NextRequest(`http://localhost/api/user/runs/${encodeURIComponent(runId)}/governance`, { headers: { "x-vercel-id": "vid-1" } }), { params: Promise.resolve({ runId }) });
  const text = await res.text();
  return {
    status: res.status,
    headers: JSON.stringify([...res.headers.entries()].sort()),
    text,
    io: [...mockIo],
    logs: JSON.stringify(mockLogs),
    builderCalls: mockBuilderCalls.length,
    parseGovernance: mockParseCounts.governance,
    parseOutput: mockParseCounts.output,
  };
}

/** Oracle (c): the same caller and run document on the real P1 handler (flag off: P1's own projection only). */
async function observeP1(c: P2Case): Promise<{ status: number; body: Record<string, any> | null }> {
  arrange(c, false);
  const runId = c.viewer.runIdParam ?? RUN_ID;
  const res = await p1Get(new NextRequest(`http://localhost/api/user/runs/${encodeURIComponent(runId)}`, { headers: { "x-vercel-id": "vid-1" } }), { params: Promise.resolve({ runId }) });
  const text = await res.text();
  return { status: res.status, body: res.status === 200 ? JSON.parse(text) : null };
}

interface Baseline {
  status: number;
  headers: string;
  bodySha256: string;
  io: string[];
  logsSha256: string;
  parseGovernance: number;
  parseOutput: number;
  /** The baseline body's `humanReviewStatus` (null when absent or not a 200). */
  humanReviewStatus: string | null;
  /** The baseline body's `governance.singleReviewer.reviewedAt`: the value P2 already discloses to this viewer. */
  singleReviewerReviewedAt: string | null;
}

function baselineOf(o: Observation): Baseline {
  const body = o.status === 200 ? JSON.parse(o.text) : null;
  return {
    status: o.status,
    headers: o.headers,
    bodySha256: sha(o.text),
    io: o.io,
    logsSha256: sha(o.logs),
    parseGovernance: o.parseGovernance,
    parseOutput: o.parseOutput,
    humanReviewStatus: typeof body?.humanReviewStatus === "string" ? body.humanReviewStatus : null,
    singleReviewerReviewedAt: typeof body?.governance?.singleReviewer?.reviewedAt === "string" ? body.governance.singleReviewer.reviewedAt : null,
  };
}

const CAPTURE = process.env.DS_PROVENANCE_BASELINE_CAPTURE;
const BASELINE_PATH = join(__dirname, "__fixtures__", "dsProvenanceP2Baseline.0b540a7.json");
const BASELINE: { baseCommit: string; cases: Record<string, Baseline> } = CAPTURE ? { baseCommit: "", cases: {} } : JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

// ─── Per-case assertions (flag ON) ─────────────────────────────────────────

const P2_VIEW_KEYS = ["kind", "version", "surfaceId", "l4", "humanReview", "useAuthorization"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const IDENTITY_KEY = /reviewer|finaliz|recorded|assign|panel|supporting|override|justification|comment|name$|actor|uid|decidedVia|conditions|count/i;
const PARSEABLE_OUTPUT = new Set(["ds_split", "ds_sources", "deep_research"]);

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

/** Splits a flag-on 200 body into the baseline-shaped body and the appended view, asserting the view is the last key. */
function splitView(text: string): { base: string; view: Record<string, any> | null } {
  const parsed = JSON.parse(text);
  if (!Object.prototype.hasOwnProperty.call(parsed, "dsProvenance")) return { base: text, view: null };
  const suffix = `,"dsProvenance":${JSON.stringify(parsed.dsProvenance)}}`;
  expect(text.endsWith(suffix)).toBe(true);
  expect(Object.keys(parsed).pop()).toBe("dsProvenance");
  return { base: text.slice(0, text.length - suffix.length) + "}", view: parsed.dsProvenance };
}

function assertFlagOn(c: P2Case, on: Observation, b: Baseline): void {
  const a = oracleA(c);
  // Denials, reads, logs and headers: byte-identical to the 0b540a7 handler.
  expect(on.status).toBe(b.status);
  expect(on.headers).toBe(b.headers);
  expect(on.io).toEqual(b.io);
  expect(sha(on.logs)).toBe(b.logsSha256);

  // Nothing is parsed or built on a denial; on a 200 the adapter parses the record, then the output, then builds.
  const usable = on.status === 200 && RECORDS[c.record].parses;
  const builds = usable && PARSEABLE_OUTPUT.has(c.adaptive);
  expect(on.builderCalls).toBe(builds ? 1 : 0);
  // The builder reads the record only after the output passed its Decision Support gate.
  expect(on.parseGovernance).toBe(b.parseGovernance + (on.status === 200 ? 1 : 0) + (builds && DS_ADAPTIVE.has(c.adaptive) ? 1 : 0));
  expect(on.parseOutput).toBe(b.parseOutput + (usable ? 1 : 0) + (builds ? 1 : 0));

  if (on.status !== 200) {
    expect(sha(on.text)).toBe(b.bodySha256);
    expect(a.built).toBe(false);
    return;
  }
  const { base, view } = splitView(on.text);
  expect(sha(base)).toBe(b.bodySha256);
  if (!a.built) {
    // Omitted entirely, never `"dsProvenance": null`: the whole body is the baseline body.
    expect(view).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(on.text), "dsProvenance")).toBe(false);
    expect(sha(on.text)).toBe(b.bodySha256);
    return;
  }
  expect(view).not.toBeNull();
  const body = JSON.parse(base);
  expect(body.viewerRole).toBe(c.viewer.role);

  // Oracle (a): the whole view, at every depth and in contract key order.
  expect(Object.keys(view!)).toEqual(P2_VIEW_KEYS);
  expect(view).toStrictEqual(expectedP2View(a, FLAG_TEXT, HISTORY_TEXT));
  expect(JSON.stringify(view)).toBe(JSON.stringify(expectedP2View(a, FLAG_TEXT, HISTORY_TEXT)));

  // Oracle (a) ↔ oracle (b): the review the view reports is the one this exact P2 response already reports, and a
  // decided reviewedAt appears exactly when (and as) the baseline P2 body discloses it to this viewer.
  expect(view!.humanReview.decision).toBe(b.humanReviewStatus);
  if (view!.humanReview.state === "decided") {
    expect(view!.humanReview.reviewedAt ?? null).toBe(b.singleReviewerReviewedAt);
  } else {
    expect("reviewedAt" in view!.humanReview).toBe(false);
  }

  // Disclosure ceiling: no identity, no count, no timestamp beyond a reviewedAt the viewer already reads.
  for (const [p, x] of leaves(view)) {
    expect([p, P2_RESTRICTED_VALUES.includes(x as string)]).toEqual([p, false]);
    if (typeof x === "string") expect([p, /Name-|uid-|reviewer-\d/.test(x)]).toEqual([p, false]);
    if (typeof x === "number") expect(p).toBe("version");
    if (typeof x === "string" && ISO.test(x)) expect(p).toBe("humanReview.reviewedAt");
  }
  for (const p of keyPaths(view)) expect([p, IDENTITY_KEY.test(p.split(".").pop()!)]).toEqual([p, false]);
}

// ─── Run every case once per flag state, plus P1 for the cross-route oracle ───

const observations = new Map<string, { off: Observation; on: Observation }>();
const p1 = new Map<string, { status: number; body: Record<string, any> | null }>();

beforeAll(async () => {
  for (const c of CASES) observations.set(c.id, { off: await observe(c, false), on: await observe(c, true) });
  if (!CAPTURE) for (const c of CASES) p1.set(c.id, await observeP1(c));
  mockFlag = false;
  if (CAPTURE) {
    const lines = CASES.map((c) => `${JSON.stringify(c.id)}: ${JSON.stringify(baselineOf(observations.get(c.id)!.off))}`);
    writeFileSync(CAPTURE, `{\n"baseCommit": ${JSON.stringify(process.env.DS_PROVENANCE_BASELINE_COMMIT ?? "")},\n"cases": {\n${lines.join(",\n")}\n}\n}\n`);
  }
});

const run = CAPTURE ? describe.skip : describe;
const builtCases = () => CASES.filter((c) => oracleA(c).built);
const viewOf = (c: P2Case) => JSON.parse(observations.get(c.id)!.on.text).dsProvenance as Record<string, any>;

run("frozen baseline (oracle b)", () => {
  it("was captured from main 0b540a7 and covers exactly this case matrix", () => {
    expect(BASELINE.baseCommit).toBe("0b540a7303448777984f170fbdcec9294d1fc869");
    expect(Object.keys(BASELINE.cases).sort()).toEqual(CASES.map((c) => c.id).sort());
    const statuses = new Set(Object.values(BASELINE.cases).map((b) => b.status));
    for (const s of [200, 401, 403, 404, 500]) expect(statuses.has(s)).toBe(true);
    // Not vacuous: Personal Workspace runs consult the resolver; a qualifying reviewer reads the history row; the
    // owner's panel is read; the baseline releases a singleReviewer reviewedAt to some viewers and not to others.
    expect(BASELINE.cases["p2ws.owner|approved_single_no_via|ds_split"].io).toContain("workspaceResolve");
    expect(BASELINE.cases["p2.rev.qualifying_row|personal_self_awc|ds_split"].io.some((x) => x.startsWith("humanReviewHistory:"))).toBe(true);
    expect(BASELINE.cases["p2.owner.panel|unreviewed|ds_split"].io).toEqual(expect.arrayContaining(["panel", "vote:reviewer-1", "vote:reviewer-2"]));
    const released = Object.values(BASELINE.cases).filter((b) => b.singleReviewerReviewedAt !== null).length;
    expect(released).toBeGreaterThan(20);
    expect(Object.values(BASELINE.cases).filter((b) => b.status === 200 && b.humanReviewStatus !== null && b.singleReviewerReviewedAt === null).length).toBeGreaterThan(20);
    expect(builtCases().length).toBe(PINNED_BUILT);
  });
});

run("flag OFF (AC-1): byte-identical to 0b540a7, no added parse, builder never called", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const { off } = observations.get(c.id)!;
    const b = BASELINE.cases[c.id];
    expect(off.status).toBe(b.status);
    expect(off.headers).toBe(b.headers);
    expect(sha(off.text)).toBe(b.bodySha256);
    expect(off.io).toEqual(b.io);
    expect(sha(off.logs)).toBe(b.logsSha256);
    expect(off.parseGovernance).toBe(b.parseGovernance);
    expect(off.parseOutput).toBe(b.parseOutput);
    expect(off.builderCalls).toBe(0);
    expect(off.text).not.toContain("dsProvenance");
  });
});

run("flag ON (AC-2..AC-8): denials frozen, reads and logs unchanged, view per oracle (a) and (b)", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    assertFlagOn(c, observations.get(c.id)!.on, BASELINE.cases[c.id]);
  });
});

// ─── D-P2-X: the cross-route condition (oracle c) ─────────────────────────

const P1_DS_WITH_REVIEW = (c: P2Case) => {
  const r = p1.get(c.id)!;
  return r.status === 200 && r.body!.adaptive?.status === "valid" && r.body!.adaptive.output?.schemaId === "decision_support" && r.body!.adaptive.humanReview !== null;
};

run("D-P2-X: every P2 view is backed by the same viewer's P1 Decision Support output (oracle c)", () => {
  it("every P2 response carrying dsProvenance has a P1 200 with the same valid Decision Support output and a usable review", () => {
    let checked = 0;
    for (const c of CASES) {
      if (!Object.prototype.hasOwnProperty.call(JSON.parse(observations.get(c.id)!.on.text || "{}"), "dsProvenance")) continue;
      const r = p1.get(c.id)!;
      expect([c.id, r.status]).toEqual([c.id, 200]);
      expect([c.id, P1_DS_WITH_REVIEW(c)]).toEqual([c.id, true]);
      const stored = realParseOutput(runDocument(c).adaptiveOutput);
      expect(r.body!.adaptive.output).toEqual(JSON.parse(JSON.stringify(stored.output)));
      checked++;
    }
    expect(checked).toBe(PINNED_BUILT);
  });

  it("admission equivalence: every authorized P2 200 is a P1 200 for the same caller, with the same role", () => {
    let checked = 0;
    for (const c of CASES) {
      const p2 = observations.get(c.id)!.on;
      if (p2.status !== 200) continue;
      const r = p1.get(c.id)!;
      expect([c.id, r.status]).toEqual([c.id, 200]);
      expect([c.id, r.body!.viewerRole]).toEqual([c.id, JSON.parse(p2.text).viewerRole]);
      checked++;
    }
    expect(checked).toBeGreaterThan(900);
  });

  it("the view appears exactly when P2 answers 200 and P1 shows this viewer a valid Decision Support output with a usable review", () => {
    for (const c of CASES) {
      const on = observations.get(c.id)!.on;
      const present = on.status === 200 && Object.prototype.hasOwnProperty.call(JSON.parse(on.text), "dsProvenance");
      expect([c.id, present]).toEqual([c.id, on.status === 200 && P1_DS_WITH_REVIEW(c)]);
    }
  });

  it("not vacuous: P1 denies some callers P2 also denies, and P1 shows non-DS or review-less outputs where P2 builds nothing", () => {
    expect(CASES.filter((c) => observations.get(c.id)!.on.status !== 200 && p1.get(c.id)!.status !== 200).length).toBeGreaterThan(100);
    expect(CASES.filter((c) => observations.get(c.id)!.on.status === 200 && !P1_DS_WITH_REVIEW(c)).length).toBeGreaterThan(300);
  });
});

// ─── Denial and record-state preservation ─────────────────────────────────

run("PR #259 and record states (AC-2, AC-6, AC-7)", () => {
  it("every unauthorized 403 is one byte-identical response, whatever the record holds", () => {
    const forbidden = DENIAL_VIEWERS.filter((v) => CASES.some((c) => c.viewer === v && observations.get(c.id)!.on.status === 403));
    expect(forbidden.map((v) => v.key).sort()).toEqual(["p2.rev.assignment_read_failed", "p2.rev.team_assignment", "p2.rev.unassigned", "p2.stranger", "p2.stranger.panel_present", "p2ws.stranger"]);
    for (const v of forbidden) {
      const obs = CASES.filter((c) => c.viewer === v).map((c) => observations.get(c.id)!.on);
      expect(obs.length).toBe(36);
      expect(new Set(obs.map((o) => `${o.status}|${o.headers}|${o.text}|${JSON.stringify(o.io)}|${o.logs}`)).size).toBe(1);
      expect(obs[0].status).toBe(403);
    }
  });

  it("an authorized viewer's unreadable record is still the baseline 500, and an absent record the baseline 200, with no view", () => {
    for (const v of SUCCESS_VIEWERS) {
      for (const adaptive of Object.keys(ADAPTIVE)) {
        // On P2 a `null` record parses as absent (200); only these are unreadable (500).
        for (const record of ["malformed_status", "unsupported_version", "non_object", "array"]) {
          const o = observations.get(`${v.key}|${record}|${adaptive}`)!.on;
          expect([v.key, record, o.status]).toEqual([v.key, record, 500]);
          expect(sha(o.text)).toBe(BASELINE.cases[`${v.key}|${record}|${adaptive}`].bodySha256);
        }
        for (const record of ["absent", "null"]) {
          const absent = observations.get(`${v.key}|${record}|${adaptive}`)!.on;
          expect([v.key, record, absent.status]).toEqual([v.key, record, 200]);
          expect(sha(absent.text)).toBe(BASELINE.cases[`${v.key}|${record}|${adaptive}`].bodySha256);
          expect(absent.text).not.toContain("dsProvenance");
        }
      }
    }
  });

  it("no view ever carries the unavailable marker or a no-review state", () => {
    for (const c of CASES) expect([c.id, /humanReviewUnavailable|"state":"none"/.test(observations.get(c.id)!.on.text)]).toEqual([c.id, false]);
  });
});

// ─── Field-level disclosure ───────────────────────────────────────────────

run("field-level disclosure ceiling (D-11(A) on P2)", () => {
  it("never decidedVia, conditions, an identity, a count or a panel field, for any viewer", () => {
    for (const c of builtCases()) {
      const s = JSON.stringify(viewOf(c));
      // `"conditions"` as a key only: the decision value `approved_with_conditions` is the status P2 already reports.
      expect([c.id, /"decidedVia"|"conditions"|single_or_legacy|multi_reviewer|COND-|Name-|reviewer-\d|uid-|panel|quorum|Count/.test(s)]).toEqual([c.id, false]);
    }
  });

  it("reviewedAt only where this exact P2 response already releases governance.singleReviewer.reviewedAt", () => {
    let released = 0;
    let withheld = 0;
    for (const c of builtCases()) {
      const v = viewOf(c);
      const b = BASELINE.cases[c.id];
      if ("reviewedAt" in v.humanReview) {
        released++;
        expect(v.humanReview.reviewedAt).toBe(b.singleReviewerReviewedAt);
      } else if (v.humanReview.state === "decided") {
        withheld++;
        expect([c.id, b.singleReviewerReviewedAt]).toEqual([c.id, null]);
      }
    }
    expect(released).toBeGreaterThan(20);
    expect(withheld).toBeGreaterThan(20);
  });

  it("a personal reviewer gets reviewedAt only as the recorded decider or for a decision proven Personal", () => {
    for (const c of builtCases().filter((x) => x.viewer.role === "personal_reviewer")) {
      if (!identityAllowed(c)) expect([c.id, "reviewedAt" in viewOf(c).humanReview]).toEqual([c.id, false]);
    }
    // Positive and negative controls.
    expect(viewOf(CASES.find((c) => c.id === "p2.rev.qualifying_row|single_reviewer_personal|ds_split")!).humanReview.reviewedAt).toEqual(expect.any(String));
    // The reviewer decided single_reviewer_personal themselves (self case); approved_single_no_via was decided by someone else.
    expect(viewOf(CASES.find((c) => c.id === "p2.rev.absent_row|single_reviewer_personal|ds_split")!).humanReview.reviewedAt).toEqual(expect.any(String));
    expect("reviewedAt" in viewOf(CASES.find((c) => c.id === "p2.rev.absent_row|approved_single_no_via|ds_split")!).humanReview).toBe(false);
    expect(viewOf(CASES.find((c) => c.id === "p2.rev.qualifying_row|approved_single_no_via|ds_split")!).humanReview.reviewedAt).toEqual(expect.any(String));
    expect(viewOf(CASES.find((c) => c.id === "p2.owner|team_panel_awc|ds_split")!).humanReview).toEqual({ state: "decided", decision: "approved_with_conditions", reviewedContent: "run_result_by_id_only" });
  });

  it("owner and personal-reviewer views of one run differ only in what the identity gate releases", () => {
    let compared = 0;
    for (const c of builtCases().filter((x) => x.viewer.key === "p2.rev.absent_row")) {
      const owner = viewOf(CASES.find((x) => x.id === `p2.owner|${c.record}|${c.adaptive}`)!);
      const rev = viewOf(c);
      const { reviewedAt: _o, ...ownerRest } = owner.humanReview;
      const { reviewedAt: _r, ...revRest } = rev.humanReview;
      expect({ ...owner, humanReview: ownerRest }).toEqual({ ...rev, humanReview: revRest });
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });
});

// ─── The suite detects flawed variants (AC-9) ─────────────────────────────

const rejects = (c: P2Case, on: Observation): "accepted" | "rejected" => {
  try {
    assertFlagOn(c, on, BASELINE.cases[c.id]);
    return "accepted";
  } catch {
    return "rejected";
  }
};
const withView = (on: Observation, edit: (v: Record<string, any>) => void): Observation => {
  const parsed = JSON.parse(on.text);
  edit(parsed.dsProvenance);
  return { ...on, text: JSON.stringify(parsed) };
};

run("flawed variants fail the acceptance assertions", () => {
  it("decidedVia, conditions or an extra reviewedAt in a P2 view is rejected (every built case)", () => {
    for (const c of builtCases()) {
      const on = observations.get(c.id)!.on;
      expect([c.id, rejects(c, withView(on, (v) => (v.humanReview.decidedVia = "single_or_legacy")))]).toEqual([c.id, "rejected"]);
      expect([c.id, rejects(c, withView(on, (v) => (v.humanReview.conditions = [])))]).toEqual([c.id, "rejected"]);
      if (!("reviewedAt" in viewOf(c).humanReview)) {
        expect([c.id, rejects(c, withView(on, (v) => (v.humanReview.reviewedAt = "2026-10-24T15:09:30.143Z")))]).toEqual([c.id, "rejected"]);
      }
    }
  });

  it("a key beyond the contract, at any depth, or an L1–L3 section, is rejected", () => {
    const additions: Array<(v: Record<string, any>) => void> = [
      (v) => (v.l1 = { slots: "unknown" }),
      (v) => (v.l4.coverage_partial = "unknown"),
      (v) => (v.l4.contested = false),
      (v) => (v.humanReview.extra = false),
      (v) => (v.extra = true),
    ];
    for (const c of builtCases()) for (const add of additions) expect([c.id, rejects(c, withView(observations.get(c.id)!.on, add))]).toEqual([c.id, "rejected"]);
  });

  it("an explicit `dsProvenance: null` on any not-built 200 is rejected", () => {
    const cases = CASES.filter((c) => !oracleA(c).built && observations.get(c.id)!.on.status === 200);
    expect(cases.length).toBe(PINNED_NOT_BUILT_200);
    for (const c of cases) {
      const on = observations.get(c.id)!.on;
      expect([c.id, rejects(c, { ...on, text: on.text.slice(0, -1) + ',"dsProvenance":null}' })]).toEqual([c.id, "rejected"]);
    }
  });

  it("a view whose key order differs is rejected", () => {
    const reorder = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).reverse());
    for (const c of builtCases()) {
      for (const part of ["l4", "humanReview"] as const) {
        expect([c.id, part, rejects(c, withView(observations.get(c.id)!.on, (v) => (v[part] = reorder(v[part]))))]).toEqual([c.id, part, "rejected"]);
      }
    }
  });

  it("the unavailable marker on an unreadable record's 500, or a view on a denial, is rejected", () => {
    for (const id of ["p2.owner|malformed_status|ds_split", "p2.stranger|team_panel_awc|ds_split"]) {
      const c = CASES.find((x) => x.id === id)!;
      const on = observations.get(id)!.on;
      expect(rejects(c, { ...on, text: on.text.slice(0, -1) + ',"dsProvenance":{"kind":"ds_provenance_min","humanReviewUnavailable":true}}' })).toBe("rejected");
    }
  });

  it("route-level variant: the builder gets the owner context for a personal reviewer → the suite fails", async () => {
    const targets = builtCases().filter((c) => c.viewer.role === "personal_reviewer" && !identityAllowed(c) && oracleA(c).built && "reviewedAt" in expectedOwnerHumanReview(c));
    expect(targets.length).toBeGreaterThan(5);
    mockBuilderOverride = (input, actual) => {
      const i = input as { surfaceRequest: Record<string, unknown> };
      return actual({ ...i, surfaceRequest: { ...i.surfaceRequest, role: "owner", mayReadDecisionReviewer: true } });
    };
    try {
      for (const c of targets) expect([c.id, rejects(c, await observe(c, true))]).toEqual([c.id, "rejected"]);
    } finally {
      mockBuilderOverride = null;
    }
  });

  it("route-level variant: the builder gets a P1 owner context → the suite fails on every built case", async () => {
    mockBuilderOverride = (input, actual) => {
      const i = input as Record<string, unknown>;
      return actual({ ...i, surfaceRequest: { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true } });
    };
    try {
      for (const c of builtCases().filter((_, k) => k % 7 === 0)) expect([c.id, rejects(c, await observe(c, true))]).toEqual([c.id, "rejected"]);
    } finally {
      mockBuilderOverride = null;
    }
  });
});

function expectedOwnerHumanReview(c: P2Case): Record<string, unknown> {
  const a = oracleA({ ...c, viewer: { key: "x", uid: OWNER, role: "owner" } });
  return a.built ? a.humanReview : {};
}

const PINNED_BUILT = 312;
const PINNED_NOT_BUILT_200 = 598;

it("the case matrix includes every DS output, every record state and every viewer class", () => {
  expect(new Set(CASES.map((c) => c.adaptive))).toEqual(new Set(Object.keys(ADAPTIVE)));
  expect(new Set(CASES.map((c) => c.record))).toEqual(new Set(Object.keys(RECORDS)));
  expect(CASES.some((c) => DS_ADAPTIVE.has(c.adaptive) && c.viewer.workspace && oracleA(c).built)).toBe(true);
});
