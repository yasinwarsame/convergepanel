/**
 * Team Workspace Activation Flow, Phase 12A.1 — source-level regression
 * tests for `TeamWorkspacesLanding.tsx`'s post-create redirect. This repo
 * has no jsdom/@testing-library/react (see
 * `WorkspaceMembersShell.spec.tsx`'s identical precedent) — interactive
 * behavior here is proven via `readFileSync` + regex against the real
 * component source, extracting `handleCreate`'s exact function body and
 * asserting on the branching around `result.status`.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "TeamWorkspacesLanding.tsx"), "utf8");

function extractHandleCreate(): string {
  const match = source.match(/const handleCreate = useCallback\(\s*async[\s\S]*?\n    \},\n    \[/);
  expect(match).not.toBeNull();
  return match![0];
}

describe("TeamWorkspacesLanding — imports useRouter from next/navigation", () => {
  it("imports useRouter and calls it in the component body", () => {
    expect(source).toMatch(/import \{ useRouter \} from ["']next\/navigation["'];/);
    expect(source).toMatch(/const router = useRouter\(\);/);
  });
});

describe("TeamWorkspacesLanding — handleCreate success navigates using the authoritative response workspaceId", () => {
  const handleCreate = extractHandleCreate();

  it("successful creation ('ok') navigates to /workspace/team/{result.workspace.workspaceId} — never inferred from the name or the list", () => {
    const okBranch = handleCreate.match(/if \(result\.status === "ok"\) \{([\s\S]*?)\} else if/);
    expect(okBranch).not.toBeNull();
    expect(okBranch![1]).toMatch(/router\.push\(`\/workspace\/team\/\$\{encodeURIComponent\(result\.workspace\.workspaceId\)\}`\);/);
  });

  it("successful creation no longer re-queries the Workspace list in place of navigating away", () => {
    const okBranch = handleCreate.match(/if \(result\.status === "ok"\) \{([\s\S]*?)\} else if/);
    expect(okBranch).not.toBeNull();
    expect(okBranch![1]).not.toMatch(/runQuery\(\);/);
  });

  it("invalid_name failure never calls router.push", () => {
    const invalidNameBranch = handleCreate.match(/else if \(result\.status === "invalid_name"\) \{([\s\S]*?)\} else \{/);
    expect(invalidNameBranch).not.toBeNull();
    expect(invalidNameBranch![1]).not.toMatch(/router\.push/);
  });

  it("generic error failure never calls router.push", () => {
    const genericErrorBranch = handleCreate.match(/\} else \{\s*setCreateError\("We couldn't create your Workspace\. Please try again\."\);\s*\}/);
    expect(genericErrorBranch).not.toBeNull();
    expect(genericErrorBranch![0]).not.toMatch(/router\.push/);
  });
});
