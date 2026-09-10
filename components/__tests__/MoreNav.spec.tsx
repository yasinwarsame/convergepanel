/**
 * Phase 11B.6 — `MoreNav` behaviour against a REAL rendered tree
 * (`react-test-renderer`, this repo's convention; no jsdom/Testing Library is
 * added for this phase). `TopNav.spec.ts` is source-level and cannot credibly
 * prove focus return, Escape, Tab or item activation, which is the whole reason
 * this component was extracted.
 *
 * Focus is observed through `createNodeMock`, so focus-return is asserted on an
 * actual call rather than inferred.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className, onClick, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, onClick, ...rest }, children as React.ReactNode);
  return { __esModule: true, default: MockLink };
});

import MoreNav, { type MoreNavItem } from "@/components/MoreNav";

const ITEMS: MoreNavItem[] = [
  { key: "approval-queue", label: "Approval Queue", href: "/workspace/reviews", current: false },
  { key: "team-reviews", label: "Team Reviews", href: "/team/reviews", current: false },
  { key: "governance", label: "Governance", href: "/governance", current: false },
  { key: "team-workspaces", label: "Team Workspaces", href: "/workspace/team", current: false },
];

function mount(opts: { items?: MoreNavItem[]; open?: boolean } = {}) {
  const onOpenChange = jest.fn();
  const triggerRef = { current: null } as unknown as React.RefObject<HTMLButtonElement>;
  const element = (open: boolean) =>
    createElement(MoreNav, { items: opts.items ?? ITEMS, open, onOpenChange, triggerRef });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element(opts.open ?? false), {
      createNodeMock: (el) => (el.type === "button" ? { focus: jest.fn(), nodeName: "BUTTON" } : null),
    });
  });
  return { renderer, onOpenChange, triggerRef, setOpen: (o: boolean) => act(() => { renderer.update(element(o)); }) };
}

const trigger = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType("button")[0];
const panel = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.id === "more-nav");
const links = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType("a");
const textOf = (n: TestRenderer.ReactTestInstance): string => {
  const out: string[] = [];
  const walk = (x: TestRenderer.ReactTestInstance) => {
    x.children.forEach((c) => {
      if (typeof c === "string") out.push(c);
      else if (c.props?.["aria-hidden"] !== "true" && !String(c.props?.className ?? "").includes("sr-only")) walk(c);
    });
  };
  walk(n);
  return out.join("").replace(/\s+/g, " ").trim();
};

beforeEach(() => jest.clearAllMocks());

describe("MoreNav — rendering", () => {
  it("renders nothing when there are no eligible items: a trigger opening onto an empty panel is a dead control", () => {
    expect(mount({ items: [] }).renderer.toJSON()).toBeNull();
  });

  it("closed: trigger present with aria-expanded=false, and no panel", () => {
    const { renderer } = mount({ open: false });
    expect(trigger(renderer).props["aria-expanded"]).toBe(false);
    expect(trigger(renderer).props["aria-controls"]).toBe("more-nav");
    expect(panel(renderer)).toHaveLength(0);
    expect(links(renderer)).toHaveLength(0);
  });

  it("open: panel renders every item in the given order, as ordinary links", () => {
    const { renderer } = mount({ open: true });
    expect(trigger(renderer).props["aria-expanded"]).toBe(true);
    expect(panel(renderer)).toHaveLength(1);
    expect(links(renderer).map((a) => textOf(a))).toEqual(["Approval Queue", "Team Reviews", "Governance", "Team Workspaces"]);
    expect(links(renderer).map((a) => String(a.props.href))).toEqual(["/workspace/reviews", "/team/reviews", "/governance", "/workspace/team"]);
  });

  it("the current destination carries aria-current='page', and exactly one does", () => {
    const items = ITEMS.map((i) => (i.key === "governance" ? { ...i, current: true } : i));
    const { renderer } = mount({ items, open: true });
    const currents = links(renderer).filter((a) => a.props["aria-current"] === "page");
    expect(currents).toHaveLength(1);
    expect(textOf(currents[0])).toBe("Governance");
  });

  it("aria-current is NEVER put on the trigger — 'More' is not a route — but a screen-reader note marks that it contains the current page", () => {
    const items = ITEMS.map((i) => (i.key === "governance" ? { ...i, current: true } : i));
    const { renderer } = mount({ items, open: false });
    expect(trigger(renderer).props["aria-current"]).toBeUndefined();
    const sr = renderer.root.findAll((n) => typeof n.props?.className === "string" && n.props.className.includes("sr-only"));
    expect(sr).toHaveLength(1);
    expect(sr[0].children.join("")).toContain("contains the current page");
  });

  it("with no current item there is no screen-reader note and no active treatment", () => {
    const { renderer } = mount({ open: false });
    expect(renderer.root.findAll((n) => typeof n.props?.className === "string" && n.props.className.includes("sr-only"))).toHaveLength(0);
    expect(String(trigger(renderer).props.className)).toContain("text-cp-muted");
  });
});

describe("MoreNav — semantics", () => {
  it("is a PLAIN DISCLOSURE: no menu/menuitem/listbox/option roles anywhere, since the application-menu keyboard model is not implemented", () => {
    const { renderer } = mount({ open: true });
    for (const role of ["menu", "menuitem", "listbox", "option"]) {
      expect(renderer.root.findAll((n) => n.props?.role === role)).toHaveLength(0);
    }
    // and no aria-selected, which belongs to listbox
    expect(links(renderer).every((a) => a.props["aria-selected"] === undefined)).toBe(true);
  });

  it("the panel is labelled by the trigger", () => {
    const { renderer } = mount({ open: true });
    expect(panel(renderer)[0].props["aria-labelledby"]).toBe("more-nav-button");
    expect(trigger(renderer).props.id).toBe("more-nav-button");
  });
});

describe("MoreNav — interaction", () => {
  it("clicking the trigger toggles through the controlled callback", () => {
    const { renderer, onOpenChange } = mount({ open: false });
    act(() => { trigger(renderer).props.onClick(); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("activating a destination closes the disclosure before navigation", () => {
    const { renderer, onOpenChange } = mount({ open: true });
    act(() => { links(renderer)[0].props.onClick(); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Escape closes, returns focus to the trigger, and stops propagation so TopNav's own Escape cannot double-fire", () => {
    const focusSpy = jest.fn();
    const { renderer, onOpenChange, triggerRef } = mount({ open: true });
    (triggerRef as { current: unknown }).current = { focus: focusSpy };
    const ev = { key: "Escape", preventDefault: jest.fn(), stopPropagation: jest.fn() };
    act(() => { panel(renderer)[0].props.onKeyDown(ev); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(focusSpy).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();
  });

  it("Escape on the trigger itself also closes and returns focus", () => {
    const focusSpy = jest.fn();
    const { renderer, onOpenChange, triggerRef } = mount({ open: true });
    (triggerRef as { current: unknown }).current = { focus: focusSpy };
    act(() => { trigger(renderer).props.onKeyDown({ key: "Escape", preventDefault: jest.fn(), stopPropagation: jest.fn() }); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(focusSpy).toHaveBeenCalled();
  });

  it("Tab closes but NEVER preventDefaults — the browser's own focus order must continue", () => {
    const { renderer, onOpenChange } = mount({ open: true });
    const ev = { key: "Tab", preventDefault: jest.fn(), stopPropagation: jest.fn() };
    act(() => { panel(renderer)[0].props.onKeyDown(ev); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("Arrow/Home/End are NOT intercepted, consistent with a plain disclosure rather than a menu", () => {
    const { renderer } = mount({ open: true });
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      const ev = { key, preventDefault: jest.fn(), stopPropagation: jest.fn() };
      act(() => { panel(renderer)[0].props.onKeyDown(ev); });
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("STRUCTURAL: registers no document-level listener and runs no effect — TopNav owns outside-click for all four disclosures", () => {
    // There is no jsdom in this repo, so `document` does not exist here and this
    // cannot be asserted behaviourally. Scoped to MoreNav's own source instead:
    // the component has no effect at all, so it is incapable of registering a
    // listener that could race TopNav's single one. The authoritative count
    // assertion (exactly one `mousedown` registration) lives in TopNav.spec.ts.
    const source = readFileSync(join(__dirname, "..", "MoreNav.tsx"), "utf8");
    expect(source).not.toMatch(/addEventListener/);
    expect(source).not.toMatch(/useEffect/);
    expect(source).not.toMatch(/document\./);
  });
});
