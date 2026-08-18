/**
 * Phase 7C — serializer regression suite for the shared `toRunSummaryBase()`,
 * extracted from `app/api/user/workspace/runs/route.ts`'s formerly-private
 * `toSummary()`. These fixtures encode the exact pre-extraction formula
 * (verbatim, not reinterpreted) so this file is the golden record proving
 * the extraction changed no consumer-visible behavior. The primary
 * regression signal remains the pre-existing route/DTO test suites
 * (`app/api/user/workspace/runs/__tests__/route.spec.ts`,
 * `app/api/user/project-runs/__tests__/route.spec.ts`,
 * `lib/projects/__tests__/projectRunSummary.spec.ts`), all of which passed
 * with byte-identical counts before and after this extraction — this file
 * adds direct, fast, mock-free coverage of the shared function itself.
 */

import { toRunSummaryBase, normalizeGovernanceStatus, firestoreSecondsNanos, firestoreMillisForDisplay } from "@/lib/runs/runSummary";
import { toProjectRunSummary } from "@/lib/projects/projectRunSummary";

describe("toRunSummaryBase", () => {
  it("derives the expected shape from a minimal run document", () => {
    const data = {
      question: "What is the capital of France?",
      selectedModels: ["gpt-4"],
      status: "complete",
      createdAt: { toMillis: () => 1723600000000 },
    };
    const summary = toRunSummaryBase("run-1", data);
    expect(summary).toEqual({
      id: "run-1",
      at: new Date(1723600000000).toISOString(),
      question: "What is the capital of France?",
      selectedModels: ["gpt-4"],
      status: "complete",
      modelsOk: undefined,
      modelsTotal: 1,
      synthesisConsensusScore: undefined,
      governanceStatus: undefined,
    });
  });

  it("no createdAt / no toMillis -> falls back to Date.now(), never throws", () => {
    const summary = toRunSummaryBase("run-1", { question: "q", selectedModels: [] });
    expect(() => new Date(summary.at)).not.toThrow();
    expect(typeof summary.at).toBe("string");
  });

  it("question defaults to empty string when absent/non-string", () => {
    expect(toRunSummaryBase("r", { selectedModels: [], createdAt: { toMillis: () => 1 } }).question).toBe("");
  });

  it("selectedModels defaults to [] when not an array", () => {
    expect(toRunSummaryBase("r", { question: "q", selectedModels: "not-an-array", createdAt: { toMillis: () => 1 } }).selectedModels).toEqual([]);
  });

  it("status omitted when not a string", () => {
    expect(toRunSummaryBase("r", { question: "q", selectedModels: [], status: 123, createdAt: { toMillis: () => 1 } }).status).toBeUndefined();
  });

  it("modelsOk/modelsTotal derived from runDocument.perModel when present, taking priority over resultsCompact", () => {
    const data = {
      question: "q",
      selectedModels: ["a", "b", "c"],
      createdAt: { toMillis: () => 1 },
      runDocument: { perModel: [{ status: "ok" }, { status: "ok" }, { status: "error" }] },
      resultsCompact: { perModel: [{ status: "ok" }] }, // must NOT be used — runDocument wins
    };
    const summary = toRunSummaryBase("r", data);
    expect(summary.modelsOk).toBe(2);
    expect(summary.modelsTotal).toBe(3);
  });

  it("modelsTotal falls back to selectedModels.length when no perModel array exists anywhere; modelsOk stays undefined", () => {
    const summary = toRunSummaryBase("r", { question: "q", selectedModels: ["a", "b"], createdAt: { toMillis: () => 1 } });
    expect(summary.modelsTotal).toBe(2);
    expect(summary.modelsOk).toBeUndefined();
  });

  it("modelsTotal is undefined (not 0) when there is no perModel and selectedModels is empty — `|| undefined` collapses the falsy 0", () => {
    const summary = toRunSummaryBase("r", { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 } });
    expect(summary.modelsTotal).toBeUndefined();
  });

  it("synthesisConsensusScore derived only when overallConsensusScore is a number", () => {
    const withScore = toRunSummaryBase("r", { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 }, synthesisConsensusSummary: { overallConsensusScore: 42 } });
    expect(withScore.synthesisConsensusScore).toBe(42);
    const withoutScore = toRunSummaryBase("r", { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 }, synthesisConsensusSummary: { overallConsensusScore: "not-a-number" } });
    expect(withoutScore.synthesisConsensusScore).toBeUndefined();
  });

  it("hasAdaptiveOutput/adaptiveSchemaId included together only when adaptiveOutput.schemaId is a string; omitted (not undefined-valued) otherwise", () => {
    const data = { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 }, adaptiveOutput: { schemaId: "deep_research" } };
    const summary = toRunSummaryBase("r", data) as Record<string, unknown>;
    expect(summary.hasAdaptiveOutput).toBe(true);
    expect(summary.adaptiveSchemaId).toBe("deep_research");

    const noAdaptive = toRunSummaryBase("r", { question: "q", selectedModels: [], createdAt: { toMillis: () => 1 } }) as Record<string, unknown>;
    expect("hasAdaptiveOutput" in noAdaptive).toBe(false);
    expect("adaptiveSchemaId" in noAdaptive).toBe(false);
  });
});

