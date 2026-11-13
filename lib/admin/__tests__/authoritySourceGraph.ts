/**
 * SEC-3 / S2-b (M-1 / M-2) — PARSER-AWARE authority-source analysis, shared by
 * `app/api/admin/__tests__/privilegedAuthoritySources.spec.ts`.
 *
 * Two analyses over the TypeScript AST (the `typescript` compiler parser, not
 * regular expressions):
 *
 *   1. `findAdminClaimReads` — every READ of an `admin` member, however it is
 *      spelled: `x.admin`, `x?.admin`, `x["admin"]`, `x[`admin`]`, `x[K]` where
 *      `const K = "admin"`, destructuring (`{ admin }`, `{ admin: a }`,
 *      `{ "admin": a }`), `"admin" in x`, and the reflective getters
 *      `Reflect.get(x, "admin")`, `get(x, "admin")`, `hasOwnProperty` / `hasOwn`
 *      / `getOwnPropertyDescriptor`. Each read is reported with its file, the
 *      enclosing named function and its line, so an allow-list can name EXACTLY
 *      where a claim may be read (the verified guard, operator tooling), rather
 *      than exempting whole files.
 *
 *   2. `taintedExports` — a module-level TAINT PROPAGATION over the import graph.
 *      Seeds are (module, export) pairs that can yield an authority (for M-2:
 *      global governance scope). An export of any other module becomes tainted
 *      when its declaration references — directly or through a module-local
 *      helper, alias or re-export — a tainted binding. Imports are followed in
 *      every form: named (incl. `as` aliases), default, namespace (`* as N`),
 *      `export … from`, `export * from`, dynamic `import("…")` and `require("…")`.
 *      The result lists every tainted export and every file that imports one, so
 *      a NEW path to the authority (a wrapper, an alias, a file in a new
 *      directory) cannot appear without the pinned inventory changing.
 *
 * Known limits (stated, not hidden): computed keys built at runtime
 * (`x["ad" + "min"]`), access through `any`-typed indirection that never names
 * `admin` (e.g. `Object.values(claims)[0]`), and module specifiers built at
 * runtime are not resolvable statically. The behavioural specs, not this file,
 * are the proof that the guard decides from the live record.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

export const REPO_ROOT = join(__dirname, "..", "..", "..");

/** Every non-test JS/TS source under the given roots, repo-relative, sorted. */
export function sourceFiles(roots: string[], root = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) {
      out.push(rel);
      return;
    }
    for (const e of readdirSync(abs)) {
      if (e === "node_modules" || e === "__tests__" || e === "__fixtures__" || e.startsWith(".")) continue;
      const p = rel === "" ? e : `${rel}/${e}`;
      const st = statSync(join(root, p));
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(e) && !/\.(spec|test)\.[a-z]+$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return [...new Set(out)].sort();
}

/** A virtual or real file set: path -> source text. */
export type FileSet = Map<string, string>;
export function loadFiles(paths: string[], root = REPO_ROOT): FileSet {
  return new Map(paths.map((p) => [p, readFileSync(join(root, p), "utf8")]));
}

function parse(path: string, src: string): ts.SourceFile {
  const kind = /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
}

function enclosingName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isPropertyAssignment(p.parent)) return p.parent.name.getText();
  }
  return "<module>";
}

const KEY = "admin";
const REFLECTIVE = new Set(["get", "hasOwnProperty", "hasOwn", "getOwnPropertyDescriptor", "has"]);

export type ClaimRead = { file: string; fn: string; line: number; kind: string; text: string };

/** Every read of an `admin` member in one source text (see the file comment for the forms). */
export function findAdminClaimReads(path: string, src: string): ClaimRead[] {
  const sf = parse(path, src);
  // Module/function-scoped string constants equal to "admin" (alias keys).
  const keyConsts = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isTypeAssertionExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      if ((ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) && init.text === KEY) keyConsts.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const isKey = (e: ts.Node | undefined): boolean => {
    if (!e) return false;
    while (ts.isParenthesizedExpression(e as ts.Expression) || ts.isAsExpression(e as ts.Expression)) e = (e as ts.ParenthesizedExpression).expression;
    return ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === KEY) || (ts.isIdentifier(e) && keyConsts.has(e.text));
  };
  const out: ClaimRead[] = [];
  const add = (kind: string, n: ts.Node) =>
    out.push({ file: path, fn: enclosingName(n), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind, text: n.getText().replace(/\s+/g, " ").slice(0, 120) });
  const isWriteTarget = (n: ts.Node) =>
    n.parent && ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === KEY && !isWriteTarget(n)) add("member", n);
    else if (ts.isElementAccessExpression(n) && isKey(n.argumentExpression) && !isWriteTarget(n)) add("element", n);
    else if (ts.isBindingElement(n) && n.parent && ts.isObjectBindingPattern(n.parent)) {
      const k = n.propertyName ?? n.name;
      if ((ts.isIdentifier(k) && k.text === KEY) || isKey(k) || (ts.isComputedPropertyName(k) && isKey(k.expression))) add("destructure", n);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && isKey(n.left)) add("in", n);
    else if (ts.isCallExpression(n) && n.arguments.some((a) => isKey(a))) {
      const callee = n.expression;
      let name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      // `Object.prototype.hasOwnProperty.call(d, "admin")` / `.apply(…)`: the reflective name is one level up.
      if ((name === "call" || name === "apply") && ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
        name = callee.expression.name.text;
      }
      if (REFLECTIVE.has(name)) add("reflective", n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/* ------------------------------------------------------------------------- *
 * Import-graph taint propagation (M-2).
 * ------------------------------------------------------------------------- */

const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"];
/** Resolves `@/x` and relative specifiers to a repo-relative path inside `files`; null for packages. */
export function resolveSpecifier(from: string, spec: string, files: FileSet): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec)).replace(/\\/g, "/");
  else return null;
  for (const e of EXTS) if (files.has(base + e)) return base + e;
  return null;
}

