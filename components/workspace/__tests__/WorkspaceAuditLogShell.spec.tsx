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

describe("WorkspaceAuditLogShell — ownership-transfer event card content, Phase TEAM-MGMT-12C", () => {
  it("renders 'Ownership transferred' as the event heading, branching on event.eventType", () => {
    expect(source).toMatch(/event\.eventType === "workspace_member_removed"/);
    expect(source).toMatch(/Ownership transferred/);
  });

  it("renders the actor's and target's resolved display names, never a raw uid field, for the transfer branch", () => {
    const transferBranch = source.slice(source.indexOf("Ownership transferred") - 50);
    expect(transferBranch).toMatch(/event\.actor\.displayName/);
    expect(transferBranch).toMatch(/event\.target\.displayName/);
  });

  it("renders the new Owner's previous role via the shared ROLE_LABEL map, never the raw lowercase role string directly", () => {
    const transferBranch = source.slice(source.indexOf("Ownership transferred") - 50);
    expect(transferBranch).toMatch(/ROLE_LABEL\[event\.previousRole\]/);
  });

  it("no raw UID/workspaceId/document-id field is referenced in the transfer branch either (DTO allow-list respected end-to-end)", () => {
    const transferBranch = source.slice(source.indexOf("Ownership transferred") - 50, source.indexOf("Ownership transferred") + 1500);
    expect(transferBranch).not.toMatch(/event\.actorUid|event\.targetUid|event\.uid|event\.workspaceId|event\.id\b/);
  });
});

describe("WorkspaceAuditLogShell — role-changed event card content, Phase 12B", () => {
  it("renders 'Role changed' as the event heading, as the else-branch of a three-way discrimination on event.eventType", () => {
    expect(source).toMatch(/event\.eventType === "workspace_member_removed"/);
    expect(source).toMatch(/event\.eventType === "workspace_ownership_transferred"/);
    expect(source).toMatch(/Role changed/);
  });

  it("renders the target's resolved display name, never a raw uid field, for the role-changed branch", () => {
    const roleChangedBranch = source.slice(source.indexOf("Role changed") - 50);
    expect(roleChangedBranch).toMatch(/event\.target\.displayName/);
  });

  it("renders both the previous role and the new role via the shared ROLE_LABEL map, never a raw lowercase role string directly", () => {
    const roleChangedBranch = source.slice(source.indexOf("Role changed") - 50, source.indexOf("Role changed") + 800);
    expect(roleChangedBranch).toMatch(/ROLE_LABEL\[event\.previousRole\]/);
    expect(roleChangedBranch).toMatch(/ROLE_LABEL\[event\.newRole\]/);
  });

  it("renders the actor's resolved display name with a 'By:' label for the role-changed branch", () => {
    const roleChangedBranch = source.slice(source.indexOf("Role changed") - 50, source.indexOf("Role changed") + 1500);
    expect(roleChangedBranch).toMatch(/By:[\s\S]{0,60}event\.actor\.displayName/);
  });

  it("no raw UID/workspaceId/document-id field is referenced in the role-changed branch either (DTO allow-list respected end-to-end)", () => {
    const roleChangedBranch = source.slice(source.indexOf("Role changed") - 50, source.indexOf("Role changed") + 1500);
    expect(roleChangedBranch).not.toMatch(/event\.actorUid|event\.targetUid|event\.uid|event\.workspaceId|event\.id\b/);
  });
});

