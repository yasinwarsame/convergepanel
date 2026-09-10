/**
 * Phase 11B.5 — `WorkspaceSwitcher` behavior against a REAL rendered tree
 * (`react-test-renderer`, this repo's convention; no jsdom/Testing Library is
 * added for this phase). Source-regex is deliberately not the evidence here.
 *
 * Focus is observed through `createNodeMock`, which hands every button a stub
 * carrying a `focus` spy — so focus-return and arrow-key movement are asserted
 * on actual calls rather than inferred.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockedPush }) }));

import WorkspaceSwitcher, { resolveWorkspaceNavContext, teamWorkspaceHref } from "@/components/WorkspaceSwitcher";
import type { WorkspaceListStatus } from "@/hooks/useWorkspaceList";

/** Names differ from ids everywhere, so nothing can pass on an identifier. */
const WS_A = { workspaceId: "ws_7x2", name: "Acme Risk Lab" };
const WS_B = { workspaceId: "ws_9z4", name: "Election Evidence Team" };
const ITEMS = [WS_A, WS_B];

type FocusStub = { focus: jest.Mock; nodeName: string };
const focusStubs: FocusStub[] = [];

function mount(
  opts: {
    pathname?: string | null;
    items?: { workspaceId: string; name: string }[];
    status?: WorkspaceListStatus;
    personalHref?: string;
    open?: boolean;
  } = {}
) {
  const onOpenChange = jest.fn();
  const onRetry = jest.fn();
  const triggerRef = { current: null as HTMLButtonElement | null };
  let renderer!: TestRenderer.ReactTestRenderer;
  const element = () =>
    createElement(WorkspaceSwitcher, {
      pathname: opts.pathname ?? "/workspace",
      items: opts.items ?? ITEMS,
      status: opts.status ?? "ready",
      personalHref: opts.personalHref ?? "/workspace",
      open: opts.open ?? false,
      onOpenChange,
      onRetry,
      triggerRef: triggerRef as React.RefObject<HTMLButtonElement>,
    });
  act(() => {
    renderer = TestRenderer.create(element(), {
      createNodeMock: (el) => {
        if (el.type === "button") {
          const stub: FocusStub = { focus: jest.fn(), nodeName: "BUTTON" };
          focusStubs.push(stub);
          return stub;
        }
        return null;
      },
    });
  });
  return { renderer, onOpenChange, onRetry, triggerRef, rerenderOpen: (open: boolean) =>
    act(() => { renderer.update(createElement(WorkspaceSwitcher, {
      pathname: opts.pathname ?? "/workspace",
      items: opts.items ?? ITEMS,
      status: opts.status ?? "ready",
      personalHref: opts.personalHref ?? "/workspace",
      open,
      onOpenChange,
      onRetry,
      triggerRef: triggerRef as React.RefObject<HTMLButtonElement>,
    })); }) };
}

