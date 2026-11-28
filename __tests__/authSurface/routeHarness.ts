/**
 * ZCA L-1 — shared harness for the closed-world cookie-only authorization oracle.
 *
 * Every protected route handler is invoked three times with otherwise IDENTICAL input:
 *   1. no credential at all;
 *   2. ONLY a valid session cookie for account A (no Authorization header);
 *   3. ONLY a valid bearer for account A (the sensitivity control).
 *
 * Zero cookie authority means (2) is indistinguishable from (1): same status, same body,
 * the same data-layer touches, and the session-cookie verifier is never consulted.
 * (3) must consult the ID-token verifier — otherwise the chosen input never reaches the
 * route's identity layer and the comparison of (1) and (2) would be vacuous.
 *
 * Network edges only are stubbed: the firebase-admin BaseAuth prototype is REAL (so the
 * real `verifyIdToken` code path, including checkRevoked, runs — and so would the SDK's
 * session-cookie path, if anything called it); the JWT verifiers decode the synthetic token's
 * payload, reject a token whose signature segment is `bad-signature` with the SDK's own
 * fixed text, reject an expired token with `auth/id-token-expired`, and count their calls;
 * `getUser` serves every account as a valid, enabled, verified user EXCEPT the revoked account
 * (its `tokensValidAfterTime` postdates the token's `auth_time`) and the disabled account, and
 * records the uid of every live read. Firestore is a recording fake with NO data. Stripe and
 * global fetch refuse, so no route can reach an external service.
 *
 * ZCA P3 R2: the same harness drives the behavioural differential (differentialOracle.ts).
 */
import { NextRequest } from "next/server";

export const harness = {
  touches: [] as string[],
  cookieVerifies: 0,
  idTokenVerifies: 0,
  getUserCalls: 0,
  /** The uid of every live Auth read, in order (R2 L-3: "uid used and live-read count"). */
  liveReads: [] as string[],
  externalCalls: [] as string[],
};

export function resetHarness(): void {
  harness.touches.length = 0;
  harness.cookieVerifies = 0;
  harness.idTokenVerifies = 0;
  harness.getUserCalls = 0;
  harness.liveReads.length = 0;
  harness.externalCalls.length = 0;
}

const NOW = Math.floor(Date.now() / 1000);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const BAD_SIGNATURE = "bad-signature";
export function jwt(sub: string, iss: string, over: Record<string, unknown> = {}, sig = "sig"): string {
  return [
    b64({ alg: "RS256", kid: "k1", typ: "JWT" }),
    b64({ sub, aud: "test-proj", iss, iat: NOW - 60, exp: NOW + 3000, auth_time: NOW - 600, email: `${sub}@example.test`, email_verified: true, ...over }),
    sig,
  ].join(".");
}
export const ID_TOKEN_ISSUER = "https://securetoken.google.com/test-proj";
export const SESSION_COOKIE_ISSUER = "https://session.firebase.google.com/test-proj";
export const A_UID = "zca-account-a";
export const B_UID = "zca-account-b";
/** getUser reports tokensValidAfterTime AFTER every token's auth_time for this account. */
export const REVOKED_UID = "zca-account-revoked";
/** getUser reports disabled: true for this account. */
export const DISABLED_UID = "zca-account-disabled";
export const A_COOKIE = jwt(A_UID, SESSION_COOKIE_ISSUER);
export const A_BEARER = jwt(A_UID, ID_TOKEN_ISSUER);

