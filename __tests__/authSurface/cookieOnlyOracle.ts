/**
 * ZCA L-1 — the behavioural half of the closed-world oracle (see routeHarness.ts for the method).
 * Each shard spec calls `defineCookieOnlyOracle(shardIndex, shardCount)`; together the shards
 * cover EVERY (route, method) in ROUTE_MANIFEST — `authSurfaceStatic.spec.ts` proves the
 * shard partition is complete.
 *
 * Baseline ratchet: `BASELINE_COOKIE_AUTHORITY` lists every (route, method) whose cookie-only
 * request is NOT yet indistinguishable from an anonymous one. Each is a `test.failing`: it
 * passes only while the defect exists. The moment a surface stops honouring the cookie (L-8),
 * its `test.failing` FAILS and the entry must be removed — the list can only shrink, and the
 * end state of the zero-cookie-authority work is an empty list.
 */
import { ROUTE_MANIFEST, type HttpMethod, type RouteEntry } from "./routeManifest";
import { buildRequest, observe, installNetworkKillSwitch, type Observation } from "./routeHarness";
import { BASELINE_COOKIE_AUTHORITY } from "./cookieOnlyBaseline";

/** Classes that resolve no user identity: the sensitivity control does not apply to them. */
const NO_IDENTITY_CLASSES = new Set(["signature", "telemetry-proxy"]);
/** Methods of the session route that by contract do not resolve identity from a bearer. */
const NO_BEARER_IDENTITY = new Set([
  "POST app/api/auth/session/route.ts", // mints from an ID token in the BODY
  "DELETE app/api/auth/session/route.ts", // only removes authority
]);
/**
 * Inputs a route validates BEFORE identity. Without them both sides of the comparison would be
 * the same 400 and the oracle would be vacuous (the sensitivity test catches that case by name).
 */
const QUERY_OVERRIDES: Record<string, string> = {
  "GET app/api/synthesize-panel/route.ts": "runId=zca-runId&mode=cache",
};

export function routeUrl(path: string): string {
  return path
    .replace(/^app/, "")
    .replace(/\/route\.tsx?$/, "")
    .replace(/\[\.\.\.(\w+)\]/g, "x")
    .replace(/\[(\w+)\]/g, (_m, name: string) => `zca-${name}`);
}
export function routeParams(path: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const m of path.matchAll(/\[(\.\.\.)?(\w+)\]/g)) params[m[2]] = m[1] ? ["x"] : `zca-${m[2]}`;
  return params;
}
export const keyOf = (method: string, path: string) => `${method} ${path}`;

export function shard(index: number, count: number): Array<{ entry: RouteEntry; method: HttpMethod }> {
  const all = ROUTE_MANIFEST.flatMap((entry) => entry.methods.map((method) => ({ entry, method })));
  return all.filter((_v, i) => i % count === index);
}

type Triple = { none: Observation; cookieA: Observation; bearerA: Observation };

export function defineCookieOnlyOracle(index: number, count: number): void {
  installNetworkKillSwitch();
  const cases = shard(index, count);
  const results = new Map<string, Triple>();

  beforeAll(async () => {
    for (const { entry, method } of cases) {
      let handler: (req: unknown, ctx: unknown) => Promise<Response>;
      try {
        const mod = require(`@/${entry.path.replace(/\.tsx?$/, "")}`) as Record<string, (req: unknown, ctx: unknown) => Promise<Response>>;
        handler = mod[method];
        if (typeof handler !== "function") throw new Error(`no exported ${method}`);
      } catch (e) {
        // A module that cannot load is recorded per route (status -3): its sensitivity test then
        // fails by name instead of the whole shard aborting.
        const failed: Observation = { status: -3, body: `load failed: ${(e as Error)?.message?.split("\n")[0]}`, setCookie: null, touches: [], cookieVerifies: 0, idTokenVerifies: 0, externalCalls: [] };
        results.set(keyOf(method, entry.path), { none: failed, cookieA: failed, bearerA: failed });
        continue;
      }
      const query = QUERY_OVERRIDES[keyOf(method, entry.path)];
      const url = query ? `${routeUrl(entry.path)}?${query}` : routeUrl(entry.path);
      const ctx = { params: routeParams(entry.path) };
      const run = (credential: "none" | "cookieA" | "bearerA") => observe(() => handler(buildRequest(url, method, credential), ctx));
      // Sequential and in a fixed order: the harness recorders are module-global.
      const none = await run("none");
      const cookieA = await run("cookieA");
      const bearerA = await run("bearerA");
      results.set(keyOf(method, entry.path), { none, cookieA, bearerA });
    }
    if (process.env.ZCA_SURVEY_OUT) {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync(`${process.env.ZCA_SURVEY_OUT}.${index}.json`, JSON.stringify(Object.fromEntries(results), null, 1));
    }
  }, 600_000);

  for (const { entry, method } of cases) {
    const key = keyOf(method, entry.path);
    const identityRoute = !NO_IDENTITY_CLASSES.has(entry.cls) && !NO_BEARER_IDENTITY.has(key);

    if (identityRoute) {
      test(`${key}: SENSITIVITY — a bearer-only request reaches the identity layer`, () => {
        const r = results.get(key)!;
        expect(r.bearerA.idTokenVerifies).toBeGreaterThan(0);
      });
    }

    const zero = () => {
      const r = results.get(key)!;
      expect({
        cookieVerifies: r.cookieA.cookieVerifies,
        status: r.cookieA.status,
        body: r.cookieA.body,
        setCookie: r.cookieA.setCookie,
        touches: r.cookieA.touches,
        externalCalls: r.cookieA.externalCalls,
      }).toEqual({
        cookieVerifies: 0,
        status: r.none.status,
        body: r.none.body,
        setCookie: r.none.setCookie,
        touches: r.none.touches,
        externalCalls: r.none.externalCalls,
      });
      // Non-vacuity of the comparison itself: the anonymous request was actually refused or
      // answered by the handler (not a harness crash) — a crash on both sides would compare equal.
      expect(r.none.status).toBeGreaterThan(0);
    };
    const name = `${key}: ZERO COOKIE AUTHORITY — a cookie-only request is indistinguishable from an anonymous one`;
    if (BASELINE_COOKIE_AUTHORITY.has(key)) test.failing(name, zero);
    else test(name, zero);
  }
}
