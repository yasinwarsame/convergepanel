/**
 * API-1a trust boundaries:
 * - lib/apiPlatform imports nothing from admin, Firebase auth, identity, billing, workspace or team code
 *   (an API key can never inherit administrator authority or read workspace data — Addendum 1 D1);
 * - nothing outside lib/apiPlatform imports it, and no route exists (DARK);
 * - rollout switches are false;
 * - client Firestore rules deny every api* collection (catch-all deny; firestore.rules is Order 6-pinned
 *   and NOT edited);
 * - the S2-b guard's credential pre-validation rejects an API key as a Firebase credential;
 * - error envelope shape and fixed messages; fake Firestore fidelity.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { prevalidateCredential } from "@/lib/admin/privilegedCredentialAdapter";
import { API_PLATFORM_DATA_PLANE_ENABLED, API_PLATFORM_MANAGEMENT_ENABLED } from "@/lib/apiPlatform/rollout";
import { API_ERRORS, apiErrorBody, apiErrorResponse } from "@/lib/apiPlatform/errors";
import { clientRequestId, newRequestId } from "@/lib/apiPlatform/requestId";
import { FakeFirestore } from "@/lib/apiPlatform/__tests__/helpers/fakeFirestore";

const ROOT = path.resolve(__dirname, "../../..");
const DIR = "lib/apiPlatform";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(rel: string, out: string[] = [], skipTests = true): string[] {
  for (const name of readdirSync(path.join(ROOT, rel))) {
    if (["node_modules", ".git", ".next", "coverage"].includes(name)) continue;
    const r = `${rel}/${name}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) {
      if (skipTests && name === "__tests__") continue;
      walk(r, out, skipTests);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(r);
  }
  return out;
}

const SPECIFIER_RES = [
  /\b(?:import|export)\b[^;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g,
  /\bimport\s*["'`]([^"'`]+)["'`]/g,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];
function specifiers(file: string, src: string): string[] {
  const out: string[] = [];
  for (const re of SPECIFIER_RES) for (const m of src.matchAll(re)) {
    const s = m[1];
    if (s.startsWith("@/")) out.push(s.slice(2));
    else if (s.startsWith(".")) out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), s)));
    else out.push(`pkg:${s}`);
  }
  return out;
}

const PROD = walk(DIR);

describe("lib/apiPlatform imports only its own modules and Node built-ins", () => {
  it("positive control: the walk sees the core modules", () => {
    for (const f of ["principal.ts", "keys.ts", "store.ts", "management.ts", "secrets.server.ts"]) expect(PROD).toContain(`${DIR}/${f}`);
  });

  it("every specifier is node:crypto, server-only or lib/apiPlatform/*", () => {
    const bad: string[] = [];
    for (const f of PROD) for (const s of specifiers(f, read(f))) {
      if (s === "pkg:node:crypto" || s === "pkg:server-only" || s.startsWith(`${DIR}/`)) continue;
      bad.push(`${f} → ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it("no source text references administrator, Firebase-auth, billing or workspace authority", () => {
    const FORBIDDEN = /customClaims|requirePrivilegedAccess|ADMIN_EMAILS|GOVERNANCE_ADMIN|BOOTSTRAP_SECRET|verifyIdToken|verifySessionCookie|resolveRequestIdentity\(|lib\/admin|lib\/firebase|lib\/stripe|lib\/workspaces|lib\/teams|scripts\/admin|workspaceMemberships|users\//;
    const hits = PROD.filter((f) => FORBIDDEN.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(hits).toEqual([]);
  });
});

describe("DARK: nothing outside lib/apiPlatform imports it; no API route exists", () => {
  it("no importer outside the directory (app, components, lib, scripts, middleware)", () => {
    const files = [
      ...walk("app", [], true), ...walk("components", [], true), ...walk("lib", [], true), ...walk("scripts", [], true), ...walk("hooks", [], true),
      "middleware.ts",
    ].filter((f) => !f.startsWith(`${DIR}/`));
    expect(files.length).toBeGreaterThan(300);
    const importers = files.filter((f) => specifiers(f, read(f)).some((s) => s === DIR || s.startsWith(`${DIR}/`)));
    expect(importers).toEqual([]);
  });

  it("no /v1 or /developer route directories exist", () => {
    const routes = walk("app", [], false).filter((f) => /^app\/api\/(v1|developer)\//.test(f) || /^app\/(v1|developer)\//.test(f));
    expect(routes).toEqual([]);
  });

  it("rollout switches are false", () => {
    expect(API_PLATFORM_DATA_PLANE_ENABLED).toBe(false);
    expect(API_PLATFORM_MANAGEMENT_ENABLED).toBe(false);
  });
});

describe("Firestore rules deny every api* collection to clients (rules file not edited)", () => {
  const rules = read("firestore.rules");
  it("no rule matches an api* collection", () => {
    expect(rules).not.toMatch(/match\s+\/api[A-Za-z]*\//);
  });
  it("the catch-all deny is present and is the last match block", () => {
    const idx = rules.lastIndexOf("match /{document=**}");
    expect(idx).toBeGreaterThan(0);
    expect(rules.slice(idx)).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+false/);
    expect(rules.slice(idx + 1)).not.toMatch(/match\s+\//);
  });
});

describe("tenantPaths validation", () => {
  it("rejects malformed ids (no path injection)", () => {
    const tp = jest.requireActual("@/lib/apiPlatform/tenantPaths") as typeof import("@/lib/apiPlatform/tenantPaths");
    expect(() => tp.membershipPath("am_" + "0".repeat(63))).toThrow();
    expect(() => tp.membershipPath("am_" + "0".repeat(64) + "/x")).toThrow();
    expect(() => tp.membershipPath("am_" + "G".repeat(64))).toThrow();
    expect(() => tp.orgPath("org_AAAAAAAAAAAAAAAAAAAA/apiKeys/x")).toThrow();
    expect(() => tp.keyPath("../AAAAAAAAAA")).toThrow();
    expect(tp.membershipPath("am_" + "0".repeat(64))).toBe(`apiOrgMemberships/am_${"0".repeat(64)}`);
  });
});

describe("compile-time API plans", () => {
  it("are empty until owner-approved, so no Firestore value can enable live keys", () => {
    const plans = jest.requireActual("@/lib/apiPlatform/apiPlans") as typeof import("@/lib/apiPlatform/apiPlans");
    expect(plans.API_PLANS).toEqual([]);
    for (const id of ["beta_capped_v1", "x", "", null, "toString"]) expect(plans.isApprovedApiPlanId(id)).toBe(false);
  });
});

describe("an API key is never a Firebase credential", () => {
  it("S2-b pre-validation rejects cpk_ keys as bearer and cookie", () => {
    const key = `cpk_live_AAAAAAAAAAAA_${"a".repeat(43)}`;
    for (const kind of ["bearer", "cookie"] as const) {
      expect(prevalidateCredential(key, kind, "convergepanel", 1_800_000_000).ok).toBe(false);
    }
  });
});

describe("error envelope and request IDs", () => {
  it("every code has the PRD §9.5 shape, fixed message and doc_url", () => {
    for (const code of Object.keys(API_ERRORS) as (keyof typeof API_ERRORS)[]) {
      const b = apiErrorBody(code, "req_x");
      expect(b).toEqual({ error: { type: API_ERRORS[code].type, code, message: API_ERRORS[code].message, param: null, request_id: "req_x", doc_url: `https://docs.convergepanel.com/errors#${code}` } });
    }
  });
  it("one 401 code covers every key failure; statuses map as PRD §9.5", () => {
    expect(API_ERRORS.invalid_api_key.status).toBe(401);
    expect(API_ERRORS.org_suspended.status).toBe(403);
    expect(API_ERRORS.live_key_requires_plan.status).toBe(403);
    expect(API_ERRORS.insufficient_scope.status).toBe(403);
    expect(API_ERRORS.api_unavailable.status).toBe(503);
  });
  it("response carries status, JSON, no-store and X-Request-Id", async () => {
    const r = apiErrorResponse("insufficient_scope", "req_abc", "scope");
    expect(r.status).toBe(403);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-request-id")).toBe("req_abc");
    expect(await r.json()).toMatchObject({ error: { code: "insufficient_scope", param: "scope" } });
  });
  it("request IDs are server-generated; client IDs echoed only when safe", () => {
    expect(newRequestId()).toMatch(/^req_[0-9A-Za-z]{24}$/);
    expect(newRequestId()).not.toBe(newRequestId());
    expect(clientRequestId(new Headers({ "x-request-id": "abc-123:x" }))).toBe("abc-123:x");
    expect(clientRequestId(new Headers({ "x-request-id": "<script>" }))).toBeNull();
    expect(clientRequestId(new Headers({ "x-request-id": "a".repeat(129) }))).toBeNull();
    expect(clientRequestId(new Headers())).toBeNull();
  });
});

describe("fake Firestore fidelity (the store's tests rely on these rules)", () => {
  it("reads after writes throw; create conflicts throw; a throwing tx commits nothing", async () => {
    const db = new FakeFirestore();
    await expect(db.runTransaction(async (tx) => { tx.create(db.doc("a/1"), {}); await tx.get(db.doc("a/2")); })).rejects.toThrow("reads to be executed before");
    expect(db.docs.size).toBe(0);
    await db.runTransaction(async (tx) => { tx.create(db.doc("a/1"), { v: 1 }); });
    await expect(db.runTransaction(async (tx) => { tx.create(db.doc("a/1"), {}); })).rejects.toThrow("ALREADY_EXISTS");
    await expect(db.runTransaction(async (tx) => { tx.create(db.doc("a/9"), {}); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(db.get("a/9")).toBeUndefined();
    await expect(db.runTransaction(async (tx) => { tx.update(db.doc("a/404"), {}); })).rejects.toThrow("NOT_FOUND");
  });
});
