/**
 * D-2 confirmation review, MATERIAL finding: on the development ADC path the Firebase Auth client must run AS the
 * validated impersonated developer service account, not as the developer's own Google user.
 *
 * Offline probe on the REAL SDKs: the real lib/firebase/admin.ts, real firebase-admin 12.7.0, real google-auth-library
 * and real @google-cloud/firestore. Only the HTTP transport is stubbed — firebase-admin's HttpClient.send and gaxios'
 * _defaultAdapter — and every credential value is fake. Raw http/https/fetch are trapped so nothing can leave the
 * process. firebase-admin's own ImpersonatedServiceAccountCredential (what applicationDefault() returns for this file)
 * only refreshes the SOURCE user's token and never calls iamcredentials, so this spec fails on that code.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEV_SA = "cp-dev-admin@convergepanel-preview.iam.gserviceaccount.com";
const PROJECT = "convergepanel-preview";
const IMPERSONATION_URL = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${DEV_SA}:generateAccessToken`;
const FAKE_ADC = {
  type: "impersonated_service_account",
  service_account_impersonation_url: IMPERSONATION_URL,
  delegates: [],
  source_credentials: { type: "authorized_user", client_id: "fake-client-id.apps.googleusercontent.com", client_secret: "fake-client-secret", refresh_token: "fake-refresh-token" },
};
const USER_TOKEN = "fake-developer-user-access-token";
const SA_TOKEN = "fake-impersonated-sa-access-token";
const CLIENT_KEY = Symbol.for("convergepanel.firebase.developmentAdcClient");

type Recorded = { via: "firebase-admin" | "gaxios"; method: string; url: string; authorization?: string };

const ENV_KEYS = ["VERCEL_ENV", "FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_WIF_AUDIENCE", "FIREBASE_WIF_SERVICE_ACCOUNT", "FIREBASE_ADMIN_CREDENTIAL_SOURCE", "GOOGLE_APPLICATION_CREDENTIALS", "google_application_credentials", "CLOUDSDK_CONFIG", "HOME", "APPDATA"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => ENV_KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cp-adc-identity-"));
  mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
  writeFileSync(join(home, ".config", "gcloud", "application_default_credentials.json"), JSON.stringify(FAKE_ADC));
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const header = (h: unknown, name: string): string | undefined => {
  if (!h) return undefined;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const e = Object.entries(h as Record<string, string>).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return e?.[1];
};

/** Loads the real admin.ts on the development ADC path with only the HTTP transport stubbed. */
function loadRealAdmin() {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, { FIREBASE_ADMIN_CREDENTIAL_SOURCE: "adc", FIREBASE_PROJECT_ID: PROJECT, HOME: home });
  const requests: Recorded[] = [];
  let mod: any;
  let Impersonated: any;
  jest.isolateModules(() => {
    // Nothing may reach the network: raw transports throw.
    const trap = () => {
      throw new Error("network access attempted in an offline probe");
    };
    jest.spyOn(require("https"), "request").mockImplementation(trap);
    jest.spyOn(require("http"), "request").mockImplementation(trap);
    if (typeof globalThis.fetch === "function") jest.spyOn(globalThis, "fetch").mockImplementation(trap);

    const { HttpClient } = require(realpathSync(join(process.cwd(), "node_modules/firebase-admin/lib/utils/api-request.js")));
    jest.spyOn(HttpClient.prototype, "send").mockImplementation(async (config: any) => {
      requests.push({ via: "firebase-admin", method: config.method, url: config.url, authorization: header(config.headers, "authorization") });
      const ok = (data: unknown) => ({ status: 200, headers: {}, data, text: JSON.stringify(data), isJson: () => true });
      if (config.url === "https://www.googleapis.com/oauth2/v4/token") return ok({ access_token: USER_TOKEN, expires_in: 3600, token_type: "Bearer" });
      if ((() => { const u = new URL(String(config.url)); return u.hostname === "identitytoolkit.googleapis.com" && u.pathname === `/v1/projects/${PROJECT}/accounts:lookup`; })()) return ok({ kind: "identitytoolkit#GetAccountInfoResponse" });
      throw new Error(`unexpected firebase-admin request ${config.method} ${config.url}`);
    });

    const { Gaxios } = require(realpathSync(require.resolve("gaxios", { paths: [realpathSync(join(process.cwd(), "node_modules/google-auth-library"))] })));
    jest.spyOn(Gaxios.prototype, "_defaultAdapter").mockImplementation(async (opts: any) => {
      const url = String(opts.url);
      requests.push({ via: "gaxios", method: opts.method, url, authorization: header(opts.headers, "authorization") });
      const ok = (data: unknown) => ({ config: opts, data, headers: {}, status: 200, statusText: "OK", request: { responseURL: url } });
      if (url === "https://oauth2.googleapis.com/token") return ok({ access_token: USER_TOKEN, expires_in: 3600, token_type: "Bearer" });
      if (url === IMPERSONATION_URL) return ok({ accessToken: SA_TOKEN, expireTime: new Date(Date.now() + 3600_000).toISOString() });
      throw new Error(`unexpected gaxios request ${opts.method} ${url}`);
    });

    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mod = require("../admin");
      Impersonated = require(realpathSync(join(process.cwd(), "node_modules/google-auth-library"))).Impersonated;
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
  return { mod, requests, Impersonated };
}

describe("development ADC path — the Admin credential runs as the validated service account (offline real-SDK probe)", () => {
  it("the Auth credential's token is the impersonated SA token: source refresh, then iamcredentials generateAccessToken for the validated SA", async () => {
    const { mod, requests } = loadRealAdmin();
    expect(mod.default).toBeDefined();
    const token = await mod.default.options.credential.getAccessToken();
    expect(requests.map((r) => `${r.via} ${r.method} ${r.url}`)).toEqual([
      "gaxios POST https://oauth2.googleapis.com/token",
      `gaxios POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${DEV_SA}:generateAccessToken`,
    ]);
    // The iamcredentials call is made with the developer's source token; nothing uses firebase-admin's own refresh.
    expect(requests[1].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(requests.some((r) => r.url.includes("/oauth2/v4/token"))).toBe(false);
    expect(token.access_token).toBe(SA_TOKEN);
    expect(token.expires_in).toBeGreaterThan(3500);
  });

  it("a real Firebase Auth read carries the impersonated SA token, never the developer's user token", async () => {
    const { mod, requests } = loadRealAdmin();
    await expect(mod.adminAuth.getUser("nonexistent-probe-uid")).rejects.toMatchObject({ code: "auth/user-not-found" });
    const lookup = requests.filter((r) => new URL(r.url).hostname === "identitytoolkit.googleapis.com");
    expect(lookup).toHaveLength(1);
    expect(lookup[0].authorization).toBe(`Bearer ${SA_TOKEN}`);
  });

  it("Firestore is given the SAME impersonated client explicitly (no lazy ADC read of its own)", async () => {
    const { mod, requests, Impersonated } = loadRealAdmin();
    const authClient = mod.adminDb?._settings?.authClient;
    expect(authClient).toBeInstanceOf(Impersonated);
    expect(authClient.targetPrincipal).toBe(DEV_SA);
    expect(mod.default.options.credential[CLIENT_KEY]).toBe(authClient);
    expect(mod.adminDb._settings.projectId).toBe(PROJECT);
    expect(mod.adminDb._settings.ignoreUndefinedProperties).toBe(true);
    // One token for both: after the Auth credential fetches it, Firestore's client already holds it (shared cache).
    await mod.default.options.credential.getAccessToken();
    const n = requests.length;
    await expect(authClient.getAccessToken()).resolves.toMatchObject({ token: SA_TOKEN });
    expect(requests).toHaveLength(n);
  });
});

describe("createDevelopmentImpersonatedClient fails closed (no unimpersonated fallback)", () => {
  const { createDevelopmentImpersonatedClient, developmentClientOf, developmentImpersonatedCredential } = jest.requireActual("../developmentAdcClient") as typeof import("../developmentAdcClient");
  const text = JSON.stringify(FAKE_ADC);

  it("targets exactly the validated SA with the cloud-platform scope", () => {
    const client = createDevelopmentImpersonatedClient(text, DEV_SA);
    expect(client.getTargetPrincipal()).toBe(DEV_SA);
    expect((client as any).targetScopes).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(developmentClientOf(developmentImpersonatedCredential(client), DEV_SA)).toBe(client);
    expect(developmentClientOf(developmentImpersonatedCredential(client), "cp-dev-other@convergepanel-preview.iam.gserviceaccount.com")).toBeNull();
  });
  it("refuses a service account that is not the one the file was validated for", () => {
    expect(() => createDevelopmentImpersonatedClient(text, "cp-dev-other@convergepanel-preview.iam.gserviceaccount.com")).toThrow(/does not match/);
  });
  it.each(["client_id", "client_secret", "refresh_token"])("refuses a source credential without %s, without echoing values", (field) => {
    const source = { ...FAKE_ADC.source_credentials } as Record<string, unknown>;
    delete source[field];
    let message = "";
    try {
      createDevelopmentImpersonatedClient(JSON.stringify({ ...FAKE_ADC, source_credentials: source }), DEV_SA);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/incomplete authorized_user/);
    expect(message).not.toMatch(/fake-/);
  });
});
