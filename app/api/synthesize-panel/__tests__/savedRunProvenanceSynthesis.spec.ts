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
 * Saved-run provenance honesty (S1) under governance input authority (F2).
 *
 * The SUBSTITUTIONS block is built from the PERSISTED run rows
 * (`runDocument.perModel`), never from request rows. A persisted substituted
 * row carries status, and — for runs completed after 6.2a — provider,
 * requestedModel and substitutedFrom; actualModel is never persisted (S2), so
 * it can never reach the block, whatever the request says. Absence stays
 * absence (no modelId-as-model, "unknown", "deepseek-chat", "primary_failed").
 */
const PROSE = [
  "Based on the available data, HubSpot appears to be the stronger choice for a small team.",
  "It offers a lower total cost of ownership and simpler onboarding than Salesforce for teams under twenty seats.",
].join(" ");
const QUESTION = "Which CRM should we choose?";

/** What a client could send for the substituted slot (complete "live" provenance) — must be ignored. */
const CLIENT_LIVE_SUB = { modelId: "claude", text: PROSE, status: "substituted", provider: "deepseek", requestedModel: "claude-sonnet-RUN", actualModel: "deepseek-chat", substitutionReason: "timeout", substitutedFrom: "anthropic:claude-sonnet-RUN" };

/** Persist a completed run whose second slot is a substituted row with exactly `subFacts`. */
function persistRun(runId: string, subFacts: Record<string, unknown>) {
  runDocs.set(runId, {
    userId: "test-uid",
    question: QUESTION,
    runDocument: {
      question: QUESTION,
      perModel: [
        { modelId: "chatgpt", status: "ok", rawTextTruncated: PROSE },
        { modelId: "claude", status: "substituted", rawTextTruncated: PROSE, ...subFacts },
      ],
    },
  });
}

function request(runId: string, clientSub: Record<string, unknown> = { modelId: "claude", text: PROSE, status: "substituted" }) {
  return new NextRequest("http://localhost/api/synthesize-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, question: QUESTION, results: [{ modelId: "chatgpt", text: PROSE, status: "ok" }, clientSub] }),
  });
}

const INVENTED = /"unknown"|deepseek-chat|primary_failed|"requestedModel":"claude"|"actualModel"|"provider":"anthropic"/;

beforeEach(() => {
  runDocs.clear();
  prompts.length = 0;
  mockCreate.mockClear();
  runsGetCallCounts.clear();
});

describe("case 6 — a persisted run's absent provenance stays absent in the synthesis prompt", () => {
  it("the SUBSTITUTIONS block carries the slot and nothing invented", async () => {
    persistRun("run-saved", {});
    const res = await POST(request("run-saved"));
    expect(res.status).toBe(200);
    expect(prompts.length).toBeGreaterThan(0);
    expect(blockOf(prompts[0])).toBe('[{"slot":"claude"}]');
    expect(prompts.join("\n")).not.toMatch(INVENTED);
  });

  it("only the facts the run persisted are included", async () => {
    persistRun("run-partial", { provider: "deepseek", requestedModel: "claude-RUN-1" });
    await POST(request("run-partial"));
    expect(blockOf(prompts[0])).toBe('[{"slot":"claude","requestedModel":"claude-RUN-1","provider":"deepseek"}]');
  });

  it("F2: complete provenance in the REQUEST is ignored — the block is the persisted facts only", async () => {
    persistRun("run-client-claims", {});
    await POST(request("run-client-claims", CLIENT_LIVE_SUB));
    expect(blockOf(prompts[0])).toBe('[{"slot":"claude"}]');
    expect(prompts.join("\n")).not.toMatch(INVENTED);
  });
});

describe("case 7 — the cached synthesis cannot carry invented substitution provenance", () => {
  it("persisted run without provenance: the cached report echoes a block with nothing invented", async () => {
    persistRun("run-saved-cache", {});
    await POST(request("run-saved-cache", CLIENT_LIVE_SUB));
    const report = runDocs.get("run-saved-cache")?.synthesizedStructuredReport as { executiveSummary: string };
    expect(report.executiveSummary).toBe('ECHO [{"slot":"claude"}]');
    // ("unknownModels" is a legitimate report field name, so match invented VALUES only.)
    expect(JSON.stringify(report)).not.toMatch(/\\"unknown\\"|deepseek-chat|primary_failed|requestedModel|actualModel|anthropic/);
  });

  it("CONTROL (non-vacuity): persisted provenance DOES reach the cache through the same path", async () => {
    persistRun("run-live-cache", { provider: "deepseek", requestedModel: "claude-sonnet-RUN", substitutedFrom: "anthropic:claude-sonnet-RUN" });
    await POST(request("run-live-cache"));
    const cached = JSON.stringify(runDocs.get("run-live-cache")?.synthesizedStructuredReport);
    expect(cached).toContain("claude-sonnet-RUN");
    expect(cached).toContain("deepseek");
    expect(cached).not.toContain("deepseek-chat"); // actualModel is never persisted, so never present
  });
});

describe("case 8 — the block format itself is unchanged", () => {
  it("buildSubstitutionBlock: a complete entry serializes exactly as before", () => {
    const PRE_S1_LIVE_BLOCK = '[{"slot":"claude","requestedModel":"claude-sonnet-RUN","provider":"deepseek","actualModel":"deepseek-chat","reason":"timeout"}]';
    expect(buildSubstitutionBlock([{ slot: "claude", requestedModel: "claude-sonnet-RUN", provider: "deepseek", actualModel: "deepseek-chat", reason: "timeout" }])).toBe(`\nSUBSTITUTIONS:\n${PRE_S1_LIVE_BLOCK}\n`);
  });
});

describe("no extra run lookup is added to recover provenance", () => {
  it("a request reads runs/{runId} the same number of times whatever the persisted provenance", async () => {
    persistRun("run-a", { provider: "deepseek", requestedModel: "claude-sonnet-RUN" });
    persistRun("run-b", {});
    await POST(request("run-a"));
    await POST(request("run-b"));
    expect(runsGetCallCounts.get("run-b")).toBe(runsGetCallCounts.get("run-a"));
  });
});
