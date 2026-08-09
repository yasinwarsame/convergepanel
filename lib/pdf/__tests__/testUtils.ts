/**
 * Adaptive Research Export, Phase 1 — structural PDF test helper.
 *
 * `AdaptiveResearchDocument({record})` returns a plain React element tree
 * (react-pdf's `<Document>`/`<Page>`/`<View>`/`<Text>` components) before
 * it's ever rendered to actual PDF bytes. Walking that tree directly for
 * text content is a deterministic, fast, dependency-free way to assert on
 * the PDF's real content — avoiding both "brittle pixel-perfect snapshot
 * tests" (Part 17's own instruction) and re-parsing generated PDF bytes,
 * which would need `pdfjs-dist`'s ESM/`import.meta` build reconfigured for
 * Jest (a broader test-infra change out of scope for this phase — the
 * legacy Node build isn't CJS-transform-compatible out of the box).
 */

/**
 * `@react-pdf/renderer`'s own components (`View`, `Text`, `Document`, ...)
 * are plain string tags ("VIEW", "TEXT", ...) — a react element referencing
 * one just needs its `props.children` walked, same as any host element.
 * But every custom component in AdaptiveResearchDocument.tsx (CoverHeader,
 * SectionCard, Milestone2Content, ...) is a real function — JSX never calls
 * a function component eagerly, so `<CoverHeader record={record} />` is
 * just `{type: CoverHeader, props: {record}}` until something actually
 * invokes it. React's reconciler normally does that at render time; since
 * this walker runs over the pre-render element tree with no reconciler
 * involved, it must invoke function-typed elements itself to reach their
 * output — otherwise every custom component in the tree resolves to no
 * text at all. None of these components use hooks/context, so calling them
 * directly outside a real render pass is safe.
 */
function collectText(node: unknown, out: string[], depth = 0): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectText(child, out, depth));
    return;
  }
  if (typeof node === "object" && "type" in (node as Record<string, unknown>) && "props" in (node as Record<string, unknown>)) {
    if (depth > 60) return; // guard against a genuine infinite-recursion bug, not expected in practice
    const el = node as { type: unknown; props?: { children?: unknown } };
    if (typeof el.type === "function") {
      const rendered = (el.type as (props: unknown) => unknown)(el.props);
      collectText(rendered, out, depth + 1);
      return;
    }
    if (el.props && "children" in el.props) collectText(el.props.children, out, depth);
  }
}

/** Flattened, whitespace-joined text content of a react-pdf element tree — the PDF's real extracted text, structurally. */
export function extractPdfElementText(element: unknown): string {
  const out: string[] = [];
  collectText(element, out);
  return out.join(" ");
}