const trigger = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "button" && n.props["aria-haspopup"] === "menu")[0];
const menu = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props?.role === "menu");
const menuItems = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props?.role === "menuitem");
const visibleTextOf = (node: TestRenderer.ReactTestInstance): string => {
  const out: string[] = [];
  const walk = (n: TestRenderer.ReactTestInstance) => {
    n.children.forEach((c) => {
      if (typeof c === "string") out.push(c);
      else if (c.props?.["aria-hidden"] !== "true") walk(c);
    });
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
};

beforeEach(() => {
  jest.clearAllMocks();
  focusStubs.length = 0;
});

// ───────────────────────── route classification (pure) ─────────────────────────

describe("resolveWorkspaceNavContext", () => {
  it("Personal routes", () => {
    for (const p of ["/", "/workspace", "/workspace/projects", "/workspace/projects/proj_1", "/workspace/team", "/workspace/team/", "/reviews", "/reviews/run_1"]) {
      expect(resolveWorkspaceNavContext(p, ITEMS)).toEqual({ kind: "personal", label: "Personal" });
    }
  });

  it("a path-addressed Team route validated against the membership list", () => {
    expect(resolveWorkspaceNavContext("/workspace/team/ws_9z4", ITEMS)).toEqual({ kind: "team", workspaceId: "ws_9z4", name: "Election Evidence Team" });
    expect(resolveWorkspaceNavContext("/workspace/team/ws_9z4/projects", ITEMS)).toEqual({ kind: "team", workspaceId: "ws_9z4", name: "Election Evidence Team" });
  });

  it("neutral surfaces get NO context — /workspace/reviews is Team-scoped but not path-addressable, so it is never labelled Personal", () => {
    for (const p of ["/workspace/reviews", "/workspace/reviews/run_1", "/team/reviews", "/team/reviews/run_1", "/governance", "/pricing", "/profile", "/admin", "/about", "/help", "/contact"]) {
      expect(resolveWorkspaceNavContext(p, ITEMS)).toBeNull();
    }
  });

  it("ORDER: /workspace/reviews is excluded BEFORE the generic /workspace/ Personal rule could swallow it", () => {
    expect(resolveWorkspaceNavContext("/workspace/reviews", ITEMS)).toBeNull();
    expect(resolveWorkspaceNavContext("/workspace/reviewsomething", ITEMS)).toEqual({ kind: "personal", label: "Personal" });
  });

  it("an unknown Team id yields NULL — it never falls through to Personal and never echoes the segment", () => {
    expect(resolveWorkspaceNavContext("/workspace/team/not-real/projects", ITEMS)).toBeNull();
    expect(resolveWorkspaceNavContext("/workspace/team/ws_foreign", ITEMS)).toBeNull();
  });

  it("decodes the Workspace segment before matching, and refuses malformed encoding", () => {
    const reserved = [{ workspaceId: "ws/a b", name: "Reserved Chars Team" }];
    expect(resolveWorkspaceNavContext("/workspace/team/ws%2Fa%20b", reserved)).toEqual({ kind: "team", workspaceId: "ws/a b", name: "Reserved Chars Team" });
    expect(resolveWorkspaceNavContext("/workspace/team/%E0%A4%A", ITEMS)).toBeNull();
  });

  it("T26 (PERSONAL-RESEARCH-URL-1) — the canonical Personal research route classifies as PERSONAL through the existing generic /workspace/ rule, with no special case", () => {
    // This is the reason URL-1 chose `/workspace/research/{id}` over `/research/{id}`:
    // a top-level route would match no Personal clause and the switcher would vanish
    // on a Personal report. No entry was added to NEUTRAL_PREFIXES for it.
    expect(resolveWorkspaceNavContext("/workspace/research/run-7", ITEMS)).toEqual({ kind: "personal", label: "Personal" });
    expect(resolveWorkspaceNavContext("/workspace/research/run%20with%20spaces", ITEMS)).toEqual({ kind: "personal", label: "Personal" });
    // and it is still Personal for a caller with zero Team memberships
    expect(resolveWorkspaceNavContext("/workspace/research/run-7", [])).toEqual({ kind: "personal", label: "Personal" });
  });

  it("null/empty pathname yields no context", () => {
    expect(resolveWorkspaceNavContext(null, ITEMS)).toBeNull();
    expect(resolveWorkspaceNavContext("", ITEMS)).toBeNull();
  });
});

describe("teamWorkspaceHref", () => {
  it("always the Overview, always percent-encoded", () => {
    expect(teamWorkspaceHref("ws_9z4")).toBe("/workspace/team/ws_9z4");
    expect(teamWorkspaceHref("ws/a b")).toBe("/workspace/team/ws%2Fa%20b");
    expect(teamWorkspaceHref("ws/a b")).not.toContain("ws/a b");
  });
});

// ───────────────────────────── visibility ─────────────────────────────

describe("WorkspaceSwitcher — visibility", () => {
  it("zero memberships: renders nothing", () => {
    const { renderer } = mount({ items: [], status: "ready" });
    expect(renderer.toJSON()).toBeNull();
  });

  it("total list error with nothing established: renders nothing", () => {
    const { renderer } = mount({ items: [], status: "error" });
    expect(renderer.toJSON()).toBeNull();
  });

  it("still loading with no items yet: renders nothing", () => {
    const { renderer } = mount({ items: [], status: "loading" });
    expect(renderer.toJSON()).toBeNull();
  });

  it("neutral route: renders nothing even with memberships", () => {
    const { renderer } = mount({ pathname: "/workspace/reviews" });
    expect(renderer.toJSON()).toBeNull();
  });

  it("UNKNOWN Team-shaped route: renders nothing — absence beats a wrong or invented context", () => {
    const { renderer } = mount({ pathname: "/workspace/team/ws_foreign/projects" });
    expect(renderer.toJSON()).toBeNull();
  });

  it("one membership on a Personal route: renders", () => {
    const { renderer } = mount({ items: [WS_A], pathname: "/workspace" });
    expect(trigger(renderer)).toBeDefined();
  });
});

// ───────────────────────────── trigger ─────────────────────────────

describe("WorkspaceSwitcher — current context trigger", () => {
  it("Personal route: trigger reads exactly 'Personal', with no 'Workspace:' prefix", () => {
    const { renderer } = mount({ pathname: "/workspace/projects" });
    expect(visibleTextOf(trigger(renderer))).toBe("Personal");
    expect(visibleTextOf(trigger(renderer))).not.toMatch(/Workspace:|Team:|Context:/);
  });

  it("NON-VACUITY: on /workspace/team/ws_9z4/projects the trigger is the server NAME, not the id, not the first list item", () => {
    const { renderer } = mount({ pathname: "/workspace/team/ws_9z4/projects" });
    const text = visibleTextOf(trigger(renderer));
    expect(text).toBe("Election Evidence Team");
    expect(text).not.toContain("ws_9z4");
    expect(text).not.toBe("Acme Risk Lab");
  });

  it("long names truncate visually while the full name stays in the accessible label and title", () => {
    const long = { workspaceId: "ws_long", name: "An Extremely Long Workspace Name That Will Not Fit In The Header" };
    const { renderer } = mount({ items: [long], pathname: "/workspace/team/ws_long" });
    const t = trigger(renderer);
    expect(t.props["aria-label"]).toBe(`Switch Workspace. Current context: ${long.name}`);
    expect(t.props.title).toBe(long.name);
    const label = t.findAll((n) => n.type === "span" && typeof n.props.className === "string" && n.props.className.includes("truncate"))[0];
    expect(label.props.className).toMatch(/max-w-\[7\.5rem\]/);
    expect(label.props.className).toMatch(/sm:max-w-\[9rem\]/);
    expect(visibleTextOf(label)).toBe(long.name); // never abbreviated in the data
  });
});

// ───────────────────────────── accessibility ─────────────────────────────

describe("WorkspaceSwitcher — menu-button accessibility", () => {
  it("trigger is a button with menu semantics and a descriptive accessible name", () => {
    const { renderer } = mount({ pathname: "/workspace" });
    const t = trigger(renderer);
    expect(t.props["aria-haspopup"]).toBe("menu");
    expect(t.props["aria-expanded"]).toBe(false);
    expect(t.props["aria-controls"]).toBe("workspace-switcher-menu");
    expect(t.props["aria-label"]).toBe("Switch Workspace. Current context: Personal");
  });

  it("aria-expanded tracks the controlled open prop", () => {
    const { renderer, rerenderOpen } = mount({ pathname: "/workspace", open: false });
    expect(trigger(renderer).props["aria-expanded"]).toBe(false);
    rerenderOpen(true);
    expect(trigger(renderer).props["aria-expanded"]).toBe(true);
  });

  it("popup uses role=menu with role=menuitem children — never listbox/option semantics", () => {
    const { renderer } = mount({ pathname: "/workspace", open: true });
    expect(menu(renderer)).toHaveLength(1);
    expect(menuItems(renderer).length).toBeGreaterThan(0);
    expect(renderer.root.findAll((n) => n.props?.role === "listbox")).toHaveLength(0);
    expect(renderer.root.findAll((n) => n.props?.role === "option")).toHaveLength(0);
    for (const item of menuItems(renderer)) {
      expect(item.props["aria-selected"]).toBeUndefined();
    }
  });

  it("the current destination is marked aria-current, and exactly one is", () => {
    const { renderer } = mount({ pathname: "/workspace/team/ws_9z4", open: true });
    const current = menuItems(renderer).filter((i) => i.props["aria-current"] === "true");
    expect(current).toHaveLength(1);
    expect(visibleTextOf(current[0])).toContain("Election Evidence Team");
  });

  it("menu order is Personal then server order — no alphabetical sort, no hoisting the current item", () => {
    const { renderer } = mount({ pathname: "/workspace/team/ws_9z4", open: true });
    expect(menuItems(renderer).map(visibleTextOf).map((t) => t.replace(/\s*✓$/, ""))).toEqual([
      "Personal", "Acme Risk Lab", "Election Evidence Team",
    ]);
  });
});

// ───────────────────────────── keyboard ─────────────────────────────

describe("WorkspaceSwitcher — keyboard", () => {
  it("click toggles open through the controlled callback", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace", open: false });
    act(() => { trigger(renderer).props.onClick(); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("Enter and Space use the button's native activation (no preventDefault, no custom handling)", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace", open: false });
    for (const key of ["Enter", " "]) {
      const ev = { key, preventDefault: jest.fn(), stopPropagation: jest.fn() };
      act(() => { trigger(renderer).props.onKeyDown(ev); });
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
    // native activation path still reaches onClick
    act(() => { trigger(renderer).props.onClick(); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("ArrowDown on a closed trigger opens the menu", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace", open: false });
    const ev = { key: "ArrowDown", preventDefault: jest.fn() };
    act(() => { trigger(renderer).props.onKeyDown(ev); });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("ArrowUp on a closed trigger also opens", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace", open: false });
    act(() => { trigger(renderer).props.onKeyDown({ key: "ArrowUp", preventDefault: jest.fn() }); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("opening focuses the first menu item", async () => {
    const { renderer } = mount({ pathname: "/workspace", open: true });
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
    expect(focusStubs.some((s) => s.focus.mock.calls.length > 0)).toBe(true);
  });

  it("ArrowDown/ArrowUp/Home/End move focus and preventDefault page scroll", () => {
    const { renderer } = mount({ pathname: "/workspace", open: true });
    const items = menuItems(renderer);
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      const ev = { key, preventDefault: jest.fn(), stopPropagation: jest.fn() };
      act(() => { items[0].props.onKeyDown(ev); });
      expect(ev.preventDefault).toHaveBeenCalled();
    }
    expect(focusStubs.some((s) => s.focus.mock.calls.length > 0)).toBe(true);
  });

  it("Escape closes, returns focus to the trigger, and stops propagation so TopNav's own Escape cannot double-fire", () => {
    const focusSpy = jest.fn();
    const { renderer, onOpenChange, triggerRef } = mount({ pathname: "/workspace", open: true });
    (triggerRef as { current: unknown }).current = { focus: focusSpy };
    const ev = { key: "Escape", preventDefault: jest.fn(), stopPropagation: jest.fn() };
    act(() => { menuItems(renderer)[0].props.onKeyDown(ev); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(focusSpy).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();
  });

  it("Tab closes but NEVER preventDefaults — normal browser tab order must keep working", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace", open: true });
    const ev = { key: "Tab", preventDefault: jest.fn(), stopPropagation: jest.fn() };
    act(() => { menuItems(renderer)[0].props.onKeyDown(ev); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── navigation ─────────────────────────────

describe("WorkspaceSwitcher — navigation targets", () => {
  it("Personal targets /workspace when the caller is admitted to the Personal Workspace UI", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace/team/ws_9z4", open: true, personalHref: "/workspace" });
    act(() => { menuItems(renderer)[0].props.onClick(); });
    expect(onOpenChange).toHaveBeenCalledWith(false); // closed BEFORE navigating
    expect(mockedPush).toHaveBeenCalledWith("/workspace");
  });

  it("Personal falls back to / when NOT admitted — never navigating a legitimate member into a rollout-gated notFound()", () => {
    const { renderer } = mount({ pathname: "/workspace/team/ws_9z4", open: true, personalHref: "/" });
    act(() => { menuItems(renderer)[0].props.onClick(); });
    expect(mockedPush).toHaveBeenCalledWith("/");
    expect(mockedPush).not.toHaveBeenCalledWith("/workspace");
  });

  it("selecting another Workspace lands on its OVERVIEW, dropping the current subroute entirely", () => {
    const { renderer } = mount({ pathname: "/workspace/team/ws_7x2/projects/proj_1/research/run_1", open: true });
    const target = menuItems(renderer).find((i) => visibleTextOf(i).includes("Election Evidence Team"))!;
    act(() => { target.props.onClick(); });
    expect(mockedPush).toHaveBeenCalledWith("/workspace/team/ws_9z4");
    const pushed = String(mockedPush.mock.calls[0][0]);
    expect(pushed).not.toContain("proj_1");
    expect(pushed).not.toContain("run_1");
  });

  it("reserved-character Workspace ids are percent-encoded in the destination", () => {
    const reserved = { workspaceId: "ws/a b", name: "Reserved Chars Team" };
    const { renderer } = mount({ items: [reserved], pathname: "/workspace", open: true });
    const target = menuItems(renderer).find((i) => visibleTextOf(i).includes("Reserved Chars Team"))!;
    act(() => { target.props.onClick(); });
    expect(mockedPush).toHaveBeenCalledWith("/workspace/team/ws%2Fa%20b");
  });

  it("activating the ALREADY-CURRENT item just closes — no redundant navigation", () => {
    const { renderer, onOpenChange } = mount({ pathname: "/workspace/team/ws_9z4", open: true });
    const current = menuItems(renderer).find((i) => i.props["aria-current"] === "true")!;
    act(() => { current.props.onClick(); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockedPush).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── partial failure ─────────────────────────────

describe("WorkspaceSwitcher — partial list failure", () => {
  it("renders with a retry action when the list is known-incomplete, so the omission is never silent", () => {
    const { renderer } = mount({ items: [WS_A], status: "partial_error", pathname: "/workspace", open: true });
    const labels = menuItems(renderer).map(visibleTextOf);
    expect(labels).toContain("Retry loading all Workspaces");
  });

  it("a complete list shows no retry action", () => {
    const { renderer } = mount({ status: "ready", pathname: "/workspace", open: true });
    expect(menuItems(renderer).map(visibleTextOf)).not.toContain("Retry loading all Workspaces");
  });

  it("retry invokes the callback and closes, returning focus to the trigger", () => {
    const focusSpy = jest.fn();
    const { renderer, onRetry, onOpenChange, triggerRef } = mount({ items: [WS_A], status: "partial_error", pathname: "/workspace", open: true });
    (triggerRef as { current: unknown }).current = { focus: focusSpy };
    const retryItem = menuItems(renderer).find((i) => visibleTextOf(i) === "Retry loading all Workspaces")!;
    act(() => { retryItem.props.onClick(); });
    expect(onRetry).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(focusSpy).toHaveBeenCalled();
  });

  it("partial failure where the CURRENT Team membership was not retrieved: no Team context is invented", () => {
    // on ws_9z4 but only ws_7x2 came back
    const { renderer } = mount({ items: [WS_A], status: "partial_error", pathname: "/workspace/team/ws_9z4/projects" });
    expect(renderer.toJSON()).toBeNull();
  });
});

// ───────────────────────────── P6 + no persistence ─────────────────────────────

describe("WorkspaceSwitcher — P6 and statelessness", () => {
  it("P6: a member with an active non-canary membership gets the switcher; the component takes no rollout flag at all", () => {
    const p6 = { workspaceId: "ws_non_canary", name: "Existing Research Team" };
    const { renderer } = mount({ items: [p6], pathname: "/workspace", open: true });
    expect(trigger(renderer)).toBeDefined();
    expect(menuItems(renderer).map(visibleTextOf)).toContain("Existing Research Team");
    // Destination is still the real Workspace Overview, so P6 can actually reach it.
    const item = menuItems(renderer).find((i) => visibleTextOf(i).includes("Existing Research Team"))!;
    act(() => { item.props.onClick(); });
    expect(mockedPush).toHaveBeenCalledWith("/workspace/team/ws_non_canary");
  });

  it("AJ — client navigation on a PERSISTENT instance re-derives context from the new pathname, with no remount and no remembered selection", () => {
    // TopNav is mounted once by the root layout and survives client navigation,
    // so this updates the same tree rather than mounting a fresh one.
    const onOpenChange = jest.fn();
    const onRetry = jest.fn();
    const triggerRef = { current: null } as unknown as React.RefObject<HTMLButtonElement>;
    const at = (pathname: string) =>
      createElement(WorkspaceSwitcher, { pathname, items: ITEMS, status: "ready" as WorkspaceListStatus, personalHref: "/workspace", open: false, onOpenChange, onRetry, triggerRef });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(at("/workspace/team/ws_7x2")); });
    expect(visibleTextOf(trigger(renderer))).toBe("Acme Risk Lab");

    act(() => { renderer.update(at("/workspace/team/ws_9z4/projects")); });
    expect(visibleTextOf(trigger(renderer))).toBe("Election Evidence Team");

    act(() => { renderer.update(at("/workspace/projects")); });
    expect(visibleTextOf(trigger(renderer))).toBe("Personal");

    // ...and the previous Workspace is not retained anywhere
    act(() => { renderer.update(at("/workspace/team/ws_foreign")); });
    expect(renderer.toJSON()).toBeNull();
  });
});
