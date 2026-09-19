/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the Project-filed `New Video` entry point
 * on the Team Project detail surface.
 *
 * A separate file from R5-I2's read-only Videos-section spec, so the creation
 * affordance can be added without touching the tests that pin the read path.
 * All three list hooks are controlled, exactly as that spec does, because the
 * affordance must not perturb any of them.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));

jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-a" }, authReady: true }) }));

const mockedUseTeamProjectRuns = jest.fn();
jest.mock("@/hooks/useTeamProjectRuns", () => {
  const actual = jest.requireActual("@/hooks/useTeamProjectRuns");
  return { ...actual, useTeamProjectRuns: (...a: unknown[]) => mockedUseTeamProjectRuns(...a) };
});
const mockedUseClaimList = jest.fn();
jest.mock("@/hooks/useTeamClaimVerificationList", () => {
  const actual = jest.requireActual("@/hooks/useTeamClaimVerificationList");
  return { ...actual, useTeamClaimVerificationList: (...a: unknown[]) => mockedUseClaimList(...a) };
});
const mockedUseVideoList = jest.fn();
jest.mock("@/hooks/useTeamVideoVerificationList", () => {
  const actual = jest.requireActual("@/hooks/useTeamVideoVerificationList");
  return { ...actual, useTeamVideoVerificationList: (...a: unknown[]) => mockedUseVideoList(...a) };
});
jest.mock("@/hooks/useTeamRunAssignee", () => ({
  useTeamRunAssignee: () => ({ open: null, openFor: jest.fn(), close: jest.fn(), state: null, save: jest.fn() }),
}));

import TeamProjectDetailShell from "@/components/workspace/projects/TeamProjectDetailShell";

const W = "ws-1";
const P = "proj-1";

function listResult(over: Record<string, unknown> = {}) {
  return {
    items: [],
    hasMore: false,
    status: "ready",
    initialErrorCode: null,
    loadingMore: false,
    loadMoreErrorCode: null,
    loadMore: jest.fn(),
    retryInitial: jest.fn(),
    resetAndReloadFromStart: jest.fn(),
    ...over,
  };
}

const ACTIVE = { id: P, name: "Launch Plan", status: "active" as const, createdAt: "2026-09-01T00:00:00.000Z" };
const ARCHIVED = { ...ACTIVE, status: "archived" as const };

async function mount(over: Record<string, unknown> = {}) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(TeamProjectDetailShell, {
        workspaceId: W,
        workspaceName: "Acme Team",
        project: ACTIVE as never,
        canReadAudit: true,
        canStartResearch: true,
        canReadClaims: true,
        canReadVideos: true,
        ...over,
      } as never)
    );
  });
  await act(async () => {
    await new Promise((r2) => setTimeout(r2, 0));
  });
  return r;
}

/** Host `<a>` only — the `next/link` mock makes the composite carry identical props. */
const createLinks = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((x) => x.type === "a" && x.props?.["data-testid"] === "team-project-videos-new");

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseTeamProjectRuns.mockReturnValue(listResult());
  mockedUseClaimList.mockReturnValue(listResult());
  mockedUseVideoList.mockReturnValue(listResult());
});

describe("the Project-filed New Video entry point", () => {
  it("offers it to an organizer on an active Project", async () => {
    const r = await mount({ canCreateVideo: true });
    const links = createLinks(r);
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe(`/workspace/team/${W}/projects/${P}/videos/new`);
    expect(String(links[0].children.join(""))).toContain("New Video");
  });

  it("hides it from a viewer who cannot create", async () => {
    const r = await mount({ canCreateVideo: false });
    expect(createLinks(r)).toHaveLength(0);
  });

  it("hides it by default rather than optimistically offering it", async () => {
    const r = await mount({});
    expect(createLinks(r)).toHaveLength(0);
  });

  it("hides it on an ARCHIVED Project — the server would reject the write", async () => {
    const r = await mount({ canCreateVideo: true, project: ARCHIVED as never });
    expect(createLinks(r)).toHaveLength(0);
  });

  it("is not rendered at all when the Videos section itself is hidden", async () => {
    const r = await mount({ canCreateVideo: true, canReadVideos: false });
    expect(createLinks(r)).toHaveLength(0);
  });

  it("addresses THIS Project, never the Workspace-level Unfiled address", async () => {
    const r = await mount({ canCreateVideo: true });
    expect(createLinks(r)[0].props.href).not.toBe(`/workspace/team/${W}/videos/new`);
    expect(createLinks(r)[0].props.href).toContain(`/projects/${P}/`);
  });
});

describe("the affordance does not disturb the read path", () => {
  it("requests nothing extra and leaves every list hook's arguments unchanged", async () => {
    await mount({ canCreateVideo: true });
    expect(mockedUseVideoList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: true });
    expect(mockedUseClaimList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: true });
  });

  it("keeps the Claims entry point independent of the Videos one", async () => {
    const r = await mount({ canCreateVideo: true, canCreateClaim: false });
    expect(createLinks(r)).toHaveLength(1);
    expect(r.root.findAll((x) => x.type === "a" && x.props?.["data-testid"] === "team-project-claims-new")).toHaveLength(0);
  });

  it("keeps the Videos entry point independent of the Claims one", async () => {
    const r = await mount({ canCreateVideo: false, canCreateClaim: true });
    expect(createLinks(r)).toHaveLength(0);
    expect(r.root.findAll((x) => x.type === "a" && x.props?.["data-testid"] === "team-project-claims-new")).toHaveLength(1);
  });
});
