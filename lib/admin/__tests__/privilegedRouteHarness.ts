/**
 * SEC-3 / S2-b — SHARED TEST HARNESS for specs that drive REAL privileged
 * route handlers through the REAL privileged-access guard.
 *
 * Doubles live ONLY at the Firebase Admin SDK boundary:
 *
 *   - `adminAuth` (`verifyIdToken`, `verifySessionCookie`, `getUser`, and the
 *     account/claim mutations the handlers perform), backed by `authState`;
 *   - `adminDb`, an in-memory Firestore that RECORDS EVERY CALL made through
 *     it (`dbLog`), so a spec can assert that a refused request touched no
 *     protected data at all — not even a read.
 *
 * Credentials are real compact JWS strings addressed to `PROJECT_ID`, so they
 * pass the guard's structural pre-validation (`privilegedCredentialAdapter`:
 * RS256, kid, sub, aud, iss, exp). The signature segment is arbitrary bytes;
 * "verification" is the double's lookup of the exact string, and an
 * unregistered well-formed credential is rejected with the SDK's own
 * `auth/argument-error` "has invalid signature." text, as the real SDK rejects
 * a token Google did not sign.
 *
 * Usage in a spec (jest.mock factories may only reach this module via require):
 *
 *   jest.mock("@/lib/firebase/admin", () =>
 *     require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble());
 */

import { AuthClientErrorCode, FirebaseAuthError } from "firebase-admin/auth";
import { NextRequest } from "next/server";

/** The SDK marks the real `(info, message)` constructor `@internal`. */
const SdkAuthError = FirebaseAuthError as unknown as new (info: { code: string; message: string }, message?: string) => FirebaseAuthError;

export const PROJECT_ID = "test-project-invented";
export const NOW_SECONDS = Math.floor(Date.now() / 1000);
export const AUTH_TIME = NOW_SECONDS - 600;

export const EMAILS = Object.freeze({
  portal: "portal-only@test-invented.example",
  governance: "governance-only@test-invented.example",
  outsider: "outsider@test-invented.example",
  system: "system-admin@test-invented.example",
});

export type Persona = "system" | "portal" | "governance" | "ordinary" | "systemPlusGovernance";

export const UIDS: Readonly<Record<Persona, string>> = Object.freeze({
  system: "uid-system-admin",
  portal: "uid-portal-only",
  governance: "uid-governance-only",
  ordinary: "uid-ordinary",
  systemPlusGovernance: "uid-system-plus-governance",
});

type Kind = "bearer" | "cookie";
const ISSUER: Record<Kind, string> = { bearer: "https://securetoken.google.com/", cookie: "https://session.firebase.google.com/" };
const JWT_NAME: Record<Kind, string> = { bearer: "Firebase ID token", cookie: "Firebase session cookie" };
const SDK_DOCS: Record<Kind, string> = {
  bearer: " See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.",
  cookie: " See https://firebase.google.com/docs/auth/admin/manage-cookies for details on how to retrieve a session cookie.",
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
let mintCounter = 0;

/** A structurally valid compact JWS for `sub`. Each call yields distinct bytes. */
export function mintCredential(kind: Kind, sub: string, over: Record<string, unknown> = {}): string {
  mintCounter += 1;
  const header = { alg: "RS256", kid: "test-kid", typ: "JWT" };
  const payload = { aud: PROJECT_ID, iss: ISSUER[kind] + PROJECT_ID, sub, iat: NOW_SECONDS - 60, exp: NOW_SECONDS + 3600, auth_time: AUTH_TIME, ...over };
  return `${b64(header)}.${b64(payload)}.${Buffer.from(`sig-${mintCounter}`).toString("base64url")}`;
}

type Decoded = Record<string, unknown>;
type AuthRecord = Record<string, unknown>;

export const authState: {
  /** `adminAuth` is exported as null when false (Admin SDK uninitialised). */
  available: boolean;
  projectId: string | undefined;
  tokens: Map<string, Decoded | Error>;
  cookies: Map<string, Decoded | Error>;
  records: Map<string, AuthRecord | Error>;
} = { available: true, projectId: PROJECT_ID, tokens: new Map(), cookies: new Map(), records: new Map() };

function invalidSignature(kind: Kind): Error {
  return new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, `${JWT_NAME[kind]} has invalid signature.${SDK_DOCS[kind]}`);
}

