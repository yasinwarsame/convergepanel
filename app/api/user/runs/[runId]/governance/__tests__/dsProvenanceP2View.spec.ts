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
 *       condition, as qualified by owner ruling A2. Every P2 viewer who receives
 *       the view must pass P1's own authorization and workspace-integrity checks
 *       for that run, and wherever P1 returns its Decision Support output the view
 *       must be backed by exactly that output (same role, usable review). A P1
 *       HTTP 200 is NOT required only when P1 throws one of the two documented
 *       malformed-perModel TypeErrors inside `runDocumentToPublicResults` (a null
 *       row, O6-OBS-5; a non-array perModel); then P1's admission is shown by the
 *       same caller and run with a well-formed perModel returning a P1 200 with the
 *       same role and output. Every other P1 failure is excluded.
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
  MALFORMED_PERMODEL_VIEWERS,
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
  if (c.viewer.perModelDefect) doc.runDocument = { perModel: c.viewer.perModelDefect.value };
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

interface P1Observation {
  /** The HTTP status, or "threw" when the handler rejected (the runtime turns that into a 500). */
  status: number | "threw";
  body: Record<string, any> | null;
  error: { name: string; message: string; stack: string } | null;
  io: string[];
}

/** Oracle (c): the same caller and run document on the real P1 handler (flag off: P1's own projection only). */
async function observeP1(c: P2Case): Promise<P1Observation> {
  arrange(c, false);
  const runId = c.viewer.runIdParam ?? RUN_ID;
  try {
    const res = await p1Get(new NextRequest(`http://localhost/api/user/runs/${encodeURIComponent(runId)}`, { headers: { "x-vercel-id": "vid-1" } }), { params: Promise.resolve({ runId }) });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? JSON.parse(text) : null, error: null, io: [...mockIo] };
  } catch (e) {
    const err = e as Error;
    return { status: "threw", body: null, error: { name: err?.constructor?.name ?? "unknown", message: String(err?.message), stack: String(err?.stack) }, io: [...mockIo] };
  }
}

/**
 * Owner ruling A2: a P1 failure is excused ONLY when it is one of the two documented malformed-perModel mechanisms
 * inside `runDocumentToPublicResults`, identified by its exact TypeError message and by the throwing (first) stack
 * frame, never by the HTTP status. Anything else (another message, another frame, a non-TypeError, a 500 response,
 * a denial) is not excused.
 *
 * The rule is a parameter only so the suite can prove its own negative tests fail against deliberately weakened
 * matching (`WEAKENED_RULES`); every oracle decision uses `STRICT_RULE`.
 */
const PERMODEL_MECHANISMS = {
  null_row: "Cannot read properties of null (reading 'rawTextTruncated')",
  non_array: "runDocument.perModel.map is not a function",
} as const;
type Mechanism = keyof typeof PERMODEL_MECHANISMS;
interface AttributionRule {
  requireTypeError: boolean;
  /** "first": only the first stack frame may be in the target file; "any": any frame (weakened). */
  frame: "first" | "any";
  /** "exact": the documented message verbatim; "loose": shared prefix / suffix (weakened). */
  message: "exact" | "loose";
  /** Whether the thrown mechanism must be the case's own seeded defect. */
  requireKindMatch: boolean;
}
const STRICT_RULE: AttributionRule = { requireTypeError: true, frame: "first", message: "exact", requireKindMatch: true };
const WEAKENED_RULES: Record<string, AttributionRule> = {
  any_frame: { ...STRICT_RULE, frame: "any" },
  loose_message: { ...STRICT_RULE, message: "loose" },
  any_error_type: { ...STRICT_RULE, requireTypeError: false },
  no_kind_match: { ...STRICT_RULE, requireKindMatch: false },
};
const TARGET_FILE = /lib[\\/]user[\\/]runDocumentToPublicResults\.ts:\d+:\d+/;
function attributedPerModelMechanism(o: Pick<P1Observation, "status" | "error">, rule: AttributionRule = STRICT_RULE): Mechanism | null {
  if (o.status !== "threw" || !o.error) return null;
  if (rule.requireTypeError && o.error.name !== "TypeError") return null;
  const frames = o.error.stack.split("\n").filter((l) => /^\s+at /.test(l));
  if (!(rule.frame === "first" ? TARGET_FILE.test(frames[0] ?? "") : frames.some((f) => TARGET_FILE.test(f)))) return null;
  for (const [kind, message] of Object.entries(PERMODEL_MECHANISMS) as Array<[Mechanism, string]>) {
    const loose = o.error.message.startsWith(message.slice(0, 30)) || (message.endsWith("is not a function") && o.error.message.endsWith("is not a function"));
    if (rule.message === "exact" ? o.error.message === message : loose) return kind;
  }
  return null;
}

