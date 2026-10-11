/**
 * Order 4 Slice 2a — architectural boundaries of Workspace Source Standing.
 *
 * Standing is human-authored Workspace metadata. It must never feed (or be
 * fed by) governance, consensus, `sourceBacked`, evidence quality, exports,
 * Personal Workspaces, the persisted run (`adaptiveOutput` / `governanceRecord`
 * / Decision Receipt) or publisher class. These pins read the real files.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const root = join(__dirname, "..", "..", "..");
const dir = join(root, "lib/sourceStanding");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const productionFiles = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));
const importsOf = (src: string) => [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
const ROUTE = "app/api/workspaces/[workspaceId]/source-authority/route.ts";

describe("lib/sourceStanding imports — exact per-file allow-list", () => {
  const ALLOWED: Record<string, string[]> = {
    "sourceIdentity.ts": ["crypto", "@/lib/verification/evidenceSourceExtraction", "@/lib/sourceAuthority/normalizeAuthorityHost"],
    "standingTypes.ts": ["./sourceIdentity"],
    "resolveStanding.ts": ["./standingTypes"],
    "standingFirestore.ts": [
      "server-only",
      "firebase-admin/firestore",
      "@/lib/firebase/admin",
      "@/lib/logger",
      "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction",
      "@/lib/workspaces/workspaceMembershipEvents",
      "./sourceIdentity",
      "./standingTypes",
      "./resolveStanding",
    ],
    "reviewContextStanding.ts": ["server-only", "@/lib/logger", "./sourceIdentity", "./standingFirestore", "./standingTypes"],
  };

  it("the directory contains exactly the reviewed modules", () => {
    expect(productionFiles.sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it.each(Object.entries(ALLOWED))("%s imports only its allow-list", (file, allowed) => {
    expect(importsOf(code(`lib/sourceStanding/${file}`)).sort()).toEqual([...allowed].sort());
  });

  it("the pure modules (identity, types, resolver) never touch Firestore, the network or process.env", () => {
    for (const f of ["sourceIdentity.ts", "standingTypes.ts", "resolveStanding.ts"]) {
      const c = code(`lib/sourceStanding/${f}`);
      for (const banned of ["firebase", "adminDb", "fetch(", "process.env", "require(", "server-only"]) expect({ f, banned, present: c.includes(banned) }).toEqual({ f, banned, present: false });
    }
  });

  it("authority is capability-only: no role-name comparison anywhere in the subsystem or route", () => {
    for (const rel of [...productionFiles.map((f) => `lib/sourceStanding/${f}`), ROUTE]) {
      const c = code(rel);
      expect({ rel, roleCompare: /role\s*[!=]==?\s*["'](owner|admin|member|reviewer|viewer)["']|["'](owner|admin|member|reviewer|viewer)["']\s*[!=]==?\s*\w*[Rr]ole/.test(c) }).toEqual({ rel, roleCompare: false });
      expect({ rel, roleTable: /\{\s*owner:\s*true/.test(c) }).toEqual({ rel, roleTable: false });
    }
    expect(code("lib/sourceStanding/standingFirestore.ts")).toContain('requiredCapability: "sources.attest"');
  });

  it("no module reads process.env (the flag comes only from lib/env.ts, in the caller)", () => {
    for (const f of productionFiles) expect({ f, env: code(`lib/sourceStanding/${f}`).includes("process.env") }).toEqual({ f, env: false });
  });

  it("sourceIdentity reuses ONLY the host-hygiene primitive from lib/sourceAuthority — never the publisher classifier", () => {
    const c = code("lib/sourceStanding/sourceIdentity.ts");
    expect(importsOf(c).filter((i) => i.includes("sourceAuthority"))).toEqual(["@/lib/sourceAuthority/normalizeAuthorityHost"]);
    for (const t of ["classifySourcePublisher", "publisherClass", "PUBLISHER_CLASS", "registry"]) expect(c).not.toContain(t);
  });
});

describe("no coupling to governance, consensus, evidence quality, exports, Personal or the persisted run", () => {
  const BANNED_TOKENS = [
    "sourceBacked",
    "evidenceQuality",
    "evidenceRefs",
    "missingSourcesCount",
    "consensus",
    "confidence",
    "governanceRecord",
    "adaptiveOutput",
    "decisionReceipt",
    "evidenceSources",
    "publisherClass",
    "classifySourcePublisher",
    "artifactStatus",
    "personal",
    "Personal",
    "score",
    "rank",
    "trust",
    "Trust",
  ];
  it.each([...productionFiles.map((f) => `lib/sourceStanding/${f}`), ROUTE])("%s contains none of the banned tokens (outside comments)", (rel) => {
    const c = code(rel);
    for (const t of BANNED_TOKENS) expect({ rel, t, present: c.includes(t) }).toEqual({ rel, t, present: false });
  });

  it("status vocabulary: none of the forbidden labels appears as a string literal in the subsystem or route", () => {
    const FORBIDDEN = ["PROVISIONAL", "CONFIRMED", "CONTESTED", "TRUSTED", "UNTRUSTED", "VERIFIED", "HIGH_AUTHORITY", "LOW_AUTHORITY"];
    for (const rel of [...productionFiles.map((f) => `lib/sourceStanding/${f}`), ROUTE, "lib/workspaces/reviewContext.ts"]) {
      const c = code(rel);
      for (const w of FORBIDDEN) expect({ rel, w, present: new RegExp(`["'\`]${w}["'\`]`).test(c) }).toEqual({ rel, w, present: false });
    }
  });

  it("only the approved modules import lib/sourceStanding (reviewContext, the dark route, a type-only client import)", () => {
    const allowed = new Set(["lib/workspaces/reviewContext.ts", "lib/client/workspaceReviewClient.ts", ROUTE]);
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        if (["node_modules", ".next", ".git", "__tests__", "coverage"].includes(name)) continue;
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)) {
          const rel = relative(root, p);
          if (rel.startsWith("lib/sourceStanding/")) continue;
          if (/(?:from|import|require)\s*\(?\s*["'][^"']*sourceStanding(?:\/|["'])/.test(readFileSync(p, "utf8")) && !allowed.has(rel)) offenders.push(rel);
        }
      }
    };
    for (const top of ["lib", "app", "components", "hooks"]) walk(join(root, top));
    expect(offenders).toEqual([]);
    for (const f of allowed) expect(readFileSync(join(root, f), "utf8")).toMatch(/@\/lib\/sourceStanding\//);
  });

  it("the client imports Source Standing as a TYPE only (no server code in the browser bundle)", () => {
    const c = code("lib/client/workspaceReviewClient.ts");
    const lines = c.split("\n").filter((l) => l.includes("sourceStanding"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^import type \{/);
  });

  it("no UI component references standing yet (dark, no UI)", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (name === "node_modules") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && /\.standing\b|sourceStanding|SourceStanding/.test(readFileSync(p, "utf8"))) hits.push(relative(root, p));
      }
    };
    for (const top of ["components", "hooks"]) walk(join(root, top));
    walk(join(root, "app"));
    expect(hits.filter((h) => !h.startsWith("app/api/workspaces/[workspaceId]/source-authority/"))).toEqual([]);
  });

  it("reviewContext attaches standing only behind the flag and never reorders, filters or reranks links", () => {
    const c = code("lib/workspaces/reviewContext.ts");
    expect(c).toMatch(/SOURCE_AUTHORITY_METADATA_ENABLED \? await withSourceStanding\(target\.workspaceId, displayedSources\) : displayedSources/);
    const helper = code("lib/sourceStanding/reviewContextStanding.ts");
    for (const t of [".sort(", ".filter((link", ".reverse(", "splice("]) expect(helper).not.toContain(t);
  });

  it("the writer never touches runs, exports or Personal paths — only sourceAuthority + workspaceMembershipEvents", () => {
    const c = code("lib/sourceStanding/standingFirestore.ts");
    const collections = [...c.matchAll(/\.collection\("([^"]+)"\)/g)].map((m) => m[1]);
    expect([...new Set(collections)].sort()).toEqual(["events", "sourceAuthority", "workspaceMembershipEvents", "workspaces"].sort());
  });

  it("the writer's only queries are the two single-field, limit-1 reads (no composite index needed)", () => {
    const c = code("lib/sourceStanding/standingFirestore.ts");
    expect(c.match(/\.orderBy\(/g)).toHaveLength(1);
    expect(c).toContain('.collection("events").orderBy("revision", "desc").limit(1)');
    expect(c.match(/\.where\(/g)).toHaveLength(1);
    expect(c).toContain('db.collection("workspaces").doc(args.workspaceId).collection("sourceAuthority").where("successorIdHash", "==", args.identity.idHash).limit(1)');
    expect(c).not.toMatch(/collectionGroup/);
    expect(readFileSync(join(root, "firestore.indexes.json"), "utf8")).not.toMatch(/sourceAuthority|"events"|successorIdHash/);
  });
});
