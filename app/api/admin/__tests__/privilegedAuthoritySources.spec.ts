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
  buildClaimKeyIndex,
  envDerivation,
  findAdminClaimReads,
  insertBeforeFunction,
  prependToFunctionBody,
  replaceFunctionBody,
  replaceTopLevelIfCondition,
  loadFiles,
  sourceFiles,
  taintedExports,
  topLevelClosure,
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

type Category = "live-record" | "telemetry" | "retired" | "inert-field" | "write-log" | "client-ui" | "operator" | "reviewed-false-positive";
/**
 * THE CLAIM-READ ALLOW-LIST, keyed `file::function::kind` (kinds: see
 * findAdminClaimReads). `claim-enumeration` / `dynamic-claim-key` are the
 * FAIL-CLOSED kinds: an enumeration of, or a non-literal key on, a claim/token
 * receiver that the parser cannot prove is not the `admin` member.
 */
const CLAIM_READ_ALLOW: Record<string, { count: number; category: Category; reason: string }> = {
  "lib/admin/verifiedAdminIdentity.ts::readLiveAuthSnapshot::member": {
    count: 1, category: "live-record",
    reason: "reads customClaims.admin from the ONE live getUser record; the verified input the guard derives SYSTEM_ADMIN from",
  },
  "lib/admin/privilegedAccess.ts::verifiedFrom::member": {
    count: 1, category: "telemetry",
    reason: "the PRESENTED token's claim, kept only to log privileged_claim_mismatch against the live decision; never decides",
  },
  "lib/firebase/auth-helpers.ts::verifyAdminToken::member": {
    count: 2, category: "retired",
    reason: "legacy claim-only helper; zero importers outside its defining module (asserted by the retired-helper test)",
  },
  "lib/firebase/auth-helpers.ts::verifyAdminToken::claim-enumeration": {
    count: 2, category: "retired",
    reason: "the same retired helper copies non-reserved token keys for a dev-only diagnostic log; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::allow::member": {
    count: 1, category: "retired",
    reason: "inside the legacy requireAdminPortalAccess; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::checkIsAdmin::member": {
    count: 1, category: "retired",
    reason: "legacy claim predicate; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::checkIsAdminFromToken::member": {
    count: 1, category: "retired",
    reason: "legacy claim predicate; zero importers (asserted)",
  },
  "lib/firebase/adminAuth.ts::requireSystemAdminBearer::member": {
    count: 1, category: "retired",
    reason: "legacy SYSTEM_ADMIN bearer helper; zero importers (asserted)",
  },
  "lib/firebase/auth-helpers.ts::verifySessionCookieValue::member": {
    count: 1, category: "inert-field",
    reason: "sets the derived `isAdmin` field on a widely used session verifier; no server-side code reads `isAdmin` (asserted)",
  },
  "app/api/admin/set-role/route.ts::POST::member": {
    count: 1, category: "write-log",
    reason: "logs the claim value this guarded SYSTEM_ADMIN route has just WRITTEN; authorizes nothing",
  },
  "components/AuthProvider.tsx::AuthProvider::member": {
    count: 1, category: "client-ui",
    reason: "browser-side menu affordance; every privileged API re-decides on the server from the live record",
  },
  "scripts/check-admin-claims.js::main::member": {
    count: 1, category: "operator", reason: "operator CLI that reports which accounts hold the claim; not deployed",
  },
  "scripts/check-admin-claims.js::main::claim-enumeration": {
    count: 1, category: "operator", reason: "the same operator CLI prints the account's claim object when it has any keys; not deployed",
  },
  "scripts/verify-admin-claims.js::main::member": {
    count: 1, category: "operator", reason: "operator CLI that reports which accounts hold the claim; not deployed",
  },
  "force-token-refresh.js::<module>::member": {
    count: 2, category: "operator", reason: "developer console snippet that prints the current token's claim; not deployed",
  },
  "lib/agreementMap.ts::labelCluster::dynamic-claim-key": {
    count: 2, category: "reviewed-false-positive",
    reason: "`claims` here is the array of RESEARCH claims in an agreement cluster, indexed by loop counters i/j (lib/agreementMap.ts:609-611); no token data",
  },
};

const KEY_INDEX = buildClaimKeyIndex(FILES);
function claimReadTable(files: FileSet, index = files === FILES ? KEY_INDEX : buildClaimKeyIndex(files)): Record<string, number> {
  const t: Record<string, number> = {};
  for (const [p, src] of files) {
    for (const r of findAdminClaimReads(p, src, index)) {
      const k = `${r.file}::${r.fn}::${r.kind}`;
      t[k] = (t[k] ?? 0) + 1;
    }
  }
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

  it("EVERY admin-claim read in the repository is exactly a pinned (file, function, kind, count) row", () => {
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
      expect(claimReadTable(mutated)).toMatchObject({ [`${q}::GET::member`]: 1 });

      const added = new Map(FILES);
      added.set("lib/billing/shortcut.ts", 'export const isOps = (t: Record<string, unknown>) => { const { ["admin"]: a } = t as any; return a === true; };');
      expect(claimReadTable(added)).toMatchObject({ "lib/billing/shortcut.ts::isOps::destructure": 1 });

      const moved = new Map(FILES);
      moved.set("components/NewPanel.tsx", "export function P(t: any) { return t.claims.admin; }");
      expect(claimReadTable(moved)).not.toEqual(ALLOWED_TABLE);
    });

    it("an extra read inside an ALLOWED function also fails (counts are exact)", () => {
      const f = "lib/admin/privilegedAccess.ts";
      const mutated = new Map(FILES);
      mutated.set(f, FILES.get(f)!.replace("tokenClaimAdmin: d.admin === true", "tokenClaimAdmin: d.admin === true || d.admin === 1"));
      expect(mutated.get(f)).not.toBe(FILES.get(f));
      expect(Object.entries(claimReadTable(mutated)).filter(([k]) => k.startsWith(`${f}::verifiedFrom::`)).reduce((n, [, v]) => n + v, 0)).toBe(2);
      expect(claimReadTable(mutated)).not.toEqual(ALLOWED_TABLE);
    });
  });
});

