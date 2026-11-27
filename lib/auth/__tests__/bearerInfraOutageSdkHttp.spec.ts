/**
 * @jest-environment node
 *
 * BEARERREV R4 (MINOR-2) — infrastructure failures of the live `checkRevoked`
 * account lookup, produced by the REAL firebase-admin 12.x HTTP stack.
 *
 * Nothing is stubbed inside the SDK. `adminAuth` is a real `Auth` instance
 * from a real (named, local-only) app, and the ONLY fake is the network edge:
 * `FIREBASE_AUTH_EMULATOR_HOST` points the SDK at a local HTTP server on
 * 127.0.0.1 that answers `accounts:lookup` (the `getUser` call `checkRevoked`
 * makes) with a scripted Identity Toolkit response. So the error `code` each
 * case asserts is the code the SDK itself derives from that HTTP response —
 * its own retry policy (503 is retried), JSON parsing and server-code mapping
 * (`QUOTA_EXCEEDED` → `auth/quota-exceeded`, an unmapped code →
 * `auth/internal-error`, a non-JSON body → `app/unable-to-parse-response`).
 * No real Firebase project, credential or network is used.
 *
 * Emulator mode makes the SDK skip the JWT signature check and always run the
 * revocation lookup, so this file is NOT the checkRevoked wiring proof (that
 * is bearerRevocationRealSdk.spec.ts). It pins the CLASSIFICATION: an
 * infrastructure failure is `auth_unavailable` (fail closed, 503 at the
 * wrappers), a credential failure stays a credential failure (401).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

type Reply = { status: number; contentType: string; body: string } | "reset";
const mockState: { reply: Reply; lookups: number; auth: unknown } = { reply: "reset", lookups: 0, auth: null };

jest.mock("@/lib/firebase/admin", () => ({
  // A live binding to the real Auth instance created in beforeAll.
  get adminAuth() {
    return mockState.auth;
  },
  adminDb: undefined,
  FIREBASE_PROJECT_ID: "test-proj",
  getInitializedFirebaseProjectId: () => "test-proj",
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";

const NOW = Math.floor(Date.now() / 1000);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Emulator-format token (alg "none", empty signature) — the only unsigned form the SDK accepts in emulator mode.
function token(sub: string, iss: string): string {
  return [b64({ alg: "none", typ: "JWT" }), b64({ sub, aud: "test-proj", iss, iat: NOW - 60, exp: NOW + 3000, auth_time: NOW - 600 }), ""].join(".");
}
const idToken = (sub: string) => token(sub, "https://securetoken.google.com/test-proj");
const sessionCookie = (sub: string) => token(sub, "https://session.firebase.google.com/test-proj");

const json = (status: number, body: unknown): Reply => ({ status, contentType: "application/json; charset=UTF-8", body: JSON.stringify(body) });
const userRecord = (extra: Record<string, unknown> = {}) => json(200, { users: [{ localId: "valid", email: "valid@example.com", emailVerified: true, disabled: false, ...extra }] });

let server: http.Server;
let app: App;
const savedEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!String(req.url).includes("accounts:lookup")) {
        res.writeHead(404).end();
        return;
      }
      mockState.lookups += 1;
      const reply = mockState.reply;
      if (reply === "reset") {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "content-type": reply.contentType }).end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = initializeApp(
    { projectId: "test-proj", credential: { getAccessToken: async () => ({ access_token: "local-test", expires_in: 3600 }) } },
    `bearer-infra-outage-${process.pid}`
  );
  mockState.auth = getAuth(app);
});

afterAll(async () => {
  if (savedEmulatorHost === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = savedEmulatorHost;
  await deleteApp(app);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mockState.lookups = 0;
  mockState.reply = userRecord();
});

function req(opts: { bearer?: string; cookie?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = `__session=${opts.cookie}`;
  return new NextRequest("http://localhost/api/x", { headers });
}

/** What the REAL SDK throws for the scripted reply — the oracle, read from the SDK, not from our classifier. */
async function sdkErrorCode(): Promise<string> {
  try {
    await (mockState.auth as { verifyIdToken: (t: string, c: boolean) => Promise<unknown> }).verifyIdToken(idToken("valid"), true);
    return "(resolved)";
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
}

describe("ANCHORS: the local network edge is what the real SDK talks to", () => {
  it("a normal account record → authenticated, exactly one lookup reached the stub server", async () => {
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "authenticated", uid: "valid", source: "bearer_token" });
    expect(mockState.lookups).toBe(1);
  });
  it("cookie + bearer for the same uid → authenticated with TWO lookups (one per presented credential)", async () => {
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid"), cookie: sessionCookie("valid") }))).resolves.toEqual({
      status: "authenticated",
      uid: "valid",
      source: "matching_cookie_and_bearer",
    });
    expect(mockState.lookups).toBe(2);
  });
});

