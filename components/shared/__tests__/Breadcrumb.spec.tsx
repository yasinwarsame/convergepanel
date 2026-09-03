/**
 * Phase 11B — coverage for the generic, presentation-only `Breadcrumb`
 * component. Renders via `react-dom/server`'s `renderToStaticMarkup` (no
 * jsdom), matching this repo's established convention for simple
 * presentational components (see `GovernanceChip.spec.tsx`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumb, type BreadcrumbSegment } from "@/components/shared/Breadcrumb";

function render(props: {
  segments: BreadcrumbSegment[];
  mobileParent?: BreadcrumbSegment;
  className?: string;
}): string {
  return renderToStaticMarkup(createElement(Breadcrumb, props));
}

describe("Breadcrumb", () => {
  it("single segment: renders, has aria-current='page', is NOT a link even with an href", () => {
    const html = render({ segments: [{ label: "Dashboard", href: "/workspace" }] });
    expect(html).toContain("Dashboard");
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('href="/workspace"');
    expect(html).not.toMatch(/<a[^>]*>Dashboard/);
  });

  it("multiple segments: correct order, non-final segments with href render as real links, final segment is aria-current and not a link", () => {
    const html = render({
      segments: [
        { label: "Workspace", href: "/workspace" },
        { label: "Projects", href: "/workspace/projects" },
        { label: "Alpha Project" },
      ],
    });

    // Order preserved.
    const workspaceIdx = html.indexOf("Workspace");
    const projectsIdx = html.indexOf("Projects");
    const alphaIdx = html.indexOf("Alpha Project");
    expect(workspaceIdx).toBeGreaterThan(-1);
    expect(projectsIdx).toBeGreaterThan(workspaceIdx);
    expect(alphaIdx).toBeGreaterThan(projectsIdx);

    // Non-final segments with href are real anchors.
    expect(html).toMatch(/<a[^>]*href="\/workspace"[^>]*>Workspace<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/workspace\/projects"[^>]*>Projects<\/a>/);

    // Final segment: aria-current, not a link.
    expect(html).toContain('aria-current="page"');
    expect(html).not.toMatch(/<a[^>]*>Alpha Project<\/a>/);

    // Only one aria-current in the whole tree, and it's the last segment.
    const ariaCurrentCount = (html.match(/aria-current="page"/g) || []).length;
    expect(ariaCurrentCount).toBe(1);
  });

  it("separators are aria-hidden and never glued onto a label's accessible text", () => {
    const html = render({
      segments: [
        { label: "Workspace", href: "/workspace" },
        { label: "Projects" },
      ],
    });

    expect(html).toContain('aria-hidden="true"');
    // The separator glyph lives in its own aria-hidden span, not appended to a label.
    expect(html).not.toMatch(/Workspace\s*\//);
    expect(html).not.toMatch(/\/\s*Workspace/);
    // Separator character appears exactly once (between the two segments).
    const slashMatches = html.match(/aria-hidden="true">\//g) || [];
    expect(slashMatches.length).toBe(1);
  });

  it("long label: truncation classes present, full label text is not sliced", () => {
    const longLabel =
      "This Is An Extremely Long Project Name That Should Be Visually Truncated But Never Sliced In The DOM";
    const html = render({ segments: [{ label: longLabel }] });

    expect(html).toContain(longLabel);
    expect(html).toContain("truncate");
    expect(html).toContain(`title="${longLabel}"`);
  });

  it("mobileParent provided: correct label, correct href, real accessible name", () => {
    const html = render({
      segments: [{ label: "Alpha Project" }],
      mobileParent: { label: "Marketing Workspace", href: "/workspace" },
    });

    expect(html).toMatch(/<a[^>]*href="\/workspace"[^>]*>/);
    expect(html).toContain("Marketing Workspace");
    // Accessible name includes the full label, not just an icon.
    expect(html).toMatch(/Marketing Workspace/);
  });

  it("mobileParent without href: renders as safe plain text, not a broken anchor", () => {
    const html = render({
      segments: [{ label: "Alpha Project" }],
      mobileParent: { label: "Orphan Parent" },
    });

    expect(html).toContain("Orphan Parent");
    expect(html).not.toMatch(/<a[^>]*>[^<]*Orphan Parent/);
    expect(html).not.toContain('href=""');
  });

  it("segment without href: renders as safe plain text, not an anchor", () => {
    const html = render({
      segments: [
        { label: "No Link Here" },
        { label: "Current Page" },
      ],
    });

    expect(html).toContain("No Link Here");
    expect(html).not.toMatch(/<a[^>]*>No Link Here<\/a>/);
    expect(html).not.toContain('href=""');
  });

  it("empty segments array: renders null/nothing, no crash, no empty nav/ol shell", () => {
    const html = render({ segments: [] });
    expect(html).toBe("");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("<ol");
  });

  it("special characters/script-like strings render as inert visible text, never unescaped HTML", () => {
    const scriptLabel = "<script>alert(1)</script>";
    const html = render({ segments: [{ label: scriptLabel }] });

    // No literal, executable <script> tag should appear in the output.
    expect(html).not.toContain("<script>alert(1)</script>");
    // React escapes it to entities instead.
    expect(html).toContain("&lt;script&gt;");
  });

  it("Unicode characters render correctly", () => {
    const unicodeLabel = "Café Résumé 日本語";
    const html = render({ segments: [{ label: unicodeLabel }] });
    expect(html).toContain(unicodeLabel);
  });

  it("no mobileParent supplied: no mobile-parent element renders (no derivation from segments is attempted)", () => {
    const html = render({
      segments: [
        { label: "Workspace", href: "/workspace" },
        { label: "Projects", href: "/workspace/projects" },
        { label: "Alpha Project" },
      ],
    });

    // The desktop <ol> exists, but nothing representing a "back" affordance
    // (the arrow glyph used for the mobile parent link) is present.
    expect(html).not.toContain("←");
  });

  it("className prop is applied to the outer nav element", () => {
    const html = render({
      segments: [{ label: "Solo" }],
      className: "my-extra-class",
    });
    expect(html).toMatch(/<nav[^>]*class="[^"]*my-extra-class[^"]*"/);
  });
});