describe("F-2 — imported and indirect admin-claim reads (cross-file symbol resolution, fail-closed)", () => {
  /** Adds files to the real repository and returns the claim reads found in the NEW/CHANGED files only. */
  const readsWith = (extra: Record<string, string>) => {
    const m = new Map(FILES);
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
    const idx = buildClaimKeyIndex(m);
    return Object.keys(extra).flatMap((f) => findAdminClaimReads(f, m.get(f)!, idx).map((r) => `${r.file}::${r.fn}::${r.kind}`));
  };
  const KEYS = 'export const ADMIN_CLAIM = "admin";\nexport const CLAIM_KEYS = { ADMIN: "admin", EMAIL: "email" } as const;\n';

  it.each([
    ["imported constant (the reviewer's mutant B)", { "lib/admin/claimKeys.ts": KEYS, "app/api/ops/route.ts": 'import { ADMIN_CLAIM } from "@/lib/admin/claimKeys";\nexport async function GET(req: any) { const decoded = req.d; if (decoded[ADMIN_CLAIM] !== true) return 403; return 200; }' }, "app/api/ops/route.ts::GET::element"],
    ["import alias + local alias", { "lib/admin/claimKeys.ts": KEYS, "lib/x/a.ts": 'import { ADMIN_CLAIM as K } from "../admin/claimKeys";\nconst K2 = K;\nexport const f = (d: any) => d[K2];' }, "lib/x/a.ts::f::element"],
    ["re-export chain (named + export *)", { "lib/admin/claimKeys.ts": KEYS, "lib/x/re.ts": 'export { ADMIN_CLAIM as CLAIM } from "@/lib/admin/claimKeys";', "lib/x/star.ts": 'export * from "@/lib/x/re";', "lib/x/use.ts": 'import { CLAIM } from "@/lib/x/star";\nexport function g(t: any) { return t.claims[CLAIM]; }' }, "lib/x/use.ts::g::element"],
    ["namespace import", { "lib/admin/claimKeys.ts": KEYS, "lib/x/ns.ts": 'import * as Keys from "@/lib/admin/claimKeys";\nexport const h = (d: any) => d[Keys.ADMIN_CLAIM] === true;' }, "lib/x/ns.ts::h::element"],
    ["imported object-const member C.ADMIN", { "lib/admin/claimKeys.ts": KEYS, "lib/x/obj.ts": 'import { CLAIM_KEYS as C } from "@/lib/admin/claimKeys";\nexport const i = (d: any) => d[C.ADMIN];' }, "lib/x/obj.ts::i::element"],
    ["namespace object-const member NS.C.ADMIN", { "lib/admin/claimKeys.ts": KEYS, "lib/x/nsobj.ts": 'import * as K from "@/lib/admin/claimKeys";\nexport const j = (d: any) => d[K.CLAIM_KEYS.ADMIN];' }, "lib/x/nsobj.ts::j::element"],
    ["local object-const member", { "lib/x/lobj.ts": 'const C = { ADMIN: "admin" };\nexport const k = (d: any) => d[C.ADMIN];' }, "lib/x/lobj.ts::k::element"],
    ["computed destructuring with an imported key", { "lib/admin/claimKeys.ts": KEYS, "lib/x/cd.ts": 'import { ADMIN_CLAIM } from "@/lib/admin/claimKeys";\nexport function l(d: any) { const { [ADMIN_CLAIM]: a } = d; return a; }' }, "lib/x/cd.ts::l::destructure"],
    ["Object.keys(d).includes(\"admin\")", { "lib/x/k.ts": 'export const m = (d: any) => Object.keys(d).includes("admin");' }, "lib/x/k.ts::m::enumeration"],
    ["Object.entries(d).some(([k]) => k === \"admin\")", { "lib/x/e.ts": 'export const n = (d: any) => Object.entries(d).some(([k, v]) => k === "admin" && v === true);' }, "lib/x/e.ts::n::enumeration"],
    ["Object.entries with an imported key", { "lib/admin/claimKeys.ts": KEYS, "lib/x/e2.ts": 'import { ADMIN_CLAIM } from "@/lib/admin/claimKeys";\nexport const o = (d: any) => Object.entries(d).find(([k]) => k === ADMIN_CLAIM)?.[1];' }, "lib/x/e2.ts::o::enumeration"],
    ["for…in with a key comparison", { "lib/x/fi.ts": 'export function p(d: any) { for (const k in d) { if (k === "admin") return d[k]; } return false; }' }, "lib/x/fi.ts::p::enumeration"],
    ["pick(d, [\"admin\"])", { "lib/x/p.ts": 'import pick from "lodash/pick";\nexport const q = (d: any) => pick(d, ["admin"]).admin2;' }, "lib/x/p.ts::q::selection"],
    ["_.pick(d, \"admin\") with an imported key", { "lib/admin/claimKeys.ts": KEYS, "lib/x/p2.ts": 'import _ from "lodash";\nimport { ADMIN_CLAIM } from "@/lib/admin/claimKeys";\nexport const r = (d: any) => _.pick(d, ADMIN_CLAIM);' }, "lib/x/p2.ts::r::selection"],
    ["get(d, [\"admin\"]) path array", { "lib/x/g.ts": 'import get from "lodash/get";\nexport const s2 = (d: any) => get(d, ["admin"]);' }, "lib/x/g.ts::s2::selection"],
    ["object spread then member", { "lib/x/sp.ts": "export const t = (decoded: any) => ({ ...decoded }).admin;" }, "lib/x/sp.ts::t::member"],
    ["Object.assign wrapper then member", { "lib/x/as.ts": "export const u = (claims: any) => Object.assign({}, claims).admin;" }, "lib/x/as.ts::u::member"],
    ["FAIL-CLOSED: unresolvable computed key on a token receiver", { "lib/x/dyn.ts": "export const v = (decodedToken: any, key: string) => decodedToken[key] === true;" }, "lib/x/dyn.ts::v::dynamic-claim-key"],
    ["FAIL-CLOSED: unresolvable computed key on customClaims", { "lib/x/dyn2.ts": "export const w = (u: any, k: string) => u.customClaims[k];" }, "lib/x/dyn2.ts::w::dynamic-claim-key"],
    ["FAIL-CLOSED: enumeration of a claims receiver", { "lib/x/en.ts": "export const x2 = (claims: any) => Object.values(claims).some(Boolean);" }, "lib/x/en.ts::x2::claim-enumeration"],
    ["FAIL-CLOSED: computed destructuring with an unresolvable key", { "lib/x/dd.ts": "export function y(d: any, k: string) { const { [k]: v } = d; return v; }" }, "lib/x/dd.ts::y::dynamic-destructure"],
  ] as Array<[string, Record<string, string>, string]>)("%s is detected", (_n, extra, expected) => {
    expect(readsWith(extra)).toContain(expected);
  });

  it.each([
    ["a comment mentioning admin claims", { "lib/x/c.ts": "// decoded.admin === true is checked by the guard; d[\"admin\"]\nexport const a = 1;" }],
    ["a log string", { "lib/x/l.ts": 'export const b = (log: any) => log.info("admin claim mismatch", { route: "admin" });' }],
    ["team-role comparisons and role lists", { "lib/x/r.ts": 'export const c = (role: string) => role === "admin" || ["owner", "admin"].includes(role);' }],
    ["a schema enum", { "lib/x/z.ts": 'import { z } from "zod";\nexport const Role = z.enum(["admin", "member"]);' }],
    ["enumerating an unrelated object with no key use", { "lib/x/o.ts": "export const d = (roles: Record<string, number>) => Object.keys(roles).length;" }],
    ["a role-name constant compared to a role", { "lib/x/rc.ts": 'const ADMIN_ROLE = "admin";\nexport const e = (role: string) => role === ADMIN_ROLE;' }],
    ["literal-keyed access to other claims", { "lib/x/o2.ts": 'export const f = (decoded: any) => decoded["email"] ?? decoded.uid;' }],
    ["numeric index on a non-token array", { "lib/x/arr.ts": "export const g = (items: string[], i: number) => items[i];" }],
    ["adminDb / firebase-admin handles", { "lib/x/h.ts": 'import * as admin from "firebase-admin";\nexport const h = () => admin.firestore();' }],
  ] as Array<[string, Record<string, string>]>)("%s is NOT a claim read (no false positive)", (_n, extra) => {
    expect(readsWith(extra)).toEqual([]);
  });

  it("the repository pin fails for the reviewer's mutant B (new key module + new route), not just the unit detector", () => {
    const m = new Map(FILES);
    m.set("lib/admin/claimKeys.ts", KEYS);
    m.set("app/api/ops/route.ts", 'import { ADMIN_CLAIM } from "@/lib/admin/claimKeys";\nexport async function GET(req: any) { const decoded = req.d; if (decoded[ADMIN_CLAIM] !== true) return 403; return 200; }');
    expect(claimReadTable(m)).toMatchObject({ "app/api/ops/route.ts::GET::element": 1 });
    expect(claimReadTable(m)).not.toEqual(ALLOWED_TABLE);
  });

  it("the index resolves key constants across files and through re-exports (positive control) and finds none in the real repository", () => {
    const m = new Map(FILES);
    m.set("lib/admin/claimKeys.ts", KEYS);
    m.set("lib/x/re.ts", 'export { ADMIN_CLAIM as CLAIM } from "@/lib/admin/claimKeys";');
    const idx = buildClaimKeyIndex(m);
    expect(idx.exports.get("lib/admin/claimKeys.ts")?.get("ADMIN_CLAIM")).toEqual({ kind: "key" });
    expect(idx.exports.get("lib/x/re.ts")?.get("CLAIM")).toEqual({ kind: "key" });
    expect([...KEY_INDEX.exports].filter(([, v]) => v.size > 0)).toEqual([]);
  });
});

/* ========================================================================= *
 * M-2
 * ========================================================================= */

