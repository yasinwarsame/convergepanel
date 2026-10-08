/**
 * Step 6.3 — the read-only index probe: one count() per distinct shape, Firestore's
 * missing-index error captured verbatim, nothing created or retried.
 */
import { planDistinctShapes, probeGovernanceSummaryIndexes, PROBE_PLACEHOLDER_PROJECT_ID } from "@/lib/governance/workspaceGovernanceSummaryProbe";
import type { CountSpec } from "@/lib/governance/workspaceGovernanceSummary";

it("enumerates every distinct shape the summary issues, once each, including per-Project and batch shapes", async () => {
  const shapes = await planDistinctShapes("W", []);
  const specs = [...shapes.values()];
  expect(shapes.size).toBeGreaterThan(40);
  // With no Projects, the placeholder exercises the per-Project not-in and the in-batch shapes.
  expect(specs.some((s) => s.filters.some((f) => f.field === "projectId" && f.value === PROBE_PLACEHOLDER_PROJECT_ID))).toBe(true);
  expect(specs.some((s) => s.filters.some((f) => f.field === "projectId" && f.op === "in"))).toBe(true);
  expect(specs.some((s) => s.filters.some((f) => f.op === "not-in") && s.filters.some((f) => f.op === ">"))).toBe(true);
});

it("runs exactly one count per distinct shape and records missing-index errors verbatim, without retrying", async () => {
  const executed: CountSpec[] = [];
  const MESSAGE = "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/...";
  const exec = async (spec: CountSpec) => {
    executed.push(spec);
    if (spec.filters.some((f) => f.op === "not-in" || f.op === ">")) throw new Error(MESSAGE);
    return 3;
  };
  const results = await probeGovernanceSummaryIndexes(exec, "W", ["p1"]);
  expect(executed).toHaveLength(results.length);
  expect(new Set(results.map((r) => r.shape)).size).toBe(results.length);
  const failed = results.filter((r) => !r.ok);
  expect(failed.length).toBeGreaterThan(0);
  for (const r of failed) {
    if (r.ok) throw new Error("unreachable");
    expect(r.missingIndex).toBe(true);
    expect(r.message).toBe(MESSAGE);
  }
  expect(results.filter((r) => r.ok).every((r) => r.ok && r.count === 3)).toBe(true);
});

it("a non-index failure is recorded as such, not as a missing index", async () => {
  const results = await probeGovernanceSummaryIndexes(async () => {
    throw new Error("UNAVAILABLE: deadline");
  }, "W", []);
  expect(results.every((r) => !r.ok && !r.missingIndex)).toBe(true);
});
