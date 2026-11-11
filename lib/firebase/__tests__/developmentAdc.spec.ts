/**
 * Order 35 G (Development isolation D-2): keyless developer Admin credential on a non-Production project only.
 * The pure resolver, and the REAL lib/firebase/admin.ts on the development ADC path.
 */
import { resolveDevelopmentAdc } from "../developmentAdc";

describe("resolveDevelopmentAdc", () => {
  it("does not apply without the explicit opt-in (every existing path unchanged)", () => {
    expect(resolveDevelopmentAdc({})).toEqual({ kind: "not_applicable" });
    expect(resolveDevelopmentAdc({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "", FIREBASE_PROJECT_ID: "convergepanel-dev" })).toEqual({ kind: "not_applicable" });
    expect(resolveDevelopmentAdc({ VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "convergepanel" })).toEqual({ kind: "not_applicable" });
  });

  it("local run or vercel dev on a non-Production project → ok", () => {
    expect(resolveDevelopmentAdc({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview" })).toEqual({ kind: "ok", projectId: "convergepanel-preview" });
    expect(resolveDevelopmentAdc({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", VERCEL_ENV: "development", FIREBASE_PROJECT_ID: " ConvergePanel-Dev " })).toEqual({ kind: "ok", projectId: "convergepanel-dev" });
  });

  it.each([
    ["unknown source", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "ADC", FIREBASE_PROJECT_ID: "convergepanel-dev" }, "unknown_credential_source"],
    ["on a Preview deployment", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: "convergepanel-preview" }, "adc_outside_development"],
    ["on a Production deployment", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "convergepanel-dev" }, "adc_outside_development"],
    ["no explicit project (the Production default is never used)", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc" }, "missing_project_id"],
    ["the Production project id", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel" }, "production_project"],
    ["the Production project id, padded / cased", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: " ConvergePanel " }, "production_project"],
    ["the Production project number", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "907484474744" }, "production_project"],
    ["a key file through GOOGLE_APPLICATION_CREDENTIALS", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-dev", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" }, "key_file_credentials"],
  ])("refuses %s", (_n, env, reason) => {
    expect(resolveDevelopmentAdc(env as Record<string, string>)).toEqual({ kind: "refused", reason });
  });
});

const ENV_KEYS = ["VERCEL_ENV", "FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_WIF_AUDIENCE", "FIREBASE_WIF_SERVICE_ACCOUNT", "FIREBASE_ADMIN_CREDENTIAL_SOURCE", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => ENV_KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

function loadAdmin(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, existingApps: unknown[] = []) {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => (process.env[k] = v as string));
  const initializeApp = jest.fn((opts: { projectId: string; credential: unknown }) => ({ name: "[DEFAULT]", options: { projectId: opts.projectId } }));
  const applicationDefault = jest.fn(() => ({ kind: "adc" }));
  const cert = jest.fn((x: unknown) => ({ cert: x }));
  const getFirestore = jest.fn(() => ({ kind: "db", settings: () => undefined }));
  const errors: string[] = [];
  let mod: any;
  jest.isolateModules(() => {
    jest.doMock("firebase-admin", () => ({ __esModule: true, default: {} }));
    jest.doMock("firebase-admin/app", () => ({ initializeApp, applicationDefault, getApps: () => existingApps, cert }));
    jest.doMock("firebase-admin/auth", () => ({ getAuth: () => ({ kind: "auth" }) }));
    jest.doMock("firebase-admin/firestore", () => ({ getFirestore, Firestore: jest.fn() }));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const err = jest.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    try {
      mod = require("../admin");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
  return { initializeApp, applicationDefault, cert, mod, errors };
}

const PROD_KEY_JSON = JSON.stringify({ project_id: "convergepanel", client_email: "firebase-adminsdk-fbsvc@convergepanel.iam.gserviceaccount.com", private_key: "k" });

describe("admin.ts — development application-default path", () => {
  it("opt-in on a non-Production project → Admin with the application-default credential, no certificate read", () => {
    const { initializeApp, applicationDefault, cert, mod } = loadAdmin({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", FIREBASE_SERVICE_ACCOUNT_JSON: PROD_KEY_JSON });
    expect(applicationDefault).toHaveBeenCalledTimes(1);
    expect(cert).not.toHaveBeenCalled();
    expect(initializeApp).toHaveBeenCalledWith({ credential: { kind: "adc" }, projectId: "convergepanel-preview" });
    expect(mod.adminDb).toBeDefined();
    expect(mod.getInitializedFirebaseProjectId()).toBe("convergepanel-preview");
  });

  it.each([
    ["the Production project", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel" }, "development_adc_production_project"],
    ["no explicit project", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc" }, "development_adc_missing_project_id"],
    ["a Production deployment", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", VERCEL_ENV: "production", FIREBASE_PROJECT_ID: "convergepanel-dev" }, "development_adc_adc_outside_development"],
    ["a key file", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-dev", GOOGLE_APPLICATION_CREDENTIALS: "/k.json" }, "development_adc_key_file_credentials"],
  ])("refused on %s: Admin stays uninitialized and no certificate fallback is attempted", (_n, env, reason) => {
    const { initializeApp, cert, mod, errors } = loadAdmin({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: PROD_KEY_JSON } as never);
    expect(initializeApp).not.toHaveBeenCalled();
    expect(cert).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
    expect(errors.join("\n")).toContain(reason);
  });

  it("an existing default app on the Production project is refused (isolation guard on the live app)", () => {
    const { mod } = loadAdmin({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-dev" }, [{ name: "[DEFAULT]", options: { projectId: "convergepanel" } }]);
    expect(mod.adminDb).toBeUndefined();
  });

  it("without the opt-in the certificate path is unchanged (Production deployment initializes from its key)", () => {
    const { initializeApp, applicationDefault, cert } = loadAdmin({ VERCEL_ENV: "production", FIREBASE_SERVICE_ACCOUNT_JSON: PROD_KEY_JSON });
    expect(applicationDefault).not.toHaveBeenCalled();
    expect(cert).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });
});
