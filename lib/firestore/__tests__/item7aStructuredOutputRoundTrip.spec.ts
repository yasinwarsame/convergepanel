/**
 * Item 7A (owner-authorized final correction round, 2026-11-24) — Firestore persistence round trip of the per-slot
 * structured-output record (`adaptiveOutput.meta.structuredOutput`).
 *
 * One run is built through the real pipeline (finalizeAdaptiveRun: real validation, a word-cap shortening, a
 * substitution, an unusable response, a provider timeout), written with the production writer (persistAdaptiveOutput),
 * read back from the stored document, and parsed with the production reader (parsePersistedAdaptiveOutput). The record,
 * the strict reader's verdict and the derived disclosure must all survive unchanged.
 *
 * Backend:
 *   - With FIRESTORE_EMULATOR_HOST set: the REAL Firestore emulator through firebase-admin (real encoding: maps,
 *     arrays of maps, integers, no undefined values):
 *       FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 GCLOUD_PROJECT=demo-item7a npx jest --runTestsByPath <file>
 *   - Otherwise (CI): the shared transactional fake, so the same assertions still run on every push.
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-item7a";

jest.mock("@/lib/firebase/admin", () => {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
    const { getFirestore } = jest.requireActual("firebase-admin/firestore");
    const app = getApps().find((a: { name: string }) => a.name === "item7a-emulator") ?? initializeApp({ projectId: "demo-item7a" }, "item7a-emulator");
    const mockDb = getFirestore(app);
    // Same client setting as Production (lib/firebase/admin.ts): the run meta already carries optional undefined keys
    // (e.g. sourceCoverage) that Production drops. The Item 7A record itself never relies on it (asserted below).
    if (!(globalThis as any).__item7aSettingsApplied) {
      mockDb.settings({ ignoreUndefinedProperties: true });
      (globalThis as any).__item7aSettingsApplied = true;
    }
    return {
      get adminDb() {
        return mockDb;
      },
    };
  }
  const { FakeTransactionalFirestore } = jest.requireActual("@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore");
  const fake = new FakeTransactionalFirestore();
  return {
    get adminDb() {
      return fake;
    },
  };
});

import { adminDb } from "@/lib/firebase/admin";
import { persistAdaptiveOutput } from "@/lib/firestore/runs";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { deriveStructuredOutputDisclosure, readStructuredOutputRecord } from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import type { CommonResponseMeta, QueryClassification } from "@/lib/adaptiveSchema/types";
import type { ModelId, ModelResult } from "@/lib/types";

const db = adminDb as any;
const RUN_ID = "run-item7a-roundtrip";

async function seedRun() {
  if (EMULATOR) {
    await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
    await db.collection("runs").doc(RUN_ID).set({ userId: "u1", status: "complete" });
  } else {
    db.docs.clear();
    db.seed(`runs/${RUN_ID}`, { userId: "u1", status: "complete" });
  }
}
async function readRun(): Promise<Record<string, any>> {
  return EMULATOR ? (await db.collection("runs").doc(RUN_ID).get()).data() : db.read(`runs/${RUN_ID}`);
}

const classification = {
  queryType: "decision_support", domain: "test", answerShape: "decision_support_view", quantExpected: false, timeSensitivity: "low",
  userIntent: "make_decision", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless",
  inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, rationale: "fixture",
} as QueryClassification;

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    decisionQuestion: "Which option?", options: ["Option A"], criteria: [], userProvidedCriteria: [], assessments: [], recommendationAction: "go",
    recommendedOption: "Option A", recommendationRationale: "r", recommendationCaveats: [], assumptions: [], uncertainties: [], risks: [],
    sensitivityFindings: [], reversibleNextStep: "", sources: [], ...over,
  });

describe(`Item 7A structured-output record: Firestore round trip (${EMULATOR ? "real emulator" : "transactional fake"})`, () => {
  it("persists and reads back the per-slot record unchanged, and the disclosure derived from it is identical", async () => {
    const longStep = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ");
    const results: ModelResult[] = [
      { modelId: "chatgpt" as ModelId, status: "ok", rawText: answer({ reversibleNextStep: longStep }), latencyMs: 1 },
      { modelId: "claude" as ModelId, status: "substituted", rawText: answer(), latencyMs: 1, provider: "deepseek", requestedModel: "claude" } as ModelResult,
      { modelId: "gemini" as ModelId, status: "ok", rawText: "```json\n{ \"decisionQuestion\": \"cut off", latencyMs: 1 },
      { modelId: "grok" as ModelId, status: "timeout", rawText: null, latencyMs: 1 },
    ];
    const out: any = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "Which option?", undefined, classification);
    const written = out.persistedOutput;
    const meta = written.meta as CommonResponseMeta;
    expect(meta.structuredOutput).toEqual({
      version: 1,
      slots: [
        { modelId: "chatgpt", call: "completed", result: "partial", shortenedFields: ["reversibleNextStep"] },
        { modelId: "claude", call: "completed", result: "complete" },
        { modelId: "gemini", call: "completed", result: "unavailable" },
        { modelId: "grok", call: "failed", result: "unavailable" },
      ],
    });

    // The record never depends on ignoreUndefinedProperties: no undefined value anywhere inside it.
    const undefinedPaths: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (v === undefined) undefinedPaths.push(at);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(meta.structuredOutput, "structuredOutput");
    expect(undefinedPaths).toEqual([]);

    await seedRun();
    expect(await persistAdaptiveOutput(RUN_ID, written)).toEqual({ saved: true });

    const stored = (await readRun()).adaptiveOutput;
    const parsed = parsePersistedAdaptiveOutput(stored);
    expect(parsed.ok).toBe(true);
    const readMeta = (parsed as { ok: true; output: { meta: CommonResponseMeta } }).output.meta;
    expect(readMeta.structuredOutput).toEqual(meta.structuredOutput);
    expect(readStructuredOutputRecord(readMeta)).toEqual(meta.structuredOutput);
    expect(deriveStructuredOutputDisclosure(readMeta)).toEqual(deriveStructuredOutputDisclosure(meta));
    expect(deriveStructuredOutputDisclosure(readMeta)).toMatchObject({ selected: 4, completedCalls: 3, usable: 2, prominent: true });
  });
});
