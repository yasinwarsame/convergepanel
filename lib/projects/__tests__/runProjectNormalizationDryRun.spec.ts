/**
 * Phase 6D.1 — dry-run orchestrator tests (fakes only, no Firestore) plus
 * the structural proof that no file in this feature area contains a
 * Firestore write primitive.
 */

import { runProjectNormalizationDryRun, type RawRunRecordForNormalization } from "@/lib/projects/runProjectNormalizationDryRun";

function run(overrides: Partial<RawRunRecordForNormalization>): RawRunRecordForNormalization {
  return {
    runId: "run-1",
    userId: "uid-1",
    hasWorkspaceIdField: false,
    workspaceIdValue: undefined,
    hasProjectIdField: false,
    projectIdValue: undefined,
    ...overrides,
  };
}

describe("runProjectNormalizationDryRun", () => {
  it("legacy run is excluded, never eligible", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [run({ runId: "run-legacy" })],
      validateWorkspaceBinding: async () => true,
    });
    expect(result.counts.legacy).toBe(1);
    expect(result.counts.would_normalize).toBe(0);
    expect(result.wouldNormalizeRunIds).toEqual([]);
  });

  it("SECURITY: bound-invalid run is never eligible even with projectId absent", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [run({ runId: "run-invalid", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1" })],
      validateWorkspaceBinding: async () => false,
    });
    expect(result.counts.bound_invalid).toBe(1);
    expect(result.counts.would_normalize).toBe(0);
  });

  it("valid + projectId absent -> eligible (would_normalize), run id captured", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [run({ runId: "run-eligible", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1" })],
      validateWorkspaceBinding: async () => true,
    });
    expect(result.counts.would_normalize).toBe(1);
    expect(result.wouldNormalizeRunIds).toEqual(["run-eligible"]);
    expect(result.wouldNormalizeByUser).toEqual({ "uid-1": 1 });
  });

  it("valid + projectId already null -> skipped, not counted as eligible", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [
        run({ runId: "run-null", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1", hasProjectIdField: true, projectIdValue: null }),
      ],
      validateWorkspaceBinding: async () => true,
    });
    expect(result.counts.already_null).toBe(1);
    expect(result.counts.would_normalize).toBe(0);
  });

  it("valid + projectId already assigned -> skipped, never touched", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [
        run({ runId: "run-assigned", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1", hasProjectIdField: true, projectIdValue: "proj-1" }),
      ],
      validateWorkspaceBinding: async () => true,
    });
    expect(result.counts.already_assigned).toBe(1);
    expect(result.counts.would_normalize).toBe(0);
  });

  it("malformed projectId is flagged as a blocker, run id captured, never eligible", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [
        run({ runId: "run-malformed", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1", hasProjectIdField: true, projectIdValue: 999 }),
      ],
      validateWorkspaceBinding: async () => true,
    });
    expect(result.counts.malformed_blocker).toBe(1);
    expect(result.malformedBlockerRunIds).toEqual(["run-malformed"]);
    expect(result.counts.would_normalize).toBe(0);
  });

  it("a Workspace-validation failure fails closed regardless of a clean projectId field", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [run({ runId: "run-x", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1" })],
      validateWorkspaceBinding: async () => false,
    });
    expect(result.counts.bound_invalid).toBe(1);
    expect(result.counts.would_normalize).toBe(0);
  });

  it("aggregates a realistic mixed population correctly, totals sum to scanned count", async () => {
    const result = await runProjectNormalizationDryRun({
      listRuns: async () => [
        run({ runId: "legacy-1" }),
        run({ runId: "legacy-2" }),
        run({ runId: "invalid-1", hasWorkspaceIdField: true, workspaceIdValue: "personal-bad" }),
        run({ runId: "eligible-1", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1" }),
        run({ runId: "eligible-2", userId: "uid-2", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-2" }),
        run({ runId: "null-1", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1", hasProjectIdField: true, projectIdValue: null }),
        run({ runId: "assigned-1", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1", hasProjectIdField: true, projectIdValue: "proj-x" }),
        run({ runId: "malformed-1", hasWorkspaceIdField: true, workspaceIdValue: "personal-uid-1", hasProjectIdField: true, projectIdValue: 1 }),
      ],
      validateWorkspaceBinding: async (userId, workspaceId) => workspaceId !== "personal-bad",
    });
    expect(result.totalScanned).toBe(8);
    expect(result.counts.legacy).toBe(2);
    expect(result.counts.bound_invalid).toBe(1);
    expect(result.counts.would_normalize).toBe(2);
    expect(result.counts.already_null).toBe(1);
    expect(result.counts.already_assigned).toBe(1);
    expect(result.counts.malformed_blocker).toBe(1);
    expect(result.wouldNormalizeByUser).toEqual({ "uid-1": 1, "uid-2": 1 });
    const sum = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.totalScanned);
  });

  it("never loads or prints run question/answer/synthesis content — listRuns contract only carries id/userId/workspaceId/projectId fields", async () => {
    let capturedKeys: string[] = [];
    await runProjectNormalizationDryRun({
      listRuns: async () => {
        const record = run({ runId: "run-1" });
        capturedKeys = Object.keys(record);
        return [record];
      },
      validateWorkspaceBinding: async () => true,
    });
    expect(capturedKeys.sort()).toEqual(["hasProjectIdField", "hasWorkspaceIdField", "projectIdValue", "runId", "userId", "workspaceIdValue"].sort());
  });
});

describe("STRUCTURAL: no Firestore write primitive anywhere in the Phase 6D.1 normalization feature area", () => {
  const files = [
    "lib/projects/runProjectNormalizationEligibility.ts",
    "lib/projects/runProjectNormalizationDryRun.ts",
    "lib/projects/validateRunWorkspaceBinding.ts",
    "scripts/projects/dry-run-project-normalization.ts",
  ];

  function realCodeOnly(raw: string): string {
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  /** Scopes the write-verb check to lines that actually touch Firestore (adminDb/.collection(/.doc(), so an unrelated in-memory `Map.set()`-style call (e.g. a local cache) can never produce a false positive here. */
  function firestoreTouchingLines(source: string): string[] {
    return source.split("\n").filter((line) => /adminDb|\.collection\(|\.doc\(/.test(line));
  }

  it.each(files)("%s contains no Firestore write primitive (.set(, .update(, .create(, .delete(, BulkWriter, runTransaction, batch()) on any Firestore-touching line, and no --execute flag anywhere", (relativePath) => {
    const fs = require("fs");
    const path = require("path");
    const fullPath = path.resolve(__dirname, "../../../", relativePath);
    const raw = fs.readFileSync(fullPath, "utf8");
    const source = realCodeOnly(raw);
    const firestoreLines = firestoreTouchingLines(source).join("\n");
    expect(firestoreLines).not.toMatch(/\.set\(/);
    expect(firestoreLines).not.toMatch(/\.update\(/);
    expect(firestoreLines).not.toMatch(/\.create\(/);
    expect(firestoreLines).not.toMatch(/\.delete\(/);
    expect(source).not.toMatch(/BulkWriter/);
    expect(source).not.toMatch(/runTransaction/);
    expect(source).not.toMatch(/\.batch\(\)/);
    expect(source).not.toMatch(/--execute/);
    expect(source).not.toMatch(/lastUpdateTime/); // no precondition-guarded write attempt either
  });
});
