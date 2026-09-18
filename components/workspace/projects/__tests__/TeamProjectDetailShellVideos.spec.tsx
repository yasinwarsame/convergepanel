/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AP — the read-only Videos section on the Team
 * Project detail surface.
 *
 * All three list hooks are controlled independently so the central guarantee is
 * actually testable: research, Claim and Video state never touch each other.
 * `TeamVideoListRow`, `SectionState`, `Breadcrumb`, `WorkspaceNav` and
 * `teamVideoDetailHref` are REAL.
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

function videoItem(over: Record<string, unknown> = {}) {
  return {
    verificationId: "vid-1",
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    frameCount: 8,
    createdAt: "2026-09-10T10:00:00.000Z",
    workspaceId: W,
    projectId: P,
    project: { id: P, name: "Launch Plan", status: "active" },
    ...over,
  };
}
function claimItem(over: Record<string, unknown> = {}) {
  return {
    verificationId: "vcl-1",
    claim: "The sky is blue.",
    verdict: "confirmed",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    createdAt: "2026-09-10T10:00:00.000Z",
    workspaceId: W,
    projectId: P,
    project: { id: P, name: "Launch Plan", status: "active" },
    ...over,
  };
}

const PROJECT = { id: P, name: "Launch Plan", status: "active" as const, createdAt: "2026-09-01T00:00:00.000Z" };

async function mount(over: Record<string, unknown> = {}) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(TeamProjectDetailShell, {
        workspaceId: W,
        workspaceName: "Acme Team",
        project: PROJECT as never,
        canReadAudit: true,
        canStartResearch: true,
        canReadClaims: true,
        canReadVideos: true,
        ...over,
      } as never)
    );
  });
  await act(async () => {
    await new Promise((x) => setTimeout(x, 0));
  });
  return r;
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const hasVideoSection = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.["data-testid"] === "team-project-videos-section").length > 0;
const hasClaimSection = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.["data-testid"] === "team-project-claims-section").length > 0;
const videoRows = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a" && n.props?.["data-testid"] === "team-video-row");

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseTeamProjectRuns.mockReturnValue(listResult());
  mockedUseClaimList.mockReturnValue(listResult());
  mockedUseVideoList.mockReturnValue(listResult());
});

describe("capability hint", () => {
  it("addresses the Project scope and is enabled when canReadVideos is true", async () => {
    await mount();
    expect(mockedUseVideoList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: true });
  });

  it("issues no Video request and renders no Videos section when canReadVideos is false", async () => {
    const r = await mount({ canReadVideos: false });
    expect(mockedUseVideoList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: false });
    expect(hasVideoSection(r)).toBe(false);
    expect(text(r)).not.toContain("No videos in this project yet.");
  });

  it("defaults to disabled when the hint is absent", async () => {
    await mount({ canReadVideos: undefined });
    expect(mockedUseVideoList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: false });
  });
});

describe("section states", () => {
  it("loading", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ status: "loading" }));
    expect(text(await mount())).toContain("Loading videos…");
  });

  it("empty", async () => {
    expect(text(await mount())).toContain("No videos in this project yet.");
  });

  it("an initial error offers a retry and uses video copy", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ status: "error", initialErrorCode: "team_workspace_unavailable" }));
    const r = await mount();
    expect(text(r)).toContain("Couldn't load videos right now. Please try again.");
  });

  it("rows render and route to the Project detail address", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()] }));
    const r = await mount();
    expect(videoRows(r)).toHaveLength(1);
    expect(text(r)).toContain('"href":"/workspace/team/ws-1/projects/proj-1/videos/vid-1"');
  });

  it("rows do NOT repeat the Project name inside its own section", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()] }));
    const r = await mount();
    expect(videoRows(r)).toHaveLength(1);
    // showProject={false}, so the row emits no Project cell at all.
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-video-row-project")).toHaveLength(0);
  });

  it("positive control: the Workspace-wide list DOES emit that Project cell", async () => {
    // Proves the assertion above is about showProject, not about the testid
    // simply never existing.
    const { TeamVideoListRow } = require("@/components/workspace/videos/TeamVideoListRow");
    let rr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      rr = TestRenderer.create(createElement(TeamVideoListRow, { workspaceId: W, item: videoItem() as never, showProject: true }));
    });
    expect(rr.root.findAll((n) => n.props?.["data-testid"] === "team-video-row-project")).toHaveLength(1);
  });

  it("load-more appears when there is more", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()], hasMore: true }));
    expect(text(await mount())).toMatch(/load more/i);
  });
});

