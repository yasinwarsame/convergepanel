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
    // Phase 11B.3 — the h1 states the current inline content state; the
    // Workspace and Project names are the breadcrumb's own segments.
    expect(renderer.root.findByType("h1").props.children).toBe("Start research");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Acme Team");
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
    expect(String(renderer.root.findByType("h1").props.children)).toBe("Start research");
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

  describe("result-heading correction — stale 'Start research' must not remain above a completed result", () => {
    it("before any submission, the heading reads 'Start research'", async () => {
      const renderer = await mount();
      expect(renderer.root.findByType("h1").props.children).toBe("Start research");
    });

    it("while composing (question typed, not yet submitted), the heading still reads 'Start research'", async () => {
      const renderer = await mount();
      const textarea = renderer.root.findByProps({ id: "team-research-question" });
      await act(async () => {
        textarea.props.onChange({ target: { value: "What is the market size?" } });
      });
      expect(renderer.root.findByType("h1").props.children).toBe("Start research");
    });

    it("after a successful run, the heading shows the actual submitted question, not 'Start research'", async () => {
      const submit = jest.fn().mockResolvedValue({ status: "ok", run: { runId: "run-1", results: [] } });
      mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
      const renderer = await mount();

      const textarea = renderer.root.findByProps({ id: "team-research-question" });
      await act(async () => {
        textarea.props.onChange({ target: { value: "What is the market size for widgets?" } });
      });
      const form = renderer.root.findByType("form");
      await act(async () => {
        await form.props.onSubmit({ preventDefault: () => {} });
      });

      const h2 = renderer.root.findByType("h1");
      expect(h2.props.children).toBe("What is the market size for widgets?");
      expect(h2.props.children).not.toBe("Start research");
    });

    it("'Start another research' resets the heading back to 'Start research', not the stale question", async () => {
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
      expect(renderer.root.findByType("h1").props.children).toBe("Q");

      const startAnotherButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Start another research")!;
      await act(async () => {
        startAnotherButton.props.onClick();
      });
      expect(renderer.root.findByType("h1").props.children).toBe("Start research");
    });

    it("a failed submission leaves the heading as 'Start research' (no result was ever set)", async () => {
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

      expect(renderer.root.findByType("h1").props.children).toBe("Start research");
    });
  });
});

/* ------------------------------------------------------------------ *
 * Phase 11B.3 — Breadcrumb inspection helpers.
 *
 * The REAL `Breadcrumb` is rendered (never mocked), so these read the shipped
 * component's own markup: its `<nav aria-label="Breadcrumb">` landmark, the
 * desktop `<ol>` hierarchy, and the separate mobile parent affordance.
 * `aria-hidden` nodes (the "/" separators and the "←" glyph) are excluded, so a
 * label assertion can never accidentally pass on decorative text.
 * ------------------------------------------------------------------ */
type BcSeg = { label: string; href?: string; current: boolean };

function visibleTextOf(node: TestRenderer.ReactTestInstance): string {
  const out: string[] = [];
  const walk = (n: TestRenderer.ReactTestInstance) => {
    n.children.forEach((c) => {
      if (typeof c === "string") out.push(c);
      else if (c.props?.["aria-hidden"] !== "true") walk(c);
    });
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
}

function breadcrumbNav(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === "Breadcrumb", { deep: true });
}

function bcSegments(r: TestRenderer.ReactTestRenderer): BcSeg[] {
  const navs = breadcrumbNav(r);
  if (navs.length === 0) return [];
  const ol = navs[0].findAllByType("ol")[0];
  return ol.findAllByType("li").map((li) => {
    const el = li.findAll((n) => (n.type === "a" || n.type === "span") && n.props?.["aria-hidden"] !== "true", { deep: true })[0];
    return {
      label: visibleTextOf(el),
      href: el.type === "a" ? String(el.props.href) : undefined,
      current: el.props["aria-current"] === "page",
    };
  });
}

function bcMobileParent(r: TestRenderer.ReactTestRenderer): { label: string; href?: string } | null {
  const navs = breadcrumbNav(r);
  if (navs.length === 0) return null;
  const wrap = navs[0].findAll(
    (n) => n.type === "div" && typeof n.props?.className === "string" && n.props.className.includes("sm:hidden"),
    { deep: true }
  );
  if (wrap.length === 0) return null;
  const el = wrap[0].findAll((n) => n.type === "a" || n.type === "span", { deep: true })[0];
  return { label: visibleTextOf(el), href: el.type === "a" ? String(el.props.href) : undefined };
}

function h1Texts(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root.findAllByType("h1").map(visibleTextOf);
}

