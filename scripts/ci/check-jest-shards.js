#!/usr/bin/env node
/**
 * Aggregate gate for the sharded Jest run in the Quality Gate workflow.
 *
 *   node scripts/ci/check-jest-shards.js --total 3 --dir jest-shards --needs-result success
 *
 * Each shard job writes `jest --json` output to jest-shard-<i>.json. This
 * script is the last step of the required "Quality Gate" job. It exits
 * non-zero unless ALL of the following hold:
 *
 *   - the shard jobs' combined result is "success";
 *   - a readable result exists for every shard 1..total;
 *   - every shard reports success, with no failed, errored or interrupted suite;
 *   - each shard ran at least one suite, and exactly the suites of its
 *     deterministic `jest --listTests --shard=<i>/<total>` plan;
 *   - across all shards, every suite of the unsharded `jest --listTests`
 *     inventory ran exactly once, and nothing outside it ran.
 *
 * The comparison logic is the pure function `evaluateShards`, unit-tested in
 * scripts/__tests__/jestShardGate.spec.ts. Nothing here touches the network.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, readdirSync, readFileSync } = require("node:fs");
const { join, relative, isAbsolute } = require("node:path");

/** Repo-relative, forward-slash form; null for a path outside the repo root. */
function toRepoPath(root, p) {
  const r = isAbsolute(p) ? relative(root, p) : p;
  if (r === "" || r.startsWith("..") || isAbsolute(r)) return null;
  return r.split("\\").join("/");
}

/**
 * @param {object} input
 * @param {number} input.total             number of shards
 * @param {string} input.needsResult       `needs.jest.result` from the workflow
 * @param {string[]} input.inventory       repo paths from unsharded --listTests
 * @param {Record<number, string[]>} input.plans   repo paths per shard from --listTests --shard
 * @param {Record<number, object|null|undefined>} input.results  parsed jest --json per shard
 * @param {string} input.root              absolute repo root the results' paths are under
 * @returns {{ ok: boolean, errors: string[], rows: object[] }}
 */
function evaluateShards({ total, needsResult, inventory, plans, results, root }) {
  const errors = [];
  const rows = [];
  if (!Number.isInteger(total) || total < 1) errors.push(`invalid shard total: ${total}`);
  if (needsResult !== "success") errors.push(`the Jest shard jobs' combined result is "${needsResult}", not "success"`);
  if (!Array.isArray(inventory) || inventory.length === 0) errors.push("the unsharded suite inventory is EMPTY");

  const inv = new Set(inventory ?? []);
  if (inv.size !== (inventory ?? []).length) errors.push("the unsharded suite inventory lists a suite twice");
  const ranBy = new Map(); // suite -> shard numbers that ran it

  for (let i = 1; i <= total; i += 1) {
    const res = results?.[i];
    if (!res || typeof res !== "object") {
      errors.push(`shard ${i}/${total}: no readable result`);
      rows.push({ shard: i, suites: 0, tests: 0, failedSuites: "?", failedTests: "?" });
      continue;
    }
    const suites = Array.isArray(res.testResults) ? res.testResults : [];
    rows.push({
      shard: i,
      suites: suites.length,
      tests: res.numTotalTests ?? "?",
      failedSuites: res.numFailedTestSuites ?? "?",
      failedTests: res.numFailedTests ?? "?",
    });
    if (res.success !== true) errors.push(`shard ${i}/${total}: jest reported success=${res.success}`);
    if (res.wasInterrupted) errors.push(`shard ${i}/${total}: the run was interrupted`);
    for (const k of ["numFailedTestSuites", "numFailedTests", "numRuntimeErrorTestSuites"]) {
      if (res[k] !== 0) errors.push(`shard ${i}/${total}: ${k}=${res[k]}`);
    }
    if (suites.length === 0) errors.push(`shard ${i}/${total}: ran ZERO suites`);

    const executed = [];
    for (const s of suites) {
      const p = typeof s?.name === "string" ? toRepoPath(root, s.name) : null;
      if (p === null) {
        errors.push(`shard ${i}/${total}: suite path outside the repo root: ${s?.name}`);
        continue;
      }
      executed.push(p);
      if (s.status === "failed") errors.push(`shard ${i}/${total}: suite FAILED: ${p}`);
      ranBy.set(p, [...(ranBy.get(p) ?? []), i]);
    }
    const plan = new Set(plans?.[i] ?? []);
    if (plan.size === 0) errors.push(`shard ${i}/${total}: its --shard plan is EMPTY`);
    const exec = new Set(executed);
    for (const p of exec) if (!plan.has(p)) errors.push(`shard ${i}/${total}: ran ${p}, which is not in its --shard plan`);
    for (const p of plan) if (!exec.has(p)) errors.push(`shard ${i}/${total}: did not run planned suite ${p}`);
  }

  for (const [p, by] of ranBy) {
    if (by.length > 1) errors.push(`suite ran ${by.length} times (shards ${by.join(", ")}): ${p}`);
    if (!inv.has(p)) errors.push(`suite outside the unsharded inventory ran: ${p}`);
  }
  for (const p of inv) if (!ranBy.has(p)) errors.push(`suite in the unsharded inventory ran in NO shard: ${p}`);

  return { ok: errors.length === 0, errors, rows };
}

