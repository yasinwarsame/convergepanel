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
 *   node scripts/security-test-preflight.mjs --all      # every tracked spec
 *
 * Phase FIRST-ADMIN-C7 — this now RUNS IN CI (Quality Gate), and CI passes
 * `--all` deliberately.
 *
 * The default mode diffs against `origin/main`, which is right for a local
 * pre-commit check and WRONG for CI: `actions/checkout` fetches a single
 * commit by default, so `origin/main` does not resolve on a runner. A
 * change-scoped scanner that cannot resolve its base either crashes or, worse,
 * yields an empty file list — and an empty scan reports "clean". That is the
 * same vacuity this script exists to catch, one level up: a gate that passes
 * because it examined nothing. `--all` enumerates tracked specs directly, so
 * the CI result never depends on how much history the runner happens to have.
 *
 * For the same reason a scan of ZERO files is a FAILURE, not a pass.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SHAPES = [
  // Phase FIRST-ADMIN-C7: these were tightened after the first whole-repo run.
  // The C6 versions were only ever run against the files a branch changed, so
  // their false-positive rate had never been measured — on the full tree they
  // produced 17 hits and ZERO were real (16 were `mockImplementation(() => {})`
  // noop callbacks matching the "empty test body" shape). A gate that is wrong
  // every time it fires gets switched off, so precision here is a security
  // property, not tidiness. Each shape is anchored by a real historical defect
  // in scripts/__fixtures__/known-vacuous-shapes.txt and proven live by --self-test.
  { id: "nullish-mask",
    re: /\?\?[^\n]*\)\s*\.\s*not\s*\.\s*toBe(Null|Undefined)\(|\?\?\s*(\[\]|\{\})\s*\)[^\n]*\.\s*toEqual\(\s*(\[\]|\{\})\s*\)/,
    why: "`??` masks the security-significant value before the assertion — `null ?? x` is never null, and masking to an empty value then asserting emptiness cannot fail." },
  { id: "default-mask",
    re: /\|\|\s*(\[\]|\{\})\s*\)[^\n]*\.\s*toEqual\(\s*(\[\]|\{\})\s*\)/,
    why: "`|| []` turns an absent key into a passing empty-array assertion." },
  { id: "truthy-authority",
    re: /expect\([^)]*(admin|Admin|authority|scope|visible)[^)]*\)\s*\.\s*toBeTruthy\(\)/,
    why: "truthiness on an authority value accepts non-boolean grants." },
  { id: "some-effects",
    re: /effects\(\)\s*\.\s*some\(/,
    why: "`some()` where every listed effect is mandatory — a skipped mutation survives." },
  { id: "empty-body",
    re: /\b(it|test)\s*\(\s*["'`][^\n]*=>\s*\{\s*\}\s*\)/,
    why: "test body is empty — passes while asserting nothing." },
  // Phase FIRST-ADMIN-C8 (R4): the same defect as `empty-body`, in the shape an
  // editor actually writes it. A line-based scanner could not see it, so the
  // canonical historical defect had an uncovered natural form. Two-line
  // lookahead only — deliberately not a parser.
  { id: "multiline-empty-body",
    at: (lines, i) => {
      if (!/\b(it|test)\s*\(\s*["'`][^\n]*=>\s*\{\s*$/.test(lines[i])) return false;
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const next = lines[j].trim();
        if (next === "") continue;
        return /^\}\s*\)\s*;?$/.test(next);
      }
      return false;
    },
    why: "test body is empty across lines — passes while asserting nothing." },
  { id: "skipped-test",
    re: /\b(it|test|describe)\s*\.\s*(skip|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/,
    why: "a skipped or todo security test is green and proves nothing." },
  // Phase FIRST-ADMIN-C16 (R12 P1). A "pin" asserted that a coverage-narrowing
  // comment existed by matching the test file against its own source — and the
  // regex literal WAS that text, so it matched itself and could never fail.
  // Deleting the thing it claimed to pin left the suite green. Two-line
  // lookahead, deliberately not a parser: it catches reading __filename and
  // asserting a literal over it, which is the shape that recurred.
  { id: "self-referential-source-assertion",
    at: (lines, i) => {
      if (!/readFileSync\s*\(\s*__filename/.test(lines[i])) return false;
      for (let j = i; j < lines.length && j <= i + 2; j++) {
        if (/\.\s*(toMatch|toContain)\s*\(\s*[/"'`]/.test(lines[j])) return true;
      }
      return false;
    },
    why: "asserting a literal against the test file's OWN source: the expected text is present because the assertion itself contains it, so the check cannot fail." },
];

const argv = process.argv.slice(2);
const all = argv.includes("--all");
const explicit = argv.filter((a) => !a.startsWith("--"));
const gitLines = (cmd) => execSync(cmd, { encoding: "utf8" }).split("\n").filter(Boolean);

const selfTest = argv.includes("--self-test");
const SELF_TEST_FIXTURE = "scripts/__fixtures__/known-vacuous-shapes.txt";

let scope;
let files;
if (selfTest) {
  scope = "self-test fixture";
  files = [SELF_TEST_FIXTURE];
} else if (explicit.length) {
  scope = "explicitly listed";
  files = explicit;
} else if (all) {
  scope = "tracked";
  files = gitLines("git ls-files -- '*.spec.ts' '*.spec.tsx'");
} else {
  scope = "changed";
  files = gitLines("git diff --name-only origin/main...HEAD -- '*.spec.ts' '*.spec.tsx'");
}

// A scan that examined nothing must never report success.
if (files.length === 0) {
  console.error(
    `pre-flight scanned ZERO ${scope} spec files. Refusing to report a clean ` +
    `result from an empty scan — check the file selection (in CI, pass --all).`
  );
  process.exit(1);
}

let hits = 0;
let scanned = 0;
let unreadable = 0;
const fired = new Set();
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch (err) {
    // An unreadable file must never be silently skipped: it would count toward
    // the "clean across N files" total while contributing no scan at all.
    console.error(`pre-flight could not read ${f}: ${err.message}`);
    unreadable++;
    continue;
  }
  scanned++;
  src.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) return; // prose about the shapes
    for (const s of SHAPES) {
      const matched = s.re ? s.re.test(line) : s.at(src.split("\n"), i);
      if (matched) { hits++; fired.add(s.id); console.log(`${f}:${i + 1}  [${s.id}] ${s.why}\n    ${line.trim()}`); }
    }
  });
}
if (selfTest) {
  /**
   * THE POSITIVE ANCHOR — expectation and implementation from DIFFERENT files.
   *
   * Phase FIRST-ADMIN-C8. This previously computed what it expected from
   * `SHAPES`, so deleting a detector deleted its own expectation and the
   * self-test passed with a smaller count. The fixture now DECLARES the
   * detectors it requires, and the two must agree in both directions.
   */
  const declared = [...readFileSync(SELF_TEST_FIXTURE, "utf8")
    .matchAll(/^#\s*EXPECT-SHAPE:\s*([a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
  const registered = SHAPES.map((s) => s.id);

  if (declared.length === 0) {
    console.error("\nSELF-TEST FAILED — the fixture declares no shapes at all.");
    process.exit(1);
  }
  // A declared shape with no detector: either a detector was DELETED, or the
  // fixture names one that never existed. Both are failures.
  const undetected = declared.filter((id) => !registered.includes(id));
  if (undetected.length) {
    console.error(`\nSELF-TEST FAILED — fixture declares shape(s) with no registered detector: ${undetected.join(", ")}`);
    process.exit(1);
  }
  // A detector with no declared shape is untested: it could be broken and the
  // self-test would never notice.
  const uncovered = registered.filter((id) => !declared.includes(id));
  if (uncovered.length) {
    console.error(`\nSELF-TEST FAILED — detector(s) have no fixture coverage: ${uncovered.join(", ")}`);
    process.exit(1);
  }
  // And each declared shape must actually fire on its own recorded defect.
  const dead = declared.filter((id) => !fired.has(id));
  if (dead.length) {
    console.error(`\nSELF-TEST FAILED — shape(s) no longer detect their known defect: ${dead.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nself-test: all ${declared.length} fixture-declared shapes fired, and every detector is covered`);
  process.exit(0);
}

if (unreadable > 0) {
  console.error(`\n${unreadable} file(s) could not be read — refusing to report a result from a partial scan.`);
  process.exit(1);
}
console.log(hits === 0 ? `\npre-flight clean across ${scanned} ${scope} spec file(s)` : `\n${hits} flagged construct(s)`);
process.exit(hits === 0 ? 0 : 1);
