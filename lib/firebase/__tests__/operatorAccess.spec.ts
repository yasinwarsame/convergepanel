/**
 * Operator Production access (owner ruling on I-1/I-2 MAJOR-2): a narrow, explicitly granted path for four reviewed
 * operator scripts. Real modules; the Admin SDK is mocked so nothing connects anywhere.
 */
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { OPERATOR_GRANT_KEY, operatorShellRefusal, readOperatorGrant } from "../operatorGrant";

const ROOT = join(__dirname, "..", "..", "..");
const PROD_SA = JSON.stringify({ project_id: "convergepanel", client_email: "firebase-adminsdk-x@convergepanel.iam.gserviceaccount.com", private_key: "k" });
const KEYS = ["VERCEL", "VERCEL_ENV", "NEXT_RUNTIME", "NODE_ENV", "FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_PROJECT_ID"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => {
  KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
});


function freshProcess(env: Record<string, string | undefined>) {
  KEYS.forEach((k) => delete process.env[k]);
  process.env.NODE_ENV = "test";
  Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
}

/** Loads writer + admin.ts in an isolated module registry with a FRESH grant slot (a new global symbol registry is not possible, so the slot is deleted between cases via a configurable test-only shim). */
function runCase(opts: { env: Record<string, string | undefined>; argv: string[]; tamper?: (g: any) => void; loadAdminFirst?: boolean }) {
  freshProcess(opts.env);
  // The production writer defines the slot non-configurable. Tests need isolation between cases, so they run the writer
  // against a temporary globalThis proxy object that the reader also sees (both read `globalThis` lexically).
  const initializeApp = jest.fn((o: { projectId: string }) => ({ name: "[DEFAULT]", options: { projectId: o.projectId } }));
  let grantResult: unknown;
  let grantError: unknown;
  let admin: { adminDb: unknown } | undefined;
  const slotHolder: Record<symbol, unknown> = {};
  const realDefine = Object.defineProperty;
  const realGetDesc = Object.getOwnPropertyDescriptor;
  const defineSpy = jest.spyOn(Object, "defineProperty").mockImplementation(((o: any, k: any, d: any) => (o === globalThis && k === OPERATOR_GRANT_KEY ? realDefine(slotHolder, k, d) : realDefine(o, k, d))) as any);
  const descSpy = jest.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(((o: any, k: any) => (o === globalThis && k === OPERATOR_GRANT_KEY ? realGetDesc(slotHolder, k) : realGetDesc(o, k))) as any);
  const g = globalThis as any;
  const hadGetter = realGetDesc(globalThis, OPERATOR_GRANT_KEY);
  if (!hadGetter) realDefine(globalThis, OPERATOR_GRANT_KEY, { get: () => slotHolder[OPERATOR_GRANT_KEY], configurable: true });
  try {
    jest.isolateModules(() => {
      jest.doMock("firebase-admin", () => ({ __esModule: true, default: {} }));
      jest.doMock("firebase-admin/app", () => ({ initializeApp, getApps: () => [], cert: (x: unknown) => x }));
      jest.doMock("firebase-admin/auth", () => ({ getAuth: () => ({}) }));
      jest.doMock("firebase-admin/firestore", () => ({ getFirestore: () => ({ settings: () => undefined }) }));
      const quiet = [jest.spyOn(console, "log").mockImplementation(() => undefined), jest.spyOn(console, "error").mockImplementation(() => undefined)];
      const writer = require("../../../scripts/lib/operatorProductionAccess");
      try {
        grantResult = writer.grantOperatorProductionAccessFromArgv(opts.argv, opts.loadAdminFirst ? ["/x/lib/firebase/admin.ts"] : []);
      } catch (e) {
        grantError = e;
      }
      if (opts.tamper && slotHolder[OPERATOR_GRANT_KEY]) opts.tamper(slotHolder);
      admin = require("../admin");
      quiet.forEach((q) => q.mockRestore());
    });
  } finally {
    defineSpy.mockRestore();
    descSpy.mockRestore();
    if (!hadGetter) delete g[OPERATOR_GRANT_KEY];
  }
  return { initializeApp, grantResult, grantError, adminDb: admin!.adminDb };
}
const ARGV = (...a: string[]) => ["node", "/repo/scripts/projects/check-project-run-invariant.ts", ...a];

