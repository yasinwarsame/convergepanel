/**
 * SEC-3 / S2-b — STRUCTURAL PIN: every privileged handler is wired to the guard.
 *
 * Fails if:
 *   - any `app/api/admin/**` route file does not import the guard (no
 *     exceptions are currently allowed; add one to ALLOW_UNGUARDED with a
 *     written reason, never silently);
 *   - any exported handler (in those files, plus the two pure GOVERNANCE_ADMIN
 *     handlers) does not call `requirePrivilegedAccess` with its pinned tier,
 *     or touches Firestore / Auth / Stripe / the request body before it does;
 *   - a handler exists that this pin does not know about (a new route or
 *     method must be given a tier here, deliberately);
 *   - a legacy privileged helper or an inline claim / allowlist check
 *     reappears in any of these files (two divergent authorities);
 *   - ANY non-test source file under app/, lib/ or middleware.ts, outside the
 *     explicit REPO_AUTHORITY_ALLOW list, calls a legacy helper or a live-record
 *     authority resolver, or reads the `admin` claim inline.
 *
 * The behaviour behind these pins is proven by privilegedRouteWiring.spec.ts;
 * this file only stops a future edit from bypassing it structurally.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type Tier = "SYSTEM_ADMIN" | "ADMIN_PORTAL" | "GOVERNANCE_ADMIN";

/** THE TIER CONTRACT, per handler. Changing a row is a security decision. */
const EXPECTED: Record<string, Tier> = {
  "GET /api/admin/access": "ADMIN_PORTAL",
  "GET /api/admin/keys": "SYSTEM_ADMIN",
  "POST /api/admin/keys": "SYSTEM_ADMIN",
  "POST /api/admin/purge-runs": "SYSTEM_ADMIN",
  "GET /api/admin/runs": "ADMIN_PORTAL",
  "GET /api/admin/runs/[runId]": "ADMIN_PORTAL",
  "PATCH /api/admin/runs/[runId]": "SYSTEM_ADMIN",
  "DELETE /api/admin/runs/[runId]": "SYSTEM_ADMIN",
  "POST /api/admin/set-role": "SYSTEM_ADMIN",
  "POST /api/admin/sync-subscription": "SYSTEM_ADMIN",
  "POST /api/admin/test-webhook": "SYSTEM_ADMIN",
  "GET /api/admin/users": "ADMIN_PORTAL",
  "GET /api/admin/users/search": "SYSTEM_ADMIN",
  "PATCH /api/admin/users/[uid]": "SYSTEM_ADMIN",
  "DELETE /api/admin/users/[uid]": "SYSTEM_ADMIN",
  "GET /api/admin/users/[uid]/details": "SYSTEM_ADMIN",
  "POST /api/admin/users/[uid]/override": "SYSTEM_ADMIN",
  "DELETE /api/admin/users/[uid]/override": "SYSTEM_ADMIN",
  "POST /api/admin/users/[uid]/stripe/cancel": "SYSTEM_ADMIN",
  "POST /api/admin/users/[uid]/stripe/reactivate": "SYSTEM_ADMIN",
  "POST /api/admin/users/[uid]/stripe/sync": "SYSTEM_ADMIN",
  "POST /api/governance/audit/backfill": "GOVERNANCE_ADMIN",
  "POST /api/governance/policy": "GOVERNANCE_ADMIN",
};

/**
 * Governance handlers deliberately NOT on the guard: their audience is not a
 * single privileged tier (Governance Admin OR an assigned reviewer, OR a
 * `full`-plan caller, OR plan-gated self-service). They stay on
 * `resolveGovernanceRequestUser` + their own scoping; see
 * docs/operations/s2b-route-inventory.md. Listed so a new governance handler
 * cannot appear without a decision.
 */
const GOVERNANCE_MIXED_AUDIENCE = new Set([
  "GET /api/governance/audit",
  "GET /api/governance/policy",
  "GET /api/governance/queue",
  "POST /api/governance/review",
  "GET /api/governance/reviewer",
  "POST /api/governance/reviewer",
]);

