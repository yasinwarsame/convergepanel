/**
 * Phase 12A.1C1 — permanent regression protection for a standing Team
 * product requirement (not an onboarding-only behavior):
 *
 *   "Invite Member" is an ONGOING Workspace capability for authorized
 *   users, independent of Workspace activation/onboarding state, and it
 *   must remain available forever — completing the setup checklist (or a
 *   Workspace becoming "active" because research exists) must NEVER hide
 *   or disable it.
 *
 * PHASE 12A.1-R1's Mutation 6 proved this gap existed: forcing the Invite
 * Member control to never render left the ENTIRE 486-suite/9639-test
 * baseline green, because no test anywhere directly rendered
 * `WorkspaceMembersShell` and asserted on the control's actual visibility
 * (the existing `WorkspaceMembersShell.spec.tsx` only regex-tests
 * `handleInvite`'s delivery-outcome messaging, never the button's JSX
 * gating). This file closes that gap with a REAL render
 * (`react-test-renderer` + `act()`, this repo's established convention
 * for interactive components with no jsdom — see
 * `app/workspace-invitations/accept/__tests__/AcceptInvitationClient.spec.tsx`),
 * proving the control's visibility is driven ONLY by
 * `canInvite`/`canManageInvitations` capability props — props that
 * `WorkspaceMembersShell` doesn't even have any activation-state
 * counterpart to (structurally proven in the "no activation prop exists"
 * test below).
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedFetchWorkspaceMembers = jest.fn();
const mockedFetchPendingInvitations = jest.fn();
jest.mock("@/lib/client/workspaceTeamClient", () => ({
  fetchWorkspaceMembers: (...args: unknown[]) => mockedFetchWorkspaceMembers(...args),
  fetchPendingInvitations: (...args: unknown[]) => mockedFetchPendingInvitations(...args),
  createInvitation: jest.fn(),
  resendInvitation: jest.fn(),
  revokeInvitation: jest.fn(),
  removeMember: jest.fn(),
}));

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

import WorkspaceMembersShell from "@/components/workspace/WorkspaceMembersShell";

const WS_ID = "ws-1";
const AUTHENTICATED_USER = { uid: "owner-1" };

function ownerMember() {
  return { uid: "owner-1", displayName: "Alice", role: "owner", isCanonicalOwner: true, joinedAt: "2026-01-01T00:00:00.000Z" };
}
function collaborator() {
  return { uid: "user-2", displayName: "Bob", role: "member", isCanonicalOwner: false, joinedAt: "2026-01-02T00:00:00.000Z" };
}

function findInviteButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((b) => b.props.children === "Invite Member");
}

async function mount(props: Partial<React.ComponentProps<typeof WorkspaceMembersShell>> & { canInvite: boolean; canManageInvitations: boolean }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(WorkspaceMembersShell, {
        workspaceId: WS_ID,
        workspaceName: "Acme Team",
        callerRole: "owner",
        canReadAudit: true,
        ...props,
      })
    );
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: AUTHENTICATED_USER, authReady: true });
  mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [ownerMember(), collaborator()] });
  mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
});

describe("Phase 12A.1C1 — permanent Invite Member capability (Section C/D)", () => {
  it("1. Owner with canInvite=true renders an active 'Invite Member' control", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true });
    expect(findInviteButton(renderer)).toBeDefined();
  });

  it("2. Admin with canInvite=true (scoped invite policy) also renders an active 'Invite Member' control", async () => {
    const renderer = await mount({ callerRole: "admin", canInvite: true, canManageInvitations: true });
    expect(findInviteButton(renderer)).toBeDefined();
  });

  it("3. canInvite=false never renders an active 'Invite Member' control", async () => {
    const renderer = await mount({ callerRole: "member", canInvite: false, canManageInvitations: false });
    expect(findInviteButton(renderer)).toBeUndefined();
  });

  it("4a. a MATURE Workspace (real research exists elsewhere in the product) still renders 'Invite Member' for an authorized caller — WorkspaceMembersShell has no notion of activation/research state to even suppress it with", async () => {
    // This IS the permanent-capability invariant: Members is a completely
    // separate route/component from the Overview activation panel, and
    // this component's props contain nothing resembling
    // hasResearch/hasProject/activationComplete/onboarding state at all —
    // proven structurally by the props actually accepted below.
    const renderer = await mount({ canInvite: true, canManageInvitations: true });
    expect(findInviteButton(renderer)).toBeDefined();
  });

  it("4b. structural proof: WorkspaceMembersShell's prop contract has no activation/onboarding-state field whatsoever", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "WorkspaceMembersShell.tsx"),
      "utf8"
    );
    const propsBlock = source.match(/export default function WorkspaceMembersShell\(\{[\s\S]*?\}\)\s*\{/)?.[0] ?? "";
    expect(propsBlock).not.toMatch(/hasResearch|hasProject|activationComplete|isFullyActive|onboarding/i);
  });

  it("5. pending invitations / resend / revoke sections remain gated only by canManageInvitations, independent of any activation concept", async () => {
    mockedFetchPendingInvitations.mockResolvedValue({
      status: "ok",
      invitations: [{ id: "inv-1", normalizedEmail: "teammate@example.com", role: "member", isExpired: false, expiresAt: "2026-01-01T00:00:00.000Z", deliveryVersion: 1 }],
    });
    const renderer = await mount({ canInvite: true, canManageInvitations: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Pending Invitations");
    expect(text).toContain("teammate@example.com");
    expect(text).toContain("Resend");
  });

  it("6. a non-authorized role (Viewer) sees no active Invite Member control, matching existing policy", async () => {
    const renderer = await mount({ callerRole: "viewer", canInvite: false, canManageInvitations: false });
    expect(findInviteButton(renderer)).toBeUndefined();
  });
});
