/**
 * SEC-3 / S2-b — M-1 / M-2 corrections (owner authorization 2026-11-14).
 *
 * PARSER-AWARE authority-source invariants (TypeScript AST, see
 * lib/admin/__tests__/authoritySourceGraph.ts). Complements, does not replace,
 * the lexical pins in privilegedGuardPin.spec.ts and the behavioural proofs in
 * privilegedRouteWiring.spec.ts / mixedAudienceGovernanceAuth.spec.ts.
 *
 * M-1  No privileged authority from a raw `admin` claim. EVERY read of an
 *      `admin` member anywhere in the repository's non-test sources — member,
 *      optional, element (literal / template / aliased-constant key),
 *      destructured, `in`, reflective — must be a row of CLAIM_READ_ALLOW,
 *      pinned to its file, enclosing function and count, with a category:
 *        live-record   the guard's live Auth snapshot (the verified boundary)
 *        telemetry     the guard's presented-claim mismatch telemetry
 *        retired       a legacy helper with ZERO importers (asserted below)
 *        inert-field   a derived field with ZERO server-side readers (asserted)
 *        write-log     logging the value a SYSTEM_ADMIN route is WRITING
 *        client-ui     browser affordance; the server decides independently
 *        operator      operator tooling outside the deployed app
 *      A new read — `d.admin !== true`, `!d.admin`, `d["admin"]`, `{ admin }`,
 *      an alias key, in ANY directory — fails here.
 *
 * M-2  Global governance scope has exactly the pinned sources. Taint starts at
 *      the ONLY reader of GOVERNANCE_ADMIN_EMAILS and is propagated through the
 *      whole import graph (named / aliased / default / namespace / re-export /
 *      export-star / dynamic import / require, module-local helpers and
 *      aliases). The full set of tainted exports and of the files importing
 *      them is pinned exactly, so a wrapper, alias or new file anywhere that
 *      can reach the governance-admin decision fails here until reviewed.
 *      Also pinned: the env list has one reader; `"admin_global"` has one
 *      producer; every one of the six mixed-audience handlers authenticates
 *      through the guard's revocation-aware authentication BEFORE any tainted
 *      or protected call.
 */
import ts from "typescript";
import {
  findAdminClaimReads,
  loadFiles,
  sourceFiles,
  taintedExports,
  type ClaimRead,
  type FileSet,
  type TaintSeed,
} from "@/lib/admin/__tests__/authoritySourceGraph";

/** Every deployable or operator source in the repository (tests, docs, public assets excluded). */
const ROOTS = [
  "app", "lib", "components", "hooks", "scripts", "extension", "prisma",
  "middleware.ts", "instrumentation.ts", "instrumentation-client.ts",
  "sentry.edge.config.ts", "sentry.server.config.ts", "force-token-refresh.js",
  "next.config.js", "tailwind.config.ts", "postcss.config.js",
];
const PATHS = sourceFiles(ROOTS);
const FILES: FileSet = loadFiles(PATHS);

/* ========================================================================= *
 * M-1
 * ========================================================================= */