/** `app/api/admin/**` route files allowed NOT to import the guard, with a reason. None today. */
const ALLOW_UNGUARDED: Record<string, string> = {};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "__tests__" || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(join(ROOT, p)).isDirectory()) routeFiles(p, out);
    else if (/^route\.(ts|tsx|js|mjs)$/.test(e)) out.push(p);
  }
  return out;
}
const routePath = (file: string) => "/" + file.replace(/^app\//, "").replace(/\/route\.(ts|tsx|js|mjs)$/, "");

/** Exported handler bodies: from `export ... METHOD(` to the next top-level `export` or EOF. */
function handlers(file: string): Array<{ key: string; body: string }> {
  const src = readFileSync(join(ROOT, file), "utf8");
  const out: Array<{ key: string; body: string }> = [];
  const re = /^export\s+(?:async\s+function|function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;
  const starts: Array<{ m: string; i: number }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ m: m[1], i: m.index });
  for (const [n, s] of starts.entries()) {
    const nextExport = src.slice(s.i + 1).search(/^export\s/m);
    const end = n + 1 < starts.length ? starts[n + 1].i : nextExport === -1 ? src.length : s.i + 1 + nextExport;
    out.push({ key: `${s.m} ${routePath(file)}`, body: src.slice(s.i, end) });
  }
  // Indirect exports (`export { x as GET }`) would hide a handler from this pin.
  expect(src).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\bas\\s+(${METHODS.join("|")})\\b`));
  return out;
}

const ADMIN_FILES = routeFiles("app/api/admin");
const GOV_FILES = routeFiles("app/api/governance");
const ALL_HANDLERS = [...ADMIN_FILES, ...GOV_FILES].flatMap((f) => handlers(f).map((h) => ({ ...h, file: f })));
const GUARDED = ALL_HANDLERS.filter((h) => h.key in EXPECTED);

/** Anything that reads protected state or acts before the decision. */
const PROTECTED_TOUCH = /\badminDb\b|\badminAuth\b|\bstripe\b|\b(?:request|req)\.json\s*\(|\bhandleSubscriptionChange\s*\(|\bdeleteResearchRun\s*\(/;
const LEGACY_AUTHORITY =
  /requireSystemAdminAccess|requireSystemAdminBearer|requireAdminPortalAccess|requireAdminApiAccess|\brequireAdmin\b|verifyAdminToken|getRequestUser|checkIsAdmin|checkAdminOnly|hasVerifiedApplicationAdminAuthority|hasVerifiedGovernanceAdminAuthority|resolveVerifiedAdminScopes|isApplicationAdminEmail|isGovernanceAdminEmail|ADMIN_EMAILS|\.admin\s*===\s*true|customClaims\?*\.admin\s*===/;

/* ------------------------------------------------------------------------- *
 * REPO-WIDE AUTHORITY BAN. Every privilege decision goes through
 * `requirePrivilegedAccess`. Outside the explicit allow-list below, no non-test
 * source file under app/, lib/ or middleware.ts may call a legacy privileged
 * helper or one of the live-record authority resolvers, or read the `admin`
 * claim inline. The walk is the FILESYSTEM (a superset of the tracked files),
 * so a new, not-yet-committed file is caught too.
 * ------------------------------------------------------------------------- */
const REPO_AUTHORITY =
  /\b(requireSystemAdminAccess|requireSystemAdminBearer|requireAdminPortalAccess|requireAdminApiAccess|requireAdmin|verifyAdminToken|getRequestUser|checkIsAdmin|checkIsAdminFromToken|checkAdminOnly|hasVerifiedApplicationAdminAuthority|hasVerifiedGovernanceAdminAuthority|resolveVerifiedAdminScopes|deriveVerifiedAdminScopes|isApplicationAdminEmail|isGovernanceAdminEmail)\b|\.admin\s*===\s*true|customClaims\s*\??\.\s*admin\b|customClaims\s*(?:\?\.)?\s*\[\s*["']admin["']\s*\]|\btoken\s*\??\.\s*admin\b/g;

/** Normalises a raw match to a stable label, so the allow-list names exactly what each file may use. */
function labelOf(raw: string): string {
  if (/^\.admin\s*===\s*true$/.test(raw)) return ".admin === true";
  if (/^customClaims/.test(raw)) return "customClaims.admin";
  if (/^token/.test(raw)) return "token.admin";
  return raw;
}
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, "");
function matchesIn(src: string): string[] {
  return [...new Set([...stripComments(src).matchAll(REPO_AUTHORITY)].map((m) => labelOf(m[0])))].sort();
}
const authorityMatches = (file: string) => matchesIn(readFileSync(join(ROOT, file), "utf8"));

function repoSourceFiles(): string[] {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir))) {
      if (e === "__tests__" || e === "node_modules" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e) && !/\.(spec|test)\.[a-z]+$/.test(e)) out.push(p);
    }
    return out;
  };
  return [...walk("app"), ...walk("lib"), "middleware.ts"];
}

/** THE ALLOW-LIST. Each entry names exactly which matches the file may contain, and why. */
const REPO_AUTHORITY_ALLOW: Record<string, { allowed: string[]; reason: string }> = {
  "lib/admin/privilegedAccess.ts": {
    allowed: ["deriveVerifiedAdminScopes", ".admin === true"],
    reason: "the guard itself: derives tiers from the live snapshot; the token claim is read for mismatch telemetry only",
  },
  "lib/admin/verifiedAdminIdentity.ts": {
    allowed: [
      "deriveVerifiedAdminScopes", "hasVerifiedApplicationAdminAuthority", "hasVerifiedGovernanceAdminAuthority",
      "isApplicationAdminEmail", "isGovernanceAdminEmail", "resolveVerifiedAdminScopes",
    ],
    reason: "defining module of the live-record authority resolvers the guard is built on",
  },
  "lib/admin/config.ts": {
    allowed: ["isApplicationAdminEmail", "isGovernanceAdminEmail"],
    reason: "defining module of the ADMIN_EMAILS / GOVERNANCE_ADMIN_EMAILS membership predicates",
  },
  "lib/firebase/auth-helpers.ts": {
    allowed: [
      ".admin === true", "checkIsAdmin", "checkIsAdminFromToken", "requireAdmin", "requireAdminApiAccess",
      "requireAdminPortalAccess", "requireSystemAdminAccess", "resolveVerifiedAdminScopes", "verifyAdminToken",
    ],
    reason: "definition site of the retired legacy helpers (no route callers; kept until their unit specs are retired)",
  },
  "lib/firebase/adminAuth.ts": {
    allowed: ["getRequestUser", "requireSystemAdminBearer"],
    reason: "definition site of the retired legacy SYSTEM_ADMIN bearer helper (no route callers)",
  },
  "lib/governance/authCheck.ts": {
    allowed: ["checkAdminOnly", "hasVerifiedGovernanceAdminAuthority"],
    reason: "mixed-audience governance: policy-READ audience (Governance Admin OR full plan) and the retired checkAdminOnly definition",
  },
  "lib/governance/governanceVisibleUserIds.ts": {
    allowed: ["resolveVerifiedAdminScopes"],
    reason: "mixed-audience governance: global-vs-reviewer queue/audit/review visibility for the unguarded handlers",
  },
  "app/api/user/usage/route.ts": {
    allowed: ["resolveVerifiedAdminScopes"],
    reason: "presentation only: emits the legacy role label, which authorizes nothing",
  },
  "app/api/admin/set-role/route.ts": {
    allowed: ["customClaims.admin"],
    reason: "logs the claim value this SYSTEM_ADMIN route is WRITING; not an authority read",
  },
};

/* ------------------------------------------------------------------------- *
 * APP/API-WIDE HANDLER DISCOVERY (owner ruling E). Any route file anywhere under
 * app/api that imports the guard, the governance authCheck, or uses a banned
 * authority symbol must have EVERY handler classified: a tier in EXPECTED, a
 * row in GOVERNANCE_MIXED_AUDIENCE, or an OTHER_CLASSIFIED entry with a reason.
 * ------------------------------------------------------------------------- */
const OTHER_CLASSIFIED: Record<string, string> = {
  "GET /api/user/usage": "presentation only: emits the legacy role label from resolveVerifiedAdminScopes; authorizes nothing",
};
function touchesAuthority(src: string): boolean {
  const code = stripComments(src);
  return /["']@\/lib\/admin\/privilegedAccess["']|["']@\/lib\/governance\/authCheck["']/.test(code) || matchesIn(src).length > 0;
}
function authorityRouteHandlers(): Array<{ key: string; file: string }> {
  return routeFiles("app/api")
    .filter((f) => touchesAuthority(readFileSync(join(ROOT, f), "utf8")))
    .flatMap((f) => handlers(f).map((h) => ({ key: h.key, file: f })));
}

describe("S2-b guard pin", () => {
  it("sees the real route tree (positive control)", () => {
    expect(ADMIN_FILES.length).toBe(16);
    expect(ALL_HANDLERS.length).toBe(Object.keys(EXPECTED).length + GOVERNANCE_MIXED_AUDIENCE.size);
  });

  it("every handler under app/api/admin and app/api/governance is classified (no unknown handler)", () => {
    const unknown = ALL_HANDLERS.map((h) => h.key).filter((k) => !(k in EXPECTED) && !GOVERNANCE_MIXED_AUDIENCE.has(k));
    expect(unknown).toEqual([]);
    const missing = [...Object.keys(EXPECTED), ...GOVERNANCE_MIXED_AUDIENCE].filter((k) => !ALL_HANDLERS.some((h) => h.key === k));
    expect(missing).toEqual([]);
  });

  it("every app/api/admin route file imports the guard and its denial response", () => {
    const offenders = ADMIN_FILES.filter((f) => !(relative(ROOT, join(ROOT, f)) in ALLOW_UNGUARDED)).filter((f) => {
      const src = readFileSync(join(ROOT, f), "utf8");
      return !/import\s*\{[^}]*\brequirePrivilegedAccess\b[^}]*\}\s*from\s*"@\/lib\/admin\/privilegedAccess"/.test(src) || !/\bprivilegedDenialResponse\b/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(EXPECTED))("%s calls the guard with tier %s BEFORE touching anything protected", (key, tier) => {
    const h = GUARDED.find((x) => x.key === key);
    expect(h).toBeDefined();
    const body = (h as { body: string }).body;
    const call = /requirePrivilegedAccess\(\s*(?:request|req)\s*,\s*"([A-Z_]+)"\s*,\s*\{\s*route:\s*"([^"]+)"\s*\}\s*\)/.exec(body);
    expect(call).not.toBeNull();
    const [, calledTier, routeLabel] = call as RegExpExecArray;
    expect(calledTier).toBe(tier);
    expect(routeLabel).toBe(key);
    // Exactly one guard call per handler, and the denial is returned on the very next statement.
    expect(body.match(/requirePrivilegedAccess\(/g)).toHaveLength(1);
    const afterCall = body.slice((call as RegExpExecArray).index);
    expect(afterCall).toMatch(/^[^;]*;\s*if \(!access\.ok\) return privilegedDenialResponse\(access\);/);
    const before = body.slice(0, (call as RegExpExecArray).index);
    expect(before).not.toMatch(PROTECTED_TOUCH);
  });

  it("no guarded route file carries a legacy privileged helper or an inline claim / allowlist check", () => {
    const files = [...new Set(GUARDED.map((h) => h.file))];
    const offenders = files.filter((f) => LEGACY_AUTHORITY.test(readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(offenders).toEqual([]);
  });

  it("no file under app/ or middleware imports a legacy privileged helper (the guard is the one authority)", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(join(ROOT, dir))) {
        if (e === "__tests__" || e === "node_modules" || e.startsWith(".")) continue;
        const p = join(dir, e);
        if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e)) out.push(p);
      }
      return out;
    };
    const files = [...walk("app"), "middleware.ts"];
    expect(files.length).toBeGreaterThan(100);
    const HELPERS = /\b(requireSystemAdminAccess|requireSystemAdminBearer|requireAdminPortalAccess|requireAdminApiAccess|requireAdmin|verifyAdminToken|getRequestUser|checkIsAdmin|checkIsAdminFromToken|checkAdminOnly)\b/;
    const offenders = files.filter((f) => {
      const code = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, "");
      return HELPERS.test(code) || /from\s+"@\/lib\/firebase\/adminAuth"/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("REPO-WIDE: no non-test source under app/, lib/ or middleware.ts re-derives privilege outside the allow-list", () => {
    const offenders: Record<string, string[]> = {};
    for (const f of repoSourceFiles()) {
      const found = authorityMatches(f);
      if (found.length === 0) continue;
      const allowed = REPO_AUTHORITY_ALLOW[f]?.allowed ?? [];
      const extra = found.filter((m) => !allowed.includes(m));
      if (extra.length > 0) offenders[f] = extra;
    }
    expect(offenders).toEqual({});
  });

  it("REPO-WIDE: every allow-list entry is still a real use with exactly its listed matches (no stale exemptions)", () => {
    for (const [f, { allowed, reason }] of Object.entries(REPO_AUTHORITY_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect([f, authorityMatches(f)]).toEqual([f, [...allowed].sort()]);
    }
  });

  it("REPO-WIDE: the walk sees app/, lib/ and middleware.ts, and skips tests (positive control)", () => {
    const files = repoSourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(expect.arrayContaining(["middleware.ts", "lib/admin/privilegedAccess.ts", "app/api/user/usage/route.ts"]));
    expect(files.some((f) => /__tests__|\.(spec|test)\./.test(f))).toBe(false);
  });

  it("APP/API-WIDE: every route handler touching the guard, governance authCheck or an authority symbol is classified", () => {
    const unclassified = authorityRouteHandlers()
      .map((h) => h.key)
      .filter((k) => !(k in EXPECTED) && !GOVERNANCE_MIXED_AUDIENCE.has(k) && !(k in OTHER_CLASSIFIED));
    expect(unclassified).toEqual([]);
  });

  it("APP/API-WIDE: every OTHER_CLASSIFIED entry is a real handler still touching an authority surface (no stale entry)", () => {
    const seen = new Set(authorityRouteHandlers().map((h) => h.key));
    for (const [k, reason] of Object.entries(OTHER_CLASSIFIED)) {
      expect(reason.length).toBeGreaterThan(20);
      expect([k, seen.has(k)]).toEqual([k, true]);
    }
  });

  it("APP/API-WIDE: discovery walks all of app/api and sees the known authority routes (positive control)", () => {
    const files = new Set(authorityRouteHandlers().map((h) => h.file));
    expect(files).toEqual(new Set([...ADMIN_FILES, ...GOV_FILES, "app/api/user/usage/route.ts"]));
    expect(touchesAuthority('import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";')).toBe(true);
    expect(touchesAuthority('import { requirePrivilegedAccess } from "@/lib/admin/privilegedAccess";')).toBe(true);
    expect(touchesAuthority("if (decoded.admin === true) {}")).toBe(true);
    expect(touchesAuthority('import { getPlanConfig } from "@/lib/plans";')).toBe(false);
  });

  it("REPO-WIDE: the authority matcher sees every forbidden form (positive control)", () => {
    for (const [src, m] of [
      ["if (await hasVerifiedApplicationAdminAuthority(uid)) {}", "hasVerifiedApplicationAdminAuthority"],
      ["await hasVerifiedGovernanceAdminAuthority(uid)", "hasVerifiedGovernanceAdminAuthority"],
      ["const s = await resolveVerifiedAdminScopes(uid)", "resolveVerifiedAdminScopes"],
      ["deriveVerifiedAdminScopes(snap)", "deriveVerifiedAdminScopes"],
      ["isApplicationAdminEmail(e)", "isApplicationAdminEmail"],
      ["isGovernanceAdminEmail(e)", "isGovernanceAdminEmail"],
      ["await requireSystemAdminAccess(req)", "requireSystemAdminAccess"],
      ["checkAdminOnly(uid)", "checkAdminOnly"],
      ["if (decoded.admin === true) {}", ".admin === true"],
      ["if (decoded.admin  ===  true) {}", ".admin === true"],
      ["const a = record.customClaims?.admin;", "customClaims.admin"],
      ["const a = record.customClaims.admin;", "customClaims.admin"],
      ['const a = record.customClaims?.["admin"];', "customClaims.admin"],
      ["if (token.admin) {}", "token.admin"],
      ["if (token?.admin) {}", "token.admin"],
    ] as const) {
      expect(matchesIn(src)).toContain(m);
    }
    expect(matchesIn("const admin = true; tokenClaimAdmin; adminUid")).toEqual([]);
  });

  it("the legacy-authority matcher can see what it forbids (positive control)", () => {
    for (const s of ["requireSystemAdminAccess(req)", "decoded.admin === true", "checkAdminOnly(uid)", "process.env.ADMIN_EMAILS"]) {
      expect(LEGACY_AUTHORITY.test(s)).toBe(true);
    }
    expect(PROTECTED_TOUCH.test("await adminDb.collection('x')")).toBe(true);
    expect(PROTECTED_TOUCH.test("const body = await request.json()")).toBe(true);
  });

  it("the mixed-audience governance handlers are NOT on the guard (a guard 403 would lock out reviewers)", () => {
    for (const h of ALL_HANDLERS.filter((x) => GOVERNANCE_MIXED_AUDIENCE.has(x.key))) {
      expect(h.body).not.toMatch(/requirePrivilegedAccess/);
    }
  });
});
