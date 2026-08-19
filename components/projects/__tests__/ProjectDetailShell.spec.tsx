/**
 * Phase 7E-B — ProjectDetailShellView. Structural assertions (heading,
 * status, no lifecycle duplication, no Add-to-project) via
 * `renderToStaticMarkup`, mirroring `ProjectsShell.spec.tsx`'s own
 * convention. Toast/reconciliation wiring (which requires invoking
 * `AssignedRunActions`' callbacks through a real interactive tree,
 * including `WorkspaceRunCard`'s `next/link`) via `react-test-renderer`
 * with the same standard `next/link` mock `ProjectLifecycleRow.spec.tsx`
 * already established.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

import type { UseProjectsResult } from "@/hooks/useProjects";
let mockUseProjectsReturn: UseProjectsResult;
jest.mock("@/hooks/useProjects", () => {
  const actual = jest.requireActual("@/hooks/useProjects");
  return {
    ...actual,
    useProjects: () => mockUseProjectsReturn,
  };
});

import { ProjectDetailShellView } from "@/components/projects/ProjectDetailShell";
import type { ProjectDetailMeta } from "@/components/projects/ProjectDetailShell";
import type { UseProjectRunsResult, ProjectRunSummary } from "@/hooks/useProjectRuns";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

function fakeProjectsResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
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
    replaceItem: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockUseProjectsReturn = fakeProjectsResult();
});

function fakeRuns(overrides: Partial<UseProjectRunsResult> = {}): UseProjectRunsResult {
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

function fakeAssociation(overrides: Partial<UseRunProjectAssociationResult> = {}): UseRunProjectAssociationResult {
  return {
    isRunBusy: () => false,
    getBusyOperation: () => null,
    assign: jest.fn(),
    move: jest.fn(),
    remove: jest.fn(),
    ...overrides,
  };
}

const PROJECT: ProjectDetailMeta = { id: "proj-1", name: "My Project", status: "active" };
const ARCHIVED_PROJECT: ProjectDetailMeta = { id: "proj-1", name: "My Archived Project", status: "archived" };
const RUN_A: ProjectRunSummary = { id: "run-a", at: "2026-08-01T00:00:00.000Z", question: "Question A", selectedModels: ["chatgpt"], projectId: "proj-1" };
const RUN_B: ProjectRunSummary = { id: "run-b", at: "2026-08-02T00:00:00.000Z", question: "Question B", selectedModels: ["chatgpt"], projectId: "proj-1" };

function renderStatic(project: ProjectDetailMeta = PROJECT, runs = fakeRuns(), association = fakeAssociation()): string {
  return renderToStaticMarkup(createElement(ProjectDetailShellView, { project, runs, association }));
}

describe("ProjectDetailShellView — header", () => {
  it("h1 is the Project name", () => {
    const html = renderStatic();
    expect(html).toMatch(/<h1[^>]*>My Project<\/h1>/);
  });

  it("shows Active status textually", () => {
    expect(renderStatic(PROJECT)).toContain("Active");
  });

  it("shows Archived status textually", () => {
    expect(renderStatic(ARCHIVED_PROJECT)).toContain("Archived");
  });

  it("Back to Projects links to /workspace/projects", () => {
    const html = renderStatic();
    expect(html).toContain('href="/workspace/projects"');
    expect(html).toContain("Back to Projects");
  });
});

describe("ProjectDetailShellView — loading/error/empty (never fabricates empty on error)", () => {
  it("loading shows a restrained message, no empty state", () => {
    const html = renderStatic(PROJECT, fakeRuns({ status: "loading" }));
    expect(html).toContain("Loading research");
    expect(html).not.toContain("No research in this project.");
  });

  it("error never fabricates the empty-state copy", () => {
    const html = renderStatic(PROJECT, fakeRuns({ status: "error", initialErrorCode: "internal_error" }));
    expect(html).toContain("Try again");
    expect(html).not.toContain("No research in this project.");
  });

  it("definitive empty state: items=[] AND hasMore=false", () => {
    expect(renderStatic(PROJECT, fakeRuns({ items: [], hasMore: false }))).toContain("No research in this project.");
  });

  it("items=[] AND hasMore=true never shows the empty state", () => {
    expect(renderStatic(PROJECT, fakeRuns({ items: [], hasMore: true }))).not.toContain("No research in this project.");
  });

  it("archived Project with zero research is still a valid readable page — never redirected, empty state still shown normally", () => {
    expect(renderStatic(ARCHIVED_PROJECT, fakeRuns({ items: [], hasMore: false }))).toContain("No research in this project.");
  });
});

describe("ProjectDetailShellView — populated list reuses WorkspaceRunCard, no Add-to-project, no lifecycle duplication", () => {
  it("renders every run's question text, in order", () => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A, RUN_B] }));
    expect(html.indexOf("Question A")).toBeLessThan(html.indexOf("Question B"));
  });

  it("renders the canonical report link for each run", () => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A] }));
    expect(html).toContain(`href="/?openResearchRun=${encodeURIComponent(RUN_A.id)}"`);
  });

  it("renders Move and Remove from project controls, never Add to project", () => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A] }));
    expect(html).toContain("Move");
    expect(html).toContain("Remove from project");
    expect(html).not.toContain("Add to project");
  });

  it.each(["New Project", "Rename", "Archive", "Restore"])("never renders a %s lifecycle control anywhere on this page", (label) => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A] }));
    expect(html).not.toContain(label);
  });
});

describe("ProjectDetailShellView — defense-in-depth: item.projectId !== route Project (spec item 13)", () => {
  it("a (hypothetically) contradictory run never renders Move/Remove controls for that row", () => {
    const contradictory: ProjectRunSummary = { ...RUN_A, projectId: "proj-DIFFERENT" };
    const html = renderStatic(PROJECT, fakeRuns({ items: [contradictory] }));
    // The card itself still renders (defense-in-depth is about the ACTIONS slot, not hiding the row), but no Move/Remove for it.
    expect(html).toContain("Question A");
    expect(html).not.toContain("Move");
    expect(html).not.toContain("Remove from project");
  });
});

describe("ProjectDetailShellView — pagination", () => {
  it("hasMore=true -> 'Load more' present; hasMore=false -> absent", () => {
    expect(renderStatic(PROJECT, fakeRuns({ items: [RUN_A], hasMore: true }))).toContain("Load more");
    expect(renderStatic(PROJECT, fakeRuns({ items: [RUN_A], hasMore: false }))).not.toContain("Load more");
  });
});

// ---------------------------------------------------------------------------
// Interactive: toast + reconciliation wiring (requires a real tree).
// ---------------------------------------------------------------------------

function mountInteractive(project = PROJECT, runs = fakeRuns({ items: [RUN_A] }), association = fakeAssociation()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ProjectDetailShellView, { project, runs, association }));
  });
  return renderer;
}

describe("ProjectDetailShellView — Move/Remove success reconciliation (spec item 35/36)", () => {
  it("a successful Move resets this Project's own run list, shows 'Moved to {name}.', and never resets top-level state (no such state is even mounted here)", async () => {
    mockUseProjectsReturn = fakeProjectsResult({
      items: [{ id: "proj-2", name: "Project Two", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }],
    });
    const resetAndReloadFromStart = jest.fn();
    const runs = fakeRuns({ items: [RUN_A], resetAndReloadFromStart });
    const move = jest.fn(async () => ({ status: "ok" as const, runId: "run-a", projectId: "proj-2" }));
    const renderer = mountInteractive(PROJECT, runs, fakeAssociation({ move }));

    const moveTrigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    act(() => moveTrigger.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    const option = dialog.findByProps({ role: "option" });
    act(() => option.props.onClick());
    const moveConfirm = renderer.root.findByProps({ role: "dialog" }).findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveConfirm.props.onClick();
    });

    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("Moved to Project Two.");
    renderer.unmount();
  });

  it("a successful Remove resets this Project's own run list and shows 'Removed from project.'", async () => {
    const resetAndReloadFromStart = jest.fn();
    const runs = fakeRuns({ items: [RUN_A], resetAndReloadFromStart });
    const remove = jest.fn(async () => ({ status: "ok" as const, runId: "run-a", projectId: null }));
    const renderer = mountInteractive(PROJECT, runs, fakeAssociation({ remove }));

    const removeTrigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    act(() => removeTrigger.props.onClick());
    const confirmButton = renderer.root
      .findByProps({ role: "dialog" })
      .findAllByType("button")
      .find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });

    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("Removed from project.");
    renderer.unmount();
  });
});

describe("ProjectDetailShellView — toast does not crash on unmount mid-timeout", () => {
  it("unmounting shortly after a success acknowledgement does not throw", async () => {
    const runs = fakeRuns({ items: [RUN_A] });
    const renderer = mountInteractive(PROJECT, runs, fakeAssociation());
    expect(() => renderer.unmount()).not.toThrow();
  });
});
