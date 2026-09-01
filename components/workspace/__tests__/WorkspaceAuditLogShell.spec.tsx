/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — source-level tests for
 * `WorkspaceAuditLogShell.tsx`. This repo has no jsdom/@testing-library/react
 * (see `TopNav.spec.ts`'s established precedent, reused verbatim by
 * `WorkspaceMembersShell.spec.tsx`) — interactive/rendering behavior is
 * proven via `readFileSync` + regex against the real component source.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "WorkspaceAuditLogShell.tsx"), "utf8");

describe("WorkspaceAuditLogShell — event card content (AU, AV, AW, AX, AY)", () => {
  it("AU. renders 'Member removed' as the event heading", () => {
    expect(source).toMatch(/Member removed/);
  });

  it("AV. renders the target's resolved display name (event.target.displayName), never a raw uid field", () => {
    expect(source).toMatch(/event\.target\.displayName/);
    expect(source).not.toMatch(/targetUid|target\.uid/);
  });

  it("AW. renders the actor's resolved display name with a 'By:' label (event.actor.displayName), never a raw uid field", () => {
    expect(source).toMatch(/By:[\s\S]{0,60}event\.actor\.displayName/);
    expect(source).not.toMatch(/actorUid|actor\.uid/);
  });

  it("AX. renders the previous role via the local ROLE_LABEL map, never the raw lowercase role string directly", () => {
    expect(source).toMatch(/Previous role:[\s\S]{0,60}ROLE_LABEL\[event\.previousRole\]/);
  });

  it("AY. renders a formatted occurrence timestamp, guarded against an invalid date rather than crashing", () => {
    expect(source).toMatch(/function formatOccurredAt/);
    expect(source).toMatch(/Number\.isNaN\(parsed\.getTime\(\)\)/);
  });

  it("AZ. no raw UID/workspaceId/document-id field is ever referenced by the component (DTO allow-list is respected end-to-end)", () => {
    expect(source).not.toMatch(/event\.actorUid|event\.targetUid|event\.uid|event\.workspaceId|event\.id\b/);
  });
});

describe("WorkspaceAuditLogShell — states (loading, empty, error)", () => {
  it("BB. renders a distinct loading state", () => {
    expect(source).toMatch(/Loading audit log…/);
  });

  it("BA. renders the repository-consistent empty state", () => {
    expect(source).toMatch(/No Workspace activity yet\./);
  });

  it("BC. renders a safe generic error state with retry, via the established ReviewErrorState component", () => {
    expect(source).toMatch(/ReviewErrorState/);
    expect(source).toMatch(/onRetry=\{loadFirstPage\}/);
  });
});

describe("WorkspaceAuditLogShell — pagination (BD)", () => {
  it("Load more is only offered when hasMore is true, and is disabled while a page fetch is in flight", () => {
    expect(source).toMatch(/status === "ready" && hasMore/);
    expect(source).toMatch(/disabled=\{loadingMore\}/);
  });

  it("loadMore is a no-op without a nextCursor (never re-fetches the first page as 'more')", () => {
    const match = source.match(/const loadMore = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/if \(!authReady \|\| !nextCursor \|\| loadingMore\) return;/);
  });
});

describe("WorkspaceAuditLogShell — navigation (T, Q)", () => {
  it("cross-links back to the Members page for the same Workspace", () => {
    expect(source).toMatch(/\/workspace\/team\/\$\{encodeURIComponent\(workspaceId\)\}\/members/);
  });

  it("does not redirect into or import from the legacy /governance dashboard or lib/governance/ (components/teamGovernance/ is a separate, pre-existing shared UI namespace already reused by WorkspaceMembersShell — not the legacy AI-research Governance Dashboard)", () => {
    const importLines = source.split("\n").filter((line) => /^import /.test(line.trim()));
    for (const line of importLines) {
      expect(line).not.toMatch(/lib\/governance\/|components\/governance\//);
    }
    expect(source).not.toMatch(/href=["'`]\/governance/);
  });
});
