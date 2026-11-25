/**
 * #332 R7: `establishServerSession` recognizes the mint's retryable outage ONLY by the contract (status 503 AND body
 * code "auth_unavailable"), and fails closed on the server cookie in every failure case.
 */
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: jest.fn() }));
import { establishServerSession, SESSION_AUTH_UNAVAILABLE_CODE } from "@/lib/client/sessionSync";
import fs from "fs";
import path from "path";

const g = globalThis as any;
const SAVED = g.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let postResponses: Array<() => Response> = [];
let methods: string[] = [];
beforeEach(() => {
  methods = [];
  g.fetch = jest.fn(async (_u: string, init?: { method?: string }) => {
    methods.push(init?.method ?? "GET");
    return init?.method === "POST" ? postResponses.shift()!() : json(200, { ok: true });
  });
});
afterAll(() => {
  g.fetch = SAVED;
});
const user = { uid: "uid-a", getIdToken: jest.fn(async () => "synthetic-token") };

describe("#332 R7 — sessionSync auth_unavailable contract", () => {
  it("503 + code auth_unavailable → reason auth_unavailable; the server cookie is still cleared; no retry storm (one POST)", async () => {
    postResponses = [() => json(503, { error: "Authentication service unavailable", code: "auth_unavailable" })];
    expect(await establishServerSession(user)).toEqual({ ok: false, reason: "auth_unavailable", serverSessionCleared: true });
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it.each([
    ["503 without a JSON body", () => new Response("Service Unavailable", { status: 503 })],
    ["503 with a different code", () => json(503, { error: "x", code: "maintenance" })],
    ["503 with the code nested wrongly", () => json(503, { error: { code: "auth_unavailable" } })],
    ["500 carrying the code", () => json(500, { code: "auth_unavailable" })],
    ["502 carrying the code", () => json(502, { code: "auth_unavailable" })],
  ])("%s → ordinary server_error (fails closed; the caller signs out)", async (_l, r) => {
    postResponses = [r];
    expect(await establishServerSession(user)).toEqual({ ok: false, reason: "server_error", serverSessionCleared: true });
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("a revoked credential (401, then the single 401 retry) → server_error, never auth_unavailable", async () => {
    postResponses = [() => json(401, { error: "Invalid or expired token" }), () => json(401, { error: "Invalid or expired token" })];
    expect(await establishServerSession(user)).toEqual({ ok: false, reason: "server_error", serverSessionCleared: true });
    expect(methods).toEqual(["POST", "POST", "DELETE"]);
  });

  it("the client's code literal equals the route's (oracle reads the real route source)", () => {
    const route = fs.readFileSync(path.resolve(__dirname, "../../../app/api/auth/session/route.ts"), "utf8");
    expect(route).toContain(`const SESSION_AUTH_UNAVAILABLE_CODE = "${SESSION_AUTH_UNAVAILABLE_CODE}";`);
    expect(SESSION_AUTH_UNAVAILABLE_CODE).toBe("auth_unavailable");
  });
});

describe("#332 R8 — client token-refresh failure (Correction B) and server-cookie cleanup (Correction C)", () => {
  const sdkErr = (code: string) => Object.assign(new Error(`Firebase: Error (${code}).`), { code, name: "FirebaseError" });
  const userWith = (getIdToken: (force?: boolean) => Promise<string>) => ({ uid: "uid-a", getIdToken: jest.fn(getIdToken) });

  it("getIdToken rejects with auth/network-request-failed → auth_unavailable; the server cookie is still cleared; no POST was sent", async () => {
    const u = userWith(async () => {
      throw sdkErr("auth/network-request-failed");
    });
    expect(await establishServerSession(u)).toEqual({ ok: false, reason: "auth_unavailable", serverSessionCleared: true });
    expect(methods).toEqual(["DELETE"]);
  });

  it.each(["auth/user-token-expired", "auth/user-disabled", "auth/invalid-user-token", "auth/internal-error", "auth/network-request-failed ", "AUTH/NETWORK-REQUEST-FAILED", ""])(
    "any other SDK code (%p) is NOT a temporary outage → network_error (the caller signs out), cookie still cleared",
    async (code) => {
      const u = userWith(async () => {
        throw sdkErr(code);
      });
      expect(await establishServerSession(u)).toEqual({ ok: false, reason: "network_error", serverSessionCleared: true });
      expect(methods).toEqual(["DELETE"]);
    }
  );

  it("a non-object rejection from getIdToken is not temporary", async () => {
    const u = userWith(async () => {
      throw "boom"; // eslint-disable-line no-throw-literal
    });
    expect(await establishServerSession(u)).toEqual({ ok: false, reason: "network_error", serverSessionCleared: true });
  });

  it("the mint request never reached the server (fetch rejects with TypeError) → auth_unavailable, cookie clear attempted", async () => {
    postResponses = [() => {
      throw new TypeError("Failed to fetch");
    }];
    expect(await establishServerSession(user)).toEqual({ ok: false, reason: "auth_unavailable", serverSessionCleared: true });
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("a failed DELETE is reported (serverSessionCleared: false), so the caller can refuse to keep a NEW identity on top of an unverified cookie", async () => {
    postResponses = [() => json(503, { error: "Authentication service unavailable", code: "auth_unavailable" })];
    g.fetch = jest.fn(async (_u: string, init?: { method?: string }) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") return postResponses.shift()!();
      throw new TypeError("Failed to fetch"); // DELETE unreachable
    });
    expect(await establishServerSession(user)).toEqual({ ok: false, reason: "auth_unavailable", serverSessionCleared: false });
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("forceRefresh defaults to true (Step 6.5); a retry may pass false; the single 401 race retry always forces", async () => {
    const u = userWith(async () => "t");
    postResponses = [() => json(200, { authenticated: true, uid: "uid-a" })];
    await establishServerSession(u);
    expect(u.getIdToken).toHaveBeenLastCalledWith(true);

    u.getIdToken.mockClear();
    postResponses = [() => json(200, { authenticated: true, uid: "uid-a" })];
    await establishServerSession(u, { forceRefresh: false });
    expect(u.getIdToken.mock.calls).toEqual([[false]]);

    u.getIdToken.mockClear();
    postResponses = [() => json(401, {}), () => json(200, { authenticated: true, uid: "uid-a" })];
    await establishServerSession(u, { forceRefresh: false });
    expect(u.getIdToken.mock.calls).toEqual([[false], [true]]);
  });
});
