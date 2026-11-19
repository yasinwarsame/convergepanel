/**
 * The Jest suite runs in deterministic shards (`jest --shard`) under the
 * required "Quality Gate" check. Sharding is only safe if the required check
 * still fails whenever ANY shard fails, and if the shards together still run
 * the WHOLE suite, each suite once. This file pins both:
 *
 *   1. the workflow wiring (the required job waits for the shards, runs even
 *      when one fails, and ends in the aggregate checker);
 *   2. the aggregate checker's decision function, with a positive control and
 *      one case per way a sharded run can be incomplete or wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { evaluateShards, toRepoPath } = require("../ci/check-jest-shards");

const WF = readFileSync(".github/workflows/quality-gate.yml", "utf8");

/** Top-level job blocks by id (2-space keys under `jobs:`). */
function jobs(wf: string): Record<string, string> {
  const body = wf.slice(wf.indexOf("\njobs:\n") + "\njobs:\n".length);
  const out: Record<string, string> = {};
  const re = /^ {2}([a-z][a-z0-9_-]*):\n/gm;
  const marks = [...body.matchAll(re)];
  marks.forEach((m, i) => {
    out[m[1]] = body.slice(m.index!, i + 1 < marks.length ? marks[i + 1].index : undefined);
  });
  return out;
}

describe("workflow wiring: the required Quality Gate aggregates every Jest shard", () => {
  const J = jobs(WF);

  it("ANCHOR: reads the real workflow and finds exactly the two jobs", () => {
    expect(WF).toContain("name: ConvergePanel Quality Gate");
    expect(Object.keys(J).sort()).toEqual(["jest", "quality"]);
  });

  it("the required check name is unchanged and belongs to the aggregating job", () => {
    expect(J.quality).toMatch(/\n {4}name: Quality Gate\n/);
    // No other job may carry the required name (a second "Quality Gate" check
    // could satisfy branch protection on its own).
    expect(J.jest).not.toMatch(/name: Quality Gate/);
  });

  it("the required job waits for the shards and still RUNS (then fails) when one fails", () => {
    const head = J.quality.slice(0, J.quality.indexOf("steps:"));
    expect(head).toMatch(/\n {4}needs: jest\n/);
    expect(head).toMatch(/\n {4}if: \$\{\{ !cancelled\(\) \}\}\n/);
    // `always()` would also run on cancellation; the default would SKIP, and a
    // skipped required check counts as passing.
    expect(WF).not.toMatch(/always\(\)/);
  });

  it("the required job's last step is the aggregate checker, fed the shards' combined result", () => {
    const steps = J.quality.split(/\n(?= {6}- name: )/).filter((c) => /^ {6}- name: /.test(c));
    const last = steps[steps.length - 1];
    expect(last).toMatch(/^ {6}- name: Test\n/);
    expect(last).toMatch(/JEST_SHARDS_RESULT: \$\{\{ needs\.jest\.result \}\}/);
    expect(last).toMatch(/run: node scripts\/ci\/check-jest-shards\.js --total 3 --dir jest-shards --needs-result "\$JEST_SHARDS_RESULT"/);
    expect(last).not.toMatch(/\n\s+if:/);
  });

  it("the shard matrix is 1..3, matching --total, runs every shard to completion, and is bounded", () => {
    expect(J.jest).toMatch(/\n {6}fail-fast: false\n/);
    expect(J.jest).toMatch(/\n {6}max-parallel: 3\n/);
    expect(J.jest).toMatch(/\n {8}shard: \[1, 2, 3\]\n/);
    expect(J.jest).toMatch(/\n {4}timeout-minutes: 30\n/);
    expect(J.quality).toMatch(/\n {4}timeout-minutes: 30\n/);
  });

  it("each shard runs the same command as the former single step, plus only the shard and result flags", () => {
    expect(J.jest).toContain(
      "run: npx jest --runInBand --shard=${{ matrix.shard }}/3 --json --outputFile=jest-shard-${{ matrix.shard }}.json"
    );
    // The only jest invocation in the workflow (no second, partial run).
    expect(WF.match(/npx jest/g)).toHaveLength(1);
  });

  it("each shard verifies the exact PR head and uploads its result even when its tests fail", () => {
    expect(J.jest).toMatch(/fetch-depth: 2/);
    expect(J.jest).toMatch(/git rev-parse HEAD\^2/);
    const upload = J.jest.slice(J.jest.indexOf("- name: Upload shard result"));
    expect(upload).toMatch(/if: \$\{\{ !cancelled\(\) \}\}/);
    expect(upload).toMatch(/if-no-files-found: error/);
    expect(upload).toMatch(/name: jest-shard-\$\{\{ matrix\.shard \}\}/);
  });

  it("nothing in the workflow is soft-failed", () => {
    expect(WF).not.toMatch(/continue-on-error/);
  });
});

