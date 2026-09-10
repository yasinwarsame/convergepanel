/**
 * PERSONAL-RESEARCH-URL-1 §AO/§AT(7) — `readOnlyActions` must be PURELY ADDITIVE.
 *
 * WHY THIS IS SOURCE-LEVEL AND NOT A RENDER TEST: `ResultsDisplay` imports
 * `react-markdown`, which is ESM-only and unparseable by this repo's Jest
 * transform — which is why the component has no render spec anywhere and why every
 * other suite mocks it. Rather than claim a render test, this makes the additive
 * property falsifiable a different way: the DEFAULT branch's markup is compared
 * byte-for-byte against the version committed on `main`, so any change to the
 * composer's existing behaviour fails here even though the component cannot be
 * mounted.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const CURRENT = readFileSync(join(__dirname, "..", "ResultsDisplay.tsx"), "utf8");

function baselineSource(): string {
  return execFileSync("git", ["show", "origin/main:components/ResultsDisplay.tsx"], {
    cwd: join(__dirname, "..", ".."),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
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
    // every attribute, class and label must still match exactly.
    expect(executionButtons(CURRENT)).toEqual(executionButtons(baselineSource()));
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
