/**
 * TEAM-VERIFICATION-PARITY-R4-I2 §AK — STATIC Personal/mutation boundary for
 * the Claims-list surface.
 *
 * The behavioural suites prove these files make no Personal request and no
 * write at runtime. This proves it structurally, so a future edit cannot
 * reintroduce either along a path no test happens to exercise.
 *
 * Comments are stripped before matching: these files deliberately DOCUMENT the
 * Personal stack they must never touch, and a comment naming a forbidden symbol
 * is the boundary being explained, not violated.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Every production file R4-I2 introduces or extends with Claim-list behaviour. */
const I2_FILES = [
  "hooks/useTeamClaimVerificationList.ts",
  "components/workspace/claims/TeamClaimListRow.tsx",
  "components/workspace/claims/TeamWorkspaceClaimsShell.tsx",
  "app/workspace/team/[workspaceId]/claims/page.tsx",
];

const FORBIDDEN = [
  "/api/user/",
  "run-governance",
  "panel-history",
  "/api/governance/",
  "/api/verify-claim",
  "generateVerificationMemo",
  "VerificationActions",
  "personalResearchHref",
  "personalResearchVerifyClaimHref",
  "?tab=verify",
  "/workspace/research/",
];

const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * ZCA L-4: a migrated page's server render only names its `kind`; its gate is the kind's row in
 * TEAM_PAGE_REQUIRED_CAPABILITIES and its props are built in TeamWorkspacePage.tsx (read from source).
 */
const TEAM_PAGE = "components/workspace/TeamWorkspacePage.tsx";
const delegatedKind = (rel: string): string | null => source(rel).match(/<TeamWorkspacePage\s+kind="([A-Za-z]+)"/)?.[1] ?? null;
const kindGuard = (kind: string): string[] => {
  const table = source(TEAM_PAGE).slice(source(TEAM_PAGE).indexOf("TEAM_PAGE_REQUIRED_CAPABILITIES"));
  const row = table.match(new RegExp(`\\n\\s*${kind}: \\[([^\\]]*)\\]`));
  if (!row) throw new Error(`no guard row for kind ${kind}`);
  return [...row[1].matchAll(/"([a-z.]+)"/g)].map((m) => m[1]);
};
const codeOf = (rel: string) =>
  source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("R4-I2 Personal boundary (static)", () => {
  it.each(I2_FILES)("%s contains no Personal verification marker", (rel) => {
    const text = codeOf(rel);
    for (const marker of FORBIDDEN) {
      expect({ file: rel, marker, found: text.includes(marker) }).toEqual({ file: rel, marker, found: false });
    }
  });

  it("never imports the Personal Claim wrapper", () => {
    for (const rel of I2_FILES) {
      expect(codeOf(rel)).not.toMatch(/from "@\/components\/ClaimVerificationResult"/);
    }
  });

  it("reads only Team Workspace endpoints", () => {
    for (const rel of I2_FILES) {
      for (const literal of codeOf(rel).match(/["'`]\/api\/[^"'`]*/g) ?? []) {
        expect(literal.slice(1).startsWith("/api/workspaces/")).toBe(true);
      }
    }
  });

  it("performs no write of any kind", () => {
    for (const rel of I2_FILES) {
      expect(codeOf(rel)).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/);
    }
  });

  it("derives no authorization decision client-side", () => {
    for (const rel of I2_FILES.filter((f) => !f.startsWith("app/"))) {
      const text = codeOf(rel);
      expect(text).not.toContain("user.email");
      expect(text).not.toContain("viewerEmail");
      expect(text).not.toContain("capabilities.includes");
      expect(text).not.toMatch(/\brole\b\s*===/);
      expect(text).not.toContain("userId ===");
    }
  });

  it("builds every Claim destination through the shared href builder", () => {
    const row = codeOf("components/workspace/claims/TeamClaimListRow.tsx");
    expect(row).toContain("teamClaimDetailHref(");
    // No hand-rolled claim path anywhere in the row.
    expect(row).not.toMatch(/`\/workspace\/team\/\$\{[^}]*\}\/claims/);
  });

  it("uses the server scope contract rather than filtering an all-response", () => {
    const shell = codeOf("components/workspace/claims/TeamWorkspaceClaimsShell.tsx");
    const hook = codeOf("hooks/useTeamClaimVerificationList.ts");
    expect(hook).toContain('params.set("scope", "unfiled")');
    // The shell must not post-filter rows it received.
    expect(shell).not.toMatch(/items\.filter\(/);
  });

  it("the Server Component gate never hands the capability array to the client", () => {
    const rel = "app/workspace/team/[workspaceId]/claims/page.tsx";
    // ZCA L-4: migrated — the gate is the `claims` guard row; TeamWorkspacePage passes no array.
    expect(delegatedKind(rel)).toBe("claims");
    expect(kindGuard("claims")).toEqual(["research.read"]);
    expect(codeOf(rel)).not.toMatch(/capabilities=\{/);
    expect(codeOf(TEAM_PAGE)).not.toMatch(/capabilities=\{/);
  });
});
