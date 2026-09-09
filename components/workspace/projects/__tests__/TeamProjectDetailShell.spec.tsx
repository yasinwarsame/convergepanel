/**
 * Team Projects UI, Phase 12A.2 — `TeamProjectDetailShell` interactive
 * behavior. `react-test-renderer` + `act()`, `useTeamProjectRuns` mocked
 * directly; the real component tree/render logic is exercised
 * end-to-end.
 *
 * PHASE 12A.3 — "Start Research" is now real (see the dedicated
 * `canStartResearch: true/false` + archived-Project tests below), but the
 * frozen boundary itself remains enforced and proven: the link always
 * points at `/workspace/team/{workspaceId}/projects/{projectId}/research/new`,
 * NEVER at `app/page.tsx` (the Personal composer) or `/api/run-panel`.
 *
 * PHASE 12A.4 — each research row is now itself a real link into the new
 * Team-only research detail route
 * (`/workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`),
 * proven below by asserting the exact `href` produced per row — never
 * `app/page.tsx` or any Personal route.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

const mockedUseTeamProjectRuns = jest.fn();
jest.mock("@/hooks/useTeamProjectRuns", () => {
  const actual = jest.requireActual("@/hooks/useTeamProjectRuns");
  return { ...actual, useTeamProjectRuns: (...args: any[]) => mockedUseTeamProjectRuns(...args) };
});

import TeamProjectDetailShell from "@/components/workspace/projects/TeamProjectDetailShell";

function runsResult(overrides: Partial<any> = {}) {
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

async function mount(props: Partial<{ project: any; canStartResearch: boolean }> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TeamProjectDetailShell, {
        workspaceId: "ws-1",
        workspaceName: "Acme Team",
        canReadAudit: true,
        canStartResearch: true,
        project: { id: "proj-1", name: "ABC Acquisition", status: "active" },
        ...props,
      })
    );
  });
  return renderer;
}

function findStartResearchLink(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType("a").find((el) => el.props.children === "Start Research");
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("TeamProjectDetailShell", () => {
  it("renders the Workspace name, shared nav, Project name, and status", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult());
    const renderer = await mount();
    // Phase 11B.3 — the Project name is now the page's primary heading; the
    // Workspace name is carried by the breadcrumb instead of a second heading.
    expect(renderer.root.findByType("h1").props.children).toBe("ABC Acquisition");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("ABC Acquisition");
    expect(text).toContain("Active");
  });

  it("zero research + authorized -> honest empty state AND a real Start Research link, never into app/page.tsx", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("No research in this project yet");
    // No link anywhere points at the Personal composer.
    const links = renderer.root.findAllByType("a");
    for (const link of links) {
      expect(link.props.href).not.toMatch(/^\/(\?|$)/);
      expect(link.props.href).not.toBe("/api/run-panel");
    }
    const startLink = findStartResearchLink(renderer);
    expect(startLink).toBeDefined();
    expect(startLink!.props.href).toBe("/workspace/team/ws-1/projects/proj-1/research/new");
  });

  describe("PHASE 12A.3 — permanent Start Research capability", () => {
    it("canStartResearch: false -> no Start Research link anywhere, authorized-only note not implied", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
      const renderer = await mount({ canStartResearch: false });
      expect(findStartResearchLink(renderer)).toBeUndefined();
    });

    it("PERMANENT capability — Start Research remains visible even with EXISTING research (not only in the empty state)", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(
        runsResult({
          items: [
            { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "What is the market size?", selectedModels: ["chatgpt", "claude"], status: "complete", modelsOk: 2, modelsTotal: 2, projectId: "proj-1" },
          ],
        })
      );
      const renderer = await mount({ canStartResearch: true });
      expect(findStartResearchLink(renderer)).toBeDefined();
    });

    it("archived Project -> Start Research never rendered, even for an otherwise-authorized caller", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
      const renderer = await mount({ canStartResearch: true, project: { id: "proj-1", name: "Old Project", status: "archived" } });
      expect(findStartResearchLink(renderer)).toBeUndefined();
    });

    it("MUTATION CHECK: asserting a DEFINED link (not merely absent from a loose text search) proves the control is genuinely present, matching the same non-vacuity discipline as the permanent Invite Member / New Project regression tests", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(runsResult({ items: [], hasMore: false }));
      const renderer = await mount({ canStartResearch: true });
      const link = findStartResearchLink(renderer);
      expect(link).toBeDefined();
      expect(typeof link).not.toBe("undefined");
    });
  });

  it("renders each research item with no interactive action controls (no Move/Remove/Assign) — read-only aside from navigation into the row itself", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(
      runsResult({
        items: [
          { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "What is the market size?", selectedModels: ["chatgpt", "claude"], status: "complete", modelsOk: 2, modelsTotal: 2, projectId: "proj-1" },
        ],
      })
    );
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("What is the market size?");
    expect(text).toContain("2/2 model responses");
    // No <button> at all inside a research row — no Move/Remove/Assign
    // action controls. The row's own <a> (asserted below) is navigation
    // into the read-only detail page, not a mutation control.
    expect(renderer.root.findAllByType("button").length).toBe(0);
  });

  describe("PHASE 12A.4 — research rows are real links into the Team research detail route", () => {
    // Deliberately excludes the "Start Research" link (href ends
    // "/research/new") — only matches the per-row detail links.
    function findRowLinks(renderer: TestRenderer.ReactTestRenderer) {
      return renderer.root
        .findAllByType("a")
        .filter((el) => typeof el.props.href === "string" && /\/research\/[^/]+$/.test(el.props.href) && !el.props.href.endsWith("/research/new"));
    }

    it("single row -> href is exactly /workspace/team/{workspaceId}/projects/{projectId}/research/{runId}, never app/page.tsx or /api/run-panel", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(
        runsResult({
          items: [
            { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "What is the market size?", selectedModels: ["chatgpt", "claude"], status: "complete", modelsOk: 2, modelsTotal: 2, projectId: "proj-1" },
          ],
        })
      );
      const renderer = await mount({ project: { id: "proj-1", name: "ABC Acquisition", status: "active" } });
      const links = findRowLinks(renderer);
      expect(links.length).toBe(1);
      expect(links[0].props.href).toBe("/workspace/team/ws-1/projects/proj-1/research/run-1");
      expect(links[0].props.href).not.toMatch(/^\/(\?|$)/);
      expect(links[0].props.href).not.toBe("/api/run-panel");
    });

    it("multiple rows -> each links to its own distinct runId, in item order", async () => {
      mockedUseTeamProjectRuns.mockReturnValue(
        runsResult({
          items: [
            { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: "First question", selectedModels: ["chatgpt"], status: "complete", modelsOk: 1, modelsTotal: 1, projectId: "proj-1" },
            { id: "run-2", at: "2026-01-02T00:00:00.000Z", question: "Second question", selectedModels: ["claude"], status: "complete", modelsOk: 1, modelsTotal: 1, projectId: "proj-1" },
          ],
        })
      );
      const renderer = await mount({ project: { id: "proj-1", name: "ABC Acquisition", status: "active" } });
      const hrefs = findRowLinks(renderer).map((l) => l.props.href);
      expect(hrefs).toEqual(["/workspace/team/ws-1/projects/proj-1/research/run-1", "/workspace/team/ws-1/projects/proj-1/research/run-2"]);
    });
  });

  it("passes workspaceId and projectId through to the runs hook exactly", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult());
    await mount({ project: { id: "proj-xyz", name: "X", status: "active" } });
    expect(mockedUseTeamProjectRuns).toHaveBeenCalledWith({ workspaceId: "ws-1", projectId: "proj-xyz" });
  });

  it("loading state shows a loading indicator, not the empty state", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult({ status: "loading", items: [] }));
    const renderer = await mount();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("No research in this project");
    expect(text).toContain("Loading research");
  });

  it("archived Project status renders 'Archived', not 'Active'", async () => {
    mockedUseTeamProjectRuns.mockReturnValue(runsResult());
    const renderer = await mount({ project: { id: "proj-1", name: "Old Project", status: "archived" } });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Archived");
    expect(text).not.toContain(">Active<");
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

describe("Phase 11B.3 — Project detail breadcrumb", () => {
  const WS = "ws_123";
  const WS_NAME = "Acme Risk Lab";
  const PID = "proj_456";
  const PNAME = "Election Evidence";

  async function mountDetail(workspaceId = WS, projectId = PID) {
    return mount({ project: { id: projectId, name: PNAME, status: "active" }, workspaceId, workspaceName: WS_NAME } as never);
  }

  it("AC1 — desktop hierarchy is {Workspace} / Projects / {Project}, with the Project final and non-linking", async () => {
    expect(bcSegments(await mountDetail())).toEqual([
      { label: WS_NAME, href: `/workspace/team/${WS}`, current: false },
      { label: "Projects", href: `/workspace/team/${WS}/projects`, current: false },
      { label: PNAME, href: undefined, current: true },
    ]);
  });

  it("AC2 — mobileParent is the Projects list, the genuine immediate parent", async () => {
    expect(bcMobileParent(await mountDetail())).toEqual({ label: "Projects", href: `/workspace/team/${WS}/projects` });
  });

  it("AC3 — the Project name is the page's single h1", async () => {
    expect(h1Texts(await mountDetail())).toEqual([PNAME]);
  });

  it("AC4 — NON-VACUITY: labels are the NAMES; neither the workspaceId nor the projectId is ever visible breadcrumb text", async () => {
    const segs = bcSegments(await mountDetail());
    const labels = segs.map((x) => x.label);
    expect(labels).toEqual([WS_NAME, "Projects", PNAME]);
    expect(labels).not.toContain(WS);
    expect(labels).not.toContain(PID);
  });

  it("AC5 — status badge and Start Research action survive the heading promotion", async () => {
    const r = await mountDetail();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Active");
    expect(r.root.findAllByType("a").some((el) => el.props.children === "Start Research")).toBe(true);
  });

  it("AC6 — ENCODING: reserved characters in BOTH ids are percent-encoded across every parent href", async () => {
    const segs = bcSegments(await mountDetail("ws/a b", "proj/x y"));
    expect(segs[0].href).toBe("/workspace/team/ws%2Fa%20b");
    expect(segs[1].href).toBe("/workspace/team/ws%2Fa%20b/projects");
  });

  it("AC7 — exactly one aria-current in the breadcrumb, and WorkspaceNav independently keeps Projects current", async () => {
    const r = await mountDetail();
    expect(bcSegments(r).filter((x) => x.current)).toHaveLength(1);
    const nav = r.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === "Workspace", { deep: true })[0];
    expect(nav.findAll((n) => n.props?.["aria-current"] === "page", { deep: true }).map(visibleTextOf)).toEqual(["Projects"]);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 11B.3-C1 — RELATIVE DOM ORDER.
 *
 * The 11B.3 tests proved the breadcrumb's contents, the h1's contents and
 * WorkspaceNav's state each independently — and every one of them passed while
 * four surfaces still rendered WorkspaceNav ABOVE the heading, in violation of
 * the frozen composition contract. This helper closes that gap by pinning the
 * one property none of them expressed: document order.
 *
 * Positions come from a depth-first walk of the RENDERED tree (`toTree()`), not
 * from source text, so it measures what a viewer actually gets.
 * ------------------------------------------------------------------ */
