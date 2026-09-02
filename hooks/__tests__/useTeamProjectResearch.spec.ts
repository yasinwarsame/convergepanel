/**
 * Team Project Research Composer, Phase 12A.3 — `useTeamProjectResearch()`
 * hook: exact request shape (URL/method/body), synchronous single-flight
 * guard (a genuine double-submit test, not merely `isSubmitting` state),
 * response parsing, and error passthrough. `react-test-renderer` + `act()`
 * `HookHost` pattern, mirroring `hooks/__tests__/useTeamProjectLifecycle.spec.ts`.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const callLog: { url: string; options: any }[] = [];
const authedFetchMock = jest.fn((url: string, options: any) => {
  callLog.push({ url, options });
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, runId: "run-1", results: [] }) });
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, any]) => authedFetchMock(...args),
}));

import { useTeamProjectResearch } from "@/hooks/useTeamProjectResearch";
import type { UseTeamProjectResearchResult, TeamResearchSubmitResult } from "@/hooks/useTeamProjectResearch";

const WS_ID = "ws-1";
const PROJECT_ID = "proj-1";

function fakeResult(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "chatgpt",
    status: "ok",
    rawTextFull: "The answer is 42.",
    rawText: "The answer is 42.",
    latencyMs: 1200,
    tokenUsage: { input: 10, output: 20, total: 30 },
    requestedModel: "gpt-5.2",
    provider: "openai",
    actualModel: "gpt-5.2",
    ...overrides,
  };
}

function HookHost({ onResult }: { onResult: (r: UseTeamProjectResearchResult) => void }) {
  const result = useTeamProjectResearch({ workspaceId: WS_ID, projectId: PROJECT_ID });
  onResult(result);
  return null;
}

async function mount(): Promise<{ latest: () => UseTeamProjectResearchResult }> {
  let latest!: UseTeamProjectResearchResult;
  await act(async () => {
    TestRenderer.create(createElement(HookHost, { onResult: (r) => (latest = r) }));
  });
  return { latest: () => latest };
}

beforeEach(() => {
  callLog.length = 0;
  authedFetchMock.mockClear();
  authedFetchMock.mockImplementation((url: string, options: any) => {
    callLog.push({ url, options });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, runId: "run-1", results: [fakeResult()], governanceStatus: "approved" }) });
  });
  mockedUseAuth.mockReturnValue({ user: { uid: "member-1" }, authReady: true });
});

describe("useTeamProjectResearch — request shape", () => {
  it("POST /api/workspaces/{workspaceId}/runs with body { question, selectedModels, projectId } — projectId is ALWAYS the bound Project, never null, never client-overridable", async () => {
    const { latest } = await mount();
    let result!: TeamResearchSubmitResult;
    await act(async () => {
      result = await latest().submit({ question: "What is the market size?", selectedModels: ["chatgpt", "claude"] });
    });
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toBe(`/api/workspaces/${WS_ID}/runs`);
    expect(callLog[0].options.method).toBe("POST");
    expect(JSON.parse(callLog[0].options.body)).toEqual({ question: "What is the market size?", selectedModels: ["chatgpt", "claude"], projectId: PROJECT_ID });
    expect(result).toEqual({ status: "ok", run: { runId: "run-1", results: [fakeResult()], governanceStatus: "approved" } });
  });

  it("NEVER calls /api/run-panel — the frozen 12A.3 architecture boundary", async () => {
    const { latest } = await mount();
    await act(async () => {
      await latest().submit({ question: "Q", selectedModels: ["chatgpt", "claude"] });
    });
    expect(callLog.every((c) => c.url !== "/api/run-panel")).toBe(true);
  });

  it("a non-ok HTTP response with a known errorCode maps through directly", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.resolve({ ok: false, json: async () => ({ ok: false, errorCode: "RUN_LIMIT_REACHED", message: "You've reached your monthly run limit." }) });
    });
    const { latest } = await mount();
    let result!: TeamResearchSubmitResult;
    await act(async () => {
      result = await latest().submit({ question: "Q", selectedModels: ["chatgpt", "claude"] });
    });
    expect(result).toEqual({ status: "error", errorCode: "RUN_LIMIT_REACHED", message: "You've reached your monthly run limit." });
  });

  it("a malformed success response (missing runId) is reported as internal_error, never a false success", async () => {
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, results: [] }) });
    });
    const { latest } = await mount();
    let result!: TeamResearchSubmitResult;
    await act(async () => {
      result = await latest().submit({ question: "Q", selectedModels: ["chatgpt", "claude"] });
    });
    expect(result.status).toBe("error");
  });

  it("a thrown fetch maps to network_error, never throws out of the hook", async () => {
    authedFetchMock.mockImplementation(() => {
      throw new Error("network down");
    });
    const { latest } = await mount();
    let result!: TeamResearchSubmitResult;
    await act(async () => {
      result = await latest().submit({ question: "Q", selectedModels: ["chatgpt", "claude"] });
    });
    expect(result).toEqual({ status: "error", errorCode: "network_error", message: expect.any(String) });
  });

  it("isSubmitting is true only while a submission is in flight", async () => {
    let resolveResponse!: (v: unknown) => void;
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    const { latest } = await mount();
    expect(latest().isSubmitting).toBe(false);

    let pending!: Promise<TeamResearchSubmitResult>;
    await act(async () => {
      pending = latest().submit({ question: "Q", selectedModels: ["chatgpt", "claude"] });
    });
    expect(latest().isSubmitting).toBe(true);

    await act(async () => {
      resolveResponse({ ok: true, json: async () => ({ ok: true, runId: "run-1", results: [] }) });
      await pending;
    });
    expect(latest().isSubmitting).toBe(false);
  });

  it("DOUBLE-SUBMIT SAFETY — a second submit() call while the first is still in flight produces exactly ONE POST; the second call is rejected synchronously", async () => {
    let resolveResponse!: (v: unknown) => void;
    authedFetchMock.mockImplementation((url: string, options: any) => {
      callLog.push({ url, options });
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    const { latest } = await mount();

    let firstPending!: Promise<TeamResearchSubmitResult>;
    let secondResult!: TeamResearchSubmitResult;
    await act(async () => {
      firstPending = latest().submit({ question: "First question", selectedModels: ["chatgpt", "claude"] });
      // Fired synchronously, in the SAME tick, before the first request settles.
      secondResult = await latest().submit({ question: "Second question", selectedModels: ["chatgpt", "claude"] });
    });

    // Only the FIRST call's POST ever reached authedFetch.
    expect(callLog).toHaveLength(1);
    expect(JSON.parse(callLog[0].options.body).question).toBe("First question");
    expect(secondResult.status).toBe("error");

    await act(async () => {
      resolveResponse({ ok: true, json: async () => ({ ok: true, runId: "run-1", results: [] }) });
      await firstPending;
    });
    // Still only ever one POST, even after the first settles.
    expect(callLog).toHaveLength(1);
    expect(latest().isSubmitting).toBe(false);
  });
});
