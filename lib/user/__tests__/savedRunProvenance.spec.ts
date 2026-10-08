/**
 * Saved-run provenance honesty (S1) — the saved-read path.
 *
 * Stop condition (cases 1–5): every provider / requested-model / substituted-from /
 * substitution-reason / actual-model fact a saved-run API returns is backed by
 * an explicit value persisted with that run. Current model configuration is
 * faked with a SENTINEL provider and switched between reads, so any derivation
 * from configuration is visible.
 */

let configProvider = "CONFIG-PROVIDER-A";
jest.mock("@/lib/panelModels", () => {
  const actual = jest.requireActual("@/lib/panelModels");
  return { ...actual, getPanelModelConfig: (id: string) => ({ ...actual.getPanelModelConfig(id), provider: configProvider }) };
});

import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import { publicizePanelResults } from "@/lib/panel/publicize";
import { normalizePersistedModelResult } from "@/lib/panel/normalize";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";

const tokenUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
const row = (over: Record<string, unknown>) => ({ modelId: "chatgpt", status: "ok", rawTextTruncated: "answer", latencyMs: 5, tokenUsage, wasTruncated: false, ...over });

/** A run completed after 6.2a: provenance persisted on every row. */
const POST_62A = {
  perModel: [
    row({ provider: "openai", requestedModel: "gpt-RUN-1" }),
    row({ modelId: "claude", status: "substituted", provider: "deepseek", requestedModel: "claude-RUN-1", substitutedFrom: "anthropic:claude-RUN-1" }),
  ],
};
/** A run completed before 6.2a: no provenance persisted. */
const PRE_62A = { perModel: [row({}), row({ modelId: "claude", status: "substituted" })] };
const PROVENANCE_KEYS = ["provider", "requestedModel", "actualModel", "substitutedFrom", "substitutionReason"];

beforeEach(() => {
  configProvider = "CONFIG-PROVIDER-A";
});

describe("case 1 — current model configuration never reaches a saved run", () => {
  it.each([
    ["post-6.2a", POST_62A],
    ["pre-6.2a", PRE_62A],
  ])("%s run: identical output under two configurations, sentinel never appears", (_label, doc) => {
    const underA = runDocumentToPublicResults(doc as never);
    configProvider = "CONFIG-PROVIDER-B";
    const underB = runDocumentToPublicResults(doc as never);
    expect(underB).toEqual(underA);
    expect(JSON.stringify(underA)).not.toContain("CONFIG-PROVIDER");
  });
});

describe("case 2 — a post-6.2a run returns its exact persisted provenance", () => {
  it("provider, requestedModel and (substituted row) substitutedFrom, exactly as persisted", () => {
    const [ok, sub] = runDocumentToPublicResults(POST_62A as never) as unknown as Array<Record<string, unknown>>;
    expect(ok).toMatchObject({ modelId: "chatgpt", status: "ok", provider: "openai", requestedModel: "gpt-RUN-1" });
    expect("substitutedFrom" in ok).toBe(false);
    expect(sub).toMatchObject({ modelId: "claude", status: "substituted", provider: "deepseek", requestedModel: "claude-RUN-1", substitutedFrom: "anthropic:claude-RUN-1" });
  });
});

describe("case 3 — a pre-6.2a run returns none of those keys", () => {
  it("no provider, requestedModel, substitutedFrom, substitutionReason or actualModel on any row", () => {
    for (const r of runDocumentToPublicResults(PRE_62A as never) as unknown as Array<Record<string, unknown>>) {
      for (const key of PROVENANCE_KEYS) expect(key in r).toBe(false);
    }
  });
  it("the logical slot and status are still returned", () => {
    expect(runDocumentToPublicResults(PRE_62A as never).map((r) => [r.modelId, r.status])).toEqual([
      ["chatgpt", "ok"],
      ["claude", "substituted"],
    ]);
  });
});

