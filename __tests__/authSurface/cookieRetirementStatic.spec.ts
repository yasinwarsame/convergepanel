/**
 * ZCA P3 R2 — static oracle for the `__session` retirement (R1 M3 + R2 L-3). DEFENCE IN DEPTH ONLY: the structural
 * proof is the behavioural differential (differentialOracle.ts). Additive to every L-8.1 ban in
 * authSurfaceStatic.spec.ts.
 *
 * Detection: the TypeScript compiler API (an AST over every production file in the scan roots), with string
 * constant folding (literal, `+` concatenation, template with constant spans), plus a regex backstop over the
 * comment-stripped text. Evasions the AST cannot see (computed names built at run time and the like) are outside
 * this scan's guarantee; the differential catches their behaviour.
 *
 * Scan roots: app, lib, components, hooks, extension, middleware.ts, instrumentation.ts, instrumentation-client.ts,
 * sentry.*.ts, next.config.js. Tests (`__tests__/`, `*.spec.*`, `*.test.*`) are excluded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const ROOT_FILES = ["middleware.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.js", ...readdirSync(ROOT).filter((f) => /^sentry\..+\.ts$/.test(f))];
export const SCAN_FILES: string[] = [
  ...["app", "lib", "components", "hooks", "extension"].flatMap((d) => walk(join(ROOT, d))),
  ...ROOT_FILES.map((f) => join(ROOT, f)).filter((p) => existsSync(p)),
]
  .map(rel)
  .sort();

const BANNED_IDENTIFIERS = ["verifySessionCookie", "verifySessionCookieValue", "createSessionCookie"];
const SESSION_NAME = "__session";

type Finding = { file: string; kind: string; text: string };

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(n: ts.Expression): ts.Expression {
  let e = n;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || (ts.isSatisfiesExpression?.(e) ?? false)) {
      e = (e as ts.ParenthesizedExpression).expression;
    } else return e;
  }
}

/** Constant-folds a string expression: literal, `+` of foldable parts, a template whose spans fold. Else null. */
export function foldString(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return foldString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldString(node.left);
    const r = foldString(node.right);
    return l !== null && r !== null ? l + r : null;
  }
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) {
      const v = foldString(span.expression);
      if (v === null) return null;
      s += v + span.literal.text;
    }
    return s;
  }
  return null;
}
/** A maximal string expression: foldable, and its parent is not itself a foldable string expression. */
function isMaximalString(node: ts.Node): boolean {
  if (foldString(node) === null) return false;
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node))) return false;
  const p = node.parent;
  if (!p) return true;
  if ((ts.isBinaryExpression(p) || ts.isTemplateSpan(p) || ts.isParenthesizedExpression(p)) && foldString(ts.isTemplateSpan(p) ? p.parent : p) !== null) return false;
  return true;
}
const receiverText = (e: ts.Expression, sf: ts.SourceFile) => unwrap(e).getText(sf).replace(/\s+/g, "");
/**
 * A headers object: an expression whose last segment is exactly `headers` (`request.headers`, `req.headers`, a bare
 * `headers` parameter). Names like `DROPPED_HEADERS` / `initHeaders` are other things (constant lists, a client's own
 * OUTGOING header init) and are not matched. Spreads are matched only for a `.headers` MEMBER (a bare `...headers`
 * is in practice a locally built outgoing header literal).
 */
const isHeadersReceiver = (e: ts.Expression, sf: ts.SourceFile) => /(^|\.)headers$/.test(receiverText(e, sf));
const isHeadersMember = (e: ts.Expression) => {
  const u = unwrap(e);
  return ts.isPropertyAccessExpression(u) && u.name.text === "headers";
};
/** An element access used as a READ (not an assignment target, not a delete operand). */
const isRead = (n: ts.Node) => {
  const p = n.parent;
  if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
  if (ts.isDeleteExpression(p)) return false;
  return true;
};

