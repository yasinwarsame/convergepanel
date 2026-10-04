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
const SECRET_SOURCE = /\.cookies\.get\s*\(|cookies\s*\(\s*\)\s*\)?\s*\.get\s*\(|headers(\s*\(\s*\)\s*\)?)?\.get\s*\(\s*["'`]authorization["'`]/i;
/** Explicit secret PRODUCERS, matched on the exact callee name (case-sensitive) — never a substring,
 *  so getRandomBytesCount() / randomBytesLength() are not producers. */
const PRODUCER_CALLEE = /^(randomBytes|randomBytesSync|randomBytesAsync|pseudoRandomBytes|getRandomValues)$|^secureRandom[A-Z0-9_]?/;
/** Names that merely describe a secret (an id, count, timestamp, type…) rather than carry it. */
const NON_SECRET_SUFFIX = /(Id|Ids|Uid|Count|At|Type|Status|Mode|Version|Length|Index|Info|Ref|Path|Name|Month|Date|Day|Year|Enabled|Required)$/;
/** A callee counts as hashing only when its name STARTS with hash/hmac/sha256 or ENDS in Hash/Hmac/Digest
 *  (so `unhashed(token)` is not a hash), or is createHash/createHmac/digest. */
const HASH_CALLEE = /^(createHash|createHmac|digest)$|^(hash|hmac|sha256)|(Hash|Hmac|Digest)$/;

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

/** Find the nearest declaration of `name` visible from `from` (walks enclosing scopes outward). */
function resolve(name: string, from: ts.Node): { init?: ts.Expression; viaProperty?: string; param?: boolean } | null {
  for (let s: ts.Node | undefined = from.parent; s; s = s.parent) {
    if (ts.isFunctionLike(s)) {
      for (const p of s.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) return { param: true };
    }
    if (ts.isBlock(s) || ts.isSourceFile(s) || ts.isModuleBlock(s) || ts.isCaseClause(s)) {
      let found: { init?: ts.Expression; viaProperty?: string } | null = null;
      const look = (n: ts.Node): void => {
        if (found || (n !== s && (ts.isFunctionLike(n) || ts.isBlock(n)))) return; // only this scope level
        if (ts.isVariableDeclaration(n)) {
          if (ts.isIdentifier(n.name) && n.name.text === name) found = { init: n.initializer };
          else if (ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              if (ts.isIdentifier(el.name) && el.name.text === name) {
                const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name;
                found = { init: n.initializer, viaProperty: prop };
              }
            }
          }
        }
        ts.forEachChild(n, look);
      };
      ts.forEachChild(s, look);
      if (found) return found;
    }
  }
  return null;
}

export function scanSource(fileName: string, text: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  /** Does ANY part of this expression carry a secret (name, source, or alias of one)? */
  const secretDerived = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    const c = strip(e);
    if (isHashed(c)) return false;
    if (ts.isIdentifier(c)) {
      if (secretNamed(c.text)) return true;
      const d = resolve(c.text, c);
      if (!d || d.param || !d.init) return false;
      if (d.viaProperty && secretNamed(d.viaProperty)) return true;
      return secretDerived(d.init, depth + 1);
    }
    // A property is secret if its NAME is (`body.token`), or if it is a value pass-through on a secret
    // source (`cookies.get(x)?.value`). Other properties of a secret-derived OBJECT are not secret:
    // `(await signIn(auth, email, password)).user.uid` is a uid, not the password.
    if (ts.isPropertyAccessExpression(c)) return secretNamed(c.name.text) || (PASS_THROUGH_PROPS.has(c.name.text) && secretDerived(c.expression, depth + 1));
    if (ts.isElementAccessExpression(c)) {
      const k = c.argumentExpression;
      return ts.isStringLiteralLike(k) && secretNamed(k.text);
    }
    if (ts.isTemplateExpression(c)) return c.templateSpans.some((s) => secretDerived(s.expression, depth + 1));
    if (ts.isBinaryExpression(c)) return secretDerived(c.left, depth + 1) || secretDerived(c.right, depth + 1);
    if (ts.isConditionalExpression(c)) return secretDerived(c.whenTrue, depth + 1) || secretDerived(c.whenFalse, depth + 1);
    if (ts.isCallExpression(c)) {
      if (SECRET_SOURCE.test(c.getText(sf))) return true;
      const n = calleeName(c.expression);
      if (n && PRODUCER_CALLEE.test(n)) return true; // randomBytes(…), randomBytesAsync(…), getRandomValues(…)
      if (n && secretNamed(n)) return true; // e.g. generateInvitationToken(), issueSessionToken()
      const recv = ts.isPropertyAccessExpression(c.expression) ? [c.expression.expression] : [];
      return [...recv, ...c.arguments].some((a) => secretDerived(a, depth + 1)); // token.trim(), String(token), h.slice(7)
    }
    return SECRET_SOURCE.test(c.getText(sf));
  };

  /** Source text of a path argument, following local consts (so a path assembled before doc() is seen). */
  const pathText = (e: ts.Expression, depth = 0): string => {
    const c = strip(e);
    if (depth < 6 && ts.isIdentifier(c)) {
      const d = resolve(c.text, c);
      if (d?.init) return pathText(d.init, depth + 1);
    }
    return c.getText(sf).replace(/^[`'"]|[`'"]$/g, "");
  };

  /** String value of a collection-name argument, following a local const if needed. */
  const literalValue = (e: ts.Expression): string | null => {
    const c = strip(e);
    if (ts.isStringLiteralLike(c)) return c.text;
    if (ts.isIdentifier(c)) {
      const d = resolve(c.text, c);
      if (d?.init && ts.isStringLiteralLike(strip(d.init))) return (strip(d.init) as ts.StringLiteralLike).text;
    }
    return null;
  };

  const out: Violation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name === "doc") {
        // namespaced `x.doc(id)` → every arg; modular `doc(db, ...segments)` → segments
        const args = ts.isIdentifier(n.expression) ? n.arguments.slice(1) : n.arguments;
        if (args.some((a) => secretDerived(a))) out.push({ file: fileName, line: at(n), rule: "SECRET_RESOURCE_ID", text: n.getText(sf).slice(0, 120) });
      }
      if (name === "collection" || name === "collectionGroup") {
        const args = ts.isIdentifier(n.expression) ? n.arguments.slice(1) : n.arguments;
        if (args.some((a) => secretDerived(a))) out.push({ file: fileName, line: at(n), rule: "SECRET_RESOURCE_ID", text: n.getText(sf).slice(0, 120) });
        if (n.arguments.some((a) => literalValue(a) === "admin_sessions")) out.push({ file: fileName, line: at(n), rule: "ADMIN_SESSIONS_COLLECTION", text: n.getText(sf).slice(0, 120) });
      }
      if (name === "doc" && n.arguments.some((a) => /(^|\/)admin_sessions(\/|$)/.test(pathText(a)))) {
        out.push({ file: fileName, line: at(n), rule: "ADMIN_SESSIONS_COLLECTION", text: n.getText(sf).slice(0, 120) });
      }
    }
    if (ts.isStringLiteralLike(n) && n.text === "admin_session") {
      out.push({ file: fileName, line: at(n), rule: "ADMIN_SESSION_COOKIE", text: n.getText(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__", "__mocks__"]);
function sourceFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) sourceFiles(f, acc);
    else if (/\.(ts|tsx)$/.test(e) && !/\.(spec|test)\.tsx?$/.test(e) && !e.endsWith(".d.ts")) acc.push(f);
  }
  return acc;
}
const PROD_FILES = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("hooks"), ...sourceFiles("components"), "middleware.ts"];

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
    const docCalls = PROD_FILES.reduce((n, f) => n + (readFileSync(f, "utf8").match(/\.doc\(/g)?.length ?? 0), 0);
    expect(docCalls).toBeGreaterThan(300);
  });

  it("finds no SECRET_RESOURCE_ID, admin_sessions collection or admin_session cookie", () => {
    const found = PROD_FILES.flatMap((f) => scanSource(f, readFileSync(f, "utf8")));
    expect(found).toEqual(ALLOWED);
  });
});

// ─────────────────────────────── T1 reachability ───────────────────────────────

function filesNamed(dir: string, name: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) { if (!SKIP_DIRS.has(e)) filesNamed(f, name, acc); }
    else if (e === name) acc.push(f);
  }
  return acc;
}
const toPath = (f: string, file: string) => "/" + f.replace(/^app\//, "").replace(new RegExp(`/?${file.replace(".", "\\.")}$`), "").replace(/\([^)]+\)\//g, "");
const API_ROUTES = filesNamed("app", "route.ts").map((f) => toPath(f, "route.ts"));
const PAGES = filesNamed("app", "page.tsx").map((f) => toPath(f, "page.tsx"));

describe("T1 — the legacy flow is not reachable", () => {
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