type ModuleInfo = {
  /** local binding -> { module, imported name ("*" for namespace/whole-module) } */
  imports: Map<string, { from: string; name: string }>;
  /** whole-module dependencies (dynamic import, require, export * from) */
  wholeModuleDeps: Set<string>;
  /** export name -> local declaration name (or `from:<module>#<name>` for re-exports) */
  exports: Map<string, string>;
  /** local top-level name -> identifiers referenced in its declaration */
  refs: Map<string, Set<string>>;
  /** `export * from` targets */
  starFrom: string[];
};

function analyzeModule(path: string, src: string, files: FileSet): ModuleInfo {
  const sf = parse(path, src);
  const info: ModuleInfo = { imports: new Map(), wholeModuleDeps: new Set(), exports: new Map(), refs: new Map(), starFrom: [] };
  const identsIn = (n: ts.Node): Set<string> => {
    const s = new Set<string>();
    const v = (x: ts.Node) => {
      if (ts.isIdentifier(x)) s.add(x.text);
      // Dynamic import / require inside a declaration: whole-module dependency.
      if (ts.isCallExpression(x) && x.arguments.length > 0 && ts.isStringLiteralLike(x.arguments[0])) {
        const isReq = ts.isIdentifier(x.expression) && x.expression.text === "require";
        const isDyn = x.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isReq || isDyn) {
          const r = resolveSpecifier(path, (x.arguments[0] as ts.StringLiteral).text, files);
          if (r) {
            info.wholeModuleDeps.add(r);
            s.add(`__module__:${r}`);
          }
        }
      }
      ts.forEachChild(x, v);
    };
    v(n);
    return s;
  };
  const exported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const moduleRefs = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const r = resolveSpecifier(path, st.moduleSpecifier.text, files);
      const c = st.importClause;
      if (!r || !c) continue;
      if (c.name) info.imports.set(c.name.text, { from: r, name: "default" });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) info.imports.set(nb.name.text, { from: r, name: "*" });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) info.imports.set(el.name.text, { from: r, name: (el.propertyName ?? el.name).text });
      continue;
    }
    if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) {
      const r = resolveSpecifier(path, st.moduleReference.expression.text, files);
      if (r) info.imports.set(st.name.text, { from: r, name: "*" });
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      const r = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? resolveSpecifier(path, st.moduleSpecifier.text, files) : null;
      if (!st.exportClause) {
        if (r) info.starFrom.push(r);
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          info.exports.set(el.name.text, r ? `from:${r}#${local}` : local);
        }
      } else if (ts.isNamespaceExport(st.exportClause) && r) {
        info.exports.set(st.exportClause.name.text, `from:${r}#*`);
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      info.refs.set("default", identsIn(st.expression));
      info.exports.set("default", "default");
      continue;
    }
    const declare = (name: string, node: ts.Node) => {
      info.refs.set(name, identsIn(node));
      if (exported(st)) info.exports.set(isDefault(st) ? "default" : name, name);
    };
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) declare(st.name.text, st);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && !st.name && isDefault(st)) declare("default", st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const names: string[] = [];
        const bind = (b: ts.BindingName) => {
          if (ts.isIdentifier(b)) names.push(b.text);
          else for (const el of b.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
        };
        bind(d.name);
        for (const nm of names) declare(nm, d);
      }
    } else if (ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
      if (st.name && ts.isIdentifier(st.name)) declare(st.name.text, st);
    } else {
      // Top-level statements with side effects (e.g. module-level calls): their
      // references taint the module's whole-module surface.
      for (const id of identsIn(st)) moduleRefs.add(id);
    }
  }
  info.refs.set("<module>", moduleRefs);
  return info;
}