export function scanSource(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out: Finding[] = [];
  const add = (kind: string, node: ts.Node) => out.push({ file, kind, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 160) });
  const visit = (node: ts.Node) => {
    // 1. Banned identifiers in ANY form: identifier (call, member, destructure, alias, bind, re-export) or a string.
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && BANNED_IDENTIFIERS.includes(node.text)) add("banned-identifier", node);
    if (isMaximalString(node)) {
      const v = foldString(node)!;
      if (BANNED_IDENTIFIERS.some((b) => v.includes(b))) add("banned-identifier-string", node);
      if (v.includes(SESSION_NAME)) add("session-name-string", node);
      if (v.toLowerCase() === "set-cookie") add("set-cookie-string", node);
    }
    // 2. Any `.cookies` member (request.cookies, response.cookies, cookies.get/getAll/has/set, iteration, spread).
    if (ts.isPropertyAccessExpression(node) && node.name.text === "cookies") add("cookies-member", node);
    if (ts.isElementAccessExpression(node) && foldString(node.argumentExpression) === "cookies") add("cookies-member", node);
    // 3. `cookies()` (next/headers) and `document.cookie`.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cookies") add("cookies-call", node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "cookie" && /(^|\.)document$/.test(receiverText(node.expression, sf))) add("document-cookie", node);
    // 4. Header reads: a Cookie / Set-Cookie read in any case; getSetCookie; a NON-LITERAL Headers.get/has/getAll argument.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      const arg = node.arguments[0];
      if (["get", "has", "getAll"].includes(m) && arg) {
        const v = foldString(arg);
        if (v !== null && ["cookie", "set-cookie"].includes(v.toLowerCase())) add("cookie-header-read", node);
        if (v === null && isHeadersReceiver(node.expression.expression, sf)) add("non-literal-header-get", node);
      }
      if (["entries", "keys", "values", "forEach"].includes(m) && isHeadersReceiver(node.expression.expression, sf)) add("header-iteration", node);
      if (["keys", "entries", "values", "fromEntries", "assign"].includes(m) && receiverText(node.expression.expression, sf) === "Object" && node.arguments.some((a) => isHeadersReceiver(a, sf))) add("header-iteration", node);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "getSetCookie") add("cookie-header-read", node);
    if (ts.isElementAccessExpression(node) && isHeadersReceiver(node.expression, sf) && isRead(node)) add("header-element-read", node);
    if (ts.isForOfStatement(node) && isHeadersReceiver(node.expression, sf)) add("header-iteration", node.expression);
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isHeadersMember(node.expression)) add("header-iteration", node);
    if (ts.isNewExpression(node) && receiverText(node.expression, sf) === "Headers" && node.arguments?.some((a) => isHeadersReceiver(a, sf))) add("header-iteration", node);
    // 5. A client DELETE: any `method: "DELETE"` property (checked against the session endpoint below).
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "method" && foldString(node.initializer)?.toUpperCase() === "DELETE") add("method-delete", node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const FINDINGS: Finding[] = SCAN_FILES.flatMap((f) => scanSource(f, readFileSync(join(ROOT, f), "utf8")));
const byKind = (kind: string) => FINDINGS.filter((x) => x.kind === kind).map((x) => `${x.file} :: ${x.text}`).sort();

/** Comments are stripped before the regex backstop, so documentation can neither satisfy nor trip it. */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

describe("scan roots (closed world)", () => {
  it("cover every production file of app, lib, components, hooks, extension and the root config/instrumentation files", () => {
    expect(SCAN_FILES.length).toBeGreaterThan(400);
    for (const f of ["middleware.ts", "instrumentation.ts", "instrumentation-client.ts", "next.config.js", "sentry.server.config.ts", "sentry.edge.config.ts", "extension/background.js", "lib/privacy/sentryScrub.ts", "lib/telemetry/analyticsProxy.ts", "app/api/auth/session/route.ts", "lib/client/sessionSync.ts"]) {
      expect({ f, scanned: SCAN_FILES.includes(f) }).toEqual({ f, scanned: true });
    }
    expect(SCAN_FILES.filter((f) => /__tests__|\.(spec|test)\./.test(f))).toEqual([]);
  });
});

describe("R1 M3 — the session-cookie verifier and minting identifiers appear NOWHERE in any form", () => {
  it("AST: no identifier, member, destructure, alias, re-export or (folded) string names them", () => {
    expect([...byKind("banned-identifier"), ...byKind("banned-identifier-string")]).toEqual([]);
  });
  it("regex backstop: not even as a substring of comment-stripped code", () => {
    const hits = SCAN_FILES.filter((f) => /verifySessionCookie|createSessionCookie/.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(hits).toEqual([]);
  });
});

describe("R1 M3 — no request cookie is read anywhere", () => {
  it("the ONLY `.cookies` member in the tree is the session route's single expiry write, and the Sentry scrub's delete", () => {
    expect(byKind("cookies-member")).toEqual(
      [
        `app/api/auth/session/route.ts :: response.cookies`,
        `lib/privacy/sentryScrub.ts :: req.cookies`,
      ].sort()
    );
  });
  it("the session route's one `.cookies` use is `.set(\"__session\", \"\", { …, maxAge: 0 })` — exactly ONE expiry, shared by POST and DELETE", () => {
    const src = readFileSync(join(ROOT, "app/api/auth/session/route.ts"), "utf8");
    const sf = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, true);
    const sets: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === "cookies") sets.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(sets).toHaveLength(1);
    const [call] = sets;
    expect((call.expression as ts.PropertyAccessExpression).name.text).toBe("set");
    expect(call.arguments.map((a) => foldString(a))).toEqual(["__session", "", null]);
    const attrs = call.arguments[2];
    expect(ts.isObjectLiteralExpression(attrs)).toBe(true);
    const props = Object.fromEntries(
      (attrs as ts.ObjectLiteralExpression).properties.filter(ts.isPropertyAssignment).map((p) => [(p.name as ts.Identifier).text, p.initializer.getText(sf)])
    );
    expect(props).toEqual({ httpOnly: "true", secure: "true", sameSite: '"lax"', path: '"/"', maxAge: "0" });
    // Both handlers go through it: POST via json(...)/finish(...), DELETE via json(...).
    expect(src.match(/function finish\(/g)).toHaveLength(1);
    expect(src).toMatch(/export async function DELETE[\s\S]*return json\(/);
  });
  it("the Sentry scrub's one `.cookies` use is a `delete` (removal, never a read)", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/privacy/sentryScrub.ts"), "utf8"));
    expect(src.match(/\.cookies\b/g)).toEqual([".cookies"]);
    expect(src).toMatch(/delete req\.cookies;/);
  });
  it("no `cookies()` call, no `document.cookie`", () => {
    expect([...byKind("cookies-call"), ...byKind("document-cookie")]).toEqual([]);
  });
  it("no Cookie / Set-Cookie header read in ANY case (get, has, getAll, getSetCookie), no element read of a headers object", () => {
    expect([...byKind("cookie-header-read"), ...byKind("header-element-read")]).toEqual([]);
  });
  it("R2 L-3: no NON-LITERAL Headers.get / has / getAll argument", () => {
    expect(byKind("non-literal-header-get")).toEqual([]);
  });
  it("R2 L-3: the existing header iteration is an EXACT allow-list (the proxy strip copy and the Sentry scrub), and both only REMOVE headers", () => {
    expect(byKind("header-iteration")).toEqual(
      [
        "middleware.ts :: new Headers(headers)",
        "lib/privacy/sentryScrub.ts :: Object.keys(headers as AnyRecord)",
      ].sort()
    );
    const mw = stripComments(readFileSync(join(ROOT, "middleware.ts"), "utf8"));
    expect(mw).toMatch(/const out = new Headers\(headers\);\s*for \(const name of PROXY_STRIPPED_REQUEST_HEADERS\) out\.delete\(name\);\s*return out;/);
    const scrub = stripComments(readFileSync(join(ROOT, "lib/privacy/sentryScrub.ts"), "utf8"));
    expect(scrub).toMatch(/for \(const name of Object\.keys\(headers as AnyRecord\)\) \{\s*if \(DROPPED_HEADERS\.has\(name\.toLowerCase\(\)\)\) delete \(headers as AnyRecord\)\[name\];\s*\}/);
  });
});

describe("R1 M3 / R2 L-3 — `__session` and Set-Cookie", () => {
  it("the `__session` name is built (literal, concatenation, template) ONLY in the session route's expiry write", () => {
    expect(byKind("session-name-string")).toEqual(['app/api/auth/session/route.ts :: "__session"']);
  });
  it("regex backstop: `__session` in comment-stripped code only in the session route", () => {
    const hits = SCAN_FILES.filter((f) => /__session/.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(hits).toEqual(["app/api/auth/session/route.ts"]);
  });
  it("a `set-cookie` string appears only in the Sentry scrub's dropped-header list (a removal)", () => {
    expect(byKind("set-cookie-string")).toEqual(['lib/privacy/sentryScrub.ts :: "set-cookie"']);
  });
  it("the telemetry scrub / strip lists still drop the Cookie header (privacy, kept)", () => {
    expect(readFileSync(join(ROOT, "lib/privacy/sentryScrub.ts"), "utf8")).toMatch(/DROPPED_HEADERS = new Set\(\["cookie", "set-cookie", "authorization"/);
    expect(readFileSync(join(ROOT, "middleware.ts"), "utf8")).toMatch(/PROXY_STRIPPED_REQUEST_HEADERS = \["cookie", "authorization"/);
  });
});

describe("R2 MA — invariant 5: no client DELETE, and nothing awaited between the token read and the handshake send", () => {
  it("no `method: \"DELETE\"` exists in any file that references the session endpoint, in any spelling", () => {
    const sessionFiles = SCAN_FILES.filter((f) => /\/?api\/auth\/session/.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(sessionFiles.sort()).toEqual(["app/api/auth/session/route.ts", "lib/client/sessionSync.ts", "lib/privacy/telemetryRouteManifest.generated.ts"]);
    expect(FINDINGS.filter((x) => x.kind === "method-delete" && sessionFiles.includes(x.file))).toEqual([]);
  });
  it("the session endpoint constant is used only by sessionSync, and sessionSync makes exactly one fetch call, a POST", () => {
    const src = readFileSync(join(ROOT, "lib/client/sessionSync.ts"), "utf8");
    const sf = ts.createSourceFile("sessionSync.ts", src, ts.ScriptTarget.Latest, true);
    const fetches: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") fetches.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(fetches).toHaveLength(1);
    const init = fetches[0].arguments[1] as ts.ObjectLiteralExpression;
    const method = init.properties.filter(ts.isPropertyAssignment).find((p) => (p.name as ts.Identifier).text === "method")!;
    expect(foldString(method.initializer)).toBe("POST");
    expect(fetches[0].arguments[0].getText(sf)).toBe("SESSION_ENDPOINT");
  });
  it("AST shape of the handshake attempt: `await getIdToken` → abort check → `return fetch(…)`, with NO other await", () => {
    const src = readFileSync(join(ROOT, "lib/client/sessionSync.ts"), "utf8");
    const sf = ts.createSourceFile("sessionSync.ts", src, ts.ScriptTarget.Latest, true);
    let attempt: ts.ArrowFunction | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "attempt" && n.initializer && ts.isArrowFunction(n.initializer)) attempt = n.initializer;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(attempt).toBeDefined();
    const body = attempt!.body as ts.Block;
    expect(ts.isBlock(body)).toBe(true);
    const stmts = body.statements;
    expect(stmts).toHaveLength(3);
    expect(stmts[0].getText(sf)).toBe("const idToken = await user.getIdToken(force);");
    expect(ts.isIfStatement(stmts[1]) && stmts[1].expression.getText(sf)).toBe("options.signal?.aborted");
    expect(ts.isReturnStatement(stmts[2]) && ts.isCallExpression(stmts[2].expression!) && (stmts[2].expression as ts.CallExpression).expression.getText(sf)).toBe("fetch");
    let awaits = 0;
    const count = (n: ts.Node) => {
      if (ts.isAwaitExpression(n)) awaits += 1;
      ts.forEachChild(n, count);
    };
    count(body);
    expect(awaits).toBe(1);
    // The token goes in BOTH the header and the body (R1 L3).
    expect(stmts[2].getText(sf)).toMatch(/Authorization: `Bearer \$\{idToken\}`/);
    expect(stmts[2].getText(sf)).toMatch(/body: JSON\.stringify\(\{ idToken \}\)/);
  });
});

describe("the scanner itself kills the R1 M3 evasion shapes (each must be FOUND)", () => {
  const found = (code: string, file = "lib/x.ts") => scanSource(file, code).map((f) => f.kind);
  it.each([
    ["a raw Cookie header parse", 'const raw = request.headers.get("Cookie") ?? "";', "cookie-header-read"],
    ["a lower-case cookie header read via has", 'if (req.headers.has("cookie")) x();', "cookie-header-read"],
    ["getAll on the cookie jar", "const all = request.cookies.getAll();", "cookies-member"],
    ["a concatenated cookie name", 'const v = request.cookies.get("__" + "session");', "session-name-string"],
    ["a template-built cookie name", 'const v = jar.get(`__${"session"}`);', "session-name-string"],
    ["bracket access to the cookie verifier", 'await auth["verifySessionCookie"](c, true);', "banned-identifier-string"],
    ["a destructure alias of the verifier", "const { verifySessionCookie: v } = adminAuth;", "banned-identifier"],
    ["a re-export of the minting call", 'export { createSessionCookie as mint } from "./x";', "banned-identifier"],
    ["a bound verifier", "const v = auth.verifySessionCookie.bind(auth);", "banned-identifier"],
    ["a computed header name", "const v = request.headers.get(name);", "non-literal-header-get"],
    ["header iteration", "for (const [k, v] of request.headers) use(k, v);", "header-iteration"],
    ["header spread", "const all = { ...req.headers };", "header-iteration"],
    ["an element read of the request headers", 'const c = (request.headers as any)["cookie"];', "header-element-read"],
    ["Object.fromEntries(headers)", "const h = Object.fromEntries(request.headers);", "header-iteration"],
    ["getSetCookie", "const c = res.headers.getSetCookie();", "cookie-header-read"],
    ["a client DELETE", 'fetch(SESSION_ENDPOINT, { method: "DELETE" });', "method-delete"],
    ["cookies() from next/headers", 'const c = cookies().get("x");', "cookies-call"],
  ])("%s", (_n, code, kind) => {
    expect(found(code)).toContain(kind);
  });
  it("a read placed INSIDE a telemetry scrub file is found too (the allow-list is by exact shape, not by file)", () => {
    const scrub = readFileSync(join(ROOT, "lib/privacy/sentryScrub.ts"), "utf8");
    const mutated = scrub.replace("delete req.cookies;", "delete req.cookies;\n  const leaked = (req as any).headers.get(\"cookie\");");
    expect(mutated).not.toBe(scrub);
    expect(scanSource("lib/privacy/sentryScrub.ts", mutated).map((f) => f.kind)).toContain("cookie-header-read");
  });
  it("control: the scanner does not flag ordinary code", () => {
    expect(found('const t = request.headers.get("authorization"); const m = new Map(); m.get(k);')).toEqual([]);
  });
});
