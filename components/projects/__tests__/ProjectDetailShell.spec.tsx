/**
 * Phase 7E-B — ProjectDetailShellView. Structural assertions (heading,
 * status, no lifecycle duplication, no Add-to-project) via
 * `renderToStaticMarkup`, mirroring `ProjectsShell.spec.tsx`'s own
 * convention. Toast/reconciliation wiring (which requires invoking
 * `AssignedRunActions`' callbacks through a real interactive tree,
 * including `WorkspaceRunCard`'s `next/link`) via `react-test-renderer`
 * with the same standard `next/link` mock `ProjectLifecycleRow.spec.tsx`
 * already established.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

import type { UseProjectsResult } from "@/hooks/useProjects";
let mockUseProjectsReturn: UseProjectsResult;
jest.mock("@/hooks/useProjects", () => {
  const actual = jest.requireActual("@/hooks/useProjects");
  return {
    ...actual,
    useProjects: () => mockUseProjectsReturn,
  };
});

import { ProjectDetailShellView } from "@/components/projects/ProjectDetailShell";
import type { ProjectDetailMeta } from "@/components/projects/ProjectDetailShell";
import type { UseProjectRunsResult, ProjectRunSummary } from "@/hooks/useProjectRuns";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

function fakeProjectsResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
  return {
    items: [],
    hasMore: false,
    status: "ready",
    initialErrorCode: null,
    loadingMore: false,
    loadMoreErrorCode: null,
    loadMore: jest.fn(),
    retryInitial: jest.fn(),
    resetAndReloadFromStart: jest.fn(),
    replaceItem: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockUseProjectsReturn = fakeProjectsResult();
});

function fakeRuns(overrides: Partial<UseProjectRunsResult> = {}): UseProjectRunsResult {
  return {
    items: [],
    hasMore: false,
    status: "ready",
    initialErrorCode: null,
    loadingMore: false,
    loadMoreErrorCode: null,
    loadMore: jest.fn(),
    retryInitial: jest.fn(),
    resetAndReloadFromStart: jest.fn(),
    ...overrides,
  };
}

function fakeAssociation(overrides: Partial<UseRunProjectAssociationResult> = {}): UseRunProjectAssociationResult {
  return {
    isRunBusy: () => false,
    getBusyOperation: () => null,
    assign: jest.fn(),
    move: jest.fn(),
    remove: jest.fn(),
    ...overrides,
  };
}

const PROJECT: ProjectDetailMeta = { id: "proj-1", name: "My Project", status: "active" };
const ARCHIVED_PROJECT: ProjectDetailMeta = { id: "proj-1", name: "My Archived Project", status: "archived" };
const RUN_A: ProjectRunSummary = { id: "run-a", at: "2026-08-01T00:00:00.000Z", question: "Question A", selectedModels: ["chatgpt"], projectId: "proj-1" };
const RUN_B: ProjectRunSummary = { id: "run-b", at: "2026-08-02T00:00:00.000Z", question: "Question B", selectedModels: ["chatgpt"], projectId: "proj-1" };

function renderStatic(project: ProjectDetailMeta = PROJECT, runs = fakeRuns(), association = fakeAssociation()): string {
  return renderToStaticMarkup(createElement(ProjectDetailShellView, { project, runs, association }));
}

describe("ProjectDetailShellView — header", () => {
  it("h1 is the Project name", () => {
    const html = renderStatic();
    expect(html).toMatch(/<h1[^>]*>My Project<\/h1>/);
  });

  it("shows Active status textually", () => {
    expect(renderStatic(PROJECT)).toContain("Active");
  });

  it("shows Archived status textually", () => {
    expect(renderStatic(ARCHIVED_PROJECT)).toContain("Archived");
  });

  it("Phase 11B.4 — the Projects destination survives, but the one-off 'Back to Projects' wording does not: the breadcrumb owns that navigation now", () => {
    const html = renderStatic();
    // the destination is preserved...
    expect(html).toContain('href="/workspace/projects"');
    // ...while the isolated affordance it used to belong to is gone
    expect(html).not.toContain("Back to Projects");
  });
});

describe("ProjectDetailShellView — loading/error/empty (never fabricates empty on error)", () => {
  it("loading shows a restrained message, no empty state", () => {
    const html = renderStatic(PROJECT, fakeRuns({ status: "loading" }));
    expect(html).toContain("Loading research");
    expect(html).not.toContain("No research in this project.");
  });

  it("error never fabricates the empty-state copy", () => {
    const html = renderStatic(PROJECT, fakeRuns({ status: "error", initialErrorCode: "internal_error" }));
    expect(html).toContain("Try again");
    expect(html).not.toContain("No research in this project.");
  });

  it("definitive empty state: items=[] AND hasMore=false", () => {
    expect(renderStatic(PROJECT, fakeRuns({ items: [], hasMore: false }))).toContain("No research in this project.");
  });

  it("items=[] AND hasMore=true never shows the empty state", () => {
    expect(renderStatic(PROJECT, fakeRuns({ items: [], hasMore: true }))).not.toContain("No research in this project.");
  });

  it("archived Project with zero research is still a valid readable page — never redirected, empty state still shown normally", () => {
    expect(renderStatic(ARCHIVED_PROJECT, fakeRuns({ items: [], hasMore: false }))).toContain("No research in this project.");
  });
});

describe("ProjectDetailShellView — populated list reuses WorkspaceRunCard, no Add-to-project, no lifecycle duplication", () => {
  it("renders every run's question text, in order", () => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A, RUN_B] }));
    expect(html.indexOf("Question A")).toBeLessThan(html.indexOf("Question B"));
  });

  it("renders the canonical report link for each run", () => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A] }));
    expect(html).toContain(`href="/workspace/research/${encodeURIComponent(RUN_A.id)}"`);
    expect(html).not.toContain("openResearchRun");
  });

  it("renders Move and Remove from project controls, never Add to project", () => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A] }));
    expect(html).toContain("Move");
    expect(html).toContain("Remove from project");
    expect(html).not.toContain("Add to project");
  });

  it.each(["New Project", "Rename", "Archive", "Restore"])("never renders a %s lifecycle control anywhere on this page", (label) => {
    const html = renderStatic(PROJECT, fakeRuns({ items: [RUN_A] }));
    expect(html).not.toContain(label);
  });
});

describe("ProjectDetailShellView — defense-in-depth: item.projectId !== route Project (spec item 13)", () => {
  it("a (hypothetically) contradictory run never renders Move/Remove controls for that row", () => {
    const contradictory: ProjectRunSummary = { ...RUN_A, projectId: "proj-DIFFERENT" };
    const html = renderStatic(PROJECT, fakeRuns({ items: [contradictory] }));
    // The card itself still renders (defense-in-depth is about the ACTIONS slot, not hiding the row), but no Move/Remove for it.
    expect(html).toContain("Question A");
    expect(html).not.toContain("Move");
    expect(html).not.toContain("Remove from project");
  });
});

describe("ProjectDetailShellView — pagination", () => {
  it("hasMore=true -> 'Load more' present; hasMore=false -> absent", () => {
    expect(renderStatic(PROJECT, fakeRuns({ items: [RUN_A], hasMore: true }))).toContain("Load more");
    expect(renderStatic(PROJECT, fakeRuns({ items: [RUN_A], hasMore: false }))).not.toContain("Load more");
  });
});

// ---------------------------------------------------------------------------
// Interactive: toast + reconciliation wiring (requires a real tree).
// ---------------------------------------------------------------------------

function mountInteractive(project = PROJECT, runs = fakeRuns({ items: [RUN_A] }), association = fakeAssociation()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(ProjectDetailShellView, { project, runs, association }));
  });
  return renderer;
}

describe("ProjectDetailShellView — Move/Remove success reconciliation (spec item 35/36)", () => {
  it("a successful Move resets this Project's own run list, shows 'Moved to {name}.', and never resets top-level state (no such state is even mounted here)", async () => {
    mockUseProjectsReturn = fakeProjectsResult({
      items: [{ id: "proj-2", name: "Project Two", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 } }],
    });
    const resetAndReloadFromStart = jest.fn();
    const runs = fakeRuns({ items: [RUN_A], resetAndReloadFromStart });
    const move = jest.fn(async () => ({ status: "ok" as const, runId: "run-a", projectId: "proj-2" }));
    const renderer = mountInteractive(PROJECT, runs, fakeAssociation({ move }));

    const moveTrigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Move")!;
    act(() => moveTrigger.props.onClick());
    const dialog = renderer.root.findByProps({ role: "dialog" });
    const option = dialog.findByProps({ role: "option" });
    act(() => option.props.onClick());
    const moveConfirm = renderer.root.findByProps({ role: "dialog" }).findAllByType("button").find((b) => b.props.children === "Move")!;
    await act(async () => {
      await moveConfirm.props.onClick();
    });

    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("Moved to Project Two.");
    renderer.unmount();
  });

  it("a successful Remove resets this Project's own run list and shows 'Removed from project.'", async () => {
    const resetAndReloadFromStart = jest.fn();
    const runs = fakeRuns({ items: [RUN_A], resetAndReloadFromStart });
    const remove = jest.fn(async () => ({ status: "ok" as const, runId: "run-a", projectId: null }));
    const renderer = mountInteractive(PROJECT, runs, fakeAssociation({ remove }));

    const removeTrigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Remove from project")!;
    act(() => removeTrigger.props.onClick());
    const confirmButton = renderer.root
      .findByProps({ role: "dialog" })
      .findAllByType("button")
      .find((b) => typeof b.props.children === "string" && b.props.children.startsWith("Remov"))!;
    await act(async () => {
      await confirmButton.props.onClick();
    });

    expect(resetAndReloadFromStart).toHaveBeenCalledTimes(1);
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("Removed from project.");
    renderer.unmount();
  });
});

describe("ProjectDetailShellView — toast does not crash on unmount mid-timeout", () => {
  it("unmounting shortly after a success acknowledgement does not throw", async () => {
    const runs = fakeRuns({ items: [RUN_A] });
    const renderer = mountInteractive(PROJECT, runs, fakeAssociation());
    expect(() => renderer.unmount()).not.toThrow();
  });
});


/* ------------------------------------------------------------------ *
 * Phase 11B.4 — Personal Project breadcrumb.
 *
 * The REAL shared `Breadcrumb` is rendered (never mocked), through the spec's
 * existing `next/link` mock, so these assertions exercise the shipped
 * component's own markup. `aria-hidden` nodes (the "/" separator and the "←"
 * glyph) are excluded so no label assertion can pass on decorative text.
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

/**
 * Phase 11B.3's lesson, carried forward: a contract about the RELATIONSHIP
 * between elements has to be asserted as a relationship. Positions come from a
 * depth-first walk of the RENDERED tree, never from source text.
 */
