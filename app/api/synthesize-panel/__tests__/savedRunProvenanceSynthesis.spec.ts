/**
 * Saved-run provenance honesty (S1) — synthesis route. Harness (mocks + fake
 * Firestore) reused from adaptiveAutoSynthesis.spec.ts.
 */
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-key",
}));

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: jest.fn().mockResolvedValue({ uid: "test-uid" }),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: jest.fn(),
}));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() }),
}));

// Minimal, real-shaped fake Firestore: `runs/{runId}` starts absent (cache
// miss) unless pre-seeded via runDocs.set(...) before a test; `.update()`/
// `.set()` resolve and mutate the same in-memory store, so writes are
// directly inspectable afterward; `users/{uid}` returns a fake profile.
// `readFailureRunIds` lets a single test force the run-document `.get()`
// to reject for one specific runId, without a module reset.
const runDocs = new Map<string, Record<string, unknown>>();
const readFailureRunIds = new Set<string>();
// Tracks how many times `.get()` was called for `runs/{runId}` — lets a
// test assert the route makes exactly one lookup attempt per request
// (no internal retry loop) rather than inferring it indirectly.
const runsGetCallCounts = new Map<string, number>();
const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (name === "runs") {
          runsGetCallCounts.set(id, (runsGetCallCounts.get(id) || 0) + 1);
        }
        if (name === "runs" && readFailureRunIds.has(id)) {
          throw new Error("Firestore unavailable");
        }
        if (name === "users") {
          return { exists: true, data: () => ({ email: "user@example.com" }) };
        }
        const data = runDocs.get(id);
        return { exists: !!data, data: () => data };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        runDocs.set(id, { ...(runDocs.get(id) || {}), ...fields });
      }),
      set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        const existing = opts?.merge ? runDocs.get(id) || {} : {};
        runDocs.set(id, { ...existing, ...fields });
      }),
      collection: () => ({
        add: jest.fn().mockResolvedValue({ id: "event-id" }),
      }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
}));

const mockedEvaluateAndStoreGovernance = jest.fn().mockResolvedValue({ governanceStatus: "approved" });
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockedEvaluateAndStoreGovernance(...args),
}));

const MINIMAL_VALID_SYNTHESIS = {
  executiveSummary: "Synthesis of the panel's decision-support responses.",
  keyFindings: [
    {
      claim: "The panel favors HubSpot on cost.",
      confidence: "Medium",
      evidenceRefs: [],
      modelsSupporting: ["chatgpt", "claude"],
    },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison of structured decision_support outputs.",
};

/** Echo: the "LLM" copies the prompt's SUBSTITUTIONS block into its report, so
 *  anything the prompt carried reaches the cached synthesis — a cache assertion
 *  therefore cannot pass vacuously. */
const prompts: string[] = [];
const blockOf = (prompt: string) => (prompt.match(/SUBSTITUTIONS:\n(\[[^\n]*\])/) ?? [])[1] ?? "NO-BLOCK";
const mockCreate = jest.fn().mockImplementation(async (args: unknown) => {
  const prompt = JSON.parse(JSON.stringify(args)).messages.map((m: { content: string }) => m.content).join("\n");
  prompts.push(prompt);
  return { choices: [{ message: { content: JSON.stringify({ ...MINIMAL_VALID_SYNTHESIS, executiveSummary: `ECHO ${blockOf(prompt)}` }) } }] };
});
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...args: unknown[]) => mockCreate(...args) } },
  }));
});
jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }));
});


import { NextRequest } from "next/server";
import { POST } from "@/app/api/synthesize-panel/route";
import { buildSubstitutionBlock } from "@/lib/panel/normalize";

/**
 * Saved-run provenance honesty (S1) — /api/synthesize-panel preserves absence.
 *
 * Case 6: a reloaded saved run's substituted row without provenance reaches the
 * prompt with nothing manufactured (no modelId-as-model, "unknown",
 * "deepseek-chat", "primary_failed"). Case 7: the CACHED synthesis cannot carry
 * invented substitution provenance. Case 8 (live half): a live row's complete
 * provenance produces the exact pre-S1 block. No run lookup is added.
 */
const PROSE = [
  "Based on the available data, HubSpot appears to be the stronger choice for a small team.",
  "It offers a lower total cost of ownership and simpler onboarding than Salesforce for teams under twenty seats.",
].join(" ");