describe("Phase 11B.3 — Research composer breadcrumb", () => {
  const WS = "ws_123";
  const WS_NAME = "Acme Risk Lab";
  const PID = "proj_456";
  const PNAME = "Election Evidence";
  const QUESTION = "What changed in the source evidence?";

  async function mountComposer(workspaceId = WS, projectId = PID) {
    return mount({ workspaceId, workspaceName: WS_NAME, project: { id: projectId, name: PNAME } });
  }

  it("AD1 — desktop hierarchy is {Workspace} / Projects / {Project} / New research, terminal non-linking", async () => {
    expect(bcSegments(await mountComposer())).toEqual([
      { label: WS_NAME, href: `/workspace/team/${WS}`, current: false },
      { label: "Projects", href: `/workspace/team/${WS}/projects`, current: false },
      { label: PNAME, href: `/workspace/team/${WS}/projects/${PID}`, current: false },
      { label: "New research", href: undefined, current: true },
    ]);
  });

  it("AD2 — mobileParent is the Project, the genuine immediate parent", async () => {
    expect(bcMobileParent(await mountComposer())).toEqual({ label: PNAME, href: `/workspace/team/${WS}/projects/${PID}` });
  });

  it("AD3 — before submit the h1 reads 'Start research', and the redundant Project eyebrow is gone", async () => {
    const r = await mountComposer();
    expect(h1Texts(r)).toEqual(["Start research"]);
    // the old <p className="text-xs ... uppercase">{project.name}</p> above the heading
    expect(r.root.findAllByType("p").filter((n) => visibleTextOf(n) === PNAME)).toHaveLength(0);
    // ...but the Project is still identified, by the breadcrumb
    expect(bcSegments(r).map((x) => x.label)).toContain(PNAME);
  });

  it("AD4 — LOAD-BEARING: after a successful run the breadcrumb terminal is STILL 'New research' while the h1 becomes the submitted question", async () => {
    const submit = jest.fn().mockResolvedValue({ status: "ok", run: { runId: "run_789", results: [], governanceStatus: null } });
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const r = await mountComposer();
    const textarea = r.root.findByType("textarea");
    await act(async () => { textarea.props.onChange({ target: { value: QUESTION } }); });
    await act(async () => { await r.root.findByType("form").props.onSubmit({ preventDefault() {} }); });

    // heading follows inline content state...
    expect(h1Texts(r)).toEqual([QUESTION]);
    // ...breadcrumb follows DURABLE ROUTE hierarchy: the URL is still /research/new
    const segs = bcSegments(r);
    expect(segs[segs.length - 1]).toEqual({ label: "New research", href: undefined, current: true });
    expect(segs.map((x) => x.label)).not.toContain(QUESTION);
  });

  it("AD5 — both Back to Project controls are RETAINED as actions (only research detail's isolated link is absorbed)", async () => {
    const before = await mountComposer();
    expect(before.root.findAllByType("a").filter((el) => el.props.children === "Back to Project")).toHaveLength(1);

    const submit = jest.fn().mockResolvedValue({ status: "ok", run: { runId: "run_789", results: [], governanceStatus: null } });
    mockedUseTeamProjectResearch.mockReturnValue(researchResult({ submit }));
    const after = await mountComposer();
    await act(async () => { after.root.findByType("textarea").props.onChange({ target: { value: QUESTION } }); });
    await act(async () => { await after.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    // Guard against vacuity: prove the POST-RESULT branch is really the one rendered
    // (otherwise this assertion would just be re-checking the form control again).
    expect(after.root.findAllByType("button").some((b) => b.props.children === "Start another research")).toBe(true);
    expect(after.root.findAllByType("form")).toHaveLength(0);
    expect(after.root.findAllByType("a").filter((el) => el.props.children === "Back to Project")).toHaveLength(1);
  });

  it("AD6 — NON-VACUITY: neither the workspaceId nor the projectId is ever a visible breadcrumb label", async () => {
    const labels = bcSegments(await mountComposer()).map((x) => x.label);
    expect(labels).toEqual([WS_NAME, "Projects", PNAME, "New research"]);
    expect(labels).not.toContain(WS);
    expect(labels).not.toContain(PID);
  });

  it("AD7 — ENCODING: reserved characters in both ids are percent-encoded in every parent href, including the mobile parent", async () => {
    const r = await mountComposer("ws/a b", "proj/x y");
    const segs = bcSegments(r);
    expect(segs[0].href).toBe("/workspace/team/ws%2Fa%20b");
    expect(segs[1].href).toBe("/workspace/team/ws%2Fa%20b/projects");
    expect(segs[2].href).toBe("/workspace/team/ws%2Fa%20b/projects/proj%2Fx%20y");
    expect(bcMobileParent(r)!.href).toBe("/workspace/team/ws%2Fa%20b/projects/proj%2Fx%20y");
  });
});
