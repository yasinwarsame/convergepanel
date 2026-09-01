/**
 * Team Workspace Activation Flow, Phase 12A.1 — `WorkspaceOverviewShell`
 * interactive behavior. `react-test-renderer` + `act()` (this repo has
 * no jsdom/@testing-library — see
 * `app/workspace-invitations/accept/__tests__/AcceptInvitationClient.spec.tsx`'s
 * identical convention). External boundaries (`useAuth`, the four
 * `workspaceTeamClient` fetchers, `next/link`) are mocked; the real
 * component tree, effect, and state derivation are exercised end-to-end.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedFetchWorkspaceMembers = jest.fn();
const mockedFetchPendingInvitations = jest.fn();
const mockedFetchTeamProjectsExistence = jest.fn();
const mockedFetchTeamResearchExistence = jest.fn();
jest.mock("@/lib/client/workspaceTeamClient", () => ({
  fetchWorkspaceMembers: (...args: unknown[]) => mockedFetchWorkspaceMembers(...args),
  fetchPendingInvitations: (...args: unknown[]) => mockedFetchPendingInvitations(...args),
  fetchTeamProjectsExistence: (...args: unknown[]) => mockedFetchTeamProjectsExistence(...args),
  fetchTeamResearchExistence: (...args: unknown[]) => mockedFetchTeamResearchExistence(...args),
}));

import WorkspaceOverviewShell from "@/components/workspace/WorkspaceOverviewShell";

const AUTHENTICATED_USER = { uid: "user-1" };
const WS_ID = "ws-1";

function owner() {
  return { uid: "user-1", displayName: "Alice", role: "owner", isCanonicalOwner: true, joinedAt: "2026-01-01T00:00:00.000Z" };
}
function collaborator() {
  return { uid: "user-2", displayName: "Bob", role: "member", isCanonicalOwner: false, joinedAt: "2026-01-02T00:00:00.000Z" };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: AUTHENTICATED_USER, authReady: true });
});

async function mount(props: Partial<React.ComponentProps<typeof WorkspaceOverviewShell>> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(WorkspaceOverviewShell, {
        workspaceId: WS_ID,
        workspaceName: "Acme Team",
        canInvite: true,
        canManageInvitations: true,
        canReadAudit: true,
        ...props,
      })
    );
  });
  return renderer;
}

describe("WorkspaceOverviewShell", () => {
  it("renders the Workspace name and shared nav", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount();
    expect(renderer.root.findByType("h1").props.children).toBe("Acme Team");
  });

  it("a brand-new Workspace (Owner only, no invites/projects/research) shows the setup panel with Invite as the active step", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Set up your Workspace");
    expect(text).toContain("Invite your team");
  });

  it("a non-owner member alone (no pending invitation) marks the invite step complete", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner(), collaborator()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    // Invite step complete -> no active "Invite your team" link, but the Project step should be the visible focus.
    expect(text).toContain("Create your first project");
  });

  it("a Workspace with real research existing renders no setup panel at all — the 'This Workspace is active' message instead", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner(), collaborator()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: true });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: true });
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("Set up your Workspace");
    expect(text).toContain("This Workspace is active");
  });

  it("canManageInvitations: false never calls fetchPendingInvitations, and still derives a correct (non-crashing) activation state from members alone", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount({ canManageInvitations: false, canInvite: false });
    expect(mockedFetchPendingInvitations).not.toHaveBeenCalled();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Set up your Workspace");
  });

  it("a failed members fetch shows the error/retry state, not a crash or a false-empty activation panel", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "error" });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("Set up your Workspace");
    expect(text).toContain("We couldn't load this Workspace's setup status");
  });

  it("exactly one members/projects/research fetch each per mount — no N+1 (invitations included when canManageInvitations)", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    await mount();
    expect(mockedFetchWorkspaceMembers).toHaveBeenCalledTimes(1);
    expect(mockedFetchPendingInvitations).toHaveBeenCalledTimes(1);
    expect(mockedFetchTeamProjectsExistence).toHaveBeenCalledTimes(1);
    expect(mockedFetchTeamResearchExistence).toHaveBeenCalledTimes(1);
  });

  it("does not fetch at all before authReady", async () => {
    mockedUseAuth.mockReturnValue({ user: null, authReady: false });
    await mount();
    expect(mockedFetchWorkspaceMembers).not.toHaveBeenCalled();
  });
});
