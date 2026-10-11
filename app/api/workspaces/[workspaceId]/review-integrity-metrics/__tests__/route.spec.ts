/**
 * Order 3 — GET /api/workspaces/{workspaceId}/review-integrity-metrics.
 *
 * The REAL loader and Firestore adapter run against a recording fake db (the
 * loader is only wrapped in a pass-through spy), so "no Firestore work" is
 * asserted at the db boundary itself: every `adminDb.collection()` call is
 * recorded. audit.read is the ONLY capability gate (real ROLE_CAPABILITIES
 * matrix); the flag defaults off, is concealed, and while off nothing touches
 * Firestore. The body is the aggregate-only allow-list.
 */
let flag = true;
jest.mock("@/lib/env", () => ({
  get WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED() {
    return flag;
  },
}));
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAuditAccess", () => ({ resolveWorkspaceAuditAccess: (...a: unknown[]) => mockedAccess(...a) }));

/** Recording fake: `projects` supports the preflight count + bounded listing; `runs` supports where + count only. */
const dbCollectionCalls: string[] = [];
let runCountFor: (wheres: Array<[string, string, unknown]>) => number = () => 0;
const runsQuery = (wheres: Array<[string, string, unknown]>): Record<string, unknown> => ({
  where: (f: string, op: string, v: unknown) => runsQuery([...wheres, [f, op, v]]),
  count: () => ({ get: async () => ({ data: () => ({ count: runCountFor(wheres) }) }) }),
});
const fakeDb = {
  collection: (name: string) => {
    dbCollectionCalls.push(name);
    if (name === "projects") return { where: () => ({ count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }), limit: () => ({ get: async () => ({ docs: [] }) }) }) };
    if (name === "runs") return runsQuery([]);
    throw new Error(`unexpected collection ${name}`);
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return fakeDb;
  },
}));
jest.mock("server-only", () => ({}));
const loadSpy = jest.fn();
jest.mock("@/lib/governance/reviewIntegrityMetricsFirestore", () => {
  const actual = jest.requireActual("@/lib/governance/reviewIntegrityMetricsFirestore");
  return { loadReviewIntegrityMetrics: (...a: unknown[]) => loadSpy(...a) ?? actual.loadReviewIntegrityMetrics(...a), __actual: actual };
});
const mockedLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/review-integrity-metrics/route";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const W = "ws-1";
const call = () => GET(new NextRequest(`http://localhost/api/workspaces/${W}/review-integrity-metrics`), { params: { workspaceId: W } });
const grant = (capabilities: readonly string[]) => ({ granted: true, capabilities });
const roles = Object.keys(ROLE_CAPABILITIES) as Array<keyof typeof ROLE_CAPABILITIES>;

beforeEach(() => {
  jest.clearAllMocks();
  flag = true;
  dbCollectionCalls.length = 0;
  runCountFor = () => 0;
  loadSpy.mockImplementation(() => undefined); // pass through to the real loader
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid: "u1" });
  mockedAccess.mockResolvedValue(grant(ROLE_CAPABILITIES.owner));
});

describe("gate order", () => {
  it("unauthenticated → 401, no access lookup, no Firestore operation", async () => {
    mockedIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await call()).status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(dbCollectionCalls).toEqual([]);
  });

  it.each([
    ["membership_not_found (foreign Workspace)", 404],
    ["membership_removed", 404],
    ["wrong_workspace_type", 404],
    ["workspace_not_found", 404],
    ["lookup_failed", 503],
  ])("no admission: %s → %i, no Firestore operation", async (reason, status) => {
    mockedAccess.mockResolvedValue({ granted: false, reason: reason.split(" ")[0] });
    expect((await call()).status).toBe(status);
    expect(dbCollectionCalls).toEqual([]);
  });

  it.each(roles)("MUTATION F — role %s: allowed exactly when the real matrix grants audit.read", async (role) => {
    mockedAccess.mockResolvedValue(grant(ROLE_CAPABILITIES[role]));
    const res = await call();
    const allowed = ROLE_CAPABILITIES[role].includes("audit.read");
    expect(res.status).toBe(allowed ? 200 : 403);
    expect(dbCollectionCalls.length > 0).toBe(allowed);
  });

  it("the matrix grants audit.read to owner and admin only, while reviews.read reaches member, reviewer and viewer too (pinned)", () => {
    expect(roles.filter((r) => ROLE_CAPABILITIES[r].includes("audit.read")).sort()).toEqual(["admin", "owner"]);
    expect(roles.filter((r) => ROLE_CAPABILITIES[r].includes("reviews.read")).sort()).toEqual(["admin", "member", "owner", "reviewer", "viewer"]);
  });

  it("audit.read is the ONLY capability gate: reviews.read (and everything else) without it → 403; audit.read alone → 200", async () => {
    mockedAccess.mockResolvedValue(grant(["reviews.read"]));
    expect((await call()).status).toBe(403);
    const everythingElse = Array.from(new Set(Object.values(ROLE_CAPABILITIES).flat())).filter((c) => c !== "audit.read");
    mockedAccess.mockResolvedValue(grant(everythingElse));
    expect((await call()).status).toBe(403);
    expect(dbCollectionCalls).toEqual([]);
    mockedAccess.mockResolvedValue(grant(["audit.read"]));
    expect((await call()).status).toBe(200);
  });
});

