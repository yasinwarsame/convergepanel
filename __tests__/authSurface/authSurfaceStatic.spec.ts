/**
 * ZCA L-1 — static half of the closed-world authorization oracle.
 *
 * Derives the authorization surface from the SOURCE TREE (never from the manifest's own claims)
 * and fails on anything that is not classified:
 *   - Route Handlers: file set, exported methods and the identity helpers each one calls must
 *     match `routeManifest.ts` exactly;
 *   - the behavioural shards cover every (route, method);
 *   - every place that can turn the `__session` cookie (or any credential) into an identity is on
 *     a pinned allow-list (cookie verifiers, `next/headers`, raw cookie reads, ID-token verifiers,
 *     session-cookie creation);
 *   - no Server Actions exist; metadata generators read no identity;
 *   - every Server Component / layout / route outside the manifest that reads identity is pinned
 *     (the 25 workspace pages — the neutral-shell migration empties that list);
 *   - middleware reads the cookie only where pinned;
 *   - client code reaches `/api/*` only through bearer-attaching helpers (or a pinned raw call that
 *     attaches the bearer itself) and never through navigations / links / forms.
 * When a pinned list changes, the diff to this file is the review record of the change.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROUTE_MANIFEST } from "./routeManifest";
import { shard, keyOf } from "./cookieOnlyOracle";

const ROOT = join(__dirname, "..", "..");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.(spec|test)\.(ts|tsx|js)$/.test(name)) out.push(p);
  }
  return out;
}
const SOURCE_DIRS = ["app", "lib", "components", "hooks"];
const SOURCES = [...SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))), join(ROOT, "middleware.ts")].map((p) => ({ path: rel(p), text: readFileSync(p, "utf8") }));
/** Comments are stripped before matching, so documentation can never satisfy or trip a rule. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const filesMatching = (re: RegExp) => SOURCES.filter((s) => re.test(code(s.text))).map((s) => s.path).sort();

const HELPERS: Array<[RegExp, string]> = [
  [/\bresolveRequestIdentity\b/, "resolveRequestIdentity"],
  [/\bgetRequestUid\b/, "getRequestUid"],
  [/\breportReviewCaller\b/, "reportReviewCaller"],
  [/\bresolveGovernanceRequestUser\b/, "resolveGovernanceRequestUser"],
  [/\brequirePrivilegedAccess\b/, "requirePrivilegedAccess"],
];

describe("Route Handlers: the manifest is exactly the source tree", () => {
  const onDisk = SOURCES.filter((s) => /^app\/.*\/route\.tsx?$/.test(s.path));

  test("every route file is classified, and every classified route exists", () => {
    expect(onDisk.map((s) => s.path).sort()).toEqual(ROUTE_MANIFEST.map((r) => r.path).sort());
  });

  test("exported HTTP methods match the manifest per route", () => {
    const actual = Object.fromEntries(
      onDisk.map((s) => [s.path, [...new Set([...code(s.text).matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]))].sort()]),
    );
    expect(actual).toEqual(Object.fromEntries(ROUTE_MANIFEST.map((r) => [r.path, [...r.methods].sort()])));
  });

  test("the identity helpers each route calls match its recorded enforcement", () => {
    const actual = Object.fromEntries(onDisk.map((s) => [s.path, HELPERS.filter(([re]) => re.test(code(s.text))).map(([, n]) => n).sort()]));
    const declared = Object.fromEntries(ROUTE_MANIFEST.map((r) => [r.path, r.enforcement.filter((e) => HELPERS.some(([, n]) => n === e)).slice().sort()]));
    expect(actual).toEqual(declared);
  });

  test("every privileged method records its tier, and the tier literal is in the source", () => {
    for (const r of ROUTE_MANIFEST.filter((x) => x.enforcement.includes("requirePrivilegedAccess"))) {
      const text = code(onDisk.find((s) => s.path === r.path)!.text);
      for (const [method, tier] of Object.entries(r.tiers ?? {})) {
        expect({ route: r.path, method, found: new RegExp(`requirePrivilegedAccess\\([^)]*"${tier}"[^)]*route: "${method} `).test(text) }).toEqual({ route: r.path, method, found: true });
      }
      if (r.cls === "privileged") expect({ route: r.path, tiered: Object.keys(r.tiers ?? {}).sort() }).toEqual({ route: r.path, tiered: [...r.methods].sort() });
    }
  });

  test("the behavioural shards partition every (route, method) exactly once", () => {
    const all = ROUTE_MANIFEST.flatMap((r) => r.methods.map((m) => keyOf(m, r.path))).sort();
    const covered = [0, 1, 2, 3].flatMap((i) => shard(i, 4).map(({ entry, method }) => keyOf(method, entry.path))).sort();
    expect(covered).toEqual(all);
    expect(new Set(covered).size).toBe(covered.length);
  });
});

describe("Credential → identity derivation is confined to a pinned allow-list", () => {
  test("session-cookie verification", () => {
    expect(filesMatching(/\bverifySessionCookie(Value)?\s*\(/)).toEqual([
      "lib/admin/privilegedAccess.ts",
      "lib/auth/resolveRequestIdentity.ts",
      "lib/auth/resolveServerComponentIdentity.ts",
      "lib/firebase/auth-helpers.ts",
    ]);
  });
  test("SDK-level session-cookie and ID-token verification", () => {
    // privilegedAccess.ts: the privileged guard's own verification (checkRevoked false + ONE live snapshot).
    // systemAdminClaimExecution.ts: the OPERATOR CLI (scripts/admin/set-system-admin-claim.ts), not a request
    //   surface — it verifies an operator ID token read from a file, with checkRevoked true, and reads no cookie.
    // adminAuth.ts: dead (no importer; pinned below).
    expect(filesMatching(/\.verifySessionCookie\s*\(|\.verifyIdToken\s*\(/)).toEqual([
      "app/api/auth/session/route.ts",
      "lib/admin/privilegedAccess.ts",
      "lib/admin/systemAdminClaimExecution.ts",
      "lib/firebase/adminAuth.ts",
      "lib/firebase/auth-helpers.ts",
      "lib/firebase/auth.ts",
    ]);
  });
  test("session-cookie creation", () => {
    expect(filesMatching(/\bcreateSessionCookie\s*\(/)).toEqual(["app/api/auth/session/route.ts"]);
  });
  test("raw reads of the __session cookie from a request", () => {
    expect(filesMatching(/cookies(\(\))?\s*\.\s*get\s*\(\s*(["'`]__session["'`]|SESSION_COOKIE(_NAME)?)\s*\)/)).toEqual([
      "lib/admin/privilegedAccess.ts",
      "lib/auth/resolveRequestIdentity.ts",
      "lib/auth/resolveServerComponentIdentity.ts",
      "lib/firebase/auth-helpers.ts",
      "middleware.ts",
    ]);
  });
  test("next/headers (the only cookie API a Server Component has)", () => {
    expect(filesMatching(/from\s+["']next\/headers["']/)).toEqual(["lib/auth/resolveServerComponentIdentity.ts"]);
  });
  test("lib/firebase/adminAuth.ts (verifyIdToken WITHOUT checkRevoked) has no importer", () => {
    expect(filesMatching(/["']@\/lib\/firebase\/adminAuth["']|["'][./]+firebase\/adminAuth["']/)).toEqual([]);
  });
});

describe("Other callable server entry points", () => {
  test("there are no Server Actions", () => {
    expect(filesMatching(/^\s*["']use server["']/m)).toEqual([]);
  });
  test("metadata / static-param generators are only on public pages and read no identity", () => {
    const gens = filesMatching(/\bexport\s+(async\s+)?function\s+generate(Metadata|StaticParams)\b|\bexport\s+const\s+metadata\b/);
    for (const f of gens) {
      const t = code(SOURCES.find((s) => s.path === f)!.text);
      expect({ f, identity: /resolveServerComponentIdentity|resolveRequestIdentity|next\/headers|__session/.test(t) }).toEqual({ f, identity: false });
    }
  });
  test("Server Components, layouts and other app/ server files that resolve identity are pinned", () => {
    const serverFiles = SOURCES.filter((s) => s.path.startsWith("app/") && !/\/route\.tsx?$/.test(s.path) && !/^\s*["']use client["']/m.test(s.text));
    const identityReaders = serverFiles.filter((s) => /resolveServerComponentIdentity|resolveRequestIdentity|verifySessionCookie|next\/headers|__session/.test(code(s.text))).map((s) => s.path).sort();
    expect(identityReaders).toEqual(SERVER_COMPONENT_IDENTITY_READERS);
  });
});

describe("Middleware", () => {
  test("middleware reads __session in exactly one place (presence only, /admin*)", () => {
    const t = code(SOURCES.find((s) => s.path === "middleware.ts")!.text);
    expect([...t.matchAll(/__session/g)].length).toBe(1);
    expect(t).not.toMatch(/verifySessionCookie|verifyIdToken|resolveRequestIdentity/);
  });
});

describe("Client callers of /api/*", () => {
  const client = SOURCES.filter((s) => /^\s*["']use client["']/m.test(s.text) || s.path.startsWith("lib/client/") || s.path.startsWith("hooks/"));
  test("raw fetch() to /api is pinned, and each pinned call attaches a bearer (or is the exempt session endpoint)", () => {
    const raw = client
      .flatMap((s) => [...code(s.text).matchAll(/\bfetch\s*\(\s*([`"'])(\/api\/[^`"'?$]*)/g)].map((m) => `${s.path} ${m[2]}`))
      .sort();
    expect(raw).toEqual(RAW_CLIENT_API_FETCHES);
  });
  test("every raw fetch() call site in client code is pinned (a variable URL cannot slip past the /api literal check)", () => {
    const counts = Object.fromEntries(
      client.map((s) => [s.path, [...code(s.text).matchAll(/(?<![\w.])fetch\s*\(/g)].length] as const).filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    expect(counts).toEqual(RAW_CLIENT_FETCH_SITES);
  });
  test("no navigation, link, window.open or form targets /api/*", () => {
    const hits = client.filter((s) => /(href|action)\s*=\s*\{?\s*[`"']\/api\/|window\.(open|location(\.href)?)\s*(=|\()\s*[`"']\/api\/|location\.(assign|replace)\s*\(\s*[`"']\/api\//.test(code(s.text))).map((s) => s.path);
    expect(hits).toEqual([]);
  });
});

/** The 25 workspace pages (D-4). The neutral-shell migration (L-3..L-7) must empty this list. */
const SERVER_COMPONENT_IDENTITY_READERS = [
  "app/workspace/page.tsx",
  "app/workspace/projects/[projectId]/page.tsx",
  "app/workspace/projects/page.tsx",
  "app/workspace/research/[runId]/page.tsx",
  "app/workspace/reviews/page.tsx",
  "app/workspace/team/page.tsx",
];

