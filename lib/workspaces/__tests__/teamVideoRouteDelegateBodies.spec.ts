/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B-C5 — a delegate's BODY survives its spelling.
 *
 * C4 made delegate DISCOVERY structural: `function`, `async function`,
 * `export function`, `const f = () => {}` and `const f = function () {}` are
 * all recognised as top-level callables POST can call. That half held.
 *
 * The half that did not: having found a variable-form delegate, the model then
 * walked its body by re-parsing the stored source text — and the text stored
 * for a variable-form callable was the VariableDeclaration (`f = () => {}`,
 * with no `const`), which re-parses as an ExpressionStatement. Neither branch
 * of the walker matched, so it returned NO calls. The delegate was recognised
 * and its body was silently empty.
 *
 * What that costs, reproduced before the fix: a direct POST delegate written
 * `const mapSeatDenial = (...) => tooManyProjectsResponse()` contributed no
 * reached helper and no code, `unresolved` stayed empty, and the client/server
 * vocabulary proof stayed GREEN while POST could answer `too_many_projects`
 * (429). The byte-identical delegate spelled `function` turned that proof RED.
 * Spelling alone decided whether the proof was true.
 *
 * So this file asserts the property the earlier round only assumed: for every
 * declaration form the model says it supports, the delegate is found AND the
 * calls inside it are followed. It deliberately checks forms against each
 * other rather than against pinned numbers — the invariant is that spelling is
 * irrelevant, and a legitimate change to the route must not have to be
 * re-typed here to keep it green.
 */

import {
  routeSource,
  postDelegates,
  reachedResponseHelpers,
  postEmissions,
  unresolvedPostBindings,
} from "@/lib/workspaces/__tests__/teamVideoRouteContract";

/**
 * Replace once, or fail loudly. Every synthetic variant below is built by
 * substitution, so a silently missing anchor would leave the "mutated" source
 * identical to the original and every assertion would pass against nothing.
 */
function rep(src: string, anchor: string, replacement: string): string {
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(`teamVideoRouteDelegateBodies: anchor matched ${n} times, expected 1: ${anchor.slice(0, 80)}`);
  }
  return src.replace(anchor, replacement);
}

const POST_DECL = "export async function POST(";
const IN_POST = "    const gate1 = await authorizeTeamVideoVerificationAdmission(";
const PROJECT_ERRORS = 'from "@/lib/projects/projectErrorResponse"';

/**
 * The probe helper: a REAL exported denial helper in a module the route already
 * imports from, emitting a sub-500 code the route does not currently use. Using
 * a real one keeps `helperBody()` resolution honest — a fabricated helper would
 * only prove the scanner can read a string this file wrote.
 */
const PROBE_HELPER = "tooManyProjectsResponse";
const PROBE_CODE = "too_many_projects";

/** Import the probe helper through the route's own existing import line. */
function withProbeImport(src: string): string {
  const line = src.split("\n").find((l) => l.includes(PROJECT_ERRORS));
  if (!line) throw new Error("teamVideoRouteDelegateBodies: route no longer imports projectErrorResponse");
  return rep(src, line, line.replace("} from", `, ${PROBE_HELPER} } from`));
}

/** Declare `mapSeatDenial` in one spelling, and optionally have POST call it. */
function withDelegate(declaration: string, { called = true }: { called?: boolean } = {}): string {
  let src = withProbeImport(routeSource());
  src = rep(src, POST_DECL, `${declaration}\n\n${POST_DECL}`);
  if (called) {
    src = rep(
      src,
      IN_POST,
      '    if (req.headers.get("x-seat") === "1") {\n' +
        '      const seat = mapSeatDenial("cap");\n' +
        "      return NextResponse.json(seat.body as object, { status: seat.status });\n" +
        "    }\n" +
        IN_POST,
    );
  }
  return src;
}

const DENIAL_BODY = `  if (kind === "cap") return ${PROBE_HELPER}();\n  return internalErrorResponse();`;

/**
 * Every top-level callable spelling the model claims to support. If one is
 * added to the model, it belongs here too.
 */
