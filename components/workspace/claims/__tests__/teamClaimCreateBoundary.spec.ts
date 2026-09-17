/**
 * TEAM-VERIFICATION-PARITY-R4-I3 §AC — STATIC ordinary-mode boundary.
 *
 * Proves structurally that the creation surface is ORDINARY mode only and
 * touches no Personal stack, so a future edit cannot introduce origin-linked
 * fields or a Personal endpoint along a path no test exercises.
 *
 * Comments are stripped: these files deliberately document the modes and
 * endpoints they must never use.
 */

import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..", "..");

const I3_FILES = [
  "lib/workspaces/teamClaimCreateHref.ts",
  "hooks/useTeamClaimVerificationCreate.ts",
  "components/workspace/claims/TeamClaimComposerShell.tsx",
  "app/workspace/team/[workspaceId]/claims/new/page.tsx",
  "app/workspace/team/[workspaceId]/projects/[projectId]/claims/new/page.tsx",
];

const FORBIDDEN = [
  "/api/verify-claim",
  "/api/user/",
  "run-governance",
  "panel-history",
  "/api/governance/",
  "buildOriginLinkedVerifyClaimRequestBody",
  "originLinkedTarget",
  "FileAttachButton",
  "generateVerificationMemo",
  "VerificationActions",
  "personalResearchHref",
  "?tab=verify",
];

const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOf = (rel: string) =>
  source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("R4-I3 ordinary-mode boundary (static)", () => {
  it.each(I3_FILES)("%s contains no Personal or origin-linked marker", (rel) => {
    const text = codeOf(rel);
    for (const marker of FORBIDDEN) {
      expect({ file: rel, marker, found: text.includes(marker) }).toEqual({ file: rel, marker, found: false });
    }
  });

  it("never mounts a Claim result renderer — the detail page owns that", () => {
    for (const rel of I3_FILES) {
      expect(codeOf(rel)).not.toMatch(/from "@\/components\/ClaimVerificationResult"/);
      expect(codeOf(rel)).not.toMatch(/from "@\/components\/verification\/ClaimVerificationResultView"/);
    }
  });

  it("constructs no origin-linked request fields", () => {
    const hook = codeOf("hooks/useTeamClaimVerificationCreate.ts");
    // `runId`/`claimId` may not appear in request construction at all.
    expect(hook).not.toMatch(/runId\s*:/);
    expect(hook).not.toMatch(/claimId\s*:/);
  });

  it("POSTs only the Team Workspace verifications endpoint", () => {
    for (const rel of I3_FILES) {
      for (const literal of codeOf(rel).match(/["'`]\/api\/[^"'`]*/g) ?? []) {
        expect(literal.slice(1).startsWith("/api/workspaces/")).toBe(true);
      }
    }
    expect(codeOf("hooks/useTeamClaimVerificationCreate.ts")).toContain("/verifications`");
  });

  it("uses only POST for the mutation and issues no other write verb", () => {
    const hook = codeOf("hooks/useTeamClaimVerificationCreate.ts");
    expect(hook).toMatch(/method:\s*"POST"/);
    expect(hook).not.toMatch(/method:\s*["'`](PUT|PATCH|DELETE)["'`]/);
  });

  it("derives no authorization decision client-side", () => {
    for (const rel of ["hooks/useTeamClaimVerificationCreate.ts", "components/workspace/claims/TeamClaimComposerShell.tsx"]) {
      const text = codeOf(rel);
      expect(text).not.toContain("capabilities.includes");
      expect(text).not.toMatch(/\brole\b\s*===/);
      expect(text).not.toContain("userId ===");
    }
  });

  it("ships no attachment surface in I3", () => {
    const shell = codeOf("components/workspace/claims/TeamClaimComposerShell.tsx");
    for (const marker of ["FileAttach", "type=\"file\"", "accept=", "FileReader"]) {
      expect(shell).not.toContain(marker);
    }
  });

  it("builds both creation and success destinations through the shared builders", () => {
    const shell = codeOf("components/workspace/claims/TeamClaimComposerShell.tsx");
    expect(shell).toContain("teamClaimDetailHref(");
    expect(shell).toContain("router.replace(");
    expect(shell).not.toContain("router.push(");
  });

  it("the Project creation gate requires both capabilities and an active Project", () => {
    const page = codeOf("app/workspace/team/[workspaceId]/projects/[projectId]/claims/new/page.tsx");
    expect(page).toContain('access.capabilities.includes("research.create")');
    expect(page).toContain('access.capabilities.includes("research.organize")');
    expect(page).toContain('projectResult.project.status !== "active"');
  });
});
