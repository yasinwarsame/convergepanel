/**
 * Order 35 G (Development isolation D-2): keyless developer Admin credential on a non-Production project only.
 * The pure resolver, and the REAL lib/firebase/admin.ts on the development ADC path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { adcWellKnownFilePath, inspectAdcFile, resolveDevelopmentAdc } from "../developmentAdc";

const DEV_SA = "cp-dev-admin@convergepanel-preview.iam.gserviceaccount.com";
const impersonation = (sa: string) => ({ type: "impersonated_service_account", service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`, source_credentials: { type: "authorized_user" } });

describe("inspectAdcFile (review M-1)", () => {
  it("accepts only an impersonated service account and returns its address", () => {
    expect(inspectAdcFile(JSON.stringify(impersonation(DEV_SA)))).toEqual({ kind: "ok", serviceAccountEmail: DEV_SA });
  });
  it.each([
    ["missing file (metadata-server fallback)", null, "adc_file_missing"],
    ["not JSON", "{", "adc_file_unreadable"],
    ["an array", "[]", "adc_file_unreadable"],
    ["a service-account KEY", JSON.stringify({ type: "service_account", project_id: "convergepanel-preview", private_key: "k", client_email: DEV_SA }), "adc_not_impersonated_service_account"],
    ["the developer's own user credential", JSON.stringify({ type: "authorized_user", client_id: "x" }), "adc_not_impersonated_service_account"],
    ["external account", JSON.stringify({ type: "external_account" }), "adc_not_impersonated_service_account"],
    ["no impersonation URL", JSON.stringify({ type: "impersonated_service_account", source_credentials: { type: "authorized_user" } }), "adc_invalid_impersonation"],
    ["a URL that is not the IAM credentials endpoint", JSON.stringify({ ...impersonation(DEV_SA), service_account_impersonation_url: `https://evil.example/v1/projects/-/serviceAccounts/${DEV_SA}:generateAccessToken` }), "adc_invalid_impersonation"],
    ["a URL with path injection", JSON.stringify({ ...impersonation(DEV_SA), service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/x%40convergepanel.iam.gserviceaccount.com:generateAccessToken?@convergepanel-preview.iam.gserviceaccount.com:generateAccessToken` }), "adc_invalid_impersonation"],
  ])("refuses %s", (_n, text, reason) => {
    expect(inspectAdcFile(text as string | null)).toEqual({ kind: "refused", reason });
  });
  it.each([
    ["an impersonation sourced from a service-account KEY", { ...impersonation(DEV_SA), source_credentials: { type: "service_account", private_key: "k" } }],
    ["no source credential", { ...impersonation(DEV_SA), source_credentials: undefined }],
    ["a malformed source credential", { ...impersonation(DEV_SA), source_credentials: ["authorized_user"] }],
  ])("refuses %s (review m-1)", (_n, content) => {
    expect(inspectAdcFile(JSON.stringify(content))).toEqual({ kind: "refused", reason: "adc_source_not_user_credential" });
  });
  it("reads the same well-known path firebase-admin and google-auth-library read (HOME / APPDATA, never CLOUDSDK_CONFIG)", () => {
    expect(adcWellKnownFilePath({ HOME: "/home/dev" }, "darwin")).toBe("/home/dev/.config/gcloud/application_default_credentials.json");
    expect(adcWellKnownFilePath({ HOME: "/home/dev", CLOUDSDK_CONFIG: "/cfg" }, "linux")).toBe("/home/dev/.config/gcloud/application_default_credentials.json");
    expect(adcWellKnownFilePath({ APPDATA: "C:/AppData", HOME: "/home/dev" }, "win32")).toBe("C:/AppData/gcloud/application_default_credentials.json");
    expect(adcWellKnownFilePath({}, "darwin")).toBeNull();
    expect(adcWellKnownFilePath({ HOME: "" }, "linux")).toBeNull();
    expect(adcWellKnownFilePath({ HOME: "/home/dev" }, "win32")).toBeNull();
  });
});

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
    ["CLOUDSDK_CONFIG (the SDKs would read a different file than gcloud wrote; review M-1)", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-dev", CLOUDSDK_CONFIG: "/cfg" }, "cloudsdk_config_unsupported"],
  ])("refuses %s", (_n, env, reason) => {
    expect(resolveDevelopmentAdc(env as Record<string, string>)).toEqual({ kind: "refused", reason });
  });
});

const ENV_KEYS = ["VERCEL_ENV", "FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_WIF_AUDIENCE", "FIREBASE_WIF_SERVICE_ACCOUNT", "FIREBASE_ADMIN_CREDENTIAL_SOURCE", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "HOME"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => ENV_KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

let cfgDir: string;
beforeEach(() => (cfgDir = mkdtempSync(join(tmpdir(), "cp-adc-"))));
afterEach(() => rmSync(cfgDir, { recursive: true, force: true }));
/** Writes the gcloud ADC file (null: none) at a temporary HOME's well-known path, the only file the SDKs read. */
const adcFile = (content: unknown | null): { HOME: string } => {
  mkdirSync(join(cfgDir, ".config", "gcloud"), { recursive: true });
  if (content !== null) writeFileSync(join(cfgDir, ".config", "gcloud", "application_default_credentials.json"), typeof content === "string" ? content : JSON.stringify(content));
  return { HOME: cfgDir };
};

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
/** Review N-1: a NON-Production key, which the certificate path would accept — so a fallback to it is detectable. */
const DEV_KEY_JSON = JSON.stringify({ project_id: "convergepanel-preview", client_email: "legacy-key@convergepanel-preview.iam.gserviceaccount.com", private_key: "k" });

