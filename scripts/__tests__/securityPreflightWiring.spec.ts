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
import { readFileSync } from "node:fs";

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
