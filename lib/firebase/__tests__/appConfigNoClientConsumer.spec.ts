/**
 * SEC-2 / S4 — no client module references `appConfig`.
 *
 * `firestore.rules` denies every client principal the whole `appConfig`
 * subtree. That is safe only while no browser code depends on reading or
 * writing it: provider keys and the governance policy are reached through the
 * Admin SDK on the server (`lib/keyStore.firestore.ts`, `app/api/admin/keys`,
 * `lib/governance/governanceFirestore.ts`). This pins that, so a future client
 * consumer fails here instead of failing silently in the browser.
 *
 * A module is a CLIENT module if any of these holds:
 *   - it lives under `components/`, `hooks/`, `lib/client/` or `extension/`;
 *   - it is an App Router UI file under `app/` (page, layout, template,
 *     loading, error, not-found, default) outside `app/api/`;
 *   - its first statement is the "use client" directive;
 *   - it imports the client Firebase SDK (`firebase/...`) or
 *     `@/lib/firebase/client`;
 *   - it is `instrumentation-client.ts`.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = join(__dirname, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__tests__", "firestore-rules-tests", "docs", "public", "prisma", "coverage"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FORBIDDEN = [/appConfig/i, /modelKeys/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !/\.(spec|test)\.[jt]sx?$/.test(name)) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

const UI_FILE = /^app\/(?!api\/)(?:.*\/)?(page|layout|template|loading|error|not-found|default|global-error)\.(tsx|ts|jsx|js)$/;
const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const CLIENT_SDK = /from\s+["'](?:firebase\/[^"']+|@\/lib\/firebase\/client)["']/;

function isClientModule(path: string, src: string): boolean {
  return (
    /^(components|hooks|lib\/client|extension)\//.test(path) ||
    UI_FILE.test(path) ||
    path === "instrumentation-client.ts" ||
    USE_CLIENT.test(src) ||
    CLIENT_SDK.test(src)
  );
}

const references = (src: string) => FORBIDDEN.filter((re) => re.test(src)).map((re) => re.source);

const ALL = walk(ROOT);
const CLIENT = ALL.filter((p) => isClientModule(p, readFileSync(join(ROOT, p), "utf8")));

describe("no client module references appConfig", () => {
  it("positive control: the client set is the real one", () => {
    expect(CLIENT.length).toBeGreaterThan(200);
    for (const p of ["app/page.tsx", "lib/firebase/client.ts", "lib/types.ts", "components/AuthProvider.tsx", "hooks/useTeamClaimVerification.ts", "app/profile/page.tsx"]) {
      expect(CLIENT).toContain(p);
    }
    expect(CLIENT.some((p) => p.startsWith("app/api/"))).toBe(false);
  });

  it("positive control: the matcher sees the server consumers, which are not client modules", () => {
    for (const p of ["lib/keyStore.firestore.ts", "app/api/admin/keys/route.ts", "lib/governance/governanceFirestore.ts"]) {
      expect(ALL).toContain(p);
      expect(references(readFileSync(join(ROOT, p), "utf8")).length).toBeGreaterThan(0);
      expect(CLIENT).not.toContain(p);
    }
  });

  it("positive control: the classifier recognises the client markers", () => {
    expect(isClientModule("lib/x.ts", '"use client";\nexport {}')).toBe(true);
    expect(isClientModule("lib/x.ts", "// c\n'use client'\n")).toBe(true);
    expect(isClientModule("lib/x.ts", 'import { doc } from "firebase/firestore";')).toBe(true);
    expect(isClientModule("lib/x.ts", 'import { auth } from "@/lib/firebase/client";')).toBe(true);
    expect(isClientModule("app/a/b/page.tsx", "")).toBe(true);
    expect(isClientModule("app/api/a/route.ts", "")).toBe(false);
    expect(isClientModule("lib/x.ts", 'import "server-only";')).toBe(false);
  });

  it("no client module mentions appConfig or modelKeys", () => {
    const offenders = CLIENT.map((p) => [p, references(readFileSync(join(ROOT, p), "utf8"))] as const).filter(([, r]) => r.length > 0);
    expect(offenders).toEqual([]);
  });
});
