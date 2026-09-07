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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    expect(SECTION).toMatch(/only proof of containment|Only an authentication rejection/);
  });

  it("the prove-dead probe OMITS the uid, so it cannot mint a claim", () => {
    /**
     * C8 told responders to POST {uid, secret}. If the rotated config had not
     * deployed, that probe re-mints admin:true on the uid used. The route
     * validates the secret before the uid, so the safe probe carries no uid.
     */
    expect(SECTION.replace(/\s+/g, " ")).toContain('{"secret": "<OLD_SECRET>"} <- no uid, ever');
    // The old, dangerous instruction must not survive anywhere in the section.
    expect(SECTION).not.toMatch(/POST\s+\/api\/admin\/set-admin\s+with the old secret must return 401/);
  });

  it("states that 429 and 5xx are INCONCLUSIVE, not containment", () => {
    expect(SECTION.replace(/\s+/g, " ")).toMatch(/\| 429 \| INCONCLUSIVE/);
    expect(SECTION).toContain("unproven");
  });

  it("does not tell the operator to bypass the rate limiter", () => {
    // Whitespace-tolerant: the doc wraps this sentence across lines.
    expect(SECTION.replace(/\s+/g, " ")).toContain("do not attempt to bypass the rate limiter");
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
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const exported = (file: string) => {
    const src = readFileSync(file, "utf8");
    return METHODS.filter((m) => new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src));
  };

  const ROUTE_FILES = [...routeFiles("app/api/admin"), ...routeFiles("app/api/governance")];

  it("ANCHOR: method extraction finds real, varied methods", () => {
    // A broken extractor returning [] would make every assertion below vacuous.
    const all = ROUTE_FILES.flatMap(exported);
    expect(all).toEqual(expect.arrayContaining(["GET", "POST", "PATCH", "DELETE"]));
    expect(exported("app/api/admin/users/[uid]/route.ts").sort()).toEqual(["DELETE", "PATCH"]);
  });

  it.each(ROUTE_FILES)("%s: every exported method appears in its table row(s)", (file) => {
    const route = "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "");
    const rows = TABLE.split("\n").filter((l) => l.includes(`\`${route}\``));
    expect(rows.length).toBeGreaterThan(0);
    const text = rows.join(" ");
    for (const m of exported(file)) expect(text).toContain(m);
  });
});
