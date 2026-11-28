/**
 * ZCA P3 R2 L-3 — THE STRUCTURAL PROOF of "the cookie grants nothing and vetoes nothing": a behavioural
 * differential over EVERY (route, method) in ROUTE_MANIFEST, run with the REAL `resolveRequestIdentity`, the
 * REAL privileged guard and every real wrapper (getRequestUid, reportReviewCaller, resolveGovernanceRequestUser),
 * with ONLY firebase-admin faked at its network edge (routeHarness.ts; Stripe and global fetch refuse, Firestore
 * is an empty recording fake, exactly as in the L-1 oracle).
 *
 * Arms: bearer ∈ {absent, valid-A, valid-B, invalid, expired, revoked, disabled, malformed}
 *     × cookie ∈ {absent, valid-A, valid-B, invalid, empty, garbage}.
 * For each bearer arm, every cookie arm must be indistinguishable from the cookie-ABSENT arm: the same status, the
 * same body (hence the same reason), the same Set-Cookie, the same live Auth reads (count AND uid), the same
 * ID-token verification count, the same data-layer touches and external calls — and the session-cookie verifier is
 * never called. The bearer-absent row is the cookie-only case, so it also proves "cookie-only == anonymous".
 *
 * Non-vacuity (per route): the valid-A bearer reaches the identity layer (an ID-token verification AND a live read
 * of account A); and across the bearer arms the route's observations are not all identical.
 *
 * `differentialStatic.spec.ts` proves the shards partition the manifest and that no differential spec mocks the
 * resolver, a wrapper or the guard.
 */
import { ROUTE_MANIFEST, type HttpMethod, type RouteEntry } from "./routeManifest";
import {
  A_UID,
  B_UID,
  BAD_SIGNATURE,
  DISABLED_UID,
  ID_TOKEN_ISSUER,
  REVOKED_UID,
  SESSION_COOKIE_ISSUER,
  buildDifferentialRequest,
  installNetworkKillSwitch,
  jwt,
  observe,
  type Observation,
} from "./routeHarness";
import { routeParams, routeUrl, keyOf } from "./cookieOnlyOracle";

const NOW = Math.floor(Date.now() / 1000);
/** Far-future expiry: the differential advances the clock between requests (see resetClockAndRandom). */
const LONG = { exp: NOW + 20 * 365 * 24 * 3600 };

export const BEARER_ARMS: Readonly<Record<string, string | null>> = Object.freeze({
  absent: null,
  validA: `Bearer ${jwt(A_UID, ID_TOKEN_ISSUER, LONG)}`,
  validB: `Bearer ${jwt(B_UID, ID_TOKEN_ISSUER, LONG)}`,
  invalid: `Bearer ${jwt(A_UID, ID_TOKEN_ISSUER, LONG, BAD_SIGNATURE)}`,
  expired: `Bearer ${jwt(A_UID, ID_TOKEN_ISSUER, { iat: NOW - 7200, exp: NOW - 3600 })}`,
  revoked: `Bearer ${jwt(REVOKED_UID, ID_TOKEN_ISSUER, LONG)}`,
  disabled: `Bearer ${jwt(DISABLED_UID, ID_TOKEN_ISSUER, LONG)}`,
  malformed: "Basic emNhOmhhcm5lc3M=",
});

export const COOKIE_ARMS: Readonly<Record<string, string | null>> = Object.freeze({
  absent: null,
  validA: `__session=${jwt(A_UID, SESSION_COOKIE_ISSUER, LONG)}`,
  validB: `__session=${jwt(B_UID, SESSION_COOKIE_ISSUER, LONG)}`,
  invalid: `__session=${jwt(A_UID, SESSION_COOKIE_ISSUER, LONG, BAD_SIGNATURE)}`,
  empty: "__session=",
  garbage: "__session=%%not-a-jwt%%; __session=x.y; other=1",
});

/** Inputs a route validates BEFORE identity (same as the L-1 oracle). */
const QUERY_OVERRIDES: Record<string, string> = {
  "GET app/api/synthesize-panel/route.ts": "runId=zca-runId&mode=cache",
};
/** Classes that resolve no user identity: the non-vacuity control does not apply to them. */
const NO_IDENTITY_CLASSES = new Set(["signature", "telemetry-proxy"]);
/** The session DELETE resolves no identity (an idempotent expiry). The POST handshake verifies the bearer. */
const NO_BEARER_IDENTITY = new Set(["DELETE app/api/auth/session/route.ts"]);

export const DIFFERENTIAL_SHARDS = 8;

export function differentialShard(index: number, count: number): Array<{ entry: RouteEntry; method: HttpMethod }> {
  const all = ROUTE_MANIFEST.flatMap((entry) => entry.methods.map((method) => ({ entry, method })));
  return all.filter((_v, i) => i % count === index);
}

type Grid = Record<string, Record<string, Observation>>;

/**
 * Determinism, not a fake of anything identity-related. Before EVERY request:
 *  - `Math.random` restarts from the same seeded stream, so code that branches on randomness (e.g. the rate
 *    limiter's 1 % opportunistic cleanup) behaves identically in a cookie arm and in its cookie-absent arm;
 *  - `Date.now` jumps 10 minutes forward, past every per-instance TTL cache in the request path (e.g. the 2-minute
 *    governance visibility cache), so every arm — cookie-absent or not — starts from the same COLD state instead of
 *    the previous arm's warm one. (Tokens expire in 20 years; the expired arm is expired in any case.)
 */