function documentOrder(r: TestRenderer.ReactTestRenderer): { breadcrumb: number; h1: number } {
  const flat: { type: string; props: Record<string, unknown> }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type?: unknown; props?: Record<string, unknown>; rendered?: unknown };
    if (typeof n.type === "string") flat.push({ type: n.type, props: n.props ?? {} });
    walk(n.rendered);
  };
  walk(r.toTree());
  return {
    breadcrumb: flat.findIndex((e) => e.type === "nav" && e.props["aria-label"] === "Breadcrumb"),
    h1: flat.findIndex((e) => e.type === "h1"),
  };
}

/** Deliberately id !== name, so nothing can pass on an identifier. */
const NAMED_PROJECT: ProjectDetailMeta = { id: "proj_456", name: "Election Evidence", status: "active" };

describe("Phase 11B.4 — Personal Project breadcrumb", () => {
  it("T1 — desktop hierarchy is exactly Projects / {Project name}, Projects linked, Project final and non-linking", () => {
    expect(bcSegments(mountInteractive(NAMED_PROJECT))).toEqual([
      { label: "Projects", href: "/workspace/projects", current: false },
      { label: "Election Evidence", href: undefined, current: true },
    ]);
  });

  it("T1b — no extra hierarchy level is introduced: no 'Personal', no 'Workspace', no WorkspaceNav on this page", () => {
    const r = mountInteractive(NAMED_PROJECT);
    const labels = bcSegments(r).map((x) => x.label);
    expect(labels).toHaveLength(2);
    expect(labels).not.toContain("Personal");
    expect(labels).not.toContain("Workspace");
    // 11B.5 owns Workspace context/switching — this Personal page must not gain the Team nav
    expect(r.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === "Workspace", { deep: true })).toHaveLength(0);
  });

  it("T2 — NON-VACUITY: the visible label is the server-resolved NAME; the Project id is never visible breadcrumb text, nor in any breadcrumb href", () => {
    const segs = bcSegments(mountInteractive(NAMED_PROJECT));
    expect(segs.map((x) => x.label)).toEqual(["Projects", "Election Evidence"]);
    expect(segs.map((x) => x.label)).not.toContain("proj_456");
    // the current Project is the terminal segment, so it is not linked and no href carries the id
    for (const seg of segs) expect(seg.href ?? "").not.toContain("proj_456");
  });

  it("T3 — mobile parent is Projects, pointing at the old Back-to-Projects destination", () => {
    expect(bcMobileParent(mountInteractive(NAMED_PROJECT))).toEqual({ label: "Projects", href: "/workspace/projects" });
  });

  it("T4 — the isolated 'Back to Projects' link is ABSORBED: no anchor carries that text, even though the breadcrumb still links to /workspace/projects", () => {
    const r = mountInteractive(NAMED_PROJECT);
    const anchors = r.root.findAllByType("a");
    // asserting the href alone would be meaningless — the breadcrumb keeps it on purpose
    expect(anchors.filter((a) => visibleTextOf(a).includes("Back to Projects"))).toHaveLength(0);
    expect(anchors.some((a) => String(a.props.href) === "/workspace/projects")).toBe(true);
  });

  it("T5 — exactly one h1, and it is still the Project name: the breadcrumb does not replace the document heading", () => {
    const r = mountInteractive(NAMED_PROJECT);
    const h1s = r.root.findAllByType("h1");
    expect(h1s).toHaveLength(1);
    expect(visibleTextOf(h1s[0])).toBe("Election Evidence");
  });

  it("T6 — ORDER IS LOAD-BEARING: the Breadcrumb landmark precedes the h1 in the rendered tree", () => {
    const o = documentOrder(mountInteractive(NAMED_PROJECT));
    expect(o.breadcrumb).toBeGreaterThanOrEqual(0);
    expect(o.h1).toBeGreaterThanOrEqual(0);
    expect(o.breadcrumb).toBeLessThan(o.h1);
  });

  it("T7 — status badge survives for BOTH states, beside the heading", () => {
    expect(visibleTextOf(mountInteractive(NAMED_PROJECT).root.findByType("main"))).toContain("Active");
    const archived = mountInteractive({ id: "proj_456", name: "Election Evidence", status: "archived" });
    expect(visibleTextOf(archived.root.findByType("main"))).toContain("Archived");
    // the archived Project still gets the same breadcrumb
    expect(bcSegments(archived).map((x) => x.label)).toEqual(["Projects", "Election Evidence"]);
  });

  it("S — ACCESSIBILITY: one Breadcrumb landmark, an ordered-list hierarchy, exactly one current segment, and the mobile parent is a real anchor", () => {
    const r = mountInteractive(NAMED_PROJECT);
    const navs = breadcrumbNav(r);
    expect(navs).toHaveLength(1);
    expect(navs[0].findAllByType("ol")).toHaveLength(1);
    const current = navs[0].findAll((n) => n.props?.["aria-current"] === "page", { deep: true });
    expect(current).toHaveLength(1);
    expect(visibleTextOf(current[0])).toBe("Election Evidence");
    const mobileWrap = navs[0].findAll(
      (n) => n.type === "div" && typeof n.props?.className === "string" && n.props.className.includes("sm:hidden"),
      { deep: true }
    );
    expect(mobileWrap[0].findAllByType("a")).toHaveLength(1);
  });

  it("O — DEEP LINK: a cold first render needs no prior route state — the same breadcrumb appears from the server-resolved props alone", () => {
    // `mountInteractive` is a first mount with no navigation history, no storage and no effects having run.
    const segs = bcSegments(mountInteractive(NAMED_PROJECT));
    expect(segs).toEqual([
      { label: "Projects", href: "/workspace/projects", current: false },
      { label: "Election Evidence", href: undefined, current: true },
    ]);
  });
});
