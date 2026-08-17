/**
 * Phase 6D.3A — checkNormalizationExecutionGuard() /
 * parseNormalizationExecutionCliArgs() tests.
 */

import { checkNormalizationExecutionGuard, parseNormalizationExecutionCliArgs } from "@/lib/projects/normalizationExecutionSafety";

const VALID_HASH = "a".repeat(64);
const ACTUAL_PROJECT = "convergepanel";

describe("checkNormalizationExecutionGuard", () => {
  it("all valid -> ok, parsed count returned as a number", () => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: "9",
      expectedCandidateSha256: VALID_HASH,
      confirmedProjectId: ACTUAL_PROJECT,
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result).toEqual({ ok: true, expectedCandidateCount: 9, expectedCandidateSha256: VALID_HASH });
  });

  it("missing --confirm-project -> rejected before any count/hash check", () => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: "9",
      expectedCandidateSha256: VALID_HASH,
      confirmedProjectId: undefined,
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result).toEqual({ ok: false, reason: "project_confirmation_missing", message: expect.any(String) });
  });

  it("wrong --confirm-project value -> rejected", () => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: "9",
      expectedCandidateSha256: VALID_HASH,
      confirmedProjectId: "some-other-project",
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result).toEqual({ ok: false, reason: "project_confirmation_mismatch", message: expect.any(String) });
  });

  it("missing --expected-candidates -> rejected", () => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: undefined,
      expectedCandidateSha256: VALID_HASH,
      confirmedProjectId: ACTUAL_PROJECT,
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result).toEqual({ ok: false, reason: "expected_count_missing", message: expect.any(String) });
  });

  it.each(["abc", "-1", "3.5", "", "  ", "9 "])("malformed --expected-candidates=%p -> rejected", (raw) => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: raw,
      expectedCandidateSha256: VALID_HASH,
      confirmedProjectId: ACTUAL_PROJECT,
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expected_count_malformed");
  });

  it("zero is a valid expected count (a fully-normalized population is a legitimate target)", () => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: "0",
      expectedCandidateSha256: VALID_HASH,
      confirmedProjectId: ACTUAL_PROJECT,
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result).toEqual({ ok: true, expectedCandidateCount: 0, expectedCandidateSha256: VALID_HASH });
  });

  it("missing --expected-candidate-sha256 -> rejected", () => {
    const result = checkNormalizationExecutionGuard({
      expectedCandidateCountRaw: "9",
      expectedCandidateSha256: undefined,
      confirmedProjectId: ACTUAL_PROJECT,
      actualProjectId: ACTUAL_PROJECT,
    });
    expect(result).toEqual({ ok: false, reason: "expected_hash_missing", message: expect.any(String) });
  });

  it.each(["short", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)])(
    "malformed --expected-candidate-sha256=%p -> rejected",
    (hash) => {
      const result = checkNormalizationExecutionGuard({
        expectedCandidateCountRaw: "9",
        expectedCandidateSha256: hash,
        confirmedProjectId: ACTUAL_PROJECT,
        actualProjectId: ACTUAL_PROJECT,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expected_hash_malformed");
    }
  );
});

describe("parseNormalizationExecutionCliArgs", () => {
  it("no args -> execute: false, everything else undefined", () => {
    expect(parseNormalizationExecutionCliArgs([])).toEqual({
      execute: false,
      expectedCandidateCountRaw: undefined,
      expectedCandidateSha256: undefined,
      confirmProjectId: undefined,
      outputPath: undefined,
    });
  });

  it("--execute alone sets execute:true but nothing else", () => {
    const result = parseNormalizationExecutionCliArgs(["--execute"]);
    expect(result.execute).toBe(true);
    expect(result.expectedCandidateCountRaw).toBeUndefined();
  });

  it("SECURITY: a misspelled flag never accidentally sets execute:true", () => {
    const result = parseNormalizationExecutionCliArgs(["--Execute", "--EXECUTE", "-execute", "execute"]);
    expect(result.execute).toBe(false);
  });

  it("parses all flags together", () => {
    const result = parseNormalizationExecutionCliArgs([
      "--execute",
      "--expected-candidates=9",
      `--expected-candidate-sha256=${VALID_HASH}`,
      "--confirm-project=convergepanel",
      "--output=/tmp/report.json",
    ]);
    expect(result).toEqual({
      execute: true,
      expectedCandidateCountRaw: "9",
      expectedCandidateSha256: VALID_HASH,
      confirmProjectId: "convergepanel",
      outputPath: "/tmp/report.json",
    });
  });
});
