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
const CONTENT = "(?:rawText|rawTextTruncated|responseText|synthesizedText|canonicalText|modelText|markdown|claim|claimText|question|questionText|text|content|answer|output|cleaned|errorText|msg)";
// Whole-value use of a content variable (`{ body: result.rawText }`, `, question)`), not `.length` etc.
const WHOLE = "(?:rawText|rawTextTruncated|responseText|synthesizedText|canonicalText|modelText|markdown|claimText|questionText|question|claim)";
const RULES: Array<[string, RegExp]> = [
  ["content excerpt", new RegExp(`\\b${CONTENT}\\??\\.(?:substring|substr|slice)\\(`)],
  ["whole content value", new RegExp(`(?:[:(,]|\\$\\{)\\s*(?:[\\w$]+\\??\\.)*${WHOLE}\\s*(?=[,)}\\]]|$)`)],
  ["preview key", /\b(?:\w*Preview|preview|previewsByModel|sampleClaims)\s*:/],
  ["full response dump", /\bfullResponse\s*:/],
  ["results dump", /(?:^|,)\s*(?:data\.results|results|result)\s*\)?\s*;?\s*$/],
];
const CALL_BASE = "console\\.(?:log|warn|error|info|debug|trace|dir|table|group|groupCollapsed)|logger\\.(?:info|warn|error|debug)";
// Parsing of TEXT (model output, request bodies, stored strings). `Response.json()` of our own API responses is
// excluded: its SyntaxError quotes an HTML error page, not user content (documented disposition).
const PARSE_TRY = /JSON\.parse|stripJsonFences|safeParse\(|req\.json\(\)|request\.json\(\)/;
const CONTENT_FREE_CALL = /\b(?:contentFreeError|errorName|diagnosticCode|issueSummary)\([^)]*\)/g;

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

/** Leading message argument removed ONLY when it is a plain literal (a template with `${…}` is scanned). */
function argsOf(call: string): string {
  return call.slice(call.indexOf("(") + 1).replace(/^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)/, "");
}