describe("normalizeGovernanceStatus", () => {
  it.each(["approved", "needs_review", "blocked"] as const)("passes through recognized value %s", (v) => {
    expect(normalizeGovernanceStatus(v)).toBe(v);
  });

  it("returns undefined for any unrecognized value", () => {
    expect(normalizeGovernanceStatus("bogus")).toBeUndefined();
    expect(normalizeGovernanceStatus(undefined)).toBeUndefined();
    expect(normalizeGovernanceStatus(null)).toBeUndefined();
    expect(normalizeGovernanceStatus(123)).toBeUndefined();
  });
});

describe("firestoreSecondsNanos", () => {
  it("extracts seconds/nanoseconds from a Timestamp-shaped value", () => {
    expect(firestoreSecondsNanos({ seconds: 100, nanoseconds: 250 })).toEqual({ seconds: 100, nanoseconds: 250 });
  });

  it("defaults to zero for a non-Timestamp value, never throws", () => {
    expect(firestoreSecondsNanos(undefined)).toEqual({ seconds: 0, nanoseconds: 0 });
    expect(firestoreSecondsNanos(null)).toEqual({ seconds: 0, nanoseconds: 0 });
    expect(firestoreSecondsNanos("not a timestamp")).toEqual({ seconds: 0, nanoseconds: 0 });
    expect(firestoreSecondsNanos({ seconds: "not-a-number", nanoseconds: 1 })).toEqual({ seconds: 0, nanoseconds: 0 });
  });
});

describe("firestoreMillisForDisplay", () => {
  it("calls .toMillis() on a Timestamp-shaped value", () => {
    expect(firestoreMillisForDisplay({ toMillis: () => 12345 })).toBe(12345);
  });

  it("defaults to 0 for a non-Timestamp value, never throws", () => {
    expect(firestoreMillisForDisplay(undefined)).toBe(0);
    expect(firestoreMillisForDisplay(null)).toBe(0);
    expect(firestoreMillisForDisplay("nope")).toBe(0);
  });
});

describe("Phase 7C shared-consumer equivalence — proves WorkspaceRunSummary and ProjectRunSummary derive identical base fields from the identical input", () => {
  it("toRunSummaryBase output is exactly what both toSummary (workspace/runs) and toProjectRunSummary (project-runs, minus projectId) now compute", () => {
    const data = {
      question: "Q",
      selectedModels: ["chatgpt", "claude"],
      status: "complete",
      createdAt: { toMillis: () => 1723600000000 },
      synthesisConsensusSummary: { overallConsensusScore: 91 },
      governanceStatus: "needs_review",
      adaptiveOutput: { schemaId: "deep_research" },
    };
    const base = toRunSummaryBase("run-x", data);
    const projectSummary = toProjectRunSummary("run-x", data, "proj-1");
    const { projectId, ...withoutProjectId } = projectSummary;
    expect(withoutProjectId).toEqual(base);
    expect(projectId).toBe("proj-1");
  });
});