/** Function-level readers of GOVERNANCE_ADMIN_EMAILS (code, not comments / log text). Pinned exactly below. */
function envListReaders(files: FileSet): string[] {
  const out: string[] = [];
  for (const [p, src] of files) {
    const sf = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const v = (n: ts.Node) => {
      if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === "GOVERNANCE_ADMIN_EMAILS") {
        // A string literal inside a log / error message is not a read.
        const inMessage = ts.isStringLiteralLike(n) && n.parent && (ts.isCallExpression(n.parent) || ts.isTemplateSpan(n.parent));
        if (!inMessage) {
          let fn: string | null = null;
          for (let q: ts.Node | undefined = n.parent; q; q = q.parent) {
            if ((ts.isFunctionDeclaration(q) || ts.isMethodDeclaration(q)) && q.name) { fn = q.name.getText(); break; }
            if ((ts.isArrowFunction(q) || ts.isFunctionExpression(q)) && q.parent && ts.isVariableDeclaration(q.parent)) { fn = q.parent.name.getText(); break; }
          }
          if (fn === null) {
            // Module level (final F-1): never one generic bucket. A module-level BINDING is
            // named; a module-level STATEMENT is identified by its syntax kind.
            let top: ts.Node = n;
            while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
            if (ts.isVariableStatement(top)) {
              const decl = top.declarationList.declarations.find((d) => d.pos <= n.pos && n.end <= d.end);
              fn = `<module-binding:${decl ? decl.name.getText() : "?"}>`;
            } else fn = `<module-statement:${ts.SyntaxKind[top.kind]}>`;
          }
          out.push(`${p}::${fn}`);
        }
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  // Every OCCURRENCE is kept (no de-duplication): a second read in an already-pinned place fails too.
  return out.sort();
}
const ENV_READERS = [
  "lib/admin/config.ts::<module-statement:IfStatement>", // the startup warning, classified exactly by the F-1 derivation pin; reads presence only, decides nothing
  "lib/admin/config.ts::governanceAdminListShapeForLog", // log SHAPE (configured / valid / invalid counts); seeded anyway (conservative)
  "lib/admin/config.ts::isGovernanceAdminEmail", // THE membership predicate
];
/** Exact export surface of the env-list module: a new export there is a new potential authority source. */
const CONFIG_EXPORTS = ["canonicalizePrivilegedEmail", "governanceAdminListShapeForLog", "invalidPrivilegedEntryCount", "isApplicationAdminEmail", "isGovernanceAdminEmail"];

/**
 * F-1: taint starts at the env-reading FUNCTIONS inside lib/admin/config.ts
 * themselves (seed `locals`), so a sibling wrapper defined in the same module is
 * tainted by local closure before traversal ever leaves the module.
 */
const GOV_SEED: TaintSeed[] = [
  {
    module: "lib/admin/config.ts",
    exports: ["isGovernanceAdminEmail", "governanceAdminListShapeForLog"],
    locals: ["isGovernanceAdminEmail", "governanceAdminListShapeForLog"],
    reason: "function-level readers of GOVERNANCE_ADMIN_EMAILS (ENV_READERS, pinned below)",
  },
];

/**
 * THE GLOBAL-GOVERNANCE AUTHORITY INVENTORY: every export that can reach the
 * governance-admin decision. Over-approximate by design (an export reaching the
 * decision for a different tier is listed too). Changing a row is a security
 * decision; the reason column says why the path is safe.
 */
const TAINTED_EXPORTS: Record<string, string> = {
  "lib/admin/config.ts#isGovernanceAdminEmail": "the seed: membership predicate over the live, verified email",
  "lib/admin/config.ts#governanceAdminListShapeForLog": "seed (F-1, conservative): reads the list only to log configured/valid/invalid COUNTS; returns no membership",
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
  "app/api/governance/queue/route.ts": ["lib/admin/config.ts#governanceAdminListShapeForLog", "lib/governance/authCheck.ts#resolveGovernanceRequestUser", "lib/governance/governanceVisibleUserIds.ts#resolveGovernanceVisibleUserIdsCached"],
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
      // NIT (shorthand): `const visibleUserIds = null; return { visibleUserIds }` and the
      // assignment forms are producers too; a REASSIGNABLE binding used in shorthand fails closed.
      const marker = (name: string, value: ts.Expression | undefined): string | null =>
        name === "visibleUserIds" && value?.kind === ts.SyntaxKind.NullKeyword ? "visibleUserIds:null"
        : name === "isSupportAdmin" && value?.kind === ts.SyntaxKind.TrueKeyword ? "isSupportAdmin:true" : null;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const mk = marker(n.name.text, n.initializer);
        if (mk) producers.push(`${p}::${fnOf(n)}::${mk}(shorthand-source)`);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        const mk = marker(n.left.text, n.right);
        if (mk) producers.push(`${p}::${fnOf(n)}::${mk}(assignment)`);
      }
      if (ts.isShorthandPropertyAssignment(n) && (n.name.text === "visibleUserIds" || n.name.text === "isSupportAdmin")) {
        // Find the binding in the enclosing function; `let`/`var` (reassignable) is not provably safe.
        let scope: ts.Node | undefined = n.parent;
        while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        let reassignable = false;
        const find = (x: ts.Node) => {
          if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === n.name.text && ts.isVariableDeclarationList(x.parent) && !(x.parent.flags & ts.NodeFlags.Const)) reassignable = true;
          ts.forEachChild(x, find);
        };
        if (scope) find(scope);
        if (reassignable) producers.push(`${p}::${fnOf(n)}::${n.name.text}(reassignable-shorthand)`);
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

/* ---- F-3: the authenticated uid is what reaches every scope decision -------- */

/** The handler plus every module-local function it (transitively) calls by name. */
function reachedFunctions(src: string, method: string): ts.Node[] {
  const sf = ts.createSourceFile("h.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const locals = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) locals.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
  }
  const out: ts.Node[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (seen.has(name) || !locals.has(name)) return;
    seen.add(name);
    const node = locals.get(name)!;
    out.push(node);
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) add(n.expression.text);
      ts.forEachChild(n, v);
    };
    v(node);
  };
  add(method);
  return out;
}
const SCOPE_FUNCS = new Set(["resolveGovernanceVisibleUserIds", "resolveGovernanceVisibleUserIdsCached", "checkGovernancePolicyReadAccess", "getAssignerUids"]);
const AUTH_PRODUCERS = new Set(["resolveGovernanceRequestUser", "resolveCaller"]);
/** A module-local wrapper of the authentication call (e.g. reviewer's resolveCaller). */
function isAuthWrapper(f: ts.Node): boolean {
  const name = ts.isFunctionDeclaration(f) && f.name ? f.name.text : ts.isVariableDeclaration(f.parent) ? f.parent.name.getText() : "";
  return AUTH_PRODUCERS.has(name);
}

