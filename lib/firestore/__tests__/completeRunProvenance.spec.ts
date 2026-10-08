/**
 * Step 6.2a — Runtime Model Provenance Capture.
 *
 * Stop condition: every newly completed run freezes the runtime provider,
 * requested model and substitution provenance already available during that
 * execution into its existing perModel rows; missing provenance is never
 * synthesized; no additional write operation is introduced.
 *
 * Current model configuration is faked with a SENTINEL that differs from every
 * runtime value, and switched between two completions of the same runtime
 * results — so any derivation from configuration is visible in the output.
 */

let configProvider = "CONFIG-PROVIDER-A";
jest.mock("@/lib/panelModels", () => {
  const actual = jest.requireActual("@/lib/panelModels");
  return { ...actual, getPanelModelConfig: (id: string) => ({ ...actual.getPanelModelConfig(id), provider: configProvider }) };
});

const update = jest.fn(async (_data: Record<string, unknown>) => undefined);
const set = jest.fn(async () => undefined);
const get = jest.fn(async () => ({ exists: false, data: () => undefined }));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ get, update, set }) }) },
}));

import { completeRun } from "@/lib/firestore/runs";
import type { ModelResult } from "@/lib/types";

const RUNTIME_REQUESTED = "gpt-RUNTIME-AT-EXECUTION";
const tokenUsage = { totalTokens: 3, promptTokens: 1, completionTokens: 2 };

function okRow(over: Partial<ModelResult> = {}): ModelResult {
  return {
    modelId: "chatgpt",
    status: "ok",
    rawText: "answer",
    latencyMs: 10,
    tokenUsage,
    provider: "openai",
    requestedModel: RUNTIME_REQUESTED,
    actualModel: RUNTIME_REQUESTED,
    ...over,
  } as ModelResult;
}
function substitutedRow(over: Partial<ModelResult> = {}): ModelResult {
  return {
    modelId: "claude",
    status: "substituted",
    rawText: "deepseek answer",
    latencyMs: 20,
    tokenUsage,
    provider: "deepseek",
    requestedModel: "claude-RUNTIME-AT-EXECUTION",
    actualModel: "deepseek-chat",
    substitutedFrom: "anthropic:claude-RUNTIME-AT-EXECUTION",
    substitutionReason: "timeout",
    ...over,
  } as ModelResult;
}

async function complete(results: ModelResult[]) {
  update.mockClear();
  await completeRun({
    runId: "run-1",
    userId: "uid-1",
    results,
    question: "Q?",
    selectedModels: results.map((r) => r.modelId),
    tokenUsageByModel: results.map((r) => ({ modelId: r.modelId, tokenUsage: { totalTokens: 3, promptTokens: 1, completionTokens: 2 } })) as never,
    tokenTotals: { totalTokens: 3 * results.length, promptTokens: results.length, completionTokens: 2 * results.length } as never,
  });
  expect(update).toHaveBeenCalledTimes(1);
  const written = update.mock.calls[0][0] as { runDocument: { perModel: Array<Record<string, unknown>> } };
  return written.runDocument.perModel;
}

beforeEach(() => {
  configProvider = "CONFIG-PROVIDER-A";
  update.mockClear();
  set.mockClear();
  get.mockClear();
});

it("freezes the runtime provider and requested model onto the existing perModel row", async () => {
  const [row] = await complete([okRow()]);
  expect(row.provider).toBe("openai");
  expect(row.requestedModel).toBe(RUNTIME_REQUESTED);
});

it("changing current model configuration does not change what is persisted for the same execution", async () => {
  const underA = await complete([okRow(), substitutedRow()]);
  configProvider = "CONFIG-PROVIDER-B";
  const underB = await complete([okRow(), substitutedRow()]);
  expect(underB).toEqual(underA);
  const json = JSON.stringify(underA);
  expect(json).not.toContain("CONFIG-PROVIDER");
});

it("a substituted row preserves its real substitutedFrom, provider and requested model", async () => {
  const [row] = await complete([substitutedRow()]);
  expect(row.status).toBe("substituted");
  expect(row.substitutedFrom).toBe("anthropic:claude-RUNTIME-AT-EXECUTION");
  expect(row.provider).toBe("deepseek");
  expect(row.requestedModel).toBe("claude-RUNTIME-AT-EXECUTION");
});

it("a non-substituted row never acquires a substitutedFrom key", async () => {
  const [row] = await complete([okRow()]);
  expect("substitutedFrom" in row).toBe(false);
});

it.each([
  ["provider", { provider: undefined }],
  ["provider", { provider: "" }],
  ["requestedModel", { requestedModel: undefined }],
  ["requestedModel", { requestedModel: "" }],
])("a runtime result without %s persists no %s key — never synthesized from config or modelId", async (field, over) => {
  const [row] = await complete([okRow(over as Partial<ModelResult>)]);
  expect(field in row).toBe(false);
  expect(JSON.stringify(row)).not.toContain("CONFIG-PROVIDER");
});

it("never persists actualModel or substitutionReason", async () => {
  const rows = await complete([okRow(), substitutedRow()]);
  for (const row of rows) {
    expect("actualModel" in row).toBe(false);
    expect("substitutionReason" in row).toBe(false);
  }
});

it("adds fields to the ONE existing completion write — no other write operation", async () => {
  await complete([okRow(), substitutedRow()]);
  expect(update).toHaveBeenCalledTimes(1);
  expect(set).not.toHaveBeenCalled();
  const [row] = (update.mock.calls[0][0] as { runDocument: { perModel: Array<Record<string, unknown>> } }).runDocument.perModel;
  expect(Object.keys(row).sort()).toEqual(["latencyMs", "modelId", "provider", "rawTextTruncated", "requestedModel", "status", "tokenUsage", "wasTruncated"]);
});
