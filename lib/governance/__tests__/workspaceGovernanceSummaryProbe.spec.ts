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
    if (spec.filters.some((f) => f.op === "not-in" || f.op === ">")) throw Object.assign(new Error(MESSAGE), { code: 9 });
    return 3;
  };
  const { results, aborted } = await probeGovernanceSummaryIndexes(exec, "W", ["p1"]);
  expect(aborted).toBeNull();
  expect(executed).toHaveLength(results.length);
  expect(new Set(results.map((r) => r.shape)).size).toBe(results.length);
  const failed = results.filter((r) => !r.ok);
  expect(failed.length).toBeGreaterThan(0);
  for (const r of failed) {
    if (r.ok) throw new Error("unreachable");
    expect(r.kind).toBe("missing_index");
    expect(r.message).toBe(MESSAGE);
  }
  expect(results.filter((r) => r.ok).every((r) => r.ok && r.count === 3)).toBe(true);
});

it("a query-shape rejection (INVALID_ARGUMENT) is recorded and the probe continues", async () => {
  const { results, aborted } = await probeGovernanceSummaryIndexes(async (spec) => {
    if (spec.filters.some((f) => f.op === "not-in")) throw Object.assign(new Error("3 INVALID_ARGUMENT: bad shape"), { code: 3 });
    return 0;
  }, "W", []);
  expect(aborted).toBeNull();
  expect(results.some((r) => !r.ok && r.kind === "query_shape")).toBe(true);
});

it.each([
  ["permission", 7, "7 PERMISSION_DENIED: Missing or insufficient permissions."],
  ["availability", 14, "14 UNAVAILABLE: deadline"],
  ["unknown", undefined, "socket hang up"],
])("a %s failure STOPS the probe immediately and is reported, never skipped", async (_l, code, message) => {
  let calls = 0;
  const { results, aborted } = await probeGovernanceSummaryIndexes(async () => {
    calls += 1;
    if (calls === 3) throw Object.assign(new Error(message), code === undefined ? {} : { code });
    return 0;
  }, "W", []);
  expect(calls).toBe(3);
  expect(results).toHaveLength(2);
  expect(aborted).toMatchObject({ message });
});
