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
 *     reappears in any of these files (two divergent authorities).
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
