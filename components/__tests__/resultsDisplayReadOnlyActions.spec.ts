/**
 * PERSONAL-RESEARCH-URL-1 §AO/§AT(7) — `readOnlyActions` must be PURELY ADDITIVE.
 *
 * WHY THIS IS SOURCE-LEVEL AND NOT A RENDER TEST: `ResultsDisplay` imports
 * `react-markdown`, which is ESM-only and unparseable by this repo's Jest
 * transform — which is why the component has no render spec anywhere and why every
 * other suite mocks it. Rather than claim a render test, this makes the additive
 * property falsifiable a different way: the DEFAULT branch's markup is compared
 * byte-for-byte against a FROZEN baseline below.
 *
 * WHY THE BASELINE IS FROZEN AND NOT READ FROM `origin/main`: the first version of
 * this suite ran `git show origin/main:...`. It passed locally and FAILED in CI,
 * where `actions/checkout` fetches the PR ref without the `main` branch, so the
 * load-bearing assertion was environment-dependent. Resolving a fallback ref and
 * skipping when none exists would have been worse — the regression would have gone
 * quietly vacuous in exactly the environment that gates the merge. So the baseline
 * is a literal: it is identical in every environment and cannot be skipped. The
 * git comparison survives only as an additive cross-check that the literal is still
 * a faithful copy of `main`, and it is not what protects the invariant.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..");
const CURRENT = readFileSync(join(__dirname, "..", "ResultsDisplay.tsx"), "utf8");

/**
 * The two execution buttons exactly as they stand on `main` at this branch's base
 * (c7649a44), whitespace-collapsed by `executionButtons()` below. Any change to
 * their handler, classes or copy fails the regression.
 */
const MAIN_BASELINE_BUTTONS = [
  '<button onClick={onRerun} className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 transition-colors" > Re-run Same Panel </button>',
  '<button onClick={onAddModel} className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 transition-colors" > Add Another Model + Re-run </button>',
];

/** The base revision, when this checkout happens to have it. `null` in CI. */
function resolvableBaseRef(): string | null {
  for (const ref of ["origin/main", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return ref;
    } catch {
      // not present in this checkout
    }
  }
  return null;
}

/**
 * The two execution buttons, extracted individually by their handler + label so no
 * surrounding wrapper or indentation can affect the comparison. Any change to their
 * attributes, classes or copy fails the regression below.
 */
function executionButtons(source: string): string[] {
  const out: string[] = [];
  for (const [handler, label] of [
    ["onRerun", "Re-run Same Panel"],
    ["onAddModel", "Add Another Model + Re-run"],
  ] as const) {
    const re = new RegExp(`<button\\s+onClick=\\{${handler}\\}[\\s\\S]*?>\\s*${label.replace(/[+]/g, "\\+")}\\s*</button>`);
    const m = source.match(re);
    expect(m).not.toBeNull();
    out.push(m![0].replace(/\s+/g, " ").trim());
  }
  return out;
}

describe("ResultsDisplay — readOnlyActions", () => {
  it("is optional and defaults to false, so every existing call site is unaffected", () => {
    expect(CURRENT).toMatch(/readOnlyActions\?: boolean;/);
    expect(CURRENT).toMatch(/readOnlyActions = false,/);
  });

  it("REGRESSION: the default execution-button markup is byte-identical to the version on main", () => {
    // Normalised only for the extra indentation the new conditional introduces;
    // every attribute, class and label must still match exactly. Runs in every
    // environment, including a CI checkout with no `main` branch.
    expect(executionButtons(CURRENT)).toEqual(MAIN_BASELINE_BUTTONS);
  });

  it("cross-check, where git history is available: the frozen baseline is still a faithful copy of main", () => {
    const ref = resolvableBaseRef();
    if (!ref) {
      // Shallow checkout (CI). The regression above already ran against the
      // literal; this only re-proves the literal's provenance.
      return;
    }
    const baseline = execFileSync("git", ["show", `${ref}:components/ResultsDisplay.tsx`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(executionButtons(baseline)).toEqual(MAIN_BASELINE_BUTTONS);
  });

  it("the read-only branch replaces those actions rather than leaving copy that promises a re-run it cannot perform", () => {
    const i = CURRENT.indexOf("{readOnlyActions ? (");
    expect(i).toBeGreaterThan(-1);
    const readOnlyBranch = CURRENT.slice(i, CURRENT.indexOf(") : (", i));
    expect(readOnlyBranch).toContain("To run this question again");
    expect(readOnlyBranch).toContain('href="/"');
    expect(readOnlyBranch).not.toContain("Re-run Same Panel");
    expect(readOnlyBranch).not.toContain("onRerun");
    expect(readOnlyBranch).not.toContain("onAddModel");
  });

  it("the prop changes EXACTLY ONE place: nothing else in the component branches on it", () => {
    // Comments stripped — the explanatory doc comments name the prop too, and an
    // absence/count assertion must not be satisfiable by prose.
    const code = CURRENT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");
    const uses = code.match(/readOnlyActions/g) ?? [];
    // exactly: the type declaration, the destructure default, the one conditional
    expect(uses).toHaveLength(3);
  });

  it("the existing required callbacks are unchanged, so no call site's contract moved", () => {
    expect(CURRENT).toMatch(/onRerun: \(\) => void;/);
    expect(CURRENT).toMatch(/onAddModel: \(\) => void;/);
  });
});
