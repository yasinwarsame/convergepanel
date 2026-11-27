/**
 * R-S0-7 (owner decision 2026-11-27, review MINOR-1): cookie-clear / mint ordering in `sessionSync`.
 * - A mint is never sent while a DELETE from this tab is still in flight, so an older clear can never land after a
 *   newer identity's cookie and delete it.
 * - A superseded sync (its signal aborted by AuthProvider) does not issue its own failure-path DELETE: the newer
 *   identity event owns the cookie.
 * Synthetic tokens and uids only.
 */
const mockEvents: string[] = [];
jest.mock("@/lib/client/authSessionTelemetry", () => ({ logAuthSessionClientEvent: (op: string) => mockEvents.push(op) }));

import { establishServerSession, clearServerSession } from "@/lib/client/sessionSync";

type Call = { method: string };
let calls: Call[] = [];
let releaseDelete: (() => void) | null = null;
let postResponse: () => unknown = () => ok({ authenticated: true, uid: "uid-a" });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const g = globalThis as any;
const SAVED_FETCH = g.fetch;
const user = { uid: "uid-a", getIdToken: async () => "synthetic-token-a" };
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  calls = [];
  mockEvents.length = 0;
  releaseDelete = null;
  postResponse = () => ok({ authenticated: true, uid: "uid-a" });
  g.fetch = jest.fn(async (_url: string, init: { method: string }) => {
    calls.push({ method: init.method });
    if (init.method === "DELETE") {
      await new Promise<void>((r) => {
        releaseDelete = r;
      });
      return ok({ ok: true });
    }
    return postResponse();
  });
});
afterAll(() => {
  g.fetch = SAVED_FETCH;
});

describe("R-S0-7 — no mint while a DELETE is in flight", () => {
  it("a mint started while a clear is pending is sent only after that clear settled", async () => {
    const clearing = clearServerSession();
    const minting = establishServerSession(user, {});
    await settle();
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    releaseDelete!();
    await expect(clearing).resolves.toBe(true);
    await expect(minting).resolves.toEqual({ ok: true, uid: "uid-a" });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
  });

  it("a sync aborted while it waits for the clear sends no mint at all", async () => {
    const clearing = clearServerSession();
    const controller = new AbortController();
    const minting = establishServerSession(user, { signal: controller.signal });
    await settle();
    controller.abort();
    releaseDelete!();
    await clearing;
    await expect(minting).resolves.toEqual({ ok: false, reason: "network_error" });
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("control: with no clear in flight the mint is sent immediately", async () => {
    await expect(establishServerSession(user, {})).resolves.toEqual({ ok: true, uid: "uid-a" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("R-S0-7 — a superseded sync issues no failure-path DELETE", () => {
  function pendingBodyResponse(status: number) {
    let resolveBody!: (b: unknown) => void;
    const body = new Promise<unknown>((r) => {
      resolveBody = r;
    });
    postResponse = () => ({ ok: status >= 200 && status < 300, status, json: () => body });
    return (b: unknown) => resolveBody(b);
  }

  it("superseded while its answer is read, then the answer is a uid mismatch: no DELETE (the newer identity owns the cookie)", async () => {
    const resolveBody = pendingBodyResponse(200);
    const controller = new AbortController();
    const minting = establishServerSession(user, { signal: controller.signal });
    await settle();
    controller.abort();
    resolveBody({ authenticated: true, uid: "uid-other" });
    await expect(minting).resolves.toEqual({ ok: false, reason: "uid_mismatch" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(mockEvents).toContain("stale_cleanup_skipped");
  });

  it("control: the same uid mismatch on a sync that is still current clears the cookie", async () => {
    const resolveBody = pendingBodyResponse(200);
    const minting = establishServerSession(user, { signal: new AbortController().signal });
    await settle();
    resolveBody({ authenticated: true, uid: "uid-other" });
    await settle();
    releaseDelete?.();
    await expect(minting).resolves.toEqual({ ok: false, reason: "uid_mismatch" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  });

  it("superseded while a 503 body is read (kept-session check), then not auth_unavailable: no DELETE", async () => {
    const resolveBody = pendingBodyResponse(503);
    const controller = new AbortController();
    const minting = establishServerSession(user, { signal: controller.signal, keepSessionOnAuthUnavailable: true });
    await settle();
    controller.abort();
    resolveBody({ error: "other" });
    await expect(minting).resolves.toEqual({ ok: false, reason: "server_error" });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });
});
