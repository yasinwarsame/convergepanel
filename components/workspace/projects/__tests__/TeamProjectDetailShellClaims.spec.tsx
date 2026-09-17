/**
 * TEAM-VERIFICATION-PARITY-R4-I2 §AJ — the read-only Claims section on the Team
 * Project detail surface.
 *
 * Both list hooks are controlled independently so the central guarantee is
 * actually testable: research state and Claim state never touch each other.
 * `TeamClaimListRow`, `SectionState`, `Breadcrumb`, `WorkspaceNav` and
 * `teamClaimDetailHref` are REAL.
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

function runItem(over: Record<string, unknown> = {}) {
  return { id: "run-1", at: "2026-09-09T10:00:00.000Z", question: "RESEARCH QUESTION", selectedModels: ["chatgpt"], projectId: P, assignee: null, ...over };
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
const hasSection = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.["data-testid"] === "team-project-claims-section").length > 0;
// The Link mock forwards data-testid to the rendered anchor, so the component
// instance and the <a> both match; count the anchors only.
const claimRows = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a" && n.props?.["data-testid"] === "team-claim-row");

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseTeamProjectRuns.mockReturnValue(listResult());
  mockedUseClaimList.mockReturnValue(listResult());
});

describe("capability hint", () => {
  it("addresses the Project scope and is enabled when canReadClaims is true", async () => {
    await mount();
    expect(mockedUseClaimList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: true });
  });

  it("issues no Claim request and renders no Claims section when canReadClaims is false", async () => {
    const r = await mount({ canReadClaims: false });
    expect(mockedUseClaimList).toHaveBeenCalledWith({ address: { kind: "project", workspaceId: W, projectId: P }, enabled: false });
    expect(hasSection(r)).toBe(false);
    expect(text(r)).not.toContain("No claims in this project yet.");
  });

  it("defaults to disabled when the hint is absent", async () => {
    const r = await mount({ canReadClaims: undefined });
    expect(mockedUseClaimList.mock.calls[0][0].enabled).toBe(false);
    expect(hasSection(r)).toBe(false);
  });
});

describe("claims section", () => {
  it("renders a Claims heading and rows", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    const r = await mount();
    expect(hasSection(r)).toBe(true);
    expect(text(r)).toContain("Claims");
    expect(claimRows(r)).toHaveLength(1);
  });

  it("links a row to the PROJECT claim detail address", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    const r = await mount();
    expect(claimRows(r)[0].props.href).toBe("/workspace/team/ws-1/projects/proj-1/claims/vcl-1");
  });

  it("does not repeat the Project name on its own rows", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    const r = await mount();
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "team-claim-row-project")).toHaveLength(0);
  });

  it("renders the empty copy", async () => {
    const r = await mount();
    expect(text(r)).toContain("No claims in this project yet.");
  });

  it("renders a loading state", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ status: "loading" }));
    expect(text(await mount())).toContain("Loading claims…");
  });

  it("renders an initial error with retry, never an empty success", async () => {
    const retryInitial = jest.fn();
    mockedUseClaimList.mockReturnValue(listResult({ status: "error", initialErrorCode: "team_workspace_unavailable", retryInitial }));
    const r = await mount();
    expect(text(r)).toContain("Couldn't load claims right now.");
    expect(text(r)).not.toContain("No claims in this project yet.");
    const btn = r.root.findAll((n) => n.type === "button" && JSON.stringify(n.children).includes("Try again"))[0];
    await act(async () => {
      (btn.props.onClick as () => void)();
    });
    expect(retryInitial).toHaveBeenCalled();
  });

  it("paginates independently", async () => {
    const loadMore = jest.fn();
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()], hasMore: true, loadMore }));
    const r = await mount();
    const btn = r.root.findAll((n) => n.type === "button" && JSON.stringify(n.children).includes("Load more"))[0];
    await act(async () => {
      (btn.props.onClick as () => void)();
    });
    expect(loadMore).toHaveBeenCalled();
    expect(mockedUseTeamProjectRuns.mock.results.every((x) => x.value.loadMore.mock.calls.length === 0)).toBe(true);
  });

  it("keeps rows when load-more fails", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()], hasMore: true, loadMoreErrorCode: "internal_error" }));
    const r = await mount();
    expect(claimRows(r)).toHaveLength(1);
    expect(text(r)).toContain("We couldn't display these claims safely.");
  });

  it("remains readable on an archived Project", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem({ project: { id: P, name: "Launch Plan", status: "archived" } })] }));
    const r = await mount({ project: { ...PROJECT, status: "archived" }, canStartResearch: false });
    expect(hasSection(r)).toBe(true);
    expect(claimRows(r)).toHaveLength(1);
  });

  it("offers no Claim creation control", async () => {
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    const r = await mount();
    const rendered = text(r);
    expect(rendered).not.toContain("Verify a claim");
    expect(rendered).not.toContain("New claim");
  });
});

describe("research / claims independence", () => {
  it("a Claims failure never hides research", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ items: [runItem()] }));
    mockedUseClaimList.mockReturnValue(listResult({ status: "error", initialErrorCode: "internal_error" }));
    const r = await mount();
    expect(text(r)).toContain("RESEARCH QUESTION");
    expect(text(r)).toContain("We couldn't display these claims safely.");
  });

  it("a research failure never hides claims", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ status: "error", initialErrorCode: "internal_error" }));
    mockedUseClaimList.mockReturnValue(listResult({ items: [claimItem()] }));
    const r = await mount();
    expect(hasSection(r)).toBe(true);
    expect(claimRows(r)).toHaveLength(1);
  });

  it("a Claim retry never calls a research action", async () => {
    const runsResult = listResult({ items: [runItem()] });
    mockedUseTeamProjectRuns.mockReturnValue(runsResult);
    const claimRetry = jest.fn();
    mockedUseClaimList.mockReturnValue(listResult({ status: "error", initialErrorCode: "network_error", retryInitial: claimRetry }));
    const r = await mount();
    const btn = r.root.findAll((n) => n.type === "button" && JSON.stringify(n.children).includes("Try again"))[0];
    await act(async () => {
      (btn.props.onClick as () => void)();
    });
    expect(claimRetry).toHaveBeenCalled();
    expect(runsResult.retryInitial).not.toHaveBeenCalled();
    expect(runsResult.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(runsResult.loadMore).not.toHaveBeenCalled();
  });

  it("a research refetch never resets the Claim list", async () => {
    const claimsResult = listResult({ items: [claimItem()] });
    mockedUseClaimList.mockReturnValue(claimsResult);
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ items: [runItem()] }));
    const r = await mount();
    // Simulate the research list re-resolving (as it does after an assignment).
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ items: [runItem({ id: "run-2", question: "REFRESHED QUESTION" })] }));
    await act(async () => {
      r.update(
        createElement(TeamProjectDetailShell, {
          workspaceId: W,
          workspaceName: "Acme Team",
          project: PROJECT as never,
          canReadAudit: true,
          canStartResearch: true,
          canReadClaims: true,
        } as never)
      );
    });
    expect(text(r)).toContain("REFRESHED QUESTION");
    expect(claimRows(r)).toHaveLength(1);
    expect(claimsResult.resetAndReloadFromStart).not.toHaveBeenCalled();
    expect(claimsResult.retryInitial).not.toHaveBeenCalled();
  });
});

describe("R4-I3 Project create entry point", () => {
  const cta = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a" && n.props?.["data-testid"] === "team-project-claims-new");

  it("offers New Claim on an active Project when the viewer can create and organize", async () => {
    const r = await mount({ canCreateClaim: true });
    expect(cta(r)).toHaveLength(1);
    expect(cta(r)[0].props.href).toBe("/workspace/team/ws-1/projects/proj-1/claims/new");
  });

  it("omits New Claim without the create capability", async () => {
    const r = await mount({ canCreateClaim: false });
    expect(cta(r)).toHaveLength(0);
  });

  it("defaults to omitting the CTA when the hint is absent", async () => {
    const r = await mount();
    expect(cta(r)).toHaveLength(0);
  });

  it("omits New Claim on an ARCHIVED Project even with the capability", async () => {
    const r = await mount({ canCreateClaim: true, project: { ...PROJECT, status: "archived" }, canStartResearch: false });
    expect(cta(r)).toHaveLength(0);
    // The archived Project's existing Claims stay readable.
    expect(hasSection(r)).toBe(true);
  });

  it("does not show the CTA when the Claims section itself is unavailable", async () => {
    const r = await mount({ canCreateClaim: true, canReadClaims: false });
    expect(cta(r)).toHaveLength(0);
    expect(hasSection(r)).toBe(false);
  });

  it("leaves the research controls untouched", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ items: [runItem()] }));
    const r = await mount({ canCreateClaim: true });
    expect(text(r)).toContain("RESEARCH QUESTION");
  });
});