const realDateNow = Date.now.bind(Date);
let clockOffsetMs = 0;
function resetClockAndRandom(): void {
  clockOffsetMs += 600_000;
  let state = 0x2f6b4a1d;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The fields compared between a cookie arm and the cookie-absent arm (everything observable). */
function comparable(o: Observation) {
  return { status: o.status, body: o.body, setCookie: o.setCookie, liveReads: o.liveReads, idTokenVerifies: o.idTokenVerifies, touches: o.touches, externalCalls: o.externalCalls };
}

export function defineDifferential(index: number, count: number): void {
  installNetworkKillSwitch();
  const realRandom = Math.random;
  Date.now = () => realDateNow() + clockOffsetMs;
  afterAll(() => {
    Math.random = realRandom;
    Date.now = realDateNow;
  });
  const cases = differentialShard(index, count);
  const results = new Map<string, Grid>();

  beforeAll(async () => {
    for (const { entry, method } of cases) {
      const key = keyOf(method, entry.path);
      let handler: (req: unknown, ctx: unknown) => Promise<Response>;
      try {
        const mod = require(`@/${entry.path.replace(/\.tsx?$/, "")}`) as Record<string, (req: unknown, ctx: unknown) => Promise<Response>>;
        handler = mod[method];
        if (typeof handler !== "function") throw new Error(`no exported ${method}`);
      } catch (e) {
        const failed: Observation = { status: -3, body: `load failed: ${(e as Error)?.message?.split("\n")[0]}`, setCookie: null, touches: [], cookieVerifies: 0, idTokenVerifies: 0, liveReads: [], externalCalls: [] };
        const grid: Grid = {};
        for (const b of Object.keys(BEARER_ARMS)) grid[b] = Object.fromEntries(Object.keys(COOKIE_ARMS).map((c) => [c, failed]));
        results.set(key, grid);
        continue;
      }
      const query = QUERY_OVERRIDES[key];
      const url = query ? `${routeUrl(entry.path)}?${query}` : routeUrl(entry.path);
      const ctx = { params: routeParams(entry.path) };
      const grid: Grid = {};
      // Sequential and in a fixed order: the harness recorders are module-global.
      for (const [b, authorization] of Object.entries(BEARER_ARMS)) {
        grid[b] = {};
        for (const [c, cookie] of Object.entries(COOKIE_ARMS)) {
          resetClockAndRandom();
          grid[b][c] = await observe(() => handler(buildDifferentialRequest(url, method, authorization, cookie), ctx));
        }
      }
      results.set(key, grid);
    }
    if (process.env.ZCA_DIFFERENTIAL_OUT) {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync(`${process.env.ZCA_DIFFERENTIAL_OUT}.${index}.json`, JSON.stringify(Object.fromEntries(results), null, 1));
    }
  }, 1_800_000);

  test("the resolver, its wrappers and the privileged guard in this shard are the REAL modules (not mocks)", () => {
    for (const m of ["@/lib/auth/resolveRequestIdentity", "@/lib/admin/privilegedAccess", "@/lib/teams/teamApiAuth", "@/lib/governance/authCheck"]) {
      const loaded = require(m) as Record<string, unknown>;
      const actual = jest.requireActual(m) as Record<string, unknown>;
      for (const k of Object.keys(actual)) expect({ m, k, same: loaded[k] === actual[k] }).toEqual({ m, k, same: true });
      expect(jest.isMockFunction(loaded.resolveRequestIdentity ?? loaded.requirePrivilegedAccess ?? loaded.getRequestUid ?? loaded.resolveGovernanceRequestUser)).toBe(false);
    }
  });

  for (const { entry, method } of cases) {
    const key = keyOf(method, entry.path);
    const identityRoute = !NO_IDENTITY_CLASSES.has(entry.cls) && !NO_BEARER_IDENTITY.has(key);

    test(`${key}: every bearer arm × every cookie arm is decided EXACTLY as without the cookie; the cookie verifier is never called`, () => {
      const grid = results.get(key)!;
      for (const b of Object.keys(BEARER_ARMS)) {
        const base = grid[b].absent;
        expect({ key, bearer: b, handlerRan: base.status > 0 }).toEqual({ key, bearer: b, handlerRan: true });
        for (const c of Object.keys(COOKIE_ARMS)) {
          const o = grid[b][c];
          expect({ bearer: b, cookie: c, cookieVerifies: o.cookieVerifies, ...comparable(o) }).toEqual({ bearer: b, cookie: c, cookieVerifies: 0, ...comparable(base) });
        }
      }
    });

    if (identityRoute) {
      test(`${key}: NON-VACUITY — the valid-A bearer reaches the identity layer (one ID-token verification, a live read of A), and the bearer arms are not all alike`, () => {
        const grid = results.get(key)!;
        expect(grid.validA.absent.idTokenVerifies).toBeGreaterThan(0);
        expect(grid.validA.absent.liveReads).toContain(A_UID);
        const distinct = new Set(Object.keys(BEARER_ARMS).map((b) => JSON.stringify(comparable(grid[b].absent))));
        expect(distinct.size).toBeGreaterThan(1);
      });
    }
  }
}
