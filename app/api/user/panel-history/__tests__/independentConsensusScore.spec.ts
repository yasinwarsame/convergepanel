/**
 * M2 — GET /api/user/panel-history (History list, rendered by app/page.tsx as "· Synthesis N/100") lists a stored
 * synthesis consensus score only when the run's persisted rows prove at least two independent executing models;
 * otherwise the score is absent and `synthesisConsensusWithheld` gives the reason. Stored docs are unchanged.
 */
const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const UID = "uid-1";
let runRows: Array<{ id: string; data: Record<string, unknown> }> = [];

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              get: async () => ({ docs: name === "runs" ? runRows.map((r) => ({ id: r.id, data: () => r.data })) : [] }),
            }),
          }),
        }),
      }),
    };
  },
}));
jest.mock("@/lib/workspaces/runWorkspaceIntegrityBatch", () => ({
  createRunWorkspaceIntegrityBatch: () => async () => ({ classification: "legacy" }),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/panel-history/route";

const row = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...extra });
const run = (id: string, perModel: unknown[] | undefined) => ({
  id,
  data: {
    userId: UID,
    question: id,
    selectedModels: ["chatgpt", "claude", "grok"],
    createdAt: { toMillis: () => 1000 },
    synthesisConsensusSummary: { overallConsensusScore: 90 },
    ...(perModel ? { runDocument: { perModel } } : {}),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
});

async function items(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/user/panel-history"));
  expect(res.status).toBe(200);
  const body = await res.json();
  return Object.fromEntries(body.items.map((i: any) => [i.question, i]));
}

describe("GET /api/user/panel-history — stored consensus score vs independent executing models", () => {
  it("withholds below two independent models and for legacy rows without execution identity; lists two independent", async () => {
    const deepseek = { provider: "deepseek" };
    runRows = [
      run("two-deepseek", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek)]),
      // C-c (CC-01): verified scenarios record each ok row's runtime provider; provider-less ok rows are pre-6.2a (UV).
      run("one-independent", [row("chatgpt", "ok", { provider: "openai" }), row("claude", "failed", { rawTextTruncated: "" })]),
      run("missing-credentials", [row("chatgpt", "failed", { rawTextTruncated: "" }), row("claude", "failed", { rawTextTruncated: "" }), row("grok", "ok", { provider: "xai" })]),
      run("legacy-no-perModel", undefined),
      run("two-independent", [row("chatgpt", "ok", { provider: "openai" }), row("grok", "ok", { provider: "xai" })]),
      run("pre62a-two-ok", [row("chatgpt", "ok"), row("grok", "ok")]),
      run("registry-rejected", [row("chatgpt", "ok", { provider: "n/a" }), row("grok", "ok", { provider: "grok" })]),
    ];
    const by = await items();
    for (const k of ["two-deepseek", "one-independent", "missing-credentials"]) {
      expect([k, by[k].synthesisConsensusScore, by[k].synthesisConsensusWithheld]).toEqual([k, undefined, "insufficient_independent_models"]);
    }
    for (const k of ["legacy-no-perModel", "pre62a-two-ok", "registry-rejected"]) {
      expect([k, by[k].synthesisConsensusScore, by[k].synthesisConsensusWithheld]).toEqual([k, undefined, "independence_unverified"]);
    }
    expect(by["two-independent"].synthesisConsensusScore).toBe(90);
    expect("synthesisConsensusWithheld" in by["two-independent"]).toBe(false);
  });
});
