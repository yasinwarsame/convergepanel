/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AI — "Videos" as the sixth permanent
 * Workspace destination, and proof that WORKSPACE-NAV-H1's containment still
 * holds at the item count it was actually built for.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceNav, { type WorkspaceNavItem } from "@/components/workspace/WorkspaceNav";

const ALL_ACTIVE: WorkspaceNavItem[] = ["overview", "projects", "claims", "videos", "members", "audit"];
const markup = (active: WorkspaceNavItem = "overview", showAudit = true) =>
  renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active, showAudit }));
const navClass = (html: string) => /<nav[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
const itemClasses = (html: string) => [...html.matchAll(/<(?:a|span)[^>]*class="([^"]*)"/g)].map((m) => m[1]);

describe("Videos is a PERMANENT destination", () => {
  it("always renders a Videos link, regardless of the active item or showAudit", () => {
    for (const active of ALL_ACTIVE) {
      for (const showAudit of [true, false]) {
        const html = markup(active, showAudit);
        expect(html).toContain("Videos");
        if (active !== "videos") {
          expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/videos"[^>]*>Videos<\/a>/);
        }
      }
    }
  });

  it("points at the canonical Workspace Videos route", () => {
    expect(markup("overview", false)).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/videos"[^>]*>Videos<\/a>/);
  });

  it("uses the product term, never the storage collection name", () => {
    const html = markup();
    expect(html).not.toContain("video-verifications");
    expect(html).not.toContain("videoVerifications");
  });

  it("appears between Claims and Members, matching the frozen product order", () => {
    const html = markup("overview", true);
    const order = ["Overview", "Projects", "Claims", "Videos", "Members", "Audit Log"].map((l) => html.indexOf(`>${l}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("active: 'videos' renders it as the non-interactive current-page item", () => {
    const html = markup("videos", true);
    expect(html).toMatch(/<span[^>]*aria-current="page"[^>]*>Videos<\/span>/);
    expect(html).not.toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/videos"[^>]*>Videos<\/a>/);
  });

  it("every other item remains a real link when Videos is active", () => {
    const html = markup("videos", true);
    for (const [href, label] of [
      ["/workspace/team/ws-1", "Overview"],
      ["/workspace/team/ws-1/projects", "Projects"],
      ["/workspace/team/ws-1/claims", "Claims"],
      ["/workspace/team/ws-1/members", "Members"],
      ["/workspace/team/ws-1/audit", "Audit Log"],
    ]) {
      expect(html).toMatch(new RegExp(`<a[^>]*href="${href.replace(/\//g, "\\/")}"[^>]*>${label}</a>`));
    }
  });

  it("carries no count, badge or activation condition", () => {
    const html = markup("overview", true);
    expect(html).not.toMatch(/Videos\s*\(/);
    expect(html).not.toMatch(/Videos<\/a>\s*<span[^>]*>\d/);
  });

  it("encodes the workspaceId in the Videos href", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws with space", active: "overview", showAudit: false }))).toContain(
      `href="/workspace/team/${encodeURIComponent("ws with space")}/videos"`
    );
  });

  it("Audit remains the only conditional destination", () => {
    const withoutAudit = markup("overview", false);
    expect(withoutAudit).toContain("Videos");
    expect(withoutAudit).not.toContain("Audit Log");
  });
});

describe("H1 containment still holds at six items", () => {
  it("the nav still owns its horizontal overflow boundary", () => {
    const cls = navClass(markup("videos", true));
    expect(cls).toContain("overflow-x-auto");
    expect(cls).toContain("max-w-full");
    expect(cls).toContain("relative");
    expect(cls).not.toContain("overflow-hidden");
    expect(cls).not.toContain("flex-wrap");
  });

  it("all SIX items refuse to shrink and refuse to wrap", () => {
    const classes = itemClasses(markup("videos", true));
    expect(classes).toHaveLength(6);
    for (const c of classes) {
      expect(c).toContain("shrink-0");
      expect(c).toContain("whitespace-nowrap");
    }
  });

  it("no label is truncated to make the sixth item fit", () => {
    const html = markup("overview", true);
    expect(html).toContain(">Audit Log<");
    expect(html).toContain(">Videos<");
    for (const c of itemClasses(html)) expect(c).not.toContain("truncate");
  });

  it("links keep the inset focus ring the overflow boundary requires", () => {
    for (const c of [...markup("videos", true).matchAll(/<a[^>]*class="([^"]*)"/g)].map((m) => m[1])) {
      expect(c).toContain("focus-visible:ring-inset");
    }
  });

  it("the active-item scroll correction is still wired and still horizontal-only", () => {
    const src = require("fs").readFileSync(require("path").join(process.cwd(), "components/workspace/WorkspaceNav.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toContain("nav.scrollLeft");
    expect(code).toContain("item.offsetLeft");
    expect(code).toContain("}, [active]);");
    expect(code).not.toContain("scrollIntoView");
    expect(code).not.toContain("scrollTop");
    expect(code).not.toContain("window.scroll");
  });
});

describe("the nav remains presentation-only", () => {
  it("takes no capability array, role or membership input", () => {
    const src = require("fs").readFileSync(require("path").join(process.cwd(), "components/workspace/WorkspaceNav.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["useAuth", "capabilities", "membership", "research.read", "research.create", "fetch(", "authedFetch"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
