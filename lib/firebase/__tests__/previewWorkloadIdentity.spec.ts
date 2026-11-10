/**
 * Order 33 — Preview-only keyless Firebase Admin credential (Workload Identity Federation).
 * The pure resolution matrix, the REAL lib/firebase/admin.ts on every WIF path, the credential adapter and the
 * federated client's STS / impersonation configuration.
 */
jest.mock("server-only", () => ({}));

const AUD = "//iam.googleapis.com/projects/718071869099/locations/global/workloadIdentityPools/vercel-preview/providers/vercel-convergepanel";
const PREVIEW_SA = "cp-preview-admin@convergepanel-preview.iam.gserviceaccount.com";
const PROD_SA = "firebase-adminsdk-x@convergepanel.iam.gserviceaccount.com";
const OK_ENV = { VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: "convergepanel-preview", FIREBASE_WIF_AUDIENCE: AUD, FIREBASE_WIF_SERVICE_ACCOUNT: PREVIEW_SA };

describe("resolvePreviewWorkloadIdentity (pure)", () => {
  const { resolvePreviewWorkloadIdentity } = jest.requireActual("../previewWorkloadIdentity") as typeof import("../previewWorkloadIdentity");

  it("applies only on a Vercel Preview deployment: production, development and unset never take this path", () => {
    for (const env of ["production", "development", undefined, "Preview", " preview"]) {
      expect(resolvePreviewWorkloadIdentity({ ...OK_ENV, VERCEL_ENV: env })).toEqual({ kind: "not_applicable" });
    }
  });
  it("a complete Preview configuration resolves to the Preview project and service account", () => {
    expect(resolvePreviewWorkloadIdentity(OK_ENV)).toEqual({ kind: "ok", config: { projectId: "convergepanel-preview", audience: AUD, serviceAccountEmail: PREVIEW_SA } });
  });
  it("no WIF variables on Preview → not applicable (the certificate path then fails closed on its own)", () => {
    expect(resolvePreviewWorkloadIdentity({ VERCEL_ENV: "preview" })).toEqual({ kind: "not_applicable" });
  });
  it("FIREBASE_PROJECT_ID alone (the certificate path's own variable) never opts into WIF", () => {
    expect(resolvePreviewWorkloadIdentity({ VERCEL_ENV: "preview", FIREBASE_PROJECT_ID: "convergepanel-preview" })).toEqual({ kind: "not_applicable" });
  });
  it.each([
    ["missing audience", { ...OK_ENV, FIREBASE_WIF_AUDIENCE: undefined }],
    ["missing service account", { ...OK_ENV, FIREBASE_WIF_SERVICE_ACCOUNT: "" }],
    ["missing project", { ...OK_ENV, FIREBASE_PROJECT_ID: undefined }],
  ])("partial configuration (%s) is refused, never half-applied", (_l, env) => {
    expect(resolvePreviewWorkloadIdentity(env as any)).toEqual({ kind: "refused", reason: "incomplete_configuration" });
  });
  it.each(["https://sts.googleapis.com", "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p", "//iam.googleapis.com/projects/x/locations/global/workloadIdentityPools/p/providers/q"])(
    "an audience that is not a workload identity provider resource is refused: %s",
    (aud) => expect(resolvePreviewWorkloadIdentity({ ...OK_ENV, FIREBASE_WIF_AUDIENCE: aud })).toEqual({ kind: "refused", reason: "invalid_audience" }),
  );
  it.each([
    ["Production project id", { FIREBASE_PROJECT_ID: "convergepanel" }],
    ["Production project id, any case", { FIREBASE_PROJECT_ID: " ConvergePanel " }],
    ["Production project number", { FIREBASE_PROJECT_ID: "907484474744" }],
    ["Production service account", { FIREBASE_WIF_SERVICE_ACCOUNT: PROD_SA }],
  ])("anything that targets Production is refused (%s)", (_l, over) => {
    expect(resolvePreviewWorkloadIdentity({ ...OK_ENV, ...over })).toEqual({ kind: "refused", reason: "production_project" });
  });
  it("a service account from another project than the configured one is refused", () => {
    expect(resolvePreviewWorkloadIdentity({ ...OK_ENV, FIREBASE_WIF_SERVICE_ACCOUNT: "x@other-project.iam.gserviceaccount.com" })).toEqual({ kind: "refused", reason: "service_account_project_mismatch" });
  });
});

