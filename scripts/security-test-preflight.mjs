#!/usr/bin/env node
/**
 * Phase FIRST-ADMIN-C6 — mechanical falsifiability pre-flight for security tests.
 *
 * Seven rounds of review on this workstream found the same class of defect over
 * and over: an assertion that reads as a security proof but cannot fail. Every
 * instance was caught by a human reviewer, never by CI, and each round I closed
 * the named cases and introduced a new variant. This scan encodes the shapes
 * found so far so the next variant is at least a known one.
 *
 * It is a LINT, not a proof. It cannot tell you an assertion is meaningful — it
 * only flags shapes that have previously turned out to be vacuous. The
 * accompanying rule (docs/operations/security-test-falsifiability.md) is the
 * part that actually matters.
 *
 *   node scripts/security-test-preflight.mjs [<paths...>]
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SHAPES = [
  { id: "nullish-mask", re: /\?\?[^\n]*\)\s*\.\s*not\s*\.\s*toBeNull|\?\?[^\n]*\)\s*\.\s*toEqual/,
    why: "`??` masks the security-significant value before the assertion — `null ?? x` is never null." },
  { id: "default-mask", re: /\|\|\s*\[\]\s*\)\s*\.\s*toEqual/,
    why: "`|| []` turns an absent key into a passing empty-array assertion." },
  { id: "truthy-authority", re: /expect\([^)]*(admin|Admin|authority|scope|visible)[^)]*\)\s*\.\s*toBeTruthy\(\)/,
    why: "truthiness on an authority value accepts non-boolean grants." },
  { id: "some-effects", re: /effects\(\)\s*\.\s*some\(/,
    why: "`some()` where every listed effect is mandatory — a skipped mutation survives." },
  { id: "empty-body", re: /=>\s*\{\s*\}\s*\)\s*;/,
    why: "test body is empty — passes while asserting nothing." },
];

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execSync("git diff --name-only origin/main...HEAD -- '*.spec.ts' '*.spec.tsx'", { encoding: "utf8" })
      .split("\n").filter(Boolean);

let hits = 0;
for (const f of files) {
  let src;
  try { src = readFileSync(f, "utf8"); } catch { continue; }
  src.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) return; // prose about the shapes
    for (const s of SHAPES) {
      if (s.re.test(line)) { hits++; console.log(`${f}:${i + 1}  [${s.id}] ${s.why}\n    ${line.trim()}`); }
    }
  });
}
console.log(hits === 0 ? `\npre-flight clean across ${files.length} changed spec file(s)` : `\n${hits} flagged construct(s)`);
process.exit(hits === 0 ? 0 : 1);