export const authCalls = {
  verifyIdToken: jest.fn(async (token: string, _checkRevoked?: boolean) => {
    const v = authState.tokens.get(token);
    if (v === undefined) throw invalidSignature("bearer");
    if (v instanceof Error) throw v;
    return v;
  }),
  verifySessionCookie: jest.fn(async (cookie: string, _checkRevoked?: boolean) => {
    const v = authState.cookies.get(cookie);
    if (v === undefined) throw invalidSignature("cookie");
    if (v instanceof Error) throw v;
    return v;
  }),
  getUser: jest.fn(async (uid: string) => {
    const v = authState.records.get(uid);
    if (v === undefined) throw Object.assign(new Error("There is no user record corresponding to the provided identifier."), { code: "auth/user-not-found" });
    if (v instanceof Error) throw v;
    return v;
  }),
  setCustomUserClaims: jest.fn(async (_uid: string, _claims: unknown) => undefined),
  updateUser: jest.fn(async (uid: string, _patch: unknown) => ({ uid })),
  deleteUser: jest.fn(async (_uid: string) => undefined),
};

export const authDouble = {
  verifyIdToken: (t: string, c?: boolean) => authCalls.verifyIdToken(t, c),
  verifySessionCookie: (t: string, c?: boolean) => authCalls.verifySessionCookie(t, c),
  getUser: (u: string) => authCalls.getUser(u),
  setCustomUserClaims: (u: string, c: unknown) => authCalls.setCustomUserClaims(u, c),
  updateUser: (u: string, p: unknown) => authCalls.updateUser(u, p),
  deleteUser: (u: string) => authCalls.deleteUser(u),
};

/* ------------------------------------------------------------------------- *
 * In-memory Firestore that records every call.
 * ------------------------------------------------------------------------- */

export type DbOp = { op: string; path: string };
export const dbLog: DbOp[] = [];
export const dbStore = new Map<string, Record<string, unknown>>();
let autoId = 0;

const WRITE_OPS = new Set(["set", "update", "delete", "create", "add", "batch.commit"]);
export const dbWrites = () => dbLog.filter((e) => WRITE_OPS.has(e.op));

type Filter = { field: string; op: string; value: unknown };

function docSnapshot(path: string) {
  const data = dbStore.get(path);
  const id = path.split("/").pop() as string;
  return {
    id,
    exists: data !== undefined,
    ref: docRef(path),
    data: () => (data === undefined ? undefined : { ...data }),
    get: (f: string) => data?.[f],
  };
}

function matches(data: Record<string, unknown>, f: Filter): boolean {
  const v = data[f.field];
  switch (f.op) {
    case "==":
      return v === f.value;
    case "in":
      return Array.isArray(f.value) && f.value.includes(v);
    case "array-contains":
      return Array.isArray(v) && v.includes(f.value);
    default:
      // Range filters are not modelled; fixtures are chosen so they need not be.
      return true;
  }
}

