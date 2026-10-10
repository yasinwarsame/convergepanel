/**
 * Order 3 — the audit page passes the SERVER-ONLY review-integrity flag to the
 * shell as a boolean prop (the raw env value is never sent), and only after
 * the page's own audit.read gate.
 */
let reviewIntegrityFlag = false;
jest.mock("@/lib/env", () => ({
  WORKSPACE_GOVERNANCE_SUMMARY_ENABLED: false,
  get WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED() {
    return reviewIntegrityFlag;
  },
}));
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
jest.mock("@/components/workspace/WorkspaceAuditLogShell", () => ({ __esModule: true, default: (props: unknown) => ({ __mockShell: true, props }) }));

import WorkspaceAuditLogPage from "@/app/workspace/team/[workspaceId]/audit/page";

const grantedOwner = { granted: true, workspaceType: "team", workspace: { id: "ws-1", name: "Acme" }, capabilities: ["audit.read", "members.read"] };

beforeEach(() => {
  jest.clearAllMocks();
  mockedIdentity.mockResolvedValue({ uid: "u1" });
  mockedAccess.mockResolvedValue(grantedOwner);
});

it.each([false, true])("flag %s → showReviewIntegrityMetrics === %s (a plain boolean)", async (value) => {
  reviewIntegrityFlag = value;
  const el = (await WorkspaceAuditLogPage({ params: { workspaceId: "ws-1" } })) as { props: { showReviewIntegrityMetrics: unknown; showGovernanceSummary: unknown } };
  expect(el.props.showReviewIntegrityMetrics).toBe(value);
  expect(el.props.showGovernanceSummary).toBe(false);
});

it("without audit.read the page is notFound and the shell is never built, flag on or not", async () => {
  reviewIntegrityFlag = true;
  mockedAccess.mockResolvedValue({ ...grantedOwner, capabilities: ["reviews.read"] });
  await expect(WorkspaceAuditLogPage({ params: { workspaceId: "ws-1" } })).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
});
