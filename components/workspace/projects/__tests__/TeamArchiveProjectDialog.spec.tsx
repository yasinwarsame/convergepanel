/**
 * Phase PROJECT-UI-AR-I1 — `TeamArchiveProjectDialog` behavior tests.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { TeamArchiveProjectDialog } from "@/components/workspace/projects/TeamArchiveProjectDialog";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

const PROJECT: TeamProjectSummary = { id: "p1", workspaceId: "ws-1", name: "My Project", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } };

function setup(lifecycle: any, handlers: { onClose?: jest.Mock; onArchived?: jest.Mock; onStaleOrGone?: jest.Mock } = {}) {
  const onClose = handlers.onClose ?? jest.fn();
  const onArchived = handlers.onArchived ?? jest.fn();
  const onStaleOrGone = handlers.onStaleOrGone ?? jest.fn();
  const triggerRef = createRef<HTMLButtonElement>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(TeamArchiveProjectDialog, { project: PROJECT, triggerRef, onClose, lifecycle, onArchived, onStaleOrGone }));
  });
  return { renderer, onClose, onArchived, onStaleOrGone };
}
const button = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAllByType("button").find((b) => b.props.children === label)!;

it("renders an accessible dialog titled for this Project with explanatory copy, Cancel and Archive", () => {
  const { renderer } = setup({ isProjectBusy: () => false, archiveProject: jest.fn() });
  const dialog = renderer.root.findAll((n) => n.props?.role === "dialog");
  expect(dialog).toHaveLength(1);
  expect(dialog[0].props["aria-modal"]).toBe("true");
  expect(renderer.root.findByType("h2").props.children).toBe('Archive "My Project"?');
  expect(JSON.stringify(renderer.toJSON())).toContain("Existing research stays in this project. You can restore the project later.");
  expect(button(renderer, "Cancel")).toBeDefined();
  expect(button(renderer, "Archive")).toBeDefined();
});

it("Cancel closes without calling archiveProject", async () => {
  const archiveProject = jest.fn();
  const { renderer, onClose } = setup({ isProjectBusy: () => false, archiveProject });
  await act(async () => {
    button(renderer, "Cancel").props.onClick();
  });
  expect(archiveProject).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("confirm calls archiveProject once with the captured Project, then closes and reports onArchived", async () => {
  const archiveProject = jest.fn().mockResolvedValue({ status: "ok", project: { ...PROJECT, status: "archived" } });
  const { renderer, onClose, onArchived } = setup({ isProjectBusy: () => false, archiveProject });
  await act(async () => {
    await button(renderer, "Archive").props.onClick();
  });
  expect(archiveProject).toHaveBeenCalledTimes(1);
  expect(archiveProject).toHaveBeenCalledWith(PROJECT);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onArchived).toHaveBeenCalledTimes(1);
});

it("while busy: confirm is disabled, shows 'Archiving…', and a click does not submit", async () => {
  const archiveProject = jest.fn();
  const { renderer } = setup({ isProjectBusy: () => true, archiveProject });
  const confirm = button(renderer, "Archiving…");
  expect(confirm.props.disabled).toBe(true);
  await act(async () => {
    await confirm.props.onClick();
  });
  expect(archiveProject).not.toHaveBeenCalled();
});

it.each(["conflict", "invalid_project_status_transition", "project_not_found", "insufficient_capability", "team_workspace_not_found"])(
  "stale/gone/denied (%s): the dialog closes itself and hands the message to onStaleOrGone — it never stays open holding the old token, and never retries",
  async (code) => {
    const archiveProject = jest.fn().mockResolvedValue({ status: "error", errorCode: code });
    const { renderer, onClose, onArchived, onStaleOrGone } = setup({ isProjectBusy: () => false, archiveProject });
    await act(async () => {
      await button(renderer, "Archive").props.onClick();
    });
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onArchived).not.toHaveBeenCalled();
    expect(onStaleOrGone).toHaveBeenCalledTimes(1);
    expect(typeof onStaleOrGone.mock.calls[0][0]).toBe("string");
    expect(onStaleOrGone.mock.calls[0][0]).not.toMatch(/ws-1|p1/);
  }
);

it("transient failure (network_error): stays open with a role=alert error, does not report success or stale, allows manual retry", async () => {
  const archiveProject = jest.fn().mockResolvedValue({ status: "error", errorCode: "network_error" });
  const { renderer, onClose, onArchived, onStaleOrGone } = setup({ isProjectBusy: () => false, archiveProject });
  await act(async () => {
    await button(renderer, "Archive").props.onClick();
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(onArchived).not.toHaveBeenCalled();
  expect(onStaleOrGone).not.toHaveBeenCalled();
  expect(renderer.root.findAll((n) => n.props?.role === "alert")[0].props.children).toBe("Something went wrong. Please try again.");
  await act(async () => {
    await button(renderer, "Archive").props.onClick();
  });
  expect(archiveProject).toHaveBeenCalledTimes(2); // second call was a deliberate user retry, not automatic
});