describe("aggregate checker decision (evaluateShards)", () => {
  const ROOT = "/w/repo";
  const abs = (p: string) => join(ROOT, p);
  const INV = ["a/__tests__/1.spec.ts", "b/__tests__/2.spec.ts", "c/__tests__/3.spec.ts", "d/__tests__/4.spec.ts"];
  const PLANS = { 1: [INV[0], INV[2]], 2: [INV[1]], 3: [INV[3]] };
  const res = (paths: string[], over: Record<string, unknown> = {}) => ({
    success: true,
    wasInterrupted: false,
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: paths.length * 2,
    testResults: paths.map((p) => ({ name: abs(p), status: "passed" })),
    ...over,
  });
  const good = () => ({ 1: res(PLANS[1]), 2: res(PLANS[2]), 3: res(PLANS[3]) } as Record<number, any>);
  const run = (over: Record<string, unknown> = {}) =>
    evaluateShards({ total: 3, needsResult: "success", inventory: INV, plans: PLANS, results: good(), root: ROOT, ...over });

  it("POSITIVE CONTROL: a complete, all-passing partition passes", () => {
    const r = run();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rows.map((x: any) => x.suites)).toEqual([2, 1, 1]);
  });

  it.each(["failure", "cancelled", "skipped", ""])("fails when the shard jobs' combined result is %p", (needsResult) => {
    const r = run({ needsResult });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/combined result/);
  });

  it("fails when a shard's result is missing (job died before upload)", () => {
    const results = good();
    delete results[2];
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/shard 2\/3: no readable result/), expect.stringMatching(/ran in NO shard: b\/__tests__\/2\.spec\.ts/)]));
  });

  it.each([
    ["success=false", { success: false }, /success=false/],
    ["a failed test", { numFailedTests: 1 }, /numFailedTests=1/],
    ["a failed suite", { numFailedTestSuites: 1 }, /numFailedTestSuites=1/],
    ["a suite that errored at load", { numRuntimeErrorTestSuites: 1 }, /numRuntimeErrorTestSuites=1/],
    ["an interrupted run", { wasInterrupted: true }, /interrupted/],
  ])("fails on %s in one shard", (_n, over, msg) => {
    const results = good();
    results[3] = res(PLANS[3], over);
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(msg);
  });

  it("fails on a suite whose status is failed even if the counters claim zero", () => {
    const results = good();
    results[2] = { ...res(PLANS[2]), testResults: [{ name: abs(INV[1]), status: "failed" }] };
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/suite FAILED: b\/__tests__\/2\.spec\.ts/);
  });

  it("fails when a suite runs in two shards", () => {
    const results = good();
    results[2] = res([INV[1], INV[0]]);
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/ran 2 times \(shards 1, 2\): a\/__tests__\/1\.spec\.ts/);
  });

  it("fails when an inventory suite runs nowhere, even if the plans also omit it", () => {
    const plans = { 1: [INV[0]], 2: [INV[1]], 3: [INV[3]] };
    const results = { 1: res([INV[0]]), 2: res([INV[1]]), 3: res([INV[3]]) };
    const r = run({ plans, results });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([expect.stringMatching(/ran in NO shard: c\/__tests__\/3\.spec\.ts/)]);
  });

  it("fails when a shard runs a suite outside the unsharded inventory", () => {
    const results = good();
    results[3] = res([INV[3], "e/__tests__/5.spec.ts"]);
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/outside the unsharded inventory ran: e\/__tests__\/5\.spec\.ts/);
  });

  it("fails when a shard's executed set differs from its --shard plan (non-deterministic partition)", () => {
    const results = good();
    results[1] = res([INV[0]]);
    results[2] = res([INV[1], INV[2]]);
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/shard 1\/3: did not run planned suite c\/__tests__\/3\.spec\.ts/);
    expect(r.errors.join("\n")).toMatch(/shard 2\/3: ran c\/__tests__\/3\.spec\.ts, which is not in its --shard plan/);
  });

  it("fails on a shard that ran zero suites, and on an empty inventory", () => {
    const results = good();
    results[3] = res([]);
    expect(run({ results }).errors.join("\n")).toMatch(/shard 3\/3: ran ZERO suites/);
    const empty = evaluateShards({ total: 1, needsResult: "success", inventory: [], plans: { 1: [] }, results: { 1: res([]) }, root: ROOT });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join("\n")).toMatch(/inventory is EMPTY/);
  });

  it("fails on a result path outside the repo root (cannot be matched to the inventory)", () => {
    const results = good();
    results[2] = { ...res([]), testResults: [{ name: "/elsewhere/b/__tests__/2.spec.ts", status: "passed" }] };
    const r = run({ results });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/outside the repo root/);
  });

  it("toRepoPath relativizes inside the root and rejects paths outside it", () => {
    expect(toRepoPath(ROOT, abs("x/__tests__/y.spec.ts"))).toBe("x/__tests__/y.spec.ts");
    expect(toRepoPath(ROOT, "/w/other/y.spec.ts")).toBeNull();
    expect(toRepoPath(ROOT, ROOT)).toBeNull();
  });
});
