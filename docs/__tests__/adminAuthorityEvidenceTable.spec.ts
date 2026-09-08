/**
 * Phase FIRST-ADMIN-C8 — the incident-response evidence table must be COMPLETE.
 *
 * History of this one table:
 *   C6 claimed `writeAuditEvent` covered the SYSTEM_ADMIN mutation handlers.
 *       False.
 *   C7 replaced it with a per-route table and the heading "Verified against
 *       every production call site". Every row was correct — and the table
 *       omitted `/api/admin/set-admin`, the SECOND claim-minting path, whose
 *       absence let the documented SYSTEM_ADMIN containment procedure declare
 *       success while a reusable bootstrap secret could re-mint the claim.
 *
 * Both times the defect was a completeness claim that nothing enforced. A
 * reviewer had to re-enumerate the routes by hand to find the hole, and the
 * second time the enumeration was performed by the same author who wrote the
 * claim. So the claim is now a test: the table is checked against the actual
 * filesystem, and a privileged route that is not listed fails CI.
 *
 * This does not check that a row's ✅/❌ marks are TRUE — that requires reading
 * the handler, and is what review is for. It checks that no route is missing,
 * which is the failure mode that actually occurred, twice.
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DOC = "docs/operations/admin-authority-tiers.md";
const SRC = readFileSync(DOC, "utf8");

/** The §A.6 evidence table: from its header row to the end of the table block. */
const TABLE = (() => {
  const start = SRC.indexOf("| Route (method) | Authority | Audit | Success log | Other evidence |");
  expect(start).toBeGreaterThan(-1);
  const after = SRC.slice(start);
  const end = after.indexOf("\n\n");
  return after.slice(0, end === -1 ? undefined : end);
})();

