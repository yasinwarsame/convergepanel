/**
 * SESSREV — wiring falsification against the REAL firebase-admin 12.x BaseAuth.
 *
 * The sibling spec mocks `verifyIdToken` and pins the call shape. This one
 * proves the shape matters: `adminAuth` is an object whose `verifyIdToken`,
 * `createSessionCookie` and `verifyDecodedJWTNotRevokedOrDisabled` are the
 * SDK's own prototype methods. Only the network edges are stubbed — the JWT
 * verifier (signature/expiry), `getUser` (the live Auth record) and the REST
 * `createSessionCookie` request handler. If the route dropped `checkRevoked`
 * the SDK would never call `getUser` and the revoked / disabled cases below
 * would mint a cookie (200).
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
  auth.authRequestHandler = { createSessionCookie: (...a: unknown[]) => mockRestCreate(...a) };
  return { adminAuth: auth };
});
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import { adminAuth } from "@/lib/firebase/admin";

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

it("ANCHOR: the route's adminAuth really is the SDK prototype (verifyIdToken / createSessionCookie are not stubs)", () => {
  expect(BASE_AUTH_PROTO.constructor.name).toBe("BaseAuth");
  expect(typeof BASE_AUTH_PROTO.verifyDecodedJWTNotRevokedOrDisabled).toBe("function");
  expect((adminAuth as unknown as { verifyIdToken: unknown }).verifyIdToken).toBe(BASE_AUTH_PROTO.verifyIdToken);
  expect((adminAuth as unknown as { createSessionCookie: unknown }).createSessionCookie).toBe(BASE_AUTH_PROTO.createSessionCookie);
});

it("CONTROL: the SDK's createSessionCookie performs NO live-record check — it mints for a disabled user when called directly", async () => {
  mockUserRecord = { uid: "u1", disabled: true };
  await expect(adminAuth!.createSessionCookie("a.b.c", { expiresIn: 432000000 })).resolves.toBe("minted-cookie");
  expect(mockGetUser).not.toHaveBeenCalled();
});

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
  expect(res.headers.get("set-cookie")).toBeNull();
});

it("disabled → 401, nothing minted", async () => {
  mockUserRecord = { uid: "u1", disabled: true };
  const res = await post();
  expect(res.status).toBe(401);
  expect(mockRestCreate).not.toHaveBeenCalled();
  expect(res.headers.get("set-cookie")).toBeNull();
});

it("getUser outage (app/network-error) → 503, nothing minted", async () => {
  mockUserRecord = Object.assign(new Error("socket hang up"), { code: "app/network-error" });
  const res = await post();
  expect(res.status).toBe(503);
  expect(mockRestCreate).not.toHaveBeenCalled();
});

it("valid (tokensValidAfterTime before auth_time) → 200 and the cookie is set", async () => {
  mockUserRecord = { uid: "u1", disabled: false, tokensValidAfterTime: new Date((AUTH_TIME - 3600) * 1000).toUTCString() };
  const res = await post();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ authenticated: true, uid: "u1" });
  expect(mockRestCreate).toHaveBeenCalledTimes(1);
  expect(res.cookies.get("__session")?.value).toBe("minted-cookie");
});
