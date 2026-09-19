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
 * SCOPE, STATED HONESTLY. This models the structural conventions the route
 * actually uses today — named `import { … } from "@/…"` lines, exported
 * `function *Response()` helpers, `NextResponse.json(body, { status })` and
 * `{ status, body }` object returns with literal codes and literal statuses.
 * It is NOT a TypeScript analyzer: ternary or variable statuses, dynamically
 * built response objects, non-lowercase or single-quoted codes, helper
 * factories and dynamic imports are outside the model. None of those forms
 * exists in this route or its helper modules today. Where a shape cannot be
 * modelled the functions below FAIL CLOSED — they report it rather than
 * silently dropping it — so adopting an unsupported form breaks the proof
 * loudly instead of quietly widening it.
 *
 * Test-support only. Nothing here is imported by production code.
 */

import { readFileSync } from "fs";
import { join } from "path";

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
export function postScope(src = routeSource()): string {
  const start = src.indexOf("export async function POST");
  const end = src.indexOf(GET_SECTION);
  if (start < 0 || end < 0 || end <= start) throw new Error("teamVideoRouteContract: cannot locate the POST region");
  const identityAt = src.indexOf("async function getUid(req");
  const identity = identityAt < 0 ? "" : src.slice(identityAt, src.indexOf("\n}", identityAt));
  return `${identity}\n${src.slice(start, end)}`;
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
 * Module-level helpers POST delegates its denials through. Their bodies are
 * part of POST's reachable surface even though the calls sit outside the
 * handler.
 */
const DELEGATES = ["mapGateDenial"];

function delegateBodies(src = routeSource()): string {
  return DELEGATES.map((name) => {
    const at = src.indexOf(`function ${name}(`);
    return at < 0 ? "" : src.slice(at, src.indexOf("\n}", at));
  }).join("\n");
}

/**
 * Every imported `*Response` helper POST actually reaches — directly, or
 * through a module-level delegate such as `mapGateDenial`.
 *
 * Derived, never listed. Adding a new denial helper to the route puts it here
 * automatically, which is what makes the vocabulary proof's completeness real
 * rather than a promise about a hand-maintained array.
 */
export function reachedResponseHelpers(src = routeSource()): string[] {
  const callScope = `${postScope(src)}\n${delegateBodies(src)}`;
  const reached: string[] = [];
  for (const [symbol] of importMap(src)) {
    if (!/Response$/.test(symbol)) continue;
    if (new RegExp(`\\b${symbol}\\s*\\(`).test(callScope)) reached.push(symbol);
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
export function emissions(code: string): Emission[] {
  const out: Emission[] = [];
  for (const chunk of code.split(/\breturn\b/).slice(1)) {
    const status = /status:\s*(\d{3})/.exec(chunk);
    if (!status) continue;
    const c = /errorCode:\s*"([a-z_]+)"/.exec(chunk) ?? /\bcode:\s*"([a-z_]+)"/.exec(chunk);
    if (!c) continue;
    out.push({ code: c[1], status: Number(status[1]) });
  }
  return out;
}

/** Every emission POST can produce: inline, plus each reached helper's own. */
export function postEmissions(src = routeSource()): { all: Emission[]; unresolved: string[] } {
  const unresolved: string[] = [];
  const all = [...emissions(postScope(src))];
  for (const helper of reachedResponseHelpers(src)) {
    const body = helperBody(helper, src);
    if (body === null) {
      unresolved.push(`${helper}: no import mapping or definition found`);
      continue;
    }
    const found = emissions(body);
    // Fail closed: a reached `*Response` helper that yields no modellable
    // emission is a shape this contract does not understand.
    if (found.length === 0) unresolved.push(`${helper}: reached but emits nothing this model can read`);
    all.push(...found);
  }
  return { all, unresolved };
}

/** Distinct sub-500 codes POST can answer with. */
export function postSubFiveHundredCodes(src = routeSource()): string[] {
  return [...new Set(postEmissions(src).all.filter((e) => e.status < 500).map((e) => e.code))].sort();
}