describe("the federated client and the firebase-admin credential adapter", () => {
  it("exchanges the Vercel OIDC token at Google STS and impersonates exactly the configured service account", async () => {
    const getVercelOidcToken = jest.fn(async () => "vercel-oidc-jwt");
    let mod!: typeof import("../previewWorkloadIdentity");
    jest.isolateModules(() => {
      jest.doMock("@vercel/oidc", () => ({ getVercelOidcToken }));
      mod = require("../previewWorkloadIdentity");
    });
    const client = mod.createPreviewWorkloadIdentityClient({ projectId: "convergepanel-preview", audience: AUD, serviceAccountEmail: PREVIEW_SA });
    expect((client as any).audience).toBe(AUD);
    expect((client as any).subjectTokenType).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(client.getServiceAccountEmail()).toBe(PREVIEW_SA);
    expect(String((client as any).serviceAccountImpersonationUrl)).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${PREVIEW_SA}:generateAccessToken`);
    expect(String((client as any).stsCredential?.tokenExchangeEndpoint ?? (client as any).tokenUrl ?? "")).toContain("https://sts.googleapis.com/v1/token");
    await expect((client as any).retrieveSubjectToken()).resolves.toBe("vercel-oidc-jwt");
    expect(getVercelOidcToken).toHaveBeenCalledTimes(1);
  });
  it("the credential returns the federated access token and its remaining lifetime; an empty token throws", async () => {
    const { previewWorkloadIdentityCredential } = jest.requireActual("../previewWorkloadIdentity") as typeof import("../previewWorkloadIdentity");
    const now = Date.now();
    const ok = previewWorkloadIdentityCredential({ getAccessToken: async () => ({ token: "ya29.t" }), credentials: { expiry_date: now + 1800_000 } } as any);
    const t = await ok.getAccessToken();
    expect(t.access_token).toBe("ya29.t");
    expect(t.expires_in).toBeGreaterThan(1700);
    expect(t.expires_in).toBeLessThanOrEqual(1800);
    const empty = previewWorkloadIdentityCredential({ getAccessToken: async () => ({ token: null }), credentials: {} } as any);
    await expect(empty.getAccessToken()).rejects.toThrow(/no access token/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The REAL lib/firebase/admin.ts on the WIF paths.
// ---------------------------------------------------------------------------------------------------------------
const ENV_KEYS = ["VERCEL_ENV", "FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_WIF_AUDIENCE", "FIREBASE_WIF_SERVICE_ACCOUNT"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => ENV_KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

function loadAdmin(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, existingApps: unknown[] = []) {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.entries(env).forEach(([k, v]) => (process.env[k] = v as string));
  const initializeApp = jest.fn((opts: { projectId: string; credential: unknown }) => ({ name: "[DEFAULT]", options: { projectId: opts.projectId } }));
  const getFirestore = jest.fn(() => ({ kind: "cert-db", settings: () => undefined }));
  const FirestoreCtor = jest.fn(function (this: any, settings: unknown) { this.kind = "wif-db"; this.settingsArg = settings; });
  const IdentityPoolClient = jest.fn(function (this: any, opts: unknown) { this.opts = opts; });
  let mod: any;
  jest.isolateModules(() => {
    jest.doMock("firebase-admin", () => ({ __esModule: true, default: {} }));
    jest.doMock("firebase-admin/app", () => ({ initializeApp, getApps: () => existingApps, cert: (x: unknown) => ({ cert: x }) }));
    jest.doMock("firebase-admin/auth", () => ({ getAuth: () => ({ kind: "auth" }) }));
    jest.doMock("firebase-admin/firestore", () => ({ getFirestore, Firestore: FirestoreCtor }));
    jest.doMock("google-auth-library", () => ({ IdentityPoolClient }));
    jest.doMock("@vercel/oidc", () => ({ getVercelOidcToken: async () => "jwt" }));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mod = require("../admin");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
  return { initializeApp, getFirestore, FirestoreCtor, IdentityPoolClient, mod };
}

describe("admin.ts — Preview workload identity path", () => {
  it("Preview + complete WIF config → Admin on the Preview project with the federated credential; Firestore built on the same auth client", () => {
    const { initializeApp, getFirestore, FirestoreCtor, IdentityPoolClient, mod } = loadAdmin(OK_ENV);
    expect(IdentityPoolClient).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledTimes(1);
    const opts = initializeApp.mock.calls[0][0] as any;
    expect(opts.projectId).toBe("convergepanel-preview");
    expect(typeof opts.credential.getAccessToken).toBe("function");
    expect(opts.credential.cert).toBeUndefined();
    expect(getFirestore).not.toHaveBeenCalled();
    expect(FirestoreCtor).toHaveBeenCalledTimes(1);
    const s = FirestoreCtor.mock.calls[0][0] as any;
    expect(s.projectId).toBe("convergepanel-preview");
    expect(s.ignoreUndefinedProperties).toBe(true);
    expect(s.authClient).toBe(IdentityPoolClient.mock.instances[0]);
    expect(mod.adminDb.kind).toBe("wif-db");
    expect(mod.adminAuth).toEqual({ kind: "auth" });
  });
  it("Production with WIF variables present never uses WIF (certificate path only)", () => {
    const { IdentityPoolClient, FirestoreCtor } = loadAdmin({ ...OK_ENV, VERCEL_ENV: "production", FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "convergepanel", client_email: PROD_SA, private_key: "k" }) });
    expect(IdentityPoolClient).not.toHaveBeenCalled();
    expect(FirestoreCtor).not.toHaveBeenCalled();
  });
  it.each([
    ["the Production project", { FIREBASE_PROJECT_ID: "convergepanel" }],
    ["a Production service account", { FIREBASE_WIF_SERVICE_ACCOUNT: PROD_SA }],
    ["an incomplete config", { FIREBASE_WIF_AUDIENCE: "" }],
    ["an invalid audience", { FIREBASE_WIF_AUDIENCE: "https://evil.example" }],
  ])("Preview WIF aimed at %s initializes nothing (Admin stays unavailable)", (_l, over) => {
    const { initializeApp, IdentityPoolClient, FirestoreCtor, mod } = loadAdmin({ ...OK_ENV, ...over });
    expect(initializeApp).not.toHaveBeenCalled();
    expect(IdentityPoolClient).not.toHaveBeenCalled();
    expect(FirestoreCtor).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
    expect(mod.adminAuth).toBeUndefined();
  });
  it("a refused WIF config never falls back to a certificate that happens to be present", () => {
    const { initializeApp } = loadAdmin({ ...OK_ENV, FIREBASE_PROJECT_ID: "convergepanel", FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "convergepanel-preview", client_email: PREVIEW_SA, private_key: "k" }) });
    expect(initializeApp).not.toHaveBeenCalled();
  });
  it("an already-registered DEFAULT app on the Production project is refused on the WIF path too", () => {
    const { mod } = loadAdmin(OK_ENV, [{ name: "[DEFAULT]", options: { projectId: "convergepanel" } }]);
    expect(mod.adminDb).toBeUndefined();
    expect(mod.adminAuth).toBeUndefined();
  });
  it("Preview with no Admin configuration at all initializes nothing (contained state)", () => {
    const { initializeApp, mod } = loadAdmin({ VERCEL_ENV: "preview" });
    expect(initializeApp).not.toHaveBeenCalled();
    expect(mod.adminDb).toBeUndefined();
  });
});