const LIVE_SUB = { modelId: "claude", text: PROSE, status: "substituted", provider: "deepseek", requestedModel: "claude-sonnet-RUN", actualModel: "deepseek-chat", substitutionReason: "timeout", substitutedFrom: "anthropic:claude-sonnet-RUN" };
/** What a reloaded pre-6.2a saved run sends: status only (S1 read path). */
const SAVED_SUB = { modelId: "claude", text: PROSE, status: "substituted" };

function request(runId: string, sub: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/synthesize-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, question: "Which CRM should we choose?", results: [{ modelId: "chatgpt", text: PROSE, status: "ok" }, sub] }),
  });
}

/** The pre-S1 block for a complete live entry, pinned literally (format unchanged). */
const PRE_S1_LIVE_BLOCK = '[{"slot":"claude","requestedModel":"claude-sonnet-RUN","provider":"deepseek","actualModel":"deepseek-chat","reason":"timeout"}]';
const INVENTED = /"unknown"|deepseek-chat|primary_failed|"requestedModel":"claude"|"actualModel":"claude"|"provider":"anthropic"/;

beforeEach(() => {
  runDocs.clear();
  prompts.length = 0;
  mockCreate.mockClear();
  runsGetCallCounts.clear();
});

describe("case 6 — a saved run's absent provenance stays absent in the synthesis prompt", () => {
  it("the SUBSTITUTIONS block carries the slot and nothing invented", async () => {
    const res = await POST(request("run-saved", SAVED_SUB));
    expect(res.status).toBe(200);
    expect(prompts.length).toBeGreaterThan(0);
    expect(blockOf(prompts[0])).toBe('[{"slot":"claude"}]');
    expect(prompts.join("\n")).not.toMatch(INVENTED);
  });

  it("only the individually supplied facts are included", async () => {
    await POST(request("run-partial", { ...SAVED_SUB, provider: "deepseek", requestedModel: "claude-RUN-1" }));
    expect(blockOf(prompts[0])).toBe('[{"slot":"claude","requestedModel":"claude-RUN-1","provider":"deepseek"}]');
  });
});

describe("case 7 — the cached synthesis cannot carry invented substitution provenance", () => {
  it("saved run: the cached report echoes the block, and the block has nothing invented", async () => {
    await POST(request("run-saved-cache", SAVED_SUB));
    const report = runDocs.get("run-saved-cache")?.synthesizedStructuredReport as { executiveSummary: string };
    expect(report.executiveSummary).toBe('ECHO [{"slot":"claude"}]');
    // ("unknownModels" is a legitimate report field name, so match invented VALUES only.)
    expect(JSON.stringify(report)).not.toMatch(/\\"unknown\\"|deepseek-chat|primary_failed|requestedModel|actualModel|anthropic/);
  });

  it("CONTROL (non-vacuity): a live run's real provenance DOES reach the cache through the same path", async () => {
    await POST(request("run-live-cache", LIVE_SUB));
    const cached = JSON.stringify(runDocs.get("run-live-cache")?.synthesizedStructuredReport);
    expect(cached).toContain("deepseek-chat");
    expect(cached).toContain("claude-sonnet-RUN");
  });
});

describe("case 8 (live) — complete live provenance produces the exact pre-S1 block", () => {
  it("prompt block is byte-identical to the pre-S1 format", async () => {
    await POST(request("run-live", LIVE_SUB));
    expect(blockOf(prompts[0])).toBe(PRE_S1_LIVE_BLOCK);
  });
  it("buildSubstitutionBlock: a complete entry serializes exactly as before", () => {
    expect(buildSubstitutionBlock([{ slot: "claude", requestedModel: "claude-sonnet-RUN", provider: "deepseek", actualModel: "deepseek-chat", reason: "timeout" }])).toBe(`\nSUBSTITUTIONS:\n${PRE_S1_LIVE_BLOCK}\n`);
  });
});

describe("no run lookup is added to recover provenance", () => {
  it("a saved request reads runs/{runId} exactly as often as a live one", async () => {
    await POST(request("run-a", LIVE_SUB));
    await POST(request("run-b", SAVED_SUB));
    expect(runsGetCallCounts.get("run-b")).toBe(runsGetCallCounts.get("run-a"));
  });
});
