/**
 * Operator Production access (owner ruling on I-1/I-2 MAJOR-2): a narrow, explicitly granted path for four reviewed
 * operator scripts. Real modules; the Admin SDK is mocked so nothing connects anywhere.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
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
function runCase(opts: { env: Record<string, string | undefined>; argv: string[]; tamper?: (g: any) => void; loadAdminFirst?: boolean; envLocalPath?: string }) {
  freshProcess(opts.env);
  // The production writer defines the slot non-configurable. Tests need isolation between cases, so they run the writer
  // against a temporary globalThis proxy object that the reader also sees (both read `globalThis` lexically).
  const initializeApp = jest.fn((o: { projectId: string }) => ({ name: "[DEFAULT]", options: { projectId: o.projectId } }));
  let grantResult: unknown;
  let grantError: unknown;
  let exitCode: number | undefined;
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
      try {
        const writer = require("../../../scripts/lib/operatorProductionAccess");
        try {
          grantResult = writer.grantOperatorProductionAccessFromArgv(opts.argv, {
            loadedModules: opts.loadAdminFirst ? ["/x/lib/firebase/admin.ts"] : [],
            envLocalPath: opts.envLocalPath ?? join(TMP, "no-such-env-local"),
            exit: (code: number) => {
              exitCode = code;
            },
          });
        } catch (e) {
          grantError = e;
        }
        if (opts.tamper) opts.tamper(slotHolder);
        admin = require("../admin");
      } finally {
        quiet.forEach((q) => q.mockRestore());
      }
    });
  } finally {
    defineSpy.mockRestore();
    descSpy.mockRestore();
    if (!hadGetter) delete g[OPERATOR_GRANT_KEY];
  }
  return { initializeApp, grantResult, grantError, exitCode, adminDb: admin!.adminDb, credentialEnv: { json: process.env.FIREBASE_SERVICE_ACCOUNT_JSON, b64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, projectId: process.env.FIREBASE_PROJECT_ID } };
}
const TMP = mkdtempSync(join(tmpdir(), "cp-operator-spec-"));
const credFile = (name: string, body: string) => {
  const f = join(TMP, name);
  writeFileSync(f, body);
  return f;
};
const PROD_CRED = credFile("prod-sa.json", PROD_SA);
const CRED = `--operator-credentials=${PROD_CRED}`;
const DEV_SA_B64 = Buffer.from(JSON.stringify({ project_id: "convergepanel-preview", client_email: "x@convergepanel-preview.iam.gserviceaccount.com", private_key: "k" })).toString("base64");
const ARGV = (...a: string[]) => ["node", "/repo/scripts/projects/check-project-run-invariant.ts", ...a];
const ARGV_FOR = (script: string, ...a: string[]) => ["node", `/repo/scripts/x/${script}`, ...a];

describe("operator grant → Admin init", () => {
  it("explicit --confirm-project in a local operator shell grants read-only access to exactly that project", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel", CRED) });
    expect(r.grantError).toBeUndefined();
    expect(r.grantResult).toMatchObject({ version: 1, projectId: "convergepanel", mode: "read-only", operation: "check-project-run-invariant.ts" });
    expect(Object.isFrozen(r.grantResult)).toBe(true);
    expect(r.initializeApp).toHaveBeenCalledTimes(1);
    expect(r.adminDb).toBeDefined();
  });
  it.each(["execute-project-normalization.ts", "provision-existing-personal-workspaces.ts"])("write-capable %s: write only with --execute, read-only without", (script) => {
    expect(runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV_FOR(script, "--execute", "--confirm-project=convergepanel", CRED) }).grantResult).toMatchObject({ mode: "write", operation: script });
    expect(runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV_FOR(script, "--confirm-project=convergepanel", CRED) }).grantResult).toMatchObject({ mode: "read-only", operation: script });
  });
  it.each(["check-project-run-invariant.ts", "dry-run-project-normalization.ts"])("read-only %s refuses --execute (mode bound to the operation)", (script) => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV_FOR(script, "--execute", "--confirm-project=convergepanel", CRED) });
    expect(String(r.grantError)).toMatch(/is read-only and does not accept --execute/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("an operation that is not one of the four reviewed scripts gets no grant", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV_FOR("setAdmin.ts", "--confirm-project=convergepanel", CRED) });
    expect(String(r.grantError)).toMatch(/not a reviewed operator operation/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("the admin lift itself refuses a non-Production project even with a forged grant naming it (numeric Production SA)", () => {
    // The writer never creates grants for non-Production targets, so plant one directly to test the reader+lift.
    const odd = JSON.stringify({ project_id: "foo-project", client_email: "907484474744-compute@developer.gserviceaccount.com", private_key: "k" });
    const plant = (project: string) => (h: Record<symbol, unknown>) =>
      Object.defineProperty(h, OPERATOR_GRANT_KEY, { value: Object.freeze({ version: 1, projectId: project, operation: "x.ts", mode: "read-only", grantedAt: "t" }), writable: false, configurable: false });
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: odd }, argv: ARGV(), tamper: plant("foo-project") });
    expect(r.initializeApp).not.toHaveBeenCalled();
    // Positive control: the same planted mechanism for exactly "convergepanel" with a Production SA IS lifted.
    const ok = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV(), tamper: plant("convergepanel") });
    expect(ok.initializeApp).toHaveBeenCalledTimes(1);
  });
  it("no --confirm-project → no grant → Production refused (no fallback)", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV() });
    expect(r.grantResult).toBeNull();
    expect(r.initializeApp).not.toHaveBeenCalled();
    expect(r.adminDb).toBeUndefined();
  });
  it("a NON-Production target needs no grant: none is created, no error even in a pulled-env shell, and Production stays refused", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA, VERCEL: "1", VERCEL_ENV: "development" }, argv: ARGV("--confirm-project=convergepanel-preview") });
    expect(r.grantError).toBeUndefined();
    expect(r.grantResult).toBeNull();
    expect(r.initializeApp).not.toHaveBeenCalled(); // Production credentials in env are still refused
  });
  it("a NON-Production target with Preview credentials initializes Preview without any grant", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_BASE64: DEV_SA_B64, VERCEL: "1", VERCEL_ENV: "development" }, argv: ARGV("--confirm-project=convergepanel-preview") });
    expect(r.grantResult).toBeNull();
    expect(r.initializeApp).toHaveBeenCalledTimes(1);
  });
  it("Production target without --operator-credentials is refused with a clear message (env credentials are never used)", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel") });
    expect(String(r.grantError)).toMatch(/requires --operator-credentials/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("the operator-selected credential REPLACES any environment credential (base64 would otherwise win)", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_BASE64: DEV_SA_B64, FIREBASE_CLIENT_EMAIL: "x@y", FIREBASE_PRIVATE_KEY: "k" }, argv: ARGV("--confirm-project=convergepanel", CRED) });
    expect(r.grantResult).toMatchObject({ projectId: "convergepanel" });
    expect(r.credentialEnv).toEqual({ json: PROD_SA, b64: undefined, projectId: "convergepanel" });
    expect(r.initializeApp).toHaveBeenCalledTimes(1);
    expect(r.initializeApp.mock.calls[0][0]).toMatchObject({ projectId: "convergepanel" });
  });
  it.each([
    ["non-Production project_id", JSON.stringify({ project_id: "convergepanel-preview", client_email: "x@convergepanel.iam.gserviceaccount.com", private_key: "k" }), /project_id is not the Production project/],
    ["non-Production client_email", JSON.stringify({ project_id: "convergepanel", client_email: "x@other.iam.gserviceaccount.com", private_key: "k" }), /not a Production service account/],
    ["unrecognised client_email", JSON.stringify({ project_id: "convergepanel", client_email: "someone@example.com", private_key: "k" }), /not a Production service account/],
    ["no private key", JSON.stringify({ project_id: "convergepanel", client_email: "x@convergepanel.iam.gserviceaccount.com" }), /no private_key/],
    ["not JSON", "not json", /not a JSON service-account key/],
  ])("an invalid credential file (%s) is refused", (_l, body, msg) => {
    const f = credFile(`bad-${Math.random().toString(36).slice(2)}.json`, body);
    const r = runCase({ env: {}, argv: ARGV("--confirm-project=convergepanel", `--operator-credentials=${f}`) });
    expect(String(r.grantError)).toMatch(msg);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("a checkout whose .env.local came from `vercel env pull` gets a specific, accurate refusal", () => {
    const envLocal = credFile("env-local-pulled", 'VERCEL="1"\nVERCEL_ENV="development"\nNEXT_PUBLIC_FIREBASE_PROJECT_ID="x"\n');
    const r = runCase({ env: { VERCEL: "1", VERCEL_ENV: "development" }, argv: ARGV("--confirm-project=convergepanel", CRED), envLocalPath: envLocal });
    expect(String(r.grantError)).toMatch(/written by `vercel env pull`.*separate operator checkout/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("--operator-preflight validates everything, exits 0, and grants nothing", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel", CRED, "--operator-preflight") });
    expect(r.exitCode).toBe(0);
    expect(r.grantResult).toBeNull();
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("--operator-preflight with a failing check refuses (no exit 0)", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel", "--operator-preflight") });
    expect(String(r.grantError)).toMatch(/requires --operator-credentials/);
    expect(r.exitCode).toBeUndefined();
  });
  it.each([
    ["Vercel Preview", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["Vercel development", { VERCEL_ENV: "development" }],
    ["inside a Next.js server", { NEXT_RUNTIME: "nodejs" }],
    ["NODE_ENV=production", { NODE_ENV: "production" }],
  ])("%s: the writer refuses and Admin stays refused", (_l, env) => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA, ...env }, argv: ARGV("--confirm-project=convergepanel", CRED) });
    expect(String(r.grantError)).toMatch(/Refusing Production access/);
    expect(r.initializeApp).not.toHaveBeenCalled();
  });
  it("ambiguous or malformed targets and credentials are refused", () => {
    expect(String(runCase({ env: {}, argv: ARGV("--confirm-project=convergepanel", "--confirm-project=other-proj", CRED) }).grantError)).toMatch(/more than once/);
    expect(String(runCase({ env: {}, argv: ARGV("--confirm-project=Convergepanel", CRED) }).grantError)).toMatch(/not a valid Firebase project id/);
    expect(String(runCase({ env: {}, argv: ARGV("--confirm-project=convergepanel", CRED, CRED) }).grantError)).toMatch(/more than once/);
  });
  it("refuses when lib/firebase/admin was already loaded before the grant", () => {
    const r = runCase({ env: { FIREBASE_SERVICE_ACCOUNT_JSON: PROD_SA }, argv: ARGV("--confirm-project=convergepanel", CRED), loadAdminFirst: true });
    expect(String(r.grantError)).toMatch(/loaded before the operator grant/);
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
