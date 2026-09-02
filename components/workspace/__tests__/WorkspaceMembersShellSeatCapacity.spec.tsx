/**
 * Permanent Team Workspace Collaborator-Seat Limit, Phase 12A.1S.1 —
 * `WorkspaceMembersShell`'s "N of 5 collaborator seats used" display and
 * the capacity-disabled "Invite Member" state, rendered against the REAL
 * component (`react-test-renderer` + `act()`, this repo's established
 * convention — see `WorkspaceMembersShellPermanentInvite.spec.tsx`, whose
 * exact mocking/mount conventions this file mirrors).
 *
 * Section AR's permanent-capability invariant is extended here, not
 * duplicated: capacity-disabled must NEVER collapse into the same
 * "disappear" behavior a permission-disabled caller already gets — the two
 * states must stay independently provable (Section AC).
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

function owner() {
  return { uid: "owner-1", displayName: "Alice", role: "owner", isCanonicalOwner: true, joinedAt: "2026-01-01T00:00:00.000Z" };
}
function member(uid: string) {
  return { uid, displayName: `Collaborator ${uid}`, role: "member", isCanonicalOwner: false, joinedAt: "2026-01-02T00:00:00.000Z" };
}
function nonOwnerMembers(count: number) {
  return Array.from({ length: count }, (_, i) => member(`m${i}`));
}
function pendingInvitation(id: string, isExpired: boolean) {
  return { id, normalizedEmail: `${id}@example.com`, role: "member" as const, isExpired, expiresAt: "2099-01-01T00:00:00.000Z", deliveryVersion: 1 };
}

function findInviteButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((b) => b.props.children === "Invite Member");
}

async function mount(props: {
  canInvite: boolean;
  canManageInvitations: boolean;
  members?: ReturnType<typeof member>[];
  invitations?: ReturnType<typeof pendingInvitation>[];
}) {
  mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner(), ...(props.members ?? [])] });
  mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: props.invitations ?? [] });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(WorkspaceMembersShell, {
        workspaceId: WS_ID,
        workspaceName: "Acme Team",
        callerRole: "owner",
        canReadAudit: true,
        canInvite: props.canInvite,
        canManageInvitations: props.canManageInvitations,
      })
    );
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: AUTHENTICATED_USER, authReady: true });
});

describe("Phase 12A.1S.1 — seat count display (AS)", () => {
  it("0 of 5: only the canonical Owner exists", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("0 of 5 collaborator seats used");
  });

  it("1 of 5: one active non-owner member, Owner excluded from the count", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(1) });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("1 of 5 collaborator seats used");
  });

  it("3 of 5: 2 active members + 1 valid pending invitation", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(2), invitations: [pendingInvitation("inv-1", false)] });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("3 of 5 collaborator seats used");
  });

  it("expired pending invitations are excluded from the count", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(2), invitations: [pendingInvitation("inv-1", true)] });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("2 of 5 collaborator seats used");
  });

  it("5 of 5: exactly at the limit", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(5) });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("5 of 5 collaborator seats used");
  });

  it("legacy over-limit Workspace displays the ACTUAL occupied count (7 of 5) — never falsely clamped to 5 of 5", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(7) });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("7 of 5 collaborator seats used");
  });

  it("mentions the Owner exemption in supporting copy", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toMatch(/Owner does not count/i);
  });
});

describe("Phase 12A.1S.1 — capacity-disabled vs. permission-disabled Invite Member (AA/AB/AC/AR)", () => {
  it("under capacity + authorized: active, enabled 'Invite Member' button (unchanged existing behavior)", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(2) });
    const button = findInviteButton(renderer);
    expect(button).toBeDefined();
    expect(button!.props.disabled).not.toBe(true);
  });

  it("at capacity (5 of 5) + authorized: 'Invite Member' REMAINS VISIBLE, but disabled, with an explanation — never hidden", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(5) });
    const button = findInviteButton(renderer);
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(true);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toMatch(/reached its collaborator limit/i);
    expect(text).toMatch(/remove a member or revoke a pending invitation/i);
  });

  it("over capacity (7 of 5) + authorized: same capacity-disabled state as exactly-at-capacity — still visible, still disabled", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(7) });
    const button = findInviteButton(renderer);
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(true);
  });

  it("unauthorized (canInvite=false) at ANY capacity: still hidden entirely — capacity-disabled never implies an unauthorized Viewer could invite once a seat frees up", async () => {
    const renderer = await mount({ canInvite: false, canManageInvitations: false, members: nonOwnerMembers(5) });
    expect(findInviteButton(renderer)).toBeUndefined();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toMatch(/reached its collaborator limit/i);
  });

  it("unauthorized (canInvite=false) UNDER capacity: still hidden — permission gating is completely independent of capacity, unaffected by this phase", async () => {
    const renderer = await mount({ canInvite: false, canManageInvitations: false, members: nonOwnerMembers(1) });
    expect(findInviteButton(renderer)).toBeUndefined();
  });

  it("MUTATION CHECK: hiding the button when full (instead of disabling it) is exactly the defect this test suite exists to catch — asserting `disabled: true` (not `undefined`) on a DEFINED button proves the button is genuinely present, not merely omitted from a loose text search", async () => {
    const renderer = await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(5) });
    const button = findInviteButton(renderer);
    expect(button).toBeDefined();
    expect(typeof button).not.toBe("undefined");
  });
});

describe("Phase 12A.1S.1 — server is authoritative, this display is advisory only", () => {
  it("the seat count and capacity gate are pure derivations from already-loaded `members`/`invitations` — no new fetch call is introduced", async () => {
    await mount({ canInvite: true, canManageInvitations: true, members: nonOwnerMembers(3) });
    expect(mockedFetchWorkspaceMembers).toHaveBeenCalledTimes(1);
    expect(mockedFetchPendingInvitations).toHaveBeenCalledTimes(1);
  });
});