type Category = "live-record" | "telemetry" | "retired" | "inert-field" | "write-log" | "client-ui" | "operator";
const CLAIM_READ_ALLOW: Record<string, { count: number; category: Category; reason: string }> = {
  "lib/admin/verifiedAdminIdentity.ts::readLiveAuthSnapshot": {
    count: 1, category: "live-record",
    reason: "reads customClaims.admin from the ONE live getUser record; the verified input the guard derives SYSTEM_ADMIN from",
  },
  "lib/admin/privilegedAccess.ts::verifiedFrom": {
    count: 1, category: "telemetry",
    reason: "the PRESENTED token's claim, kept only to log privileged_claim_mismatch against the live decision; never decides",
  },
  "lib/firebase/auth-helpers.ts::verifyAdminToken": {
    count: 2, category: "retired",
    reason: "legacy claim-only helper; zero importers outside its defining module (asserted by the retired-helper test)",
  },
  "lib/firebase/auth-helpers.ts::allow": {
    count: 1, category: "retired",
    reason: "inside the legacy requireAdminPortalAccess; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::checkIsAdmin": {
    count: 1, category: "retired",
    reason: "legacy claim predicate; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::checkIsAdminFromToken": {
    count: 1, category: "retired",
    reason: "legacy claim predicate; zero importers (asserted)",
  },
  "lib/firebase/adminAuth.ts::requireSystemAdminBearer": {
    count: 1, category: "retired",
    reason: "legacy SYSTEM_ADMIN bearer helper; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::verifySessionCookieValue": {
    count: 1, category: "inert-field",
    reason: "sets the derived `isAdmin` field on a widely used session verifier; no server-side code reads `isAdmin` (asserted)",
  },
  "app/api/admin/set-role/route.ts::POST": {
    count: 1, category: "write-log",
    reason: "logs the claim value this guarded SYSTEM_ADMIN route has just WRITTEN; authorizes nothing",
  },
  "components/AuthProvider.tsx::AuthProvider": {
    count: 1, category: "client-ui",
    reason: "browser-side menu affordance; every privileged API re-decides on the server from the live record",
  },
  "scripts/check-admin-claims.js::main": {
    count: 1, category: "operator", reason: "operator CLI that reports which accounts hold the claim; not deployed",
  },
  "scripts/verify-admin-claims.js::main": {
    count: 1, category: "operator", reason: "operator CLI that reports which accounts hold the claim; not deployed",
  },
  "force-token-refresh.js::<module>": {
    count: 2, category: "operator", reason: "developer console snippet that prints the current token's claim; not deployed",
  },
};

function claimReadTable(files: FileSet): Record<string, number> {
  const t: Record<string, number> = {};
  for (const [p, src] of files) for (const r of findAdminClaimReads(p, src)) t[`${r.file}::${r.fn}`] = (t[`${r.file}::${r.fn}`] ?? 0) + 1;
  return t;
}
const ALLOWED_TABLE = Object.fromEntries(Object.entries(CLAIM_READ_ALLOW).map(([k, v]) => [k, v.count]));

/** Server-side (non-"use client") sources: app, lib, middleware. */
function serverFiles(files: FileSet): FileSet {
  return new Map(
    [...files].filter(([p, src]) => /^(app|lib)\/|^middleware\.ts$/.test(p) && !/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*["']use client["']/.test(src))
  );
}
/** Reads of a named member (any spelling) — reuses the claim-read parser with another key. */
function memberReads(path: string, src: string, key: string): ClaimRead[] {
  // findAdminClaimReads is keyed on "admin"; re-key by textual substitution of the
  // KEY is not safe, so walk the AST here for the two simple derived names.
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: ClaimRead[] = [];
  const visit = (n: ts.Node) => {
    const hit =
      (ts.isPropertyAccessExpression(n) && n.name.text === key) ||
      (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === key) ||
      (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.propertyName ?? n.name) && (n.propertyName ?? n.name).getText() === key);
    if (hit) out.push({ file: path, fn: "", line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind: "member", text: n.getText().slice(0, 100) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("M-1 — no privileged authority from a raw admin claim (parser-aware)", () => {
  it("sees the whole repository (positive control)", () => {
    expect(PATHS.length).toBeGreaterThan(900);
    for (const must of ["middleware.ts", "lib/admin/privilegedAccess.ts", "components/AuthProvider.tsx", "scripts/check-admin-claims.js", "force-token-refresh.js"]) {
      expect(PATHS).toContain(must);
    }
    expect(PATHS.some((p) => /__tests__|\.(spec|test)\./.test(p))).toBe(false);
  });

  it("EVERY admin-claim read in the repository is exactly a pinned (file, function, count) row", () => {
    expect(claimReadTable(FILES)).toEqual(ALLOWED_TABLE);
  });

  it("every allow-list row has a category and a written reason", () => {
    for (const [k, v] of Object.entries(CLAIM_READ_ALLOW)) {
      expect([k, v.reason.length > 30]).toEqual([k, true]);
    }
  });

  it("'retired' rows: the legacy helpers have ZERO importers anywhere (incl. aliases, namespace, re-export, dynamic import)", () => {
    const seeds: TaintSeed[] = [
      { module: "lib/firebase/auth-helpers.ts", exports: ["verifyAdminToken", "requireAdminPortalAccess", "requireAdminApiAccess", "requireAdmin", "requireSystemAdminAccess", "checkIsAdmin", "checkIsAdminFromToken"], reason: "legacy claim-based helper" },
      { module: "lib/firebase/adminAuth.ts", exports: ["requireSystemAdminBearer", "getRequestUser"], reason: "legacy claim-based helper" },
    ];
    const { importers } = taintedExports(FILES, seeds);
    // Namespace / whole-module importers of these modules would import the helpers
    // too; the only importers allowed are none at all for the helper symbols.
    const offenders = [...importers].filter(([k]) => seeds.some((s) => s.exports.some((e) => k === `${s.module}#${e}`)));
    expect(offenders).toEqual([]);
  });

  it("'inert-field' rows: no server-side source reads the claim-derived `isAdmin` / `tokenClaimAdmin` fields outside their definitions", () => {
    const allow: Record<string, number> = {
      // requireSystemAdminAccess (retired, zero importers) reads its own verifyAdminToken result.
      "lib/firebase/auth-helpers.ts#isAdmin": 1,
      // The guard compares the presented claim to the live decision for telemetry, and copies it onto the actor.
      "lib/admin/privilegedAccess.ts#tokenClaimAdmin": 3,
    };
    const seen: Record<string, number> = {};
    for (const [p, src] of serverFiles(FILES)) {
      for (const key of ["isAdmin", "tokenClaimAdmin"]) {
        const n = memberReads(p, src, key).length;
        if (n > 0) seen[`${p}#${key}`] = n;
      }
    }
    expect(seen).toEqual(allow);
  });

  it("server classification is real: client pages are excluded, routes and lib are included (positive control)", () => {
    const s = serverFiles(FILES);
    expect(s.has("app/api/admin/keys/route.ts")).toBe(true);
    expect(s.has("lib/firebase/auth-helpers.ts")).toBe(true);
    expect(s.has("app/admin/keys/page.tsx")).toBe(false); // "use client" page reads isAdmin from useAuth for display only
  });

  describe("negative controls — the parser sees every forbidden spelling", () => {
    const FORBIDDEN: Array<[string, string]> = [
      ["strict equality", "export function f(d: any) { return d.admin === true; }"],
      ["strict inequality", "export function f(d: any) { if (d.admin !== true) return false; return true; }"],
      ["negation", "export function f(d: any) { return !d.admin; }"],
      ["truthiness", "export function f(d: any) { if (d.admin) return 1; }"],
      ["optional chain", "export function f(d: any) { return d?.admin === true; }"],
      ["deep optional chain", "export function f(r: any) { return r.customClaims?.admin; }"],
      ["element literal", 'export function f(d: any) { return d["admin"] === true; }'],
      ["element single-quote", "export function f(d: any) { return d['admin']; }"],
      ["element template", "export function f(d: any) { return d[`admin`]; }"],
      ["aliased key constant", 'const K = "admin"; export function f(d: any) { return d[K]; }'],
      ["aliased key const-asserted", 'const K = "admin" as const; export function f(d: any) { return d[K]; }'],
      ["destructure shorthand", "export function f(d: any) { const { admin } = d; return admin; }"],
      ["destructure rename", "export function f(d: any) { const { admin: isA } = d; return isA; }"],
      ["destructure quoted key", 'export function f(d: any) { const { "admin": isA } = d; return isA; }'],
      ["destructure in parameter", "export const f = ({ admin }: any) => admin === true;"],
      ["nested destructure", "export function f(t: any) { const { claims: { admin } } = t; return admin; }"],
      ["in operator", 'export function f(d: any) { return "admin" in d; }'],
      ["Reflect.get", 'export function f(d: any) { return Reflect.get(d, "admin"); }'],
      ["lodash get", 'import get from "lodash/get"; export function f(d: any) { return get(d, "admin"); }'],
      ["hasOwnProperty", 'export function f(d: any) { return Object.prototype.hasOwnProperty.call(d, "admin"); }'],
      ["Object.hasOwn", 'export function f(d: any) { return Object.hasOwn(d, "admin"); }'],
      ["aliased object", "export function f(decoded: any) { const c = decoded; return Boolean(c.admin); }"],
      ["helper returning a decision", "export const isPrivileged = (t: any): boolean => t.claims.admin == true;"],
      ["class method", "export class G { ok(t: any) { return t.admin; } }"],
      ["tsx component", "export function C(p: any) { return p.token.admin ? 1 : 0; }"],
    ];
    it.each(FORBIDDEN)("%s is detected", (_name, src) => {
      expect(findAdminClaimReads("lib/new/x.tsx", src).length).toBeGreaterThan(0);
    });

    it.each([
      ["Admin SDK handle", 'import { adminDb } from "@/lib/firebase/admin"; adminDb.collection("x");'],
      ["firebase-admin import", 'import * as admin from "firebase-admin"; admin.auth();'],
      ["writing the claim", "export async function f(a: any, uid: string) { await a.setCustomUserClaims(uid, { admin: true }); }"],
      ["assignment target", "export function f(c: any) { c.admin = true; }"],
      ["team role string", 'export function f(role: string) { return role === "admin"; }'],
      ["unrelated names", "const adminUid = 1; const isAdminPage = true; const administrator = 2;"],
    ])("%s is NOT a claim read (no false positive)", (_name, src) => {
      expect(findAdminClaimReads("lib/new/x.ts", src)).toEqual([]);
    });

    it("an unauthorized claim decision added to a REAL route, or a NEW file anywhere, fails the repository pin", () => {
      const mutated = new Map(FILES);
      const q = "app/api/governance/queue/route.ts";
      mutated.set(q, FILES.get(q)!.replace(
        "export async function GET(request: NextRequest) {",
        "export async function GET(request: NextRequest) {\n  const peek = (request as any).decoded;\n  if (peek && peek.admin !== true) { /* grant */ }"
      ));
      expect(mutated.get(q)).not.toBe(FILES.get(q));
      expect(claimReadTable(mutated)).not.toEqual(ALLOWED_TABLE);
      expect(claimReadTable(mutated)).toMatchObject({ [`${q}::GET`]: 1 });

      const added = new Map(FILES);
      added.set("lib/billing/shortcut.ts", 'export const isOps = (t: Record<string, unknown>) => { const { ["admin"]: a } = t as any; return a === true; };');
      expect(claimReadTable(added)).toMatchObject({ "lib/billing/shortcut.ts::isOps": 1 });

      const moved = new Map(FILES);
      moved.set("components/NewPanel.tsx", "export function P(t: any) { return t.claims.admin; }");
      expect(claimReadTable(moved)).not.toEqual(ALLOWED_TABLE);
    });

    it("an extra read inside an ALLOWED function also fails (counts are exact)", () => {
      const f = "lib/admin/privilegedAccess.ts";
      const mutated = new Map(FILES);
      mutated.set(f, FILES.get(f)!.replace("tokenClaimAdmin: d.admin === true", "tokenClaimAdmin: d.admin === true || d.admin === 1"));
      expect(mutated.get(f)).not.toBe(FILES.get(f));
      expect(claimReadTable(mutated)[`${f}::verifiedFrom`]).toBe(2);
      expect(claimReadTable(mutated)).not.toEqual(ALLOWED_TABLE);
    });
  });
});

/* ========================================================================= *
 * M-2
 * ========================================================================= */

const GOV_SEED: TaintSeed[] = [
  { module: "lib/admin/config.ts", exports: ["isGovernanceAdminEmail"], reason: "the ONLY reader of GOVERNANCE_ADMIN_EMAILS (pinned below)" },
];

/**
 * THE GLOBAL-GOVERNANCE AUTHORITY INVENTORY: every export that can reach the
 * governance-admin decision. Over-approximate by design (an export reaching the
 * decision for a different tier is listed too). Changing a row is a security
 * decision; the reason column says why the path is safe.
 */
const TAINTED_EXPORTS: Record<string, string> = {
  "lib/admin/config.ts#isGovernanceAdminEmail": "the seed: membership predicate over the live, verified email",
  "lib/admin/verifiedAdminIdentity.ts#deriveVerifiedAdminScopes": "derives tiers from ONE live snapshot (verified, enabled email)",
  "lib/admin/verifiedAdminIdentity.ts#resolveVerifiedAdminScopes": "live getUser -> derive; fails closed on lookup failure",
  "lib/admin/verifiedAdminIdentity.ts#hasVerifiedGovernanceAdminAuthority": "live getUser -> derive",
  "lib/admin/verifiedAdminIdentity.ts#hasVerifiedApplicationAdminAuthority": "over-approximation: same live resolver, application tier",
  "lib/admin/privilegedAccess.ts#requirePrivilegedAccess": "THE guard: verified credentials + one live read + revocation + disabled + fail-closed",
  "lib/admin/privilegedAccess.ts#authenticatePrivilegedPrincipal": "the guard's authentication (same checks), no tier decision",
  "lib/governance/authCheck.ts#resolveGovernanceRequestUser": "mixed-audience authentication = authenticatePrivilegedPrincipal",
  "lib/governance/authCheck.ts#checkGovernancePolicyReadAccess": "policy-read audience; called only after resolveGovernanceRequestUser (pinned below)",
  "lib/governance/authCheck.ts#checkAdminOnly": "retired; zero importers (asserted by the importer table)",
  "lib/governance/governanceVisibleUserIds.ts#resolveGovernanceVisibleUserIds": "re-resolves the live identity; the ONLY producer of admin_global",
  "lib/governance/governanceVisibleUserIds.ts#resolveGovernanceVisibleUserIdsCached": "cache key includes uid, email, verification, enabled AND the live governance-admin decision",
  "lib/firebase/auth-helpers.ts#requireAdminPortalAccess": "retired legacy helper; zero importers",
  "lib/firebase/auth-helpers.ts#requireAdminApiAccess": "retired legacy helper; zero importers",
  // Route handlers (leaves: Next.js invokes them; nothing imports them).
  ...Object.fromEntries(
    [
      "app/api/admin/access/route.ts#GET", "app/api/admin/keys/route.ts#GET", "app/api/admin/keys/route.ts#POST",
      "app/api/admin/purge-runs/route.ts#POST", "app/api/admin/runs/[runId]/route.ts#DELETE", "app/api/admin/runs/[runId]/route.ts#GET",
      "app/api/admin/runs/[runId]/route.ts#PATCH", "app/api/admin/runs/route.ts#GET", "app/api/admin/set-role/route.ts#POST",
      "app/api/admin/sync-subscription/route.ts#POST", "app/api/admin/test-webhook/route.ts#POST",
      "app/api/admin/users/[uid]/details/route.ts#GET", "app/api/admin/users/[uid]/override/route.ts#DELETE",
      "app/api/admin/users/[uid]/override/route.ts#POST", "app/api/admin/users/[uid]/route.ts#DELETE",
      "app/api/admin/users/[uid]/route.ts#PATCH", "app/api/admin/users/[uid]/stripe/cancel/route.ts#POST",
      "app/api/admin/users/[uid]/stripe/reactivate/route.ts#POST", "app/api/admin/users/[uid]/stripe/sync/route.ts#POST",
      "app/api/admin/users/route.ts#GET", "app/api/admin/users/search/route.ts#GET",
      "app/api/governance/audit/backfill/route.ts#POST", "app/api/governance/policy/route.ts#POST",
    ].map((k) => [k, "guarded handler: requirePrivilegedAccess with its pinned tier (privilegedGuardPin.spec.ts)"])
  ),
  "app/api/governance/audit/route.ts#GET": "mixed-audience: authenticates first (pinned below), then scoped visibility",
  "app/api/governance/queue/route.ts#GET": "mixed-audience: authenticates first (pinned below), then scoped visibility",
  "app/api/governance/review/route.ts#POST": "mixed-audience: authenticates first (pinned below), then scoped visibility",
  "app/api/governance/policy/route.ts#GET": "mixed-audience: authenticates first (pinned below), then policy-read audience",
  "app/api/governance/reviewer/route.ts#GET": "mixed-audience self-service: authenticates first; no privileged capability",
  "app/api/governance/reviewer/route.ts#POST": "mixed-audience self-service: authenticates first; no privileged capability",
  "app/api/user/usage/route.ts#GET": "presentation only: legacy role label; authorizes nothing",
};

/** EXACT importer table: file -> tainted symbols it imports. A new edge anywhere fails. */
const IMPORTERS: Record<string, string[]> = {
  ...Object.fromEntries(
    [
      "app/api/admin/access/route.ts", "app/api/admin/keys/route.ts", "app/api/admin/purge-runs/route.ts",
      "app/api/admin/runs/[runId]/route.ts", "app/api/admin/runs/route.ts", "app/api/admin/set-role/route.ts",
      "app/api/admin/sync-subscription/route.ts", "app/api/admin/test-webhook/route.ts",
      "app/api/admin/users/[uid]/details/route.ts", "app/api/admin/users/[uid]/override/route.ts",
      "app/api/admin/users/[uid]/route.ts", "app/api/admin/users/[uid]/stripe/cancel/route.ts",
      "app/api/admin/users/[uid]/stripe/reactivate/route.ts", "app/api/admin/users/[uid]/stripe/sync/route.ts",
      "app/api/admin/users/route.ts", "app/api/admin/users/search/route.ts", "app/api/governance/audit/backfill/route.ts",
    ].map((f) => [f, ["lib/admin/privilegedAccess.ts#requirePrivilegedAccess"]])
  ),
  "app/api/governance/audit/route.ts": ["lib/governance/authCheck.ts#resolveGovernanceRequestUser", "lib/governance/governanceVisibleUserIds.ts#resolveGovernanceVisibleUserIdsCached"],
  "app/api/governance/policy/route.ts": ["lib/admin/privilegedAccess.ts#requirePrivilegedAccess", "lib/governance/authCheck.ts#checkGovernancePolicyReadAccess", "lib/governance/authCheck.ts#resolveGovernanceRequestUser"],
  "app/api/governance/queue/route.ts": ["lib/governance/authCheck.ts#resolveGovernanceRequestUser", "lib/governance/governanceVisibleUserIds.ts#resolveGovernanceVisibleUserIdsCached"],
  "app/api/governance/review/route.ts": ["lib/governance/authCheck.ts#resolveGovernanceRequestUser", "lib/governance/governanceVisibleUserIds.ts#resolveGovernanceVisibleUserIds"],
  "app/api/governance/reviewer/route.ts": ["lib/governance/authCheck.ts#resolveGovernanceRequestUser"],
  "app/api/user/usage/route.ts": ["lib/admin/verifiedAdminIdentity.ts#resolveVerifiedAdminScopes"],
  "lib/admin/privilegedAccess.ts": ["lib/admin/verifiedAdminIdentity.ts#deriveVerifiedAdminScopes"],
  "lib/admin/verifiedAdminIdentity.ts": ["lib/admin/config.ts#isGovernanceAdminEmail"],
  "lib/firebase/auth-helpers.ts": ["lib/admin/verifiedAdminIdentity.ts#resolveVerifiedAdminScopes"],
  "lib/governance/authCheck.ts": ["lib/admin/privilegedAccess.ts#authenticatePrivilegedPrincipal", "lib/admin/verifiedAdminIdentity.ts#hasVerifiedGovernanceAdminAuthority"],
  "lib/governance/governanceVisibleUserIds.ts": ["lib/admin/verifiedAdminIdentity.ts#resolveVerifiedAdminScopes"],
};

const MIXED_HANDLERS: Array<{ file: string; method: string }> = [
  { file: "app/api/governance/policy/route.ts", method: "GET" },
  { file: "app/api/governance/audit/route.ts", method: "GET" },
  { file: "app/api/governance/queue/route.ts", method: "GET" },
  { file: "app/api/governance/review/route.ts", method: "POST" },
  { file: "app/api/governance/reviewer/route.ts", method: "GET" },
  { file: "app/api/governance/reviewer/route.ts", method: "POST" },
];

/** Ordered call names reached from an exported handler, inlining module-local functions at their call site. */
function handlerCallSequence(path: string, src: string, method: string): string[] {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const locals = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) locals.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
  }
  const entry = locals.get(method);
  if (!entry) throw new Error(`${path}: no exported ${method}`);
  const seq: string[] = [];
  const calleeName = (e: ts.Expression): string => {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return `${calleeName(e.expression)}.${e.name.text}`;
    if (ts.isElementAccessExpression(e)) return `${calleeName(e.expression)}[]`;
    if (ts.isCallExpression(e)) return `${calleeName(e.expression)}()`;
    if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return calleeName(e.expression);
    return "<expr>";
  };
  const inlining = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      // Arguments are evaluated before the call completes, the callee after: visit args first.
      n.arguments.forEach(walk);
      const name = calleeName(n.expression);
      seq.push(name);
      if (locals.has(name) && name !== method && !inlining.has(name)) {
        inlining.add(name);
        walk(locals.get(name)!);
        inlining.delete(name);
      }
      walk(n.expression);
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(entry);
  return seq;
}

const AUTH_CALL = "resolveGovernanceRequestUser";
/** Module-local function names: their bodies are inlined into the sequence, so the bare name is not itself a protected call. */
function localFunctionNames(src: string): Set<string> {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.add(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.add(d.name.text);
  }
  return out;
}
/** Calls allowed BEFORE authentication in a mixed handler: response construction and timing only. */
const PRE_AUTH_ALLOWED = new Set(["NextResponse.json", "Date.now"]);

function globalMarkers(files: FileSet) {
    const producers: string[] = [];
  const consumers: string[] = [];
  const nullVisibilityCalls: string[] = [];
  for (const [p, src] of files) {
    const sf = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const fnOf = (n: ts.Node) => {
      for (let q: ts.Node | undefined = n.parent; q; q = q.parent) if (ts.isFunctionDeclaration(q) && q.name) return q.name.text;
      return "<module>";
    };
    const v = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n) && n.text === "admin_global" && !ts.isLiteralTypeNode(n.parent)) {
        const par = n.parent;
        const isComparison =
          ts.isBinaryExpression(par) &&
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(par.operatorToken.kind);
        (isComparison || ts.isCaseClause(par) ? consumers : producers).push(`${p}::${fnOf(n)}::admin_global`);
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
        if (n.name.text === "visibleUserIds" && n.initializer.kind === ts.SyntaxKind.NullKeyword) producers.push(`${p}::${fnOf(n)}::visibleUserIds:null`);
        if (n.name.text === "isSupportAdmin" && n.initializer.kind === ts.SyntaxKind.TrueKeyword) producers.push(`${p}::${fnOf(n)}::isSupportAdmin:true`);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runOwnerVisibleInGovernance" && n.arguments[0]?.kind === ts.SyntaxKind.NullKeyword) {
        nullVisibilityCalls.push(p);
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  return { producers, consumers, nullVisibilityCalls };
}

describe("M-2 — global governance authority has exactly the pinned sources (parser-aware)", () => {
  const result = taintedExports(FILES, GOV_SEED);

  it("the tainted-export inventory is exactly pinned (no new path to the governance-admin decision)", () => {
    expect([...result.tainted.keys()].sort()).toEqual(Object.keys(TAINTED_EXPORTS).sort());
    for (const [k, why] of Object.entries(TAINTED_EXPORTS)) expect([k, why.length > 20]).toEqual([k, true]);
  });

  it("the importer table is exactly pinned (every file that imports a tainted export)", () => {
    expect(Object.fromEntries(result.byImporter)).toEqual(IMPORTERS);
  });

  it("retired authority exports have NO importers", () => {
    for (const k of ["lib/governance/authCheck.ts#checkAdminOnly", "lib/firebase/auth-helpers.ts#requireAdminPortalAccess", "lib/firebase/auth-helpers.ts#requireAdminApiAccess", "lib/admin/verifiedAdminIdentity.ts#hasVerifiedApplicationAdminAuthority"]) {
      expect([k, result.importers.get(k) ?? []]).toEqual([k, []]);
    }
  });

  it("GOVERNANCE_ADMIN_EMAILS is read (in code, not comments) by exactly one file", () => {
    const readers: string[] = [];
    for (const [p, src] of FILES) {
      const sf = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      let hit = false;
      const v = (n: ts.Node) => {
        if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === "GOVERNANCE_ADMIN_EMAILS") {
          // A string literal inside a log / error message is not a read.
          const inMessage = ts.isStringLiteralLike(n) && n.parent && (ts.isCallExpression(n.parent) || ts.isTemplateSpan(n.parent));
          if (!inMessage) hit = true;
        }
        ts.forEachChild(n, v);
      };
      v(sf);
      if (hit) readers.push(p);
    }
    expect(readers).toEqual(["lib/admin/config.ts"]);
  });

  it("global-scope MARKERS have exactly one producer: \"admin_global\", `visibleUserIds: null`, `isSupportAdmin: true`, and no literal-null visibility check", () => {
    const { producers, consumers, nullVisibilityCalls } = globalMarkers(FILES);
    const P = "lib/governance/governanceVisibleUserIds.ts::resolveVisibilityForTrustedIdentity";
    // Exact occurrences, not a set: a SECOND producer inside the same function
    // (e.g. a full-plan branch returning global scope) must fail too.
    expect(producers.sort()).toEqual([`${P}::admin_global`, `${P}::isSupportAdmin:true`, `${P}::visibleUserIds:null`]);
    // Every other "admin_global" is a client-side comparison (display only).
    expect([...new Set(consumers.map((c) => c.split("::")[0]))]).toEqual(["components/governance/GovernanceDashboard.tsx"]);
    expect(nullVisibilityCalls).toEqual([]);
  });

  it("negative control: a second global-scope producer inside the SAME function (full plan -> global) is detected", () => {
    const f = "lib/governance/governanceVisibleUserIds.ts";
    const m = new Map(FILES);
    m.set(f, FILES.get(f)!.replace('return { ok: true, visibleUserIds: [], isSupportAdmin: false, queueScope: "no_assigners" };', 'return { ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" };'));
    expect(m.get(f)).not.toBe(FILES.get(f));
    expect(globalMarkers(m).producers.length).toBe(globalMarkers(FILES).producers.length + 3);
    const n = new Map(FILES);
    n.set("lib/x/peek.ts", 'import { runOwnerVisibleInGovernance } from "@/lib/governance/governanceVisibleUserIds";\nexport const all = (o: string) => runOwnerVisibleInGovernance(null, o);');
    expect(globalMarkers(n).nullVisibilityCalls).toEqual(["lib/x/peek.ts"]);
  });

  it.each(MIXED_HANDLERS)("$method $file authenticates through the guard BEFORE any tainted or protected call", ({ file, method }) => {
    const seq = handlerCallSequence(file, FILES.get(file)!, method);
    const authAt = seq.indexOf(AUTH_CALL);
    expect(authAt).toBeGreaterThanOrEqual(0);
    const locals = localFunctionNames(FILES.get(file)!);
    const before = seq.slice(0, authAt).filter((c) => !PRE_AUTH_ALLOWED.has(c) && !locals.has(c));
    expect([file, method, before]).toEqual([file, method, []]);
    // The tainted visibility / policy-read calls the handler makes all come after authentication.
    const taintedNames = (IMPORTERS[file] ?? []).map((k) => k.split("#")[1]).filter((n) => n !== AUTH_CALL);
    for (const n of taintedNames) {
      const at = seq.indexOf(n);
      if (at !== -1) expect([file, method, n, at > authAt]).toEqual([file, method, n, true]);
    }
  });

  it("every one of the six handlers is a real export and exercises the order check (positive control)", () => {
    expect(MIXED_HANDLERS).toHaveLength(6);
    for (const { file, method } of MIXED_HANDLERS) expect(handlerCallSequence(file, FILES.get(file)!, method)).toContain(AUTH_CALL);
    // Visibility-scoped handlers really do call the visibility resolver after authentication.
    expect(handlerCallSequence("app/api/governance/queue/route.ts", FILES.get("app/api/governance/queue/route.ts")!, "GET")).toContain("resolveGovernanceVisibleUserIdsCached");
    expect(handlerCallSequence("app/api/governance/policy/route.ts", FILES.get("app/api/governance/policy/route.ts")!, "GET")).toContain("checkGovernancePolicyReadAccess");
  });

  describe("negative controls — deliberately broken implementations are detected", () => {
    const withFiles = (extra: Record<string, string>) => {
      const m = new Map(FILES);
      for (const [k, v] of Object.entries(extra)) m.set(k, v);
      return taintedExports(m, GOV_SEED);
    };
    const newEdges = (r: ReturnType<typeof taintedExports>) =>
      Object.fromEntries([...r.byImporter].filter(([f]) => !(f in IMPORTERS)));

    it("a wrapper in a NEW directory, under an alias, and its consumer", () => {
      const r = withFiles({
        "lib/shortcuts/gov.ts": 'import { hasVerifiedGovernanceAdminAuthority as isGov } from "@/lib/admin/verifiedAdminIdentity";\nexport const canSeeAll = (u: string) => isGov(u);',
        "app/api/reports/route.ts": 'import { canSeeAll } from "@/lib/shortcuts/gov";\nexport async function GET() { return canSeeAll("x"); }',
      });
      expect(r.tainted.has("lib/shortcuts/gov.ts#canSeeAll")).toBe(true);
      expect(newEdges(r)).toEqual({
        "lib/shortcuts/gov.ts": ["lib/admin/verifiedAdminIdentity.ts#hasVerifiedGovernanceAdminAuthority"],
        "app/api/reports/route.ts": ["lib/shortcuts/gov.ts#canSeeAll"],
      });
    });

    it("a module-local alias of an imported decision", () => {
      const r = withFiles({
        "lib/x/alias.ts": 'import { resolveVerifiedAdminScopes } from "@/lib/admin/verifiedAdminIdentity";\nconst s = resolveVerifiedAdminScopes;\nfunction inner(u: string) { return s(u); }\nexport async function global(u: string) { return (await inner(u)).governanceAdmin; }',
      });
      expect(r.tainted.has("lib/x/alias.ts#global")).toBe(true);
    });

    it("namespace import, re-export, export-star, dynamic import and require all propagate", () => {
      const r = withFiles({
        "lib/x/ns.ts": 'import * as V from "../../lib/governance/governanceVisibleUserIds";\nexport const all = (u: string) => V.resolveGovernanceVisibleUserIds(u);',
        "lib/x/re.ts": 'export { resolveGovernanceRequestUser as who } from "@/lib/governance/authCheck";',
        "lib/x/star.ts": 'export * from "@/lib/governance/authCheck";',
        "lib/x/dyn.ts": 'export async function lazy(u: string) { const m = await import("@/lib/governance/authCheck"); return m.checkGovernancePolicyReadAccess(u); }',
        "lib/x/req.ts": 'export function cjs(u: string) { return require("@/lib/admin/verifiedAdminIdentity").hasVerifiedGovernanceAdminAuthority(u); }',
        "lib/x/consumer.ts": 'import { who } from "@/lib/x/re";\nimport { checkGovernancePolicyReadAccess } from "@/lib/x/star";\nexport const z = [who, checkGovernancePolicyReadAccess];',
      });
      for (const k of ["lib/x/ns.ts#all", "lib/x/re.ts#who", "lib/x/star.ts#checkGovernancePolicyReadAccess", "lib/x/dyn.ts#lazy", "lib/x/req.ts#cjs", "lib/x/consumer.ts#z"]) {
        expect([k, r.tainted.has(k)]).toEqual([k, true]);
      }
      expect(Object.keys(newEdges(r)).sort()).toEqual(["lib/x/consumer.ts", "lib/x/dyn.ts", "lib/x/ns.ts", "lib/x/re.ts", "lib/x/req.ts", "lib/x/star.ts"]);
    });

    it("a full-plan or reviewer path that newly consults the governance-admin decision becomes a new edge", () => {
      const f = "lib/admin/entitlements.ts";
      const r = withFiles({
        [f]: FILES.get(f)! + '\nimport { hasVerifiedGovernanceAdminAuthority as g2 } from "@/lib/admin/verifiedAdminIdentity";\nexport async function fullPlanOrGlobal(u: string) { return (await g2(u)) ? "admin_global" : "own"; }\n',
      });
      expect(r.tainted.has(`${f}#fullPlanOrGlobal`)).toBe(true);
      expect(newEdges(r)).toMatchObject({ [f]: ["lib/admin/verifiedAdminIdentity.ts#hasVerifiedGovernanceAdminAuthority"] });
    });

    it("a NEW reader of GOVERNANCE_ADMIN_EMAILS outside config.ts is visible to the AST", () => {
      const src = "export const gov = () => (process.env.GOVERNANCE_ADMIN_EMAILS ?? '').split(',');";
      const sf = ts.createSourceFile("lib/x/env.ts", src, ts.ScriptTarget.Latest, true);
      let hit = false;
      const v = (n: ts.Node) => { if (ts.isIdentifier(n) && n.text === "GOVERNANCE_ADMIN_EMAILS") hit = true; ts.forEachChild(n, v); };
      v(sf);
      expect(hit).toBe(true);
    });

    it("a handler that touches the visibility resolver or Firestore BEFORE authenticating fails the order check", () => {
      const q = "app/api/governance/queue/route.ts";
      const broken = FILES.get(q)!.replace(
        'const resolved = await resolveGovernanceRequestUser(request, { route: "GET /api/governance/queue" });',
        'const early = await resolveGovernanceVisibleUserIdsCached("x");\n  const resolved = await resolveGovernanceRequestUser(request, { route: "GET /api/governance/queue" });'
      );
      expect(broken).not.toBe(FILES.get(q));
      const seq = handlerCallSequence(q, broken, "GET");
      const before = seq.slice(0, seq.indexOf(AUTH_CALL)).filter((c) => !PRE_AUTH_ALLOWED.has(c));
      expect(before).toContain("resolveGovernanceVisibleUserIdsCached");

      const r2 = "app/api/governance/reviewer/route.ts";
      const broken2 = FILES.get(r2)!.replace(
        "const resolved = await resolveGovernanceRequestUser(req, { route });",
        'await adminDb!.collection("users").doc("x").get();\n  const resolved = await resolveGovernanceRequestUser(req, { route });'
      );
      expect(broken2).not.toBe(FILES.get(r2));
      const seq2 = handlerCallSequence(r2, broken2, "GET");
      expect(seq2.slice(0, seq2.indexOf(AUTH_CALL)).filter((c) => !PRE_AUTH_ALLOWED.has(c)).length).toBeGreaterThan(0);
    });

    it("a handler that never authenticates fails the order check", () => {
      const a = "app/api/governance/audit/route.ts";
      const broken = FILES.get(a)!.replace(/resolveGovernanceRequestUser\(/g, "skipAuth(");
      expect(handlerCallSequence(a, broken, "GET")).not.toContain(AUTH_CALL);
    });
  });
});