/** Every privileged route on disk, as an API path. */
function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}
const ROUTES = [...routeFiles("app/api/admin"), ...routeFiles("app/api/governance")]
  .map((f) => "/" + f.replace(/^app\//, "").replace(/\/route\.ts$/, ""))
  .sort();

describe("§A.6 evidence table is complete against the filesystem", () => {
  it("ANCHOR: the table was located and is substantial", () => {
    // Without this, a failed lookup yielding "" would make every `toContain`
    // below fail loudly rather than silently — but a table trimmed to one row
    // would not. Pin both the parse and the scale.
    expect(TABLE).toContain("| Route (method) |");
    expect(TABLE.split("\n").length).toBeGreaterThan(20);
  });

  it("ANCHOR: the filesystem enumeration found the routes it is supposed to check", () => {
    // A broken walker returning [] would satisfy every per-route assertion.
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(ROUTES).toContain("/api/admin/set-admin");
    expect(ROUTES).toContain("/api/governance/review");
  });

  it.each(ROUTES)("%s appears in the evidence table", (route) => {
    expect(TABLE).toContain(`\`${route}\``);
  });

  it("names the bootstrap claim-minting route as having NO audit and NO success log", () => {
    // The specific omission that made the C7 containment procedure incomplete.
    const row = TABLE.split("\n").find((l) => l.includes("`/api/admin/set-admin`"));
    expect(row).toBeDefined();
    expect(row).toContain("BOOTSTRAP_SECRET");
    // Two ❌ NONE cells: no durable record, and no runtime evidence either.
    expect(row!.match(/❌ \*\*NONE\*\*/g) ?? []).toHaveLength(2);
  });
});

describe("the SYSTEM_ADMIN containment procedure closes the bootstrap path", () => {
  const SECTION = SRC.slice(
    SRC.indexOf("### B. SYSTEM_ADMIN (claim-derived)"),
    SRC.indexOf("### What this procedure does NOT give you")
  );

  it("ANCHOR: the containment section was located and still covers claim removal", () => {
    expect(SECTION).toContain("setCustomUserClaims(uid, { admin: false })");
    expect(SECTION).toContain("revokeRefreshTokens");
    expect(SECTION.length).toBeGreaterThan(1000);
  });

  it("requires rotating or removing ADMIN_SECRET", () => {
    expect(SECTION).toMatch(/Rotate `ADMIN_SECRET`|remove it entirely/);
  });

  it("requires a deliberate deploy of the rotated value", () => {
    expect(SECTION).toMatch(/Deploy deliberately|does not affect\s+running Production/);
  });

  it("requires proving the old secret is dead, not just changed", () => {
    expect(SECTION.replace(/\s+/g, " ")).toMatch(/Only `PRE accepted -> POST rejected` prints/);
  });

  it("the prove-dead probe OMITS the uid, so it cannot mint a claim", () => {
    /**
     * C8 told responders to POST {uid, secret}. If the rotated config had not
     * deployed, that probe re-mints admin:true on the uid used. The route
     * validates the secret before the uid, so the safe probe carries no uid.
     */
    expect(SECTION).toContain("scripts/probe-admin-secret.mjs");
    expect(SECTION).toContain("--production-two-phase");
    // The secret is exported, never inlined on a command line where the shell
    // would mangle it — that produced a false proof.
    expect(SECTION).toContain("export OLD_ADMIN_SECRET");
    expect(SECTION).not.toMatch(/OLD_ADMIN_SECRET=<old value> node/);
    // The runbook must no longer reconstruct a request body of its own.
    expect(SECTION).not.toMatch(/["']uid["']\s*:/);
    // The old, dangerous instruction must not survive anywhere in the section.
    expect(SECTION).not.toMatch(/POST\s+\/api\/admin\/set-admin\s+with the old secret must return 401/);
  });

  it("states that 429 and 5xx are INCONCLUSIVE, not containment", () => {
    // Row shape only; the SEMANTICS of each status are pinned by verdict token
    // in docs/__tests__/bootstrapProbeInvariant.spec.ts, so a reworded row
    // cannot invert the meaning the way it could in C9.
    expect(SECTION.replace(/\s+/g, " ")).toMatch(/a 429 tells you nothing about the credential/);
  });

  it("does not tell the operator to bypass the rate limiter", () => {
    // Whitespace-tolerant: the doc wraps this sentence across lines.
    expect(SECTION.replace(/\s+/g, " ")).toMatch(/Wait for the window and re-run rather than trying to bypass it/);
  });

  it("states plainly that containment is incomplete while the secret can re-mint", () => {
    expect(SECTION).toMatch(/not complete while a reusable bootstrap credential/);
  });
});

describe("evidence cells corrected in C9 stay corrected", () => {
  /**
   * Phase FIRST-ADMIN-C9. C8-R5 found five cells wrong in the dangerous
   * direction — claiming evidence that does not exist. Each was re-derived by
   * reading the handler's SUCCESS path (for logs) and the Stripe call
   * DIRECTION (for provider evidence), not by counting logging calls in a file,
   * which is the inference that produced the errors.
   *
   * LIMIT OF THIS TEST, stated plainly: it pins the documented VALUES so a
   * correction cannot silently revert. It does NOT re-derive them from source,
   * and it cannot prove the classification is true — that took reading the
   * handlers, and it is what review is for. Do not read a green run here as
   * semantic verification.
   */
  /** A route can occupy several rows (one per method group), so select by both. */
  const row = (route: string, method?: string) => {
    const found = TABLE.split("\n").filter(
      (l) => l.includes(`\`${route}\``) && (method ? l.includes(method) : true)
    );
    expect(found).toHaveLength(1);
    return found[0];
  };

  it.each([
    ["/api/admin/runs", "success returns are silent; only fallback/integrity warns and a catch"],
    ["/api/admin/runs/[runId]", "same — the only logger.warn precedes a 404"],
  ])("%s GET claims NO success log", (route) => {
    const line = row(route, "GET");
    // The Success-log column must be a NONE, not a tick.
    expect(line).toContain("❌ **NONE**");
    expect(line.split("|")[4]).not.toContain("✅");
  });

  it.each([
    "/api/admin/sync-subscription",
    "/api/admin/test-webhook",
    "/api/admin/users/[uid]/stripe/sync",
  ])("%s claims NO external Stripe evidence (it only reads Stripe)", (route) => {
    const line = row(route, "POST");
    expect(line).toContain("reads Stripe only");
    expect(line).not.toContain("| Stripe events |");
  });

  it.each([
    "/api/admin/users/[uid]/stripe/cancel",
    "/api/admin/users/[uid]/stripe/reactivate",
  ])("%s KEEPS its Stripe-events credit (it genuinely writes to Stripe)", (route) => {
    // ANCHOR: without this the rule "no Stripe credit" could be satisfied by
    // stripping every provider claim, which would be a different wrong table.
    expect(row(route, "POST")).toContain("Stripe events");
  });

  it("the containment pointer on the set-admin row names the bootstrap section", () => {
    expect(row("/api/admin/set-admin", "POST")).toContain("§B.6");
    expect(row("/api/admin/set-admin", "POST")).not.toContain("§B.4");
  });
});

describe("§A.6 table enumerates every HTTP method each route exports", () => {
  /**
   * Phase FIRST-ADMIN-C9 (R5 P2-1). Completeness was enforced at ROUTE level
   * only, so `/api/admin/users/[uid]` could be narrowed from "PATCH, DELETE" to
   * "PATCH" — dropping permanent account deletion from the incident table —
   * with CI green.
   */
  /**
   * Phase FIRST-ADMIN-C10 (R6 F-2). The extractor saw only
   * `export function` / `export async function` among five verbs, so a route
   * added as `export const DELETE = …`, or exporting OPTIONS/HEAD, could be
   * listed with that method missing from the incident table and CI stayed
   * green. No route uses those forms today — this closes the gap before one
   * does, rather than narrowing the claim a third time.
   */
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
  const exported = (file: string) => {
    const src = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // a commented-out export is not an export
      .join("\n");
    return METHODS.filter((m) =>
      new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src) ||
      new RegExp(`export\\s+(const|let|var)\\s+${m}\\s*(:[^=]*)?=`).test(src)
    );
  };

  const ROUTE_FILES = [...routeFiles("app/api/admin"), ...routeFiles("app/api/governance")];

  it("ANCHOR: method extraction finds real, varied methods", () => {
    // A broken extractor returning [] would make every assertion below vacuous.
    const all = ROUTE_FILES.flatMap(exported);
    expect(all).toEqual(expect.arrayContaining(["GET", "POST", "PATCH", "DELETE"]));
    expect(exported("app/api/admin/users/[uid]/route.ts").sort()).toEqual(["DELETE", "PATCH"]);
  });

  it("ANCHOR: the extractor recognises every export form and verb it claims to", () => {
    /**
     * Written against synthetic sources, because no route in the repository
     * uses the const form or OPTIONS/HEAD today — which is precisely why the
     * gap was invisible. Without this the broadened claim would be untested.
     */
    const tmp = join(mkdtempSync(join(tmpdir(), "route-extract-")), "route.ts");
    writeFileSync(tmp, [
      "export async function GET() {}",
      "export function POST() {}",
      "export const DELETE = async () => {};",
      "export const PATCH: RouteHandler = async () => {};",
      "export let OPTIONS = () => {};",
      "export async function HEAD() {}",
    ].join("\n"));
    expect(exported(tmp).sort()).toEqual(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST"].sort());

    const none = join(mkdtempSync(join(tmpdir(), "route-extract-none-")), "route.ts");
    // Must NOT match a non-export, a comment, or a similarly-named local.
    writeFileSync(none, "const GET = 1;\n// export function POST() {}\nfunction DELETEX() {}\n");
    expect(exported(none)).toEqual([]);
  });

  it.each(ROUTE_FILES)("%s: every exported method appears in its table row(s)", (file) => {
    const route = "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "");
    const rows = TABLE.split("\n").filter((l) => l.includes(`\`${route}\``));
    expect(rows.length).toBeGreaterThan(0);
    const text = rows.join(" ");
    for (const m of exported(file)) expect(text).toContain(m);
  });
});

describe("STRUCTURED CONTAINMENT CONTRACT — steps identified by stable ID", () => {
  /**
   * Phase FIRST-ADMIN-C11 (R7 P2-3). Every containment imperative was pinned by
   * a prose fragment, so four of them could be demoted to optional notes with
   * CI green — including "Revoke refresh tokens", which this document itself
   * calls the most important lever, pinned only by a string-presence anchor the
   * demoted text still satisfied.
   *
   * Each MUST step now carries a stable ID. Wording can evolve; the step cannot
   * silently disappear or drift out of the procedure.
   */
  const src = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");
  const SECTION = src.slice(
    src.indexOf("### B. SYSTEM_ADMIN (claim-derived)"),
    src.indexOf("### What this procedure does NOT give you")
  );

  const REQUIRED = [
    "CONTAINMENT_REMOVE_CLAIM",
    "CONTAINMENT_REVOKE_REFRESH",
    "CONTAINMENT_ROTATE_BOOTSTRAP",
    "CONTAINMENT_PROBE_OLD_SECRET",
    "CONTAINMENT_DISABLE_ACCOUNT",
    "CONTAINMENT_REENUMERATE_CLAIMS",
    "CONTAINMENT_VERIFY_DENIAL",
  ];

  it("ANCHOR: the containment section was located and is substantial", () => {
    expect(SECTION).toContain("revokeRefreshTokens");
    expect(SECTION.length).toBeGreaterThan(2000);
  });

  it.each(REQUIRED)("%s appears exactly once, inside the containment section", (id) => {
    expect(SECTION.match(new RegExp(`\\[${id}\\]`, "g")) ?? []).toHaveLength(1);
    expect(src.match(new RegExp(`\\[${id}\\]`, "g")) ?? []).toHaveLength(1);
  });

  it.each(REQUIRED)("%s carries Mode=MUST in the structured obligation table", (id) => {
    /**
     * Phase FIRST-ADMIN-C13 (R9 P2). C12 enforced obligation with a six-phrase
     * blocklist, and a reviewer walked past it with "at your discretion; omit
     * when time-pressed" while keeping the [REQUIRED] marker. Blacklisting
     * synonyms is not achievable; the structured Mode column is the contract,
     * and the prose under each step is free to evolve.
     */
    const row = SECTION.split("\n").filter((l) => l.includes(`\`${id}\``) && l.includes("|"));
    expect(row).toHaveLength(1);
    expect(row[0].split("|").map((c) => c.trim())).toContain("MUST");
  });

  it("the obligation table declares no requirement this contract does not know about", () => {
    const declared = [...SECTION.matchAll(/\|\s*`(CONTAINMENT_[A-Z_]+)`\s*\|[^|]*\|\s*MUST\s*\|/g)].map((m) => m[1]);
    expect([...new Set(declared)].sort()).toEqual([...REQUIRED].sort());
  });

  it("ANCHOR: downgrading a Mode is visible — no row may say MAY or SHOULD", () => {
    expect(SECTION).not.toMatch(/\|\s*(MAY|SHOULD|OPTIONAL)\s*\|/);
  });

  it("the section declares no containment ID this contract does not require", () => {
    // Catches a step being renamed rather than removed.
    const found = [...SECTION.matchAll(/\[(CONTAINMENT_[A-Z_]+)\]/g)].map((m) => m[1]);
    expect([...new Set(found)].sort()).toEqual([...REQUIRED].sort());
  });

  it("each identified step is a numbered MUST step, not an aside", () => {
    for (const id of REQUIRED) {
      const line = SECTION.split("\n").find((l) => l.includes(`[${id}]`))!;
      expect({ id, numbered: /^\s*(\d+\.|[a-z]\.)\s/.test(line) }).toEqual({ id, numbered: true });
    }
  });
});

describe("the session-mint claim matches the code", () => {
  /**
   * C10 asserted that POST /api/auth/session refuses to mint for a disabled or
   * revoked identity. The route calls verifyIdToken WITHOUT checkRevoked, so
   * that was false — and it contradicted §B.5 of the same document.
   */
  const src = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");
  const ROUTE = readFileSync("app/api/auth/session/route.ts", "utf8");

  it("ANCHOR: the route still mints from verifyIdToken", () => {
    expect(ROUTE).toContain("verifyIdToken");
    expect(ROUTE).toContain("createSessionCookie");
  });

  it("the route does NOT pass checkRevoked — so the doc must not claim it refuses", () => {
    // If this ever changes, the documentation below should change with it.
    expect(ROUTE).not.toMatch(/verifyIdToken\([^)]*,\s*true\s*\)/);
    expect(src).toMatch(/without\s*\n?\s*`checkRevoked`/);
    expect(src.replace(/\s+/g, " ")).toContain("Minting a NEW cookie is not blocked by this application");
  });

  it("does not assert an immediate bearer-path cutoff", () => {
    expect(src.replace(/\s+/g, " ")).toContain("Do not record the ADMIN_PORTAL surface as closed");
  });
});

describe("the documented bootstrap rate limit matches the route's constants", () => {
  /**
   * Phase FIRST-ADMIN-C11 (R7 F-1). The runbook stated "3 per 5 min per IP" as
   * fact. The numbers happened to be right; the mechanism was broken and
   * nothing tied the prose to the code. Both are now derived from the same
   * exported constants.
   */
  const ROUTE = readFileSync("app/api/admin/set-admin/route.ts", "utf8");
  const DOC = readFileSync("docs/operations/admin-authority-tiers.md", "utf8");

  const constant = (name: string) => {
    const m = ROUTE.match(new RegExp(`const ${name} = (\\d+);`));
    expect(m).not.toBeNull();
    return Number(m![1]);
  };

  it("ANCHOR: the route exports both constants and uses them in its limiter call", () => {
    expect(constant("RATE_LIMIT_MAX_REQUESTS")).toBeGreaterThan(0);
    expect(constant("RATE_LIMIT_WINDOW_SECONDS")).toBeGreaterThan(0);
    expect(ROUTE).toContain("maxRequests: RATE_LIMIT_MAX_REQUESTS");
    expect(ROUTE).toContain("windowSeconds: RATE_LIMIT_WINDOW_SECONDS");
  });

  it("the runbook states the ACTUAL numbers, and they match the runtime constants", () => {
    /**
     * C11 cited only the constant NAMES, which made parity vacuous — the window
     * could be changed from 300 to 5 with every test green, and an on-call
     * responder had no way to know how long to wait. The numbers are back, and
     * now they are checked.
     */
    const max = constant("RATE_LIMIT_MAX_REQUESTS");
    const win = constant("RATE_LIMIT_WINDOW_SECONDS");
    const flat = DOC.replace(/\s+/g, " ");
    expect(flat).toContain(`${max} attempts per ${win} seconds`);
    expect(DOC).toContain("RATE_LIMIT_MAX_REQUESTS");
    expect(DOC).toContain("RATE_LIMIT_WINDOW_SECONDS");
  });

  it("documents that the per-IP key depends on the hosting layer, not on this code", () => {
    const flat = DOC.replace(/\s+/g, " ");
    expect(flat).toContain("does **not** independently prevent header spoofing");
    expect(flat).toMatch(/Vercel overwrites that header/);
    expect(flat).toMatch(/operational dependency on the hosting layer/);
  });

  it("the runbook presents rate limiting as defence-in-depth, not the primary boundary", () => {
    const flat = DOC.replace(/\s+/g, " ");
    expect(flat).toContain("defence-in-depth only");
    expect(flat).toMatch(/primary boundary is a high-entropy `ADMIN_SECRET`/);
  });
});