describe("infrastructure failures of the live lookup → auth_unavailable (fail closed, never a credential verdict)", () => {
  const cases: Array<[string, Reply, string]> = [
    [
      "429 QUOTA_EXCEEDED (Identity Toolkit project quota)",
      json(429, { error: { code: 429, message: "QUOTA_EXCEEDED : Exceeded quota for getting account information.", status: "RESOURCE_EXHAUSTED" } }),
      "auth/quota-exceeded",
    ],
    ["429 RESOURCE_EXHAUSTED (unmapped server code)", json(429, { error: { code: 429, message: "RESOURCE_EXHAUSTED", status: "RESOURCE_EXHAUSTED" } }), "auth/internal-error"],
    ["500 with an unmapped server code", json(500, { error: { code: 500, message: "INTERNAL", status: "INTERNAL" } }), "auth/internal-error"],
    ["403 PERMISSION_DENIED (the server's own service account lacks access)", json(403, { error: { code: 403, message: "PERMISSION_DENIED : caller lacks permission", status: "PERMISSION_DENIED" } }), "auth/insufficient-permission"],
    ["502 HTML error page (non-JSON body)", { status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" }, "app/unable-to-parse-response"],
  ];
  it.each(cases)("%s", async (_name, reply, expectedSdkCode) => {
    mockState.reply = reply;
    expect(await sdkErrorCode()).toBe(expectedSdkCode); // oracle: the code really comes from the SDK
    mockState.lookups = 0;
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
    expect(mockState.lookups).toBeGreaterThanOrEqual(1);
  });

  it("quota exceeded on the COOKIE slot → auth_unavailable as well", async () => {
    mockState.reply = cases[0][1];
    await expect(resolveRequestIdentity(req({ cookie: sessionCookie("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
  });

  it("quota exceeded while a matching cookie is ALSO presented → still unauthenticated (no fallback to either credential)", async () => {
    mockState.reply = cases[0][1];
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid"), cookie: sessionCookie("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
  });

  it("a 503 is retried by the SDK before failing (availability cost, measured)", async () => {
    mockState.reply = { status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: 503, message: "UNAVAILABLE", status: "UNAVAILABLE" } }) };
    const t0 = Date.now();
    const r = await resolveRequestIdentity(req({ bearer: idToken("valid") }));
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
    expect(mockState.lookups).toBe(5); // 1 attempt + 4 SDK retries (defaultRetryConfig: maxRetries 4, statusCodes [503])
    process.stdout.write(`\nBENCH sdk-503-retry: lookups=${mockState.lookups} elapsed=${elapsed}ms\n`);
  }, 30_000);

  it("a connection reset (app/network-error) is retried by the SDK, then auth_unavailable (measured)", async () => {
    mockState.reply = "reset";
    const t0 = Date.now();
    const r = await resolveRequestIdentity(req({ bearer: idToken("valid") }));
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
    expect(mockState.lookups).toBe(5); // ECONNRESET is in defaultRetryConfig.ioErrorCodes
    process.stdout.write(`\nBENCH sdk-reset-retry: lookups=${mockState.lookups} elapsed=${elapsed}ms\n`);
  }, 30_000);
});

describe("credential failures from the same live lookup stay credential failures (401 contract unchanged)", () => {
  it("disabled account → invalid_bearer_token", async () => {
    mockState.reply = userRecord({ disabled: true });
    expect(await sdkErrorCode()).toBe("auth/user-disabled");
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
  it("deleted account (no user in the lookup) → invalid_bearer_token", async () => {
    mockState.reply = json(200, {});
    expect(await sdkErrorCode()).toBe("auth/user-not-found");
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
  it("tokens revoked after sign-in → revoked_session", async () => {
    mockState.reply = userRecord({ validSince: String(NOW) });
    expect(await sdkErrorCode()).toBe("auth/id-token-revoked");
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });
  it("USER_NOT_FOUND as a server error body → invalid_bearer_token", async () => {
    mockState.reply = json(400, { error: { code: 400, message: "USER_NOT_FOUND" } });
    expect(await sdkErrorCode()).toBe("auth/user-not-found");
    await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
});