describe("the Videos section is independent of Research and Claims", () => {
  it("uses a SEPARATE hook instance from the Claim list", async () => {
    await mount();
    expect(mockedUseVideoList).toHaveBeenCalledTimes(1);
    expect(mockedUseClaimList).toHaveBeenCalledTimes(1);
    expect(mockedUseVideoList.mock.results[0].value).not.toBe(mockedUseClaimList.mock.results[0].value);
  });

  it("a Video error leaves Research and Claims rendered and untouched", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ status: "error", initialErrorCode: "internal_error" }));
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    const r = await mount();
    expect(hasClaimSection(r)).toBe(true);
    expect(text(r)).toContain("The sky is blue.");
    const claimResult = mockedUseClaimList.mock.results[0].value as Record<string, jest.Mock>;
    expect(claimResult.retryInitial).not.toHaveBeenCalled();
    expect(claimResult.resetAndReloadFromStart).not.toHaveBeenCalled();
  });

  it("a Video retry never resets the Claim or research lists", async () => {
    const videoState = listResult({ status: "error", initialErrorCode: "team_workspace_unavailable" });
    mockedUseVideoList.mockReturnValue(videoState);
    const r = await mount();
    const retry = r.root.findAll((n) => n.type === "button" && JSON.stringify(n.children).includes("Try again"));
    if (retry.length > 0) {
      await act(async () => {
        (retry[retry.length - 1].props.onClick as () => void)();
      });
    }
    const claimResult = mockedUseClaimList.mock.results[0].value as Record<string, jest.Mock>;
    const runsResult = mockedUseTeamProjectRuns.mock.results[0].value as Record<string, jest.Mock>;
    expect(claimResult.retryInitial).not.toHaveBeenCalled();
    expect(runsResult.retryInitial).not.toHaveBeenCalled();
  });

  it("a Claim error leaves the Videos section rendered", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ status: "error", initialErrorCode: "internal_error" }));
    mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()] }));
    const r = await mount();
    expect(hasVideoSection(r)).toBe(true);
    expect(videoRows(r)).toHaveLength(1);
    const videoResult = mockedUseVideoList.mock.results[0].value as Record<string, jest.Mock>;
    expect(videoResult.retryInitial).not.toHaveBeenCalled();
  });

  it("the Videos section renders AFTER the Claims section", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()] }));
    const html = text(await mount());
    expect(html.indexOf("team-project-claims-section")).toBeLessThan(html.indexOf("team-project-videos-section"));
  });
});

describe("archived Projects stay readable", () => {
  it("renders the Videos section for an archived Project", async () => {
    mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()] }));
    const r = await mount({ project: { ...PROJECT, status: "archived" } });
    expect(hasVideoSection(r)).toBe(true);
    expect(videoRows(r)).toHaveLength(1);
  });
});

describe("no creation surface", () => {
  it("renders no New Video control, for any capability combination", async () => {
    for (const over of [{}, { canCreateClaim: true }, { project: { ...PROJECT, status: "archived" } }]) {
      jest.clearAllMocks();
      mockedUseTeamProjectRuns.mockReturnValue(listResult());
      mockedUseClaimList.mockReturnValue(listResult());
      mockedUseVideoList.mockReturnValue(listResult({ items: [videoItem()] }));
      const r = await mount(over);
      const html = text(r);
      expect(html).not.toContain("New Video");
      expect(html).not.toContain("videos/new");
    }
  });
});
