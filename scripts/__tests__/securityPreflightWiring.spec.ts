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
      // The example line is deliberately BENIGN: this case tests the
      // unknown-detector-id path, which fails before any matching happens. An
      // actual vacuous shape here would be scanned as real source by `--all`
      // and flagged — the scanner matches string literals too, a known and
      // documented limitation.
      "# EXPECT-SHAPE: no-such-detector\n    const placeholder = 1;\n"
    );
    const res = spawnSync("node", [join(dir, SCRIPT), "--self-test"], { cwd: dir, encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("no registered detector");
  });
});


// ===========================================================================
describe("DETECTOR PARITY — registered, documented and self-tested agree", () => {
  /**
   * Phase FIRST-ADMIN-C17 (R13). The falsifiability document stated a detector
   * count of seven while the scanner registered eight, and the eighth appeared
   * nowhere in the document — drift introduced by the very commit that added it.
   * A count in prose cannot be kept honest by hand, so the contract is set
   * equality over stable IDs across three INDEPENDENT sources:
   *
   *   registered  — parsed from the scanner's own `{ id: "..." }` registrations
   *   documented  — parsed from the "Registered detectors" table in the doc
   *   self-tested — parsed from the fixture's `# EXPECT-SHAPE:` tags
   *
   * None of the three is derived from another, and none is read from THIS file,
   * so the assertion cannot be satisfied by its own source.
   */
  const SCANNER = "scripts/security-test-preflight.mjs";
  const DOC = "docs/operations/security-test-falsifiability.md";
  const FIXTURE = "scripts/__fixtures__/known-vacuous-shapes.txt";

  const registered = (): string[] =>
    [...readFileSync(SCANNER, "utf8").matchAll(/\{\s*id:\s*"([a-z-]+)"/g)].map((m) => m[1]).sort();

  const documented = (): string[] => {
    const doc = readFileSync(DOC, "utf8");
    const start = doc.indexOf("### Registered detectors");
    expect(start).toBeGreaterThan(-1);
    const table = doc.slice(start, doc.indexOf("\n\n", doc.indexOf("| Detector ID |", start) + 10) + 1);
    return [...table.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]).sort();
  };

  const selfTested = (): string[] =>
    [...readFileSync(FIXTURE, "utf8").matchAll(/^#\s*EXPECT-SHAPE:\s*([a-z-]+)/gm)].map((m) => m[1]).sort();

  it("ANCHOR: all three sources parsed a non-trivial detector set", () => {
    expect(registered().length).toBeGreaterThan(5);
    expect(documented().length).toBeGreaterThan(5);
    expect(selfTested().length).toBeGreaterThan(5);
  });

  it("every registered detector is documented", () => {
    expect(documented()).toEqual(registered());
  });

  it("every registered detector has a self-test fixture", () => {
    expect(selfTested()).toEqual(registered());
  });

  it("the documented set has no duplicates padding the count", () => {
    const d = documented();
    expect(d).toEqual([...new Set(d)]);
  });

  it("the self-referential detector is among them", () => {
    // Named explicitly: it is the one R13 found missing from the document.
    expect(registered()).toContain("self-referential-source-assertion");
    expect(documented()).toContain("self-referential-source-assertion");
    expect(selfTested()).toContain("self-referential-source-assertion");
  });

  it("no prose in the document asserts a hard-coded detector count", () => {
    const doc = readFileSync(DOC, "utf8");
    // A number in prose drifts; the tables above are the contract.
    expect(doc).not.toMatch(/\b(five|six|seven|eight|nine|ten)\s+detectors\s+(the\s+scanner|are\s+registered)/i);
  });
});
