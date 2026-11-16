/**
 * PR #295 × S2-b — OPERATOR-ONLY REACHABILITY of the SYSTEM_ADMIN claim tool
 * (owner ruling A).
 *
 * The claim tool reads and writes the `admin` custom claim. S2-b's authority
 * pins (privilegedGuardPin.spec.ts, privilegedAuthoritySources.spec.ts) allow
 * those reads ONLY because the tool is offline operator code. This spec is the
 * independent proof of that premise. It fails if:
 *
 *   1. any DEPLOYED entry point — every module under app/ (routes, pages,
 *      layouts, server actions), middleware.ts, the instrumentation and Sentry
 *      configs, next.config.js — can reach a tool module through ANY chain of
 *      static imports (including side-effect and type-only), `export … from`
 *      re-exports and barrels, `export * from`, `import x = require()`,
 *      dynamic `import()`, CommonJS `require()` / `require.resolve()`, or the
 *      `@/` path alias;
 *   2. a module reachable from a deployed entry point contains a dynamic
 *      import or require whose target is NOT a string literal (fail-closed:
 *      the walker cannot see where it goes);
 *   3. anything other than the intended CLI entry point (and the tool's own
 *      modules) imports a tool module, anywhere in the repository;
 *   4. tsconfig declares a path alias this walker does not resolve.
 *
 * The walker is deliberately CONSERVATIVE: type-only imports count as edges,
 * `require.context` reaches every code file under its directory, and the file
 * set is the WHOLE repository (minus node_modules, .next, .git and build
 * output; test HELPERS included, spec files too) so nothing is out of view.
 * Any `@/` or relative specifier that resolves to no file at all, and any
 * module-loading form it cannot follow (non-literal targets, aliased
 * `require`, `module.require`, `createRequire`), is reported as UNRESOLVABLE
 * and fails the pin (review round 1, findings 1-2): it can over-report, and it
 * refuses to silently under-report.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT, type FileSet } from "./authoritySourceGraph";

const TOOL = [
  "lib/admin/systemAdminClaimSafety.ts",
  "lib/admin/systemAdminClaimExecution.ts",
  "scripts/admin/set-system-admin-claim.ts",
] as const;
const CLI = "scripts/admin/set-system-admin-claim.ts";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** Skipped at ANY depth: package code and VCS metadata (a relative import into them resolves to no FILES entry and fails closed). */
const SKIP_ANYWHERE = new Set(["node_modules", ".git"]);
/** Build output skipped at the REPO ROOT only (review round 2: a nested `lib/build/` is repo code and must be walked). */
const SKIP_AT_ROOT = new Set([".next", ".vercel", "coverage", "dist", "build", "out", ".turbo"]);
/** Symlinks met during the walk: never followed; the pin fails if any exists (review round 2, finding 2). */
const SYMLINKS: string[] = [];
/** The WHOLE repository's code (not only fixed roots; test helpers included), as a FileSet. */
function wholeRepoFiles(root = REPO_ROOT): FileSet {
  const out: FileSet = new Map();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel))) {
      if (SKIP_ANYWHERE.has(e) || (rel === "" && SKIP_AT_ROOT.has(e))) continue;
      const r = rel ? `${rel}/${e}` : e;
      const lst = lstatSync(join(root, r));
      if (lst.isSymbolicLink()) { SYMLINKS.push(r); continue; }
      if (lst.isDirectory()) walk(r);
      else if (CODE.test(e) && !e.endsWith(".d.ts")) out.set(r, readFileSync(join(root, r), "utf8"));
    }
  };
  walk("");
  return out;
}
const FILES: FileSet = wholeRepoFiles();

const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const INDEX = EXTS.filter(Boolean).map((e) => `/index${e}`);
type Resolution = { code: string } | { asset: string } | { missing: true } | { pkg: true };
/** Resolves `@/` and relative specifiers. A target that is no file at all is MISSING (fail-closed). */
function resolveRepo(from: string, spec: string, files: FileSet): Resolution {
  let base: string;
  if (spec.startsWith("@/")) base = normalize(spec.slice(2)).replace(/\\/g, "/"); // review round 2: "@/lib/../lib/x" is normalised too
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec)).replace(/\\/g, "/");
  else return { pkg: true };
  for (const e of [...EXTS, ...INDEX]) if (files.has(base + e)) return { code: base + e };
  const m = /^(.*)\.(js|jsx|mjs|cjs)$/.exec(base);
  if (m) for (const e of [".ts", ".tsx", ".mts", ".cts"]) if (files.has(m[1] + e)) return { code: m[1] + e };
  // A real NON-CODE file (css, json, svg …) is a leaf. A CODE file the walker does not hold (skipped
  // directory, symlink, outside the repo) is MISSING: fail closed (review round 2, finding 1).
  if (!CODE.test(base) && !base.startsWith("..") && existsSync(join(REPO_ROOT, base)) && statSync(join(REPO_ROOT, base)).isFile()) return { asset: base };
  return { missing: true };
}

