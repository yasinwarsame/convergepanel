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
 * The walker is deliberately CONSERVATIVE (type-only imports count as edges),
 * so it can only over-report reachability, never under-report it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT, loadFiles, resolveSpecifier, sourceFiles, type FileSet } from "./authoritySourceGraph";

const TOOL = [
  "lib/admin/systemAdminClaimSafety.ts",
  "lib/admin/systemAdminClaimExecution.ts",
  "scripts/admin/set-system-admin-claim.ts",
] as const;
const CLI = "scripts/admin/set-system-admin-claim.ts";

/** Every source the repository could ship or run (tests excluded by sourceFiles). */
const ROOTS = [
  "app", "lib", "components", "hooks", "scripts", "extension", "prisma",
  "middleware.ts", "instrumentation.ts", "instrumentation-client.ts",
  "sentry.edge.config.ts", "sentry.server.config.ts", "next.config.js",
];
const FILES: FileSet = loadFiles(sourceFiles(ROOTS));

/** Deployed entry points: everything Next.js can load from app/, plus the root runtime modules. */
function deployedEntries(files: FileSet): string[] {
  const roots = new Set(["middleware.ts", "instrumentation.ts", "instrumentation-client.ts", "sentry.edge.config.ts", "sentry.server.config.ts", "next.config.js"]);
  return [...files.keys()].filter((f) => f.startsWith("app/") || roots.has(f)).sort();
}

type Edges = { deps: string[]; unresolvable: string[] };

/** Every module dependency of one file, conservatively. Package specifiers are ignored (not repo code). */
function edgesOf(path: string, src: string, files: FileSet): Edges {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(js|jsx|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const deps = new Set<string>();
  const unresolvable: string[] = [];
  const add = (spec: string) => {
    const r = resolveSpecifier(path, spec, files);
    if (r) deps.add(r);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) add(n.moduleReference.expression.text);
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) add(n.argument.literal.text);
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isRequireResolve = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "require" && callee.name.text === "resolve";
      if (isDynImport || isRequire || isRequireResolve) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteralLike(a)) add(a.text);
        else unresolvable.push(`${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText(sf).slice(0, 80)}`);
      }
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

/** Direct importers of each tool module, across the WHOLE repository (deployed or not). */
function toolImporters(files: FileSet): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(TOOL.map((t) => [t, [] as string[]]));
  for (const [f, src] of files) {
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
