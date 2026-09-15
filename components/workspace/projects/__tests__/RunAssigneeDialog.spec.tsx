/**
 * Project/Research Assignment — `RunAssigneeDialog` (react-test-renderer,
 * `useWorkspaceMembers` mocked, the assignee hook injected). Proves the D2
 * client MIRROR (pinned to the server matrix), the D8 non-blocking overlap
 * warning, the expected-state token from the loaded current assignee, the
 * stale-current disclosure, and the outcome split.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseWorkspaceMembers = jest.fn();
jest.mock("@/hooks/useWorkspaceMembers", () => ({ useWorkspaceMembers: (...a: unknown[]) => mockedUseWorkspaceMembers(...a) }));

import { RunAssigneeDialog, teamRunAssigneeErrorCopy, shouldRefreshAfterTeamRunAssigneeError } from "@/components/workspace/projects/RunAssigneeDialog";
import { RUN_ASSIGNEE_ELIGIBLE_ROLES } from "@/lib/workspaces/assignmentTargetEligibilityClient";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const member = (uid: string, role: string) => ({ uid, displayName: `Name(${uid})`, role, isCanonicalOwner: role === "owner", joinedAt: "x", updateTimeToken: { seconds: 1, nanoseconds: 0 } });
const MEMBERS = [member("owner-1", "owner"), member("a1", "admin"), member("m1", "member"), member("r1", "reviewer"), member("v1", "viewer")];
const RUN = { id: "run-1", question: "What is the TAM?" };

function setup(assignment: any, handlers: Partial<{ onClose: jest.Mock; onSaved: jest.Mock; onStaleOrGone: jest.Mock }> = {}) {
  const onClose = handlers.onClose ?? jest.fn();
  const onSaved = handlers.onSaved ?? jest.fn();
  const onStaleOrGone = handlers.onStaleOrGone ?? jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  return (async () => {
    await act(async () => {
      renderer = TestRenderer.create(createElement(RunAssigneeDialog, { workspaceId: "ws-1", run: RUN, triggerRef: createRef<HTMLButtonElement>(), onClose, assignment, onSaved, onStaleOrGone }));
    });
    return { renderer, onClose, onSaved, onStaleOrGone };
  })();
}
const button = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAllByType("button").find((b) => b.props.children === label)!;
const radios = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType("input").filter((i) => i.props.type === "radio");
const assignment = (overrides: Record<string, unknown> = {}) => ({
  isRunBusy: () => false,
  loadRunAssignee: jest.fn().mockResolvedValue({ status: "ok", assignee: null, reviewerUids: [] }),
  setRunAssignee: jest.fn().mockResolvedValue({ status: "ok", changed: true, assigneeUid: "m1" }),
  ...overrides,
});

beforeEach(() => {
  mockedUseWorkspaceMembers.mockReset();
  mockedUseWorkspaceMembers.mockReturnValue({ status: "ready", members: MEMBERS, workspaceUpdateToken: null, reload: jest.fn() });
});

describe("D2 client mirror", () => {
  it("SOURCE PIN — RUN_ASSIGNEE_ELIGIBLE_ROLES equals exactly the server roles holding research.create", () => {
    const serverRoles = (Object.keys(ROLE_CAPABILITIES) as (keyof typeof ROLE_CAPABILITIES)[]).filter((r) => ROLE_CAPABILITIES[r].includes("research.create")).sort();
    expect(Array.from(RUN_ASSIGNEE_ELIGIBLE_ROLES).sort()).toEqual(serverRoles);
  });
  it("offers Unassigned + only mirror-eligible members (Owner/Admin/Member), labelled as a mirror of the server rule", async () => {
    const { renderer } = await setup(assignment());
    const labels = radios(renderer).length;
    expect(labels).toBe(4); // Unassigned + owner + admin + member
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Name(m1)");
    expect(text).not.toContain("Name(r1)");
    expect(text).not.toContain("Name(v1)");
    expect(text).toContain("mirror of the server rule");
  });
});

describe("expected-state token and current assignee", () => {
  it("loads the CURRENT assignee on open, pre-selects it, and sends it back as expectedAssigneeUid with the new choice", async () => {
    const loadRunAssignee = jest.fn().mockResolvedValue({ status: "ok", assignee: { uid: "a1", displayName: "Name(a1)", state: "active" }, reviewerUids: [] });
    const setRunAssignee = jest.fn().mockResolvedValue({ status: "ok", changed: true, assigneeUid: "m1" });
    const { renderer, onSaved, onClose } = await setup(assignment({ loadRunAssignee, setRunAssignee }));
    expect(loadRunAssignee).toHaveBeenCalledWith("run-1", expect.anything());
    const r = radios(renderer);
    expect(r[2].props.checked).toBe(true); // a1
    await act(async () => {
      r[3].props.onChange(); // m1
    });
    await act(async () => {
      await button(renderer, "Save").props.onClick();
    });
    expect(setRunAssignee).toHaveBeenCalledWith({ runId: "run-1", assigneeUid: "m1", expectedAssigneeUid: "a1" });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("a STALE current assignee (no longer mirror-eligible) is disclosed, disabled, and still used as the expected value when clearing", async () => {
    const loadRunAssignee = jest.fn().mockResolvedValue({ status: "ok", assignee: { uid: "v1", displayName: "Name(v1)", state: "stale" }, reviewerUids: [] });
    const setRunAssignee = jest.fn().mockResolvedValue({ status: "ok", changed: true, assigneeUid: null });
    const { renderer } = await setup(assignment({ loadRunAssignee, setRunAssignee }));
    const stale = renderer.root.findAll((n) => n.props?.["data-testid"] === "stale-current-assignee");
    expect(stale).toHaveLength(1);
    expect(stale[0].findByType("input").props.disabled).toBe(true);
    await act(async () => {
      radios(renderer)[0].props.onChange(); // Unassigned
    });
    await act(async () => {
      await button(renderer, "Save").props.onClick();
    });
    expect(setRunAssignee).toHaveBeenCalledWith({ runId: "run-1", assigneeUid: null, expectedAssigneeUid: "v1" });
  });
  it("a failed current-assignee load disables Save and shows the mapped copy (never submits with a guessed token)", async () => {
    const { renderer } = await setup(assignment({ loadRunAssignee: jest.fn().mockResolvedValue({ status: "error", errorCode: "run_not_found" }) }));
    expect(button(renderer, "Save").props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("This research could not be found.");
  });
});

describe("D8 — reviewer overlap warning is NON-blocking", () => {
  it("shows the warning only when the selected member is a current reviewer; Save stays enabled and the write proceeds", async () => {
    const setRunAssignee = jest.fn().mockResolvedValue({ status: "ok", changed: true, assigneeUid: "m1" });
    const { renderer } = await setup(assignment({ loadRunAssignee: jest.fn().mockResolvedValue({ status: "ok", assignee: null, reviewerUids: ["m1"] }), setRunAssignee }));
    const warning = () => renderer.root.findAll((n) => n.props?.["data-testid"] === "reviewer-overlap-warning");
    expect(warning()).toHaveLength(0);
    await act(async () => {
      radios(renderer)[3].props.onChange(); // m1 (a reviewer)
    });
    expect(warning()).toHaveLength(1);
    expect(button(renderer, "Save").props.disabled).toBe(false);
    await act(async () => {
      radios(renderer)[2].props.onChange(); // a1 (not a reviewer)
    });
    expect(warning()).toHaveLength(0);
    await act(async () => {
      radios(renderer)[3].props.onChange();
    });
    expect(warning()).toHaveLength(1);
    await act(async () => {
      await button(renderer, "Save").props.onClick();
    });
    expect(setRunAssignee).toHaveBeenCalledWith({ runId: "run-1", assigneeUid: "m1", expectedAssigneeUid: null });
  });
});

describe("outcomes", () => {
  it("conflict / gone / denied ⇒ close + onStaleOrGone; assignee_not_eligible ⇒ stay open + reload members; transient ⇒ stay open", async () => {
    for (const code of ["assignee_conflict", "run_not_found", "team_workspace_not_found", "insufficient_capability"]) {
      expect(shouldRefreshAfterTeamRunAssigneeError(code as never)).toBe(true);
      const { renderer, onStaleOrGone, onClose } = await setup(assignment({ setRunAssignee: jest.fn().mockResolvedValue({ status: "error", errorCode: code }) }));
      await act(async () => {
        await button(renderer, "Save").props.onClick();
      });
      expect(onStaleOrGone).toHaveBeenCalledWith(teamRunAssigneeErrorCopy(code as never));
      expect(onClose).toHaveBeenCalledTimes(1);
    }
    const reload = jest.fn();
    mockedUseWorkspaceMembers.mockReturnValue({ status: "ready", members: MEMBERS, workspaceUpdateToken: null, reload });
    const a = await setup(assignment({ setRunAssignee: jest.fn().mockResolvedValue({ status: "error", errorCode: "assignee_not_eligible" }) }));
    await act(async () => {
      await button(a.renderer, "Save").props.onClick();
    });
    expect(a.onClose).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(a.renderer.root.findAll((n) => n.props?.role === "alert")).toHaveLength(1);
    const t = await setup(assignment({ setRunAssignee: jest.fn().mockResolvedValue({ status: "error", errorCode: "network_error" }) }));
    await act(async () => {
      await button(t.renderer, "Save").props.onClick();
    });
    expect(t.onClose).not.toHaveBeenCalled();
    expect(t.onStaleOrGone).not.toHaveBeenCalled();
  });
  it("busy: Save disabled, 'Saving…', no submit", async () => {
    const setRunAssignee = jest.fn();
    const { renderer } = await setup(assignment({ isRunBusy: () => true, setRunAssignee }));
    expect(button(renderer, "Saving…").props.disabled).toBe(true);
    await act(async () => {
      await button(renderer, "Saving…").props.onClick();
    });
    expect(setRunAssignee).not.toHaveBeenCalled();
  });
});