const SUPPORTED_FORMS: [string, string][] = [
  ["function", `function mapSeatDenial(kind: string): { status: number; body: unknown } {\n${DENIAL_BODY}\n}`],
  ["async function", `async function mapSeatDenial(kind: string): Promise<{ status: number; body: unknown }> {\n${DENIAL_BODY}\n}`],
  ["export function", `export function mapSeatDenial(kind: string): { status: number; body: unknown } {\n${DENIAL_BODY}\n}`],
  ["export async function", `export async function mapSeatDenial(kind: string): Promise<{ status: number; body: unknown }> {\n${DENIAL_BODY}\n}`],
  ["const arrow", `const mapSeatDenial = (kind: string): { status: number; body: unknown } => {\n${DENIAL_BODY}\n};`],
  ["const async arrow", `const mapSeatDenial = async (kind: string): Promise<{ status: number; body: unknown }> => {\n${DENIAL_BODY}\n};`],
  ["export const arrow", `export const mapSeatDenial = (kind: string): { status: number; body: unknown } => {\n${DENIAL_BODY}\n};`],
  ["const function expression", `const mapSeatDenial = function (kind: string): { status: number; body: unknown } {\n${DENIAL_BODY}\n};`],
  ["const async function expression", `const mapSeatDenial = async function (kind: string): Promise<{ status: number; body: unknown }> {\n${DENIAL_BODY}\n};`],
  ["export const function expression", `export const mapSeatDenial = function (kind: string): { status: number; body: unknown } {\n${DENIAL_BODY}\n};`],
];

/** The whole derived contract, so forms can be compared as a single value. */
function derive(src: string) {
  const emissions = postEmissions(src);
  return {
    delegates: postDelegates(src).map((d) => d.name),
    reached: reachedResponseHelpers(src),
    subFiveHundred: [...new Set(emissions.all.filter((e) => e.status < 500).map((e) => e.code))].sort(),
    unresolved: emissions.unresolved,
  };
}

describe("the route contract reads the committed source it claims to read", () => {
  it("derives a non-trivial contract before anything is mutated", () => {
    // Positive control for every comparison below: if the real route stopped
    // parsing, each variant would derive the same empty contract as the next
    // and the equality assertions would hold vacuously.
    const base = derive(routeSource());
    expect(base.delegates.length).toBeGreaterThan(1);
    expect(base.reached.length).toBeGreaterThan(3);
    expect(base.subFiveHundred.length).toBeGreaterThan(8);
    expect(base.unresolved).toEqual([]);
    expect(base.subFiveHundred).not.toContain(PROBE_CODE);
  });
});

describe("a direct POST delegate's calls are followed in every supported spelling", () => {
  // The `function` spelling is the one that already worked before C5. Every
  // other form is required to produce the SAME derived contract, which is what
  // "declaration spelling is irrelevant" actually means.
  const reference = derive(withDelegate(SUPPORTED_FORMS[0][1]));

  it("the reference spelling actually exercises the probe", () => {
    // Without this, a fix that broke every form equally would still pass the
    // equality assertions below.
    expect(reference.delegates).toContain("mapSeatDenial");
    expect(reference.reached).toContain(PROBE_HELPER);
    expect(reference.subFiveHundred).toContain(PROBE_CODE);
    expect(reference.unresolved).toEqual([]);
  });

  it.each(SUPPORTED_FORMS)("%s", (_label, declaration) => {
    expect(derive(withDelegate(declaration))).toEqual(reference);
  });
});