export type TaintSeed = { module: string; exports: string[]; reason: string };
export type TaintResult = {
  /** "module#export" -> reason chain */
  tainted: Map<string, string>;
  /** "module#export" -> sorted importer files */
  importers: Map<string, string[]>;
  /** importer file -> tainted symbols it imports */
  byImporter: Map<string, string[]>;
};

/**
 * Propagates taint from `seeds` through `files` to a fixpoint. A whole-module
 * import (namespace, dynamic import, require, `export * from`) of a module that
 * has ANY tainted export imports every tainted export of it.
 */
export function taintedExports(files: FileSet, seeds: TaintSeed[]): TaintResult {
  const mods = new Map<string, ModuleInfo>();
  for (const [p, src] of files) mods.set(p, analyzeModule(p, src, files));
  const tainted = new Map<string, string>();
  for (const s of seeds) {
    if (!mods.has(s.module)) throw new Error(`seed module not in file set: ${s.module}`);
    for (const e of s.exports) {
      if (!mods.get(s.module)!.exports.has(e)) throw new Error(`seed export not exported: ${s.module}#${e}`);
      tainted.set(`${s.module}#${e}`, `SEED: ${s.reason}`);
    }
  }
  const moduleTainted = (m: string) => [...tainted.keys()].some((k) => k.startsWith(`${m}#`));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [p, info] of mods) {
      // Which local bindings are tainted?
      const localTaint = new Map<string, string>();
      for (const [local, imp] of info.imports) {
        if (imp.name === "*" ? moduleTainted(imp.from) : tainted.has(`${imp.from}#${imp.name}`)) localTaint.set(local, `imports ${imp.from}#${imp.name}`);
      }
      for (const dep of info.wholeModuleDeps) if (moduleTainted(dep)) localTaint.set(`__module__:${dep}`, `loads ${dep}`);
      // Module-local closure over top-level declarations.
      let localChanged = true;
      while (localChanged) {
        localChanged = false;
        for (const [name, refs] of info.refs) {
          if (localTaint.has(name)) continue;
          const hit = [...refs].find((r) => localTaint.has(r) && r !== name);
          if (hit) {
            localTaint.set(name, `${name} -> ${hit}`);
            localChanged = true;
          }
        }
      }
      // Module-level side-effect statements taint every export.
      const moduleLevel = localTaint.get("<module>");
      const mark = (key: string, why: string) => {
        if (!tainted.has(key)) {
          tainted.set(key, why);
          changed = true;
        }
      };
      for (const [exp, local] of info.exports) {
        if (local.startsWith("from:")) {
          const [mod, name] = local.slice(5).split("#");
          if (name === "*" ? moduleTainted(mod) : tainted.has(`${mod}#${name}`)) mark(`${p}#${exp}`, `re-exports ${mod}#${name}`);
        } else if (localTaint.has(local)) mark(`${p}#${exp}`, localTaint.get(local)!);
        else if (moduleLevel) mark(`${p}#${exp}`, `module-level: ${moduleLevel}`);
      }
      for (const from of info.starFrom) {
        for (const k of [...tainted.keys()]) {
          if (!k.startsWith(`${from}#`)) continue;
          const name = k.slice(from.length + 1);
          if (name !== "default") mark(`${p}#${name}`, `export * from ${from}`);
        }
      }
    }
  }
  // Importer table.
  const importers = new Map<string, Set<string>>();
  const byImporter = new Map<string, Set<string>>();
  const edge = (key: string, file: string) => {
    if (!importers.has(key)) importers.set(key, new Set());
    importers.get(key)!.add(file);
    if (!byImporter.has(file)) byImporter.set(file, new Set());
    byImporter.get(file)!.add(key);
  };
  for (const [p, info] of mods) {
    for (const imp of info.imports.values()) {
      if (imp.name === "*") {
        for (const k of tainted.keys()) if (k.startsWith(`${imp.from}#`)) edge(k, p);
      } else if (tainted.has(`${imp.from}#${imp.name}`)) edge(`${imp.from}#${imp.name}`, p);
    }
    for (const dep of [...info.wholeModuleDeps, ...info.starFrom]) for (const k of tainted.keys()) if (k.startsWith(`${dep}#`)) edge(k, p);
    for (const local of info.exports.values()) {
      if (!local.startsWith("from:")) continue;
      const [mod, name] = local.slice(5).split("#");
      for (const k of tainted.keys()) if (k === `${mod}#${name}` || (name === "*" && k.startsWith(`${mod}#`))) edge(k, p);
    }
  }
  const sortMap = (m: Map<string, Set<string>>) => new Map([...m.entries()].map(([k, v]) => [k, [...v].sort()] as [string, string[]]).sort(([a], [b]) => a.localeCompare(b)));
  return { tainted: new Map([...tainted.entries()].sort(([a], [b]) => a.localeCompare(b))), importers: sortMap(importers), byImporter: sortMap(byImporter) };
}

export const repoRelative = (abs: string) => relative(REPO_ROOT, abs).replace(/\\/g, "/");
