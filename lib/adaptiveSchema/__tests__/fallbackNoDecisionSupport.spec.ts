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
 * So the proof is: for the business, medical and legal questions, the routed schema is generic, finalize returns NO
 * Milestone-2 envelope and NO decisionSupport result, and the persisted envelope is the plain generic one. The source
 * gate is pinned as well, so the proof cannot drift from runPanelExecution.ts.
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
const answer = (modelId: string) => ({ modelId, status: "ok", rawText: JSON.stringify({ summary: `${modelId} summary`, keyClaims: [], uncertainties: [], followUps: [] }), latencyMs: 1 });

describe.each([
  ["business decision", "Should our company expand into Kenya?", "professional"],
  ["medical", "Should I stop taking my insulin?", "high_stakes"],
  ["legal", "Is it legal to break my lease early?", "high_stakes"],
])("%s: %s", (_kind, question, riskLevel) => {
  it("routes to generic with the fallback marked, its risk level kept, and produces nothing Decision Support's workflow keys on", async () => {
    const plan = await planAdaptiveRun(`${question} [${_kind}]`, ["chatgpt", "claude"] as never, null);
    expect(plan.routing.kind).toBe("active");
    expect(plan.schema.id).toBe("generic");
    expect(plan.classification.queryType).toBe("generic");
    expect(plan.classification.fallbackReason).toBe("connector_error");
    expect(plan.classification.riskLevel).toBe(riskLevel);
    if (riskLevel === "high_stakes") expect(plan.classification.classificationSource).toBe("heuristic");

    const res: any = await finalizeAdaptiveRun(plan.schema, [answer("chatgpt"), answer("claude")] as never, question, undefined, plan.classification);
    expect(res.persistedOutput).toBeUndefined(); // no Milestone-2 envelope → no governance record, receipt or Team review
    expect(res.decisionSupport).toBeUndefined(); // no Decision Support result → no Decision Support export
    expect(res.persistedLegacyOutput?.schemaId).toBe("generic");
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