/** The same caller and run with a well-formed perModel: the P1 response the malformed data prevented. */
const counterfactual = (c: P2Case): P2Case => ({ ...c, id: `${c.id}#wellFormedPerModel`, viewer: { ...c.viewer, perModelDefect: undefined } });

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
const p1 = new Map<string, P1Observation>();
const p1Counterfactual = new Map<string, P1Observation>();

beforeAll(async () => {
  for (const c of CASES) observations.set(c.id, { off: await observe(c, false), on: await observe(c, true) });
  if (!CAPTURE) for (const c of CASES) p1.set(c.id, await observeP1(c));
  if (!CAPTURE) for (const c of CASES) if (c.viewer.perModelDefect) p1Counterfactual.set(c.id, await observeP1(counterfactual(c)));
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

// ─── D-P2-X: the cross-route condition (oracle c), as qualified by owner ruling A2 ───
//
// A. no view for a caller P1 would deny (authorization or workspace integrity);
// B. where P1 returns its Decision Support output, the view is backed by exactly that output;
// C/D. a P1 200 is not required ONLY when P1 threw one of the two documented malformed-perModel TypeErrors, and then
//      the same caller and run with a well-formed perModel must be a P1 200 that satisfies A and B;
// E. no other P1 failure is excused.

const dsWithReview = (r: P1Observation | undefined) =>
  !!r && r.status === 200 && r.body!.adaptive?.status === "valid" && r.body!.adaptive.output?.schemaId === "decision_support" && r.body!.adaptive.humanReview !== null;

/** The P1 response that backs this case: P1 itself, or (A2 exception only) the well-formed-perModel counterfactual. */
function backingP1(c: P2Case, rule: AttributionRule = STRICT_RULE): { r: P1Observation; via: "p1" | "a2_exception" } | null {
  const r = p1.get(c.id)!;
  if (r.status === 200) return { r, via: "p1" };
  const kind = attributedPerModelMechanism(r, rule);
  if (kind === null || (rule.requireKindMatch && kind !== c.viewer.perModelDefect?.kind)) return null;
  const cf = p1Counterfactual.get(c.id);
  return cf && cf.status === 200 ? { r: cf, via: "a2_exception" } : null;
}
const P1_DS_WITH_REVIEW = (c: P2Case) => dsWithReview(backingP1(c)?.r);

run("D-P2-X: every P2 view is backed by the same viewer's P1 Decision Support output (oracle c, ruling A2)", () => {
  it("every P2 response carrying dsProvenance is backed by P1 under A2 (a P1 200, or for the two malformed-perModel throws only, the well-formed counterfactual's P1 200) with the same valid Decision Support output and a usable review", () => {
    const via = { p1: 0, a2_exception: 0 };
    for (const c of CASES) {
      if (!Object.prototype.hasOwnProperty.call(JSON.parse(observations.get(c.id)!.on.text || "{}"), "dsProvenance")) continue;
      const backing = backingP1(c);
      expect([c.id, backing !== null]).toEqual([c.id, true]);
      expect([c.id, dsWithReview(backing!.r)]).toEqual([c.id, true]);
      const stored = realParseOutput(runDocument(c).adaptiveOutput);
      expect(backing!.r.body!.adaptive.output).toEqual(JSON.parse(JSON.stringify(stored.output)));
      expect([c.id, backing!.r.body!.viewerRole]).toEqual([c.id, c.viewer.role]);
      via[backing!.via]++;
    }
    expect(via.p1 + via.a2_exception).toBe(PINNED_BUILT);
    // The exception is used exactly by the malformed-perModel viewers' built cases, and by nothing else.
    expect(via.a2_exception).toBe(builtCases().filter((c) => c.viewer.perModelDefect).length);
    expect(via.a2_exception).toBeGreaterThan(100);
  });

  it("admission equivalence: every authorized P2 200 passes P1 for the same caller and role (a P1 200, or under A2 the well-formed counterfactual's P1 200)", () => {
    let direct = 0;
    let exception = 0;
    for (const c of CASES) {
      const p2 = observations.get(c.id)!.on;
      if (p2.status !== 200) continue;
      const backing = backingP1(c);
      expect([c.id, backing?.r.status]).toEqual([c.id, 200]);
      expect([c.id, backing!.r.body!.viewerRole]).toEqual([c.id, JSON.parse(p2.text).viewerRole]);
      if (backing!.via === "p1") direct++;
      else exception++;
    }
    expect(direct).toBeGreaterThan(900);
    expect(exception).toBe(MALFORMED_PERMODEL_VIEWERS.length * 80);
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

run("owner ruling A2: the malformed-perModel exception and its limits", () => {
  it("R1's counterexample reproduces: P1 throws the documented TypeError while P2 returns 200 with the view", () => {
    for (const [id, kind] of [
      ["p2.owner.permodel_null_row|approved_single_no_via|ds_split", "null_row"],
      ["p2.rev.qualifying_row.permodel_null_row|personal_self_awc|ds_split", "null_row"],
      ["p2.owner.permodel_string|team_panel_awc|ds_sources", "non_array"],
      ["p2.rev.absent_row.permodel_object|approved_single_no_via|ds_split", "non_array"],
    ] as const) {
      const r = p1.get(id)!;
      expect([id, r.status, r.error?.name, r.error?.message]).toEqual([id, "threw", "TypeError", PERMODEL_MECHANISMS[kind]]);
      expect([id, attributedPerModelMechanism(r)]).toEqual([id, kind]);
      const on = observations.get(id)!.on;
      expect([id, on.status, Object.prototype.hasOwnProperty.call(JSON.parse(on.text), "dsProvenance")]).toEqual([id, 200, true]);
    }
  });

  it("every P1 failure in the malformed-perModel cases is one of the two mechanisms, matching the case's defect", () => {
    for (const c of CASES.filter((x) => x.viewer.perModelDefect && x.viewer.role !== null)) {
      const r = p1.get(c.id)!;
      expect([c.id, r.status, attributedPerModelMechanism(r)]).toEqual([c.id, "threw", c.viewer.perModelDefect!.kind]);
    }
  });

  it("P1 threw only after it authorized the caller: its reads are the counterfactual 200's authorization reads, in order", () => {
    for (const c of CASES.filter((x) => x.viewer.perModelDefect && x.viewer.role !== null)) {
      const thrown = p1.get(c.id)!.io;
      const ok = p1Counterfactual.get(c.id)!;
      expect([c.id, ok.status]).toEqual([c.id, 200]);
      expect([c.id, ok.io.slice(0, thrown.length)]).toEqual([c.id, thrown]);
      expect(thrown[0]).toBe("runDoc");
      if (c.viewer.workspace) expect(thrown).toContain("workspaceResolve");
      if (c.viewer.role === "personal_reviewer") expect(thrown).toContain("assignment");
    }
  });

  it("the persisted Decision Support output is exactly what the well-formed P1 response exposes", () => {
    let checked = 0;
    for (const c of CASES.filter((x) => x.viewer.perModelDefect && x.viewer.role !== null && DS_ADAPTIVE.has(x.adaptive))) {
      const ok = p1Counterfactual.get(c.id)!;
      expect(ok.body!.adaptive.output).toEqual(JSON.parse(JSON.stringify(realParseOutput(runDocument(c).adaptiveOutput).output)));
      checked++;
    }
    expect(checked).toBe(MALFORMED_PERMODEL_VIEWERS.length * Object.keys(RECORDS).length * 2);
  });

  it("the attribution rejects every unrelated P1 failure", () => {
    const real = p1.get("p2.owner.permodel_null_row|approved_single_no_via|ds_split")!;
    const stringReal = p1.get("p2.owner.permodel_string|approved_single_no_via|ds_split")!;
    expect(attributedPerModelMechanism(real)).toBe("null_row");
    expect(attributedPerModelMechanism(stringReal)).toBe("non_array");
    const otherFrame = real.error!.stack.replace(/lib\/user\/runDocumentToPublicResults\.ts/g, "lib/runs/runReadPayload.ts");
    const rejected: Array<[string, Pick<P1Observation, "status" | "error">]> = [
      ["a 500 response", { status: 500, error: null }],
      ["a 403 denial", { status: 403, error: null }],
      ["a 404 integrity failure", { status: 404, error: null }],
      ["another TypeError message", { status: "threw", error: { ...real.error!, message: "Cannot read properties of undefined (reading 'x')" } }],
      ["the same message from another frame", { status: "threw", error: { ...real.error!, stack: otherFrame } }],
      ["a non-TypeError with the same message", { status: "threw", error: { ...real.error!, name: "Error" } }],
      ["an unrelated thrown error", { status: "threw", error: { name: "Error", message: "history read failed", stack: "Error: history read failed\n    at x (lib/firestore/runs.ts:1:1)" } }],
    ];
    for (const [name, o] of rejected) expect([name, attributedPerModelMechanism(o)]).toEqual([name, null]);
    // A real unrelated P1 500 (workspace lookup failure) is a response, not an excused throw, and P2 builds nothing.
    const lookup = CASES.find((c) => c.id === "p2ws.owner.lookup_failed|approved_single_no_via|ds_split")!;
    expect(p1.get(lookup.id)!.status).toBe(500);
    expect(attributedPerModelMechanism(p1.get(lookup.id)!)).toBeNull();
    expect(observations.get(lookup.id)!.on.text).not.toContain("dsProvenance");
  });

  it("a mismatched mechanism is not excused: the case's own defect must be the one P1 threw (R2 NIT-2)", () => {
    // Each real case relabelled with the OTHER mechanism: P1 really threw its own TypeError, so the A2 backing must vanish.
    const pairs: Array<[string, Mechanism]> = [
      ["p2.owner.permodel_string|approved_single_no_via|ds_split", "null_row"],
      ["p2.owner.permodel_null_row|approved_single_no_via|ds_split", "non_array"],
    ];
    for (const [id, otherKind] of pairs) {
      const c = CASES.find((x) => x.id === id)!;
      const forged: P2Case = { ...c, viewer: { ...c.viewer, perModelDefect: { kind: otherKind, value: c.viewer.perModelDefect!.value } } };
      // Positive control: the true label is backed through the exception.
      expect([id, backingP1(c)?.via]).toEqual([id, "a2_exception"]);
      // The assertion under test: the mislabelled case is not backed at all.
      expect([id, backingP1(forged)]).toEqual([id, null]);
      // Falsification: with the kind check removed the same forged case WOULD be backed, so the assertion above fails.
      expect([id, backingP1(forged, WEAKENED_RULES.no_kind_match)?.via]).toEqual([id, "a2_exception"]);
    }
  });

  it("the throwing-frame and message rules: accepted only for the documented message from the first frame in runDocumentToPublicResults (R2 NIT-3)", () => {
    const at = (fn: string, file: string, line = 18) => `    at ${fn} (/any/checkout/${file}:${line}:24)`;
    const stack = (message: string, ...frames: string[]) => [`TypeError: ${message}`, ...frames].join("\n");
    const NULL_MSG = PERMODEL_MECHANISMS.null_row;
    const MAP_MSG = PERMODEL_MECHANISMS.non_array;
    const threw = (name: string, message: string, s: string): Pick<P1Observation, "status" | "error"> => ({ status: "threw", error: { name, message, stack: s } });
    // Literal expected outcomes under the strict rule (never computed from the predicate under test).
    const table: Array<[string, Pick<P1Observation, "status" | "error">, Mechanism | null]> = [
      ["null row, thrown in the map callback inside the target", threw("TypeError", NULL_MSG, stack(NULL_MSG, at("<anonymous>", "lib/user/runDocumentToPublicResults.ts", 19), "    at Array.map (<anonymous>)", at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResults.ts"))), "null_row"],
      ["non-array, thrown by the target itself", threw("TypeError", MAP_MSG, stack(MAP_MSG, at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResults.ts"), at("buildRunReadPayload", "lib/runs/runReadPayload.ts", 103))), "non_array"],
      ["same path with Windows separators", threw("TypeError", MAP_MSG, stack(MAP_MSG, "    at runDocumentToPublicResults (C:\\checkout\\lib\\user\\runDocumentToPublicResults.ts:18:24)")), "non_array"],
      ["same null-row message, first frame elsewhere, target only second", threw("TypeError", NULL_MSG, stack(NULL_MSG, at("normalizePersistedModelResult", "lib/panel/normalize.ts", 5), at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResults.ts"))), null],
      ["same map message from another function entirely", threw("TypeError", MAP_MSG, stack(MAP_MSG, at("publicizePanelResults", "lib/panel/publicize.ts", 9), at("buildRunReadPayload", "lib/runs/runReadPayload.ts", 105))), null],
      ["unrelated null read inside the target", threw("TypeError", "Cannot read properties of null (reading 'tokenUsage')", stack("Cannot read properties of null (reading 'tokenUsage')", at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResults.ts", 20))), null],
      ["unrelated 'not a function' inside the target", threw("TypeError", "p.rawTextTruncated.trim is not a function", stack("p.rawTextTruncated.trim is not a function", at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResults.ts", 19))), null],
      ["documented message, not a TypeError", threw("Error", NULL_MSG, stack(NULL_MSG, at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResults.ts"))), null],
      ["target file named only in the message, no frame", threw("TypeError", MAP_MSG, `TypeError: ${MAP_MSG} (lib/user/runDocumentToPublicResults.ts)`), null],
      ["a similarly named file", threw("TypeError", MAP_MSG, stack(MAP_MSG, at("runDocumentToPublicResults", "lib/user/runDocumentToPublicResultsLegacy.ts"))), null],
    ];
    for (const [name, o, expected] of table) expect([name, attributedPerModelMechanism(o)]).toEqual([name, expected]);
    // Falsification: every weakened rule disagrees with the literal table on at least one row, so the loop above fails.
    for (const [ruleName, rule] of Object.entries(WEAKENED_RULES).filter(([n]) => n !== "no_kind_match")) {
      const disagreements = table.filter(([, o, expected]) => attributedPerModelMechanism(o, rule) !== expected).map(([n]) => n);
      expect([ruleName, disagreements.length > 0]).toEqual([ruleName, true]);
    }
    // ...and each one specifically: "any frame" admits the second-frame row; "loose" admits the unrelated messages;
    // "any error type" admits the plain Error.
    expect(attributedPerModelMechanism(table[3][1], WEAKENED_RULES.any_frame)).toBe("null_row");
    expect(attributedPerModelMechanism(table[5][1], WEAKENED_RULES.loose_message)).toBe("null_row");
    expect(attributedPerModelMechanism(table[6][1], WEAKENED_RULES.loose_message)).toBe("non_array");
    expect(attributedPerModelMechanism(table[7][1], WEAKENED_RULES.any_error_type)).toBe("null_row");
    // The real thrown stacks (whatever this machine's paths look like) are accepted by the strict rule.
    expect(attributedPerModelMechanism(p1.get("p2.owner.permodel_null_row|approved_single_no_via|ds_split")!)).toBe("null_row");
    expect(attributedPerModelMechanism(p1.get("p2.owner.permodel_string|approved_single_no_via|ds_split")!)).toBe("non_array");
  });

  it("authorization and workspace-integrity failures still suppress the view on malformed-perModel runs", () => {
    const denials = CASES.filter((c) => c.viewer.perModelDefect && c.viewer.role === null);
    expect(denials.length).toBe(4 * Object.keys(RECORDS).length * 2);
    for (const c of denials) {
      const on = observations.get(c.id)!.on;
      expect([c.id, on.status === 200, on.text.includes("dsProvenance")]).toEqual([c.id, false, false]);
      expect(sha(on.text)).toBe(BASELINE.cases[c.id].bodySha256);
      // P1 denies these callers before it ever reaches the per-model rows, so the A2 exception is unreachable for them.
      expect([c.id, typeof p1.get(c.id)!.status]).toEqual([c.id, "number"]);
      expect([c.id, p1.get(c.id)!.status === 200]).toEqual([c.id, false]);
    }
  });

  it("P2 never reads perModel: a malformed perModel leaves every P2 response byte-identical to the well-formed run", () => {
    for (const c of CASES.filter((x) => x.viewer.perModelDefect && x.viewer.role !== null)) {
      const twinKey = c.viewer.key.replace(/\.permodel_(null_row|string|object)$/, "");
      const twin = observations.get(`${twinKey}|${c.record}|${c.adaptive}`);
      expect([c.id, twin !== undefined]).toEqual([c.id, true]);
      expect([c.id, observations.get(c.id)!.on.text]).toEqual([c.id, twin!.on.text]);
      expect([c.id, observations.get(c.id)!.on.io]).toEqual([c.id, twin!.on.io]);
    }
  });
});

// ─── Denial and record-state preservation ─────────────────────────────────

run("PR #259 and record states (AC-2, AC-6, AC-7)", () => {
  it("every unauthorized 403 is one byte-identical response, whatever the record holds", () => {
    const forbidden = DENIAL_VIEWERS.filter((v) => CASES.some((c) => c.viewer === v && observations.get(c.id)!.on.status === 403));
    expect(forbidden.map((v) => v.key).sort()).toEqual(["p2.rev.assignment_read_failed", "p2.rev.team_assignment", "p2.rev.unassigned", "p2.rev.unassigned.permodel_string", "p2.stranger", "p2.stranger.panel_present", "p2.stranger.permodel_null_row", "p2ws.stranger"]);
    for (const v of forbidden) {
      const obs = CASES.filter((c) => c.viewer === v).map((c) => observations.get(c.id)!.on);
      expect(obs.length).toBe(Object.keys(RECORDS).length * 2);
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

run("builder inputs: the route hands over exactly what D-P2 allows", () => {
  it("the raw stored record and the stored output's parse, the route's own context, and no results", async () => {
    const targets = builtCases().filter((_, k) => k % 5 === 0);
    expect(targets.length).toBeGreaterThan(50);
    for (const c of targets) {
      await observe(c, true);
      expect([c.id, mockBuilderCalls.length]).toEqual([c.id, 1]);
      const input = mockBuilderCalls[0] as Record<string, any>;
      const stored = mockRunDocs.get(RUN_ID)!;
      expect(Object.keys(input).sort()).toEqual(["governanceRecord", "publicAdaptiveOutput", "publicResults", "surfaceRequest"]);
      // The very object read from the run document. This does NOT kill mutant M15 (route passes its parsed record):
      // parseGovernanceRecord returns that same object (governanceRecordParser.ts:177), so M15 is an equivalent
      // mutant and survives (32/33 author mutants killed). What this test does pin is the input set, `publicResults:
      // null`, the stored output's parse and the route's own context, including mayReadDecisionReviewer vs oracle (a).
      expect([c.id, input.governanceRecord === stored.governanceRecord]).toEqual([c.id, true]);
      expect(input.publicAdaptiveOutput).toEqual(realParseOutput(stored.adaptiveOutput).output);
      expect(input.publicResults).toBeNull();
      expect(input.surfaceRequest).toEqual({ surfaceId: "P2", role: c.viewer.role, mayReadDecisionReviewer: identityAllowed(c) });
    }
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

const PINNED_BUILT = 532;
const PINNED_NOT_BUILT_200 = 988;

it("the case matrix includes every DS output, every record state and every viewer class", () => {
  expect(new Set(CASES.map((c) => c.adaptive))).toEqual(new Set(Object.keys(ADAPTIVE)));
  expect(new Set(CASES.map((c) => c.record))).toEqual(new Set(Object.keys(RECORDS)));
  expect(CASES.some((c) => DS_ADAPTIVE.has(c.adaptive) && c.viewer.workspace && oracleA(c).built)).toBe(true);
});
