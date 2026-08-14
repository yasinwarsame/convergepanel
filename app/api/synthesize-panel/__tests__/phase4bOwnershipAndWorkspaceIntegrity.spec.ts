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
 * quickly under fake concurrency).
 *
 * An earlier version of this file covered that branch with a source-level
 * regex assertion instead (matching this directory's own
 * clientAdaptiveGuardRegression.spec.ts convention). A later independent
 * security review proved by mutation testing that this specific guard was
 * worthless: four different broken mutants of the branch (check disabled,
 * check comparing a value to itself, check commented out, unconditional
 * early disclosure) all still passed every assertion, because the
 * assertions only matched byte offsets of string literals in the raw
 * source text and never executed the code. The fix was to extract the
 * branch's entire decision into an exported, directly callable function —
 * `resolveInFlightDisclosureGate(runId, uid)` (in
 * lib/synthesis/inFlightDisclosureGate.ts, imported directly by the route
 * handler — Next.js's App Router route-export typing forbids exporting it
 * from route.ts itself) — and test that function's real return values
 * below instead of the surrounding source text.
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

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/synthesize-panel/route";
import { resolveInFlightDisclosureGate } from "@/lib/synthesis/inFlightDisclosureGate";

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

describe("resolveInFlightDisclosureGate — direct executable coverage of the in-flight branch (Phase 4B security re-review)", () => {
  // A second independent review found the original source-text-regex
  // coverage of this branch worthless: it verified by mutation testing
  // that all its assertions still passed against four different broken
  // mutants (check disabled, check comparing a value to itself, check
  // commented out, unconditional early disclosure). The fix extracted the
  // branch's entire decision into `resolveInFlightDisclosureGate()`
  // (lib/synthesis/inFlightDisclosureGate.ts) specifically so it can be
  // called directly here and asserted against real return values — not
  // string-matched.
  const OWNER_UID = "owner-uid";
  const RUN_ID = "run-in-flight";

  function seedRun(overrides: Record<string, unknown> = {}) {
    runDocs.set(RUN_ID, { userId: OWNER_UID, synthesizedStructuredReport: MINIMAL_VALID_SYNTHESIS, schemaVersion: 1, ...overrides });
  }

  it("Firestore read throws -> denied, 503, fails closed rather than falling through to disclose anything", async () => {
    seedRun();
    const originalCollection = mockAdminDb.collection;
    (mockAdminDb as any).collection = (name: string) =>
      name === "runs"
        ? { doc: () => ({ get: async () => { throw new Error("simulated read failure"); } }) }
        : originalCollection(name);
    try {
      const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
      expect(result.outcome).toBe("denied");
      if (result.outcome === "denied") {
        expect(result.status).toBe(503);
        expect(result.reason).toBe("run_lookup_threw");
      }
    } finally {
      (mockAdminDb as any).collection = originalCollection;
    }
  });

  it("run document does not (yet) exist -> denied, 503, fails closed rather than falling through unchecked", async () => {
    // Deliberately NOT seeding runDocs for RUN_ID.
    const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.status).toBe(503);
      expect(result.reason).toBe("run_not_found");
    }
  });

  it("SECURITY: unrelated authenticated user (different uid than run.userId) -> denied, 403, never cache_hit or verified_no_cache", async () => {
    seedRun();
    const result = await resolveInFlightDisclosureGate(RUN_ID, "attacker-uid");
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.status).toBe(403);
      expect(result.reason).toBe("owner_mismatch");
    }
  });

  it("Workspace integrity check throws -> denied, 503, fails closed", async () => {
    seedRun({ workspaceId: `personal-${OWNER_UID}` });
    mockedGetWorkspace.mockImplementationOnce(async () => { throw new Error("simulated workspace lookup failure"); });
    const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") expect(result.reason).toBe("workspace_integrity_check_threw");
  });

  it("SECURITY: Workspace-bound-invalid run -> denied, 403, even for the true owner", async () => {
    seedRun({ workspaceId: `personal-${OWNER_UID}` });
    // No workspace seeded -> not_found -> invalid.
    const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.status).toBe(403);
      expect(result.reason).toContain("workspace_run_integrity_failed");
    }
  });

  it("true owner, cached report already present -> cache_hit, with the real report body", async () => {
    seedRun();
    const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
    expect(result.outcome).toBe("cache_hit");
    if (result.outcome === "cache_hit") expect(result.body.report).toEqual(MINIMAL_VALID_SYNTHESIS);
  });

  it("true owner, no cached report yet -> verified_no_cache (safe to await the in-flight promise)", async () => {
    seedRun({ synthesizedStructuredReport: undefined, schemaVersion: undefined });
    const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
    expect(result.outcome).toBe("verified_no_cache");
  });

  it("legacy run (workspaceId absent) with true owner -> verified_no_cache, no Workspace lookup attempted", async () => {
    seedRun();
    mockedGetWorkspace.mockClear();
    const result = await resolveInFlightDisclosureGate(RUN_ID, OWNER_UID);
    expect(result.outcome).toBe("cache_hit"); // seedRun() includes a cached report by default
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });
});
