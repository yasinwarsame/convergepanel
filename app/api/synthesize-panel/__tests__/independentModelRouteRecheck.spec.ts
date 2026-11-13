/**
 * Phase 0 (L03 site 2; owner Option C): /api/synthesize-panel has NO executing-model re-check of the prompt rows, exactly
 * as at 35933c8 — admission is decided once, by authoritativeSynthesisInputs (usable slots). Here that gate is replaced
 * by a double that admits two DeepSeek-substituted rows, and the route synthesizes them like any two admitted rows.
 * Harness copied from serverAuthoritativeInputs.spec.ts.
 */
import { installDeletionTombstoneCollection } from "@/lib/workspaces/__tests__/helpers/deletionTombstoneCollection";
jest.mock("@/lib/env", () => ({ OPENAI_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key" }));
jest.mock("@/lib/firebase/auth-helpers", () => ({ verifySessionCookie: jest.fn().mockResolvedValue({ uid: "test-uid" }) }));
jest.mock("@/lib/firebase/auth", () => ({ verifyIdToken: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() }),
}));

const runDocs = new Map<string, Record<string, unknown>>();
const runWrites: Array<{ id: string; fields: Record<string, unknown> }> = [];
const mockAdminDb = {
  // Research deletion integrity (2026-11-03, review round 2 M-2): the synthesis write is now a guarded transactional
  // update. Buffered like a real transaction: the writes apply only when the callback completes.
  runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
    const buffered: Array<() => Promise<unknown>> = [];
    const result = await fn({
      get: (ref: any) => ref.get(),
      update: (ref: any, f: unknown) => void buffered.push(() => ref.update(f)),
      set: (ref: any, f: unknown, o?: unknown) => void buffered.push(() => ref.set(f, o)),
      create: (ref: any, f: unknown) => void buffered.push(() => (ref.create ? ref.create(f) : ref.set(f))),
    });
    for (const w of buffered) await w();
    return result;
  },
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (name === "users") return { exists: true, data: () => ({ email: "user@example.com" }) };
        const data = runDocs.get(id);
        return { exists: !!data, data: () => (data ? structuredClone(data) : undefined) };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        if (name === "runs") runWrites.push({ id, fields });
        runDocs.set(id, { ...(runDocs.get(id) || {}), ...fields });
      }),
      set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        if (name === "runs") runWrites.push({ id, fields });
        runDocs.set(id, { ...(opts?.merge ? runDocs.get(id) || {} : {}), ...fields });
      }),
      collection: () => ({ add: jest.fn().mockResolvedValue({ id: "event-id" }) }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
installDeletionTombstoneCollection(mockAdminDb);

// Workspace integrity is exercised for real elsewhere; here a Workspace-bound run is simply "valid".
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: jest.fn(async (d: Record<string, unknown>) =>
    typeof d.workspaceId === "string" ? { classification: "valid", workspaceId: d.workspaceId } : { classification: "legacy" }
  ),
}));

const mockedEvaluateAndStoreGovernance = jest.fn().mockResolvedValue({ governanceStatus: "approved" });
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockedEvaluateAndStoreGovernance(...args),
}));

/** The "LLM" returns one key finding about Zanzibar — supported only by the SERVER texts below. */
const SYNTHESIS = {
  executiveSummary: "Synthesis.",
  keyFindings: [{ claim: "Zanzibar holds the answer.", confidence: "Medium", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude"] }],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison.",
};
const prompts: string[] = [];
const mockCreate = jest.fn().mockImplementation(async (args: unknown) => {
  prompts.push(JSON.parse(JSON.stringify(args)).messages.map((m: { content: string }) => m.content).join("\n"));
  return { choices: [{ message: { content: JSON.stringify(SYNTHESIS) } }] };
});
jest.mock("openai", () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockCreate(...a) } } })));
jest.mock("@anthropic-ai/sdk", () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));


const mockAuthoritative = jest.fn();
jest.mock("@/lib/synthesis/authoritativeRunInputs", () => ({ authoritativeSynthesisInputs: (...a: unknown[]) => mockAuthoritative(...a) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/synthesize-panel/route";

const A = "SERVER-TEXT-ALPHA. Zanzibar is the island the evidence points to, with a long and well documented trading history across the Indian Ocean.";
const B = "SERVER-TEXT-BRAVO. Zanzibar again stands out: its archives, its port records and its spice trade make it the strongest first candidate.";
const row = (modelId: string, status: "ok" | "substituted", text: string, provider?: string) => ({ modelId, status, text, provenance: provider ? { provider } : {} });

function post(runId: string) {
  return POST(
    new NextRequest("http://localhost/api/synthesize-panel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, question: "q", results: [{ modelId: "chatgpt", text: A, status: "ok" }, { modelId: "claude", text: B, status: "ok" }] }),
    })
  );
}

beforeEach(() => {
  runDocs.clear();
  runWrites.length = 0;
  prompts.length = 0;
  mockCreate.mockClear();
  mockedEvaluateAndStoreGovernance.mockClear();
  runDocs.set("run-x", { userId: "test-uid", question: "q", runDocument: { question: "q", perModel: [] } });
});

describe("route: no executing-model re-check of the prompt rows (Phase 0 = 35933c8)", () => {
  it("Phase 0 slot rule: two DeepSeek-substituted rows admitted upstream → synthesized (no re-check, 35933c8)", async () => {
    mockAuthoritative.mockReturnValue({ ok: true, value: { question: "q", rows: [row("chatgpt", "substituted", A, "deepseek"), row("claude", "substituted", B, "deepseek")] } });
    const res = await post("run-x");
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(runWrites.some((w) => "synthesizedStructuredReport" in w.fields)).toBe(true);
  });

  it("control: one real + one substitute admitted upstream → synthesized", async () => {
    mockAuthoritative.mockReturnValue({ ok: true, value: { question: "q", rows: [row("chatgpt", "substituted", A, "deepseek"), row("claude", "ok", B, "anthropic")] } });
    const res = await post("run-x");
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
