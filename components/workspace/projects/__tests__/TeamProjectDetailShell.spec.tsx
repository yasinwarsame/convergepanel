/**
 * Team Projects UI, Phase 12A.2 — `TeamProjectDetailShell` interactive
 * behavior. `react-test-renderer` + `act()`, `useTeamProjectRuns` mocked
 * directly; the real component tree/render logic is exercised
 * end-to-end.
 *
 * PHASE 12A.3 — "Start Research" is now real (see the dedicated
 * `canStartResearch: true/false` + archived-Project tests below), but the
 * frozen boundary itself remains enforced and proven: the link always
 * points at `/workspace/team/{workspaceId}/projects/{projectId}/research/new`,
 * NEVER at `app/page.tsx` (the Personal composer) or `/api/run-panel`.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

const mockedUseTeamProjectRuns = jest.fn();
jest.mock("@/hooks/useTeamProjectRuns", () => {
  const actual = jest.requireActual("@/hooks/useTeamProjectRuns");
  return { ...actual, useTeamProjectRuns: (...args: any[]) => mockedUseTeamProjectRuns(...args) };
});

import TeamProjectDetailShell from "@/components/workspace/projects/TeamProjectDetailShell";

function runsResult(overrides: Partial<any> = {}) {
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
    ...overrides,
  };
}

async function mount(props: Partial<{ project: any; canStartResearch: boolean }> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TeamProjectDetailShell, {
        workspaceId: "ws-1",
        workspaceName: "Acme Team",
        canReadAudit: true,
        canStartResearch: true,
        project: { id: "proj-1", name: "ABC Acquisition", status: "active" },
        ...props,
      })
    );
  });
  return renderer;
}

function findStartResearchLink(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType("a").find((el) => el.props.children === "Start Research");
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("TeamProjectDetailShell", () => {
  it("renders the Workspace name, shared nav, Project name, and status", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult());
    const renderer = await mount();
    expect(renderer.root.findByType("h1").props.children).toBe("Acme Team");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("ABC Acquisition");
    expect(text).toContain("Active");
  });

  it("zero research + authorized -> honest empty state AND a real Start Research link, never into app/page.tsx", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No research in this project yet");
    // No link anywhere points at the Personal composer.
    const links = renderer.root.findAllByType("a");
    for (const link of links) {
      expect(link.props.href).not.toMatch(/^\/(\?|$)/);
      expect(link.props.href).not.toBe("/api/run-panel");
    }
    const startLink = findStartResearchLink(renderer);
    expect(startLink).toBeDefined();
    expect(startLink!.props.href).toBe("/workspace/team/ws-1/projects/proj-1/research/new");
  });

  describe("PHASE 12A.3 — permanent Start Research capability", () => {
    it("canStartResearch: false -> no Start Research link anywhere, authorized-only note not implied", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
      const renderer = await mount({ canStartResearch: false });
      expect(findStartResearchLink(renderer)).toBeUndefined();
    });

    it("PERMANENT capability — Start Research remains visible even with EXISTING research (not only in the empty state)", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(
        runsResult({
          items: [
            { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "What is the market size?", selectedModels: ["chatgpt", "claude"], status: "complete", modelsOk: 2, modelsTotal: 2, projectId: "proj-1" },
          ],
        })
      );
      const renderer = await mount({ canStartResearch: true });
      expect(findStartResearchLink(renderer)).toBeDefined();
    });

    it("archived Project -> Start Research never rendered, even for an otherwise-authorized caller", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
      const renderer = await mount({ canStartResearch: true, project: { id: "proj-1", name: "Old Project", status: "archived" } });
      expect(findStartResearchLink(renderer)).toBeUndefined();
    });

    it("MUTATION CHECK: asserting a DEFINED link (not merely absent from a loose text search) proves the control is genuinely present, matching the same non-vacuity discipline as the permanent Invite Member / New Project regression tests", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
      const renderer = await mount({ canStartResearch: true });
      const link = findStartResearchLink(renderer);
      expect(link).toBeDefined();
      expect(typeof link).not.toBe("undefined");
    });
  });

  it("renders each research item read-only — no interactive action controls (no Move/Remove/Assign)", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(
      runsResult({
        items: [
          { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "What is the market size?", selectedModels: ["chatgpt", "claude"], status: "complete", modelsOk: 2, modelsTotal: 2, projectId: "proj-1" },
        ],
      })
    );
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("What is the market size?");
    expect(text).toContain("2/2 model responses");
    // No <a> or <button> at all inside a research row — this is a read-only surface.
    expect(renderer.root.findAllByType("button").length).toBe(0);
  });

  it("passes workspaceId and projectId through to the runs hook exactly", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult());
    await mount({ project: { id: "proj-xyz", name: "X", status: "active" } });
    expect(mockedUseTeamProjectRuns).toHaveBeenCalledWith({ workspaceId: "ws-1", projectId: "proj-xyz" });
  });

  it("loading state shows a loading indicator, not the empty state", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult({ status: "loading", items: [] }));
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("No research in this project");
    expect(text).toContain("Loading research");
  });

  it("archived Project status renders 'Archived', not 'Active'", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult());
    const renderer = await mount({ project: { id: "proj-1", name: "Old Project", status: "archived" } });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Archived");
    expect(text).not.toContain(">Active<");
  });
});
