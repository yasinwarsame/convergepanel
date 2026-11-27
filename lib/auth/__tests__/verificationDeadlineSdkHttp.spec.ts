/**
 * @jest-environment node
 *
 * R4o C1 — the END-TO-END verification deadline against the REAL
 * firebase-admin 12.7.0 HTTP stack (the shape of the R4 reviewer's hang
 * repro, scratchpad r4/B-review/tools/hang.js).
 *
 * Nothing inside the SDK is stubbed. `FIREBASE_AUTH_EMULATOR_HOST` points the
 * SDK at a local 127.0.0.1 server whose `accounts:lookup` (the `getUser` that
 * `checkRevoked` makes) is scripted to:
 *   - "hang": accept the request and never answer. Without a deadline the SDK
 *     makes 5 attempts × its fixed 25 s request timeout ≈ 132 s;
 *   - "retry-after": 503 + `Retry-After: 11` — the SDK honours the header
 *     (up to 60 s per wait, 4 retries), so its first retry alone lands after
 *     the deadline;
 *   - "late-valid": answer a VALID, enabled account record — 12 s late.
 * firebase-admin 12.7.0 exposes no per-call AbortSignal and no Auth retry or
 * timeout option (AuthHttpClient is built with defaultRetryConfig and the
 * hard-coded FIREBASE_AUTH_TIMEOUT), so the deadline races the verification
 * and ABANDONS the late promise; these tests prove the abandoned work can
 * never change the answer. Real timers; no real Firebase project, credential
 * or network.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

type Mode = "hang" | "retry-after" | "late-valid" | "valid";
const mockState: { mode: Mode; auth: unknown } = { mode: "valid", auth: null };
/** Lookups per requested uid — each test uses its own uids, so abandoned retries from an earlier test never count. */
const lookups = new Map<string, number>();
const lookupsOf = (...uids: string[]) => uids.reduce((n, u) => n + (lookups.get(u) ?? 0), 0);

jest.mock("@/lib/firebase/admin", () => ({
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

const DEADLINE = 10_000;
/** Scheduling slack for a loaded machine; still an order of magnitude below the unbounded ~132 s. */
const SLACK = 3_000;
const UNAVAILABLE = { status: "unauthenticated", reason: "auth_unavailable" };

const NOW = Math.floor(Date.now() / 1000);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub: string, iss: string): string {
  return [b64({ alg: "none", typ: "JWT" }), b64({ sub, aud: "test-proj", iss, iat: NOW - 60, exp: NOW + 3000, auth_time: NOW - 600 }), ""].join(".");
}
const idToken = (sub: string) => token(sub, "https://securetoken.google.com/test-proj");
const sessionCookie = (sub: string) => token(sub, "https://session.firebase.google.com/test-proj");
const validRecord = JSON.stringify({ users: [{ localId: "valid", email: "valid@example.com", emailVerified: true, disabled: false }] });

let server: http.Server;
let app: App;
const sockets = new Set<Socket>();
const timers = new Set<NodeJS.Timeout>();
const savedEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const sdkCalls: Array<Promise<unknown>> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (!String(req.url).includes("accounts:lookup")) {
        res.writeHead(404).end();
        return;
      }
      let uid = "?";
      try {
        uid = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).localId?.[0]);
      } catch {
        /* count under "?" */
      }
      lookups.set(uid, (lookups.get(uid) ?? 0) + 1);
      const ok = () => res.writeHead(200, { "content-type": "application/json" }).end(validRecord);
      switch (mockState.mode) {
        case "hang":
          return; // accept, never answer
        case "retry-after":
          res.writeHead(503, { "content-type": "application/json", "retry-after": "11" }).end(JSON.stringify({ error: { code: 503, message: "UNAVAILABLE" } }));
          return;
        case "late-valid": {
          const t = setTimeout(ok, 12_000);
          timers.add(t);
          return;
        }
        default:
          ok();
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = initializeApp(
    { projectId: "test-proj", credential: { getAccessToken: async () => ({ access_token: "local-test", expires_in: 3600 }) } },
    `verification-deadline-${process.pid}`
  );
  // The real Auth instance, with each verification's promise recorded so the
  // tests can observe the ABANDONED SDK call settle (and drain it at the end).
  const real = getAuth(app);
  const record = <T>(p: Promise<T>): Promise<T> => {
    sdkCalls.push(p);
    return p;
  };
  mockState.auth = {
    verifyIdToken: (t: string, c?: boolean) => record(real.verifyIdToken(t, c)),
    verifySessionCookie: (t: string, c?: boolean) => record(real.verifySessionCookie(t, c)),
  };
});

afterEach(() => {
  // Release the abandoned SDK requests so they settle (and are ignored) promptly:
  // their next retry gets a fast valid answer instead of hanging again.
  mockState.mode = "valid";
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const s of sockets) s.destroy();
});

