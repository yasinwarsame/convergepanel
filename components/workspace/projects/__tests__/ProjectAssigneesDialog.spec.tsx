/**
 * Project/Research Assignment — `ProjectAssigneesDialog` (react-test-renderer,
 * `useWorkspaceMembers` mocked, the lifecycle hook injected). Every active
 * member is offered (never capability-filtered, D2 Project rule); stale
 * stored assignees are listed as "no longer eligible" and NOT submitted;
 * the 20-cap mirror; and the three-way outcome split.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseWorkspaceMembers = jest.fn();
jest.mock("@/hooks/useWorkspaceMembers", () => ({ useWorkspaceMembers: (...a: unknown[]) => mockedUseWorkspaceMembers(...a) }));

import { ProjectAssigneesDialog, MAX_PROJECT_ASSIGNEES_CLIENT_MIRROR } from "@/components/workspace/projects/ProjectAssigneesDialog";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

const member = (uid: string, role = "member") => ({ uid, displayName: `Name(${uid})`, role, isCanonicalOwner: role === "owner", joinedAt: "x", updateTimeToken: { seconds: 1, nanoseconds: 0 } });
const MEMBERS = [member("owner-1", "owner"), member("m1"), member("v1", "viewer"), member("r1", "reviewer")];
const PROJECT: TeamProjectSummary = { id: "p1", workspaceId: "ws-1", name: "Due Diligence", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 }, assignees: [{ uid: "m1", displayName: "Name(m1)", state: "active" }, { uid: "gone", displayName: "Ghost", state: "stale" }] };

function setup(lifecycle: any, handlers: Partial<{ onClose: jest.Mock; onSaved: jest.Mock; onStaleOrGone: jest.Mock }> = {}, project = PROJECT) {
  const onClose = handlers.onClose ?? jest.fn();
  const onSaved = handlers.onSaved ?? jest.fn();
  const onStaleOrGone = handlers.onStaleOrGone ?? jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ProjectAssigneesDialog, { workspaceId: "ws-1", project, triggerRef: createRef<HTMLButtonElement>(), onClose, lifecycle, onSaved, onStaleOrGone }));
  });
  return { renderer, onClose, onSaved, onStaleOrGone };
}
const button = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAllByType("button").find((b) => b.props.children === label)!;
const checkboxes = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
const lifecycle = (overrides: Record<string, unknown> = {}) => ({ isProjectBusy: () => false, setAssignees: jest.fn().mockResolvedValue({ status: "ok", project: PROJECT }), ...overrides });

beforeEach(() => {
  mockedUseWorkspaceMembers.mockReset();
  mockedUseWorkspaceMembers.mockReturnValue({ status: "ready", members: MEMBERS, workspaceUpdateToken: null, reload: jest.fn() });
});

it("is an accessible dialog offering EVERY active member (Viewer and Reviewer included — D2 Project rule), with current active assignees pre-checked", () => {
  const { renderer } = setup(lifecycle());
  expect(renderer.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(1);
  expect(renderer.root.findByType("h2").props.children).toBe('Assignees for "Due Diligence"');
  const boxes = checkboxes(renderer);
  expect(boxes).toHaveLength(4);
  const text = JSON.stringify(renderer.toJSON());
  for (const uid of ["owner-1", "m1", "v1", "r1"]) expect(text).toContain(`Name(${uid})`);
  expect(boxes.filter((b) => b.props.checked)).toHaveLength(1);
  expect(mockedUseWorkspaceMembers).toHaveBeenCalledWith({ workspaceId: "ws-1" });
});

it("a stored assignee who is no longer a member is disclosed as 'no longer eligible' and NEVER submitted; save sends only listed, checked uids", async () => {
  const setAssignees = jest.fn().mockResolvedValue({ status: "ok", project: PROJECT });
  const { renderer, onSaved, onClose } = setup(lifecycle({ setAssignees }));
  expect(JSON.stringify(renderer.toJSON())).toContain("No longer eligible and will be removed on save");
  expect(JSON.stringify(renderer.toJSON())).toContain("Ghost");
  await act(async () => {
    checkboxes(renderer)[2].props.onChange(); // v1
  });
  await act(async () => {
    await button(renderer, "Save assignees").props.onClick();
  });
  expect(setAssignees).toHaveBeenCalledTimes(1);
  expect(setAssignees).toHaveBeenCalledWith(PROJECT, expect.arrayContaining(["m1", "v1"]));
  expect(setAssignees.mock.calls[0][1]).not.toContain("gone");
  expect(setAssignees.mock.calls[0][1]).toHaveLength(2);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("cap mirror: with 20 selected, unselected boxes are disabled and a note is shown (the server remains authoritative)", async () => {
  const many = Array.from({ length: 21 }, (_, i) => member(`u${i}`));
  mockedUseWorkspaceMembers.mockReturnValue({ status: "ready", members: many, workspaceUpdateToken: null, reload: jest.fn() });
  const { renderer } = setup(lifecycle(), {}, { ...PROJECT, assignees: [] });
  for (let i = 0; i < MAX_PROJECT_ASSIGNEES_CLIENT_MIRROR; i++) {
    await act(async () => {
      checkboxes(renderer)[i].props.onChange();
    });
  }
  const boxes = checkboxes(renderer);
  expect(boxes.filter((b) => b.props.checked)).toHaveLength(20);
  expect(boxes[20].props.disabled).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain("A Project can have at most ");
});

it("members loading / error states: Save is disabled; the error offers retry through reload()", () => {
  mockedUseWorkspaceMembers.mockReturnValue({ status: "loading", members: [], workspaceUpdateToken: null, reload: jest.fn() });
  let { renderer } = setup(lifecycle());
  expect(button(renderer, "Save assignees").props.disabled).toBe(true);
  const reload = jest.fn();
  mockedUseWorkspaceMembers.mockReturnValue({ status: "error", members: [], workspaceUpdateToken: null, reload });
  ({ renderer } = setup(lifecycle()));
  expect(button(renderer, "Save assignees").props.disabled).toBe(true);
  act(() => {
    button(renderer, "Try again").props.onClick();
  });
  expect(reload).toHaveBeenCalledTimes(1);
});

it("stale / gone / denied / archived ⇒ closes and reports onStaleOrGone (the shell refetches); transient ⇒ stays open with the message; assignee_not_eligible additionally reloads members", async () => {
  for (const code of ["conflict", "project_not_found", "insufficient_capability", "team_workspace_not_found", "project_archived"]) {
    const { renderer, onStaleOrGone, onClose, onSaved } = setup(lifecycle({ setAssignees: jest.fn().mockResolvedValue({ status: "error", errorCode: code }) }));
    await act(async () => {
      await button(renderer, "Save assignees").props.onClick();
    });
    expect(onStaleOrGone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  }
  const reload = jest.fn();
  mockedUseWorkspaceMembers.mockReturnValue({ status: "ready", members: MEMBERS, workspaceUpdateToken: null, reload });
  const { renderer, onStaleOrGone, onClose } = setup(lifecycle({ setAssignees: jest.fn().mockResolvedValue({ status: "error", errorCode: "assignee_not_eligible" }) }));
  await act(async () => {
    await button(renderer, "Save assignees").props.onClick();
  });
  expect(onStaleOrGone).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(renderer.root.findAll((n) => n.props?.role === "alert")).toHaveLength(1);
  expect(reload).toHaveBeenCalledTimes(1);
  const net = setup(lifecycle({ setAssignees: jest.fn().mockResolvedValue({ status: "error", errorCode: "network_error" }) }));
  await act(async () => {
    await button(net.renderer, "Save assignees").props.onClick();
  });
  expect(net.onClose).not.toHaveBeenCalled();
  expect(JSON.stringify(net.renderer.toJSON())).toContain("Something went wrong");
});

it("busy: Save is disabled and shows 'Saving…'; the dialog never retries on its own", async () => {
  const setAssignees = jest.fn();
  const { renderer } = setup(lifecycle({ isProjectBusy: () => true, setAssignees }));
  expect(button(renderer, "Saving…").props.disabled).toBe(true);
  await act(async () => {
    await button(renderer, "Saving…").props.onClick();
  });
  expect(setAssignees).not.toHaveBeenCalled();
});