/** Every scope-decision call and the uid argument it receives; `trusted` = derived from the authenticated result. */
function uidBindings(src: string, method: string): Array<{ call: string; arg: string; trusted: boolean }> {
  const fns = reachedFunctions(src, method);
  const roots = new Set<string>();
  const uids = new Set<string>();
  const strip = (e: ts.Expression): ts.Expression => (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ? strip(e.expression) : e);
  const isTrusted = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    e = strip(e);
    if (ts.isIdentifier(e)) return uids.has(e.text);
    return ts.isPropertyAccessExpression(e) && e.name.text === "uid" && ts.isIdentifier(strip(e.expression)) && roots.has((strip(e.expression) as ts.Identifier).text);
  };
  // Pass 1: roots (results of the authentication calls) and uid identifiers derived from them (const only).
  for (let pass = 0; pass < 3; pass++) for (const f of fns) {
    const v = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)) {
        const init = strip(n.initializer);
        if (ts.isIdentifier(n.name) && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && AUTH_PRODUCERS.has(init.expression.text)) roots.add(n.name.text);
        if (ts.isIdentifier(n.name) && isTrusted(init)) uids.add(n.name.text);
        if (ts.isObjectBindingPattern(n.name) && ts.isIdentifier(init) && roots.has(init.text))
          for (const el of n.name.elements) if ((el.propertyName ?? el.name).getText() === "uid" && ts.isIdentifier(el.name)) uids.add(el.name.text);
      }
      ts.forEachChild(n, v);
    };
    v(f);
  }
  const out: Array<{ call: string; arg: string; trusted: boolean }> = [];
  for (const f of fns) {
    const v = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
        if (SCOPE_FUNCS.has(name)) out.push({ call: name, arg: n.arguments[0]?.getText() ?? "<none>", trusted: isTrusted(n.arguments[0]) });
        // Own-record scope reads: `.where("governanceReviewerUid", "==", X)` must bind the caller.
        if (name === "where" && n.arguments.length === 3 && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === "governanceReviewerUid") {
          out.push({ call: "where(governanceReviewerUid)", arg: n.arguments[2].getText(), trusted: isTrusted(n.arguments[2]) });
        }
      }
      // resolveCaller-style wrappers: the uid they RETURN (from their own body, not a nested callback) must be trusted.
      if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression) && isAuthWrapper(f)) {
        let owner: ts.Node | undefined = n.parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        if (owner === f) {
          for (const pr of n.expression.properties) {
            if (ts.isPropertyAssignment(pr) && pr.name.getText() === "uid") out.push({ call: "return{uid}", arg: pr.initializer.getText(), trusted: isTrusted(pr.initializer) });
          }
        }
      }
      // Every `uid` binding in the handler must come from the authenticated result.
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "uid" && n.initializer) {
        out.push({ call: "bind uid", arg: n.initializer.getText(), trusted: uids.has("uid") && isTrusted(n.initializer) });
      }
      ts.forEachChild(n, v);
    };
    v(f);
  }
  return out;
}

