/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B-C2 — the ONE place the Team Video POST
 * contract is read from source, shared by the concealment proof and the
 * rejection-vocabulary proof.
 *
 * WHY THIS EXISTS. Both proofs previously carried their own copy of "which
 * modules and which helpers to read", and both copies were wrong in a way that
 * passed:
 *
 *   - the concealment proof searched a hardcoded list of candidate modules with
 *     first-match `indexOf`, so a same-named decoy in a module the route does
 *     NOT import shadowed the real, route-imported helper — a genuinely leaking
 *     helper stayed green;
 *   - both proofs used a hand-maintained allow-list of helper names, so a NEW
 *     denial helper imported and called by POST emitted an unclassifiable
 *     sub-500 code with the suite still green.
 *
 * That is the same "validated against a hand-copied list" defect the
 * vocabulary proof was written to kill, one level down. So nothing here is
 * hand-listed: the import map, the reached-helper set and each helper's source
 * module are all derived from the route itself.
 *
 * SCOPE, STATED HONESTLY. This is a lexical/structural scanner, NOT a
 * TypeScript analyzer. It models the conventions this route uses today: named
 * `import { … } from "@/…"` lines, exported `function *Response()` helpers,
 * module-level denial delegates declared in the route and called from POST,
 * and error returns carrying a literal double-quoted lowercase code with a
 * literal 3-digit status.
 *
 * WHAT IS AND IS NOT COVERED. The delegate model is DIRECT calls from POST's
 * own lexical body to named top-level callables declared in this same module,
 * classified structurally through the TypeScript AST — `function`,
 * `async function`, `export function`, `const f = () => {}`,
 * `const f = function () {}` and their exported/async variants are all the
 * same to it, because an earlier regex recognised only the first spelling and
 * three ordinary alternatives silently escaped. NOT covered, and not claimed:
 * a delegate reached only through another delegate, a factory-produced
 * handler, a method or property call, another module's internals, or
 * whole-program reachability. A direct call to a same-module binding this
 * model cannot classify is REPORTED through `unresolvedPostBindings`.
 *
 * WHAT FAIL-CLOSED MEANS HERE, PRECISELY. A returned expression is treated as
 * an ERROR CANDIDATE when it carries `ok: false`, an `errorCode:` key or a
 * quoted `code:` key. For a candidate, a code or status this scanner cannot
 * read as a literal is reported through `unsupported`/`unresolved` — asserted
 * empty by the consuming proof — so a ternary status, a single-quoted code, a
 * code containing a digit, or a response object assembled in a variable breaks
 * the proof loudly instead of quietly narrowing the derived vocabulary.
 *
 * The guarantee is deliberately bounded to candidates. A return that carries no
 * error marker at all — a success payload, a helper returning data — is
 * ignored, not reported: "fail closed" must not degenerate into "fail on any
 * unfamiliar syntax", or the proof becomes noise and gets weakened to silence
 * it.
 *
 * Still outside the model, and NOT claimed: helper factories, dynamic imports
 * and general call-graph reachability. The route does contain one dynamic
 * `await import(...)` (the rate limiter), which carries no error code and so
 * cannot affect the rejection vocabulary — the earlier blanket claim that no
 * unsupported form exists here was wrong, and this is the accurate statement.
 *
 * Test-support only. Nothing here is imported by production code.
 */

import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

export const ROUTE_PATH = "app/api/workspaces/[workspaceId]/video-verifications/route.ts";

/** The banner that begins the GET half of the route file. */
const GET_SECTION = "// TEAM-VERIFICATION-PARITY-R5-I1 — GET";

export const readSource = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

export function routeSource(): string {
  return readSource(ROUTE_PATH);
}

/**
 * POST's analysable region: the handler body PLUS its own identity helper,
 * which is declared ABOVE POST and therefore outside any forward slice. The
 * GET half is excluded — it has its own identity helper and its own response
 * vocabulary, and a slice running to `export async function GET` swallows it.
 */
