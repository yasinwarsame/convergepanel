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

// Research deletion integrity (2026-11-03, review round 2 M-2): the completion write is now a guarded transactional
// update, so the spec uses the shared transactional fake. `updates()` and the full write log replace the update/set spies.
// The assertions are the same: exactly ONE completion write, it is an `update`, and nothing else is written.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const updates = () => db.writeLog.filter((w) => w.kind === "update");

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
  db.writeLog = [];
  await completeRun({
    runId: "run-1",
    userId: "uid-1",
    results,
    question: "Q?",
    selectedModels: results.map((r) => r.modelId),
    tokenUsageByModel: results.map((r) => ({ modelId: r.modelId, tokenUsage: { totalTokens: 3, promptTokens: 1, completionTokens: 2 } })) as never,
    tokenTotals: { totalTokens: 3 * results.length, promptTokens: results.length, completionTokens: 2 * results.length } as never,
  });
  expect(updates()).toHaveLength(1);
  const written = updates()[0].data as unknown as { runDocument: { perModel: Array<Record<string, unknown>> } };
  return written.runDocument.perModel;
}

beforeEach(() => {
  configProvider = "CONFIG-PROVIDER-A";
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.seed("runs/run-1", { userId: "uid-1", question: "Q?", status: "running" }); // completeRun updates an existing run
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
  expect(db.writeLog.map((w) => [w.kind, w.path])).toEqual([["update", "runs/run-1"]]); // one write, an update, nothing else
  const [row] = (updates()[0].data as unknown as { runDocument: { perModel: Array<Record<string, unknown>> } }).runDocument.perModel;
  expect(Object.keys(row).sort()).toEqual(["latencyMs", "modelId", "provider", "rawTextTruncated", "requestedModel", "status", "tokenUsage", "wasTruncated"]);
});

it("deletion barrier (review round 2, M-2): model output is not written to a run whose deletion has started", async () => {
  db.seed("runDeletionJobs/run-1", { state: "in_progress" });
  db.writeLog = [];
  await expect(
    completeRun({ runId: "run-1", userId: "uid-1", results: [okRow()], question: "Q?", selectedModels: ["chatgpt"], tokenUsageByModel: [{ modelId: "chatgpt", tokenUsage }] as never, tokenTotals: { totalTokens: 3, promptTokens: 1, completionTokens: 2 } as never })
  ).rejects.toMatchObject({ code: "research_write_refused" });
  expect(db.writeLog).toEqual([]);
  expect(db.read("runs/run-1")).toEqual({ userId: "uid-1", question: "Q?", status: "running" });
});
