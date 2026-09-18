/**
 * WORKSPACE-NAV-H1 — the narrow-viewport containment contract for
 * `WorkspaceNav`.
 *
 * Two things are proven here, and they need different harnesses:
 *
 * 1. CONTAINMENT is structural, so it is asserted on the rendered markup: the
 *    nav must own a horizontal overflow boundary, and items must not be
 *    allowed to shrink or wrap. These classes are load-bearing — they ARE the
 *    contract, not styling preference — which is why they are pinned.
 *
 * 2. ACTIVE-ITEM VISIBILITY is behavioural, so it runs the real effect against
 *    EXPLICIT element geometry supplied through `createNodeMock`. The repo's
 *    Jest environment is `node`, so every geometry value (`clientWidth`,
 *    `scrollLeft`, `offsetLeft`, `offsetWidth`) is stated outright rather than
 *    defaulting to 0 — a zero-geometry harness would make every one of these
 *    assertions pass no matter what the component did.
 *
 * The nav mock records EVERY property write, so "adjusts only `scrollLeft`"
 * is a positive assertion about what was touched, not an absence of evidence.
 */

// `next/link` pulls in Next's intersection-observer helper, which touches
// `self` — undefined in this repo's `node` Jest environment. The link's only
// role in these tests is to be a focusable host element with a class, so a
// plain anchor is an exact stand-in. The real `next/link` href contract stays
// covered by `WorkspaceNav.spec.tsx`.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & Record<string, unknown>) =>
    require("react").createElement("a", { href, ...rest }, children),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import WorkspaceNav, { type WorkspaceNavItem } from "@/components/workspace/WorkspaceNav";

// ─── structural containment ───────────────────────────────────────────────────

