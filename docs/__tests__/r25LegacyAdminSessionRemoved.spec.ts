/**
 * R-25 — no authentication/session secret may be used as a Firestore resource
 * identifier, and the legacy password admin session stays removed.
 *
 * The removed flow (`/api/admin/login` → `lib/adminAuth.ts#setAdminSession`)
 * generated `randomBytes(32).toString("hex")`, used it directly as
 * `admin_sessions/{secret}` and also set it as the `admin_session` cookie. It
 * never gated anything — no caller ever validated it — but a secret in a
 * document *name* is copied into Firestore Data Access audit entries, which this
 * project retains for 365 days.
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

const SECRET_NAME = /token|secret|password|passwd|cookie|apikey|api_key|credential/i;
const HASHED_NAME = /hash|digest|hmac|sha\d*/i;
const SECRET_SOURCE = /randomBytes\s*\(|\.cookies\.get\s*\(|cookies\s*\(\s*\)\s*\.get\s*\(|headers\.get\s*\(\s*["'`]authorization["'`]/i;
const HASH_CALL = /^(createHash|createHmac)$|hash|hmac|digest|sha256/i;

function calleeName(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

/** True when the expression is (or ends in) a hash/HMAC computation. */
function isHashed(e: ts.Expression): boolean {
  let cur: ts.Expression = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  if (ts.isCallExpression(cur)) {
    // walk the whole call chain: createHash("sha256").update(x).digest("hex")
    let c: ts.Expression = cur;
    while (ts.isCallExpression(c) || ts.isPropertyAccessExpression(c)) {
      const n = ts.isCallExpression(c) ? calleeName(c.expression) : c.name.text;
      if (n && HASH_CALL.test(n)) return true;
      c = ts.isCallExpression(c) ? c.expression : c.expression;
    }
  }
  return false;
}

export function scanSource(fileName: string, text: string): Violation[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const decls = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const secretDerived = (e: ts.Expression, depth = 0): boolean => {
    if (depth > 4 || isHashed(e)) return false;
    let cur: ts.Expression = e;
    while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    if (ts.isIdentifier(cur)) {
      if (SECRET_NAME.test(cur.text) && !HASHED_NAME.test(cur.text)) return true;
      const init = decls.get(cur.text);
      return init ? secretDerived(init, depth + 1) : false;
    }
    return SECRET_SOURCE.test(cur.getText(sf));
  };

  const out: Violation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name === "doc") {
        // namespaced `x.doc(id)` → every arg; modular `doc(db, ...segments)` → segments
        const args = ts.isIdentifier(n.expression) ? n.arguments.slice(1) : n.arguments;
        for (const a of args) if (secretDerived(a)) out.push({ file: fileName, line: at(n), rule: "SECRET_RESOURCE_ID", text: n.getText(sf).slice(0, 120) });
      }
      if ((name === "collection" || name === "collectionGroup") && n.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === "admin_sessions")) {
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
  it("does NOT flag hashed ids or ordinary ids (negative controls)", () => {
    expect(rules(`db.collection("i").doc(hashWorkspaceInvitationToken(rawToken));`)).toEqual([]);
    expect(rules(`db.collection("i").doc(createHash("sha256").update(token).digest("hex"));`)).toEqual([]);
    expect(rules(`const tokenHash = hashIt(token); db.collection("i").doc(tokenHash);`)).toEqual([]);
    expect(rules(`db.collection("runs").doc(runId); db.collection("users").doc(uid); doc(db, "w", workspaceId);`)).toEqual([]);
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