/** Local log wrappers: `const warn = (m, d) => logger.warn(m, d)` / `function log(...) { console.log(...) }`. */
function wrapperNames(src: string): string[] {
  const names = new Set<string>();
  // Arrow-function forwarders only (`const warn = (m, d) => logger.warn(m, d)`, optionally behind one `if`). A named
  // function that merely STARTS with a log line (e.g. a row builder logging a length) is not a forwarder.
  const re = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*\\([^)]*\\)\\s*(?::[^=]*)?=>\\s*\\{?\\s*(?:if\\s*\\([^)]*\\)\\s*)?(?:${CALL_BASE})\\s*\\(`, "g");
  for (const m of src.matchAll(re)) names.add(m[1]!);
  return [...names];
}

/** Catch blocks whose try body parses text: any log of `<err>.message` / `.stack` / the whole error is content. */
/** Local functions whose body parses text — a `try` that CALLS one is a parse path too (synthesisReport's `callNarrative`). */
function parseHelperNames(src: string): string[] {
  const names: string[] = [];
  const defs = [...src.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>/g)];
  defs.forEach((d, i) => {
    const end = i + 1 < defs.length ? defs[i + 1].index! : src.length;
    if (PARSE_TRY.test(src.slice(d.index!, Math.min(end, d.index! + 4000)))) names.push((d[1] ?? d[2])!);
  });
  return names;
}

function parseCatchHits(src: string, file: string): string[] {
  const hits: string[] = [];
  const lines = src.split("\n");
  const helpers = parseHelperNames(src);
  const helperCall = helpers.length ? new RegExp(`\\b(?:${helpers.join("|")})\\s*\\(`) : null;
  lines.forEach((line, i) => {
    const m = line.match(/\}\s*catch\s*\((\w+)/);
    if (!m) return;
    const v = m[1];
    const indent = line.length - line.trimStart().length;
    let j = i - 1;
    while (j >= 0 && !(/^\s*try\s*\{/.test(lines[j]) && lines[j].length - lines[j].trimStart().length === indent)) j--;
    const tryBody = j < 0 ? "" : lines.slice(j, i).join("\n");
    if (j < 0 || !(PARSE_TRY.test(tryBody) || (helperCall !== null && helperCall.test(tryBody)))) return;
    let k = i + 1;
    while (k < lines.length && !(lines[k].trim().startsWith("}") && lines[k].length - lines[k].trimStart().length === indent)) k++;
    const body = lines.slice(i + 1, k).join("\n");
    const callRe = new RegExp(`\\b(?:${CALL_BASE})\\s*\\(`, "g");
    for (const c of body.matchAll(callRe)) {
      const args = argsOf(callText(body, c.index!)).replace(CONTENT_FREE_CALL, "");
      if (new RegExp(`\\b${v}\\??\\.(?:message|stack)\\b|(?:[:(,]\\s*)${v}\\s*(?=[,)}]|$)`).test(args)) {
        hits.push(`${file}:${i + 1} parse-path error message`);
      }
    }
  });
  return hits;
}

/** Scans one source text. Exported for the evasion-shape controls. */
export function scanSource(src: string, file: string): string[] {
  const hits: string[] = [];
  const wrappers = wrapperNames(src);
  const callRe = new RegExp(`\\b(?:${CALL_BASE}${wrappers.length ? "|" + wrappers.join("|") : ""})\\s*\\(`, "g");
  for (const m of src.matchAll(callRe)) {
    // skip the wrapper's own definition head (`const warn = (`)
    if (/(?:const|let|function)\s+\w*\s*=?\s*$/.test(src.slice(Math.max(0, m.index! - 30), m.index!))) continue;
    const args = argsOf(callText(src, m.index!));
    for (const [rule, re] of RULES) {
      if (re.test(args)) hits.push(`${file}:${src.slice(0, m.index).split("\n").length} ${rule}`);
    }
  }
  return [...hits, ...parseCatchHits(src, file)];
}

/**
 * Documented dispositions (PR #329 R3): parse-path catch blocks whose parsed text is NOT user / model content.
 * Keyed by file + rule; each entry says why. Anything new fails.
 */
const DISPOSITIONS: Record<string, string> = {
  "app/api/admin/keys/route.ts parse-path error message": "admin key-config request body (no user content)",
  "app/api/admin/purge-runs/route.ts parse-path error message": "admin purge parameters (ids, dates)",
  "app/api/admin/set-role/route.ts parse-path error message": "admin role request (uid, role)",
  "app/api/admin/sync-subscription/route.ts parse-path error message": "admin billing sync request (uid)",
  "app/api/admin/test-webhook/route.ts parse-path error message": "admin webhook test parameters",
  "app/api/admin/users/[uid]/override/route.ts parse-path error message": "admin plan override (plan ids)",
  "app/api/admin/users/[uid]/route.ts parse-path error message": "admin user mutation (flags)",
  "app/api/admin/users/[uid]/stripe/cancel/route.ts parse-path error message": "admin cancellation request",
  "app/api/billing/create-checkout-session/route.ts parse-path error message": "checkout request (plan / interval ids)",
  "app/api/billing/sync-plan/route.ts parse-path error message": "billing sync (no body content)",
  "app/billing/page.tsx parse-path error message": "billing page sync (plan data)",
  "lib/keyStore.ts parse-path error message": "local key-config file (operator credentials metadata, not user content; never in prod runtime)",
  "app/page.tsx parse-path error message":
    "hash-frozen file; client console only (Sentry console breadcrumbs are stripped at the boundary); the inner JSON.parse catch logs errorName only, so these outer catch-alls receive no parse excerpt",
  "components/PanelSynthesisView.tsx parse-path error message":
    "client console only; the inner parse catch now throws a content-free Error (class name only), so the outer catch receives no excerpt",
};

export function scanForContentLogging(): string[] {
  const hits: string[] = [];
  for (const d of DIRS) for (const f of files(join(ROOT, d))) hits.push(...scanSource(readFileSync(f, "utf8"), relative(ROOT, f)));
  return hits.filter((h) => !(h.replace(/:\d+ /, " ") in DISPOSITIONS));
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
      expect(scanSource(s, "sample.ts").length).toBeGreaterThan(0);
    }
  });
});

/**
 * R3 (review MINOR — guard evadable, and it missed MAJOR-1). Each sample is a
 * shape the reviewer showed slipping through, or the MAJOR-1 mechanism itself.
 */
describe("R3 guard — evasion shapes are caught", () => {
  const scanSnippet = (src: string): string[] => {
    return scanSource(src, "snippet.ts");
  };
  it.each([
    ["template interpolation", "logger.warn(`[x] failed ${result.rawText.slice(0, 120)}`);"],
    ["whole-value content", "logger.error(\"[x] failed\", { body: result.rawText });"],
    [".substr", "console.log(\"[x]\", { p: responseText.substr(0, 50) });"],
    ["console.trace/dir/table", "console.table(data.results);"],
    ["wrapper function", "const warn = (m: string, d?: unknown) => logger.warn(m, d);\nwarn(\"[x]\", { preview: markdown.substring(0, 80) });"],
    ["MAJOR-1 through a parse helper", "async function callNarrative() {\n  return JSON.parse(stripJsonFences(r.rawText));\n}\nasync function run() {\n  try {\n    await callNarrative();\n  } catch (err: any) {\n    logger.warn(\"[x] threw\", { error: err?.message });\n  }\n}"],
    ["MAJOR-1: err.message after JSON.parse", "try {\n  const p = JSON.parse(stripJsonFences(result.rawText));\n} catch (err: any) {\n  logger.warn(\"[x] threw\", { error: err?.message });\n}"],
  ])("%s", (_name, src) => {
    expect(scanSnippet(src).length).toBeGreaterThan(0);
  });
  it("control: content-free shapes pass", () => {
    expect(scanSnippet("logger.warn(\"[x] failed\", { length: result.rawText.length, errorName: errorName(err) });")).toEqual([]);
  });
});
