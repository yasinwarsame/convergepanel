/**
 * Team Project Research Composer, Phase 12A.3 — `TeamResearchComposerShell`
 * interactive behavior. `react-test-renderer` + `act()`, mirroring
 * `TeamProjectsShell.spec.tsx`'s convention: `useUserPlan`/
 * `useTeamProjectResearch` mocked directly, the real component tree/render
 * logic exercised end-to-end.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

const mockedUseUserPlan = jest.fn();
jest.mock("@/hooks/useUserPlan", () => ({
  useUserPlan: (...args: any[]) => mockedUseUserPlan(...args),
}));

const mockedUseTeamProjectResearch = jest.fn();
jest.mock("@/hooks/useTeamProjectResearch", () => ({
  useTeamProjectResearch: (...args: any[]) => mockedUseTeamProjectResearch(...args),
}));

import TeamResearchComposerShell from "@/components/workspace/projects/TeamResearchComposerShell";

const WS_ID = "ws-1";
const PROJECT = { id: "proj-1", name: "ABC Acquisition" };

function planResult(overrides: Partial<any> = {}) {
  return { plan: "full", loading: false, error: null, ...overrides };
}

function researchResult(overrides: Partial<any> = {}) {
  return { isSubmitting: false, submit: jest.fn(), ...overrides };
}

async function mount(props: Partial<React.ComponentProps<typeof TeamResearchComposerShell>> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TeamResearchComposerShell, {
        workspaceId: WS_ID,
        workspaceName: "Acme Team",
        project: PROJECT,
        canReadAudit: true,
        ...props,
      })
    );
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseUserPlan.mockReturnValue(planResult());
  mockedUseTeamProjectResearch.mockReturnValue(researchResult());
});

describe("TeamResearchComposerShell", () => {
  it("renders the Workspace name and the bound Project name — never asking the user to select either", async () => {
    const renderer = await mount();
    expect(renderer.root.findByType("h1").props.children).toBe("Acme Team");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("ABC Acquisition");
  });

  it("NO Workspace picker and NO Project picker anywhere in the tree — the only <select> present is ModelPicker's own preset dropdown, never a Workspace/Project chooser", async () => {
    const renderer = await mount();
    const selects = renderer.root.findAllByType("select");
    expect(selects.length).toBe(1); // ModelPicker's preset dropdown only
    const optionLabels = selects[0].findAllByType("option").map((o) => o.props.children);
    for (const label of optionLabels) {
      expect(String(label)).not.toMatch(/Acme Team|ABC Acquisition|Workspace|Project/i);
    }
    // Workspace/Project names appear as plain, non-interactive text, never inside a select's own options.
    expect(String(renderer.root.findByType("h1").props.children)).toBe("Acme Team");
  });

  it("passes workspaceId and the route-bound projectId to the research hook exactly", async () => {
    await mount({ project: { id: "proj-xyz", name: "X" } });
    expect(mockedUseTeamProjectResearch).toHaveBeenCalledWith({ workspaceId: WS_ID, projectId: "proj-xyz" });
  });

  it("empty question -> validation error, submit() never called", async () => {
    const submit = jest.fn();
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const renderer = await mount();
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(submit).not.toHaveBeenCalled();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Enter a question");
  });

  it("valid submission calls submit() with the typed question and current model selection", async () => {
    const submit = jest.fn().mockResolvedValue({ status: "ok", run: { runId: "run-1", results: [] } });
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const renderer = await mount();

    const textarea = renderer.root.findByProps({ id: "team-research-question" });
    await act(async () => {
      textarea.props.onChange({ target: { value: "What is the market size?" } });
    });

    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].question).toBe("What is the market size?");
    expect(Array.isArray(submit.mock.calls[0][0].selectedModels)).toBe(true);
    expect(submit.mock.calls[0][0].selectedModels.length).toBeGreaterThanOrEqual(2);
  });

  it("successful submission shows the result view and 'Back to Project' / 'Start another research' actions, hides the form", async () => {
    const submit = jest.fn().mockResolvedValue({
      status: "ok",
      run: { runId: "run-1", results: [{ modelId: "chatgpt", status: "ok", rawTextFull: "42", latencyMs: 100, tokenUsage: {}, requestedModel: "gpt", provider: "openai", actualModel: "gpt" }] },
    });
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const renderer = await mount();

    const textarea = renderer.root.findByProps({ id: "team-research-question" });
    await act(async () => {
      textarea.props.onChange({ target: { value: "Q" } });
    });
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(renderer.root.findAllByType("form").length).toBe(0);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Research complete");
    expect(text).toContain("Back to Project");
    expect(text).toContain("Start another research");
  });

  it("failed submission shows a clear error, does NOT show a result view, form remains usable", async () => {
    const submit = jest.fn().mockResolvedValue({ status: "error", errorCode: "RUN_LIMIT_REACHED", message: "You've reached your monthly run limit." });
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const renderer = await mount();

    const textarea = renderer.root.findByProps({ id: "team-research-question" });
    await act(async () => {
      textarea.props.onChange({ target: { value: "Q" } });
    });
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("You've reached your monthly run limit.");
    expect(text).not.toContain("Research complete");
    expect(renderer.root.findAllByType("form").length).toBe(1);
  });

  it("'Start another research' resets the form and clears the previous result", async () => {
    const submit = jest.fn().mockResolvedValue({ status: "ok", run: { runId: "run-1", results: [] } });
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const renderer = await mount();

    const textarea = renderer.root.findByProps({ id: "team-research-question" });
    await act(async () => {
      textarea.props.onChange({ target: { value: "Q" } });
    });
    const form = renderer.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(renderer.root.findAllByType("form").length).toBe(0);

    const startAnotherButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Start another research")!;
    await act(async () => {
      startAnotherButton.props.onClick();
    });
    expect(renderer.root.findAllByType("form").length).toBe(1);
    const newTextarea = renderer.root.findByProps({ id: "team-research-question" });
    expect(newTextarea.props.value).toBe("");
  });

  it("Run Research is disabled while isSubmitting is true", async () => {
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ isSubmitting: true }));
    const renderer = await mount();
    const runButton = renderer.root.findAllByType("button").find((b) => (b.props.children as any)?.toString().includes("Running") || b.props.type === "submit");
    expect(runButton).toBeDefined();
    expect(runButton!.props.disabled).toBe(true);
  });

  it("'Back to Project' link always points at this exact Workspace/Project, never Personal, never a different Project", async () => {
    const renderer = await mount({ project: { id: "proj-xyz", name: "X" } });
    const backLink = renderer.root.findAllByType("a").find((a) => a.props.children === "Back to Project");
    expect(backLink).toBeDefined();
    expect(backLink!.props.href).toBe(`/workspace/team/${WS_ID}/projects/proj-xyz`);
  });
});
