/**
 * I-1 / I-2 — Firebase project isolation. Covers the shared pure rule, the REAL lib/firebase/admin.ts (every
 * credential-resolution path, with the Admin SDK mocked so nothing connects anywhere), and the REAL
 * lib/firebase/client.ts (client SDK mocked).
 */
import {
  PRODUCTION_FIREBASE_PROJECT_ID,
  UNAVAILABLE_BROWSER_FIREBASE_CONFIG,
  UNAVAILABLE_FIREBASE_PROJECT_ID,
  evaluateServerFirebaseIsolation,
  resolveBrowserFirebaseConfig,
} from "../projectIsolation";

const PROD_SA_EMAIL = "firebase-adminsdk-x@convergepanel.iam.gserviceaccount.com";
const PREVIEW_SA_EMAIL = "firebase-adminsdk-x@convergepanel-preview.iam.gserviceaccount.com";
const NON_PROD_ENVS: unknown[] = ["preview", "development", undefined, "", "Production", " production", "production ", "prod", null, 1];

const PROD_WEB = { apiKey: "AIzaProd", authDomain: "convergepanel.firebaseapp.com", projectId: "convergepanel", storageBucket: "convergepanel.firebasestorage.app", messagingSenderId: "907484474744", appId: "1:907484474744:web:abc" };
const PREVIEW_WEB = { apiKey: "AIzaPrev", authDomain: "convergepanel-preview.firebaseapp.com", projectId: "convergepanel-preview", storageBucket: "convergepanel-preview.firebasestorage.app", messagingSenderId: "111111111111", appId: "1:111111111111:web:def" };

describe("server rule (I-2)", () => {
  it("Production deployment may use the Production project", () => {
    expect(evaluateServerFirebaseIsolation({ projectId: "convergepanel", clientEmail: PROD_SA_EMAIL, deploymentEnv: "production" })).toEqual({ ok: true });
  });
  it.each(NON_PROD_ENVS)("deployment env %p may NOT use the Production project (by projectId or by service-account IAM domain)", (env) => {
    for (const id of ["convergepanel", "ConvergePanel", " convergepanel "]) {
      expect(evaluateServerFirebaseIsolation({ projectId: id, clientEmail: PREVIEW_SA_EMAIL, deploymentEnv: env })).toEqual({ ok: false, reason: "production_project_outside_production" });
    }
    // Credentials from the Production project pointed at another project id are refused too (identity, not names).
    expect(evaluateServerFirebaseIsolation({ projectId: "convergepanel-preview", clientEmail: PROD_SA_EMAIL, deploymentEnv: env })).toEqual({ ok: false, reason: "production_project_outside_production" });
    expect(evaluateServerFirebaseIsolation({ projectId: "convergepanel-preview", clientEmail: PROD_SA_EMAIL.toUpperCase(), deploymentEnv: env })).toEqual({ ok: false, reason: "production_project_outside_production" });
  });
  it.each(["preview", "development", undefined])("deployment env %p may use a non-Production project", (env) => {
    expect(evaluateServerFirebaseIsolation({ projectId: "convergepanel-preview", clientEmail: PREVIEW_SA_EMAIL, deploymentEnv: env })).toEqual({ ok: true });
  });
  it("a missing project id is refused in every environment", () => {
    for (const env of ["production", "preview", undefined]) for (const id of [undefined, "", "  ", null]) expect(evaluateServerFirebaseIsolation({ projectId: id, deploymentEnv: env })).toEqual({ ok: false, reason: "missing_project_id" });
  });
});

