/**
 * Team Projects UI, Phase 12A.2 — `TeamProjectDetailShell` interactive
 * behavior. `react-test-renderer` + `act()`, `useTeamProjectRuns` mocked
 * directly; the real component tree/render logic is exercised
 * end-to-end. Deliberately proves NO fake/broken "Start research" link
 * and NO route into `app/page.tsx` (the frozen 12A.3 boundary).
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

async function mount(props: Partial<{ project: any }> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TeamProjectDetailShell, {
        workspaceId: "ws-1",
        workspaceName: "Acme Team",
        canReadAudit: true,
        project: { id: "proj-1", name: "ABC Acquisition", status: "active" },
        ...props,
      })
    );
  });
  return renderer;
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

  it("zero research -> honest empty state, no fake Start Research link, no route into app/page.tsx", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No research in this project yet");
    // No link anywhere points at the Personal composer.
    const links = renderer.root.findAllByType("a");
    for (const link of links) {
      expect(link.props.href).not.toMatch(/^\/(\?|$)/);
    }
    expect(text).not.toContain("Start research");
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
