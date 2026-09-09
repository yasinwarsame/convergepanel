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

/**
 * Phase 12A.1C1 — fixed, non-"today"-relative fixture: `isExpired` is the
 * server's own canonical field (see `WorkspaceInvitationItem`), never
 * recomputed from `expiresAt` here, so there is no date-boundary
 * fragility in these tests.
 */
function invitation({ expired = false }: { expired?: boolean } = {}) {
  return {
    id: expired ? "inv-expired" : "inv-valid",
    normalizedEmail: "teammate@example.com",
    role: "member",
    isExpired: expired,
    expiresAt: "2026-01-01T00:00:00.000Z",
    deliveryVersion: 1,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: AUTHENTICATED_USER, authReady: true });
});

/**
 * Phase 12A.1C1 — precise check for the ACTIVE "Invite your team" action
 * link specifically (as opposed to the always-present row label text, or
 * WorkspaceNav's unrelated "Members" link), by inspecting real rendered
 * `<a>` elements rather than substring-matching the whole tree.
 */
function activeInviteLinkExists(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAllByType("a").some((el) => {
    const children = el.props.children;
    return children === "Invite your team" || (Array.isArray(children) && children.join("") === "Invite your team");
  });
}

async function mount(props: Partial<React.ComponentProps<typeof WorkspaceOverviewShell>> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(WorkspaceOverviewShell, {
        workspaceId: WS_ID,
        workspaceName: "Acme Team",
        canInvite: true,
        canManageInvitations: true,
        canCreateProject: true,
        canStartResearch: true,
        canReadAudit: true,
        ...props,
      })
    );
  });
  return renderer;
}

describe("WorkspaceOverviewShell", () => {
  it("renders the page-name heading and shared nav (Phase 11B.3: the Workspace name moved to the breadcrumb)", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount();
    // Phase 11B.3 — the h1 now names the PAGE; the Workspace name is the
    // breadcrumb's first segment, so it is no longer repeated as a heading.
    expect(renderer.root.findByType("h1").props.children).toBe("Overview");
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

  it("a non-owner member alone (no pending invitation) marks the invite step complete — no active Invite link remains", async () => {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner(), collaborator()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
    const renderer = await mount();
    expect(activeInviteLinkExists(renderer)).toBe(false);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Create your first project");
  });

  describe("Phase 12A.1C1 — expired-invitation activation matrix (Section H)", () => {
    it("1. Owner only, no invitations -> Invite incomplete (active link present)", async () => {
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(true);
    });

    it("2. a currently-valid (non-expired) pending invitation alone -> Invite complete", async () => {
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [invitation({ expired: false })] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(false);
    });

    it("3. an EXPIRED pending invitation only (no other member) -> Invite remains INCOMPLETE (the exact 12A.1-R1 gap this correction closes)", async () => {
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [invitation({ expired: true })] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(true);
    });

    it("4. a revoked invitation never appears in the pending list at all (server-side filtering) -> reduces to the empty-list case -> Invite incomplete", async () => {
      // listWorkspaceInvitations only ever returns status:"pending" records —
      // a revoked invitation is structurally absent from this response, not
      // present-but-flagged. Simulating the empty list IS the correct
      // simulation of "only a revoked invitation exists."
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(true);
    });

    it("5. an accepted invitation record (now inactive as a pending item) without an active non-owner member does not independently complete the step", async () => {
      // An accepted invitation becomes a membership and drops out of the
      // pending list — identical simulation to (4): empty pending list,
      // Owner-only membership.
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(true);
    });

    it("6. an active non-owner member -> Invite complete regardless of invitation history", async () => {
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner(), collaborator()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(false);
    });

    it("7. an EXPIRED invitation coexisting with an active non-owner member -> Invite complete because the collaborator exists", async () => {
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner(), collaborator()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [invitation({ expired: true })] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(false);
    });

    it("an expired invitation mixed with a still-valid one -> Invite complete (at least one currently-valid invitation exists)", async () => {
      mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
      mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [invitation({ expired: true }), invitation({ expired: false })] });
      mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: false });
      mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: false });
      const renderer = await mount();
      expect(activeInviteLinkExists(renderer)).toBe(false);
    });
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

/* ------------------------------------------------------------------ *
 * Phase 11B.3 — Breadcrumb inspection helpers.
 *
 * The REAL `Breadcrumb` is rendered (never mocked), so these read the shipped
 * component's own markup: its `<nav aria-label="Breadcrumb">` landmark, the
 * desktop `<ol>` hierarchy, and the separate mobile parent affordance.
 * `aria-hidden` nodes (the "/" separators and the "←" glyph) are excluded, so a
 * label assertion can never accidentally pass on decorative text.
 * ------------------------------------------------------------------ */
