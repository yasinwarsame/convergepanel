/**
 * Phase 7E-B — MoveToProjectDialog. Interactive test via `react-test-renderer`,
 * structural mirror of `AddToProjectDialog.spec.tsx`. Focused on what's
 * NEW/different here: source-Project exclusion, the hasMore-preserves-
 * Load-More edge case (spec item 25), and the Move-specific request body.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { UseProjectsResult, ProjectSummary } from "@/hooks/useProjects";

const mockUseProjectsArgs: { status: "active" | "archived" }[] = [];
let mockUseProjectsReturn: UseProjectsResult;
jest.mock("@/hooks/useProjects", () => {
  const actual = jest.requireActual("@/hooks/useProjects");
  return {
    ...actual,
    useProjects: (args: { status: "active" | "archived" }) => {
      mockUseProjectsArgs.push(args);
      return mockUseProjectsReturn;
    },
  };
});

import { MoveToProjectDialog } from "@/components/projects/MoveToProjectDialog";
import type { UseRunProjectAssociationResult, RunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
import type { ProjectRunSummary } from "@/hooks/useProjectRuns";

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

const UPDATE_TIME = { seconds: 1723600000, nanoseconds: 0 };
const P1 = "proj-source";
const PROJECT_1: ProjectSummary = { id: P1, name: "Source Project", status: "active", createdAt: "x", updatedAt: "x", updateTime: UPDATE_TIME };
const PROJECT_2: ProjectSummary = { id: "proj-2", name: "Project Two", status: "active", createdAt: "x", updatedAt: "x", updateTime: UPDATE_TIME };
const RUN: ProjectRunSummary = { id: "run-1", at: "2026-08-01T00:00:00.000Z", question: "Assigned question", selectedModels: ["chatgpt"], projectId: P1 };

function setup(
  association: UseRunProjectAssociationResult,
  onClose = jest.fn(),
  onMoved = jest.fn(),
  onStaleSource = jest.fn(),
  sourceProjectId: string = P1
) {
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(MoveToProjectDialog, { run: RUN, sourceProjectId, triggerRef, onClose, association, onMoved, onStaleSource }));
  });
  return { renderer, onClose, onMoved, onStaleSource };
}

beforeEach(() => {
  mockUseProjectsArgs.length = 0;
  mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_1, PROJECT_2] });
});

describe("MoveToProjectDialog — target scope (spec item 23)", () => {
  it("calls useProjects with exactly {status:'active'}, never 'archived'", () => {
    setup(fakeAssociation());
    expect(mockUseProjectsArgs).toEqual([{ status: "active" }]);
  });

  it("excludes the current source Project from the offered options — only the OTHER active Project is shown", () => {
    const { renderer } = setup(fakeAssociation());
    const options = renderer.root.findAllByProps({ role: "option" });
    expect(options.map((o) => o.children.join(""))).toEqual(["Project Two"]);
  });
});

describe("MoveToProjectDialog — current-only page + hasMore edge case (spec item 25)", () => {
  it("page 1 contains only the source Project, hasMore=true: shows Load More, NEVER the terminal 'no other projects' empty state", () => {
    mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_1], hasMore: true });
    const { renderer } = setup(fakeAssociation());
    expect(renderer.root.findAllByProps({ role: "option" })).toHaveLength(0);
    const html = JSON.stringify(renderer.toJSON());
    expect(html).not.toContain("No other active projects available.");
    expect(html).toContain("Load more");
  });

  it("terminal empty state only fires once accumulated selectable count is 0 AND hasMore=false", () => {
    mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_1], hasMore: false });
    const { renderer } = setup(fakeAssociation());
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("No other active projects available.");
  });
});

describe("MoveToProjectDialog — deliberate selection, zero mutation until explicit Move", () => {
  it("opening/selecting/Cancel all dispatch zero mutation", () => {
    const move = jest.fn();
    const { renderer, onClose } = setup(fakeAssociation({ move }));
    expect(move).not.toHaveBeenCalled();
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    expect(move).not.toHaveBeenCalled();
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(move).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Move is disabled until a target is selected", () => {
    const { renderer } = setup(fakeAssociation());
    const moveButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Move"))!;
    expect(moveButton.props.disabled).toBe(true);
  });
});

describe("MoveToProjectDialog — Move dispatches exactly one PATCH via association.move", () => {
  it("sends (run.id, selectedProjectId, sourceProjectId) exactly — P1 from the prop, not the route", async () => {
    const move = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string]>(async () => ({ status: "ok", runId: "run-1", projectId: "proj-2" }));
    const { renderer } = setup(fakeAssociation({ move }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveButton.props.onClick();
    });
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith("run-1", "proj-2", P1);
  });

  it("on success, closes and calls onMoved with the target Project's name", async () => {
    const move = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string]>(async () => ({ status: "ok", runId: "run-1", projectId: "proj-2" }));
    const { renderer, onClose, onMoved } = setup(fakeAssociation({ move }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveButton.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMoved).toHaveBeenCalledWith("Project Two");
  });

  it("busy: Move confirm shows 'Moving…' only when getBusyOperation returns 'move'", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: () => true, getBusyOperation: () => "move" }));
    const moveButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Mov"))!;
    expect(moveButton.props.disabled).toBe(true);
    expect(moveButton.props.children).toBe("Moving…");
  });

  it("busy but a DIFFERENT operation ('remove') is what's in flight: Move confirm still says 'Move', not 'Moving…'", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: () => true, getBusyOperation: () => "remove" }));
    const moveButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Mov"))!;
    expect(moveButton.props.disabled).toBe(true); // still disabled (shared lock)
    expect(moveButton.props.children).toBe("Move"); // but never claims to be the busy operation
  });
});

describe("MoveToProjectDialog — stale-source failures: no retry, source refresh, dialog stays open", () => {
  it.each(["run_not_found", "project_association_conflict", "project_association_unchanged"] as const)("%s: shows error, calls onStaleSource, never closes", async (errorCode) => {
    const move = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string]>(async () => ({ status: "error", errorCode }));
    const { renderer, onClose, onMoved, onStaleSource } = setup(fakeAssociation({ move }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveButton.props.onClick();
    });
    expect(move).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
    expect(onStaleSource).toHaveBeenCalledTimes(1);
  });
});

describe("MoveToProjectDialog — target conflict: no retry, chooser refreshes, selection cleared", () => {
  it.each(["project_not_found", "project_archived"] as const)("%s: refreshes the chooser's own list, clears selection", async (errorCode) => {
    const move = jest.fn<Promise<RunProjectAssociationResult>, [string, string, string]>(async () => ({ status: "error", errorCode }));
    const resetAndReloadFromStart = jest.fn();
    mockUseProjectsReturn = fakeProjectsResult({ items: [PROJECT_1, PROJECT_2], resetAndReloadFromStart });
    const { renderer, onStaleSource } = setup(fakeAssociation({ move }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveButton.props.onClick();
    });
    expect(onStaleSource).not.toHaveBeenCalled();
    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    const moveButtonAfter = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    expect(moveButtonAfter.props.disabled).toBe(true);
  });
});

describe("MoveToProjectDialog — no optimistic removal", () => {
  it("association.move is awaited before onMoved fires — no fabricated success", async () => {
    let resolveMove!: (v: RunProjectAssociationResult) => void;
    const move = jest.fn(() => new Promise<RunProjectAssociationResult>((res) => (resolveMove = res)));
    const { renderer, onMoved } = setup(fakeAssociation({ move }));
    const option = renderer.root.findAllByProps({ role: "option" })[0];
    act(() => option.props.onClick());
    const moveButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    let clickPromise!: Promise<void>;
    act(() => {
      clickPromise = moveButton.props.onClick();
    });
    expect(onMoved).not.toHaveBeenCalled();
    await act(async () => {
      resolveMove({ status: "ok", runId: "run-1", projectId: "proj-2" });
      await clickPromise;
    });
    expect(onMoved).toHaveBeenCalledTimes(1);
  });
});
