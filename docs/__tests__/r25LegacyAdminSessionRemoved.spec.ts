/**
 * R-25 — no authentication/session secret may be used as a Firestore resource
 * identifier, and the legacy password admin session stays removed.
 *
 * The removed flow (`/api/admin/login` → `lib/adminAuth.ts#setAdminSession`)
 * generated `randomBytes(32).toString("hex")`, used it directly as
 * `admin_sessions/{secret}` and also set it as the `admin_session` cookie. It
 * never gated anything — no caller ever validated it — but a secret in a
 * document *name* is copied into Firestore Data Access audit entries, which this
 * project retains (365 days per the private controls record at the time of writing).
 *
 * What each block proves:
 *   T1  the legacy routes/page/module are not reachable: no route or page
 *       resolves to them, and no module imports the legacy helper.
 *   T2  a real-AST scan of all production source finds no `.doc(...)` / `doc(...)`
 *       resource identifier derived from a secret (secret-named identifier,
 *       `randomBytes`, a cookie read or the Authorization header, including
 *       through local aliases), no `admin_sessions` collection and no
 *       `admin_session` cookie name. Its rules are proven to fire on fixtures
 *       and not to fire on hashed identifiers.
 *   T3  `/admin` gating (middleware) and ADMIN_PORTAL authority still depend on
 *       the Firebase `__session` / bearer credential and the `admin` claim —
 *       an `admin_session` cookie alone grants nothing.
 *   T4  SYSTEM_ADMIN gates stay fail-closed and ignore `admin_session`.
 *   T5  the authority evidence table names no route that no longer exists
 *       (the existing completeness test only checks the other direction).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

// ─────────────────────────────── T2 scanner ───────────────────────────────

export type Violation = { file: string; line: number; rule: "SECRET_RESOURCE_ID" | "ADMIN_SESSIONS_COLLECTION" | "ADMIN_SESSION_COOKIE"; text: string };

const SECRET_NAME = /token|secret|password|passwd|cookie|apikey|api_key|credential|authorization|bearer|jwt/i;
const HASHED_NAME = /hash|digest|hmac|sha\d*/i;
/** Text of a direct request-credential source: a cookie read or the Authorization header. */
const SECRET_SOURCE = /\.cookies\.get(All)?\s*\(|cookies\s*\(\s*\)\s*\)?\s*\.get\s*\(|headers(\s*\(\s*\)\s*\)?)?\.get\s*\(\s*["'`]authorization["'`]/i;
/** Explicit secret PRODUCERS, matched on the exact callee name (case-sensitive) — never a substring,
 *  so getRandomBytesCount() / randomBytesLength() are not producers. */
const PRODUCER_CALLEE = /^(randomBytes|randomBytesSync|randomBytesAsync|pseudoRandomBytes|getRandomValues)$|^secureRandom[A-Z0-9_]?/;
/** Names that merely describe a secret (an id, count, timestamp, type…) rather than carry it. */
const NON_SECRET_SUFFIX = /(Id|Ids|Uid|Count|At|Type|Status|Mode|Version|Length|Index|Info|Ref|Path|Name|Month|Date|Day|Year|Enabled|Required)$/;
/** A callee counts as hashing only when its name STARTS with hash/hmac/sha256 or ENDS in Hash/Hmac/Digest
 *  (so `unhashed(token)` is not a hash), or is createHash/createHmac/digest. */
const HASH_CALLEE = /^(createHash|createHmac|digest)$|^(hash|hmac|sha256)(?![a-z])|(Hash|Hmac|Digest)$/;

function calleeName(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}
const strip = (e: ts.Expression): ts.Expression => {
  let c = e;
  while (ts.isParenthesizedExpression(c) || ts.isAsExpression(c) || ts.isNonNullExpression(c) || ts.isTypeAssertionExpression(c) || ts.isSatisfiesExpression(c) || ts.isAwaitExpression(c)) c = c.expression;
  return c;
};
const PASS_THROUGH_PROPS = new Set(["value"]);
const secretNamed = (name: string) => SECRET_NAME.test(name) && !HASHED_NAME.test(name) && !NON_SECRET_SUFFIX.test(name);

/** True when the expression's value is the output of a hash/HMAC call chain. */
function isHashed(e: ts.Expression): boolean {
  let c: ts.Expression = strip(e);
  while (ts.isCallExpression(c) || ts.isPropertyAccessExpression(c)) {
    const n = ts.isCallExpression(c) ? calleeName(c.expression) : c.name.text;
    if (n && HASH_CALLEE.test(n)) return true;
    c = c.expression;
  }
  return false;
}

type Binding = { inits: ts.Expression[]; viaProperty?: string; param?: boolean; fn?: ts.FunctionLikeDeclaration };

/** Every value a local name can hold, from the nearest enclosing scope that declares it: its initializer,
 *  every later plain assignment to it in that function/file (so `let id = uid; id = secret` is seen),
 *  or — for a function name — the function itself (so a helper's return values can be followed). */
function resolve(name: string, from: ts.Node): Binding | null {
  for (let s: ts.Node | undefined = from.parent; s; s = s.parent) {
    if (ts.isFunctionLike(s)) {
      for (const p of s.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) return { inits: [], param: true };
    }
    if (ts.isBlock(s) || ts.isSourceFile(s) || ts.isModuleBlock(s) || ts.isCaseClause(s)) {
      let found: Binding | null = null;
      const look = (n: ts.Node): void => {
        if (found) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === name) { found = { inits: [], fn: n }; return; }
        if (n !== s && (ts.isFunctionLike(n) || ts.isBlock(n))) return; // only this scope level
        if (ts.isVariableDeclaration(n)) {
          if (ts.isIdentifier(n.name) && n.name.text === name) {
            const init = n.initializer ? strip(n.initializer) : undefined;
            found = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? { inits: [], fn: init } : { inits: n.initializer ? [n.initializer] : [] };
          } else if (ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              if (ts.isIdentifier(el.name) && el.name.text === name) {
                const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name;
                found = { inits: n.initializer ? [n.initializer] : [], viaProperty: prop };
              }
            }
          }
        }
        ts.forEachChild(n, look);
      };
      ts.forEachChild(s, look);
      if (found) {
        // add reassignments within the declaring function (or file), not descending into nested functions
        const owner = (() => { let o: ts.Node = s; while (o.parent && !ts.isFunctionLike(o) && !ts.isSourceFile(o)) o = o.parent; return o; })();
        const assigns = (n: ts.Node): void => {
          if (n !== owner && ts.isFunctionLike(n)) return;
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) (found as Binding).inits.push(n.right);
          ts.forEachChild(n, assigns);
        };
        assigns(owner);
        return found;
      }
    }
  }
  return null;
}

