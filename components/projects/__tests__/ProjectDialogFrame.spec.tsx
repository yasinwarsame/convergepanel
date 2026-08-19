/**
 * Phase 7D — `ProjectDialogFrame`. Interactive behavior that doesn't touch
 * `document` (backdrop-click-to-close, `role`/`aria-modal`/`aria-labelledby`
 * wiring, render-prop `requestClose`) is covered by real `react-test-renderer`
 * mounting below. The Escape-key and initial-focus behavior depends on
 * `document`/`.focus()`, which this repo's jsdom-free test environment
 * doesn't provide — that piece is instead verified via a source-level
 * structural check, mirroring `components/__tests__/TopNav.spec.ts`'s
 * established convention for the identical constraint (see that file's own
 * header comment: "this repo deliberately has no jsdom/@testing-library/react").
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";

const source = readFileSync(join(__dirname, "..", "ProjectDialogFrame.tsx"), "utf8");

describe("ProjectDialogFrame — source-level: Escape + initial-focus + focus-restore wiring", () => {
  it("listens for Escape and calls requestClose (the same function backdrop-click and Cancel use)", () => {
    expect(source).toMatch(/event\.key === "Escape"\)\s*requestClose\(\)/);
    expect(source).toMatch(/document\.addEventListener\("keydown", handleKeyDown\)/);
    expect(source).toMatch(/document\.removeEventListener\("keydown", handleKeyDown\)/); // cleanup — no listener leak across re-renders/unmounts
  });

  it("requestClose both invokes onClose AND restores focus to the exact trigger element (never a different one)", () => {
    expect(source).toMatch(/const requestClose = useCallback\(\(\) => \{\s*onClose\(\);\s*triggerRef\.current\?\.focus\(\);/);
  });

  it("moves focus into the dialog on mount — to initialFocusRef if given, else the panel itself", () => {
    expect(source).toMatch(/\(initialFocusRef\?\.current \?\? panelRef\.current\)\?\.focus\(\)/);
  });

  it("the initial-focus effect runs once on mount only (empty dependency array) — never re-fires on every render", () => {
    expect(source).toMatch(/\}, \[\]\);/);
  });
});

function fakeTrigger() {
  return createRef<HTMLButtonElement>();
}

describe("ProjectDialogFrame — mounted behavior (no `document` dependency)", () => {
  it("renders role=dialog, aria-modal, aria-labelledby pointing at the title", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      // `children` here is ProjectDialogFrame's typed render-prop function,
      // not literal ReactNode — it must be passed inside the props object.
      // createElement's positional-children overload always types rest args
      // as ReactNode, which does not satisfy this component's `children:
      // (args) => ReactNode` prop type.
      renderer = TestRenderer.create(
        // eslint-disable-next-line react/no-children-prop
        createElement(ProjectDialogFrame, { title: "Test dialog", triggerRef: fakeTrigger(), onClose: jest.fn(), children: () => createElement("p", null, "body") })
      );
    });
    const dialog = renderer.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-modal"]).toBe("true");
    const heading = renderer.root.findByType("h2");
    expect(dialog.props["aria-labelledby"]).toBe(heading.props.id);
    expect(heading.children).toContain("Test dialog");
  });

  it("clicking the backdrop itself (not the panel) calls onClose", () => {
    const onClose = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      // eslint-disable-next-line react/no-children-prop -- see comment above
      renderer = TestRenderer.create(createElement(ProjectDialogFrame, { title: "T", triggerRef: fakeTrigger(), onClose, children: () => createElement("p", null, "body") }));
    });
    const backdrop = renderer.root.findByProps({ role: "dialog" });
    const fakeEvent = { target: "backdrop-node", currentTarget: "backdrop-node" };
    act(() => {
      backdrop.props.onMouseDown(fakeEvent);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the panel (target !== currentTarget) does NOT close", () => {
    const onClose = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      // eslint-disable-next-line react/no-children-prop -- see comment above
      renderer = TestRenderer.create(createElement(ProjectDialogFrame, { title: "T", triggerRef: fakeTrigger(), onClose, children: () => createElement("p", null, "body") }));
    });
    const backdrop = renderer.root.findByProps({ role: "dialog" });
    act(() => {
      backdrop.props.onMouseDown({ target: "inner-node", currentTarget: "backdrop-node" });
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("children render-prop receives a working requestClose that also calls onClose", () => {
    const onClose = jest.fn();
    let capturedRequestClose: (() => void) | null = null;
    act(() => {
      TestRenderer.create(
        // eslint-disable-next-line react/no-children-prop -- see comment above
        createElement(ProjectDialogFrame, {
          title: "T",
          triggerRef: fakeTrigger(),
          onClose,
          children: ({ requestClose }: { requestClose: () => void; titleId: string }) => {
            capturedRequestClose = requestClose;
            return createElement("p", null, "body");
          },
        })
      );
    });
    act(() => {
      capturedRequestClose!();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
