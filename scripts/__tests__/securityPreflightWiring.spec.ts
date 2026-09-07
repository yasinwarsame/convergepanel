/**
 * Phase FIRST-ADMIN-C7 — the pre-flight must stay WIRED.
 *
 * The C6 scanner was never invoked by anything. It existed, it worked, and it
 * gated nothing for a whole phase, because "we added a script" and "a script
 * runs on every PR" are different claims and only the second one is a control.
 *
 * Deleting the workflow step is invisible to a test suite unless a test looks
 * at the workflow, so this looks at the workflow. It also pins `--self-test`,
 * without which the scanner can pass with every shape switched off.
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = readFileSync(".github/workflows/quality-gate.yml", "utf8");
const PKG = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("security-test pre-flight is wired into the Quality Gate", () => {
  it("package.json exposes the pre-flight script", () => {
    expect(PKG.scripts["security:preflight"]).toBe("node scripts/security-test-preflight.mjs");
  });

  it("the Quality Gate runs the pre-flight over ALL tracked specs", () => {
    // `--all`, not the default changed-files mode: `actions/checkout` fetches a
    // single commit, so `origin/main` does not resolve on a runner.
    expect(WORKFLOW).toContain("npm run security:preflight -- --all");
  });

  it("the Quality Gate runs the scanner's own self-test first", () => {
    expect(WORKFLOW).toContain("npm run security:preflight -- --self-test");
  });

  it("the pre-flight runs before the test step, so a vacuous shape is reported even if tests fail", () => {
    expect(WORKFLOW.indexOf("security:preflight")).toBeLessThan(WORKFLOW.indexOf("npx jest"));
  });

  it("ANCHOR: this test is reading the real workflow, not an empty string", () => {
    expect(WORKFLOW).toContain("name: ConvergePanel Quality Gate");
    expect(WORKFLOW).toContain("npx jest");
    expect(WORKFLOW.length).toBeGreaterThan(500);
  });
});

describe("the scanner's CLI contract — a printed warning is not a gate", () => {
  /**
   * Phase FIRST-ADMIN-C9 (R5 F-2). Nothing asserted the scanner's EXIT
   * behaviour. Changing its last line to `process.exit(0)` left CI printing
   * "1 flagged construct(s)" and passing forever, and deleting the zero-file
   * guard made "clean across 0 files" a pass — both with every wiring test
   * green. The gate's whole value is the exit code, so the exit code is now
   * the thing under test.
   */
  const SCRIPT = "scripts/security-test-preflight.mjs";
  const run = (args: string[], cwd = process.cwd()) =>
    spawnSync("node", [join(process.cwd(), SCRIPT), ...args], { cwd, encoding: "utf8" });

  const specFile = (contents: string) => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-cli-"));
    const file = join(dir, "probe.spec.ts");
    writeFileSync(file, contents);
    return file;
  };

  it("ANCHOR: the scanner is executable and reports on a file we hand it", () => {
    const res = run([specFile("it(\"real\", () => { expect(1).toBe(1); });\n")]);
    expect(res.error).toBeUndefined();
    expect(res.stdout).toContain("explicitly listed spec file");
  });

  it("a CLEAN scan exits 0", () => {
    const res = run([specFile("it(\"real\", () => { expect(1).toBe(1); });\n")]);
    expect(res.status).toBe(0);
  });

  it("a PROHIBITED construct exits NONZERO", () => {
    const res = run([specFile("it(\"vacuous\", async () => {});\n")]);
    // The defect: printing the finding but exiting 0.
    expect(res.stdout).toContain("flagged construct");
    expect(res.status).not.toBe(0);
  });

  it("a scan that examined ZERO files exits NONZERO, and says so distinctly", () => {
    // A repo with the script but no specs at all: zero FILES, not zero findings.
    const dir = mkdtempSync(join(tmpdir(), "preflight-empty-"));
    spawnSync("git", ["init", "-q", "."], { cwd: dir });
    mkdirSync(join(dir, "scripts", "__fixtures__"), { recursive: true });
    cpSync(SCRIPT, join(dir, SCRIPT));
    cpSync("scripts/__fixtures__/known-vacuous-shapes.txt", join(dir, "scripts/__fixtures__/known-vacuous-shapes.txt"));
    spawnSync("git", ["add", "-A"], { cwd: dir });
    const res = spawnSync("node", [join(dir, SCRIPT), "--all"], { cwd: dir, encoding: "utf8" });
    expect(res.status).not.toBe(0);
    // Must be distinguishable from "clean": a zero-file scan is not a pass.
    expect(res.stderr + res.stdout).toMatch(/ZERO/);
    expect(res.stdout).not.toContain("pre-flight clean");
  });

  it("a passing SELF-TEST exits 0", () => {
    const res = run(["--self-test"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fixture-declared shapes fired");
  });

  it("a FAILING self-test exits NONZERO", () => {
    // A fixture declaring a detector that does not exist.
    const dir = mkdtempSync(join(tmpdir(), "preflight-selftest-"));
    mkdirSync(join(dir, "scripts", "__fixtures__"), { recursive: true });
    cpSync(SCRIPT, join(dir, SCRIPT));
    writeFileSync(
      join(dir, "scripts/__fixtures__/known-vacuous-shapes.txt"),
      "# EXPECT-SHAPE: no-such-detector\n    expect(x ?? undefined).not.toBeNull();\n"
    );
    const res = spawnSync("node", [join(dir, SCRIPT), "--self-test"], { cwd: dir, encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("no registered detector");
  });
});