function sourceFile(src: string): ts.SourceFile {
  return ts.createSourceFile(ROUTE_PATH, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function postDeclaration(sf: ts.SourceFile): ts.FunctionDeclaration {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === "POST" && st.body) return st;
  }
  throw new Error("teamVideoRouteContract: cannot locate the POST declaration");
}

/** The POST handler body alone. */
export function postBody(src = routeSource()): string {
  const sf = sourceFile(src);
  return postDeclaration(sf).getText(sf);
}

/**
 * What a top-level name in the route module IS.
 *
 * `unsupported` is the load-bearing member. A regex that recognised only
 * `function name(` treated `export function`, `const name = () => {}` and
 * `const name = function () {}` as if they did not exist — three ordinary
 * spellings, each of which let a real POST denial delegate emit an
 * unclassified code with every test green. Classification is structural now,
 * so spelling cannot create an escape; and a binding whose shape this model
 * does NOT recognise is recorded rather than ignored, so the next unmodelled
 * form fails loudly instead of silently.
 */
type TopLevelBinding =
  | { kind: "callable"; text: string }
  | { kind: "unsupported"; why: string }
  | { kind: "imported"; module: string };

function topLevelBindings(sf: ts.SourceFile): Map<string, TopLevelBinding> {
  const map = new Map<string, TopLevelBinding>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      const mod = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
      for (const el of st.importClause.namedBindings.elements) map.set(el.name.text, { kind: "imported", module: mod });
      continue;
    }
    // `function f()`, `async function f()`, `export function f()`, `export async function f()`
    if (ts.isFunctionDeclaration(st) && st.name) {
      map.set(st.name.text, { kind: "callable", text: st.getText(sf) });
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        // `const f = () => {}`, `const f = async () => {}`, `const f = function () {}`
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          map.set(d.name.text, { kind: "callable", text: d.getText(sf) });
        } else {
          map.set(d.name.text, {
            kind: "unsupported",
            why: init ? `bound to ${ts.SyntaxKind[init.kind]}, not a recognized callable form` : "declared without an initializer",
          });
        }
      }
      continue;
    }
    if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
      map.set(st.name.text, { kind: "unsupported", why: `declared as ${ts.SyntaxKind[st.kind]}` });
    }
  }
  return map;
}

/**
 * Identifiers CALLED directly in a function's own lexical body.
 *
 * Nested function bodies are deliberately not descended into: their calls are
 * not POST's direct calls, and claiming otherwise would overstate the depth
 * this model actually covers.
 */
function directCalls(node: ts.Node, sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (n !== node && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.add(n.expression.text);
    n.forEachChild(visit);
  };
  node.forEachChild(visit);
  return names;
}

/**
 * Direct calls made inside one delegate's own body.
 *
 * The delegate text is re-parsed and the traversal STARTS at its function-like
 * node. Starting at the synthetic SourceFile instead would make that very
 * declaration look like a nested function and skip it wholesale — which is how
 * `mapGateDenial`'s two Project helpers briefly stopped being discovered.
 */
function callsWithin(declarationText: string): Set<string> {
  const sf = ts.createSourceFile("delegate.ts", declarationText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) return directCalls(st, sf);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return directCalls(init, sf);
      }
    }
  }
  return new Set<string>();
}

/**
 * Same-module top-level callables POST calls DIRECTLY — its identity helper and
 * its denial delegates. Derived structurally; declaration spelling and `export`
 * are irrelevant.
 */