describe("case 4 — saved-run responses contain no actualModel", () => {
  it("not from perModel rows, and not even when a legacy results[] row stored one", () => {
    expect(JSON.stringify(runDocumentToPublicResults(POST_62A as never))).not.toContain("actualModel");
    const legacy = publicizePanelResults([{ modelId: "chatgpt", status: "ok", rawText: "x", provider: "openai", requestedModel: "gpt-4o", actualModel: "gpt-4o" }]);
    expect("actualModel" in (legacy[0] as unknown as Record<string, unknown>)).toBe(false);
    // ...while that legacy row's genuinely stored provenance is kept as stored.
    expect(legacy[0]).toMatchObject({ provider: "openai", requestedModel: "gpt-4o" });
  });
});

describe("case 5 — an old substituted run may say substituted but names nothing unrecorded", () => {
  it("substituted status kept; no provider / model / reason invented", () => {
    const sub = runDocumentToPublicResults(PRE_62A as never)[1] as unknown as Record<string, unknown>;
    expect(sub.status).toBe("substituted");
    for (const key of PROVENANCE_KEYS) expect(key in sub).toBe(false);
  });
  it.each([
    ["a bare model string", "gpt-4o-mini"],
    ["an object missing its model", { provider: "openai" }],
    ["an object missing its provider", { model: "gpt-4o-mini" }],
    ["an empty string", ""],
  ])("a stored substitutedFrom that is %s is not completed with a fallback provider or 'unknown'", (_l, value) => {
    const out = normalizePersistedModelResult({ modelId: "claude", status: "substituted", substitutedFrom: value }) as Record<string, unknown>;
    expect("substitutedFrom" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("unknown");
  });
  it("a complete legacy object is canonicalized, and its code-like reason kept", () => {
    expect(normalizePersistedModelResult({ modelId: "claude", status: "substituted", substitutedFrom: { provider: "anthropic", model: "claude-3", reason: "timeout" } })).toMatchObject({
      substitutedFrom: "anthropic:claude-3",
      substitutionReason: "timeout",
    });
  });
  it("a non-code stored reason is dropped, never rewritten to 'unknown_error'", () => {
    const out = normalizePersistedModelResult({ modelId: "claude", status: "substituted", substitutionReason: "The upstream API returned an error message" }) as Record<string, unknown>;
    expect("substitutionReason" in out).toBe(false);
  });
  it("a non-substituted row never carries substitutedFrom or a reason, even if stored", () => {
    const out = normalizePersistedModelResult({ modelId: "chatgpt", status: "ok", substitutedFrom: "openai:x", substitutionReason: "timeout" }) as Record<string, unknown>;
    expect("substitutedFrom" in out).toBe(false);
    expect("substitutionReason" in out).toBe(false);
  });
});

describe("the saved-run read APIs (Personal and Team detail share buildRunReadPayload)", () => {
  async function results(doc: unknown, viewerRole: RunReadViewerRole) {
    const payload = await buildRunReadPayload({
      mayReadDecisionContent: true,
      runId: "run-1",
      data: { userId: "owner-1", question: "Q", selectedModels: ["chatgpt", "claude"], status: "complete", runDocument: doc },
      viewerRole,
      resolveReviewRouting: async () => "unknown",
    });
    return JSON.parse(JSON.stringify(payload.results)) as Array<Record<string, unknown>>;
  }
  it.each(["owner", "team_member", "personal_reviewer", "team_reviewer"] as const)("%s: a pre-6.2a run returns no provenance keys", async (role) => {
    for (const r of await results(PRE_62A, role)) for (const key of PROVENANCE_KEYS) expect(key in r).toBe(false);
  });
  it.each(["owner", "team_member"] as const)("%s: a post-6.2a run returns exactly the persisted values", async (role) => {
    const [ok, sub] = await results(POST_62A, role);
    expect([ok.provider, ok.requestedModel, sub.provider, sub.requestedModel, sub.substitutedFrom]).toEqual(["openai", "gpt-RUN-1", "deepseek", "claude-RUN-1", "anthropic:claude-RUN-1"]);
  });
});
