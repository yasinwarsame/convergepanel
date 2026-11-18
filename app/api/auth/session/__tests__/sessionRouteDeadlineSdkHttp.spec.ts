/**
 * @jest-environment node
 *
 * R5 C (MAJOR-1) — the session mint's 10 s deadline against the REAL
 * firebase-admin 12.7.0 HTTP stack. Nothing inside the SDK is stubbed:
 * `FIREBASE_AUTH_EMULATOR_HOST` points it at a local 127.0.0.1 server that
 * scripts the two upstream calls the mint makes —
 *   - `accounts:lookup` (the `getUser` behind `verifyIdToken(idToken, true)`), and
 *   - `:createSessionCookie`.
 * Modes: "hang" (accept, never answer: unbounded, the SDK makes 5 attempts ×
 * its 25 s timeout ≈ 132 s), "late-valid" (answer VALID 12 s late). Real
 * timers. No real Firebase project, credential or network.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

type Mode = "ok" | "hang" | "late-valid";
const mockState: { lookup: Mode; create: Mode; auth: unknown } = { lookup: "ok", create: "ok", auth: null };
const hits = { lookup: 0, create: 0 };

jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return mockState.auth;
  },
  adminDb: undefined,
  FIREBASE_PROJECT_ID: "test-proj",
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { POST } from "@/app/api/auth/session/route";

const DEADLINE = 10_000;
const SLACK = 3_000;
const NOW = Math.floor(Date.now() / 1000);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (sub: string) =>
  [b64({ alg: "none", typ: "JWT" }), b64({ sub, aud: "test-proj", iss: "https://securetoken.google.com/test-proj", iat: NOW - 60, exp: NOW + 3000, auth_time: NOW - 600 }), ""].join(".");
const record = (uid: string) => JSON.stringify({ users: [{ localId: uid, email: `${uid}@example.com`, emailVerified: true, disabled: false }] });

let server: http.Server;
let app: App;
const sockets = new Set<Socket>();
const timers = new Set<NodeJS.Timeout>();
const sdkCalls: Array<Promise<unknown>> = [];
const savedEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = String(req.url);
      const isLookup = url.includes("accounts:lookup");
      const isCreate = url.includes(":createSessionCookie");
      if (!isLookup && !isCreate) return void res.writeHead(404).end();
      let uid = "u";
      try {
        uid = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).localId?.[0] ?? "u");
      } catch {
        /* default */
      }
      const ok = () =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(isLookup ? record(uid) : JSON.stringify({ sessionCookie: "minted-session-cookie" }));
      const mode = isLookup ? mockState.lookup : mockState.create;
      hits[isLookup ? "lookup" : "create"]++;
      if (mode === "hang") return;
      if (mode === "late-valid") {
        const t = setTimeout(ok, 12_000);
        timers.add(t);
        return;
      }
      ok();
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
    `session-deadline-${process.pid}`
  );
  const real = getAuth(app);
  const rec = <T>(p: Promise<T>): Promise<T> => {
    sdkCalls.push(p);
    return p;
  };
  mockState.auth = {
    verifyIdToken: (t: string, c?: boolean) => rec(real.verifyIdToken(t, c)),
    createSessionCookie: (t: string, o: { expiresIn: number }) => rec(real.createSessionCookie(t, o)),
  };
});

beforeEach(() => {
  mockState.lookup = "ok";
  mockState.create = "ok";
  hits.lookup = 0;
  hits.create = 0;
});
afterEach(() => {
  mockState.lookup = "ok";
  mockState.create = "ok";
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const s of sockets) s.destroy();
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await Promise.allSettled(sdkCalls);
  if (savedEmulatorHost === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = savedEmulatorHost;
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteApp(app);
});

const post = (sub: string) =>
  POST(new NextRequest("http://localhost/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: idToken(sub) }) }));

async function timed<T>(start: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await start();
  return { value, ms: Date.now() - t0 };
}

it("ANCHOR: through the same local edge a healthy login mints a cookie (lookup + createSessionCookie both reached)", async () => {
  const { value: res, ms } = await timed(() => post("ok-user"));
  expect(res.status).toBe(200);
  expect(res.cookies.get("__session")?.value).toBe("minted-session-cookie");
  expect(hits).toEqual({ lookup: 1, create: 1 });
  expect(ms).toBeLessThan(DEADLINE);
});

it("accounts:lookup HANGS → 503 at ~10 s (not ~132 s), no Set-Cookie, createSessionCookie never reached", async () => {
  mockState.lookup = "hang";
  const { value: res, ms } = await timed(() => post("hang-user"));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "Authentication service unavailable" });
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(ms).toBeGreaterThanOrEqual(DEADLINE - 50);
  expect(ms).toBeLessThan(DEADLINE + SLACK);
  expect(hits.lookup).toBe(1); // the SDK really was waiting on the hung lookup
  expect(hits.create).toBe(0);
  process.stdout.write(`\nBENCH session-mint lookup-hang: ${ms}ms openSockets=${sockets.size}\n`);
}, 30_000);

it("accounts:lookup answers VALID 12 s late → 503 at the deadline; the late valid verification NEVER reaches createSessionCookie", async () => {
  mockState.lookup = "late-valid";
  const before = sdkCalls.length;
  const { value: res, ms } = await timed(() => post("late-user"));
  expect(res.status).toBe(503);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(ms).toBeLessThan(DEADLINE + SLACK);
  await new Promise((r) => setTimeout(r, 12_000 - ms + 500));
  // the abandoned SDK verification really completed VALID …
  await expect(sdkCalls[before]).resolves.toMatchObject({ uid: "late-user" });
  // … and no session cookie was ever requested from upstream.
  expect(hits.create).toBe(0);
  expect(sdkCalls).toHaveLength(before + 1);
}, 40_000);

it(":createSessionCookie HANGS after a fast verification → 503 at ~10 s end-to-end, no Set-Cookie", async () => {
  mockState.create = "hang";
  const { value: res, ms } = await timed(() => post("create-hang-user"));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "Authentication service unavailable" });
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(hits).toEqual({ lookup: 1, create: 1 });
  expect(ms).toBeGreaterThanOrEqual(DEADLINE - 50);
  expect(ms).toBeLessThan(DEADLINE + SLACK);
}, 30_000);
