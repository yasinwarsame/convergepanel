/**
 * Roadmap 4.4a (N1) — every WorkspaceNav item shown to a role leads to a page
 * that role can open.
 *
 * For each role in the REAL role -> capability matrix, the nav is rendered
 * exactly as the pages render it (flags = the caller's own capabilities), and
 * each link's destination page is read from source to find the capabilities
 * it requires before rendering (`if (!access.capabilities.includes("x")) notFound()`).
 * A link to a page whose guard the role cannot pass fails this test.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const ROOT = join(__dirname, "..", "..", "..");
const TEAM_APP = join(ROOT, "app", "workspace", "team", "[workspaceId]");
const WS = "ws-1";
const BASE = `/workspace/team/${WS}`;

function pageFileFor(href: string): string {
  const rest = href.slice(BASE.length).replace(/^\//, "");
  return rest ? join(TEAM_APP, rest, "page.tsx") : join(TEAM_APP, "page.tsx");
}

function requiredCapabilities(pageFile: string): string[] {
  const src = readFileSync(pageFile, "utf8");
  return [...src.matchAll(/if \(!access\.capabilities\.includes\("([a-z.]+)"\)\)\s*\{?\s*notFound\(\)/g)].map((m) => m[1]);
}

function navHrefs(caps: readonly string[]): string[] {
  const html = renderToStaticMarkup(
    createElement(WorkspaceNav, {
      workspaceId: WS,
      active: "overview",
      showMembers: caps.includes("members.read"),
      showAudit: caps.includes("audit.read"),
    })
  );
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe("the guard extraction is not vacuous", () => {
  it("finds the capability each gated page requires", () => {
    expect(requiredCapabilities(pageFileFor(`${BASE}/members`))).toContain("members.read");
    expect(requiredCapabilities(pageFileFor(`${BASE}/audit`))).toContain("audit.read");
    expect(requiredCapabilities(pageFileFor(`${BASE}/projects`))).toContain("projects.read");
  });
});

describe.each(Object.keys(ROLE_CAPABILITIES))("role %s", (role) => {
  const caps = ROLE_CAPABILITIES[role as keyof typeof ROLE_CAPABILITIES];

  it("every nav link opens a page whose capability guard this role passes", () => {
    const hrefs = navHrefs(caps);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const missing = requiredCapabilities(pageFileFor(href)).filter((c) => !caps.includes(c as never));
      expect({ href, missing }).toEqual({ href, missing: [] });
    }
  });

  it("shows Members exactly when the role holds members.read", () => {
    expect(navHrefs(caps).includes(`${BASE}/members`)).toBe(caps.includes("members.read" as never));
  });
});

describe("the roles the defect affected", () => {
  it.each(["reviewer", "viewer"])("%s is not offered Members", (role) => {
    const caps = ROLE_CAPABILITIES[role as keyof typeof ROLE_CAPABILITIES];
    expect(caps.includes("members.read" as never)).toBe(false);
    expect(navHrefs(caps)).not.toContain(`${BASE}/members`);
  });
});

describe("wiring — every Team page derives the Members flag from its own members.read capability", () => {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const pages = execSync(`git ls-files "app/workspace/team/*page.tsx"`, { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("__tests__"));

  it("finds the Team pages", () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it("each page that passes an audit flag also passes a members flag from members.read", () => {
    for (const file of pages) {
      const src = readFileSync(join(ROOT, file), "utf8");
      const auditFlags = (src.match(/(showAudit|canReadAudit)=\{access\.capabilities\.includes\("audit\.read"\)\}/g) ?? []).length;
      const memberFlags = (src.match(/(showMembers|canReadMembers)=\{access\.capabilities\.includes\("members\.read"\)\}/g) ?? []).length;
      // The audit page always shows Audit, so it carries a Members flag with no audit flag.
      expect({ file, ok: memberFlags >= auditFlags }).toEqual({ file, ok: true });
    }
  });

  it("the Audit Log page passes its own members.read flag", () => {
    const src = readFileSync(join(TEAM_APP, "audit", "page.tsx"), "utf8");
    expect(src).toContain('canReadMembers={access.capabilities.includes("members.read")}');
  });
});