describe("operator grant → Admin init", () => {
  it("explicit --confirm-project in a local operator shell grants read-only access to exactly that project", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel") });
    expect(r.grantError).toBeUndefined();
    expect(r.grantResult).toMatchObject({ version: 1, projectId: "convergepanel", mode: "read-only", operation: "check-project-run-invariant.ts" });
    expect(Object.isFrozen(r.grantResult)).toBe(true);
    expect(r.initializeApp).toHaveBeenCalledTimes(1);
    expect(r.adminDb).toBeDefined();
  });
  it("--execute marks the grant write-capable (the script's own write safeguards still apply)", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--execute", "--confirm-project=convergepanel") });
    expect(r.grantResult).toMatchObject({ mode: "write" });
  });
  it("no --confirm-project → no grant → Production refused (no fallback)", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV() });
    expect(r.grantResult).toBeNull();
    expect(r.initializeApp).not.toHaveBeenCalled();
    expect(r.adminDb).toBeUndefined();
  });
  it("a grant naming a different project does not unlock Production", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel-preview") });
    expect(r.grantResult).toMatchObject({ projectId: "convergepanel-preview" });
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it.each([
    ["Vercel Preview", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["Vercel development", { VERCEL_ENV: "development" }],
    ["inside a Next.js server", { NEXT_RUNTIME: "nodejs" }],
    ["NODE_ENV=production", { NODE_ENV: "production" }],
  ])("%s: the writer refuses and Admin stays refused", (_l, env) => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA, ...env }, argv: ARGV("--confirm-project=convergepanel") });
    expect(String(r.grantError)).toMatch(/Refusing Production access/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("ambiguous or malformed targets are refused", () => {
    expect(String(runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel", "--confirm-project=other-proj") }).grantError)).toMatch(/more than once/);
    expect(String(runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=Convergepanel") }).grantError)).toMatch(/not a valid Firebase project id/);
  });
  it("refuses when lib/firebase/admin was already loaded before the grant", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel"), loadAdminFirst: true });
    expect(String(r.grantError)).toMatch(/loaded before the operator grant/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("Production credentials relabelled with the granted project id are still refused (credential must belong to it)", () => {
    const relabelled = JSON.stringify({ project_id: "convergepanel", client_email: "x@some-other-project.iam.gserviceaccount.com", private_key: "k" });
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: relabelled }, argv: ARGV("--confirm-project=convergepanel") });
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
});

describe("operator grant reader: forged or unsafe grants are ignored", () => {
  it("operatorShellRefusal names every unsafe context", () => {
    expect(operatorShellRefusal({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBeNull();
    expect(operatorShellRefusal({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv)).toMatch(/Vercel/);
    expect(operatorShellRefusal({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv)).toMatch(/VERCEL_ENV/);
    expect(operatorShellRefusal({ NEXT_RUNTIME: "edge" } as unknown as NodeJS.ProcessEnv)).toMatch(/Next\.js/);
    expect(operatorShellRefusal({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toMatch(/NODE_ENV/);
  });
  it("a mutable (forged) grant slot is not a grant", () => {
    freshProcess({});
    const g = globalThis as any;
    Object.defineProperty(globalThis, OPERATOR_GRANT_KEY, { value: Object.freeze({ version: 1, projectId: "convergepanel", operation: "x", mode: "write", grantedAt: "t" }), writable: true, configurable: true });
    try {
      expect(readOperatorGrant()).toBeNull();
    } finally {
      delete g[OPERATOR_GRANT_KEY];
    }
  });
  it("an unfrozen grant object is not a grant, even in an immutable slot (frozen check isolated)", () => {
    freshProcess({});
    const g = globalThis as any;
    const unfrozen = { version: 1, projectId: "convergepanel", operation: "x", mode: "write", grantedAt: "t" };
    Object.defineProperty(globalThis, OPERATOR_GRANT_KEY, { value: unfrozen, writable: false, configurable: true });
    const realDesc = Object.getOwnPropertyDescriptor;
    const spy = jest.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(((o: any, k: any) => (o === globalThis && k === OPERATOR_GRANT_KEY ? { value: unfrozen, writable: false, configurable: false, enumerable: false } : realDesc(o, k))) as any);
    try {
      expect(readOperatorGrant()).toBeNull();
      Object.freeze(unfrozen);
      expect(readOperatorGrant()).toBe(unfrozen); // positive control: the same grant once frozen
    } finally {
      spy.mockRestore();
      delete g[OPERATOR_GRANT_KEY];
    }
  });
  it.each([{ VERCEL_ENV: "preview" }, { VERCEL: "1" }, { NEXT_RUNTIME: "nodejs" }, { NODE_ENV: "production" }])("a valid immutable grant is honoured in a safe shell but ignored by the reader in unsafe context %p", (env) => {
    const g = globalThis as any;
    const grant = Object.freeze({ version: 1, projectId: "convergepanel", operation: "x", mode: "read-only", grantedAt: "t" });
    Object.defineProperty(globalThis, OPERATOR_GRANT_KEY, { value: grant, writable: false, configurable: true });
    const realDesc = Object.getOwnPropertyDescriptor;
    // Present the slot exactly as the writer creates it (non-writable, non-configurable) so only the env check differs.
    const spy = jest.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation(((o: any, k: any) => (o === globalThis && k === OPERATOR_GRANT_KEY ? { value: grant, writable: false, configurable: false, enumerable: false } : realDesc(o, k))) as any);
    try {
      freshProcess({});
      expect(readOperatorGrant()).toBe(grant); // positive control
      freshProcess(env);
      expect(readOperatorGrant()).toBeNull();
    } finally {
      spy.mockRestore();
      delete g[OPERATOR_GRANT_KEY];
    }
  });
  it("no grant at all → null", () => {
    freshProcess({});
    expect(readOperatorGrant()).toBeNull();
  });
});

describe("static: the operator path stays confined to operator tooling", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", ".git"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = ["app", "components", "hooks", "lib", "scripts"].flatMap((d) => walk(join(ROOT, d))).filter((f) => !f.includes(`${join("__tests__")}`));
  const rel = (f: string) => relative(ROOT, f);
  it("only the four reviewed operator scripts import the grant writer, each as their FIRST import", () => {
    const importers = files.filter((f) => /^\s*(import\b[^;]*|.*\brequire\()\s*["'][^"']*operatorProductionAccess["']/m.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(importers).toEqual([
      "scripts/projects/check-project-run-invariant.ts",
      "scripts/projects/dry-run-project-normalization.ts",
      "scripts/projects/execute-project-normalization.ts",
      "scripts/workspaces/provision-existing-personal-workspaces.ts",
    ]);
    for (const f of importers) {
      const firstImport = readFileSync(join(ROOT, f), "utf8").split("\n").find((l) => /^import /.test(l));
      expect([f, firstImport]).toEqual([f, 'import "../lib/operatorProductionAccess";']);
    }
  });
  it("only lib/firebase/admin.ts reads the grant, and nothing outside the grant modules touches the grant key", () => {
    const readers = files.filter((f) => /from "\.\/operatorGrant"|from "@\/lib\/firebase\/operatorGrant"|lib\/firebase\/operatorGrant"/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(readers).toEqual(["lib/firebase/admin.ts", "scripts/lib/operatorProductionAccess.ts"]);
    const keyUsers = files.filter((f) => /operatorProductionGrant\.v1|OPERATOR_GRANT_KEY/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(keyUsers).toEqual(["lib/firebase/operatorGrant.ts", "scripts/lib/operatorProductionAccess.ts"]);
  });
  it("no environment switch exists for operator access (the grant is never read from process.env)", () => {
    for (const f of ["lib/firebase/operatorGrant.ts", "scripts/lib/operatorProductionAccess.ts", "lib/firebase/admin.ts", "lib/firebase/projectIsolation.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect([f, /process\.env\.[A-Z_]*(OPERATOR|OVERRIDE|BYPASS|ALLOW_PRODUCTION)/.test(src)]).toEqual([f, false]);
    }
  });
});