/** Request-derived field names a handler reads (query params and JSON body), so an identity field cannot be introduced silently. */
function requestFields(src: string, method: string): string[] {
  const fns = reachedFunctions(src, method);
  const bodyVars = new Set<string>();
  const spVars = new Set<string>();
  const out = new Set<string>();
  const isJsonCall = (e: ts.Expression): boolean => {
    while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "json" && /^(req|request)$/.test(e.expression.expression.getText());
  };
  for (let pass = 0; pass < 2; pass++) for (const f of fns) {
    const v = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (ts.isIdentifier(n.name) && isJsonCall(n.initializer)) bodyVars.add(n.name.text);
        if (ts.isIdentifier(n.name) && /searchParams$/.test(n.initializer.getText())) spVars.add(n.name.text);
        if (ts.isObjectBindingPattern(n.name) && ts.isIdentifier(n.initializer) && bodyVars.has(n.initializer.text))
          for (const el of n.name.elements) out.add(`body.${(el.propertyName ?? el.name).getText()}`);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isJsonCall(n.right)) bodyVars.add(n.left.text);
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && bodyVars.has(n.expression.text)) out.add(`body.${n.name.text}`);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const recv = n.expression.expression;
        if (/searchParams$/.test(recv.getText()) || (ts.isIdentifier(recv) && spVars.has(recv.text))) out.add(`query.${n.arguments[0].text}`);
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === "params" && !/searchParams/.test(n.getText())) out.add(`route.params`);
      ts.forEachChild(n, v);
    };
    v(f);
  }
  return [...out].sort();
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

  it("GOVERNANCE_ADMIN_EMAILS is read (in code, not comments) by exactly the pinned FUNCTIONS, all in one module", () => {
    expect(envListReaders(FILES)).toEqual(ENV_READERS);
    // Every non-module reader is a seed (no reader escapes the taint).
    const seeded = new Set(GOV_SEED.flatMap((sd) => (sd.locals ?? []).map((l) => `${sd.module}::${l}`)));
    for (const r of ENV_READERS.filter((x) => !x.includes("::<module-"))) expect([r, seeded.has(r)]).toEqual([r, true]);
  });

  it("the env-list module's export surface is exactly pinned", () => {
    const sf = ts.createSourceFile("c.ts", FILES.get("lib/admin/config.ts")!, ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(st)) names.push(`<export-declaration:${st.getText().slice(0, 60)}>`);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names.push(d.name.getText());
      else if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) names.push(st.name.text);
      else if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
      else names.push(`<other:${st.getText().slice(0, 40)}>`);
    }
    expect(names.sort()).toEqual(CONFIG_EXPORTS);
  });

  describe("F-1 negative controls — a wrapper INSIDE the seed module", () => {
    const withConfig = (append: string, extra: Record<string, string> = {}) => {
      const m = new Map(FILES);
      m.set("lib/admin/config.ts", FILES.get("lib/admin/config.ts")! + append);
      for (const [k, v] of Object.entries(extra)) m.set(k, v);
      return { m, r: taintedExports(m, GOV_SEED) };
    };

    it("the reviewer's mutant A: sibling export wrapping isGovernanceAdminEmail + a new route importing it", () => {
      const { r } = withConfig("\nexport const isGovernanceListed = (e: string) => isGovernanceAdminEmail(e);\n", {
        "app/api/reports/route.ts": 'import { isGovernanceListed } from "@/lib/admin/config";\nexport async function GET(req: any) { return isGovernanceListed(req.headers.get("x-email")) ? 200 : 403; }',
      });
      expect(r.tainted.has("lib/admin/config.ts#isGovernanceListed")).toBe(true);
      expect(r.tainted.has("app/api/reports/route.ts#GET")).toBe(true);
      expect(Object.fromEntries(r.byImporter)).not.toEqual(IMPORTERS);
      expect(r.byImporter.get("app/api/reports/route.ts")).toEqual(["lib/admin/config.ts#isGovernanceListed"]);
    });

    it("an indirect chain of local helpers, a re-export and an aliased import elsewhere", () => {
      const { r } = withConfig(
        "\nfunction inner(e: string) { return isGovernanceAdminEmail(e); }\nfunction middle(e: string) { return inner(e); }\nexport { middle as governanceListed };\n",
        { "lib/x/user.ts": 'import { governanceListed as gl } from "@/lib/admin/config";\nexport const viaAlias = (e: string) => gl(e);' }
      );
      expect(r.tainted.has("lib/admin/config.ts#governanceListed")).toBe(true);
      expect(r.tainted.has("lib/x/user.ts#viaAlias")).toBe(true);
    });

    it("a NEW reader of the env list inside config.ts (a second predicate) fails the function-level reader pin", () => {
      const { m } = withConfig("\nexport function anyGovernanceAdmins() { return Boolean(process.env.GOVERNANCE_ADMIN_EMAILS); }\n");
      expect(envListReaders(m)).toContain("lib/admin/config.ts::anyGovernanceAdmins");
      expect(envListReaders(m)).not.toEqual(ENV_READERS);
    });

    it("cycles between modules terminate and still propagate", () => {
      const { r } = withConfig("", {
        "lib/x/cyc1.ts": 'import { b } from "@/lib/x/cyc2";\nimport { isGovernanceAdminEmail } from "@/lib/admin/config";\nexport const a = (e: string): boolean => b(e) || isGovernanceAdminEmail(e);',
        "lib/x/cyc2.ts": 'import { a } from "@/lib/x/cyc1";\nexport const b = (e: string): boolean => e.length > 99 && a(e);',
      });
      expect(r.tainted.has("lib/x/cyc1.ts#a")).toBe(true);
      expect(r.tainted.has("lib/x/cyc2.ts#b")).toBe(true);
    });

    it("an exports-only seed (no `locals`) ALSO catches the sibling wrapper: the engine's seed-module local closure, not the seed shape, is what catches it", () => {
      const m = new Map(FILES);
      m.set("lib/admin/config.ts", FILES.get("lib/admin/config.ts")! + "\nexport const isGovernanceListed = (e: string) => isGovernanceAdminEmail(e);\n");
      const legacySeed: TaintSeed[] = [{ module: "lib/admin/config.ts", exports: ["isGovernanceAdminEmail"], reason: "pre-F-1 seed shape" }];
      // Even the exports-only seed now taints the local closure (the engine fix), so the wrapper is caught either way.
      expect(taintedExports(m, legacySeed).tainted.has("lib/admin/config.ts#isGovernanceListed")).toBe(true);
    });
  });

  /* ----------------------------------------------------------------------- *
   * F-1 (final round): MODULE-LEVEL reads and DERIVED values in config.ts.
   * The previous pin filed any top-level read under one `<module>` bucket with
   * no count, so a module-level constant built from GOVERNANCE_ADMIN_EMAILS and
   * consumed by isApplicationAdminEmail (reviewer mutant R1) passed every suite.
   * ----------------------------------------------------------------------- */
  describe("F-1 (final) — every governance-list read and every value derived from it is classified", () => {
    const CFG = "lib/admin/config.ts";
    const GOV = "GOVERNANCE_ADMIN_EMAILS";
    /** Reviewed top-level declarations deriving from GOVERNANCE_ADMIN_EMAILS. Exactly these; nothing else in the module. */
    const DERIVED: Record<string, string> = {
      governanceAdminListShapeForLog: "log SHAPE only (configured / valid / invalid counts); grants nothing; seeded anyway",
      isGovernanceAdminEmail: "THE governance membership predicate (consumed only through the live-record verified resolver)",
    };
    /**
     * E1b: reviewed state mutations in config.ts, keyed EXACTLY as
     * `envDerivation(...).stateWrites` reports them ("<top-level>::<operation text>").
     * Each entry must say why it cannot transfer privileged authority. There are
     * none today; an unclassified write fails (no silent permission).
     */
    const REVIEWED_STATE_WRITES: Record<string, string> = {};
    /**
     * Every F-1 invariant over one version of config.ts. Returns the violated
     * invariants; [] means all hold. The SAME function judges the real file and
     * every control below, so a control cannot pass for an unrelated reason.
     */
    const violations = (src: string): string[] => {
      const v: string[] = [];
      const d = envDerivation(CFG, src, GOV);
      // (1)+(2) every derived value is a reviewed declaration.
      if (JSON.stringify(d.derived) !== JSON.stringify(Object.keys(DERIVED).sort())) v.push(`derived:${d.derived.join(",")}`);
      // the taint seed covers exactly the derived set (no derived value escapes the inventory)
      const seedLocals = [...(GOV_SEED.find((s) => s.module === CFG)?.locals ?? [])].sort();
      if (JSON.stringify(seedLocals) !== JSON.stringify(d.derived)) v.push("seed-not-equal-derived");
      // no module-level state at all: a derived value cannot be parked in a module binding
      if (d.variableBindings.length) v.push(`module-bindings:${d.variableBindings.join(",")}`);
      // (6) exactly ONE module-level statement, and it is the startup warning (console.warn with literal text only, no else)
      const ms = d.moduleStatements;
      if (ms.length !== 1 || ms[0].kind !== "startup-warning") v.push(`module-statements:${ms.map((s) => `${s.kind}[${s.text}]`).join("|")}`);
      // fail closed: no process.env use whose key cannot be resolved
      if (d.dynamicEnv.length) v.push(`dynamic-env:${d.dynamicEnv.join("|")}`);
      // E1b: no unreviewed property / element / global-object write or reflective mutation (a side channel between functions)
      const unreviewed = d.stateWrites.filter((w) => !(w in REVIEWED_STATE_WRITES));
      if (unreviewed.length) v.push(`state-writes:${unreviewed.join("|")}`);
      // (3)+(4)+(5) tier separation, both directions, over the full local closure
      const tierReads = (fn: string) => {
        const scope = [fn, ...topLevelClosure(d, fn)];
        return { derived: scope.filter((x) => d.derived.includes(x)), env: [...new Set(scope.flatMap((x) => d.envReads.get(x) ?? []))].sort() };
      };
      const app = tierReads("isApplicationAdminEmail");
      if (app.derived.length || JSON.stringify(app.env) !== '["ADMIN_EMAILS"]') v.push(`isApplicationAdminEmail-reads:${app.env.join(",")}|derived:${app.derived.join(",")}`);
      const gov = tierReads("isGovernanceAdminEmail");
      if (JSON.stringify(gov.env) !== `["${GOV}"]`) v.push(`isGovernanceAdminEmail-reads:${gov.env.join(",")}`);
      // the repo-wide occurrence pin agrees
      const m = new Map(FILES);
      m.set(CFG, src);
      if (JSON.stringify(envListReaders(m)) !== JSON.stringify(ENV_READERS)) v.push(`env-readers:${envListReaders(m).filter((r) => r.startsWith(CFG)).join(",")}`);
      return v;
    };
    const SRC = FILES.get(CFG)!;
    const replaceOnce = (src: string, from: string, to: string) => {
      expect(src.split(from).length - 1).toBe(1); // the control really edits the file
      const out = src.replace(from, to);
      expect(out).not.toBe(src);
      return out;
    };

    it("the real config.ts satisfies every F-1 invariant", () => {
      expect(violations(SRC)).toEqual([]);
      const d = envDerivation(CFG, SRC, GOV);
      expect(d.moduleStatements.map((s) => [s.kind, s.envReads])).toEqual([["startup-warning", ["ADMIN_EMAILS", GOV]]]);
      expect(d.variableBindings).toEqual([]);
      expect(d.stateWrites).toEqual([]);
      // (the exact closure of isApplicationAdminEmail is NOT pinned: violations() checks it semantically, so an application-only helper stays allowed)
    });

    it("CONTROL R1 (the reviewer's mutant): a module-level const read from the governance list feeding isApplicationAdminEmail FAILS", () => {
      // syntax-aware set-up (by function name), so a legitimate refactor of config.ts does not break the control
      const r1 = prependToFunctionBody(
        insertBeforeFunction(SRC, "isApplicationAdminEmail", "const GOVERNANCE_LIST = parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS);"),
        "isApplicationAdminEmail",
        "if (GOVERNANCE_LIST.includes(canonicalizePrivilegedEmail(email) ?? \"\")) return true;"
      );
      expect(r1).toContain("GOVERNANCE_LIST.includes(");
      const v = violations(r1);
      expect(v).toEqual(expect.arrayContaining([
        "derived:GOVERNANCE_LIST,governanceAdminListShapeForLog,isApplicationAdminEmail,isGovernanceAdminEmail",
        "module-bindings:GOVERNANCE_LIST",
        "isApplicationAdminEmail-reads:ADMIN_EMAILS,GOVERNANCE_ADMIN_EMAILS|derived:isApplicationAdminEmail,GOVERNANCE_LIST",
      ]));
      expect(v.some((x) => x.startsWith("env-readers:") && x.includes("<module-binding:GOVERNANCE_LIST>"))).toBe(true);
    });

    it.each([
      ["R1 via bracket key", `const G = process.env["GOVERNANCE_ADMIN_EMAILS"];`, "parsePrivilegedList(G)"],
      ["R1 via a key constant", `const K = "GOVERNANCE_ADMIN_EMAILS";`, "parsePrivilegedList(process.env[K])"],
      ["R1 via destructuring", `const { GOVERNANCE_ADMIN_EMAILS: G } = process.env;`, "parsePrivilegedList(G)"],
      ["R1 via a lazily filled module cache", `let cache: string[] | null = null;\nfunction govList() { return (cache ??= parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS)); }`, "govList()"],
      ["write-through from the governance predicate", `const seen: string[] = [];`, "seen"],
    ])("CONTROL %s FAILS", (_label, decl, list) => {
      // syntax-aware set-up (by function name)
      let src = insertBeforeFunction(SRC, "isApplicationAdminEmail", decl);
      src = prependToFunctionBody(src, "isApplicationAdminEmail", `if (${list}.includes(canonicalizePrivilegedEmail(email) ?? "")) return true;`);
      expect(src).toContain(decl);
      if (_label.startsWith("write-through")) {
        // syntax-aware: replaces the predicate's body wherever / however it is written
        src = replaceFunctionBody(src, "isGovernanceAdminEmail", "{\n  const c = canonicalizePrivilegedEmail(email);\n  if (!c) return false;\n  const l = parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS);\n  seen.push(...l);\n  return l.includes(c);\n}");
      }
      const v = violations(src);
      expect(v.some((x) => x.startsWith("isApplicationAdminEmail-reads:"))).toBe(true);
      expect(v.some((x) => x.startsWith("module-bindings:"))).toBe(true);
    });

    it("CONTROL: a shared helper that defaults to the governance list (no module binding) FAILS tier separation", () => {
      const src = prependToFunctionBody(SRC, "parsePrivilegedList", "raw ??= process.env.GOVERNANCE_ADMIN_EMAILS;");
      expect(src).toContain("raw ??= process.env.GOVERNANCE_ADMIN_EMAILS;");
      const v = violations(src);
      expect(v.some((x) => x.startsWith("isApplicationAdminEmail-reads:"))).toBe(true);
      expect(v.some((x) => x.startsWith("derived:") && x.includes("parsePrivilegedList"))).toBe(true);
    });

    it("CONTROL: a dynamic process.env key in config.ts FAILS closed", () => {
      const src = prependToFunctionBody(SRC, "isApplicationAdminEmail", "const k = ['ADMIN', 'EMAILS'].join('_'); if (parsePrivilegedList(process.env[k]).includes(canonicalizePrivilegedEmail(email) ?? \"\")) return true;");
      expect(src).toContain("process.env[k]");
      expect(violations(src).some((x) => x.startsWith("dynamic-env:"))).toBe(true);
    });

    it("CONTROL: the startup-warning statement is NOT a generic exemption (other module-level statements FAIL)", () => {
      const warn = SRC.slice(SRC.lastIndexOf("if ("));
      // a module-level statement that stores state instead of warning
      const side = SRC + '\nif (process.env.GOVERNANCE_ADMIN_EMAILS) { (globalThis as any).__gov = process.env.GOVERNANCE_ADMIN_EMAILS; }\n';
      expect(violations(side).some((x) => x.startsWith("module-statements:"))).toBe(true);
      // the warning given an else branch
      const withElse = SRC + "";
      const elsed = replaceOnce(withElse, warn, warn.trimEnd() + " else { (globalThis as any).__gov = 1; }\n");
      expect(violations(elsed).some((x) => x.startsWith("module-statements:"))).toBe(true);
      // a second warning-shaped statement (count is exact)
      expect(violations(SRC + "\n" + warn).some((x) => x.startsWith("module-statements:"))).toBe(true);
    });

    it("POSITIVE CONTROL: legitimate refactors of governance-list reads are NOT blocked", () => {
      // Syntax-aware set-up (no exact-text anchors): each refactor is applied by function NAME.
      // function-local derived value inside the reviewed predicate
      const local = replaceFunctionBody(SRC, "isGovernanceAdminEmail", "{\n  const c = canonicalizePrivilegedEmail(email);\n  if (!c) return false;\n  const list = parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS);\n  return list.includes(c);\n}");
      expect(local).toContain("const list = parsePrivilegedList(process.env.GOVERNANCE_ADMIN_EMAILS);");
      expect(violations(local)).toEqual([]);
      // an application-only helper used by isApplicationAdminEmail
      const helper = replaceFunctionBody(
        insertBeforeFunction(SRC, "isApplicationAdminEmail", "function applicationListRaw(): string | undefined {\n  return process.env.ADMIN_EMAILS;\n}"),
        "isApplicationAdminEmail",
        "{\n  const c = canonicalizePrivilegedEmail(email);\n  if (!c) return false;\n  return parsePrivilegedList(applicationListRaw()).includes(c);\n}"
      );
      expect(helper).toContain("applicationListRaw()");
      expect(violations(helper)).toEqual([]);
    });

    /* E1b (reviewer's surviving mutant) and its state-channel variants. Set-up is syntax-aware. */
    const SHAPE_STASH_BODY = (stash: string) =>
      `{\n  const raw = process.env.GOVERNANCE_ADMIN_EMAILS;\n  const configured = (raw ?? "").split(",").filter((e) => e.trim().length > 0).length;\n  const l = parsePrivilegedList(raw);\n  ${stash}\n  const valid = l.length;\n  return \`configured=\${configured} valid=\${valid} invalid=\${configured - valid}\`;\n}`;
    it.each([
      ["E1b: function-object property", "(canonicalizePrivilegedEmail as any).g = l;", "if (((canonicalizePrivilegedEmail as any).g ?? []).includes(canonicalizePrivilegedEmail(email))) return true;"],
      ["computed property write", '(canonicalizePrivilegedEmail as any)["g"] = l;', 'if (((canonicalizePrivilegedEmail as any)["g"] ?? []).includes(canonicalizePrivilegedEmail(email))) return true;'],
      ["globalThis property", "(globalThis as any).__cpg = l;", "if (((globalThis as any).__cpg ?? []).includes(canonicalizePrivilegedEmail(email))) return true;"],
      ["Object.assign", "Object.assign(canonicalizePrivilegedEmail, { g: l });", "if (((canonicalizePrivilegedEmail as any).g ?? []).includes(canonicalizePrivilegedEmail(email))) return true;"],
      ["Object.defineProperty", 'Object.defineProperty(canonicalizePrivilegedEmail, "g", { value: l, configurable: true });', "if (((canonicalizePrivilegedEmail as any).g ?? []).includes(canonicalizePrivilegedEmail(email))) return true;"],
      ["Reflect.set", 'Reflect.set(canonicalizePrivilegedEmail, "g", l);', "if (((canonicalizePrivilegedEmail as any).g ?? []).includes(canonicalizePrivilegedEmail(email))) return true;"],
    ])("CONTROL %s carrying the governance list into isApplicationAdminEmail FAILS statically", (_label, stash, read) => {
      const src = prependToFunctionBody(replaceFunctionBody(SRC, "governanceAdminListShapeForLog", SHAPE_STASH_BODY(stash)), "isApplicationAdminEmail", read);
      expect(src).toContain(stash);
      expect(src).toContain(read);
      expect(violations(src).some((x) => x.startsWith("state-writes:"))).toBe(true);
    });

    it.each([
      ["E2: globalThis assignment in the condition", '!((globalThis as any).__cpg = process.env.GOVERNANCE_ADMIN_EMAILS)?.trim()'],
      ["an update expression in the condition", 'typeof window === "undefined" && (globalCounter++ > -1) && !process.env.ADMIN_EMAILS?.trim()'],
      ["a non-trim call in the condition", 'typeof window === "undefined" && !process.env.ADMIN_EMAILS?.trim() && !record(process.env.GOVERNANCE_ADMIN_EMAILS)'],
    ])("CONTROL %s: the startup warning is no longer classified as the warning (FAILS without relying on a fresh import)", (_label, cond) => {
      const src = replaceTopLevelIfCondition(SRC, cond);
      expect(src).toContain(cond);
      expect(violations(src).some((x) => x.startsWith("module-statements:"))).toBe(true);
    });

    it("POSITIVE CONTROL: the approved startup warning, re-written with an equivalent pure condition, is still the warning", () => {
      const src = replaceTopLevelIfCondition(SRC, 'typeof window === "undefined" && !process.env.GOVERNANCE_ADMIN_EMAILS?.trim() && !process.env.ADMIN_EMAILS?.trim()');
      expect(src).not.toBe(SRC);
      expect(violations(src)).toEqual([]);
    });
  });

  describe("F-1 (final) — tier separation BEHAVIOUR on a FRESH import (module-level values are evaluated at import time)", () => {
    const KEYS = ["ADMIN_EMAILS", "GOVERNANCE_ADMIN_EMAILS"] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
    afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
    const fresh = (adminEmails: string, governanceEmails: string) => {
      process.env.ADMIN_EMAILS = adminEmails;
      process.env.GOVERNANCE_ADMIN_EMAILS = governanceEmails;
      let mod!: typeof import("@/lib/admin/config");
      jest.isolateModules(() => { mod = require("@/lib/admin/config"); });
      return mod;
    };
    it("a governance-only address is NOT an application (ADMIN_PORTAL) admin, and vice versa", () => {
      const m = fresh("portal-only@test-invented.example", "gov-only@test-invented.example");
      expect(m.isApplicationAdminEmail("gov-only@test-invented.example")).toBe(false);
      expect(m.isGovernanceAdminEmail("gov-only@test-invented.example")).toBe(true);
      expect(m.isApplicationAdminEmail("portal-only@test-invented.example")).toBe(true);
      expect(m.isGovernanceAdminEmail("portal-only@test-invented.example")).toBe(false);
    });
    it("an address on BOTH lists holds both memberships (independent, not blended)", () => {
      const m = fresh("both@test-invented.example", "both@test-invented.example");
      expect([m.isApplicationAdminEmail("both@test-invented.example"), m.isGovernanceAdminEmail("both@test-invented.example")]).toEqual([true, true]);
    });
    it("an empty application list grants no application membership even when the governance list is populated", () => {
      const m = fresh("", "gov-only@test-invented.example");
      expect(m.isApplicationAdminEmail("gov-only@test-invented.example")).toBe(false);
    });
    it("E1b ORDER-SENSITIVE: after the governance code paths run in the SAME module instance (shape log, governance predicate), governance-only membership still never grants application membership — repeated; and the reverse", () => {
      const GOV_ONLY = "gov-only@test-invented.example";
      const APP_ONLY = "portal-only@test-invented.example";
      const m = fresh(APP_ONLY, GOV_ONLY);
      for (let round = 0; round < 3; round++) {
        // the governance code paths production executes (queue GET logs the shape on every request)
        expect(m.governanceAdminListShapeForLog()).toBe("configured=1 valid=1 invalid=0");
        expect(m.isGovernanceAdminEmail(GOV_ONLY)).toBe(true);
        // ... then the application-admin decision for the same address
        expect([round, m.isApplicationAdminEmail(GOV_ONLY)]).toEqual([round, false]);
        // reverse direction: the application paths first, then the governance decision
        expect(m.isApplicationAdminEmail(APP_ONLY)).toBe(true);
        expect([round, m.isGovernanceAdminEmail(APP_ONLY)]).toEqual([round, false]);
      }
      // still separated after interleaving in the opposite order on the same instance
      expect(m.isApplicationAdminEmail(GOV_ONLY)).toBe(false);
      expect(m.governanceAdminListShapeForLog()).toBe("configured=1 valid=1 invalid=0");
      expect(m.isGovernanceAdminEmail(APP_ONLY)).toBe(false);
    });
  });

  /* ----------------------------------------------------------------------- *
   * V5 (owner ruling 2026-11-14): BEHAVIOURAL tier-separation gate with
   * MULTI-ENTRY lists and an EMPTY application list. Real exported functions,
   * fresh module instance per scenario, env and ambient process state isolated.
   * (The single-entry tests above never activate a channel gated on list size.)
   * ----------------------------------------------------------------------- */
  describe("V5 — multi-entry / empty-list tier separation BEHAVIOUR (fresh module, order-sensitive)", () => {
    const KEYS = ["ADMIN_EMAILS", "GOVERNANCE_ADMIN_EMAILS"] as const;
    const saved: Record<string, string | undefined> = {};
    let savedArgv: string[] = [];
    beforeEach(() => {
      for (const k of KEYS) saved[k] = process.env[k];
      savedArgv = [...process.argv];
    });
    afterEach(() => {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      // restore ambient process state a (mutant) implementation could have altered
      process.argv.splice(0, process.argv.length, ...savedArgv);
    });
    const fresh = (adminEmails: string, governanceEmails: string) => {
      process.env.ADMIN_EMAILS = adminEmails;
      process.env.GOVERNANCE_ADMIN_EMAILS = governanceEmails;
      let mod!: typeof import("@/lib/admin/config");
      jest.isolateModules(() => { mod = require("@/lib/admin/config"); });
      return mod;
    };
    const G1 = "gov-one@test-invented.example";
    const G2 = "gov-two@test-invented.example";
    const G3 = "gov-three@test-invented.example";
    const A1 = "app-only@test-invented.example";

    it("Scenario 1 — ADMIN_EMAILS empty, two governance admins: after the governance paths run (repeatedly), neither governance admin is an application admin", () => {
      const m = fresh("", `${G1},${G2}`);
      expect(m.governanceAdminListShapeForLog()).toBe("configured=2 valid=2 invalid=0");
      expect([m.isGovernanceAdminEmail(G1), m.isGovernanceAdminEmail(G2)]).toEqual([true, true]);
      expect([m.isApplicationAdminEmail(G1), m.isApplicationAdminEmail(G2)]).toEqual([false, false]);
      for (let i = 0; i < 5; i++) {
        expect(m.governanceAdminListShapeForLog()).toBe("configured=2 valid=2 invalid=0");
        expect([i, m.isGovernanceAdminEmail(G1), m.isGovernanceAdminEmail(G2)]).toEqual([i, true, true]);
        expect([i, m.isApplicationAdminEmail(G1), m.isApplicationAdminEmail(G2)]).toEqual([i, false, false]);
      }
    });

    it("Scenario 1b — three governance admins (larger list), application list empty: still no application membership", () => {
      const m = fresh("", `${G1},${G2},${G3}`);
      for (let i = 0; i < 3; i++) m.governanceAdminListShapeForLog();
      for (const g of [G1, G2, G3]) {
        expect([g, m.isGovernanceAdminEmail(g)]).toEqual([g, true]);
        expect([g, m.isApplicationAdminEmail(g)]).toEqual([g, false]);
      }
    });

    it("Scenario 2 — one application-only admin and two governance-only admins: memberships stay independent in one module instance", () => {
      const m = fresh(A1, `${G1},${G2}`);
      for (let i = 0; i < 3; i++) {
        expect(m.governanceAdminListShapeForLog()).toBe("configured=2 valid=2 invalid=0");
        expect([i, m.isGovernanceAdminEmail(G1), m.isGovernanceAdminEmail(G2)]).toEqual([i, true, true]);
        expect([i, m.isApplicationAdminEmail(G1), m.isApplicationAdminEmail(G2)]).toEqual([i, false, false]);
        expect([i, m.isApplicationAdminEmail(A1)]).toEqual([i, true]);
        expect([i, m.isGovernanceAdminEmail(A1)]).toEqual([i, false]);
      }
    });

    type Op = "shape" | "gov" | "app";
    const ORDERS: Op[][] = [
      ["shape", "gov", "app"], ["shape", "app", "gov"], ["gov", "shape", "app"],
      ["gov", "app", "shape"], ["app", "shape", "gov"], ["app", "gov", "shape"],
    ];
    it.each(ORDERS.map((o) => [o.join(" → "), o]))("Scenario 3 — execution order %s (repeated, fresh module): results identical to the expected matrix", (_label, order) => {
      const m = fresh(A1, `${G1},${G2}`);
      const run = (op: Op) => {
        if (op === "shape") return m.governanceAdminListShapeForLog();
        if (op === "gov") return [G1, G2, A1].map((e) => m.isGovernanceAdminEmail(e));
        return [G1, G2, A1].map((e) => m.isApplicationAdminEmail(e));
      };
      const expected: Record<Op, unknown> = { shape: "configured=2 valid=2 invalid=0", gov: [true, true, false], app: [false, false, true] };
      for (let round = 0; round < 3; round++) {
        for (const op of order as Op[]) expect([round, op, run(op)]).toEqual([round, op, expected[op]]);
      }
      // and once more in the reverse of this order, on the same instance
      for (const op of [...(order as Op[])].reverse()) expect(["reverse", op, run(op)]).toEqual(["reverse", op, expected[op]]);
    });

    it("POSITIVE CONTROL — the same multi-entry module grants each tier to its own list (the gate is not vacuous)", () => {
      const m = fresh(`${A1},${G1}`, `${G1},${G2}`);
      m.governanceAdminListShapeForLog();
      // G1 is deliberately on BOTH lists: both memberships, independently
      expect([m.isApplicationAdminEmail(G1), m.isGovernanceAdminEmail(G1)]).toEqual([true, true]);
      expect([m.isApplicationAdminEmail(G2), m.isGovernanceAdminEmail(G2)]).toEqual([false, true]);
      expect([m.isApplicationAdminEmail(A1), m.isGovernanceAdminEmail(A1)]).toEqual([true, false]);
    });
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

  it("NIT negative control: the reviewer's mutant D — a shorthand `{ visibleUserIds }` bound to null — is detected structurally", () => {
    const f = "lib/governance/governanceVisibleUserIds.ts";
    const from = 'return { ok: true, visibleUserIds: [], isSupportAdmin: false, queueScope: "no_assigners" };';
    expect(FILES.get(f)!.split(from).length - 1).toBe(1);
    const shorthand = new Map(FILES);
    shorthand.set(f, FILES.get(f)!.replace(from, 'const visibleUserIds = null;\n    return { ok: true, visibleUserIds, isSupportAdmin: false, queueScope: "no_assigners" };'));
    expect(globalMarkers(shorthand).producers.length).toBe(globalMarkers(FILES).producers.length + 1);
    const assigned = new Map(FILES);
    assigned.set(f, FILES.get(f)!.replace(from, 'let visibleUserIds: string[] | null = [];\n    visibleUserIds = null;\n    return { ok: true, visibleUserIds, isSupportAdmin: false, queueScope: "no_assigners" };'));
    expect(globalMarkers(assigned).producers.length).toBeGreaterThan(globalMarkers(FILES).producers.length);
    const supportAdmin = new Map(FILES);
    supportAdmin.set(f, FILES.get(f)!.replace(from, 'const isSupportAdmin = true;\n    return { ok: true, visibleUserIds: [], isSupportAdmin, queueScope: "no_assigners" };'));
    expect(globalMarkers(supportAdmin).producers.length).toBe(globalMarkers(FILES).producers.length + 1);
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

  /** F-3: the exact uid bindings per handler (every one derived from the authenticated result). */
  const UID_BINDINGS: Record<string, string[]> = {
    "GET app/api/governance/policy/route.ts": ["checkGovernancePolicyReadAccess(resolved.uid)"],
    "GET app/api/governance/audit/route.ts": ["resolveGovernanceVisibleUserIdsCached(resolved.uid)"],
    "GET app/api/governance/queue/route.ts": ["resolveGovernanceVisibleUserIdsCached(resolved.uid)"],
    "POST app/api/governance/review/route.ts": ["bind uid(resolved.uid)", "resolveGovernanceVisibleUserIds(resolved.uid)"],
    "GET app/api/governance/reviewer/route.ts": ["bind uid(caller.uid)", "return{uid}(resolved.uid)", "where(governanceReviewerUid)(uid)"],
    "POST app/api/governance/reviewer/route.ts": ["bind uid(caller.uid)", "return{uid}(resolved.uid)"],
  };
  /** F-3: the exact request-derived fields each handler reads. None names an identity to act as. */
  const REQUEST_FIELDS: Record<string, string[]> = {
    "GET app/api/governance/policy/route.ts": [],
    "GET app/api/governance/audit/route.ts": ["query.collection", "query.from", "query.limit", "query.runId", "query.runType", "query.to"],
    "GET app/api/governance/queue/route.ts": ["query.limit", "query.offset", "query.runType", "query.status"],
    "POST app/api/governance/review/route.ts": ["body.action", "body.collection", "body.comment", "body.runId"],
    "GET app/api/governance/reviewer/route.ts": [],
    // reviewerEmail names the TARGET reviewer to assign (looked up live, plan-checked), never the acting identity.
    "POST app/api/governance/reviewer/route.ts": ["body.action", "body.enabled", "body.reviewerEmail"],
  };
  const fmt = (b: ReturnType<typeof uidBindings>) => b.map((x) => `${x.call}(${x.arg})`).sort();

  it.each(MIXED_HANDLERS)("F-3: $method $file passes ONLY the authenticated uid to every scope decision", ({ file, method }) => {
    const key = `${method} ${file}`;
    const b = uidBindings(FILES.get(file)!, method);
    expect([key, b.filter((x) => !x.trusted)]).toEqual([key, []]);
    expect([key, fmt(b)]).toEqual([key, [...UID_BINDINGS[key]].sort()]);
  });

  it.each(MIXED_HANDLERS)("F-3: $method $file reads exactly its pinned request fields (no request-supplied identity)", ({ file, method }) => {
    const key = `${method} ${file}`;
    expect([key, requestFields(FILES.get(file)!, method)]).toEqual([key, REQUEST_FIELDS[key]]);
  });

  describe("F-3 negative controls — a handler that evaluates scope for ANOTHER identity is detected", () => {
    const edit = (file: string, from: string, to: string) => {
      const src = FILES.get(file)!;
      expect(src.split(from).length - 1).toBe(1);
      return src.replace(from, to);
    };
    it("the reviewer's mutant C: queue takes the uid from a query parameter", () => {
      const q = "app/api/governance/queue/route.ts";
      const src = edit(q, "resolveGovernanceVisibleUserIdsCached(resolved.uid)", 'resolveGovernanceVisibleUserIdsCached(request.nextUrl.searchParams.get("asUid") ?? resolved.uid)');
      expect(uidBindings(src, "GET").some((x) => !x.trusted)).toBe(true);
      expect(requestFields(src, "GET")).toContain("query.asUid");
    });
    it("audit evaluates a hardcoded other user's uid", () => {
      const src = edit("app/api/governance/audit/route.ts", "resolveGovernanceVisibleUserIdsCached(resolved.uid)", 'resolveGovernanceVisibleUserIdsCached("uid-of-user-b")');
      expect(uidBindings(src, "GET").some((x) => !x.trusted)).toBe(true);
    });
    it("review evaluates a uid taken from the request body", () => {
      const src = edit("app/api/governance/review/route.ts", "resolveGovernanceVisibleUserIds(resolved.uid)", "resolveGovernanceVisibleUserIds((body as any)?.uid ?? resolved.uid)");
      expect(uidBindings(src, "POST").some((x) => !x.trusted)).toBe(true);
    });
    it("policy read access evaluated for a mismatched identity field (email instead of uid)", () => {
      const src = edit("app/api/governance/policy/route.ts", "checkGovernancePolicyReadAccess(resolved.uid)", "checkGovernancePolicyReadAccess(resolved.email)");
      expect(uidBindings(src, "GET").some((x) => !x.trusted)).toBe(true);
    });
    it("reviewer: the auth wrapper returns a uid from a header", () => {
      const src = edit("app/api/governance/reviewer/route.ts", "return { uid: resolved.uid, email: resolved.email };", 'return { uid: req.headers.get("x-uid") ?? resolved.uid, email: resolved.email };');
      expect(uidBindings(src, "GET").some((x) => !x.trusted)).toBe(true);
      expect(uidBindings(src, "POST").some((x) => !x.trusted)).toBe(true);
    });
    it("reviewer GET: the assigner query is bound to another identity", () => {
      const src = edit("app/api/governance/reviewer/route.ts", '.where("governanceReviewerUid", "==", uid)', '.where("governanceReviewerUid", "==", "uid-of-user-b")');
      expect(uidBindings(src, "GET").some((x) => !x.trusted)).toBe(true);
    });
    it("a REASSIGNABLE uid (let, later overwritten) is not trusted", () => {
      const src = edit("app/api/governance/review/route.ts", "const uid = resolved.uid;", 'let uid = resolved.uid; uid = "uid-of-user-b";');
      expect(uidBindings(src, "POST").some((x) => !x.trusted)).toBe(true);
    });
    it("a new identity-like body field fails the request-field pin", () => {
      const src = edit("app/api/governance/review/route.ts", "const { runId, collection: coll, action, comment } = body;", "const { runId, collection: coll, action, comment, actingUid } = body;");
      expect(requestFields(src, "POST")).toContain("body.actingUid");
    });
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