export function postDelegates(src = routeSource()): { name: string; body: string }[] {
  const sf = sourceFile(src);
  const bindings = topLevelBindings(sf);
  const out: { name: string; body: string }[] = [];
  for (const name of directCalls(postDeclaration(sf), sf)) {
    const b = bindings.get(name);
    if (b?.kind === "callable") out.push({ name, body: b.text });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Identifiers POST calls directly that ARE same-module top-level bindings but
 * whose shape this model does not recognise — e.g. `const denial =
 * makeHandler(...)` then `denial(...)`. The factory is deliberately not
 * analysed; what matters is that such a call cannot vanish from a proof
 * claiming direct-delegate coverage.
 *
 * Imported identifiers are excluded (the imported-helper model owns those) and
 * so are globals/builtins, which are not same-module bindings at all.
 */
export function unresolvedPostBindings(src = routeSource()): string[] {
  const sf = sourceFile(src);
  const bindings = topLevelBindings(sf);
  const out: string[] = [];
  for (const name of directCalls(postDeclaration(sf), sf)) {
    const b = bindings.get(name);
    if (b?.kind === "unsupported") out.push(`${name}: ${b.why}`);
  }
  return out.sort();
}

/**
 * POST's own body plus every same-module top-level callable it calls DIRECTLY.
 *
 * Deliberately not "everything POST can emit from": a delegate called only by
 * another delegate (depth 2), a factory-produced handler, a method call and any
 * other module's internals are outside this model. What the model does not
 * recognise is reported through `unresolvedPostBindings`, not assumed absent.
 */
export function postScope(src = routeSource()): string {
  return [postBody(src), ...postDelegates(src).map((d) => d.body)].join("\n");
}

/** Everything from the GET banner onwards — used only to prove POST excludes it. */
export function getScope(src = routeSource()): string {
  const at = src.indexOf(GET_SECTION);
  if (at < 0) throw new Error("teamVideoRouteContract: cannot locate the GET section");
  return src.slice(at);
}

/** Every named import the route declares, as symbol -> module path. */
export function importMap(src = routeSource()): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/([^"]+)"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name) map.set(name, `${m[2]}.ts`);
    }
  }
  return map;
}

/**
 * Every imported `*Response` helper POST actually reaches — directly, or
 * through a module-level delegate such as `mapGateDenial`.
 *
 * Derived, never listed. Adding a new denial helper to the route puts it here
 * automatically, which is what makes the vocabulary proof's completeness real
 * rather than a promise about a hand-maintained array.
 */
/**
 * Imported `*Response` helpers reached by POST — called directly by POST or by
 * one of its direct delegates. Imported bindings only: same-module callables
 * belong to the delegate model, so no emission is counted twice.
 */
export function reachedResponseHelpers(src = routeSource()): string[] {
  const sf = sourceFile(src);
  const bindings = topLevelBindings(sf);
  // Direct calls made by POST, plus those made by each delegate it calls.
  const called = new Set<string>(directCalls(postDeclaration(sf), sf));
  for (const d of postDelegates(src)) {
    for (const n of callsWithin(d.body)) called.add(n);
  }
  const reached: string[] = [];
  for (const name of called) {
    if (!/Response$/.test(name)) continue;
    if (bindings.get(name)?.kind === "imported") reached.push(name);
  }
  return reached.sort();
}

/**
 * A reached helper's source, resolved through the route's OWN import line.
 *
 * Two modules in this repository export identically named
 * `invalidRequestBodyResponse` / `unexpectedFieldResponse` with identical
 * codes. Searching a candidate list finds whichever comes first; only the
 * import line says which one POST compiles against.
 *
 * Returns `null` when the symbol is not imported or its definition cannot be
 * found — callers assert those are absent rather than skipping them.
 */
export function helperBody(symbol: string, src = routeSource()): string | null {
  const modulePath = importMap(src).get(symbol);
  if (!modulePath) return null;
  const moduleSrc = readSource(modulePath);
  const at = moduleSrc.indexOf(`export function ${symbol}`);
  if (at < 0) return null;
  const end = moduleSrc.indexOf("\n}", at);
  if (end < 0) return null;
  return moduleSrc.slice(at, end);
}

export type Emission = { code: string; status: number };

