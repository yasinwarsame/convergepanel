/**
 * Phase PROJECT-UI-AR-I1 — `TeamProjectLifecycleRow` behavior tests
 * (react-test-renderer; hook injected as a prop). Status drives the
 * action, `canManageProjects` and a non-null `updateTime` gate it, the
 * busy lock disables it, and every non-success outcome is handled
 * without a retry.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

import { TeamProjectLifecycleRow } from "@/components/workspace/projects/TeamProjectLifecycleRow";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";

const TOKEN = { seconds: 1723600000, nanoseconds: 5 };
const ACTIVE: TeamProjectSummary = { id: "p1", workspaceId: "ws-1", name: "Quarterly Diligence", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", updateTime: TOKEN };
const ARCHIVED: TeamProjectSummary = { ...ACTIVE, id: "p2", status: "archived" };

function lifecycle(overrides: Record<string, unknown> = {}) {
  return { isProjectBusy: () => false, getBusyOperation: () => null, archiveProject: jest.fn(), restoreProject: jest.fn(), ...overrides } as any;
}

async function mount(props: { project: TeamProjectSummary; canManageProjects: boolean; lifecycle: any; refreshSections?: () => void }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement("ul", null, createElement(TeamProjectLifecycleRow, { workspaceId: "ws-1", refreshSections: jest.fn(), ...props })));
  });
  return renderer;
}
const buttons = (r: TestRenderer.ReactTestRenderer, label: string) => r.root.findAllByType("button").filter((b) => b.props.children === label);

it("active + manage: Archive only; the name links to the Team detail route and is never nested with the buttons", async () => {
  const r = await mount({ project: ACTIVE, canManageProjects: true, lifecycle: lifecycle() });
  expect(buttons(r, "Archive")).toHaveLength(1);
  expect(buttons(r, "Restore")).toHaveLength(0);
  const link = r.root.findByType("a");
  expect(link.props.href).toBe("/workspace/team/ws-1/projects/p1");
  expect(link.props.children).toBe("Quarterly Diligence");
  expect(link.findAllByType("button")).toHaveLength(0);
});

it("archived + manage: Restore only", async () => {
  const r = await mount({ project: ARCHIVED, canManageProjects: true, lifecycle: lifecycle() });
  expect(buttons(r, "Restore")).toHaveLength(1);
  expect(buttons(r, "Archive")).toHaveLength(0);
});

it.each([
  ["active", ACTIVE],
  ["archived", ARCHIVED],
])("%s + cannot manage: no lifecycle control at all", async (_label, project) => {
  const r = await mount({ project, canManageProjects: false, lifecycle: lifecycle() });
  expect(r.root.findAllByType("button")).toHaveLength(0);
});

it.each([
  ["active", ACTIVE],
  ["archived", ARCHIVED],
])("%s with updateTime: null: no lifecycle control even for a manager", async (_label, project) => {
  const r = await mount({ project: { ...project, updateTime: null }, canManageProjects: true, lifecycle: lifecycle() });
  expect(r.root.findAllByType("button")).toHaveLength(0);
});

it("busy: Archive is disabled; a busy restore shows 'Restoring…' and is disabled", async () => {
  const a = await mount({ project: ACTIVE, canManageProjects: true, lifecycle: lifecycle({ isProjectBusy: () => true, getBusyOperation: () => "archive" }) });
  expect(buttons(a, "Archive")[0].props.disabled).toBe(true);
  const b = await mount({ project: ARCHIVED, canManageProjects: true, lifecycle: lifecycle({ isProjectBusy: () => true, getBusyOperation: () => "restore" }) });
  expect(buttons(b, "Restoring…")[0].props.disabled).toBe(true);
  expect(buttons(b, "Restore")).toHaveLength(0);
});

it("Restore is immediate (no dialog): one restoreProject call with the exact row, then refreshSections on success", async () => {
  const restoreProject = jest.fn().mockResolvedValue({ status: "ok", project: { ...ARCHIVED, status: "active" } });
  const refreshSections = jest.fn();
  const r = await mount({ project: ARCHIVED, canManageProjects: true, lifecycle: lifecycle({ restoreProject }), refreshSections });
  await act(async () => {
    await buttons(r, "Restore")[0].props.onClick();
  });
  expect(r.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(0);
  expect(restoreProject).toHaveBeenCalledTimes(1);
  expect(restoreProject).toHaveBeenCalledWith(ARCHIVED);
  expect(refreshSections).toHaveBeenCalledTimes(1);
});

it("Archive opens a confirmation dialog and sends nothing until confirmed", async () => {
  const archiveProject = jest.fn();
  const r = await mount({ project: ACTIVE, canManageProjects: true, lifecycle: lifecycle({ archiveProject }) });
  await act(async () => {
    buttons(r, "Archive")[0].props.onClick();
  });
  expect(r.root.findAll((n) => n.props?.role === "dialog")).toHaveLength(1);
  expect(archiveProject).not.toHaveBeenCalled();
});

it.each(["conflict", "invalid_project_status_transition", "project_not_found", "insufficient_capability", "team_workspace_not_found"])(
  "restore denied with %s: one request, inline role=alert message, refreshSections called, no retry",
  async (code) => {
    const restoreProject = jest.fn().mockResolvedValue({ status: "error", errorCode: code });
    const refreshSections = jest.fn();
    const r = await mount({ project: ARCHIVED, canManageProjects: true, lifecycle: lifecycle({ restoreProject }), refreshSections });
    await act(async () => {
      await buttons(r, "Restore")[0].props.onClick();
    });
    expect(restoreProject).toHaveBeenCalledTimes(1);
    expect(r.root.findAll((n) => n.props?.role === "alert")).toHaveLength(1);
    expect(refreshSections).toHaveBeenCalledTimes(1);
  }
);

it("restore generic failure: inline error, NO refresh, control still rendered for a manual retry", async () => {
  const restoreProject = jest.fn().mockResolvedValue({ status: "error", errorCode: "internal_error" });
  const refreshSections = jest.fn();
  const r = await mount({ project: ARCHIVED, canManageProjects: true, lifecycle: lifecycle({ restoreProject }), refreshSections });
  await act(async () => {
    await buttons(r, "Restore")[0].props.onClick();
  });
  expect(r.root.findAll((n) => n.props?.role === "alert")[0].props.children).toBe("Something went wrong. Please try again.");
  expect(refreshSections).not.toHaveBeenCalled();
  expect(buttons(r, "Restore")).toHaveLength(1);
});

it("long Project names: the name element can shrink and break, the action group does not (source-level layout contract)", async () => {
  const r = await mount({ project: { ...ACTIVE, name: "A".repeat(200) }, canManageProjects: true, lifecycle: lifecycle() });
  expect(r.root.findByType("a").props.className).toMatch(/min-w-0/);
  expect(r.root.findByType("a").props.className).toMatch(/break-words/);
  const group = r.root.findAll((n) => typeof n.type === "string" && n.type === "div" && /shrink-0/.test(n.props.className ?? ""));
  expect(group).toHaveLength(1);
  expect(group[0].props.className).toMatch(/flex-wrap/);
});