describe("browser rule (I-1)", () => {
  it("Production build + Production config → Production config", () => {
    expect(resolveBrowserFirebaseConfig(PROD_WEB, "production")).toEqual({ status: "ok", config: PROD_WEB });
  });
  it.each(NON_PROD_ENVS)("build env %p + Production config → placeholder, never Production", (env) => {
    const r = resolveBrowserFirebaseConfig(PROD_WEB, env);
    expect(r).toEqual({ status: "unavailable", reason: "production_project_outside_production", config: UNAVAILABLE_BROWSER_FIREBASE_CONFIG });
  });
  it("any single Production identity field is enough to refuse outside Production", () => {
    for (const [k, v] of Object.entries(PROD_WEB)) {
      if (k === "apiKey") continue; // the API key is not a project identifier
      const mixed = { ...PREVIEW_WEB, [k]: v };
      expect(resolveBrowserFirebaseConfig(mixed, "preview")).toMatchObject({ status: "unavailable", reason: "production_project_outside_production" });
    }
  });
  it("missing or malformed values never fall back to Production (no defaults exist)", () => {
    for (const k of Object.keys(PREVIEW_WEB)) {
      for (const bad of [undefined, "", " x", "x ", 42]) {
        const r = resolveBrowserFirebaseConfig({ ...PREVIEW_WEB, [k]: bad }, "preview");
        expect(r).toEqual({ status: "unavailable", reason: "missing_or_malformed", config: UNAVAILABLE_BROWSER_FIREBASE_CONFIG });
      }
    }
    // Everything missing — e.g. a CI build — in a Production build too.
    expect(resolveBrowserFirebaseConfig({}, "production")).toMatchObject({ status: "unavailable", config: { projectId: UNAVAILABLE_FIREBASE_PROJECT_ID } });
  });
  it("Preview build + Preview config → Preview config", () => {
    expect(resolveBrowserFirebaseConfig(PREVIEW_WEB, "preview")).toEqual({ status: "ok", config: PREVIEW_WEB });
  });
  it("the placeholder can never be a real project and carries no Production identity", () => {
    expect(UNAVAILABLE_FIREBASE_PROJECT_ID).toMatch(/[A-Z_]/); // real Firebase project ids are lowercase letters, digits, hyphens
    expect(JSON.stringify(UNAVAILABLE_BROWSER_FIREBASE_CONFIG)).not.toMatch(new RegExp(`${PRODUCTION_FIREBASE_PROJECT_ID}|907484474744`));
    expect(Object.isFrozen(UNAVAILABLE_BROWSER_FIREBASE_CONFIG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The REAL lib/firebase/admin.ts, every credential-resolution path.
// ---------------------------------------------------------------------------------------------------------------
const ENV_KEYS = ["VERCEL_ENV", "FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_PROJECT_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => ENV_KEYS.forEach((k) => (savedEnv[k] = process.env[k])));
afterEach(() => ENV_KEYS.forEach((k) => (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]))));

function loadAdmin(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, existingApps: unknown[] = []) {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => (process.env[k] = v));
  const initializeApp = jest.fn((opts: { projectId: string }) => ({ options: { projectId: opts.projectId } }));
  let mod: { adminDb: unknown; adminAuth: unknown; getInitializedFirebaseProjectId: () => string | undefined } | undefined;
  jest.isolateModules(() => {
    jest.doMock("firebase-admin", () => ({ __esModule: true, default: {} }));
    jest.doMock("firebase-admin/app", () => ({ initializeApp, getApps: () => existingApps, cert: (x: unknown) => x }));
    jest.doMock("firebase-admin/auth", () => ({ getAuth: () => ({ kind: "auth" }) }));
    jest.doMock("firebase-admin/firestore", () => ({ getFirestore: () => ({ kind: "db", settings: () => undefined }) }));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mod = require("../admin");
    log.mockRestore();
    err.mockRestore();
  });
  return { initializeApp, mod: mod! };
}
const sa = (project: string, email: string) => JSON.stringify({ project_id: project, client_email: email, private_key: "-----KEY-----" });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("REAL Admin init (I-2): every credential path", () => {
  const paths = {
    base64: (project: string, email: string) => ({ FIREBASE_SERVICE_ACCOUNT_BASE64: b64(sa(project, email)) }),
    json: (project: string, email: string) => ({ FIREBASE_SERVICE_ACCOUNT_JSON: sa(project, email) }),
    separate: (project: string, email: string) => ({ FIREBASE_CLIENT_EMAIL: email, FIREBASE_PRIVATE_KEY: "-----KEY-----", FIREBASE_PROJECT_ID: project }),
  };
  it.each(Object.keys(paths))("%s: Preview/development/unset targeting convergepanel → refused, no app created, adminDb undefined", (p) => {
    for (const env of ["preview", "development", undefined]) {
      const { initializeApp, mod } = loadAdmin({ ...(paths as any)[p]("convergepanel", PROD_SA_EMAIL), ...(env ? { VERCEL_ENV: env } : {}) });
      expect(initializeApp).not.toHaveBeenCalled();
      expect(mod.adminDb).toBeUndefined();
      expect(mod.adminAuth).toBeUndefined();
      expect(mod.getInitializedFirebaseProjectId()).toBeUndefined();
    }
  });
  it.each(Object.keys(paths))("%s: Production targeting convergepanel → initialized (authorized Production path preserved)", (p) => {
    const { initializeApp, mod } = loadAdmin({ ...(paths as any)[p]("convergepanel", PROD_SA_EMAIL), VERCEL_ENV: "production" });
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(initializeApp.mock.calls[0][0]).toMatchObject({ projectId: "convergepanel" });
    expect(mod.adminDb).toBeDefined();
    expect(mod.getInitializedFirebaseProjectId()).toBe("convergepanel");
  });
  it.each(Object.keys(paths))("%s: Preview targeting a non-Production project → initialized", (p) => {
    const { initializeApp, mod } = loadAdmin({ ...(paths as any)[p]("convergepanel-preview", PREVIEW_SA_EMAIL), VERCEL_ENV: "preview" });
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(mod.getInitializedFirebaseProjectId()).toBe("convergepanel-preview");
  });
  it("separate vars with FIREBASE_PROJECT_ID unset fall back to convergepanel — and that fallback is refused outside Production", () => {
    const { initializeApp, mod } = loadAdmin({ FIREBASE_CLIENT_EMAIL: PREVIEW_SA_EMAIL, FIREBASE_PRIVATE_KEY: "-----KEY-----", VERCEL_ENV: "preview" });
    expect(initializeApp).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
  });
  it("base64 JSON without project_id falls back to FIREBASE_PROJECT_ID/convergepanel — refused outside Production", () => {
    const { initializeApp } = loadAdmin({ FIREBASE_SERVICE_ACCOUNT_BASE64: b64(JSON.stringify({ client_email: PREVIEW_SA_EMAIL, private_key: "k" })), VERCEL_ENV: "preview" });
    expect(initializeApp).not.toHaveBeenCalled();
  });
  it("Production credentials relabelled with a Preview project id are refused (IAM domain check)", () => {
    const { initializeApp } = loadAdmin({ FIREBASE_SERVICE_ACCOUNT_JSON: sa("convergepanel-preview", PROD_SA_EMAIL), VERCEL_ENV: "preview" });
    expect(initializeApp).not.toHaveBeenCalled();
  });
  it("an app already in the SDK registry that points at convergepanel is refused outside Production", () => {
    const { initializeApp, mod } = loadAdmin({ FIREBASE_SERVICE_ACCOUNT_JSON: sa("convergepanel-preview", PREVIEW_SA_EMAIL), VERCEL_ENV: "preview" }, [{ options: { projectId: "convergepanel" } }]);
    expect(initializeApp).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
    expect(mod.getInitializedFirebaseProjectId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The REAL lib/firebase/client.ts.
// ---------------------------------------------------------------------------------------------------------------
const WEB_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "apiKey",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "authDomain",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "projectId",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "storageBucket",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "messagingSenderId",
  NEXT_PUBLIC_FIREBASE_APP_ID: "appId",
} as const;
const WEB_KEYS = [...Object.keys(WEB_ENV), "NEXT_PUBLIC_VERCEL_ENV"];
const savedWeb: Record<string, string | undefined> = {};
beforeAll(() => WEB_KEYS.forEach((k) => (savedWeb[k] = process.env[k])));
afterEach(() => WEB_KEYS.forEach((k) => (savedWeb[k] === undefined ? delete process.env[k] : (process.env[k] = savedWeb[k]))));

function loadClient(web: Record<string, string> | null, buildEnv: string | undefined) {
  WEB_KEYS.forEach((k) => delete process.env[k]);
  if (web) for (const [envKey, field] of Object.entries(WEB_ENV)) if (web[field] !== undefined) process.env[envKey] = web[field];
  if (buildEnv !== undefined) process.env.NEXT_PUBLIC_VERCEL_ENV = buildEnv;
  const initializeApp = jest.fn((cfg: { projectId: string }) => ({ options: cfg }));
  jest.isolateModules(() => {
    jest.doMock("firebase/app", () => ({ initializeApp, getApps: () => [] }));
    jest.doMock("firebase/auth", () => ({ getAuth: () => ({}) }));
    jest.doMock("firebase/firestore", () => ({ getFirestore: () => ({}) }));
    require("../client");
  });
  expect(initializeApp).toHaveBeenCalledTimes(1); // the module always imports cleanly (SSR / CI build safe)
  return initializeApp.mock.calls[0][0] as Record<string, string>;
}

describe("REAL client init (I-1)", () => {
  it("Production build with Production config initializes Production", () => {
    expect(loadClient(PROD_WEB, "production")).toEqual(PROD_WEB);
  });
  it.each(["preview", "development", undefined])("build env %p with Production config never initializes Production", (env) => {
    const cfg = loadClient(PROD_WEB, env);
    expect(cfg.projectId).toBe(UNAVAILABLE_FIREBASE_PROJECT_ID);
    expect(JSON.stringify(cfg)).not.toMatch(/convergepanel|907484474744/);
  });
  it.each(["preview", "production", undefined])("build env %p with NO Firebase variables (e.g. CI) uses the placeholder — the old Production defaults are gone", (env) => {
    const cfg = loadClient(null, env);
    expect(cfg).toEqual(UNAVAILABLE_BROWSER_FIREBASE_CONFIG);
  });
  it("Preview build with one Preview variable missing never selects Production", () => {
    const { appId: _omit, ...partial } = PREVIEW_WEB;
    expect(loadClient(partial as Record<string, string>, "preview")).toEqual(UNAVAILABLE_BROWSER_FIREBASE_CONFIG);
  });
  it("Preview build with complete Preview config initializes Preview", () => {
    expect(loadClient(PREVIEW_WEB, "preview")).toEqual(PREVIEW_WEB);
  });
  it("no hard-coded Production values remain in client.ts", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "client.ts"), "utf8");
    expect(src).not.toMatch(/AIzaSy|907484474744|convergepanel\.firebaseapp\.com|"convergepanel"/);
  });
});