describe("spelling does not change what the committed route is proven to emit", () => {
  /**
   * Re-spell a `function` declaration as a variable-bound callable without
   * changing what it does. Derived from the delegate's own source rather than
   * re-typed, so renaming or re-signing a delegate in the route does not
   * silently stop this from testing anything.
   */
  function respell(declaration: string, as: "arrow" | "function expression"): string {
    const head = /^(?:export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)\s*/.exec(declaration);
    if (!head) throw new Error(`teamVideoRouteDelegateBodies: not a function declaration: ${declaration.slice(0, 60)}`);
    const isAsync = Boolean(head[1]);
    const name = head[2];

    // Parameter list, by paren matching — a signature can contain `)` inside a
    // default value or a nested type, so the first `)` is not safe to use.
    const open = declaration.indexOf("(", head[0].length);
    let depth = 0;
    let close = -1;
    for (let i = open; i < declaration.length; i += 1) {
      if (declaration[i] === "(") depth += 1;
      else if (declaration[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) throw new Error("teamVideoRouteDelegateBodies: unbalanced parameter list");
    const params = declaration.slice(open, close + 1);

    // The body is the final balanced `{...}`; a return type annotation such as
    // `: { status: number; body: unknown }` also contains braces, so this is
    // found from the END rather than the front.
    if (!declaration.trimEnd().endsWith("}")) throw new Error("teamVideoRouteDelegateBodies: declaration does not end in a body");
    const text = declaration.trimEnd();
    let d = 0;
    let bodyStart = -1;
    for (let i = text.length - 1; i > close; i -= 1) {
      if (text[i] === "}") d += 1;
      else if (text[i] === "{") {
        d -= 1;
        if (d === 0) {
          bodyStart = i;
          break;
        }
      }
    }
    if (bodyStart < 0) throw new Error("teamVideoRouteDelegateBodies: could not locate the body");
    const returnType = text.slice(close + 1, bodyStart);
    const body = text.slice(bodyStart);
    const prefix = isAsync ? "async " : "";
    return as === "arrow"
      ? `const ${name} = ${prefix}${params}${returnType}=> ${body};`
      : `const ${name} = ${prefix}function ${params}${returnType}${body};`;
  }

  const base = derive(routeSource());
  const declared = postDelegates(routeSource()).filter((d) => /^(?:export\s+)?(?:async\s+)?function\s/.test(d.body));

  it("the route still declares delegates in `function` form to re-spell", () => {
    // Positive control: if the route's delegates were all already variable-form
    // this suite would silently test nothing.
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(["arrow", "function expression"] as const)("every `function` delegate re-spelled as %s derives an identical contract", (as) => {
    let src = routeSource();
    for (const d of declared) {
      const rewritten = respell(d.body, as);
      expect(rewritten).not.toEqual(d.body);
      expect(rewritten.startsWith("const ")).toBe(true);
      src = rep(src, d.body, rewritten);
    }
    expect(derive(src)).toEqual(base);
  });
});

describe("the model still declines what it cannot follow", () => {
  it("a supported variable-form callable POST never calls contributes nothing", () => {
    // Discovery must stay anchored to POST's own calls. A model that scanned
    // every top-level callable would report denials the endpoint cannot reach.
    for (const [, declaration] of SUPPORTED_FORMS.filter(([l]) => l.startsWith("const") || l.startsWith("export const"))) {
      const uncalled = derive(withDelegate(declaration, { called: false }));
      expect(uncalled.delegates).not.toContain("mapSeatDenial");
      expect(uncalled.reached).not.toContain(PROBE_HELPER);
      expect(uncalled.subFiveHundred).not.toContain(PROBE_CODE);
      expect(uncalled.unresolved).toEqual([]);
    }
  });

  it("a factory-bound callable POST calls is reported, not assumed empty", () => {
    // Carrying nodes must not turn "I cannot classify this initializer" into
    // "there is nothing here" — the failure that C4 introduced the unsupported
    // channel to prevent.
    const src = withDelegate("const mapSeatDenial = makeDenialHandler(\"cap\");");
    expect(unresolvedPostBindings(src)).toEqual([
      "mapSeatDenial: bound to CallExpression, not a recognized callable form",
    ]);
    expect(postEmissions(src).unresolved).toContain(
      "POST direct call: mapSeatDenial: bound to CallExpression, not a recognized callable form",
    );
    expect(postDelegates(src).map((d) => d.name)).not.toContain("mapSeatDenial");
  });

  it("a callable declared without an initializer is reported", () => {
    const src = withDelegate("let mapSeatDenial;");
    expect(unresolvedPostBindings(src)).toEqual(["mapSeatDenial: declared without an initializer"]);
  });
});

describe("declarators in one statement keep their own bodies", () => {
  it("follows the called declarator, not whichever came first", () => {
    // `const a = () => {}, b = () => {}` is one VariableStatement holding two
    // independent callables. Anything that stored or re-parsed the STATEMENT
    // would have to pick one of them, and would attribute the wrong body to the
    // other — silently, and in the direction of a false clean result.
    const declaration =
      `const mapOtherDenial = (): { status: number; body: unknown } => {\n` +
      `  return projectArchivedTargetResponse();\n` +
      `},\n` +
      `  mapSeatDenial = (kind: string): { status: number; body: unknown } => {\n` +
      `${DENIAL_BODY}\n` +
      `};`;
    const derived = derive(withDelegate(declaration));

    expect(derived.delegates).toContain("mapSeatDenial");
    expect(derived.delegates).not.toContain("mapOtherDenial");
    expect(derived.reached).toContain(PROBE_HELPER);
    expect(derived.subFiveHundred).toContain(PROBE_CODE);
    expect(derived.unresolved).toEqual([]);
  });
});