/** Factory for `jest.mock("@/lib/firebase/admin", ...)`. */
export function firebaseAdminMock(): Record<string, unknown> {
  const proto = Object.getPrototypeOf(require("firebase-admin/auth").Auth.prototype);
  const auth = Object.create(proto);
  const decode = (t: string, jwtName: string) => {
    const parts = String(t).split(".");
    if (!parts[1]) throw Object.assign(new Error(`Decoding ${jwtName} failed.`), { code: "auth/argument-error" });
    if (parts[2] === BAD_SIGNATURE) {
      throw Object.assign(new Error(`${jwtName} has invalid signature. See the documentation for details.`), { code: "auth/argument-error" });
    }
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof p.exp === "number" && p.exp <= Math.floor(Date.now() / 1000)) {
      throw Object.assign(new Error(`${jwtName} has expired.`), { code: "auth/id-token-expired" });
    }
    return { ...p, uid: p.sub };
  };
  auth.idTokenVerifier = { verifyJWT: async (t: string) => { harness.idTokenVerifies += 1; return decode(t, "Firebase ID token"); } };
  auth.sessionCookieVerifier = { verifyJWT: async (t: string) => { harness.cookieVerifies += 1; return decode(t, "Firebase session cookie"); } };
  auth.getUser = async (uid: string) => {
    harness.getUserCalls += 1;
    harness.liveReads.push(uid);
    const validAfter = uid === REVOKED_UID ? NOW - 60 : NOW - 3600;
    return { uid, disabled: uid === DISABLED_UID, email: `${uid}@example.test`, emailVerified: true, customClaims: {}, tokensValidAfterTime: new Date(validAfter * 1000).toUTCString(), metadata: {}, providerData: [] };
  };
  const emptySnap = (path: string) => ({ exists: false, id: path.split("/").pop(), ref: docRef(path), data: () => undefined, get: () => undefined, createTime: undefined, updateTime: undefined });
  const emptyQuery = () => ({ empty: true, size: 0, docs: [] as unknown[], forEach: () => undefined, docChanges: () => [] });
  function docRef(path: string): Record<string, unknown> {
    return {
      path,
      id: path.split("/").pop(),
      parent: { path: path.split("/").slice(0, -1).join("/") },
      get: async () => (harness.touches.push(`get ${path}`), emptySnap(path)),
      collection: (n: string) => colRef(`${path}/${n}`),
      listCollections: async () => (harness.touches.push(`listCollections ${path}`), []),
      set: async () => { harness.touches.push(`set ${path}`); },
      update: async () => { harness.touches.push(`update ${path}`); },
      create: async () => { harness.touches.push(`create ${path}`); },
      delete: async () => { harness.touches.push(`delete ${path}`); },
    };
  }
  function colRef(path: string): Record<string, unknown> {
    const q: Record<string, unknown> = {
      path,
      id: path.split("/").pop(),
      doc: (id?: string) => docRef(`${path}/${id ?? "auto-id"}`),
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      limitToLast: () => q,
      offset: () => q,
      select: () => q,
      startAfter: () => q,
      startAt: () => q,
      endBefore: () => q,
      endAt: () => q,
      count: () => ({ get: async () => (harness.touches.push(`count ${path}`), { data: () => ({ count: 0 }) }) }),
      get: async () => (harness.touches.push(`query ${path}`), emptyQuery()),
      add: async () => (harness.touches.push(`add ${path}`), docRef(`${path}/auto-id`)),
      listDocuments: async () => (harness.touches.push(`listDocuments ${path}`), []),
    };
    return q;
  }
  const tx: Record<string, unknown> = {
    get: async (r: { path?: string; get?: () => Promise<unknown> }) =>
      typeof r.path === "string" && !("where" in r) ? (harness.touches.push(`tx-get ${r.path}`), emptySnap(r.path)) : (r as { get: () => Promise<unknown> }).get(),
    getAll: async (...refs: Array<{ path: string }>) => refs.map((r) => (harness.touches.push(`tx-get ${r.path}`), emptySnap(r.path))),
    set: (r: { path: string }) => (harness.touches.push(`tx-set ${r.path}`), tx),
    update: (r: { path: string }) => (harness.touches.push(`tx-update ${r.path}`), tx),
    create: (r: { path: string }) => (harness.touches.push(`tx-create ${r.path}`), tx),
    delete: (r: { path: string }) => (harness.touches.push(`tx-delete ${r.path}`), tx),
  };
  const db = {
    collection: (p: string) => (harness.touches.push(`collection ${p}`), colRef(p)),
    collectionGroup: (p: string) => (harness.touches.push(`collectionGroup ${p}`), colRef(p)),
    doc: (p: string) => (harness.touches.push(`doc ${p}`), docRef(p)),
    getAll: async (...refs: Array<{ path: string }>) => (harness.touches.push("getAll"), refs.map((r) => emptySnap(r.path))),
    runTransaction: async (fn: (t: unknown) => unknown) => (harness.touches.push("runTransaction"), fn(tx)),
    batch: () => (harness.touches.push("batch"), { set() {}, update() {}, delete() {}, create() {}, commit: async () => { harness.touches.push("batch-commit"); } }),
    bulkWriter: () => { harness.touches.push("bulkWriter"); throw new Error("bulkWriter not available in harness"); },
    recursiveDelete: async () => { harness.touches.push("recursiveDelete"); },
  };
  const realAdmin = require("firebase-admin");
  return { adminAuth: auth, adminDb: db, admin: realAdmin, firebaseAdmin: realAdmin, FIREBASE_PROJECT_ID: "test-proj", getInitializedFirebaseProjectId: () => "test-proj", default: {} };
}

