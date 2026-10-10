/**
 * Order 3 — the read-only index probe: enumerates every distinct shape from
 * the REAL planner, runs one representative each, records missing-index
 * rejections with Firestore's own message, aborts on anything else, and has
 * no capability beyond a count executor.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { planDistinctReviewIntegrityShapes, probeReviewIntegrityMetricsIndexes, REVIEW_INTEGRITY_PROBE_PLACEHOLDER_PROJECT_ID } from "@/lib/governance/reviewIntegrityMetricsProbe";
import { F_DECIDED_VIA } from "@/lib/governance/reviewIntegrityMetrics";
import type { CountSpec } from "@/lib/governance/workspaceGovernanceSummary";

const W = "__review_integrity_probe_ws__";

it("enumerates exactly the distinct index shapes: 9 — 7 identical to Step 6.3's adaptive human-axis shapes, 2 new decision-path shapes", async () => {
  const shapes = await planDistinctReviewIntegrityShapes(W, []);
  expect([...shapes.keys()].sort()).toEqual(
    [
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete"',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ projectId == null',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ projectId in [Project batch]',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status == <status> ∧ projectId == null',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status == <status> ∧ projectId in [Project batch]',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status not-in ["unreviewed","pending","approved","approved_with_conditions","changes_requested","rejected"] ∧ projectId == null',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status not-in ["unreviewed","pending","approved","approved_with_conditions","changes_requested","rejected"] ∧ projectId == <Project>',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status == <status> ∧ governanceRecord.humanReview.decidedVia == "<path>" ∧ projectId == null',
      'runs: workspaceId == W ∧ adaptiveOutput.version == 1 ∧ status == "complete" ∧ governanceRecord.humanReview.status == <status> ∧ governanceRecord.humanReview.decidedVia == "<path>" ∧ projectId in [Project batch]',
    ].sort()
  );
  // The placeholder Project lets the per-Project shapes be planned in an empty Workspace.
  const specs = [...shapes.values()];
  expect(specs.some((s) => s.filters.some((f) => f.field === "projectId" && JSON.stringify(f.value).includes(REVIEW_INTEGRITY_PROBE_PLACEHOLDER_PROJECT_ID)))).toBe(true);
  // The representative path spec is a real path value, not the abstraction.
  const pathSpec = specs.find((s) => s.filters.some((f) => f.field === F_DECIDED_VIA))!;
  expect(pathSpec.filters.find((f) => f.field === F_DECIDED_VIA)!.value).toBe("single_reviewer");
});

it("records a missing-index rejection with Firestore's message and continues; classifies an invalid shape; aborts on anything else", async () => {
  const seen: CountSpec[] = [];
  const run = await probeReviewIntegrityMetricsIndexes(
    async (spec) => {
      seen.push(spec);
      if (spec.filters.some((f) => f.field === F_DECIDED_VIA)) throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/...create_composite=X"), { code: 9 });
      return 0;
    },
    W,
    []
  );
  expect(run.aborted).toBeNull();
  expect(run.results).toHaveLength(9);
  const failed = run.results.filter((r) => !r.ok);
  expect(failed).toHaveLength(2);
  for (const f of failed) if (!f.ok) expect(f.kind).toBe("missing_index");
  expect(seen).toHaveLength(9);

  const aborted = await probeReviewIntegrityMetricsIndexes(async () => {
    throw Object.assign(new Error("7 PERMISSION_DENIED"), { code: 7 });
  }, W, []);
  expect(aborted.aborted?.code).toBe(7);
  expect(aborted.results).toHaveLength(0);
});

it("the probe and the adapter are read-only by construction: no write, delete, batch, transaction or index call in their source", () => {
  for (const file of ["reviewIntegrityMetricsProbe.ts", "reviewIntegrityMetricsFirestore.ts", "reviewIntegrityMetrics.ts"]) {
    const raw = readFileSync(join(__dirname, "..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The probe's only `.set(` is on its own in-memory shape Map; nothing else may resemble a write.
    const src = raw.replace(/\bshapes\.set\(/g, "");
    for (const forbidden of [".set(", ".add(", ".update(", ".delete(", ".create(", "batch(", "runTransaction", "createIndex", "indexes", "bulkWriter", ".get()"]) {
      expect({ file, forbidden, present: src.includes(forbidden) }).toEqual({ file, forbidden, present: false });
    }
  }
});

it("the probe imports only pure planning modules — no Firestore SDK or adapter", () => {
  const src = readFileSync(join(__dirname, "..", "reviewIntegrityMetricsProbe.ts"), "utf8");
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();
  expect(imports).toEqual(["./reviewIntegrityMetrics", "./workspaceGovernanceSummary", "./workspaceGovernanceSummaryProbe"]);
});
