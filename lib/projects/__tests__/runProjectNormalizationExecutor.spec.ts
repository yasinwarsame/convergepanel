/**
 * Phase 6D.3A — runProjectNormalizationExecutor() tests (fakes only, no
 * Firestore). Covers the zero-write preflight gate, fail-fast execution,
 * and the structural proof that this module never touches projectEvents
 * or accepts a real Project id.
 */

import { runProjectNormalizationExecution, type NormalizeOneRunFn } from "@/lib/projects/runProjectNormalizationExecutor";
import { computeCandidateFingerprint } from "@/lib/projects/candidateFingerprint";
import type { RawRunRecordForNormalization } from "@/lib/projects/runProjectNormalizationDryRun";

function run(overrides: Partial<RawRunRecordForNormalization>): RawRunRecordForNormalization {
  return {
    runId: "run-1",
    userId: "uid-1",
    hasWorkspaceIdField: true,
    workspaceIdValue: "personal-uid-1",
    hasProjectIdField: false,
    projectIdValue: undefined,
    ...overrides,
  };
}

const TWO_CANDIDATES = [run({ runId: "run-a" }), run({ runId: "run-b" })];
const TWO_CANDIDATE_FINGERPRINT = computeCandidateFingerprint(["run-a", "run-b"]);

function alwaysValid() {
  return async () => true;
}

describe("runProjectNormalizationExecution — preflight mode", () => {
  it("never calls normalizeOneRun, regardless of expected values supplied or omitted", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest.fn();
    const result = await runProjectNormalizationExecution({
      mode: "preflight",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: TWO_CANDIDATE_FINGERPRINT.candidateCount,
      expectedCandidateSha256: TWO_CANDIDATE_FINGERPRINT.candidateIdSha256,
    });
    expect(normalizeOneRun).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
    expect(result.observedCandidateCount).toBe(2);
    expect(result.observedCandidateSha256).toBe(TWO_CANDIDATE_FINGERPRINT.candidateIdSha256);
    expect(result.fingerprintMatches).toBe(true);
  });

  it("reports a mismatch without ever attempting a write", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest.fn();
    const result = await runProjectNormalizationExecution({
      mode: "preflight",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: 99,
      expectedCandidateSha256: "0".repeat(64),
    });
    expect(normalizeOneRun).not.toHaveBeenCalled();
    expect(result.fingerprintMatches).toBe(false);
    expect(result.countMatches).toBe(false);
    expect(result.hashMatches).toBe(false);
  });
});

describe("runProjectNormalizationExecution — execute mode, zero-write gate", () => {
  it("SECURITY: count mismatch aborts BEFORE any write attempt", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest.fn();
    const result = await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: 5, // wrong
      expectedCandidateSha256: TWO_CANDIDATE_FINGERPRINT.candidateIdSha256,
    });
    expect(normalizeOneRun).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("count_mismatch");
    expect(result.attempted).toEqual([]);
  });

  it("SECURITY: hash mismatch aborts BEFORE any write attempt, even with the correct count", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest.fn();
    const result = await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: TWO_CANDIDATE_FINGERPRINT.candidateCount,
      expectedCandidateSha256: "f".repeat(64), // wrong
    });
    expect(normalizeOneRun).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("hash_mismatch");
  });

  it("proceeds and writes every candidate when count and hash both match exactly", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest.fn().mockResolvedValue({ status: "normalized" });
    const result = await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: TWO_CANDIDATE_FINGERPRINT.candidateCount,
      expectedCandidateSha256: TWO_CANDIDATE_FINGERPRINT.candidateIdSha256,
    });
    expect(normalizeOneRun).toHaveBeenCalledTimes(2);
    expect(normalizeOneRun).toHaveBeenCalledWith("run-a");
    expect(normalizeOneRun).toHaveBeenCalledWith("run-b");
    expect(result.aborted).toBe(false);
    expect(result.succeeded.sort()).toEqual(["run-a", "run-b"]);
  });

  it("processes candidates in sorted order, matching the order the fingerprint was computed over", async () => {
    const callOrder: string[] = [];
    const normalizeOneRun: NormalizeOneRunFn = jest.fn(async (runId: string) => {
      callOrder.push(runId);
      return { status: "normalized" };
    });
    await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => [run({ runId: "run-z" }), run({ runId: "run-a" }), run({ runId: "run-m" })],
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: 3,
      expectedCandidateSha256: computeCandidateFingerprint(["run-a", "run-m", "run-z"]).candidateIdSha256,
    });
    expect(callOrder).toEqual(["run-a", "run-m", "run-z"]);
  });
});

