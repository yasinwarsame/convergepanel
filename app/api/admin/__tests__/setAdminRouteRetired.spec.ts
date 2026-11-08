/**
 * Security slice S1 — the secret bootstrap route stays retired.
 *
 * `POST /api/admin/set-admin` minted `admin: true` on any uid from possession of
 * `ADMIN_SECRET`, authenticated no identity, and left no audit record and no
 * success log. S1 deleted the route, its probe and the variable. This file keeps
 * all of that deleted:
 *
 *   1. ROUTE RESOLUTION. No app-router route file resolves `/api/admin/set-admin`,
 *      using Next's own path normalisation and route matcher (route groups,
 *      dynamic and catch-all segments included), and no rewrite or middleware
 *      maps the path anywhere. A POST to it therefore gets Next's 404.
 *   2. NO SECRET READ. No non-test source file contains `ADMIN_SECRET` or
 *      `BOOTSTRAP_SECRET` at all — in code, config or example env files.
 *
 * Both scans walk the filesystem, not `git ls-files`, so they also run in a
 * `git archive` export (the mutation-testing environment).
 *
 * LIMIT, stated plainly: this is static resolution against the source tree, not
 * a request to a running server. It proves no route exists for the path; the
 * live Production 404 is a separate post-deploy check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { normalizeAppPath } from "next/dist/shared/lib/router/utils/app-paths";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";

const ROOT = process.cwd();
const RETIRED_PATH = "/api/admin/set-admin";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "coverage", "out", "dist", ".vercel", ".turbo", ".claude"]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

// ─── 1. route resolution ────────────────────────────────────────────────────

/** Every app-router route handler, as Next's app path (e.g. `/api/admin/runs/[runId]`). */
const ROUTE_HANDLERS = walk(join(ROOT, "app"))
  .map(rel)
  .filter((f) => /(^|\/)route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
  .filter((f) => !f.includes("__tests__"))
  .map((f) => ({
    file: f,
    path: normalizeAppPath("/" + f.replace(/^app\//, "").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")),
  }));

/** Every page, too: a page at the path would also answer instead of a 404. */
const PAGES = walk(join(ROOT, "app"))
  .map(rel)
  .filter((f) => /(^|\/)page\.(ts|tsx|js|jsx|mdx)$/.test(f))
  .map((f) => ({
    file: f,
    path: normalizeAppPath("/" + f.replace(/^app\//, "").replace(/\.(ts|tsx|js|jsx|mdx)$/, "")),
  }));

const resolves = (appPath: string, url: string) =>
  getRouteMatcher(getRouteRegex(appPath))(url) !== false;

const matching = (url: string) =>
  [...ROUTE_HANDLERS, ...PAGES].filter((r) => resolves(r.path, url)).map((r) => r.file);

describe("S1 — POST /api/admin/set-admin has no route (404)", () => {
  it("ANCHOR: the walker found the real route tree", () => {
    expect(ROUTE_HANDLERS.length).toBeGreaterThan(100);
    expect(ROUTE_HANDLERS.map((r) => r.file)).toContain("app/api/admin/set-role/route.ts");
  });

  it("ANCHOR: Next's matcher resolves real paths, including dynamic segments", () => {
    // Positive controls — without these, a matcher that never matches would
    // make the 404 assertion below vacuous.
    expect(matching("/api/admin/set-role")).toEqual(["app/api/admin/set-role/route.ts"]);
    expect(matching("/api/admin/runs/abc123")).toEqual(["app/api/admin/runs/[runId]/route.ts"]);
    expect(normalizeAppPath("/(group)/api/x/route")).toBe("/api/x");
    expect(resolves("/api/admin/[slug]", RETIRED_PATH)).toBe(true);
    expect(resolves("/api/[...rest]", RETIRED_PATH)).toBe(true);
    expect(resolves("/api/admin/[[...opt]]", RETIRED_PATH)).toBe(true);
  });

  it("the route directory and file are gone", () => {
    expect(existsSync(join(ROOT, "app/api/admin/set-admin"))).toBe(false);
    expect(existsSync(join(ROOT, "pages/api/admin/set-admin.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "pages"))).toBe(false);
    expect(existsSync(join(ROOT, "src/app"))).toBe(false);
  });

  it("no route handler or page resolves the retired path", () => {
    expect(matching(RETIRED_PATH)).toEqual([]);
    expect(matching(RETIRED_PATH + "/")).toEqual([]);
  });

  it("no rewrite, redirect or middleware maps the retired path", () => {
    for (const f of ["next.config.js", "middleware.ts", "vercel.json"]) {
      const p = join(ROOT, f);
      if (!existsSync(p)) continue;
      expect({ f, mentions: readFileSync(p, "utf8").includes("set-admin") }).toEqual({ f, mentions: false });
    }
  });

  it("the retired probe and its attestation module are gone", () => {
    for (const f of [
      "scripts/probe-admin-secret.mjs",
      "scripts/lib/probe-admin-secret.mjs",
      "lib/security/adminSecretProbeAttestation.ts",
    ]) {
      expect({ f, exists: existsSync(join(ROOT, f)) }).toEqual({ f, exists: false });
    }
  });
});

// ─── 2. no source reads the retired secret ─────────────────────────────────

const SECRET_TOKENS = /\b(?:[A-Z0-9_]*_)?(ADMIN_SECRET|BOOTSTRAP_SECRET)\b/;
const BINARY = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|pdf|zip|gz|mp4|mov|webm|mp3|wav)$/i;

/**
 * Every non-test, non-Markdown file in the repository. Markdown is excluded only
 * because the docs must NAME the retired variable to say it is retired; the
 * docs-parity specs (`docs/__tests__/bootstrapProbeInvariant.spec.ts`) police
 * what they may say about it.
 */
const SOURCE_FILES = walk(ROOT)
  .map(rel)
  .filter((f) => !/(^|\/)(__tests__|__fixtures__|__mocks__)\//.test(f))
  .filter((f) => !/\.(spec|test)\.[cm]?[jt]sx?$/.test(f))
  .filter((f) => !/\.mdx?$/i.test(f))
  .filter((f) => !BINARY.test(f))
  .filter((f) => f !== "package-lock.json" && !f.endsWith(".lock"))
  // A developer's real, untracked env file is not source; only the committed
  // example is. It is never printed — only its name could appear in a failure.
  .filter((f) => !/(^|\/)\.env(\.[^/]*)?$/.test(f) || f.endsWith(".example"));

const readers = (files: string[]) =>
  files.filter((f) => {
    try { return SECRET_TOKENS.test(readFileSync(join(ROOT, f), "utf8")); } catch { return false; }
  });

describe("S1 — no non-test source reads ADMIN_SECRET or BOOTSTRAP_SECRET", () => {
  it("ANCHOR: the scan covers code, config and example env files", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(300);
    for (const f of ["lib/env.ts", "next.config.js", ".env.local.example", "package.json", "middleware.ts"]) {
      expect(SOURCE_FILES).toContain(f);
    }
  });

  it("SELF-VALIDATION: the token pattern fires on every read form it must catch", () => {
    for (const bad of [
      "process.env.ADMIN_SECRET",
      'process.env["ADMIN_SECRET"]',
      "const { ADMIN_SECRET } = process.env;",
      "ADMIN_SECRET=your-long-random-secret-string-here",
      "env.BOOTSTRAP_SECRET",
      "process.env.OLD_ADMIN_SECRET",
    ]) {
      expect({ bad, caught: SECRET_TOKENS.test(bad) }).toEqual({ bad, caught: true });
    }
    for (const ok of ["ADMIN_EMAILS", "GOVERNANCE_ADMIN_EMAILS", "STRIPE_WEBHOOK_SECRET", "CRON_SECRET"]) {
      expect({ ok, caught: SECRET_TOKENS.test(ok) }).toEqual({ ok, caught: false });
    }
  });

  it("no non-test source file mentions either variable", () => {
    expect(readers(SOURCE_FILES)).toEqual([]);
  });
});
