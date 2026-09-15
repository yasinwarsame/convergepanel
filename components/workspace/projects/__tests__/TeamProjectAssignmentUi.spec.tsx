/**
 * Project/Research Assignment — UI wiring across the Team Project list row,
 * the Team Projects shell, and the Team Project detail shell
 * (react-test-renderer; hooks mocked/injected exactly as the sibling specs
 * do). Proves: the "Manage assignees" gate (D9 list-row-only editor),
 * chips render names never uids (D4 stale marker), the shell's
 * set_assignees outcome copy + refetch, the `?assignee=me` filter control
 * feeding the hooks, the research row's SIBLING "Assign" action (never
 * nested in the row link), the detail header's READ-ONLY chips with NO
 * editor, and the run row's assignee line.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
const mockedUseTeamProjects = jest.fn();
jest.mock("@/hooks/useTeamProjects", () => {
  const actual = jest.requireActual("@/hooks/useTeamProjects");
  return { ...actual, useTeamProjects: (...args: any[]) => mockedUseTeamProjects(...args) };
});
const mockedUseTeamProjectLifecycle = jest.fn();
jest.mock("@/hooks/useTeamProjectLifecycle", () => ({ useTeamProjectLifecycle: (...args: any[]) => mockedUseTeamProjectLifecycle(...args) }));
const mockedUseTeamProjectRuns = jest.fn();
jest.mock("@/hooks/useTeamProjectRuns", () => {
  const actual = jest.requireActual("@/hooks/useTeamProjectRuns");
  return { ...actual, useTeamProjectRuns: (...args: any[]) => mockedUseTeamProjectRuns(...args) };
});
const mockedUseTeamRunAssignee = jest.fn();
jest.mock("@/hooks/useTeamRunAssignee", () => ({ useTeamRunAssignee: (...args: any[]) => mockedUseTeamRunAssignee(...args) }));
jest.mock("@/hooks/useWorkspaceMembers", () => ({ useWorkspaceMembers: () => ({ status: "ready", members: [], workspaceUpdateToken: null, reload: jest.fn() }) }));

import { TeamProjectLifecycleRow } from "@/components/workspace/projects/TeamProjectLifecycleRow";
import TeamProjectsShell from "@/components/workspace/projects/TeamProjectsShell";
import TeamProjectDetailShell from "@/components/workspace/projects/TeamProjectDetailShell";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

const TOKEN = { seconds: 1, nanoseconds: 0 };
const ASSIGNEES = [
  { uid: "m1", displayName: "Bao", state: "active" as const },
  { uid: "gone", displayName: "Chidi", state: "stale" as const },
];
const ACTIVE: TeamProjectSummary = { id: "p1", workspaceId: "ws-1", name: "Quarterly Diligence", status: "active", createdAt: "x", updatedAt: "x", updateTime: TOKEN, assignees: ASSIGNEES };
const lifecycle = (o: Record<string, unknown> = {}) => ({ isCreating: false, createProject: jest.fn(), isProjectBusy: () => false, getBusyOperation: () => null, archiveProject: jest.fn(), restoreProject: jest.fn(), setAssignees: jest.fn(), ...o }) as any;
const buttons = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAllByType("button").filter((b) => b.props.children === label);
const listResult = (o: Record<string, unknown> = {}) => ({ items: [], hasMore: false, status: "ready", initialErrorCode: null, loadingMore: false, loadMoreErrorCode: null, loadMore: jest.fn(), retryInitial: jest.fn(), resetAndReloadFromStart: jest.fn(), ...o });

describe("TeamProjectLifecycleRow", () => {
  async function mount(props: Record<string, unknown>) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement("ul", null, createElement(TeamProjectLifecycleRow, { workspaceId: "ws-1", project: ACTIVE, canManageProjects: true, lifecycle: lifecycle(), onLifecycleAttemptStart: jest.fn(), onLifecycleOutcome: jest.fn(), ...props } as any)));
    });
    return renderer;
  }
  it("renders assignee chips by DISPLAY NAME with the stale marker, never a uid", async () => {
    const r = await mount({});
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Bao");
    expect(text).toContain("Chidi");
    expect(text).toContain("no longer eligible");
    expect(text).not.toContain('"m1"');
    expect(text).not.toContain("gone");
  });
  it("'Manage assignees' renders ONLY when manage + live token + active + assignmentUiEnabled (positive control first)", async () => {
    expect(buttons(await mount({ assignmentUiEnabled: true }), "Manage assignees")).toHaveLength(1);
    expect(buttons(await mount({}), "Manage assignees")).toHaveLength(0); // rollout hint absent
    expect(buttons(await mount({ assignmentUiEnabled: true, canManageProjects: false }), "Manage assignees")).toHaveLength(0);
    expect(buttons(await mount({ assignmentUiEnabled: true, project: { ...ACTIVE, updateTime: null } }), "Manage assignees")).toHaveLength(0);
    expect(buttons(await mount({ assignmentUiEnabled: true, project: { ...ACTIVE, status: "archived" } }), "Manage assignees")).toHaveLength(0);
  });
  it("the action is a SIBLING of the name link (never nested), opens the picker, and signals attempt-start; a busy row disables it", async () => {
    const onLifecycleAttemptStart = jest.fn();
    const r = await mount({ assignmentUiEnabled: true, onLifecycleAttemptStart });
    expect(r.root.findByType("a").findAllByType("button")).toHaveLength(0);
    await act(async () => {
      buttons(r, "Manage assignees")[0].props.onClick();
    });
    expect(r.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(1);
    expect(onLifecycleAttemptStart).toHaveBeenCalledTimes(1);
    const busy = await mount({ assignmentUiEnabled: true, lifecycle: lifecycle({ isProjectBusy: () => true }) });
    expect(buttons(busy, "Manage assignees")[0].props.disabled).toBe(true);
  });
});

describe("TeamProjectsShell", () => {
  async function mount(props: Record<string, unknown> = {}) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(TeamProjectsShell, { workspaceId: "ws-1", workspaceName: "Acme", canCreateProject: true, canManageProjects: true, canReadAudit: false, ...props } as any));
    });
    return renderer;
  }
  beforeEach(() => {
    mockedUseTeamProjects.mockReturnValue(listResult({ items: [ACTIVE] }));
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycle());
  });
  it("'Assigned to me' filter renders only with assignmentUiEnabled and drives BOTH list hooks' assigneeFilter (null ⇒ 'me')", async () => {
    const off = await mount();
    expect(JSON.stringify(off.toJSON())).not.toContain("Assigned to me");
    mockedUseTeamProjects.mockClear();
    const r = await mount({ assignmentUiEnabled: true });
    expect(mockedUseTeamProjects.mock.calls.every((c) => c[0].assigneeFilter === null)).toBe(true);
    const box = r.root.findAllByType("input").find((i) => i.props.type === "checkbox")!;
    mockedUseTeamProjects.mockClear();
    await act(async () => {
      box.props.onChange({ target: { checked: true } });
    });
    const calls = mockedUseTeamProjects.mock.calls.map((c) => [c[0].status, c[0].assigneeFilter]);
    expect(calls).toContainEqual(["active", "me"]);
    expect(calls).toContainEqual(["archived", "me"]);
  });
  it("filtered empty state is honest ('No projects are assigned to you.'), never the create prompt", async () => {
    mockedUseTeamProjects.mockReturnValue(listResult({ items: [] }));
    const r = await mount({ assignmentUiEnabled: true });
    await act(async () => {
      r.root.findAllByType("input").find((i) => i.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
    });
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("No projects are assigned to you.");
    expect(text).not.toContain("Create a Project to organize");
  });
  it("a committed set_assignees outcome refetches BOTH sections and shows 'Assignees for <name> were updated.' (no ids)", async () => {
    const active = listResult({ items: [ACTIVE] });
    const archived = listResult();
    mockedUseTeamProjects.mockImplementation((args: { status: string }) => (args.status === "archived" ? archived : active));
    const setAssignees = jest.fn().mockResolvedValue({ status: "ok", project: ACTIVE });
    mockedUseTeamProjectLifecycle.mockReturnValue(lifecycle({ setAssignees }));
    const r = await mount({ assignmentUiEnabled: true });
    await act(async () => {
      buttons(r, "Manage assignees")[0].props.onClick();
    });
    await act(async () => {
      await buttons(r, "Save assignees")[0].props.onClick();
    });
    expect(active.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(archived.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    const notice = r.root.findAll((n) => n.props?.role === "status" && n.props?.tabIndex === -1);
    expect(notice).toHaveLength(1);
    const text = JSON.stringify(notice[0].props.children);
    expect(text).toContain("Assignees for Quarterly Diligence were updated.");
    expect(text).not.toContain("p1");
  });
});

describe("TeamProjectDetailShell", () => {
  const run = (o: Record<string, unknown> = {}) => ({ id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "What is the TAM?", selectedModels: [], status: "complete", modelsOk: 2, modelsTotal: 2, projectId: "p1", assignee: null, ...o });
  async function mount(props: Record<string, unknown> = {}) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(TeamProjectDetailShell, { workspaceId: "ws-1", workspaceName: "Acme", canReadAudit: false, canStartResearch: true, project: { id: "p1", name: "Quarterly Diligence", status: "active", assignees: ASSIGNEES }, ...props } as any));
    });
    return renderer;
  }
  beforeEach(() => {
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ items: [run({ assignee: { uid: "m1", displayName: "Bao", state: "stale" } })] }));
    mockedUseTeamRunAssignee.mockReturnValue({ isRunBusy: () => false, loadRunAssignee: jest.fn().mockResolvedValue({ status: "ok", assignee: null, reviewerUids: [] }), setRunAssignee: jest.fn() });
  });
  it("D9 — header chips are READ-ONLY: names rendered, no 'Manage assignees' control anywhere, no token plumbing", async () => {
    const r = await mount({ assignmentUiEnabled: true, canAssignResearch: true });
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Bao");
    expect(text).toContain("Chidi");
    expect(buttons(r, "Manage assignees")).toHaveLength(0);
  });
  it("research row shows 'Assigned to <name>' (stale marker) INSIDE the link, and the 'Assign' action as a SIBLING outside it, gated on research.organize + rollout + active Project", async () => {
    const r = await mount({ assignmentUiEnabled: true, canAssignResearch: true });
    const rowLink = r.root.findAllByType("a").find((a) => a.props.href === "/workspace/team/ws-1/projects/p1/research/run-1")!;
    const assigneeLine = rowLink.findAll((n) => n.props?.["data-testid"] === "team-run-row-assignee");
    expect(assigneeLine).toHaveLength(1);
    const lineText = JSON.stringify(TestRenderer.create(createElement("span", null, ...assigneeLine[0].props.children)).toJSON());
    expect(lineText).toContain("Assigned to ");
    expect(lineText).toContain("Bao");
    expect(lineText).toContain("(no longer eligible)");
    expect(rowLink.findAllByType("button")).toHaveLength(0);
    expect(buttons(r, "Assign")).toHaveLength(1);
    expect(buttons(await mount({ assignmentUiEnabled: true, canAssignResearch: false }), "Assign")).toHaveLength(0);
    expect(buttons(await mount({ assignmentUiEnabled: false, canAssignResearch: true }), "Assign")).toHaveLength(0);
    expect(buttons(await mount({ assignmentUiEnabled: true, canAssignResearch: true, project: { id: "p1", name: "Old", status: "archived", assignees: [] } }), "Assign")).toHaveLength(0);
  });
  it("'Assign' opens the run picker; a committed save refetches the list and shows a status notice", async () => {
    const runs = listResult({ items: [run()] });
    mockedUseTeamProjectRuns.mockReturnValue(runs);
    const setRunAssignee = jest.fn().mockResolvedValue({ status: "ok", changed: true, assigneeUid: null });
    mockedUseTeamRunAssignee.mockReturnValue({ isRunBusy: () => false, loadRunAssignee: jest.fn().mockResolvedValue({ status: "ok", assignee: null, reviewerUids: [] }), setRunAssignee });
    const r = await mount({ assignmentUiEnabled: true, canAssignResearch: true });
    await act(async () => {
      buttons(r, "Assign")[0].props.onClick();
    });
    expect(r.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(1);
    await act(async () => {
      await buttons(r, "Save")[0].props.onClick();
    });
    expect(setRunAssignee).toHaveBeenCalledWith({ runId: "run-1", assigneeUid: null, expectedAssigneeUid: null });
    expect(runs.resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r.toJSON())).toContain("Research assignment updated.");
  });
  it("'Assigned to me' filter drives the runs hook and yields an honest empty state", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(listResult({ items: [] }));
    const r = await mount({ assignmentUiEnabled: true });
    mockedUseTeamProjectRuns.mockClear();
    await act(async () => {
      r.root.findAllByType("input").find((i) => i.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
    });
    expect(mockedUseTeamProjectRuns).toHaveBeenLastCalledWith({ workspaceId: "ws-1", projectId: "p1", assigneeFilter: "me" });
    expect(JSON.stringify(r.toJSON())).toContain("No research in this project is assigned to you.");
  });
});
