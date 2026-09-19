/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the `New Video` entry points, and the
 * capability each one is derived from.
 *
 * The derivation tests exist because of R5-I2's surviving mutation I2-M16: a
 * capability HINT needs its own test. Rendering the section proved nothing
 * about which capability gated it, so an incorrect requirement went undetected.
 * Here the two addresses deliberately differ — Unfiled needs `research.create`
 * alone, Project-filed needs `research.create` AND `research.organize` — and
 * each derivation is pinned from the page source.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));

let auth: { user: { uid: string } | null; authReady: boolean } = { user: { uid: "uid-a" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => auth }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import TeamWorkspaceVideosShell from "@/components/workspace/videos/TeamWorkspaceVideosShell";
import { teamVideoCreateHref } from "@/lib/workspaces/teamVideoCreateHref";

const W = "ws-1";
const P = "proj-1";

const emptyList = { ok: true, items: [], nextCursor: null };
const response = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountVideosShell(props: Record<string, unknown>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(TeamWorkspaceVideosShell as never, { workspaceId: W, workspaceName: "Acme Team", showAudit: false, ...props } as never)
    );
  });
  await flush();
  return r;
}

/** Host `<a>` only: the `next/link` mock makes the composite carry identical props, so an unfiltered search double-counts every link. */
const newLinks = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((x) => x.type === "a" && x.props?.["data-testid"] === "team-videos-new");

beforeEach(() => {
  jest.clearAllMocks();
  auth = { user: { uid: "uid-a" }, authReady: true };
  mockedAuthedFetch.mockResolvedValue(response(200, emptyList));
});

describe("the create address builder", () => {
  it("addresses Unfiled creation at the Workspace", () => {
    expect(teamVideoCreateHref({ workspaceId: W, projectId: null })).toBe(`/workspace/team/${W}/videos/new`);
  });

  it("addresses Project-filed creation under the Project", () => {
    expect(teamVideoCreateHref({ workspaceId: W, projectId: P })).toBe(`/workspace/team/${W}/projects/${P}/videos/new`);
  });

  it("percent-encodes both segments exactly once", () => {
    expect(teamVideoCreateHref({ workspaceId: "a/b", projectId: "c d" })).toBe("/workspace/team/a%2Fb/projects/c%20d/videos/new");
  });

  it("never produces a Personal address", () => {
    expect(teamVideoCreateHref({ workspaceId: W, projectId: null })).not.toContain("/api/");
    expect(teamVideoCreateHref({ workspaceId: W, projectId: P })).toContain("/workspace/team/");
  });
});

describe("the Workspace Videos entry point", () => {
  it("offers New Video to a creator", async () => {
    const r = await mountVideosShell({ canCreateVideo: true });
    const links = newLinks(r);
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe(`/workspace/team/${W}/videos/new`);
    expect(String(links[0].children.join(""))).toContain("New Video");
  });

  it("hides it entirely from a viewer who cannot create", async () => {
    const r = await mountVideosShell({ canCreateVideo: false });
    expect(newLinks(r)).toHaveLength(0);
  });

  it("hides it by default rather than optimistically offering it", async () => {
    const r = await mountVideosShell({});
    expect(newLinks(r)).toHaveLength(0);
  });

  it("offers exactly ONE entry point, not one per screen region", async () => {
    const r = await mountVideosShell({ canCreateVideo: true });
    const anyCreateLink = r.root.findAll((x) => x.type === "a" && typeof x.props?.href === "string" && String(x.props.href).endsWith("/videos/new"));
    expect(anyCreateLink).toHaveLength(1);
  });

  it("does not change what the list requests", async () => {
    await mountVideosShell({ canCreateVideo: true });
    const urls = mockedAuthedFetch.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => u.includes("/video-verifications"))).toBe(true);
    expect(urls.some((u) => u.includes("/new"))).toBe(false);
  });
});

/**
 * I2-M16's lesson, applied: pin the DERIVATION, not just the rendering.
 */
describe("capability derivation, read from the page gates", () => {
  const workspacePage = readFileSync(join(process.cwd(), "app/workspace/team/[workspaceId]/videos/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const projectPage = readFileSync(join(process.cwd(), "app/workspace/team/[workspaceId]/projects/[projectId]/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("the Workspace Videos page derives canCreateVideo from research.create ALONE", () => {
    const line = workspacePage.split("\n").find((l) => l.includes("canCreateVideo="));
    expect(line).toBeDefined();
    expect(line).toContain('access.capabilities.includes("research.create")');
    expect(line).not.toContain("research.organize");
  });

  it("the Project page derives canCreateVideo from research.create AND research.organize", () => {
    const line = projectPage.split("\n").find((l) => l.includes("canCreateVideo="));
    expect(line).toBeDefined();
    expect(line).toContain('access.capabilities.includes("research.create")');
    expect(line).toContain('access.capabilities.includes("research.organize")');
    expect(line).toContain("&&");
  });

  it("neither page derives creation from a role string or an owner check", () => {
    for (const code of [workspacePage, projectPage]) {
      const line = code.split("\n").find((l) => l.includes("canCreateVideo=")) ?? "";
      for (const forbidden of ["role", "owner", "createdBy", "isAdmin"]) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  it("the read hint stays independent of the create hint", () => {
    const readLine = workspacePage.split("\n").find((l) => l.includes("canCreateVideo=")) ?? "";
    // The create hint must not be derived from research.read.
    expect(readLine).not.toContain("research.read");
  });
});
