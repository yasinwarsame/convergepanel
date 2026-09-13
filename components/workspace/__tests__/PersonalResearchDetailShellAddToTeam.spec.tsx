/**
 * ADD-TO-TEAM-PROJECT §S — the OWNER-ONLY "Add to Team Project" affordance on
 * `PersonalResearchDetailShell`, against a real rendered tree. Same
 * controlled boundaries as the shell's own suite (`useAuth`, `authedFetch`,
 * `ResultsDisplay` stubbed) plus: the Team offering signal (`useUserPlan`)
 * is switchable, the snapshot hook is a spy, and the dialog is a marker
 * element that exposes its props so the hand-off can be asserted.
 *
 * M23 target: rendering the action for a `personal_reviewer` makes Z37b fail.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "fs";
import { join } from "path";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className }, children as React.ReactNode);
  return { __esModule: true, default: MockLink };
});

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));

jest.mock("@/components/ResultsDisplay", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => require("react").createElement("div", { "data-testid": "results-display", "data-run-id": String(props.runId ?? "") }),
}));

let teamWorkspacesUiEnabled = true;
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ teamWorkspacesUiEnabled }) }));

const mockedIsSourceBusy = jest.fn((_sourceRunId: string) => false);
const mockedCreate = jest.fn();
jest.mock("@/hooks/useTeamResearchSnapshot", () => ({
  useTeamResearchSnapshot: () => ({ isSourceBusy: (id: string) => mockedIsSourceBusy(id), create: (...a: unknown[]) => mockedCreate(...a) }),
}));

const dialogProps: Record<string, unknown>[] = [];
jest.mock("@/components/workspace/AddToTeamProjectDialog", () => ({
  AddToTeamProjectDialog: (props: Record<string, unknown>) => {
    dialogProps.push(props);
    return require("react").createElement("div", { "data-testid": "add-to-team-dialog", "data-source": String(props.sourceRunId) });
  },
}));

import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";

const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const okRun = (over: Record<string, unknown> = {}) => ({
  ok: true,
  runId: "run-7",
  question: "What changed in the source evidence?",
  status: "complete",
  viewerRole: "owner",
  results: [{ modelId: "chatgpt", status: "ok", rawText: "answer" }],
  adaptive: { status: "absent", output: null },
  legacyAdaptive: { status: "absent", output: null },
  ...over,
});

function mount(runId = "run-7") {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(PersonalResearchDetailShell, { runId }));
  });
  return {
    renderer,
    rerenderWith: (nextRunId: string) =>
      act(() => {
        renderer.update(createElement(PersonalResearchDetailShell, { runId: nextRunId }));
      }),
  };
}

const textOf = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const addButtons = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType("button").filter((b) => JSON.stringify(b.props.children).includes("Add to Team Project"));
const dialogs = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.["data-testid"] === "add-to-team-dialog");

beforeEach(() => {
  jest.clearAllMocks();
  dialogProps.length = 0;
  teamWorkspacesUiEnabled = true;
  mockedIsSourceBusy.mockReturnValue(false);
  mockedUseAuth.mockReturnValue({ user: { uid: "uid_alice" }, authReady: true });
});

describe("Z37 — owner-only visibility", () => {
  it("Z37a (positive control) — OWNER + Team signal ON → the action renders, once, on the loaded report", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ viewerRole: "owner" })));
    const { renderer } = mount();
    await act(async () => {});
    expect(renderer.root.findAll((n) => n.props?.["data-testid"] === "results-display")).toHaveLength(1);
    expect(addButtons(renderer)).toHaveLength(1);
    expect(dialogs(renderer)).toHaveLength(0);
  });

  it("Z37b — a personal_reviewer sees the SAME loaded report but NO action (same fixture, only the role differs)", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ viewerRole: "personal_reviewer" })));
    const { renderer } = mount();
    await act(async () => {});
    expect(renderer.root.findAll((n) => n.props?.["data-testid"] === "results-display")).toHaveLength(1);
    expect(addButtons(renderer)).toHaveLength(0);
    expect(textOf(renderer)).not.toContain("Add to Team Project");
  });

  it("Z37c — OWNER with the Team signal OFF → no action", async () => {
    teamWorkspacesUiEnabled = false;
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ viewerRole: "owner" })));
    const { renderer } = mount();
    await act(async () => {});
    expect(addButtons(renderer)).toHaveLength(0);
  });

  it("no action while loading, or on unavailable / failed / in-progress states, even for an owner", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false }));
    let m = mount();
    await act(async () => {});
    expect(addButtons(m.renderer)).toHaveLength(0);
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ status: "running" })));
    m = mount("run-8");
    await act(async () => {});
    expect(addButtons(m.renderer)).toHaveLength(0);
  });

  it("the rendering precondition is pinned in source: viewerRole === \"owner\" AND teamWorkspacesUiEnabled", () => {
    const source = readFileSync(join(__dirname, "..", "PersonalResearchDetailShell.tsx"), "utf8");
    expect(source).toMatch(/viewerRole === "owner" && teamWorkspacesUiEnabled/);
    expect(source).not.toMatch(/PERSONAL_VIEWER_ROLES\.has\([^)]*\) && teamWorkspacesUiEnabled/);
  });
});

describe("hand-off and outcome", () => {
  it("clicking the action opens the dialog for THIS run; the trigger is disabled while this source is busy", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer } = mount();
    await act(async () => {});
    act(() => {
      addButtons(renderer)[0].props.onClick();
    });
    expect(dialogs(renderer)).toHaveLength(1);
    expect(dialogs(renderer)[0].props["data-source"]).toBe("run-7");
    expect(dialogProps[0].sourceRunId).toBe("run-7");
    mockedIsSourceBusy.mockReturnValue(true);
    act(() => {
      renderer.update(createElement(PersonalResearchDetailShell, { runId: "run-7" }));
    });
    expect(addButtons(renderer)[0].props.disabled).toBe(true);
  });

  it("onCreated closes the dialog and shows a status with the exact destination link; already_exists uses different copy", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer } = mount();
    await act(async () => {});
    act(() => {
      addButtons(renderer)[0].props.onClick();
    });
    const href = "/workspace/team/ws-1/projects/p-1/research/run-copy";
    act(() => {
      (dialogProps[0].onCreated as (r: unknown) => void)({ ok: true, status: "created", runId: "run-copy", workspaceId: "ws-1", projectId: "p-1", href });
    });
    expect(dialogs(renderer)).toHaveLength(0);
    expect(textOf(renderer)).toContain("A Team copy of this research was created.");
    expect(textOf(renderer)).toContain("Your Personal report is unchanged.");
    expect(renderer.root.findAllByType("a").some((a) => a.props.href === href)).toBe(true);

    act(() => {
      addButtons(renderer)[0].props.onClick();
    });
    act(() => {
      (dialogProps[dialogProps.length - 1].onCreated as (r: unknown) => void)({ ok: true, status: "already_exists", runId: "run-copy", workspaceId: "ws-1", projectId: "p-1", href });
    });
    expect(textOf(renderer)).toContain("already in that Team Project");
  });

  it("a run change clears the confirmation — it belongs to one run only", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer, rerenderWith } = mount();
    await act(async () => {});
    act(() => {
      addButtons(renderer)[0].props.onClick();
    });
    act(() => {
      (dialogProps[0].onCreated as (r: unknown) => void)({ ok: true, status: "created", runId: "run-copy", workspaceId: "ws-1", projectId: "p-1", href: "/workspace/team/ws-1/projects/p-1/research/run-copy" });
    });
    expect(textOf(renderer)).toContain("Team copy");
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ runId: "run-8" })));
    rerenderWith("run-8");
    await act(async () => {});
    expect(textOf(renderer)).not.toContain("Team copy of this research was created");
  });

  it("the shell never fetches the snapshot endpoint itself — the only reads are the run detail (and usage via the mocked plan hook)", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    mount();
    await act(async () => {});
    for (const call of mockedAuthedFetch.mock.calls) {
      expect(String(call[0])).not.toContain("/research/snapshots");
    }
  });
});
