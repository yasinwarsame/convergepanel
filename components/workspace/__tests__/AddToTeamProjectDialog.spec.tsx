/**
 * ADD-TO-TEAM-PROJECT §T/§U/§V — `AddToTeamProjectDialog` against a real
 * rendered tree. The two list hooks are controlled boundaries (their own
 * suites cover fetching); the snapshot hook is a spy. Z38 (disclosure) and
 * Z13 (Project mandatory, no Unfiled) live here.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";

let workspaceListState: Record<string, unknown> = { items: [], status: "ready", retry: jest.fn() };
jest.mock("@/hooks/useWorkspaceList", () => ({ useWorkspaceList: () => workspaceListState }));

const mockedUseTeamProjects = jest.fn();
jest.mock("@/hooks/useTeamProjects", () => ({
  useTeamProjects: (...a: unknown[]) => mockedUseTeamProjects(...a),
  isDefinitiveEmptyTeamProjectsState: (s: { status: string; items: unknown[]; hasMore: boolean }) => s.status === "ready" && s.items.length === 0 && s.hasMore === false,
}));

import { AddToTeamProjectDialog, ADD_TO_TEAM_FIDELITY_DISCLOSURE } from "@/components/workspace/AddToTeamProjectDialog";

const WS = [
  { workspaceId: "ws-1", name: "Acme Team" },
  { workspaceId: "ws-2", name: "Beta Team" },
];
const resetAndReloadFromStart = jest.fn();
const projectsReady = (items: Array<{ id: string; name: string }>) => ({
  items: items.map((p) => ({ ...p, workspaceId: "ws-1", status: "active", createdAt: "", updatedAt: "", updateTime: null })),
  hasMore: false,
  status: "ready",
  initialErrorCode: null,
  loadingMore: false,
  loadMoreErrorCode: null,
  loadMore: jest.fn(),
  retryInitial: jest.fn(),
  resetAndReloadFromStart,
});

const isSourceBusy = jest.fn((_sourceRunId: string) => false);
const create = jest.fn();
const snapshot = { isSourceBusy: (id: string) => isSourceBusy(id), create: (...a: unknown[]) => create(...a) };
const onCreated = jest.fn();
const onClose = jest.fn();

function mount() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      createElement(AddToTeamProjectDialog, { sourceRunId: "run-src", triggerRef: createRef<HTMLElement>(), onClose, snapshot: snapshot as never, onCreated })
    );
  });
  return renderer;
}
const textOf = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const options = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll((n) => n.type === "ul" && n.props["aria-label"] === label).flatMap((ul) => ul.findAllByType("button"));
const confirmButton = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType("button").find((b) => String(b.props.children).includes("Add to Team Project") || String(b.props.children).includes("Adding"))!;

beforeEach(() => {
  jest.clearAllMocks();
  isSourceBusy.mockReturnValue(false);
  workspaceListState = { items: WS, status: "ready", retry: jest.fn() };
  mockedUseTeamProjects.mockReturnValue(projectsReady([{ id: "p-1", name: "Due Diligence" }, { id: "p-2", name: "Market Scan" }]));
});

describe("Z38 — fidelity disclosure", () => {
  it("is rendered verbatim before any choice is made, and says copy / unchanged / model responses", () => {
    const r = mount();
    expect(textOf(r)).toContain(ADD_TO_TEAM_FIDELITY_DISCLOSURE);
    expect(ADD_TO_TEAM_FIDELITY_DISCLOSURE).toMatch(/Team copy/);
    expect(ADD_TO_TEAM_FIDELITY_DISCLOSURE).toMatch(/Personal report will stay unchanged/);
    expect(ADD_TO_TEAM_FIDELITY_DISCLOSURE).toMatch(/underlying model responses/);
    expect(ADD_TO_TEAM_FIDELITY_DISCLOSURE).not.toMatch(/move|identical|governance/i);
  });
});

describe("Z13 — Project is mandatory", () => {
  it("the confirm button is disabled until BOTH a Workspace and a Project are chosen; there is no Unfiled option", () => {
    const r = mount();
    expect(confirmButton(r).props.disabled).toBe(true);
    expect(textOf(r)).not.toMatch(/Unfiled/);
    // Projects are not even offered before a Workspace is chosen.
    expect(mockedUseTeamProjects).not.toHaveBeenCalled();

    act(() => options(r, "Team Workspaces")[0].props.onClick());
    expect(confirmButton(r).props.disabled).toBe(true);
    expect(mockedUseTeamProjects).toHaveBeenCalledWith({ workspaceId: "ws-1", status: "active" });

    act(() => options(r, "Active projects")[0].props.onClick());
    expect(confirmButton(r).props.disabled).toBe(false);
  });

  it("changing the Workspace clears the Project choice and remounts the Project step for the new Workspace", () => {
    const r = mount();
    act(() => options(r, "Team Workspaces")[0].props.onClick());
    act(() => options(r, "Active projects")[0].props.onClick());
    expect(confirmButton(r).props.disabled).toBe(false);
    act(() => options(r, "Team Workspaces")[1].props.onClick());
    expect(confirmButton(r).props.disabled).toBe(true);
    expect(mockedUseTeamProjects).toHaveBeenLastCalledWith({ workspaceId: "ws-2", status: "active" });
  });

  it("an empty Workspace list explains membership rather than offering nothing silently", () => {
    workspaceListState = { items: [], status: "ready", retry: jest.fn() };
    const r = mount();
    expect(textOf(r)).toContain("not a member of any Team Workspace");
  });
});

describe("§V — submission", () => {
  it("confirm dispatches exactly one create with the chosen destination and hands the result to onCreated", async () => {
    const dto = { ok: true, status: "created", runId: "run-copy", workspaceId: "ws-1", projectId: "p-2", href: "/workspace/team/ws-1/projects/p-2/research/run-copy" };
    create.mockResolvedValue({ status: "ok", snapshot: dto });
    const r = mount();
    act(() => options(r, "Team Workspaces")[0].props.onClick());
    act(() => options(r, "Active projects")[1].props.onClick());
    await act(async () => {
      await confirmButton(r).props.onClick();
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ sourceRunId: "run-src", workspaceId: "ws-1", projectId: "p-2" });
    expect(onCreated).toHaveBeenCalledWith(dto);
    expect(onClose).toHaveBeenCalled();
  });

  it("while this source is busy the confirm button is disabled and reads Adding…", () => {
    isSourceBusy.mockReturnValue(true);
    const r = mount();
    act(() => options(r, "Team Workspaces")[0].props.onClick());
    act(() => options(r, "Active projects")[0].props.onClick());
    expect(confirmButton(r).props.disabled).toBe(true);
    expect(String(confirmButton(r).props.children)).toContain("Adding");
  });

  it("a stale-Project denial shows honest copy, clears the Project choice and reloads the Project list; a transient error keeps the choice", async () => {
    create.mockResolvedValue({ status: "error", errorCode: "project_archived" });
    const r = mount();
    act(() => options(r, "Team Workspaces")[0].props.onClick());
    act(() => options(r, "Active projects")[0].props.onClick());
    await act(async () => {
      await confirmButton(r).props.onClick();
    });
    expect(textOf(r)).toContain("This Project is archived");
    expect(confirmButton(r).props.disabled).toBe(true);
    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();

    create.mockResolvedValue({ status: "error", errorCode: "network_error" });
    act(() => options(r, "Active projects")[0].props.onClick());
    await act(async () => {
      await confirmButton(r).props.onClick();
    });
    expect(textOf(r)).toContain("couldn't reach the server");
    expect(confirmButton(r).props.disabled).toBe(false);
    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
  });

  it("a concealed source denial and an insufficient_capability denial render their own honest copy", async () => {
    const r = mount();
    act(() => options(r, "Team Workspaces")[0].props.onClick());
    act(() => options(r, "Active projects")[0].props.onClick());
    create.mockResolvedValue({ status: "error", errorCode: "source_not_found" });
    await act(async () => {
      await confirmButton(r).props.onClick();
    });
    expect(textOf(r)).toContain("could not be copied");
    act(() => options(r, "Active projects")[0].props.onClick());
    create.mockResolvedValue({ status: "error", errorCode: "insufficient_capability" });
    await act(async () => {
      await confirmButton(r).props.onClick();
    });
    expect(textOf(r)).toContain("permission to add research");
  });
});
