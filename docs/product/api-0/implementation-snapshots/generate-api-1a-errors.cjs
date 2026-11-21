#!/usr/bin/env node
/**
 * Generates implementation-snapshots/api-1a-errors.json from the REAL `lib/apiPlatform/errors.ts`
 * at a given commit of the API-1a branch (PR #327). Docs-only tooling: it reads the file with
 * `git show <commit>:lib/apiPlatform/errors.ts`, transpiles it with the repository's declared
 * `typescript` devDependency, evaluates the module in an isolated vm context, and serializes
 * `API_ERRORS` as `{ status, type, message }` per code, with codes sorted.
 *
 * Usage (from the repository root):
 *   node docs/product/api-0/implementation-snapshots/generate-api-1a-errors.cjs <commit> [pr]
 *     > docs/product/api-0/implementation-snapshots/api-1a-errors.json
 *
 * The mirror test inside #327 (commit 96db2b6: lib/apiPlatform/__tests__/errorsSnapshot.spec.ts with
 * fixtures/api-1a-errors.snapshot.json, byte-identical) pins errors.ts to an identical snapshot; this repository's test
 * (docs/__tests__/apiOpenapiRequestContract.spec.ts, "m1") pins the catalog to this snapshot.
 */
"use strict";
const { execFileSync } = require("child_process");
const vm = require("vm");
const ts = require("typescript");

const SOURCE = "lib/apiPlatform/errors.ts";
const commitArg = process.argv[2];
const pr = Number(process.argv[3] ?? 327);
if (!commitArg) {
  process.stderr.write("usage: generate-api-1a-errors.cjs <commit> [pr]\n");
  process.exit(2);
}
const commit = execFileSync("git", ["rev-parse", "--verify", `${commitArg}^{commit}`], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit SHA: ${commit}`);
const source = execFileSync("git", ["show", `${commit}:${SOURCE}`], { encoding: "utf8" });

const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sandbox = { module: { exports: {} }, exports: {}, Response: function Response() {} };
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(js, sandbox, { filename: SOURCE, timeout: 1000 });
const errors = sandbox.module.exports.API_ERRORS;
if (!errors || typeof errors !== "object") throw new Error("API_ERRORS not exported");

const codes = {};
for (const code of Object.keys(errors).sort()) {
  const { status, type, message } = errors[code];
  if (!Number.isInteger(status) || typeof type !== "string" || typeof message !== "string") {
    throw new Error(`malformed entry ${code}`);
  }
  codes[code] = { status, type, message };
}
process.stdout.write(JSON.stringify({ source: SOURCE, pr, commit, codes }, null, 2) + "\n");