/** A spec/test FILE is never deployed (a test HELPER is only reachable if deployed code imports it). */
const isSpecFile = (f: string) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(f);
/** Deployed entry points: every non-spec module Next.js can load from app/, plus the root runtime modules. */
function deployedEntries(files: FileSet): string[] {
  const roots = new Set(["middleware.ts", "instrumentation.ts", "instrumentation-client.ts", "sentry.edge.config.ts", "sentry.server.config.ts", "next.config.js"]);
  return [...files.keys()].filter((f) => (f.startsWith("app/") && !isSpecFile(f)) || roots.has(f)).sort();
}

type Edges = { deps: string[]; unresolvable: string[] };

/** Every module dependency of one file, conservatively. Package specifiers are ignored (not repo code). */
function edgesOf(path: string, src: string, files: FileSet): Edges {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(js|jsx|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const deps = new Set<string>();
  const unresolvable: string[] = [];
  const where = (n: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const add = (spec: string, n: ts.Node) => {
    const r = resolveRepo(path, spec, files);
    if ("code" in r) deps.add(r.code);
    else if ("missing" in r) unresolvable.push(`${where(n)} unresolved repo specifier ${JSON.stringify(spec)}`);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text, n);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) add(n.moduleReference.expression.text, n);
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) add(n.argument.literal.text, n);
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isRequireResolve = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "require" && callee.name.text === "resolve";
      const isRequireContext = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "require" && callee.name.text === "context";
      const isModuleRequire = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "module" && callee.name.text === "require";
      const isCreateRequire = ts.isIdentifier(callee) && callee.text === "createRequire";
      const a = n.arguments[0];
      if (isRequireContext) {
        // webpack bundles every match under the directory: conservatively, every code file under it.
        if (a && ts.isStringLiteralLike(a) && a.text.startsWith(".")) {
          const dir = normalize(join(dirname(path), a.text)).replace(/\\/g, "/").replace(/\/$/, "");
          for (const f of files.keys()) if (f.startsWith(`${dir}/`)) deps.add(f);
        } else unresolvable.push(`${where(n)} require.context with a non-literal or non-relative directory`);
      } else if (isModuleRequire || isCreateRequire) {
        unresolvable.push(`${where(n)} ${isCreateRequire ? "createRequire" : "module.require"} (not followed)`);
      } else if (isDynImport || isRequire || isRequireResolve) {
        if (a && ts.isStringLiteralLike(a)) add(a.text, n);
        else unresolvable.push(`${where(n)} non-literal ${n.getText(sf).slice(0, 80)}`);
      }
    }
    // `require` used as a VALUE (aliased: const r = require; r(...)) cannot be followed: fail closed.
    if (ts.isIdentifier(n) && n.text === "require" && n.parent && !(ts.isCallExpression(n.parent) && n.parent.expression === n)
      && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
      && !(ts.isTypeOfExpression(n.parent))
      && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
      && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
      && !(ts.isImportSpecifier(n.parent) || ts.isExportSpecifier(n.parent))) {
      unresolvable.push(`${where(n)} require used as a value (aliased require)`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { deps: [...deps].sort(), unresolvable };
}

/** Breadth-first closure from the deployed entry points, with a parent map for diagnostics. */
function reach(files: FileSet) {
  const parent = new Map<string, string | null>();
  const unresolvable: string[] = [];
  const queue = deployedEntries(files);
  for (const e of queue) parent.set(e, null);
  for (let i = 0; i < queue.length; i++) {
    const f = queue[i];
    const { deps, unresolvable: u } = edgesOf(f, files.get(f)!, files);
    unresolvable.push(...u);
    for (const d of deps) {
      if (!parent.has(d)) {
        parent.set(d, f);
        queue.push(d);
      }
    }
  }
  const chain = (f: string) => {
    const out = [f];
    for (let p = parent.get(f); p; p = parent.get(p)) out.push(p);
    return out.reverse().join(" -> ");
  };
  return { reached: new Set(parent.keys()), unresolvable, chain };
}

/** Direct NON-SPEC importers of each tool module, across the WHOLE repository (deployed or not; helpers included). */
function toolImporters(files: FileSet): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(TOOL.map((t) => [t, [] as string[]]));
  for (const [f, src] of files) {
    if (isSpecFile(f)) continue;
    for (const d of edgesOf(f, src, files).deps) if (d in out) out[d].push(f);
  }
  for (const t of TOOL) out[t].sort();
  return out;
}