function markup(active: WorkspaceNavItem = "overview", showAudit = true) {
  return renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active, showAudit }));
}
const navClass = (html: string) => /<nav[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";

describe("the nav owns a horizontal overflow boundary", () => {
  it("scrolls internally instead of widening the document", () => {
    const cls = navClass(markup());
    expect(cls).toContain("overflow-x-auto");
    expect(cls).toContain("max-w-full");
  });

  it("is the offset parent of its items, so item offsets are nav-relative", () => {
    expect(navClass(markup())).toContain("relative");
  });

  it("never hides page overflow or clips the strip outright", () => {
    const cls = navClass(markup());
    expect(cls).not.toContain("overflow-hidden");
    expect(cls).not.toContain("overflow-x-hidden");
  });

  it("keeps the single-row layout it has always had", () => {
    const cls = navClass(markup());
    expect(cls).toContain("flex");
    expect(cls).not.toContain("flex-wrap");
    expect(cls).not.toContain("flex-col");
  });

  it.each(["overview", "audit"] as const)("containment holds regardless of the active item (%s)", (active) => {
    const cls = navClass(markup(active));
    expect(cls).toContain("overflow-x-auto");
    expect(cls).toContain("max-w-full");
  });
});

describe("items are never compressed to force a fit", () => {
  const itemClasses = (html: string) => [...html.matchAll(/<(?:a|span)[^>]*class="([^"]*)"/g)].map((m) => m[1]);

  it("every item refuses to shrink and refuses to wrap", () => {
    const classes = itemClasses(markup("claims", true));
    // Six since TEAM-VERIFICATION-PARITY-R5-I2 added Videos: the exact count
    // this containment was hardened for.
    expect(classes).toHaveLength(6);
    for (const c of classes) {
      expect(c).toContain("shrink-0");
      expect(c).toContain("whitespace-nowrap");
    }
  });

  it("the longest label is not truncated or abbreviated to compensate", () => {
    const html = markup("overview", true);
    expect(html).toContain(">Audit Log<");
    expect(navClass(html)).not.toContain("truncate");
    for (const c of itemClasses(html)) expect(c).not.toContain("truncate");
  });

  it("labels remain the exact product strings", () => {
    const html = markup("overview", true);
    for (const label of ["Overview", "Projects", "Claims", "Videos", "Members", "Audit Log"]) {
      expect(html).toContain(`>${label}<`);
    }
  });
});

describe("focus stays visible inside the overflow boundary", () => {
  it("links carry an INSET focus ring, which an overflow boundary cannot clip", () => {
    const linkClasses = [...markup("overview", true).matchAll(/<a[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(linkClasses.length).toBeGreaterThan(0);
    for (const c of linkClasses) {
      expect(c).toContain("focus-visible:ring-inset");
      expect(c).toContain("focus-visible:ring-2");
    }
  });

  it("does not leave links with no focus indicator at all", () => {
    for (const c of [...markup("overview", true).matchAll(/<a[^>]*class="([^"]*)"/g)].map((m) => m[1])) {
      const suppressesDefault = c.includes("focus-visible:outline-none") || c.includes("outline-none");
      const providesOwn = c.includes("focus-visible:ring-2");
      expect(!suppressesDefault || providesOwn).toBe(true);
    }
  });
});

// ─── active-item horizontal visibility ────────────────────────────────────────

type Geometry = { offsetLeft: number; offsetWidth: number };

/** A nav mock that records every property write made to it. */
function makeNavMock(initial: { scrollLeft: number; clientWidth: number }) {
  const writes: Array<{ prop: string; value: unknown }> = [];
  const state = { scrollLeft: initial.scrollLeft, scrollTop: 0 };
  const scrollIntoView = jest.fn();
  const scrollTo = jest.fn();
  const mock = {
    clientWidth: initial.clientWidth,
    scrollIntoView,
    scrollTo,
    get scrollLeft() {
      return state.scrollLeft;
    },
    set scrollLeft(v: number) {
      writes.push({ prop: "scrollLeft", value: v });
      state.scrollLeft = v;
    },
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(v: number) {
      writes.push({ prop: "scrollTop", value: v });
      state.scrollTop = v;
    },
  };
  return { mock, writes, scrollIntoView, scrollTo, read: () => state.scrollLeft };
}

/**
 * Renders the nav with stated geometry. `activeGeometry` is keyed by label so a
 * re-render with a different active item gets its own position.
 */
function renderWithGeometry(opts: {
  active: WorkspaceNavItem;
  showAudit?: boolean;
  nav: { scrollLeft: number; clientWidth: number };
  activeGeometry: Record<string, Geometry>;
}) {
  const nav = makeNavMock(opts.nav);
  const itemScrollIntoView = jest.fn();

  const createNodeMock = (element: { type: unknown; props: Record<string, unknown> }) => {
    if (element.type === "nav") return nav.mock;
    if (element.type === "span" && element.props["aria-current"] === "page") {
      const label = String(element.props.children);
      const g = opts.activeGeometry[label];
      if (!g) throw new Error(`test set no geometry for the active item "${label}"`);
      return { offsetLeft: g.offsetLeft, offsetWidth: g.offsetWidth, scrollIntoView: itemScrollIntoView };
    }
    return null;
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      createElement(WorkspaceNav, { workspaceId: "ws-1", active: opts.active, showAudit: opts.showAudit ?? true }),
      { createNodeMock }
    );
  });

  const rerender = (active: WorkspaceNavItem) => {
    act(() => {
      renderer.update(createElement(WorkspaceNav, { workspaceId: "ws-1", active, showAudit: opts.showAudit ?? true }));
    });
  };

  return { nav, itemScrollIntoView, rerender };
}

// Visible window is 0..320 unless a test states otherwise.
const NAV = { scrollLeft: 0, clientWidth: 320 };

describe("the active item is brought into the visible horizontal range", () => {
  it("already visible at the start (Overview, unscrolled) -> scrollLeft untouched", () => {
    const { nav } = renderWithGeometry({
      active: "overview",
      nav: NAV,
      activeGeometry: { Overview: { offsetLeft: 0, offsetWidth: 70 } },
    });
    expect(nav.read()).toBe(0);
    expect(nav.writes).toEqual([]);
  });

  it("fully visible in the middle of the range -> no scroll at all", () => {
    const { nav } = renderWithGeometry({
      active: "claims",
      nav: NAV,
      activeGeometry: { Claims: { offsetLeft: 150, offsetWidth: 60 } },
    });
    expect(nav.read()).toBe(0);
    expect(nav.writes).toEqual([]);
  });

  it("starts LEFT of the visible range -> corrected leftward to the item's left edge", () => {
    // Visible window 200..520; the item sits at 0..70, entirely before it.
    const { nav } = renderWithGeometry({
      active: "overview",
      nav: { scrollLeft: 200, clientWidth: 320 },
      activeGeometry: { Overview: { offsetLeft: 0, offsetWidth: 70 } },
    });
    expect(nav.read()).toBe(0);
    expect(nav.writes).toEqual([{ prop: "scrollLeft", value: 0 }]);
  });

  it("ends RIGHT of the visible range -> corrected rightward so its right edge is flush", () => {
    // Visible window 0..320; the item sits at 400..480, entirely after it.
    const { nav } = renderWithGeometry({
      active: "audit",
      nav: NAV,
      activeGeometry: { "Audit Log": { offsetLeft: 400, offsetWidth: 80 } },
    });
    // 480 (item right) - 320 (clientWidth) = 160
    expect(nav.read()).toBe(160);
    expect(nav.writes).toEqual([{ prop: "scrollLeft", value: 160 }]);
  });

  it("partially cut off on the right -> scrolled just far enough, not to the end", () => {
    // Visible 0..320; item 280..360 straddles the right edge.
    const { nav } = renderWithGeometry({
      active: "members",
      nav: NAV,
      activeGeometry: { Members: { offsetLeft: 280, offsetWidth: 80 } },
    });
    expect(nav.read()).toBe(40);
  });

  it("partially cut off on the left -> aligned to the item's left edge", () => {
    // Visible 100..420; item 60..140 straddles the left edge.
    const { nav } = renderWithGeometry({
      active: "projects",
      nav: { scrollLeft: 100, clientWidth: 320 },
      activeGeometry: { Projects: { offsetLeft: 60, offsetWidth: 80 } },
    });
    expect(nav.read()).toBe(60);
  });

  it("recomputes when the active item changes", () => {
    const { nav, rerender } = renderWithGeometry({
      active: "overview",
      nav: NAV,
      activeGeometry: {
        Overview: { offsetLeft: 0, offsetWidth: 70 },
        "Audit Log": { offsetLeft: 400, offsetWidth: 80 },
      },
    });
    expect(nav.read()).toBe(0);
    expect(nav.writes).toEqual([]);

    rerender("audit");
    expect(nav.read()).toBe(160);
    expect(nav.writes).toEqual([{ prop: "scrollLeft", value: 160 }]);
  });

  it("a wide nav that fits everything never scrolls, whichever item is active", () => {
    for (const [active, label] of [
      ["overview", "Overview"],
      ["claims", "Claims"],
      ["audit", "Audit Log"],
    ] as const) {
      const { nav } = renderWithGeometry({
        active,
        nav: { scrollLeft: 0, clientWidth: 1280 },
        activeGeometry: { [label]: { offsetLeft: 400, offsetWidth: 80 } },
      });
      expect(nav.writes).toEqual([]);
    }
  });
});

describe("the correction is horizontal-only and nav-local", () => {
  it("writes scrollLeft and nothing else — never scrollTop", () => {
    const { nav } = renderWithGeometry({
      active: "audit",
      nav: NAV,
      activeGeometry: { "Audit Log": { offsetLeft: 400, offsetWidth: 80 } },
    });
    expect(nav.writes.map((w) => w.prop)).toEqual(["scrollLeft"]);
    expect(nav.writes.some((w) => w.prop === "scrollTop")).toBe(false);
  });

  it("never calls scrollIntoView on the nav or the active item (it can move the page vertically)", () => {
    const { nav, itemScrollIntoView } = renderWithGeometry({
      active: "audit",
      nav: NAV,
      activeGeometry: { "Audit Log": { offsetLeft: 400, offsetWidth: 80 } },
    });
    expect(nav.scrollIntoView).not.toHaveBeenCalled();
    expect(itemScrollIntoView).not.toHaveBeenCalled();
  });

  it("never calls scrollTo on the nav", () => {
    const { nav } = renderWithGeometry({
      active: "audit",
      nav: NAV,
      activeGeometry: { "Audit Log": { offsetLeft: 400, offsetWidth: 80 } },
    });
    expect(nav.scrollTo).not.toHaveBeenCalled();
  });

  it("source never reaches for window/document scroll or viewport width", () => {
    const src = require("fs").readFileSync(require("path").join(process.cwd(), "components/workspace/WorkspaceNav.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["window.scroll", "document.documentElement", "document.body", "innerWidth", "matchMedia", "scrollIntoView", "getBoundingClientRect"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("is a no-op when geometry is unavailable rather than throwing", () => {
    // No node mocks at all: both refs stay null, exactly like SSR/hydration.
    expect(() => {
      act(() => {
        TestRenderer.create(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "audit", showAudit: true }), { createNodeMock: () => null });
      });
    }).not.toThrow();
  });
});

describe("the harness itself is not vacuous", () => {
  it("geometry is explicitly stated, so a zero-geometry default cannot mask a broken correction", () => {
    const { nav } = renderWithGeometry({
      active: "audit",
      nav: NAV,
      activeGeometry: { "Audit Log": { offsetLeft: 400, offsetWidth: 80 } },
    });
    // If the mock returned 0s (the JSDOM/node default), the item would appear
    // fully visible and scrollLeft would never be written. It was.
    expect(nav.writes).not.toEqual([]);
    expect(nav.read()).toBeGreaterThan(0);
  });

  it("the active-item mock is actually wired: omitting its geometry is an error, not a silent pass", () => {
    expect(() =>
      renderWithGeometry({ active: "audit", nav: NAV, activeGeometry: { Overview: { offsetLeft: 0, offsetWidth: 70 } } })
    ).toThrow(/no geometry for the active item "Audit Log"/);
  });
});
