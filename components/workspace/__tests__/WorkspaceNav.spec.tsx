/**
 * Team Workspace Activation Flow, Phase 12A.1 — tests for the shared
 * `WorkspaceNav`. Pure, prop-driven, no hooks/effects, so
 * `renderToStaticMarkup` exercises its real render logic directly (this
 * repo has no jsdom/@testing-library/react — see
 * `components/workspace/__tests__/WorkspaceMembersShell.spec.tsx`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";

describe("WorkspaceNav", () => {
  it("always renders Overview and Members, linking to the exact Workspace", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "audit", showAudit: true }));
    expect(html).toContain("Overview");
    expect(html).toContain("Members");
    expect(html).toContain('href="/workspace/team/ws-1"');
    expect(html).toContain('href="/workspace/team/ws-1/members"');
  });

  it("showAudit: false omits the Audit Log link entirely", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "overview", showAudit: false }));
    expect(html).not.toContain("Audit Log");
  });

  it("showAudit: true includes a link to the exact Workspace's audit page", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "overview", showAudit: true }));
    expect(html).toContain("Audit Log");
    expect(html).toContain('href="/workspace/team/ws-1/audit"');
  });

  it("the active item is rendered as non-interactive current-page text, not a link to itself", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "members", showAudit: true }));
    // "Members" appears as a <span aria-current="page">, not inside an <a href=".../members">.
    expect(html).toMatch(/<span[^>]*aria-current="page"[^>]*>Members<\/span>/);
    expect(html).not.toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/members"[^>]*>Members<\/a>/);
  });

  it("a non-active item remains a real link", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "members", showAudit: false }));
    expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1"[^>]*>Overview<\/a>/);
  });

  it("workspaceId is URI-encoded in every href", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws with space", active: "overview", showAudit: true }));
    expect(html).toContain(encodeURIComponent("ws with space"));
    expect(html).not.toContain("/workspace/team/ws with space");
  });

  describe("Phase 12A.2 — Projects is a PERMANENT navigation destination", () => {
    it("always renders a Projects link, regardless of the active item or showAudit", () => {
      for (const active of ["overview", "projects", "members", "audit"] as const) {
        for (const showAudit of [true, false]) {
          const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active, showAudit }));
          expect(html).toContain("Projects");
          if (active !== "projects") {
            expect(html).toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/projects"[^>]*>Projects<\/a>/);
          }
        }
      }
    });

    it("active: 'projects' renders it as the non-interactive current-page item", () => {
      const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "projects", showAudit: true }));
      expect(html).toMatch(/<span[^>]*aria-current="page"[^>]*>Projects<\/span>/);
      expect(html).not.toMatch(/<a[^>]*href="\/workspace\/team\/ws-1\/projects"[^>]*>Projects<\/a>/);
    });

    it("Projects appears between Overview and Members, matching the frozen product order", () => {
      const html = renderToStaticMarkup(createElement(WorkspaceNav, { workspaceId: "ws-1", active: "audit", showAudit: true }));
      const overviewIdx = html.indexOf(">Overview<");
      const projectsIdx = html.indexOf(">Projects<");
      const membersIdx = html.indexOf(">Members<");
      expect(overviewIdx).toBeGreaterThan(-1);
      expect(overviewIdx).toBeLessThan(projectsIdx);
      expect(projectsIdx).toBeLessThan(membersIdx);
    });
  });
});