/**
 * Raw client fetches to /api. Each attaches `Authorization: Bearer` itself (verified by reading the
 * call site when it was pinned), except the session endpoint, which is exempt by contract.
 */
const RAW_CLIENT_API_FETCHES = [
  "app/admin/users/page.tsx /api/admin/users/",
  "app/page.tsx /api/synthesize-panel",
  "app/page.tsx /api/synthesize-panel",
  "app/workspace-invitations/accept/AcceptInvitationClient.tsx /api/workspace-invitations/",
  "components/VideoUploader.tsx /api/verify-video",
].sort();

/**
 * Every raw fetch() call site in client code, by file. Pinned at L-1 from the tree:
 * authedFetch.ts (the bearer-attaching helper), fetchWithTimeout.ts (generic; its /api callers
 * pass prepared bearer headers), sessionSync.ts (the exempt session endpoint: mint / clear / status),
 * and the raw /api calls listed above. (ZCA L-2 removed the third sessionSync call, the GET status read.)
 */
const RAW_CLIENT_FETCH_SITES: Record<string, number> = {
  "app/admin/users/page.tsx": 1,
  "app/page.tsx": 2,
  "app/workspace-invitations/accept/AcceptInvitationClient.tsx": 1,
  "components/VideoUploader.tsx": 1,
  "lib/client/authedFetch.ts": 1,
  "lib/client/fetchWithTimeout.ts": 1,
  "lib/client/sessionSync.ts": 2,
};
