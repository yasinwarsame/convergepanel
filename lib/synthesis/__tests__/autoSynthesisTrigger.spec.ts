/**
 * TEAM-RESEARCH-PARITY-R2 §L/§M — `shouldAutoTriggerSynthesis()`: the one
 * decision behind ResultsDisplay's automatic `POST /api/synthesize-panel`.
 */
import { shouldAutoTriggerSynthesis, type AutoSynthesisTriggerInput } from "@/lib/synthesis/autoSynthesisTrigger";

/** The live-composer happy path: every pre-existing condition satisfied, policy allowed. */
const LIVE: AutoSynthesisTriggerInput = {
  okResultCount: 2,
  runId: "run-1",
  alreadyTriggered: false,
  synthesisStatus: "idle",
  hasPreGeneratedReport: false,
  hasAdaptive: false,
  allowSynthesisGeneration: true,
};

describe("shouldAutoTriggerSynthesis", () => {
  it("live composer conditions → true (the established automatic synthesis behaviour)", () => {
    expect(shouldAutoTriggerSynthesis(LIVE)).toBe(true);
    expect(shouldAutoTriggerSynthesis({ ...LIVE, okResultCount: 5 })).toBe(true);
  });

  it("allowSynthesisGeneration=false → false even when EVERY other condition would trigger", () => {
    expect(shouldAutoTriggerSynthesis({ ...LIVE, allowSynthesisGeneration: false })).toBe(false);
  });

  it.each<[string, Partial<AutoSynthesisTriggerInput>]>([
    ["fewer than two successful rows", { okResultCount: 1 }],
    ["zero rows", { okResultCount: 0 }],
    ["no runId", { runId: null }],
    ["empty runId", { runId: "" }],
    ["already triggered for this runId", { alreadyTriggered: true }],
    ["synthesis loading", { synthesisStatus: "loading" }],
    ["synthesis complete", { synthesisStatus: "complete" }],
    ["synthesis error", { synthesisStatus: "error" }],
    ["a pre-generated (persisted) report exists", { hasPreGeneratedReport: true }],
    ["an adaptive result exists", { hasAdaptive: true }],
  ])("pre-existing condition — %s → false", (_name, override) => {
    expect(shouldAutoTriggerSynthesis({ ...LIVE, ...override })).toBe(false);
  });

  it("the policy is independent of the other conditions: false wins in every combination", () => {
    const statuses: AutoSynthesisTriggerInput["synthesisStatus"][] = ["idle", "loading", "complete", "error"];
    for (const okResultCount of [0, 1, 2, 3]) {
      for (const synthesisStatus of statuses) {
        for (const hasPreGeneratedReport of [false, true]) {
          for (const hasAdaptive of [false, true]) {
            expect(shouldAutoTriggerSynthesis({ ...LIVE, okResultCount, synthesisStatus, hasPreGeneratedReport, hasAdaptive, allowSynthesisGeneration: false })).toBe(false);
          }
        }
      }
    }
  });
});