describe("runProjectNormalizationExecution — fail-fast on divergence during execution", () => {
  it("stops immediately on the first non-normalized result, never attempts remaining candidates, never retries", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest
      .fn()
      .mockResolvedValueOnce({ status: "normalized" })
      .mockResolvedValueOnce({ status: "precondition_failed" });
    const result = await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: TWO_CANDIDATE_FINGERPRINT.candidateCount,
      expectedCandidateSha256: TWO_CANDIDATE_FINGERPRINT.candidateIdSha256,
    });
    expect(normalizeOneRun).toHaveBeenCalledTimes(2); // attempted both a and b (sorted order), stopped after b's failure — never a 3rd attempt/retry
    expect(result.aborted).toBe(true);
    expect(result.stoppedAtRunId).toBe("run-b");
    expect(result.stoppedReason).toBe("precondition_failed");
    expect(result.succeeded).toEqual(["run-a"]); // run-a's success is preserved even though run-b failed
  });

  it("a 'skipped_not_absent' divergence during execution is treated as a stop condition, not a benign continue", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest.fn().mockResolvedValue({ status: "skipped_not_absent" });
    const result = await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => [run({ runId: "run-a" })],
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: 1,
      expectedCandidateSha256: computeCandidateFingerprint(["run-a"]).candidateIdSha256,
    });
    expect(result.aborted).toBe(true);
    expect(result.stoppedReason).toBe("skipped_not_absent");
  });

  it("records full per-run detail (runId + result) for the operational artifact", async () => {
    const normalizeOneRun: NormalizeOneRunFn = jest
      .fn()
      .mockResolvedValueOnce({ status: "normalized" })
      .mockResolvedValueOnce({ status: "invalid_workspace_binding" });
    const result = await runProjectNormalizationExecution({
      mode: "execute",
      listRuns: async () => TWO_CANDIDATES,
      validateWorkspaceBinding: alwaysValid(),
      normalizeOneRun,
      expectedCandidateCount: TWO_CANDIDATE_FINGERPRINT.candidateCount,
      expectedCandidateSha256: TWO_CANDIDATE_FINGERPRINT.candidateIdSha256,
    });
    expect(result.perRun).toEqual([
      { runId: "run-a", result: "normalized" },
      { runId: "run-b", result: "invalid_workspace_binding" },
    ]);
  });
});

describe("STRUCTURAL: no projectEvents, no assignment capability", () => {
  function realCodeOnly(raw: string): string {
    // Doc comments legitimately name writeProjectEvent/projectEvents in
    // prose to explain what this module deliberately does NOT do —
    // strip comments before checking real code, matching the
    // established convention (see projectEvents.spec.ts).
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("this module never imports or calls writeProjectEvent in real code", () => {
    const fs = require("fs");
    const path = require("path");
    const raw = fs.readFileSync(path.resolve(__dirname, "../runProjectNormalizationExecutor.ts"), "utf8");
    const source = realCodeOnly(raw);
    expect(source).not.toMatch(/writeProjectEvent/);
    expect(source).not.toMatch(/projectEvents/);
  });

  it("this module's public surface never accepts a real Project id (assign/move) parameter in real code", () => {
    const fs = require("fs");
    const path = require("path");
    const raw = fs.readFileSync(path.resolve(__dirname, "../runProjectNormalizationExecutor.ts"), "utf8");
    const source = realCodeOnly(raw);
    expect(source).not.toMatch(/targetProjectId/);
    expect(source).not.toMatch(/assign/i);
    expect(source).not.toMatch(/\bmove\b/i);
  });
});