describe("admin.ts — development application-default path", () => {
  it("opt-in on a non-Production project → Admin with the application-default credential, no certificate read", () => {
    const { initializeApp, applicationDefault, cert, mod } = loadAdmin({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", FIREBASE_SERVICE_ACCOUNT_JSON: DEV_KEY_JSON, ...adcFile(impersonation(DEV_SA)) });
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
    ["a service-account key as the ADC file", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", __adc: { type: "service_account", private_key: "k", client_email: DEV_SA } }, "development_adc_adc_not_impersonated_service_account"],
    ["no ADC file (metadata-server fallback)", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", __adc: null }, "development_adc_adc_file_missing"],
    ["CLOUDSDK_CONFIG pointing at a different file than the SDKs read (review M-1)", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", CLOUDSDK_CONFIG: "/elsewhere" }, "development_adc_cloudsdk_config_unsupported"],
    ["an impersonation sourced from a service-account key (review m-1)", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", __adc: { ...impersonation(DEV_SA), source_credentials: { type: "service_account", private_key: "k" } } }, "development_adc_adc_source_not_user_credential"],
    ["impersonating the Production Admin SA", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", __adc: impersonation("firebase-adminsdk-fbsvc@convergepanel.iam.gserviceaccount.com") }, "production_project_outside_production"],
    ["impersonating an SA of another project", { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", __adc: impersonation("cp-dev-admin@other-project-123.iam.gserviceaccount.com") }, "credential_project_mismatch"],
  ])("refused on %s: Admin stays uninitialized and no certificate fallback is attempted", (_n, envIn, reason) => {
    const { __adc, ...env } = envIn as Record<string, unknown>;
    const { initializeApp, cert, mod, errors } = loadAdmin({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: DEV_KEY_JSON, ...adcFile(__adc === undefined ? impersonation(DEV_SA) : __adc) } as never);
    expect(initializeApp).not.toHaveBeenCalled();
    expect(cert).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
    expect(errors.join("\n")).toContain(reason);
  });

  it("HOME unset: the SDKs would skip the well-known file and use the metadata server, so it is refused (review M-1)", () => {
    adcFile(impersonation(DEV_SA));
    const { initializeApp, mod, errors } = loadAdmin({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview" });
    expect(process.env.HOME).toBeUndefined();
    expect(initializeApp).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
    expect(errors.join("\n")).toContain("development_adc_adc_file_missing");
  });

  it("an existing default app on the Production project is refused (isolation guard on the live app)", () => {
    const { mod } = loadAdmin({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", ...adcFile(impersonation(DEV_SA)) }, [{ name: "[DEFAULT]", options: { projectId: "convergepanel" } }]);
    expect(mod.adminDb).toBeUndefined();
  });

  it("review N-2: an existing default app for another non-Production project is not reused", () => {
    const { mod, errors } = loadAdmin({ FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: "convergepanel-preview", ...adcFile(impersonation(DEV_SA)) }, [{ name: "[DEFAULT]", options: { projectId: "convergepanel-dev" } }]);
    expect(mod.adminDb).toBeUndefined();
    expect(errors.join("\n")).toContain("development_adc_existing_app_project_mismatch");
  });

  it("without the opt-in the certificate path is unchanged (Production deployment initializes from its key)", () => {
    const { initializeApp, applicationDefault, cert } = loadAdmin({ VERCEL_ENV: "production", FIREBASE_SERVICE_ACCOUNT_JSON: PROD_KEY_JSON });
    expect(applicationDefault).not.toHaveBeenCalled();
    expect(cert).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });
});