function queryRef(collectionPath: string, filters: Filter[] = [], max = Infinity): Record<string, unknown> {
  const run = () => {
    const prefix = collectionPath + "/";
    const docs = [...dbStore.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .filter((k) => filters.every((f) => matches(dbStore.get(k) as Record<string, unknown>, f)))
      .slice(0, max)
      .map((k) => docSnapshot(k));
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (cb: (d: unknown) => void) => docs.forEach(cb) };
  };
  return {
    where: (field: string, op: string, value: unknown) => queryRef(collectionPath, [...filters, { field, op, value }], max),
    orderBy: () => queryRef(collectionPath, filters, max),
    limit: (n: number) => queryRef(collectionPath, filters, Math.min(max, n)),
    startAfter: () => queryRef(collectionPath, filters, 0),
    select: () => queryRef(collectionPath, filters, max),
    count: () => ({ get: async () => ({ data: () => ({ count: run().size }) }) }),
    get: async () => {
      dbLog.push({ op: "query.get", path: collectionPath });
      return run();
    },
    __isQuery: true,
  };
}

function docRef(path: string): Record<string, unknown> {
  const id = path.split("/").pop() as string;
  const ref: Record<string, unknown> = {
    id,
    path,
    get: async () => {
      dbLog.push({ op: "get", path });
      return docSnapshot(path);
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      dbLog.push({ op: "set", path });
      dbStore.set(path, opts?.merge ? { ...(dbStore.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: Record<string, unknown>) => {
      dbLog.push({ op: "update", path });
      if (!dbStore.has(path)) throw Object.assign(new Error("NOT_FOUND"), { code: 5 });
      dbStore.set(path, { ...(dbStore.get(path) as Record<string, unknown>), ...data });
    },
    create: async (data: Record<string, unknown>) => {
      dbLog.push({ op: "create", path });
      if (dbStore.has(path)) throw Object.assign(new Error("ALREADY_EXISTS"), { code: 6 });
      dbStore.set(path, { ...data });
    },
    delete: async () => {
      dbLog.push({ op: "delete", path });
      dbStore.delete(path);
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
  return ref;
}

function collectionRef(path: string): Record<string, unknown> {
  return {
    ...queryRef(path),
    id: path.split("/").pop(),
    path,
    doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++autoId}`}`),
    add: async (data: Record<string, unknown>) => {
      const p = `${path}/auto-${++autoId}`;
      dbLog.push({ op: "add", path: p });
      dbStore.set(p, { ...data });
      return docRef(p);
    },
  };
}

type AnyRef = { path: string; get: () => Promise<unknown> } & Record<string, unknown>;

export const dbDouble = {
  collection: (name: string) => {
    dbLog.push({ op: "collection", path: name });
    return collectionRef(name);
  },
  doc: (path: string) => docRef(path),
  batch: () => {
    const pending: Array<() => Promise<unknown>> = [];
    return {
      set: (ref: AnyRef, d: unknown, o?: unknown) => void pending.push(() => (ref.set as (a: unknown, b?: unknown) => Promise<unknown>)(d, o)),
      update: (ref: AnyRef, d: unknown) => void pending.push(() => (ref.update as (a: unknown) => Promise<unknown>)(d)),
      delete: (ref: AnyRef) => void pending.push(() => (ref.delete as () => Promise<unknown>)()),
      commit: async () => {
        dbLog.push({ op: "batch.commit", path: "" });
        for (const w of pending) await w();
      },
    };
  },
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    dbLog.push({ op: "runTransaction", path: "" });
    const pending: Array<() => Promise<unknown>> = [];
    const tx = {
      get: (ref: AnyRef) => ref.get(),
      set: (ref: AnyRef, d: unknown, o?: unknown) => (pending.push(() => (ref.set as (a: unknown, b?: unknown) => Promise<unknown>)(d, o)), tx),
      update: (ref: AnyRef, d: unknown) => (pending.push(() => (ref.update as (a: unknown) => Promise<unknown>)(d)), tx),
      create: (ref: AnyRef, d: unknown) => (pending.push(() => (ref.create as (a: unknown) => Promise<unknown>)(d)), tx),
      delete: (ref: AnyRef) => (pending.push(() => (ref.delete as () => Promise<unknown>)()), tx),
    };
    const result = await fn(tx);
    for (const w of pending) await w();
    return result;
  },
  getAll: async (...refs: AnyRef[]) => Promise.all(refs.map((r) => r.get())),
};

/** The `@/lib/firebase/admin` module, as seen by the code under test. */
export function firebaseAdminModuleDouble(): Record<string, unknown> {
  const actualFirestore = require("firebase-admin/firestore");
  return {
    get adminAuth() {
      return authState.available ? authDouble : null;
    },
    get adminDb() {
      return dbDouble;
    },
    getInitializedFirebaseProjectId: () => authState.projectId,
    FIREBASE_PROJECT_ID: PROJECT_ID,
    firebaseAdmin: {
      firestore: { Timestamp: actualFirestore.Timestamp, FieldValue: actualFirestore.FieldValue },
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Personas and requests.
 * ------------------------------------------------------------------------- */

export type SignedIn = { uid: string; bearer: string; cookie: string };

/** The live Auth record for a persona (override any field). */
export function liveRecord(persona: Persona, over: AuthRecord = {}): AuthRecord {
  const uid = UIDS[persona];
  const email =
    persona === "portal"
      ? EMAILS.portal
      : persona === "governance" || persona === "systemPlusGovernance"
        ? EMAILS.governance
        : persona === "system"
          ? EMAILS.system
          : EMAILS.outsider;
  const claimAdmin = persona === "system" || persona === "systemPlusGovernance";
  return {
    uid,
    email,
    emailVerified: true,
    disabled: false,
    customClaims: claimAdmin ? { admin: true } : {},
    tokensValidAfterTime: undefined,
    ...over,
  };
}

/**
 * Registers a bearer token, a session cookie and a live record for the
 * persona. `tokenClaimAdmin` sets what the PRESENTED credential claims (the
 * guard records it for telemetry only and never decides on it).
 */
export function signInAs(persona: Persona, opts: { record?: AuthRecord; tokenClaimAdmin?: boolean } = {}): SignedIn {
  const uid = UIDS[persona];
  const claim = opts.tokenClaimAdmin ?? (persona === "system" || persona === "systemPlusGovernance");
  const bearer = mintCredential("bearer", uid);
  const cookie = mintCredential("cookie", uid);
  const decoded = { uid, sub: uid, auth_time: AUTH_TIME, ...(claim ? { admin: true } : {}) };
  authState.tokens.set(bearer, decoded);
  authState.cookies.set(cookie, decoded);
  authState.records.set(uid, liveRecord(persona, opts.record));
  return { uid, bearer, cookie };
}

export type Credentials = { bearer?: string; cookie?: string; authorization?: string };

export function routeRequest(url: string, init: { method?: string; body?: unknown; creds?: Credentials } = {}): NextRequest {
  const headers: Record<string, string> = {};
  const creds = init.creds ?? {};
  if (creds.authorization !== undefined) headers.authorization = creds.authorization;
  else if (creds.bearer !== undefined) headers.authorization = `Bearer ${creds.bearer}`;
  if (creds.cookie !== undefined) headers.cookie = `__session=${creds.cookie}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(new URL(url, "http://localhost"), {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  });
}

const ENV_KEYS = ["ADMIN_EMAILS", "GOVERNANCE_ADMIN_EMAILS"] as const;
const envSnapshot: Record<string, string | undefined> = {};

/** Call once per spec file (top level). Restores the env afterwards. */
export function installPrivilegedHarness(): void {
  beforeAll(() => {
    for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
  });
  beforeEach(() => resetPrivilegedHarness());
}

export function resetPrivilegedHarness(): void {
  process.env.ADMIN_EMAILS = EMAILS.portal;
  process.env.GOVERNANCE_ADMIN_EMAILS = EMAILS.governance;
  authState.available = true;
  authState.projectId = PROJECT_ID;
  authState.tokens.clear();
  authState.cookies.clear();
  authState.records.clear();
  for (const fn of Object.values(authCalls)) fn.mockClear();
  dbLog.length = 0;
  dbStore.clear();
}