type BcSeg = { label: string; href?: string; current: boolean };

function visibleTextOf(node: TestRenderer.ReactTestInstance): string {
  const out: string[] = [];
  const walk = (n: TestRenderer.ReactTestInstance) => {
    n.children.forEach((c) => {
      if (typeof c === "string") out.push(c);
      else if (c.props?.["aria-hidden"] !== "true") walk(c);
    });
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
}

function breadcrumbNav(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === "Breadcrumb", { deep: true });
}

function bcSegments(r: TestRenderer.ReactTestRenderer): BcSeg[] {
  const navs = breadcrumbNav(r);
  if (navs.length === 0) return [];
  const ol = navs[0].findAllByType("ol")[0];
  return ol.findAllByType("li").map((li) => {
    const el = li.findAll((n) => (n.type === "a" || n.type === "span") && n.props?.["aria-hidden"] !== "true", { deep: true })[0];
    return {
      label: visibleTextOf(el),
      href: el.type === "a" ? String(el.props.href) : undefined,
      current: el.props["aria-current"] === "page",
    };
  });
}

function bcMobileParent(r: TestRenderer.ReactTestRenderer): { label: string; href?: string } | null {
  const navs = breadcrumbNav(r);
  if (navs.length === 0) return null;
  const wrap = navs[0].findAll(
    (n) => n.type === "div" && typeof n.props?.className === "string" && n.props.className.includes("sm:hidden"),
    { deep: true }
  );
  if (wrap.length === 0) return null;
  const el = wrap[0].findAll((n) => n.type === "a" || n.type === "span", { deep: true })[0];
  return { label: visibleTextOf(el), href: el.type === "a" ? String(el.props.href) : undefined };
}

function h1Texts(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root.findAllByType("h1").map(visibleTextOf);
}

describe("Phase 11B.3 — Overview breadcrumb", () => {
  const WS = "ws_123";
  const NAME = "Acme Risk Lab";

  async function mountOverview(workspaceId = WS, workspaceName = NAME) {
    mockedFetchWorkspaceMembers.mockResolvedValue({ status: "ok", members: [owner()] });
    mockedFetchPendingInvitations.mockResolvedValue({ status: "ok", invitations: [] });
    mockedFetchTeamProjectsExistence.mockResolvedValue({ status: "ok", hasAny: true });
    mockedFetchTeamResearchExistence.mockResolvedValue({ status: "ok", hasAny: true });
    return mount({ workspaceId, workspaceName });
  }

  it("Y1 — desktop hierarchy is exactly {Workspace name} / Overview, with Overview current and the Workspace segment linked", async () => {
    const segs = bcSegments(await mountOverview());
    expect(segs).toEqual([
      { label: NAME, href: `/workspace/team/${WS}`, current: false },
      { label: "Overview", href: undefined, current: true },
    ]);
  });

  it("Y2 — exactly ONE breadcrumb segment is aria-current, and it is the final one", async () => {
    const segs = bcSegments(await mountOverview());
    expect(segs.filter((x) => x.current)).toHaveLength(1);
    expect(segs[segs.length - 1].current).toBe(true);
  });

  it("Y3 — NON-VACUITY: the Workspace label is the NAME, and the raw workspaceId is never visible breadcrumb text", async () => {
    const segs = bcSegments(await mountOverview());
    expect(segs.map((x) => x.label)).toEqual([NAME, "Overview"]);
    expect(segs.map((x) => x.label)).not.toContain(WS);
    // the id is legitimate INSIDE the href, and nowhere else
    expect(segs[0].href).toContain(WS);
  });

  it("Y4 — Overview has NO mobileParent: /workspace/team is gated by resolveTeamWorkspacesMode() while this page is not, so a member outside the rollout would be sent to notFound()", async () => {
    expect(bcMobileParent(await mountOverview())).toBeNull();
  });

  it("Y5 — the primary heading is 'Overview' and there is exactly one h1", async () => {
    expect(h1Texts(await mountOverview())).toEqual(["Overview"]);
  });

  it("Y6 — WorkspaceNav still marks Overview as the current tab, independently of the breadcrumb", async () => {
    const r = await mountOverview();
    const nav = r.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === "Workspace", { deep: true })[0];
    const current = nav.findAll((n) => n.props?.["aria-current"] === "page", { deep: true }).map(visibleTextOf);
    expect(current).toEqual(["Overview"]);
  });

  it("Y7 — ENCODING: reserved characters in the workspaceId are percent-encoded in the breadcrumb href", async () => {
    const segs = bcSegments(await mountOverview("ws/a b", NAME));
    expect(segs[0].href).toBe("/workspace/team/ws%2Fa%20b");
    expect(segs[0].href).not.toContain("ws/a b");
  });
});