describe("dark deploy: flag off", () => {
  it("flag off → concealed 404 AFTER authorization and ZERO Firestore operations (no Project listing, no count, no read)", async () => {
    flag = false;
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." });
    expect(dbCollectionCalls).toEqual([]);
    expect(loadSpy).not.toHaveBeenCalled();
    // Concealment only after authorization: an unauthorized caller still gets 403, not a feature-state signal.
    mockedAccess.mockResolvedValue(grant(["reviews.read"]));
    expect((await call()).status).toBe(403);
  });

  it("positive control: flag on → the same request reaches Firestore (projects preflight, listing, then runs counts)", async () => {
    expect((await call()).status).toBe(200);
    expect(dbCollectionCalls[0]).toBe("projects");
    expect(dbCollectionCalls.filter((c) => c === "runs")).toHaveLength(21);
  });
});

describe("responses", () => {
  const ALLOWED_KEYS = [
    "ok",
    "metrics",
    "version",
    "workspaceId",
    "generatedAt",
    "scope",
    "family",
    "sourceSystem",
    "completion",
    "timeRange",
    "projectContainment",
    "teamWorkspaceOnly",
    "totals",
    "completedAdaptiveResearch",
    "terminalHumanDecisions",
    "nonTerminalRecognized",
    "otherOrMissingReviewState",
    "projectIntegrityAnomalies",
    "reviewStates",
    "status",
    "count",
    "decisionPaths",
    "path",
    "multiReviewer",
    "explicitDecisionCount",
    "panelFinalizationCount",
    "ownerOverrideCount",
  ].sort();
  const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
    return out;
  };

  it("MUTATION G: 200 body uses exactly the aggregate allow-list — no identity, run, question or Project field at any depth", async () => {
    // Two completed adaptive runs in the Workspace (projectId null), both approved with no recorded path.
    runCountFor = (wheres) => {
      const project = wheres.find(([f]) => f === "projectId");
      const state = wheres.find(([f]) => f === "governanceRecord.humanReview.status");
      const path = wheres.some(([f]) => f === "governanceRecord.humanReview.decidedVia");
      if (project && project[2] !== null) return 0;
      if (!state && !path) return 2;
      return state && state[1] === "==" && state[2] === "approved" && !path ? 2 : 0;
    };
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.totals.completedAdaptiveResearch).toBe(2);
    expect(body.metrics.totals.terminalHumanDecisions).toBe(2);
    expect([...keysOf(body)].sort()).toEqual(ALLOWED_KEYS);
    for (const banned of ["uid", "userId", "reviewerId", "reviewerUserId", "reviewerName", "name", "email", "runId", "question", "projectId", "projectName", "comment", "conditions", "overrideJustification", "reviewedAt"]) {
      expect(keysOf(body).has(banned)).toBe(false);
    }
  });

  it("an internal metrics object carrying extra fields is serialized through the allow-list only", async () => {
    const real = await (jest.requireMock("@/lib/governance/reviewIntegrityMetricsFirestore") as { __actual: { loadReviewIntegrityMetrics: (...a: unknown[]) => Promise<{ ok: true; metrics: Record<string, unknown> }> } }).__actual.loadReviewIntegrityMetrics(fakeDb, W);
    loadSpy.mockImplementation(async () => ({ ok: true, metrics: { ...real.metrics, reviewerId: "leak", debugSpecs: [{ runId: "r1" }], totals: { ...(real.metrics.totals as object), question: "leak" } } }));
    const body = await (await call()).json();
    expect([...keysOf(body)].sort()).toEqual(ALLOWED_KEYS);
    expect(JSON.stringify(body)).not.toContain("leak");
  });

  it("too many Projects → 409 with the ceiling", async () => {
    loadSpy.mockImplementation(async () => ({ ok: false, reason: "workspace_too_large", projectCeiling: 30 }));
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, errorCode: "metrics_workspace_too_large", projectCeiling: 30 });
  });

  it("irreconcilable after retry → 503 metrics_unavailable, no numbers", async () => {
    loadSpy.mockImplementation(async () => ({ ok: false, reason: "inconsistent" }));
    const res = await call();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, errorCode: "metrics_unavailable", message: "Review integrity metrics are temporarily unavailable. Please try again." });
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining("could not be reconciled"), { workspaceId: W });
  });

  it("a count query failure → internal error, logged without leaking it to the client", async () => {
    runCountFor = () => {
      throw new Error("9 FAILED_PRECONDITION: The query requires an index.");
    };
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("FAILED_PRECONDITION");
    expect(mockedLogger.error).toHaveBeenCalled();
  });
});
