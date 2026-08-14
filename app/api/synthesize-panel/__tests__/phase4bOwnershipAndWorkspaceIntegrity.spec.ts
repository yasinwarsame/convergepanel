/**
 * Phase 4B security completion — synthesize-panel.
 *
 * A security review of PR #45 found the in-flight-cache branch of POST
 * /api/synthesize-panel (the "another request for this runId is already
 * being processed" fast-path) returned cached synthesis content with NO
 * ownership check at all — the only branch in this file that had none,
 * not even the pre-existing lenient one every other branch has. An
 * authenticated-but-unrelated user could receive another owner's cached
 * report merely by requesting the same runId while a request for it
 * happened to already be in flight. The fix adds an ownership check
 * (mirroring the existing lenient pattern used elsewhere in this file —
 * not a new, stricter rule) plus Phase 4B Workspace integrity to that
 * branch, and to the GET cached-report path and the main POST path.
 *
 * Runtime coverage below: the GET path (fast, deterministic, no LLM
 * involved) and the POST main/first-request path (denies before any LLM
 * call, so no concurrency needed). The in-flight branch itself is the one
 * path that requires genuinely racing two concurrent POST requests through
 * this route's full LLM/timeout/AbortController machinery to exercise at
 * runtime — attempting that proved too fragile/slow to be a reliable CI
 * test (the route's real timeout/abort-signal plumbing does not resolve
 * quickly under fake concurrency). That branch is instead covered by a
 * source-level regression assertion below, the same technique this exact
 * directory already uses in clientAdaptiveGuardRegression.spec.ts for a
 * comparable hard-to-execute-at-runtime scenario: it fails if a future
 * edit removes the ownership/integrity check from that specific branch.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-key",
  WORKSPACES_ENABLED: true,
}));

let currentAuthUid: string | null = "owner-uid";
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: jest.fn(async () =>
    currentAuthUid ? { status: "authenticated", uid: currentAuthUid } : { status: "unauthenticated", reason: "missing_credentials" }
  ),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() }),
}));

const runDocs = new Map<string, Record<string, unknown>>();
const workspaceDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (name === "runs") {
          const data = runDocs.get(id);
          return { exists: !!data, data: () => data };
        }
        if (name === "users") {
          return { exists: true, data: () => ({ email: "user@example.com" }) };
        }
        return { exists: false, data: () => undefined };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        runDocs.set(id, { ...(runDocs.get(id) || {}), ...fields });
      }),
      set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        const existing = opts?.merge ? runDocs.get(id) || {} : {};
        runDocs.set(id, { ...existing, ...fields });
      }),
      collection: () => ({ add: jest.fn().mockResolvedValue({ id: "event-id" }) }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

// Phase 4B's own Workspace lookup — mocked directly rather than routed
// through mockAdminDb, exactly as the primitive's own unit tests do.
const mockedGetWorkspace = jest.fn(async (id: string) => {
  if (!workspaceDocs.has(id)) return { status: "not_found" };
  return { status: "found", workspace: workspaceDocs.get(id) };
});
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));

jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: jest.fn().mockResolvedValue({ governanceStatus: "approved" }),
}));

jest.mock("openai", () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock("@anthropic-ai/sdk", () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/synthesize-panel/route";

const MINIMAL_VALID_SYNTHESIS = {
  executiveSummary: "Synthesis of the panel's responses.",
  keyFindings: [{ claim: "x", confidence: "Medium", evidenceRefs: [], modelsSupporting: ["chatgpt"] }],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison.",
};

function buildPostRequest(runId: string) {
  return new NextRequest("http://localhost/api/synthesize-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId,
      question: "Which CRM should we choose?",
      results: [
        { modelId: "chatgpt", text: "chatgpt: HubSpot is the stronger choice for a small team on cost grounds." },
        { modelId: "claude", text: "claude: HubSpot is the stronger choice for a small team on cost grounds." },
      ],
    }),
  });
}

function buildGetRequest(runId: string) {
  return new NextRequest(`http://localhost/api/synthesize-panel?runId=${runId}`);
}

function validWorkspace(ownerUid: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `personal-${ownerUid}`,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: ownerUid,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  runDocs.clear();
  workspaceDocs.clear();
  currentAuthUid = "owner-uid";
  jest.clearAllMocks();
});

describe("GET /api/synthesize-panel — cached-report disclosure", () => {
  it("owner reading their own cached report -> 200, allowed", async () => {
    runDocs.set("run-1", { userId: "owner-uid", synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS, schemaVersion: 1 });
    currentAuthUid = "owner-uid";
    const res = await GET(buildGetRequest("run-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.report).toEqual(MINIMAL_VALID_SYNTHESIS);
  });

  it("unrelated authenticated user reading another owner's cached report -> 403, denied", async () => {
    runDocs.set("run-1", { userId: "owner-uid", synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS, schemaVersion: 1 });
    currentAuthUid = "other-uid";
    const res = await GET(buildGetRequest("run-1"));
    expect(res.status).toBe(403);
  });

  it("unauthenticated caller -> 401, denied", async () => {
    runDocs.set("run-1", { userId: "owner-uid", synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS, schemaVersion: 1 });
    currentAuthUid = null;
    const res = await GET(buildGetRequest("run-1"));
    expect(res.status).toBe(401);
  });

  it("owner reading a Workspace-BOUND but INVALID run -> denied, even though they are the true owner", async () => {
    runDocs.set("run-1", {
      userId: "owner-uid",
      workspaceId: "personal-owner-uid",
      synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS,
      schemaVersion: 1,
    });
    // No matching workspace seeded -> workspace_not_found
    currentAuthUid = "owner-uid";
    const res = await GET(buildGetRequest("run-1"));
    expect(res.status).toBe(403);
  });

  it("owner reading a Workspace-BOUND VALID run -> 200, allowed, identical to legacy", async () => {
    workspaceDocs.set("personal-owner-uid", validWorkspace("owner-uid"));
    runDocs.set("run-1", {
      userId: "owner-uid",
      workspaceId: "personal-owner-uid",
      synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS,
      schemaVersion: 1,
    });
    currentAuthUid = "owner-uid";
    const res = await GET(buildGetRequest("run-1"));
    expect(res.status).toBe(200);
  });

  it("legacy run (workspaceId truly absent) never calls getWorkspace", async () => {
    runDocs.set("run-1", { userId: "owner-uid", synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS, schemaVersion: 1 });
    currentAuthUid = "owner-uid";
    await GET(buildGetRequest("run-1"));
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });
});

describe("POST /api/synthesize-panel — main ownership path (first request for a runId)", () => {
  it("unrelated authenticated user cannot generate synthesis for a run they don't own", async () => {
    runDocs.set("run-2", { userId: "owner-uid" });
    currentAuthUid = "other-uid";
    const res = await POST(buildPostRequest("run-2"));
    expect(res.status).toBe(403);
  });

  it("Workspace-bound-invalid run denies even the true owner, before any LLM call", async () => {
    runDocs.set("run-3", { userId: "owner-uid", workspaceId: "personal-owner-uid" });
    currentAuthUid = "owner-uid";
    const res = await POST(buildPostRequest("run-3"));
    expect(res.status).toBe(403);
  });

  it("legacy run (workspaceId absent) never calls getWorkspace on the main path", async () => {
    runDocs.set("run-4", { userId: "owner-uid" });
    currentAuthUid = "owner-uid";
    await POST(buildPostRequest("run-4"));
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("unauthenticated caller is denied before any Firestore read", async () => {
    currentAuthUid = null;
    const res = await POST(buildPostRequest("run-5"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/synthesize-panel — in-flight-cache branch (source-level regression guard)", () => {
  // See the file-level doc comment for why this is source-level rather
  // than a live concurrency test — same technique already used in this
  // exact directory's clientAdaptiveGuardRegression.spec.ts.
  const ROUTE_SOURCE = readFileSync(join(__dirname, "..", "route.ts"), "utf-8");

  it("the in-flight branch's cache-hit block is preceded by an ownership check before the runDoc data is ever returned", () => {
    const inFlightBlockStart = ROUTE_SOURCE.indexOf("Request already in progress for runId");
    expect(inFlightBlockStart).toBeGreaterThan(-1);
    const cacheHitReturn = ROUTE_SOURCE.indexOf("Cache hit (while waiting for in-flight)", inFlightBlockStart);
    expect(cacheHitReturn).toBeGreaterThan(inFlightBlockStart);

    const blockBetween = ROUTE_SOURCE.slice(inFlightBlockStart, cacheHitReturn);
    expect(blockBetween).toMatch(/cachedRunUserId\s*!==\s*undefined\s*&&\s*cachedRunUserId\s*!==\s*uid/);
    expect(blockBetween).toMatch(/ERROR_CODES\.FORBIDDEN/);
  });

  it("the in-flight branch also calls validateRunWorkspaceAssociation before the cache-hit disclosure", () => {
    const inFlightBlockStart = ROUTE_SOURCE.indexOf("Request already in progress for runId");
    const cacheHitReturn = ROUTE_SOURCE.indexOf("Cache hit (while waiting for in-flight)", inFlightBlockStart);
    const blockBetween = ROUTE_SOURCE.slice(inFlightBlockStart, cacheHitReturn);
    expect(blockBetween).toMatch(/validateRunWorkspaceAssociation\(data\)/);
    expect(blockBetween).toMatch(/inFlightIntegrity\.classification\s*===\s*"invalid"/);
  });

  it("both new checks appear BEFORE the `report:` field is ever placed in a response within this block", () => {
    const inFlightBlockStart = ROUTE_SOURCE.indexOf("Request already in progress for runId");
    const cacheHitReturn = ROUTE_SOURCE.indexOf("Cache hit (while waiting for in-flight)", inFlightBlockStart);
    const ownershipCheckIdx = ROUTE_SOURCE.indexOf("cachedRunUserId !== undefined", inFlightBlockStart);
    const integrityCheckIdx = ROUTE_SOURCE.indexOf("validateRunWorkspaceAssociation(data)", inFlightBlockStart);
    const reportFieldIdx = ROUTE_SOURCE.indexOf("report: data.synthesizedStructuredReport", inFlightBlockStart);

    expect(ownershipCheckIdx).toBeGreaterThan(inFlightBlockStart);
    expect(integrityCheckIdx).toBeGreaterThan(ownershipCheckIdx);
    expect(reportFieldIdx).toBeGreaterThan(cacheHitReturn); // the disclosure itself, after the cache-hit log line
    expect(integrityCheckIdx).toBeLessThan(reportFieldIdx);
  });
});