afterAll(async () => {
  mockState.mode = "valid";
  // Drain every abandoned SDK call (their retries now get a fast valid answer).
  for (const s of sockets) s.destroy();
  await Promise.allSettled(sdkCalls);
  if (savedEmulatorHost === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = savedEmulatorHost;
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteApp(app);
});

beforeEach(() => {
  mockState.mode = "valid";
});

function req(opts: { bearer?: string; cookie?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = `__session=${opts.cookie}`;
  return new NextRequest("http://localhost/api/x", { headers });
}

/** Takes a THUNK: the clock must start before the request starts (the deadline timer is armed synchronously). */
async function timed<T>(start: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await start();
  return { value, ms: Date.now() - t0 };
}

it("ANCHOR: a normal record authenticates through the same local edge, far below the deadline", async () => {
  const { value, ms } = await timed(() => resolveRequestIdentity(req({ bearer: idToken("valid") })));
  expect(value).toEqual({ status: "authenticated", uid: "valid", source: "bearer_token" });
  expect(ms).toBeLessThan(DEADLINE);
});

it("Identity Toolkit HANGS: bearer and cookie+bearer — each auth_unavailable at ~10 s (not ~132 s); a cookie ALONE is never sent upstream (ZCA L-8)", async () => {
  mockState.mode = "hang";
  const [bearerOnly, cookieOnly, both] = await Promise.all([
    timed(() => resolveRequestIdentity(req({ bearer: idToken("h1") }))),
    timed(() => resolveRequestIdentity(req({ cookie: sessionCookie("h2") }))),
    timed(() => resolveRequestIdentity(req({ bearer: idToken("h3"), cookie: sessionCookie("h3") }))),
  ]);
  const results = [bearerOnly, both];
  for (const { value, ms } of results) {
    expect(value).toEqual(UNAVAILABLE);
    expect(ms).toBeGreaterThanOrEqual(DEADLINE - 50);
    expect(ms).toBeLessThan(DEADLINE + SLACK);
  }
  // ZCA L-8: the cookie-only request is the anonymous answer at once — no deadline wait, no upstream lookup.
  expect(cookieOnly.value).toEqual({ status: "unauthenticated", reason: "missing_credentials" });
  expect(cookieOnly.ms).toBeLessThan(DEADLINE / 2);
  expect(lookupsOf("h2")).toBe(0);
  expect(lookupsOf("h1", "h2", "h3")).toBe(3); // the SDK really was waiting on the stub: one hung lookup per verified credential
  process.stdout.write(`\nBENCH deadline-hang: ${[bearerOnly, cookieOnly, both].map((r) => r.ms).join(",")}ms lookups=${lookupsOf("h1", "h2", "h3")}\n`);
}, 30_000);

it("503 + Retry-After: 11 (the SDK sleeps past the deadline before retrying) → bounded at ~10 s", async () => {
  mockState.mode = "retry-after";
  const { value, ms } = await timed(() => resolveRequestIdentity(req({ bearer: idToken("ra") })));
  expect(value).toEqual(UNAVAILABLE);
  expect(ms).toBeGreaterThanOrEqual(DEADLINE - 50);
  expect(ms).toBeLessThan(DEADLINE + SLACK);
  expect(lookupsOf("ra")).toBe(1); // the SDK was sleeping 11 s before its first retry when the deadline fired
}, 30_000);

it("the account lookup answers VALID 12 s late → auth_unavailable at the deadline; the late valid answer changes nothing", async () => {
  mockState.mode = "late-valid";
  const before = sdkCalls.length;
  let p!: Promise<unknown>;
  const { value, ms } = await timed(() => (p = resolveRequestIdentity(req({ bearer: idToken("late") }))));
  const abandoned = sdkCalls.slice(before);
  expect(abandoned).toHaveLength(1);
  expect(value).toEqual(UNAVAILABLE);
  expect(ms).toBeLessThan(DEADLINE + SLACK);
  // Let the server deliver the late VALID record to the abandoned SDK call.
  await new Promise((r) => setTimeout(r, 12_000 - ms + 500));
  expect(lookupsOf("late")).toBe(1);
  // The abandoned SDK call really did complete with a VALID decoded token…
  await expect(abandoned[0]).resolves.toMatchObject({ uid: "late" });
  // …and the request's decision did not change.
  await expect(p).resolves.toEqual(UNAVAILABLE);
}, 40_000);

it("12 parallel hanging requests are EACH bounded (~10 s total, not serialized), and a fresh request afterwards is healthy", async () => {
  mockState.mode = "hang";
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => resolveRequestIdentity(req({ bearer: idToken(`u${i}`) }))));
  const ms = Date.now() - t0;
  for (const r of results) expect(r).toEqual(UNAVAILABLE);
  expect(ms).toBeLessThan(DEADLINE + SLACK);
  expect(lookupsOf(...Array.from({ length: 12 }, (_, i) => `u${i}`))).toBe(12);
  for (const s of sockets) s.destroy();
  mockState.mode = "valid";
  await expect(resolveRequestIdentity(req({ bearer: idToken("valid") }))).resolves.toEqual({ status: "authenticated", uid: "valid", source: "bearer_token" });
  process.stdout.write(`\nBENCH deadline-parallel12: ${ms}ms\n`);
}, 30_000);