/** Factory for `jest.mock("@/lib/stripe/client", ...)`: every Stripe call is recorded and refused. */
export function stripeClientMock(): Record<string, unknown> {
  const refuse = (path: string): unknown =>
    new Proxy(function () { /* callable */ }, {
      get: (_t, k) => (k === "then" ? undefined : refuse(`${path}.${String(k)}`)),
      apply: () => { harness.externalCalls.push(`stripe ${path}`); return Promise.reject(new Error("stripe refused in harness")); },
    });
  return { stripe: refuse("stripe"), getStripe: () => refuse("stripe"), default: refuse("stripe") };
}

/** Global fetch refuses: no route may reach any network service during the oracle. */
export function installNetworkKillSwitch(): void {
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => {
    harness.externalCalls.push(`fetch ${typeof input === "string" ? input.split("?")[0] : "request"}`);
    throw new TypeError("network refused in harness");
  };
}

export type Credential = "none" | "cookieA" | "bearerA";

export function buildRequest(url: string, method: string, credential: Credential, body?: unknown): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "zca-harness", origin: "http://localhost:3000" };
  if (credential === "cookieA") headers.cookie = `__session=${A_COOKIE}`;
  if (credential === "bearerA") headers.authorization = `Bearer ${A_BEARER}`;
  const hasBody = !["GET", "HEAD", "DELETE"].includes(method);
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
}

export type Observation = { status: number; body: string; setCookie: string | null; touches: string[]; cookieVerifies: number; idTokenVerifies: number; liveReads: string[]; externalCalls: string[] };

/** Bounded: a handler that never settles is reported, not waited on forever. */
export async function observe(call: () => Promise<Response>): Promise<Observation> {
  resetHarness();
  let res: Response | "timeout";
  try {
    res = await Promise.race([
      call(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000)),
    ]);
  } catch (e) {
    return { status: -1, body: `threw ${(e as Error)?.name}: ${(e as Error)?.message}`, setCookie: null, touches: [...harness.touches], cookieVerifies: harness.cookieVerifies, idTokenVerifies: harness.idTokenVerifies, liveReads: [...harness.liveReads], externalCalls: [...harness.externalCalls] };
  }
  if (res === "timeout") {
    return { status: -2, body: "timeout", setCookie: null, touches: [...harness.touches], cookieVerifies: harness.cookieVerifies, idTokenVerifies: harness.idTokenVerifies, liveReads: [...harness.liveReads], externalCalls: [...harness.externalCalls] };
  }
  const body = await res.text().catch(() => "<unreadable>");
  return {
    status: res.status,
    // Request ids / timestamps would make identical outcomes differ; normalise them.
    body: body.replace(/"(requestId|timestamp|ts|at|now)":"[^"]*"/g, '"$1":"<n>"'),
    setCookie: res.headers.get("set-cookie"),
    touches: [...harness.touches],
    cookieVerifies: harness.cookieVerifies,
    idTokenVerifies: harness.idTokenVerifies,
    liveReads: [...harness.liveReads],
    externalCalls: [...harness.externalCalls],
  };
}

/** R2 L-3: a request with an independently chosen raw Authorization value and raw Cookie header. */
export function buildDifferentialRequest(url: string, method: string, authorization: string | null, cookie: string | null, body?: unknown): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "zca-harness", origin: "http://localhost:3000" };
  if (authorization !== null) headers.authorization = authorization;
  if (cookie !== null) headers.cookie = cookie;
  const hasBody = !["GET", "HEAD", "DELETE"].includes(method);
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
}
