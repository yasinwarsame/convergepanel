/**
 * Phase 7E-B — RemoveFromProjectDialog. Interactive test via
 * `react-test-renderer`, structural mirror of `ArchiveProjectDialog.spec.tsx`'s
 * confirm-step pattern.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { RemoveFromProjectDialog } from "@/components/projects/RemoveFromProjectDialog";
import type { UseRunProjectAssociationResult, RunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
import type { ProjectRunSummary } from "@/hooks/useProjectRuns";

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

const P1 = "proj-source";
const RUN: ProjectRunSummary = { id: "run-1", at: "2026-08-01T00:00:00.000Z", question: "Assigned question", selectedModels: ["chatgpt"], projectId: P1 };

function setup(association: UseRunProjectAssociationResult, onClose = jest.fn(), onRemoved = jest.fn(), onStaleSource = jest.fn(), sourceProjectId: string = P1) {
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(RemoveFromProjectDialog, { run: RUN, sourceProjectId, triggerRef, onClose, association, onRemoved, onStaleSource }));
  });
  return { renderer, onClose, onRemoved, onStaleSource };
}

describe("RemoveFromProjectDialog — copy (spec item 28)", () => {
  it("uses relocation copy, never destructive-deletion language", () => {
    const { renderer } = setup(fakeAssociation());
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("Remove from project?");
    expect(html).toContain("This research will return to Unfiled. The saved report will not be deleted.");
    expect(html.toLowerCase()).not.toMatch(/delete this research|permanently delete/);
  });
});

describe("RemoveFromProjectDialog — confirmation semantics (spec item 29)", () => {
  it("opening the dialog dispatches zero PATCH", () => {
    const remove = jest.fn();
    setup(fakeAssociation({ remove }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("Cancel dispatches zero PATCH", () => {
    const remove = jest.fn();
    const { renderer, onClose } = setup(fakeAssociation({ remove }));
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => cancelButton.props.onClick());
    expect(remove).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("explicit Remove dispatches exactly one PATCH via association.remove(run.id, sourceProjectId)", async () => {
    const remove = jest.fn<Promise<RunProjectAssociationResult>, [string, string]>(async () => ({ status: "ok", runId: "run-1", projectId: null }));
    const { renderer } = setup(fakeAssociation({ remove }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("run-1", P1);
  });
});

describe("RemoveFromProjectDialog — success", () => {
  it("closes and calls onRemoved on canonical success", async () => {
    const remove = jest.fn<Promise<RunProjectAssociationResult>, [string, string]>(async () => ({ status: "ok", runId: "run-1", projectId: null }));
    const { renderer, onClose, onRemoved } = setup(fakeAssociation({ remove }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("no optimistic removal — onRemoved fires only after association.remove resolves", async () => {
    let resolveRemove!: (v: RunProjectAssociationResult) => void;
    const remove = jest.fn(() => new Promise<RunProjectAssociationResult>((res) => (resolveRemove = res)));
    const { renderer, onRemoved } = setup(fakeAssociation({ remove }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    let clickPromise!: Promise<void>;
    act(() => {
      clickPromise = confirmButton.props.onClick();
    });
    expect(onRemoved).not.toHaveBeenCalled();
    await act(async () => {
      resolveRemove({ status: "ok", runId: "run-1", projectId: null });
      await clickPromise;
    });
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});

describe("RemoveFromProjectDialog — busy presentation (spec item 31/55)", () => {
  it("Remove confirm shows 'Removing…' only when getBusyOperation returns 'remove'", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: () => true, getBusyOperation: () => "remove" }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    expect(confirmButton.props.disabled).toBe(true);
    expect(confirmButton.props.children).toBe("Removing…");
  });

  it("busy but a DIFFERENT operation ('move') is what's in flight: Remove confirm still says 'Remove', not 'Removing…'", () => {
    const { renderer } = setup(fakeAssociation({ isRunBusy: () => true, getBusyOperation: () => "move" }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    expect(confirmButton.props.disabled).toBe(true); // still disabled (shared lock)
    expect(confirmButton.props.children).toBe("Remove"); // but never claims to be the busy operation
  });
});

describe("RemoveFromProjectDialog — stale-source failures: no retry, dialog stays open", () => {
  it.each(["run_not_found", "project_association_conflict", "project_association_unchanged"] as const)("%s: shows error, calls onStaleSource, never closes", async (errorCode) => {
    const remove = jest.fn<Promise<RunProjectAssociationResult>, [string, string]>(async () => ({ status: "error", errorCode }));
    const { renderer, onClose, onRemoved, onStaleSource } = setup(fakeAssociation({ remove }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });
    expect(remove).toHaveBeenCalledTimes(1); // exactly once — never auto-retried
    expect(onClose).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onStaleSource).toHaveBeenCalledTimes(1);
    const alert = renderer.root.findByProps({ role: "alert" });
    expect(alert.children.join("")).toBeTruthy();
  });
});

describe("RemoveFromProjectDialog — generic failures never fabricate success", () => {
  it("internal_error shows a message, stays open, calls neither onStaleSource nor onRemoved", async () => {
    const remove = jest.fn<Promise<RunProjectAssociationResult>, [string, string]>(async () => ({ status: "error", errorCode: "internal_error" }));
    const { renderer, onClose, onRemoved, onStaleSource } = setup(fakeAssociation({ remove }));
    const confirmButton = renderer.root.findAllByType("button").find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onStaleSource).not.toHaveBeenCalled();
  });
});
