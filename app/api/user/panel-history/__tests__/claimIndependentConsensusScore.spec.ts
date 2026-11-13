/**
 * Review of 262ef64, MAJOR B1 — GET /api/user/panel-history claim items (rendered by app/page.tsx as
 * "Confirmed · 100 consensus") list the stored score only when the stored per-model rows prove >= 2 independent
 * executing models with a usable answer; otherwise `consensusScore: null` + `consensusWithheld`, and every item carries
 * `modelIndependence` for the client line (claimHistoryConsensusSuffix). Stored docs are unchanged.
 */
const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const UID = "uid-1";
let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              get: async () => ({ docs: name === "verifications" ? verRows.map((r) => ({ id: r.id, data: () => r.data })) : [] }),
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
import { claimHistoryConsensusSuffix } from "@/lib/verification/claimConsensusPresentation";

const row = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({ modelId, status, verdict: "accurate", ...extra });
const DS = { substituted: true, provider: "deepseek" };
const OPENAI = { provider: "openai" };
const ver = (id: string, modelResults: unknown[] | undefined, selectedModels?: string[]) => ({
  id,
  data: {
    userId: UID,
    type: "claim_verification",
    claim: id,
    verdict: "confirmed",
    consensusScore: 100,
    timestamp: { toMillis: () => 1000 },
    ...(modelResults ? { modelResults } : {}),
    ...(selectedModels ? { selectedModels } : {}),
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
  return Object.fromEntries(body.items.map((i: any) => [i.claim, i]));
}

describe("GET /api/user/panel-history — claim consensus score vs independent executing models", () => {
  it.each([
    // C-b (CB-01): verified scenarios record each answering row's provider; provider-less rows (what stored own-provider
    // claim rows hold, m-B) are unverified.
    ["one-of-three", [row("chatgpt", "ok", OPENAI), row("claude", "failed"), row("grok", "failed")], ["chatgpt", "claude", "grok"], null, "insufficient_independent_models", "insufficient", " · No consensus score (fewer than two independent models)"],
    ["two-deepseek", [row("chatgpt", "ok", DS), row("claude", "ok", DS)], ["chatgpt", "claude"], null, "insufficient_independent_models", "insufficient", " · No consensus score (fewer than two independent models)"],
    ["two-independent", [row("chatgpt", "ok", OPENAI), row("claude", "ok", { provider: "anthropic" })], ["chatgpt", "claude"], 100, undefined, "independent", " · 100 consensus"],
    ["missing-provenance", undefined, undefined, null, "independence_unverified", "unverified", " · Consensus score withheld (model independence not recorded)"],
    ["legacy-two-ok-no-selected", [row("chatgpt", "ok", OPENAI), row("gemini", "ok", { provider: "google" })], undefined, 100, undefined, "independent", " · 100 consensus"],
    ["two-ok-provider-less", [row("chatgpt", "ok"), row("claude", "ok")], ["chatgpt", "claude"], null, "independence_unverified", "unverified", " · Consensus score withheld (model independence not recorded)"],
    ["one-of-three-provider-less", [row("chatgpt", "ok"), row("claude", "failed"), row("grok", "failed")], ["chatgpt", "claude", "grok"], null, "independence_unverified", "unverified", " · Consensus score withheld (model independence not recorded)"],
  ])("%s", async (id, mr, sel, score, withheld, independence, suffix) => {
    const d = ver(id, mr as unknown[] | undefined, sel as string[] | undefined);
    const before = JSON.stringify(d.data);
    verRows = [d];
    const it0 = (await items())[id];
    expect([it0.consensusScore, it0.consensusWithheld, it0.modelIndependence]).toEqual([score, withheld, independence]);
    expect(claimHistoryConsensusSuffix(it0)).toBe(suffix);
    expect(JSON.stringify(d.data)).toBe(before);
  });
});
