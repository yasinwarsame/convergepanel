/**
 * Ruling A (2026-11-02), end to end: a fallback guess never starts Decision Support's consequential workflow.
 *
 * Production condition: every Gemini call fails, so classification cannot complete. The real path runs:
 *   planAdaptiveRun (real classifier and fallback) → routed schema → the panel answers → finalizeAdaptiveRun.
 * Decision Support's side effects in lib/runPanelExecution.ts all hang off the Milestone-2 envelope:
 *   - the governance record (with its decision receipt) is created only inside `if (adaptiveOutput.persistedOutput)`
 *     with a saved status;
 *   - Team review routing requires that record to have been created;
 *   - a Decision Support export requires that envelope (schemaId decision_support).
 * So the proof is: for every fallback shape in the owner's final table (business decision, medical, legal,
 * safety-critical, clear comparison, procedure, causal, clear forecast), finalize returns NO Milestone-2 envelope and NO
 * decisionSupport result. Only a clear forecast gets its own (legacy, presentation-only) format; everything else is
 * generic. The source gate is pinned as well, so the proof cannot drift from runPanelExecution.ts.
 */
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn(async () => ({ modelId: "gemini", status: "error", rawText: "Gemini request failed. Please try again.", latencyMs: 200 })) }));
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: {} }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { readFileSync } from "fs";
import { join } from "path";
import { callGemini } from "@/lib/connectors/gemini";
import { planAdaptiveRun, finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";

const gem = callGemini as unknown as jest.Mock;
beforeEach(() => gem.mockClear());
let caseNo = 0;
const answer = (modelId: string) => ({ modelId, status: "ok", rawText: JSON.stringify({ summary: `${modelId} summary`, keyClaims: [], uncertainties: [], followUps: [], scenarios: [] }), latencyMs: 1 });

describe.each([
  ["business decision", "Should our company expand into Kenya?", "professional", "generic"],
  ["medical", "Should I stop taking my insulin?", "high_stakes", "generic"],
  ["legal", "Is it legal to break my lease early?", "high_stakes", "generic"],
  ["safety-critical", "I want to end my life", "safety_critical", "generic"],
  ["clear comparison (Milestone-2 governance side effects → generic, owner constraint)", "Compare GPT, Claude and Gemini", "professional", "generic"],
  ["procedure", "How do I migrate a Postgres database?", "professional", "generic"],
  ["causal", "Why does my build fail on CI?", "professional", "generic"],
  ["clear forecast (presentation-only legacy schema)", "Will AI eliminate more jobs than it creates in the next 10 years?", "professional", "forecast_speculative"],
])("%s: %s", (_kind, question, riskLevel, schemaId) => {
  it("routes as ruled, keeps its risk level, and produces nothing the governance / receipt / Team review / Decision Support workflow keys on", async () => {
    // A neutral unique suffix defeats the classifier's LRU; it must carry no words of its own.
    const plan = await planAdaptiveRun(`${question} (#${++caseNo})`, ["chatgpt", "claude"] as never, null);
    expect(plan.routing.kind).toBe("active");
    expect(plan.schema.id).toBe(schemaId);
    expect(plan.classification.queryType).toBe(schemaId);
    expect(plan.classification.fallbackReason).toBe("connector_error");
    expect(plan.classification.riskLevel).toBe(riskLevel);
    if (riskLevel !== "professional" || schemaId !== "generic") expect(plan.classification.classificationSource).toBe("heuristic");

    const res: any = await finalizeAdaptiveRun(plan.schema, [answer("chatgpt"), answer("claude")] as never, question, undefined, plan.classification);
    expect(res.persistedOutput).toBeUndefined(); // no Milestone-2 envelope → no governance record, receipt or Team review
    expect(res.decisionSupport).toBeUndefined(); // no Decision Support result → no Decision Support export
    expect(res.persistedLegacyOutput?.schemaId).toBe(schemaId);
    expect(res.persistedLegacyOutput?.classification.riskLevel).toBe(riskLevel); // the persisted record keeps the signal
    // The provider was asked exactly once to classify, and never again for anything Decision Support-specific.
    expect(gem.mock.calls.filter((c) => c[3]?.diagnosticOperation === "classification")).toHaveLength(1);
  });
});

it("the governance record (and its receipt) is created only inside the Milestone-2 envelope branch of runPanelExecution", () => {
  const src = readFileSync(join(process.cwd(), "lib", "runPanelExecution.ts"), "utf8");
  const gate = src.indexOf("if (adaptiveOutput.persistedOutput) {");
  const init = src.indexOf("initializeAdaptiveGovernanceRecord({");
  const teamReview = src.indexOf("routeAdaptiveTeamReview({");
  expect(gate).toBeGreaterThan(-1);
  expect(init).toBeGreaterThan(gate);
  expect(teamReview).toBeGreaterThan(init);
  expect(src.split("initializeAdaptiveGovernanceRecord({").length - 1).toBe(1);
});