describe("WorkspaceAuditLogShell — navigation (T, Q)", () => {
  it("Phase 12A.1 — cross-links back to Members/Overview via the shared WorkspaceNav, not a locally-duplicated tab strip", () => {
    expect(source).toMatch(/import WorkspaceNav from ["']@\/components\/workspace\/WorkspaceNav["'];/);
    expect(source).toMatch(/<WorkspaceNav workspaceId=\{workspaceId\} active="audit" showAudit \/>/);
    // The old locally-duplicated <nav> markup must be gone — WorkspaceNav owns it now.
    expect(source).not.toMatch(/<nav className="mb-6 flex gap-4/);
  });

  it("does not redirect into or import from the legacy /governance dashboard or lib/governance/ (components/teamGovernance/ is a separate, pre-existing shared UI namespace already reused by WorkspaceMembersShell — not the legacy AI-research Governance Dashboard)", () => {
    const importLines = source.split("\n").filter((line) => /^import /.test(line.trim()));
    for (const line of importLines) {
      expect(line).not.toMatch(/lib\/governance\/|components\/governance\//);
    }
    expect(source).not.toMatch(/href=["'`]\/governance/);
  });
});

describe("WorkspaceAuditLogShell — Project lifecycle event cards, Phase PROJECT-AUDIT-AR-I1", () => {
  const archivedBranch = source.match(/event\.eventType === "workspace_project_archived" \? \(([\s\S]*?)\) : event\.eventType === "workspace_project_restored"/)?.[1] ?? "";
  const restoredBranch = source.match(/event\.eventType === "workspace_project_restored" \? \(([\s\S]*?)\) : \(/)?.[1] ?? "";

  it("discriminates on BOTH new event types, each as its own branch, leaving the role-changed branch as the final else", () => {
    expect(archivedBranch).not.toBe("");
    expect(restoredBranch).not.toBe("");
    expect(source).toMatch(/\) : \(\s*<>\s*<p className="text-sm font-medium text-cp-text">Role changed<\/p>/);
  });

  it("archived: heading 'Project archived', body '<name> was archived.', actor with 'By:' label, formatted timestamp", () => {
    expect(archivedBranch).toMatch(/Project archived/);
    expect(archivedBranch).toMatch(/\{event\.project\.name\}<\/span> was archived\./);
    expect(archivedBranch).toMatch(/By:[\s\S]{0,60}event\.actor\.displayName/);
    expect(archivedBranch).toMatch(/formatOccurredAt\(event\.occurredAt\)/);
  });

  it("restored: heading 'Project restored', body '<name> was restored.', actor with 'By:' label, formatted timestamp", () => {
    expect(restoredBranch).toMatch(/Project restored/);
    expect(restoredBranch).toMatch(/\{event\.project\.name\}<\/span> was restored\./);
    expect(restoredBranch).toMatch(/By:[\s\S]{0,60}event\.actor\.displayName/);
    expect(restoredBranch).toMatch(/formatOccurredAt\(event\.occurredAt\)/);
  });

  it("long Project names wrap inside the card (break-words on the body line) rather than overflowing", () => {
    expect(archivedBranch).toMatch(/className="mt-1 break-words text-sm text-cp-muted"/);
    expect(restoredBranch).toMatch(/className="mt-1 break-words text-sm text-cp-muted"/);
  });

  it("Project branches never reference role labels or a member target — the Project shape is rendered as itself, not forced through the member schema", () => {
    for (const branch of [archivedBranch, restoredBranch]) {
      expect(branch).not.toMatch(/ROLE_LABEL|previousRole|newRole|event\.target/);
    }
  });

  it("no raw projectId, actorUid, workspaceId, or document id is referenced anywhere in the component (AZ guard extended to Project fields)", () => {
    expect(source).not.toMatch(/event\.actorUid|event\.targetUid|event\.uid|event\.workspaceId|event\.id\b|event\.projectId|project\.id\b/);
  });

  it("no Project link, filter, or archive/restore control was added — audit rendering only", () => {
    expect(source).not.toMatch(/href=\{`\/workspace\/team\/[^`]*projects/);
    expect(source).not.toMatch(/archiveProject|restoreProject|onArchive|onRestore|<select/);
  });

  it("the actor fallback for an unresolved actor is server-provided ('Unknown user' comes from the DTO, the component never invents one)", () => {
    expect(source).not.toMatch(/Unknown user/);
    expect(source).toMatch(/event\.actor\.displayName/);
  });
});

