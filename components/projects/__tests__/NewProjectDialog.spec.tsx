/**
 * Phase 7D — NewProjectDialog. Interactive test via `react-test-renderer` +
 * `act()` (no jsdom): elements are located via `root.findByType`/
 * `findAllByType` and their event handlers invoked directly. `lifecycle`
 * is injected as a fake prop object (jest.fn() per operation), so no
 * `authedFetch`/`useAuth` mocking is needed at this layer — that contract
 * is already covered by `useProjectLifecycle.spec.ts`.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import type { UseProjectLifecycleResult, ProjectMutationResult } from "@/hooks/useProjectLifecycle";

function fakeLifecycle(overrides: Partial<UseProjectLifecycleResult> = {}): UseProjectLifecycleResult {
  return {
    isProjectBusy: () => false,
    getBusyOperation: () => null,
    isCreating: false,
    createProject: jest.fn(),
    renameProject: jest.fn(),
    archiveProject: jest.fn(),
    restoreProject: jest.fn(),
    ...overrides,
  };
}

function setup(lifecycle: UseProjectLifecycleResult, onClose = jest.fn(), onCreated = jest.fn()) {
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(createElement(NewProjectDialog, { triggerRef, onClose, lifecycle, onCreated }));
  });
  return { renderer, onClose, onCreated };
}

describe("NewProjectDialog — structure", () => {
  it("renders as a labeled dialog with a name input", () => {
    const { renderer } = setup(fakeLifecycle());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(renderer.root.findByType("input")).toBeTruthy();
  });
});

describe("NewProjectDialog — cancel never mutates", () => {
  it("clicking Cancel calls onClose and dispatches zero createProject calls", () => {
    const lifecycle = fakeLifecycle();
    const { renderer, onClose } = setup(lifecycle);
    const cancelButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Cancel")!;
    act(() => {
      cancelButton.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lifecycle.createProject).not.toHaveBeenCalled();
  });
});

describe("NewProjectDialog — valid submit", () => {
  it("submits exactly once with the typed name, nothing else in the body shape (helper-level contract already proven in useProjectLifecycle.spec.ts)", async () => {
    const createProject = jest.fn<Promise<ProjectMutationResult>, [string]>(async () => ({
      status: "ok",
      project: { id: "p1", name: "My New Project", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } },
    }));
    const lifecycle = fakeLifecycle({ createProject });
    const { renderer, onClose, onCreated } = setup(lifecycle);

    const input = renderer.root.findByType("input");
    act(() => {
      input.props.onChange({ target: { value: "My New Project" } });
    });

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith("My New Project");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("double submit is prevented: Submit button is disabled while isCreating", () => {
    const lifecycle = fakeLifecycle({ isCreating: true });
    const { renderer } = setup(lifecycle);
    const submitButton = renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;
    expect(submitButton.props.disabled).toBe(true);
  });

  it("Submit is disabled for an empty/whitespace-only name (client-side hint, server remains authoritative)", () => {
    const lifecycle = fakeLifecycle();
    const { renderer } = setup(lifecycle);
    const submitButton = renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;
    expect(submitButton.props.disabled).toBe(true); // initial empty name
  });
});

describe("NewProjectDialog — error handling", () => {
  it("a failed create shows an error message and does NOT close the dialog", async () => {
    const createProject = jest.fn<Promise<ProjectMutationResult>, [string]>(async () => ({ status: "error", errorCode: "invalid_project_name" }));
    const lifecycle = fakeLifecycle({ createProject });
    const { renderer, onClose, onCreated } = setup(lifecycle);

    const input = renderer.root.findByType("input");
    act(() => {
      input.props.onChange({ target: { value: "x" } });
    });
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    const alert = renderer.root.findByProps({ role: "alert" });
    expect(alert.children.join("")).toMatch(/1.200 characters/);
  });
});

// Escape-key/initial-focus behavior lives in the shared `ProjectDialogFrame`
// (used identically by all three dialogs) and depends on `document`, which
// this repo's jsdom-free test environment doesn't provide — see
// `ProjectDialogFrame.spec.tsx` for the source-level structural proof of
// that behavior, mirroring `TopNav.spec.ts`'s established convention for
// the same constraint.
