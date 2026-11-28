/**
 * ZCA P3 R2 L-3 — static gates for the behavioural differential (differentialOracle.ts):
 *  - the shards partition EVERY (route, method) of ROUTE_MANIFEST exactly once (156 pairs at this head: the design's
 *    "157" counted GET /api/auth/session, which ZCA L-2 removed and R2 does not restore);
 *  - the arms are exactly the designed 8 bearer × 6 cookie arms;
 *  - NO differential spec (nor the oracle / harness they load) mocks, spies on or replaces the request resolver, a
 *    wrapper of it, or the privileged guard: the only `jest.mock` targets are the network/data edges below.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_MANIFEST } from "./routeManifest";
import { keyOf } from "./cookieOnlyOracle";
import { BEARER_ARMS, COOKIE_ARMS, DIFFERENTIAL_SHARDS, differentialShard } from "./differentialOracle";

const DIR = __dirname;
const SHARD_FILES = readdirSync(DIR).filter((f) => /^differential\.shard\d+\.spec\.ts$/.test(f)).sort();
const LOADED_HELPERS = ["differentialOracle.ts", "routeHarness.ts", "cookieOnlyOracle.ts", "routeManifest.ts"];
const ALLOWED_MOCK_TARGETS = ["@/lib/firebase/admin", "@/lib/stripe/client", "@react-pdf/renderer", "@/lib/logger"];
const IDENTITY_MODULES = /resolveRequestIdentity|teamApiAuth|reportReviewRouteSupport|governance\/authCheck|privilegedAccess|privilegedCredentialAdapter|verifiedAdminIdentity|firebase\/auth["'/]|firebase\/auth-helpers/;

describe("the differential covers every route-method pair exactly once", () => {
  it("one spec file per shard, and the shards partition the manifest", () => {
    expect(SHARD_FILES).toEqual(Array.from({ length: DIFFERENTIAL_SHARDS }, (_, i) => `differential.shard${i}.spec.ts`));
    for (const [i, f] of SHARD_FILES.entries()) {
      expect(readFileSync(join(DIR, f), "utf8")).toContain(`defineDifferential(${i}, DIFFERENTIAL_SHARDS);`);
    }
    const all = ROUTE_MANIFEST.flatMap((r) => r.methods.map((m) => keyOf(m, r.path))).sort();
    const covered = Array.from({ length: DIFFERENTIAL_SHARDS }, (_, i) => differentialShard(i, DIFFERENTIAL_SHARDS).map(({ entry, method }) => keyOf(method, entry.path))).flat().sort();
    expect(covered).toEqual(all);
    expect(new Set(covered).size).toBe(covered.length);
    expect(all).toHaveLength(156);
  });
  it("the arms are exactly the designed bearer × cookie grid (8 × 6)", () => {
    expect(Object.keys(BEARER_ARMS)).toEqual(["absent", "validA", "validB", "invalid", "expired", "revoked", "disabled", "malformed"]);
    expect(Object.keys(COOKIE_ARMS)).toEqual(["absent", "validA", "validB", "invalid", "empty", "garbage"]);
    expect(BEARER_ARMS.absent).toBeNull();
    expect(COOKIE_ARMS.absent).toBeNull();
    expect(Object.values(COOKIE_ARMS).filter((c) => c !== null).every((c) => /__session=/.test(c!))).toBe(true);
  });
});

describe("no differential spec mocks the resolver, a wrapper or the guard (R2 L-3 gate)", () => {
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const mockTargets = (src: string) => [...stripComments(src).matchAll(/jest\.(?:mock|doMock|unstable_mockModule|setMock)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  it.each(SHARD_FILES)("%s mocks only the network/data edges", (f) => {
    const src = readFileSync(join(DIR, f), "utf8");
    expect(mockTargets(src).sort()).toEqual([...ALLOWED_MOCK_TARGETS].sort());
    expect(src).not.toMatch(/jest\.(spyOn|replaceProperty|requireMock|createMockFromModule|enableAutomock)|__mocks__/);
    expect(src).not.toMatch(IDENTITY_MODULES);
  });
  it.each(LOADED_HELPERS)("%s (loaded by every shard) declares no mock and replaces no identity module", (f) => {
    const src = readFileSync(join(DIR, f), "utf8");
    expect(mockTargets(src)).toEqual([]);
    expect(src).not.toMatch(/jest\.(spyOn|replaceProperty|requireMock|createMockFromModule|enableAutomock)/);
  });
  it("the oracle asserts at run time that the identity modules it exercised are the real ones", () => {
    const src = readFileSync(join(DIR, "differentialOracle.ts"), "utf8");
    expect(src).toMatch(/jest\.requireActual\(m\)/);
    for (const m of ["@/lib/auth/resolveRequestIdentity", "@/lib/admin/privilegedAccess", "@/lib/teams/teamApiAuth", "@/lib/governance/authCheck"]) expect(src).toContain(`"${m}"`);
  });
  it("there is no __mocks__ directory that could replace an identity module", () => {
    const find = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? (e.name === "__mocks__" ? [join(d, e.name)] : find(join(d, e.name))) : []
      );
    const root = join(DIR, "..", "..");
    expect(["app", "lib", "components", "hooks", "__tests__"].flatMap((d) => find(join(root, d)))).toEqual([]);
  });
});
