/**
 * Privacy remediation round 2 (review B2) — repository-wide STATIC guard:
 * no `console.*` / `logger.*` call in shipped code (app, components, lib,
 * hooks) may log an excerpt of user / model text or a whole response.
 *
 * The scanner extracts each call's full argument text (multi-line, balanced
 * parentheses) and fails on:
 *   - `<content>.substring(` / `<content>.slice(` where <content> is one of
 *     the identifiers that hold claims, questions, model output or response
 *     bodies in this codebase;
 *   - a `...Preview` / `preview` / `previewsByModel` / `sampleClaims` key;
 *   - `fullResponse:` and the specific whole-object dumps the review found
 *     (`data.results)` and a bare `result)` / `results)` argument).
 * New sites must log lengths, counts, ids, codes and stages instead.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["app", "components", "lib", "hooks"];
const CONTENT = "(?:rawText|responseText|synthesizedText|canonicalText|modelText|markdown|claim|claimText|question|questionText|text|content|answer|output|cleaned|errorText|msg)";
const RULES: Array<[string, RegExp]> = [
  ["content excerpt", new RegExp(`\\b${CONTENT}\\??\\.(?:substring|slice)\\(`)],
  ["preview key", /\b(?:\w*Preview|preview|previewsByModel|sampleClaims)\s*:/],
  ["full response dump", /\bfullResponse\s*:/],
  ["results dump", /,\s*(?:data\.results|results|result)\s*\)\s*;?\s*$/],
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function callText(src: string, start: number): string {
  let depth = 0;
  for (let j = src.indexOf("(", start); j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")" && --depth === 0) return src.slice(start, j + 1);
  }
  return src.slice(start, start + 400);
}

export function scanForContentLogging(): string[] {
  const hits: string[] = [];
  const CALL = /\b(?:console\.(?:log|warn|error|info|debug)|logger\.(?:info|warn|error|debug))\s*\(/g;
  for (const d of DIRS) {
    for (const f of files(join(ROOT, d))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(CALL)) {
        const txt = callText(src, m.index!);
        const args = txt.slice(txt.indexOf("(") + 1).replace(/^\s*(`[^`]*`|"[^"]*"|'[^']*')/, "");
        for (const [rule, re] of RULES) {
          if (re.test(args)) hits.push(`${relative(ROOT, f)}:${src.slice(0, m.index).split("\n").length} ${rule}`);
        }
      }
    }
  }
  return hits;
}

describe("static guard: no content excerpts or whole responses in log calls", () => {
  it("finds no violations in app/, components/, lib/, hooks/", () => {
    expect(scanForContentLogging()).toEqual([]);
  });

  it("control: the scanner flags each pattern it is meant to catch", () => {
    const samples = [
      `logger.error("x", { rawPreview: synthesizedText.substring(0, 500) })`,
      `console.log("[panel] Raw API response:", responseText.substring(0, 500))`,
      `console.log("x", { previewsByModel: p })`,
      `console.error("x", { fullResponse: data })`,
      `console.log("[panel] Raw results from API:", data.results);`,
    ];
    for (const s of samples) {
      const args = s.slice(s.indexOf("(") + 1).replace(/^\s*(`[^`]*`|"[^"]*"|'[^']*')/, "");
      expect(RULES.some(([, re]) => re.test(args))).toBe(true);
    }
  });
});
