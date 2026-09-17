/**
 * TEAM-VERIFICATION-PARITY-R4-I1 §X — STATIC Personal-boundary guard.
 *
 * The behavioural suites prove the Team Claim detail surface makes no Personal
 * request at runtime. This one proves the same thing structurally, so a future
 * edit cannot reintroduce a Personal dependency along a path no test happens to
 * exercise: the I1-owned source files must not even MENTION the Personal
 * verification stack.
 *
 * Deliberately a source-text check, not an import graph walk: a string such as
 * `"/api/user/" + suffix` assembled at runtime would evade a module-graph test
 * but not this one.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Every production file R4-I1 introduces. */
const I1_FILES = [
  "lib/workspaces/teamClaimDetailHref.ts",
  "hooks/useTeamClaimVerification.ts",
  "components/workspace/projects/TeamClaimDetailShell.tsx",
  "app/workspace/team/[workspaceId]/claims/[verificationId]/page.tsx",
  "app/workspace/team/[workspaceId]/projects/[projectId]/claims/[verificationId]/page.tsx",
];

/**
 * Forbidden markers. Each is a Personal-scope route, a Personal-only component
 * or a Personal-only export that must never be reachable from a Team surface.
 */
const FORBIDDEN = [
  "/api/user/",
  "run-governance",
  "panel-history",
  "/api/governance/",
  "/api/verify-claim",
  "components/ClaimVerificationResult",
  "generateVerificationMemo",
  "VerificationActions",
  "GovernanceBadge",
  "personalResearchHref",
  "personalResearchVerifyClaimHref",
  "?tab=verify",
  "/workspace/research/",
];

const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * The guard applies to CODE, not prose. These files deliberately document the
 * Personal stack they must never touch ("never calls `/api/user/...`"), and a
 * comment naming a forbidden symbol is the boundary being explained, not
 * violated. Comments are therefore stripped before matching.
 */
const codeOf = (rel: string) =>
  source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("R4-I1 Personal boundary (static)", () => {
  it.each(I1_FILES)("%s contains no Personal verification marker", (rel) => {
    const text = codeOf(rel);
    for (const marker of FORBIDDEN) {
      expect({ file: rel, marker, found: text.includes(marker) }).toEqual({ file: rel, marker, found: false });
    }
  });

  it("the shell reaches the shared R2 view directly, never through the Personal wrapper", () => {
    const shell = codeOf("components/workspace/projects/TeamClaimDetailShell.tsx");
    expect(shell).toContain('from "@/components/verification/ClaimVerificationResultView"');
    expect(shell).not.toMatch(/from "@\/components\/ClaimVerificationResult"/);
  });

  it("the hook and shell read only Team Workspace endpoints", () => {
    for (const rel of ["hooks/useTeamClaimVerification.ts", "components/workspace/projects/TeamClaimDetailShell.tsx"]) {
      const text = codeOf(rel);
      for (const literal of text.match(/["'`]\/api\/[^"'`]*/g) ?? []) {
        expect(literal.slice(1).startsWith("/api/workspaces/")).toBe(true);
      }
    }
  });

  it("uses `useAuth` only to obtain the caller's token identity, never as an authorization decision", () => {
    const shell = codeOf("components/workspace/projects/TeamClaimDetailShell.tsx");
    const hook = codeOf("hooks/useTeamClaimVerification.ts");
    // No capability/role/ownership reasoning is derived client-side.
    for (const text of [shell, hook]) {
      expect(text).not.toContain("user.email");
      expect(text).not.toContain("viewerEmail");
      expect(text).not.toContain("capabilities.includes");
      expect(text).not.toMatch(/\brole\b\s*===/);
      expect(text).not.toContain("userId ===");
    }
  });

  it("ships no export, clipboard or Verify-another action surface", () => {
    const shell = codeOf("components/workspace/projects/TeamClaimDetailShell.tsx");
    expect(shell).not.toContain("actionsSurface={");
    expect(shell).not.toContain("Verify another");
    expect(shell).not.toContain("download");
    expect(shell).not.toContain("clipboard");
  });

  it("performs no write: the I1 surface issues GET only", () => {
    for (const rel of ["hooks/useTeamClaimVerification.ts", "components/workspace/projects/TeamClaimDetailShell.tsx"]) {
      const text = codeOf(rel);
      expect(text).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/);
    }
  });

  it("the Server Component gates never hand the capability array to the client", () => {
    for (const rel of I1_FILES.filter((f) => f.startsWith("app/"))) {
      const text = codeOf(rel);
      expect(text).toContain('access.capabilities.includes("research.read")');
      // Only the single `audit.read` presentation hint crosses the boundary.
      expect(text).not.toMatch(/capabilities=\{/);
      expect(text).not.toContain("capabilities={access.capabilities}");
    }
  });
});
