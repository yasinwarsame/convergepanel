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
    expect(SECTION).toContain("must return 401");
  });

  it("states plainly that containment is incomplete while the secret can re-mint", () => {
    expect(SECTION).toMatch(/not complete while a reusable bootstrap credential/);
  });
});