/** The forbidden result for a file set: which tool modules a deployed entry point reaches, and how. */
function deployedToolPaths(files: FileSet): string[] {
  const { reached, chain } = reach(files);
  return TOOL.filter((t) => reached.has(t)).map(chain);
}

const withFiles = (extra: Record<string, string>): FileSet => {
  const m = new Map(FILES);
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
};
const ROUTE = "app/api/admin/access/route.ts";
const routeWith = (line: string) => `${line}\n${FILES.get(ROUTE)}`;

describe("PR #295 claim tool is operator-only: unreachable from every deployed module", () => {
  it("the walker sees the repository and the deployed graph (positive controls)", () => {
    for (const t of TOOL) expect(FILES.has(t)).toBe(true);
    const entries = deployedEntries(FILES);
    expect(entries).toContain(ROUTE);
    expect(entries).toContain("middleware.ts");
    expect(entries.length).toBeGreaterThan(100);
    const { reached } = reach(FILES);
    // Reached only transitively (routes import them): proves the closure walks dependencies.
    for (const deep of ["lib/admin/privilegedAccess.ts", "lib/firebase/admin.ts", "lib/admin/auditLog.ts"]) expect({ deep, reached: reached.has(deep) }).toEqual({ deep, reached: true });
  });

  it("NO deployed entry point reaches any tool module, by any import chain", () => {
    expect(deployedToolPaths(FILES)).toEqual([]);
  });

  it("FAIL-CLOSED: no module reachable from a deployed entry point has a dynamic import / require the walker cannot resolve", () => {
    expect(reach(FILES).unresolvable).toEqual([]);
  });

  it("the CLI entry point is the only runtime consumer: exact importer census across the whole repository", () => {
    expect(toolImporters(FILES)).toEqual({
      "lib/admin/systemAdminClaimSafety.ts": ["lib/admin/systemAdminClaimExecution.ts", CLI].sort(),
      "lib/admin/systemAdminClaimExecution.ts": [CLI],
      [CLI]: [],
    });
  });

  it("FAIL-CLOSED: the repository contains no symlink (a symlinked directory would index the tool under another name)", () => {
    expect(SYMLINKS).toEqual([]);
  });

  it("there is no second Next.js root (pages/, src/app, src/pages) the entry list would miss", () => {
    for (const d of ["pages", "src/app", "src/pages"]) expect({ d, exists: existsSync(join(REPO_ROOT, d)) }).toEqual({ d, exists: false });
    // and next.config.js declares no webpack resolve.alias the resolver would not know
    expect(readFileSync(join(REPO_ROOT, "next.config.js"), "utf8")).not.toMatch(/resolve\s*\.\s*alias|alias\s*:/);
  });

  it("every tsconfig path alias is one the walker resolves (a new alias cannot hide an import)", () => {
    const tsconfig = JSON.parse(readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./*"] });
  });

  describe("negative controls — each deliberately unsafe mutation is caught", () => {
    const MUTANTS: Array<[string, Record<string, string>]> = [
      ["direct static import in a route", { [ROUTE]: routeWith('import { planClaimChange } from "@/lib/admin/systemAdminClaimSafety";') }],
      ["side-effect import in a route", { [ROUTE]: routeWith('import "@/lib/admin/systemAdminClaimSafety";') }],
      ["type-only import in a route (conservative)", { [ROUTE]: routeWith('import type { ParsedClaimArgs } from "@/lib/admin/systemAdminClaimSafety";') }],
      ["relative path from a route", { [ROUTE]: routeWith('import { planClaimChange } from "../../../../lib/admin/systemAdminClaimSafety";') }],
      ["indirect barrel export (lib/admin/index.ts) imported as @/lib/admin", {
        "lib/admin/index.ts": 'export * from "./systemAdminClaimExecution";\n',
        [ROUTE]: routeWith('import * as admin from "@/lib/admin";'),
      }],
      ["named re-export through an innocuous lib module", {
        "lib/util/claimHelpers.ts": 'export { planClaimChange as plan } from "../admin/systemAdminClaimSafety";\n',
        [ROUTE]: routeWith('import { plan } from "@/lib/util/claimHelpers";'),
      }],
      ["dynamic import() deep in a lib module a route uses", {
        "lib/util/lazy.ts": 'export async function load() { return import("@/lib/admin/systemAdminClaimExecution"); }\n',
        [ROUTE]: routeWith('import { load } from "@/lib/util/lazy";'),
      }],
      ["CommonJS require in a lib module a route uses", {
        "lib/util/cjs.js": 'module.exports = function f() { return require("../admin/systemAdminClaimSafety"); };\n',
        [ROUTE]: routeWith('import f from "@/lib/util/cjs";'),
      }],
      ["import x = require() in a route", { [ROUTE]: routeWith('import tool = require("@/lib/admin/systemAdminClaimSafety");') }],
      ["middleware reaching the CLI script itself", { "middleware.ts": `import "@/scripts/admin/set-system-admin-claim";\n${FILES.get("middleware.ts")}` }],
    ];

    it.each(MUTANTS)("%s → a deployed path to the tool is reported", (_label, extra) => {
      const paths = deployedToolPaths(withFiles(extra));
      expect(paths.length).toBeGreaterThan(0);
      // The diagnostic names a deployed entry point at the head of the chain.
      expect(paths.some((p) => /^(app\/|middleware\.ts)/.test(p))).toBe(true);
    });

    it.each([
      ["new top-level directory outside the old roots", { "server/adminGate.ts": 'export * from "../lib/admin/systemAdminClaimSafety";\n', [ROUTE]: routeWith('import * as g from "@/server/adminGate";') }],
      ["non-spec test helper imported by a route", { "lib/util/__tests__/gateHelper.ts": 'export { planClaimChange } from "../../admin/systemAdminClaimSafety";\n', [ROUTE]: routeWith('import { planClaimChange } from "@/lib/util/__tests__/gateHelper";') }],
      ["barrel at index.jsx", { "lib/x/index.jsx": 'export * from "../admin/systemAdminClaimSafety";\n', [ROUTE]: routeWith('import * as x from "@/lib/x";') }],
      ["barrel at index.mjs", { "lib/y/index.mjs": 'export * from "../admin/systemAdminClaimSafety";\n', [ROUTE]: routeWith('import * as y from "@/lib/y";') }],
      ["webpack require.context over lib/admin", { [ROUTE]: routeWith('const ctx = require.context("../../../../lib/admin", false, /systemAdminClaim/);') }],
      ["review round 2: nested lib/build/ directory with an explicit .js specifier", { "lib/build/gate.js": 'module.exports = require("../admin/systemAdminClaimSafety");\n', [ROUTE]: routeWith('import g from "@/lib/build/gate.js";') }],
      ["review round 2: un-normalised @/ path with an explicit .ts extension", { [ROUTE]: routeWith('import * as g from "@/lib/../lib/admin/systemAdminClaimSafety.ts";') }],
      ["review round 2: @/./ path", { [ROUTE]: routeWith('import * as g from "@/./lib/admin/systemAdminClaimSafety";') }],
    ] as Array<[string, Record<string, string>]>)("review round 1: %s → reached", (_l, extra) => {
      expect(deployedToolPaths(withFiles(extra)).length).toBeGreaterThan(0);
    });

    it.each([
      ["an unresolvable repo specifier (target file absent)", 'import "@/lib/does/not/exist";'],
      ["a CODE file outside the walked set, named with its extension (review round 2)", 'import g from "@/node_modules/whatever/index.js";'],
      ["aliased require", 'const r = require; r("../../../../lib/admin/systemAdminClaimSafety");'],
      ["module.require", 'module.require("../../../../lib/admin/systemAdminClaimSafety");'],
      ["createRequire", 'import { createRequire } from "node:module"; const rq = createRequire(import.meta.url);'],
    ])("review round 1: %s in a route → reported as unresolvable (fail-closed)", (_l, line) => {
      expect(reach(withFiles({ [ROUTE]: routeWith(line) })).unresolvable.some((u) => u.startsWith(`${ROUTE}:`))).toBe(true);
    });

    it("a non-literal dynamic import in a reachable module is reported as unresolvable (fail-closed)", () => {
      const fs = withFiles({
        "lib/util/opaque.ts": 'export async function load(p: string) { return import(p); }\n',
        [ROUTE]: routeWith('import { load } from "@/lib/util/opaque";'),
      });
      expect(reach(fs).unresolvable.some((u) => u.startsWith("lib/util/opaque.ts:"))).toBe(true);
    });

    it("a second, non-deployed consumer (another script) fails the importer census", () => {
      const fs = withFiles({ "scripts/admin/other-tool.ts": 'import { planClaimChange } from "../../lib/admin/systemAdminClaimSafety";\n' });
      expect(deployedToolPaths(fs)).toEqual([]); // not deployed …
      expect(toolImporters(fs)["lib/admin/systemAdminClaimSafety.ts"]).toContain("scripts/admin/other-tool.ts"); // … but caught here
    });

    it("an unrelated new lib import does not trip the pin (no false positive)", () => {
      const fs = withFiles({
        "lib/util/benign.ts": 'export const x = 1;\n',
        [ROUTE]: routeWith('import { x } from "@/lib/util/benign";'),
      });
      expect(deployedToolPaths(fs)).toEqual([]);
    });
  });
});