function documentOrder(r: TestRenderer.ReactTestRenderer): { breadcrumb: number; h1: number; workspaceNav: number } {
  const flat: { type: string; props: Record<string, unknown> }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type?: unknown; props?: Record<string, unknown>; rendered?: unknown };
    if (typeof n.type === "string") flat.push({ type: n.type, props: n.props ?? {} });
    walk(n.rendered);
  };
  walk(r.toTree());

  const at = (pred: (e: { type: string; props: Record<string, unknown> }) => boolean) => flat.findIndex(pred);
  return {
    breadcrumb: at((e) => e.type === "nav" && e.props["aria-label"] === "Breadcrumb"),
    h1: at((e) => e.type === "h1"),
    workspaceNav: at((e) => e.type === "nav" && e.props["aria-label"] === "Workspace"),
  };
}

/** Breadcrumb -> page heading -> WorkspaceNav, with all three actually present. */
function expectFrozenComposition(r: TestRenderer.ReactTestRenderer) {
  const o = documentOrder(r);
  expect(o.breadcrumb).toBeGreaterThanOrEqual(0);
  expect(o.h1).toBeGreaterThanOrEqual(0);
  expect(o.workspaceNav).toBeGreaterThanOrEqual(0);
  expect(o.breadcrumb).toBeLessThan(o.h1);
  expect(o.h1).toBeLessThan(o.workspaceNav);
}

describe("Phase 11B.3-C1 — Project detail page composition order", () => {
  it("C1-D1 — Breadcrumb -> h1 Project name -> WorkspaceNav -> research content", async () => {
    const r = await mount({ project: { id: "proj_456", name: "Election Evidence", status: "active" } } as never);
    expectFrozenComposition(r);
  });

  it("C1-D2 — the status badge and Start Research moved WITH the heading row, staying above WorkspaceNav", async () => {
    const r = await mount({ project: { id: "proj_456", name: "Election Evidence", status: "active" } } as never);
    const o = documentOrder(r);
    const flat: { type: string; props: Record<string, unknown> }[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const n = node as { type?: unknown; props?: Record<string, unknown>; rendered?: unknown };
      if (typeof n.type === "string") flat.push({ type: n.type, props: n.props ?? {} });
      walk(n.rendered);
    };
    walk(r.toTree());
    const badge = flat.findIndex((e) => e.type === "span" && e.props.children === "Active");
    const startResearch = flat.findIndex((e) => e.type === "a" && e.props.children === "Start Research");
    for (const i of [badge, startResearch]) {
      expect(i).toBeGreaterThan(o.h1);
      expect(i).toBeLessThan(o.workspaceNav);
    }
  });
});