/** Return-value expressions of a function-like node (arrow expression body or `return x` statements). */
function returnsOf(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body as ts.Expression];
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, walk);
  };
  walk(fn.body);
  return out;
}

const scriptKind = (f: string) =>
  f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.(js|mjs|cjs)$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

export function scanSource(fileName: string, text: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));

  /** Does ANY part of this expression carry a secret (name, source, producer, or alias of one)? */
  const secretDerived = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    const c = strip(e);
    if (isHashed(c)) return false;
    if (ts.isIdentifier(c)) {
      if (secretNamed(c.text)) return true;
      const d = resolve(c.text, c);
      if (!d || d.param) return false;
      if (d.viaProperty && secretNamed(d.viaProperty)) return true;
      return d.inits.some((i) => secretDerived(i, depth + 1));
    }
    // A property is secret if its NAME is (`body.token`), or if it is a value pass-through on a secret
    // source (`cookies.get(x)?.value`). Other properties of a secret-derived OBJECT are not secret:
    // `(await signIn(auth, email, password)).user.uid` is a uid, not the password.
    if (ts.isPropertyAccessExpression(c)) return secretNamed(c.name.text) || (PASS_THROUGH_PROPS.has(c.name.text) && secretDerived(c.expression, depth + 1));
    if (ts.isElementAccessExpression(c)) {
      const k = c.argumentExpression;
      // a string key is a property name (secret only by name); a numeric/computed index selects an
      // element of the container, so it carries the container's taint (`cookies.getAll()[0]`)
      if (ts.isStringLiteralLike(k)) return secretNamed(k.text);
      return secretDerived(c.expression, depth + 1);
    }
    if (ts.isTemplateExpression(c)) return c.templateSpans.some((s) => secretDerived(s.expression, depth + 1));
    if (ts.isBinaryExpression(c)) return secretDerived(c.left, depth + 1) || secretDerived(c.right, depth + 1);
    if (ts.isConditionalExpression(c)) return secretDerived(c.whenTrue, depth + 1) || secretDerived(c.whenFalse, depth + 1);
    if (ts.isArrayLiteralExpression(c)) return c.elements.some((el) => ts.isExpression(el) && secretDerived(el, depth + 1));
    if (ts.isCallExpression(c)) {
      if (SECRET_SOURCE.test(c.getText(sf))) return true;
      const n = calleeName(c.expression);
      if (n && PRODUCER_CALLEE.test(n)) return true; // randomBytes(…), randomBytesAsync(…), getRandomValues(…)
      if (n && secretNamed(n)) return true; // e.g. generateInvitationToken(), issueSessionToken()
      if (ts.isIdentifier(c.expression)) {
        // a LOCAL helper: follow its return values (`function newId() { return randomBytes(32)… }`)
        const d = resolve(c.expression.text, c.expression);
        if (d?.fn && returnsOf(d.fn).some((r) => secretDerived(r, depth + 1))) return true;
      }
      const recv = ts.isPropertyAccessExpression(c.expression) ? [c.expression.expression] : [];
      return [...recv, ...c.arguments].some((a) => secretDerived(a, depth + 1)); // token.trim(), String(token), h.slice(7), [..].join("/")
    }
    return SECRET_SOURCE.test(c.getText(sf));
  };

  /** Constant string value of an expression (literals, `+`, templates, local consts); unknown parts become "\u0000". */
  const fold = (e: ts.Expression, depth = 0): string => {
    const c = strip(e);
    if (ts.isStringLiteralLike(c)) return c.text;
    if (ts.isTemplateExpression(c)) return c.head.text + c.templateSpans.map((s) => fold(s.expression, depth + 1) + s.literal.text).join("");
    if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.PlusToken) return fold(c.left, depth + 1) + fold(c.right, depth + 1);
    if (depth < 6 && ts.isIdentifier(c)) {
      const d = resolve(c.text, c);
      if (d && !d.param && !d.fn && d.inits.length === 1) return fold(d.inits[0], depth + 1);
    }
    if (depth < 6 && ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "join" && ts.isArrayLiteralExpression(strip(c.expression.expression))) {
      const sep = c.arguments[0] ? fold(c.arguments[0], depth + 1) : ",";
      return (strip(c.expression.expression) as ts.ArrayLiteralExpression).elements.map((el) => (ts.isExpression(el) ? fold(el, depth + 1) : "\u0000")).join(sep);
    }
    return "\u0000";
  };
  const isMaximalString = (n: ts.Node) =>
    (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
    !(n.parent && ((ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isTemplateSpan(n.parent)));
  const ADMIN_SESSIONS_SEGMENT = /(^|\/)admin_sessions(\/|$)/;
  /** A raw Set-Cookie value issuing the removed cookie: `admin_session=…` (header strings, templates, concatenations). */
  const ADMIN_SESSION_SET_COOKIE = /(^|[;,\s])admin_session=/;

  const out: Violation[] = [];
  const seen = new Set<string>();
  const push = (n: ts.Node, rule: Violation["rule"]) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const key = `${line}|${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: fileName, line, rule, text: n.getText(sf).slice(0, 120) });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name === "doc" || name === "collection" || name === "collectionGroup") {
        // namespaced `x.doc(id)` → every arg; modular `doc(db, ...segments)` → segments
        const args = ts.isIdentifier(n.expression) ? n.arguments.slice(1) : n.arguments;
        if (args.some((a) => secretDerived(a))) push(n, "SECRET_RESOURCE_ID");
        if (n.arguments.some((a) => ADMIN_SESSIONS_SEGMENT.test(fold(a)))) push(n, "ADMIN_SESSIONS_COLLECTION");
      }
    }
    // Any constant string anywhere that IS the removed cookie name or names the removed collection —
    // including concatenations, templates and `[..].join("/")` paths assembled elsewhere.
    if (isMaximalString(n) || (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "join")) {
      const v = fold(n as ts.Expression);
      if (v === "admin_session" || ADMIN_SESSION_SET_COOKIE.test(v)) push(n, "ADMIN_SESSION_COOKIE");
      if (ADMIN_SESSIONS_SEGMENT.test(v)) push(n, "ADMIN_SESSIONS_COLLECTION");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__", "__mocks__", "__fixtures__"]);
/** Every JS-family source the app can build or run: Next compiles .js/.jsx routes too (`allowJs: true`). */
export const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/;
function sourceFiles(dir: string, acc: string[] = [], recurse = true): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const f = dir === "." ? e : join(dir, e);
    if (statSync(f).isDirectory()) { if (recurse) sourceFiles(f, acc); }
    else if (SOURCE_EXT.test(e) && !TEST_FILE.test(e) && !e.endsWith(".d.ts")) acc.push(f);
  }
  return acc;
}
const PROD_FILES = [
  ...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("hooks"), ...sourceFiles("components"), ...sourceFiles("scripts"),
  // Next also builds the Pages Router (pages/, src/pages/) and src/app/; scanned if they ever appear.
  ...sourceFiles("pages"), ...sourceFiles("src"), ...sourceFiles("extension"),
  ...sourceFiles(".", [], false), // root files: middleware.ts, instrumentation, configs
];

/** Pinned: there is no legitimate exception. Adding one must be a reviewed change to this array. */
const ALLOWED: Violation[] = [];

describe("T2 — scanner rules fire on secret-derived resource ids (fixtures)", () => {
  const rules = (src: string) => scanSource("fixture.ts", src).map((v) => v.rule);

  it("flags the removed legacy shape (secret id + admin_sessions collection)", () => {
    const r = rules(`const token = randomBytes(32).toString("hex"); await adminDb.collection("admin_sessions").doc(token).set({});`);
    expect(r).toContain("SECRET_RESOURCE_ID");
    expect(r).toContain("ADMIN_SESSIONS_COLLECTION");
  });
  it("flags an innocuously named id derived from randomBytes", () => {
    expect(rules(`const id = randomBytes(16).toString("hex"); db.collection("x").doc(id);`)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it("flags a cookie-derived id through an alias split across lines", () => {
    expect(rules(`const c = request.cookies.get("foo")?.value;\nconst k = c;\ndb.collection("x")\n  .doc(\n    k\n  );`)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it("flags an Authorization-header-derived id inline", () => {
    expect(rules(`db.collection("x").doc(req.headers.get("authorization"));`)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it("flags a secret-named id in the modular doc(db, ...) form", () => {
    expect(rules(`doc(db, "sessions", sessionToken);`)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it("flags any admin_session cookie name", () => {
    expect(rules(`cookies().set("admin_session", v, {});`)).toEqual(["ADMIN_SESSION_COOKIE"]);
  });
  it.each([
    ["template path", "db.doc(`sessions/${token}`);"],
    ["concatenated path", 'db.doc("sessions/" + token);'],
    ["property access", "db.collection(\"x\").doc(body.token);"],
    ["String() / .trim() wrappers", "db.collection(\"x\").doc(String(token)); db.collection(\"y\").doc(token.trim());"],
    ["destructured rename", "const { token: t } = body; db.collection(\"x\").doc(t);"],
    ["secret returned by a helper", "const v = generateInvitationToken(); db.collection(\"x\").doc(v);"],
    ["headers() Authorization", 'const h = headers().get("authorization"); db.collection("x").doc(h);'],
    ["bearer slice", 'const h = req.headers.get("authorization"); db.collection("x").doc(h.slice(7));'],
    ["misleading hash-like callee", "db.collection(\"x\").doc(unhashed(token));"],
  ])("flags %s", (_label, src) => {
    expect(rules(src as string)).toContain("SECRET_RESOURCE_ID");
  });
  it.each([
    ["awaited async helper", "const v = await generateInvitationToken(); db.collection(\"x\").doc(v);"],
    ["awaited headers()", 'const h = (await headers()).get("authorization"); db.collection("y").doc(h);'],
    ["awaited async randomBytes", 'const id = (await randomBytesAsync(32)).toString("hex"); db.collection("z").doc(id);'],
    ["secret as a collection id", "db.collection(token).doc(uid);"],
    ["bearer/jwt-named identifiers", "db.collection(\"x\").doc(bearer); db.collection(\"y\").doc(jwt);"],
  ])("flags %s", (_label, src) => {
    expect(rules(src as string)).toContain("SECRET_RESOURCE_ID");
  });
  it.each([
    ["await generateInvitationToken() inline", 'doc(db, "collection", await generateInvitationToken());'],
    ["awaited helper alias", 'const token = await generateInvitationToken();\ndoc(db, "collection", token);'],
    ["nested awaits", 'const v = await (await getSecretFactory()).issueSessionToken(); db.collection("x").doc(v);'],
    ["await randomBytesAsync(...)", 'const id = (await randomBytesAsync(32)).toString("hex"); db.collection("x").doc(id);'],
    ["awaited helper returning a secret, via alias chain", 'const a = await issueSessionToken(); const b = a; const c2 = b; db.collection("x").doc(c2);'],
    ["destructured alias of an awaited helper", 'const { token: t } = await createSession(); db.collection("x").doc(t);'],
    ["wrapper around an awaited producer", 'db.collection("x").doc(String(await generateInvitationToken()).trim());'],
    ["crypto.randomBytes", 'const n = crypto.randomBytes(32).toString("hex"); db.collection("x").doc(n);'],
    ["getRandomValues", 'const n = toHex(crypto.getRandomValues(new Uint8Array(32))); db.collection("x").doc(n);'],
    ["secureRandom* wrapper", 'const n = secureRandomHex(32); db.collection("x").doc(n);'],
  ])("Phase-2/3 positive: %s", (_label, src) => {
    expect(rules(src as string)).toContain("SECRET_RESOURCE_ID");
  });
  it.each([
    ["getRandomBytesCount()", 'const n = getRandomBytesCount(); db.collection("x").doc(n);'],
    ["randomBytesLength()", 'const n = randomBytesLength(cfg); db.collection("x").doc(n);'],
    ["logRandomBytesUsage()", 'const n = logRandomBytesUsage(uid); db.collection("x").doc(n);'],
    ["RandomBytesTelemetry()", 'const n = RandomBytesTelemetry(); db.collection("x").doc(n);'],
    ["authorizationRequestId", "db.collection(\"x\").doc(authorizationRequestId);"],
    ["bearerTokenCount", "db.collection(\"x\").doc(bearerTokenCount);"],
    ["jwtIssuedAt / tokenUsageMonth / tokenizerName", "db.collection(\"a\").doc(jwtIssuedAt); db.collection(\"b\").doc(tokenUsageMonth); db.collection(\"c\").doc(tokenizerName);"],
    ["authorizationInfo.permission", "db.collection(\"x\").doc(authorizationInfo.permission);"],
  ])("Phase-3/N4 negative control (not a secret producer/carrier): %s", (_label, src) => {
    expect(rules(src as string)).toEqual([]);
  });
  it("flags admin_sessions/<secret> assembled before doc() is called", () => {
    const r = rules('const t = randomBytes(32).toString("hex");\nconst p = `admin_sessions/${t}`;\ndb.doc(p);');
    expect(r).toContain("ADMIN_SESSIONS_COLLECTION");
    expect(r).toContain("SECRET_RESOURCE_ID");
  });
  it("flags a nested resource path ending in admin_sessions/{secret}", () => {
    expect(rules('db.collection("tenants").doc(tid).collection("admin_sessions").doc(sessionToken);')).toEqual(["SECRET_RESOURCE_ID", "ADMIN_SESSIONS_COLLECTION"]);
  });
  it("modular doc(db, 'admin_sessions', …) is flagged", () => {
    expect(rules('doc(db, "admin_sessions", sid);')).toContain("ADMIN_SESSIONS_COLLECTION");
  });
  it("scope guard: an alias in one function never resolves to a declaration in a sibling or nested scope", () => {
    expect(rules(`function outer() { const id = uid; function inner() { const id = randomBytes(8).toString("hex"); return id; } db.collection("x").doc(id); }`)).toEqual([]);
    expect(rules(`function outer() { const id = randomBytes(8).toString("hex"); function inner() { const id = uid; db.collection("x").doc(id); } }`)).toEqual([]);
  });
  it("D1: JavaScript sources are parsed and scanned (route.js restore of the legacy shape)", () => {
    const js = 'import { randomBytes } from "crypto";\nexport async function POST() { const t = randomBytes(32).toString("hex"); await adminDb.collection("admin_sessions").doc(t).set({}); (await cookies()).set("admin_session", t); }';
    const r = scanSource("app/api/admin/login/route.js", js).map((v) => v.rule);
    expect(r).toEqual(expect.arrayContaining(["SECRET_RESOURCE_ID", "ADMIN_SESSIONS_COLLECTION", "ADMIN_SESSION_COOKIE"]));
    expect(scanSource("x.jsx", 'const c = <a href="/">x</a>; db.collection("y").doc(sessionToken);').map((v) => v.rule)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it.each([
    ["R1 local helper function returning a raw secret", 'function newId() { return randomBytes(32).toString("hex"); }\ndb.collection("sessions").doc(newId());'],
    ["R1 local arrow helper returning a raw secret", 'const mint = () => randomBytes(16).toString("hex");\ndb.collection("sessions").doc(mint());'],
    ["R2 reassigned let", 'let id = uid;\nid = randomBytes(32).toString("hex");\ndb.collection("x").doc(id);'],
  ])("flags %s", (_label, src) => {
    expect(rules(src as string)).toContain("SECRET_RESOURCE_ID");
  });
  it("R3: a join()-assembled admin_sessions path is flagged by both rules", () => {
    const r = rules('const t = randomBytes(32).toString("hex");\ndb.doc(["admin_sessions", t].join("/"));');
    expect(r).toContain("ADMIN_SESSIONS_COLLECTION");
    expect(r).toContain("SECRET_RESOURCE_ID");
  });
  it.each([
    ["concatenated cookie name", 'cookies().set("admin_" + "session", v);'],
    ["template cookie name", 'cookies().set(`admin_${"session"}`, v);'],
    ["const-assembled cookie name", 'const A = "admin_"; const N = A + "session"; cookies().set(N, v);'],
  ])("R11: flags an assembled admin_session cookie name (%s)", (_label, src) => {
    expect(rules(src as string)).toContain("ADMIN_SESSION_COOKIE");
  });
  it.each([
    ["Set-Cookie header template", 'export function issue(v) { return new Response(null, { headers: { "Set-Cookie": `admin_session=${v}; Path=/; HttpOnly` } }); }'],
    ["Set-Cookie header concatenation", 'res.headers.append("set-cookie", "admin_session=" + v + "; Path=/");'],
    ["Set-Cookie after another cookie", 'res.headers.set("set-cookie", "a=1; admin_session=" + v);'],
  ])("D2: flags a raw Set-Cookie issuing admin_session (%s)", (_label, src) => {
    expect(rules(src as string)).toContain("ADMIN_SESSION_COOKIE");
  });
  it("N1: getAll() cookie reads are sources; hashtagOf() is not a hash", () => {
    expect(rules('const c = request.cookies.getAll()[0].value; db.collection("x").doc(c);')).toContain("SECRET_RESOURCE_ID");
    expect(rules('db.collection("x").doc(hashtagOf(token));')).toContain("SECRET_RESOURCE_ID");
  });
  it("D2 negative controls: other cookies / prose mentioning the name are not flagged", () => {
    expect(rules('res.headers.append("set-cookie", "__session=" + v + "; Path=/"); const s = "my_admin_session=x";')).toEqual([]);
  });
  it("negative controls for folding/helpers/reassignment", () => {
    expect(rules('cookies().set("__session", v); const k = "admin_" + "sessionsX"; db.collection("x").doc(uid);')).toEqual([]);
    expect(rules('function idOf(u) { return u.uid; } db.collection("users").doc(idOf(user));')).toEqual([]);
    expect(rules('let id = randomBytes(8).toString("hex"); function f() { let id = uid; db.collection("x").doc(id); }')).toEqual([]);
  });
  it("flags admin_sessions inside a document path", () => {
    expect(rules("db.doc(`admin_sessions/${uid}`);")).toContain("ADMIN_SESSIONS_COLLECTION");
  });
  it("scope guard: a nested function's same-named const does not shadow an outer secret", () => {
    expect(rules(`function a() { const id = "fixed"; return id; }\nconst id = randomBytes(8).toString("hex");\ndb.collection("x").doc(id);`)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it("flags a constant admin_sessions collection name", () => {
    expect(rules(`const C = "admin_sessions"; db.collection(C).doc(uid);`)).toEqual(["ADMIN_SESSIONS_COLLECTION"]);
  });
  it("resolves aliases per scope: a same-named const elsewhere does not hide a secret", () => {
    expect(rules(`function a() { const id = "fixed"; return id; }\nfunction b() { const id = randomBytes(8).toString("hex"); db.collection("x").doc(id); }`)).toEqual(["SECRET_RESOURCE_ID"]);
  });
  it("does NOT flag hashed ids or ordinary ids (negative controls)", () => {
    expect(rules(`db.collection("i").doc(hashWorkspaceInvitationToken(rawToken));`)).toEqual([]);
    expect(rules(`db.collection("i").doc(createHash("sha256").update(token).digest("hex"));`)).toEqual([]);
    expect(rules(`const tokenHash = hashIt(token); db.collection("i").doc(tokenHash);`)).toEqual([]);
    expect(rules(`db.collection("runs").doc(runId); db.collection("users").doc(uid); doc(db, "w", workspaceId);`)).toEqual([]);
    expect(rules("db.doc(`users/${uid}/runs/${runId}`); db.collection(\"i\").doc(invitation.tokenHash);")).toEqual([]);
    // a uid read off an auth result whose CALL took a password is not the password
    expect(rules(`const cred = await signInWithEmailAndPassword(auth, email, password); const user = cred.user; await setDoc(doc(db, "users", user.uid), {});`)).toEqual([]);
  });
});

describe("T2 — production source uses no secret as a Firestore resource identifier", () => {
  it("ANCHOR: the scan is not vacuous (real files, real doc() calls)", () => {
    expect(PROD_FILES.length).toBeGreaterThan(500);
    expect(PROD_FILES).toContain("lib/firestore/workspaceInvitations.ts");
    expect(PROD_FILES).toContain("middleware.ts");
    // JS-family sources are scanned too (Next builds .js routes with allowJs)
    expect(PROD_FILES.some((f) => /\.(js|mjs|cjs)$/.test(f))).toBe(true);
    expect(PROD_FILES).toContain("scripts/check-admin-claims.js");
    const docCalls = PROD_FILES.reduce((n, f) => n + (readFileSync(f, "utf8").match(/\.doc\(/g)?.length ?? 0), 0);
    expect(docCalls).toBeGreaterThan(300);
  });

  it("finds no SECRET_RESOURCE_ID, admin_sessions collection or admin_session cookie", () => {
    const found = PROD_FILES.flatMap((f) => scanSource(f, readFileSync(f, "utf8")));
    expect(found).toEqual(ALLOWED);
  });
});

// ─────────────────────────────── T1 reachability ───────────────────────────────

/** Next App Router entry files in EVERY extension Next will build (`allowJs: true`, default pageExtensions). */
export const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;
export const PAGE_FILE = /^page\.(ts|tsx|js|jsx|mjs|md|mdx)$/;
function filesMatching(dir: string, re: RegExp, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) { if (!SKIP_DIRS.has(e)) filesMatching(f, re, acc); }
    else if (re.test(e)) acc.push(f);
  }
  return acc;
}
/** app/(group)/api/x/route.js → /api/x ; app/admin/login/page.jsx → /admin/login */
export const routePathOf = (f: string) =>
  "/" + f.replace(/^app\//, "").replace(/\/?(route|page)\.[a-z]+$/, "").replace(/\([^)]+\)\/?/g, "").replace(/\/$/, "");
/** Pages Router entries: pages/api/admin/login.ts → /api/admin/login ; pages/admin/login/index.jsx → /admin/login */
export const pagesRoutePathOf = (f: string) =>
  "/" + f.replace(/^(src\/)?pages\//, "").replace(/\.(ts|tsx|js|jsx|mjs|md|mdx)$/, "").replace(/(^|\/)index$/, "");
const PAGES_ROUTER_FILES = ["pages", "src/pages"].filter(existsSync).flatMap((d) => filesMatching(d, SOURCE_EXT));
const API_ROUTES = [
  ...filesMatching("app", ROUTE_FILE).map(routePathOf),
  ...(existsSync("src/app") ? filesMatching("src/app", ROUTE_FILE).map((f) => routePathOf(f.replace(/^src\//, ""))) : []),
  ...PAGES_ROUTER_FILES.map(pagesRoutePathOf).filter((r) => r.startsWith("/api/")),
];
const PAGES = [
  ...filesMatching("app", PAGE_FILE).map((f) => routePathOf(f) || "/"),
  ...PAGES_ROUTER_FILES.map(pagesRoutePathOf).filter((r) => !r.startsWith("/api/")),
];

describe("T1 — the legacy flow is not reachable", () => {
  it("ANCHOR: entry-file matching covers every buildable extension (a route.js / page.jsx restore cannot hide)", () => {
    for (const f of ["route.ts", "route.tsx", "route.js", "route.jsx", "route.mjs"]) expect(ROUTE_FILE.test(f)).toBe(true);
    for (const f of ["page.tsx", "page.ts", "page.js", "page.jsx", "page.mdx"]) expect(PAGE_FILE.test(f)).toBe(true);
    expect(routePathOf("app/api/admin/login/route.js")).toBe("/api/admin/login");
    expect(routePathOf("app/(legacy)/api/admin/logout/route.jsx")).toBe("/api/admin/logout");
    expect(routePathOf("app/admin/login/page.jsx")).toBe("/admin/login");
  });
  it("the app is App-Router only: no pages/, src/pages/ or src/app/ tree exists (a Pages Router restore cannot hide)", () => {
    expect(existsSync("pages")).toBe(false);
    expect(existsSync("src/pages")).toBe(false);
    expect(existsSync("src/app")).toBe(false);
  });
  it("ANCHOR: Pages Router paths map correctly if a pages/ tree ever appears", () => {
    expect(pagesRoutePathOf("pages/api/admin/login.ts")).toBe("/api/admin/login");
    expect(pagesRoutePathOf("src/pages/api/admin/logout.js")).toBe("/api/admin/logout");
    expect(pagesRoutePathOf("pages/admin/login/index.jsx")).toBe("/admin/login");
  });
  it("ANCHOR: route and page enumeration works", () => {
    expect(API_ROUTES).toContain("/api/admin/set-admin");
    expect(API_ROUTES).toContain("/api/admin/access");
    expect(PAGES).toContain("/admin");
  });
  it("no API route resolves to /api/admin/login or /api/admin/logout", () => {
    expect(API_ROUTES).not.toContain("/api/admin/login");
    expect(API_ROUTES).not.toContain("/api/admin/logout");
  });
  it("no page resolves to /admin/login", () => {
    expect(PAGES).not.toContain("/admin/login");
  });
  it("no production module imports the legacy helper (and the live Firebase helper is still imported)", () => {
    const imports = PROD_FILES.flatMap((f) => {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, false);
      return sf.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    });
    expect(imports).toContain("@/lib/firebase/adminAuth");
    expect(imports.filter((s) => s === "@/lib/adminAuth" || /(^|\/)lib\/adminAuth$/.test(s))).toEqual([]);
    expect(existsSync("lib/adminAuth.ts")).toBe(false);
    expect(existsSync("lib/firebase/adminAuth.ts")).toBe(true);
  });
});

// ─────────────────────────────── T5 evidence table ───────────────────────────────

describe("T5 — the authority evidence table names only routes that exist", () => {
  const src = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");
  const start = src.indexOf("| Route (method) | Authority | Audit | Success log | Other evidence |");
  const after = src.slice(start);
  const table = after.slice(0, after.indexOf("\n\n") === -1 ? undefined : after.indexOf("\n\n"));
  const cited = [...new Set([...table.matchAll(/`(\/api\/(?:admin|governance)[^`\s]*)`/g)].map((m) => m[1]))];

  it("ANCHOR: the table was found and cites routes", () => {
    expect(start).toBeGreaterThan(-1);
    expect(cited.length).toBeGreaterThan(15);
    expect(cited).toContain("/api/admin/set-admin");
  });
  it.each(cited)("%s exists on disk", (route) => {
    expect(API_ROUTES).toContain(route);
  });
});