function listTests(root, extra = []) {
  const r = spawnSync("npx", ["jest", "--listTests", ...extra], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`jest --listTests ${extra.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => toRepoPath(root, p) ?? `<outside root> ${p}`)
    .sort();
}

/** Finds jest-shard-<i>.json anywhere under dir (download-artifact nests per artifact). */
function readResults(dir, total) {
  const out = {};
  const files = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const m = /^jest-shard-(\d+)\.json$/.exec(e.name);
        if (m) files.set(Number(m[1]), [...(files.get(Number(m[1])) ?? []), f]);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  for (let i = 1; i <= total; i += 1) {
    const fs = files.get(i) ?? [];
    if (fs.length !== 1) {
      out[i] = null;
      if (fs.length > 1) console.error(`shard ${i}: ${fs.length} result files found`);
      continue;
    }
    try {
      out[i] = JSON.parse(readFileSync(fs[0], "utf8"));
    } catch (e) {
      console.error(`shard ${i}: unreadable result ${fs[0]}: ${e.message}`);
      out[i] = null;
    }
  }
  return out;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const total = Number(arg("--total"));
  const dir = arg("--dir");
  const needsResult = arg("--needs-result");
  if (!Number.isInteger(total) || total < 1 || !dir || needsResult === undefined) {
    console.error("usage: check-jest-shards.js --total <n> --dir <results dir> --needs-result <result>");
    process.exit(2);
  }
  const root = process.cwd();
  const inventory = listTests(root);
  const plans = {};
  for (let i = 1; i <= total; i += 1) plans[i] = listTests(root, [`--shard=${i}/${total}`]);
  const results = readResults(dir, total);
  const { ok, errors, rows } = evaluateShards({ total, needsResult, inventory, plans, results, root });

  const table = [
    "| Shard | Suites | Tests | Failed suites | Failed tests |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.shard}/${total} | ${r.suites} | ${r.tests} | ${r.failedSuites} | ${r.failedTests} |`),
  ].join("\n");
  const head = `Jest shards: inventory ${inventory.length} suites; ${ok ? "PASS" : `FAIL (${errors.length} problem(s))`}`;
  console.log(head);
  console.log(table);
  for (const e of errors) console.error(`::error::${e}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const body = `## ${head}\n\n${table}\n${errors.length ? `\n${errors.map((e) => `- ${e}`).join("\n")}\n` : ""}`;
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
    } catch {
      /* the summary is diagnostics only */
    }
  }
  process.exitCode = ok ? 0 : 1;
}

module.exports = { evaluateShards, toRepoPath };

if (require.main === module) main();
