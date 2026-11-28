/**
 * SESSREV — wiring falsification against the REAL firebase-admin 12.x BaseAuth.
 *
 * The sibling spec mocks `verifyIdToken` and pins the call shape. This one
 * proves the shape matters: `adminAuth` is an object whose `verifyIdToken` and
 * `verifyDecodedJWTNotRevokedOrDisabled` are the SDK's own prototype methods.
 * Only the network edges are stubbed — the JWT verifier (signature/expiry),
 * `getUser` (the live Auth record) and the SDK's REST request handler (which
 * would carry any cookie-minting request). If the route dropped `checkRevoked`
 * the SDK would never call `getUser` and the revoked / disabled cases below
 * would answer 200. ZCA P3 R2: the handshake mints nothing — the REST handler
 * is never reached on any path, and every response carries only the expiry.
 */

// BaseAuth is not an exported subpath; reach it as the public Auth class's parent prototype.
const BASE_AUTH_PROTO = Object.getPrototypeOf(require("firebase-admin/auth").Auth.prototype);

const NOW = Math.floor(Date.now() / 1000);
const AUTH_TIME = NOW - 600;
let mockUserRecord: { uid: string; disabled: boolean; tokensValidAfterTime?: string } | Error;
const mockGetUser = jest.fn();
const mockRestCreate = jest.fn();

jest.mock("@/lib/firebase/admin", () => {
  const auth = Object.create(Object.getPrototypeOf(require("firebase-admin/auth").Auth.prototype));
  auth.idTokenVerifier = { verifyJWT: async () => ({ uid: "u1", sub: "u1", auth_time: Math.floor(Date.now() / 1000) - 600 }) };
  auth.getUser = (...a: unknown[]) => mockGetUser(...a);
  // Every REST call of the SDK's request handler is recorded: the handshake must never reach it.
  auth.authRequestHandler = new Proxy({}, { get: (_t: object, k: string | symbol) => (typeof k === "symbol" ? undefined : (...a: unknown[]) => mockRestCreate(k, ...a)) });
  return { adminAuth: auth };
});
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import { adminAuth } from "@/lib/firebase/admin";
import { expectExpiryOnly } from "./handshakeHarness";

const post = () =>
  POST(
    new NextRequest("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "a.b.c" }),
    })
  );

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST; // emulator mode forces checkRevoked — would mask the defect
  mockGetUser.mockImplementation(async () => {
    if (mockUserRecord instanceof Error) throw mockUserRecord;
    return mockUserRecord;
  });
  mockRestCreate.mockResolvedValue("minted-cookie");
});

it("ANCHOR: the route's adminAuth really is the SDK prototype (verifyIdToken is not a stub)", () => {
  expect(BASE_AUTH_PROTO.constructor.name).toBe("BaseAuth");
  expect(typeof BASE_AUTH_PROTO.verifyDecodedJWTNotRevokedOrDisabled).toBe("function");
  expect((adminAuth as unknown as { verifyIdToken: unknown }).verifyIdToken).toBe(BASE_AUTH_PROTO.verifyIdToken);
});

// ZCA P3 R2: the CONTROL "the SDK's cookie minting performs no live-record check" was DELETED with the minting.

it("CONTROL: verifyIdToken WITHOUT checkRevoked accepts a revoked token (the pre-fix behaviour)", async () => {
  mockUserRecord = { uid: "u1", disabled: false, tokensValidAfterTime: new Date((AUTH_TIME + 60) * 1000).toUTCString() };
  await expect(adminAuth!.verifyIdToken("a.b.c")).resolves.toMatchObject({ uid: "u1" });
  expect(mockGetUser).not.toHaveBeenCalled();
});

it("revoked (tokensValidAfterTime after auth_time) → 401, nothing minted", async () => {
  mockUserRecord = { uid: "u1", disabled: false, tokensValidAfterTime: new Date((AUTH_TIME + 60) * 1000).toUTCString() };
  const res = await post();
  expect(res.status).toBe(401);
  expect(mockGetUser).toHaveBeenCalledWith("u1");
  expect(mockRestCreate).not.toHaveBeenCalled();
  expectExpiryOnly(res);
});

it("disabled → 401, nothing minted", async () => {
  mockUserRecord = { uid: "u1", disabled: true };
  const res = await post();
  expect(res.status).toBe(401);
  expect(mockRestCreate).not.toHaveBeenCalled();
  expectExpiryOnly(res);
});

it("getUser outage (app/network-error) → 503, nothing minted", async () => {
  mockUserRecord = Object.assign(new Error("socket hang up"), { code: "app/network-error" });
  const res = await post();
  expect(res.status).toBe(503);
  expect(mockRestCreate).not.toHaveBeenCalled();
  expectExpiryOnly(res);
});

it("valid (tokensValidAfterTime before auth_time) → 200 { authenticated, uid }, one live read, NOTHING minted (no REST call, only the expiry)", async () => {
  mockUserRecord = { uid: "u1", disabled: false, tokensValidAfterTime: new Date((AUTH_TIME - 3600) * 1000).toUTCString() };
  const res = await post();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ authenticated: true, uid: "u1" });
  expect(mockGetUser).toHaveBeenCalledTimes(1);
  expect(mockRestCreate).not.toHaveBeenCalled();
  expectExpiryOnly(res);
});
