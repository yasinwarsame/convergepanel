/**
 * ADAPTIVE_RETRY_CORRECTION — AR5 retry window + AR11 route duration.
 * Pure arithmetic on an injected monotonic clock: no sleeps.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import {
  ADAPTIVE_RETRY_DEFAULT_MIN_WINDOW_MS,
  ADAPTIVE_RETRY_HARD_TIMEOUT_MARGIN_MS,
  ADAPTIVE_RETRY_POST_RESERVE_MS,
  ADAPTIVE_RETRY_WRITE_MARGIN_MS,
  RESEARCH_REQUEST_BUDGET_MS,
  RESEARCH_ROUTE_MAX_DURATION_SECONDS,
  adaptiveRetryMinimumWindowMs,
  computeAdaptiveRetryWindow,
  startResearchRequestBudget,
} from "@/lib/adaptiveSchema/retryBudget";
import { MODEL_TIMEOUTS } from "@/lib/modelConfig";
import { BACKFILL_CALL_TIMEOUT_MS, CLUSTER_CALL_TIMEOUT_MS } from "@/lib/adaptiveSchema/alignment";
import { BIAS_CALL_TIMEOUT_MS } from "@/lib/adaptiveSchema/biasDetection";
import { COVERAGE_CALL_TIMEOUT_MS } from "@/lib/adaptiveSchema/coverageAudit";
import { SYNTHESIS_CALL_TIMEOUT_MS } from "@/lib/adaptiveSchema/synthesisReport";

const ROOT = join(__dirname, "..", "..", "..");
const budgetAt0 = { startedAtMonoMs: 0, budgetMs: RESEARCH_REQUEST_BUDGET_MS };

describe("constants", () => {
  it("request budget is derived from the single route duration constant (300 s)", () => {
    expect(RESEARCH_ROUTE_MAX_DURATION_SECONDS).toBe(300);
    expect(RESEARCH_REQUEST_BUDGET_MS).toBe(300_000);
  });

  it("the 76 s reserve = longest mutually exclusive post-retry LLM branch + 20 s write margin, recomputed from the real timeout constants", () => {
    // Claim-matrix path: cluster → backfill → bias → coverage → narrative → one regenerate.
    const claimPath =
      CLUSTER_CALL_TIMEOUT_MS + BACKFILL_CALL_TIMEOUT_MS + BIAS_CALL_TIMEOUT_MS + COVERAGE_CALL_TIMEOUT_MS + 2 * SYNTHESIS_CALL_TIMEOUT_MS;
    const deepResearchPath = COVERAGE_CALL_TIMEOUT_MS;
    const biasBlindspotPath = Math.max(BIAS_CALL_TIMEOUT_MS, COVERAGE_CALL_TIMEOUT_MS); // run in parallel
    const longest = Math.max(claimPath, deepResearchPath, biasBlindspotPath);
    expect(longest).toBe(56_000);
    expect(ADAPTIVE_RETRY_WRITE_MARGIN_MS).toBe(20_000);
    expect(ADAPTIVE_RETRY_POST_RESERVE_MS).toBe(longest + ADAPTIVE_RETRY_WRITE_MARGIN_MS);
    expect(ADAPTIVE_RETRY_POST_RESERVE_MS).toBe(76_000);
  });

  it("deterministic minimum windows: Perplexity 30 s, every other panel model 15 s", () => {
    expect(adaptiveRetryMinimumWindowMs("perplexity")).toBe(30_000);
    for (const modelId of ["chatgpt", "claude", "gemini", "grok"] as const) {
      expect(adaptiveRetryMinimumWindowMs(modelId)).toBe(ADAPTIVE_RETRY_DEFAULT_MIN_WINDOW_MS);
    }
    expect(ADAPTIVE_RETRY_DEFAULT_MIN_WINDOW_MS).toBe(15_000);
  });

  it("budget start uses the injected monotonic clock", () => {
    expect(startResearchRequestBudget(() => 1234.5)).toEqual({ startedAtMonoMs: 1234.5, budgetMs: 300_000 });
  });
});

describe("computeAdaptiveRetryWindow", () => {
  it("plenty of budget: guard = model hard timeout + 5 s (from the central model config)", () => {
    for (const modelId of ["chatgpt", "claude", "gemini", "grok", "perplexity"] as const) {
      const w = computeAdaptiveRetryWindow({ modelId, budget: budgetAt0, nowMonoMs: 10_000 });
      expect(w).toMatchObject({ kind: "run", guardMs: MODEL_TIMEOUTS[modelId].hardTimeoutMs + ADAPTIVE_RETRY_HARD_TIMEOUT_MARGIN_MS });
    }
    expect(computeAdaptiveRetryWindow({ modelId: "perplexity", budget: budgetAt0, nowMonoMs: 0 })).toMatchObject({ guardMs: 95_000 });
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget: budgetAt0, nowMonoMs: 0 })).toMatchObject({ guardMs: 65_000 });
  });

  it("later in the request: guard = remaining − 76 s reserve", () => {
    // 180 s elapsed → 120 s remaining → 44 s available (< 65 s cap).
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget: budgetAt0, nowMonoMs: 180_000 })).toMatchObject({
      kind: "run",
      guardMs: 44_000,
      remainingMs: 120_000,
    });
  });

  it("the guard plus the reserve never exceeds the remaining budget", () => {
    for (let elapsed = 0; elapsed <= 300_000; elapsed += 1_000) {
      const w = computeAdaptiveRetryWindow({ modelId: "perplexity", budget: budgetAt0, nowMonoMs: elapsed });
      if (w.kind === "run") expect(w.guardMs + ADAPTIVE_RETRY_POST_RESERVE_MS).toBeLessThanOrEqual(300_000 - elapsed);
    }
  });

  it("exact reserve boundary: no time left after the reserve is a skip", () => {
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget: budgetAt0, nowMonoMs: 300_000 - 76_000 })).toMatchObject({
      kind: "skip",
      availableMs: 0,
    });
  });

  it("exactly the minimum window runs; 1 ms below it skips (default 15 s)", () => {
    const atMin = 300_000 - 76_000 - 15_000;
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget: budgetAt0, nowMonoMs: atMin })).toMatchObject({ kind: "run", guardMs: 15_000 });
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget: budgetAt0, nowMonoMs: atMin + 1 })).toMatchObject({
      kind: "skip",
      availableMs: 14_999,
      minimumMs: 15_000,
    });
  });

  it("Perplexity minimum is 30 s: 29 999 ms available skips, 30 000 runs", () => {
    const atMin = 300_000 - 76_000 - 30_000;
    expect(computeAdaptiveRetryWindow({ modelId: "perplexity", budget: budgetAt0, nowMonoMs: atMin })).toMatchObject({ kind: "run", guardMs: 30_000 });
    expect(computeAdaptiveRetryWindow({ modelId: "perplexity", budget: budgetAt0, nowMonoMs: atMin + 1 })).toMatchObject({ kind: "skip", minimumMs: 30_000 });
    // The same 29 999 ms window is enough for a default-floor model.
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget: budgetAt0, nowMonoMs: atMin + 1 })).toMatchObject({ kind: "run" });
  });

  it("past the deadline is a skip (negative availability)", () => {
    expect(computeAdaptiveRetryWindow({ modelId: "gemini", budget: budgetAt0, nowMonoMs: 400_000 })).toMatchObject({ kind: "skip" });
  });

  it("measures elapsed time from the request start, not from zero", () => {
    const budget = { startedAtMonoMs: 5_000_000, budgetMs: 300_000 };
    expect(computeAdaptiveRetryWindow({ modelId: "claude", budget, nowMonoMs: 5_180_000 })).toMatchObject({ kind: "run", guardMs: 44_000 });
  });
});

describe("AR11 — explicit 300 s route duration on exactly the research execution routes", () => {
  const RESEARCH_ROUTES = ["app/api/run-panel/route.ts", "app/api/workspaces/[workspaceId]/runs/route.ts"];

  function listRouteFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        out.push(...listRouteFiles(full));
      } else if (entry === "route.ts") {
        out.push(relative(ROOT, full));
      }
    }
    return out;
  }

  it.each(RESEARCH_ROUTES)("%s exports maxDuration = RESEARCH_ROUTE_MAX_DURATION_SECONDS and captures the budget first", (route) => {
    const source = readFileSync(join(ROOT, route), "utf8");
    const match = source.match(/^export const maxDuration = (\d+);$/m);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(RESEARCH_ROUTE_MAX_DURATION_SECONDS);
    // First statement inside POST is the budget capture.
    const postBody = source.slice(source.indexOf("export async function POST("));
    const firstStatement = postBody
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    expect(firstStatement).toBe("const requestBudget = startResearchRequestBudget();");
    expect(source).toMatch(/executeOrdinaryRun\(\{[\s\S]*?requestBudget,[\s\S]*?\}\);/);
  });

  it("these are the only callers of executeOrdinaryRun", () => {
    const callers = listRouteFiles(join(ROOT, "app")).filter((f) => readFileSync(join(ROOT, f), "utf8").includes("executeOrdinaryRun("));
    expect(callers.sort()).toEqual([...RESEARCH_ROUTES].sort());
  });

  it("no other route gained a maxDuration (the pre-existing set is unchanged)", () => {
    const withMaxDuration = listRouteFiles(join(ROOT, "app")).filter((f) => /^export const maxDuration\b/m.test(readFileSync(join(ROOT, f), "utf8")));
    expect(withMaxDuration.sort()).toEqual(
      [
        ...RESEARCH_ROUTES,
        // Pre-existing before ADAPTIVE_RETRY_CORRECTION (unchanged):
        "app/api/synthesize-panel/route.ts",
        "app/api/verify-video/route.ts",
        "app/api/workspaces/[workspaceId]/video-verifications/route.ts",
      ].sort()
    );
  });
});