/**
 * Pair a code with its status WITHIN ONE `return` statement.
 *
 * A character-window regex pairs across statement boundaries — an earlier
 * version reported a 503-only code as sub-500 by borrowing a neighbouring 4xx.
 * Splitting on `return` keeps every pairing inside the emission it belongs to.
 * A return whose status or code is not a literal yields nothing rather than
 * borrowing from its neighbour.
 */
function scan(code: string): { emissions: Emission[]; unsupported: string[] } {
  const emissionsOut: Emission[] = [];
  const unsupported: string[] = [];
  for (const chunk of code.split(/\breturn\b/).slice(1)) {
    // Bound the chunk at the end of the returned expression so a later
    // statement's tokens cannot be read as part of this one.
    const body = chunk.split(/\n\s*(?:const|let|if|for|while|return)\b/)[0];

    // Is this an ERROR emission at all? A success payload or a data-returning
    // helper carries none of these markers and is ignored rather than
    // reported — fail-closed must not mean "fail on any unfamiliar syntax".
    const isCandidate = /\bok:\s*false/.test(body) || /errorCode\s*:/.test(body) || /\bcode\s*:\s*['"`]/.test(body);
    if (!isCandidate) continue;

    const status = /status:\s*(\d{3})\b/.exec(body);
    const literalCode = /errorCode:\s*"([a-z_]+)"/.exec(body) ?? /\bcode:\s*"([a-z_]+)"/.exec(body);

    if (status && literalCode) {
      emissionsOut.push({ code: literalCode[1], status: Number(status[1]) });
      continue;
    }
    // A relevant candidate whose code or status this scanner cannot read as a
    // literal. Reported, never dropped: a ternary status, a single-quoted or
    // digit-bearing code, or an object assembled in a variable lands here.
    const why = !status && !literalCode ? "no literal status and no literal code"
      : !status ? "no literal status (ternary/variable?)"
      : "no literal double-quoted lowercase code";
    unsupported.push(`${why}: ${body.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  }
  return { emissions: emissionsOut, unsupported };
}

/** Modelled emissions only. Use `scanUnsupported` for the fail-closed signal. */
export function emissions(code: string): Emission[] {
  return scan(code).emissions;
}

/** Error candidates whose code or status this scanner could not read. */
export function scanUnsupported(code: string): string[] {
  return scan(code).unsupported;
}

/** Every emission POST can produce: inline, plus each reached helper's own. */
export function postEmissions(src = routeSource()): { all: Emission[]; unresolved: string[] } {
  const unresolved: string[] = [];

  // A direct same-module call whose binding shape this model does not
  // recognise must not vanish from a proof claiming direct-delegate coverage.
  unresolved.push(...unresolvedPostBindings(src).map((u) => `POST direct call: ${u}`));

  // POST's own body AND every delegate it calls — `mapGateDenial` included.
  const scope = scan(postScope(src));
  const all = [...scope.emissions];
  unresolved.push(...scope.unsupported.map((u) => `POST scope: ${u}`));

  for (const helper of reachedResponseHelpers(src)) {
    const body = helperBody(helper, src);
    if (body === null) {
      unresolved.push(`${helper}: no import mapping or definition found`);
      continue;
    }
    const found = scan(body);
    unresolved.push(...found.unsupported.map((u) => `${helper}: ${u}`));
    // A reached `*Response` helper that yields no modellable emission at all is
    // a shape this contract does not understand.
    if (found.emissions.length === 0 && found.unsupported.length === 0) {
      unresolved.push(`${helper}: reached but emits nothing this model can read`);
    }
    all.push(...found.emissions);
  }
  return { all, unresolved };
}

/** Distinct sub-500 codes POST can answer with. */
export function postSubFiveHundredCodes(src = routeSource()): string[] {
  return [...new Set(postEmissions(src).all.filter((e) => e.status < 500).map((e) => e.code))].sort();
}
