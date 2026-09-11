/**
 * PERSONAL-RESEARCH-URL-1 §BB — the canonical route's Server Component boundary.
 *
 * The page is deliberately thin, so this pins exactly that: it establishes
 * identity, hands the opaque runId to the client shell, and does nothing else —
 * no Firestore read, no duplicated authorization, and NO Workspace/Projects
 * rollout gate (§E/§AA), which would otherwise take a user's own saved research
 * away because an unrelated UI flag had not reached them.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...a: unknown[]) => mockedResolveServerComponentIdentity(...a),
}));

const notFoundError = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw notFoundError;
  },
}));

/** The shell is exercised by its own spec; here we only observe what it receives. */
jest.mock("@/components/workspace/PersonalResearchDetailShell", () => ({
  __esModule: true,
  default: ({ runId }: { runId: string }) =>
    require("react").createElement("div", { "data-testid": "shell", "data-run-id": runId }),
}));

import PersonalResearchDetailPage from "@/app/workspace/research/[runId]/page";

const SOURCE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
/**
 * Comments stripped before any ABSENCE assertion. The page's own doc comment
 * explains that it does NOT consult `projectId` / `workspaceUiEnabled` /
 * `projectsUiEnabled`, which would otherwise satisfy a `not.toMatch` against raw
 * source — the self-referential-source-assertion trap this repo's preflight detects.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const UID = "uid-owner";

async function render(runId: string) {
  const element = await PersonalResearchDetailPage({ params: { runId } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element as never);
  });
  return renderer;
}

async function expectNotFound(runId: string) {
  let caught: unknown;
  try {
    await PersonalResearchDetailPage({ params: { runId } });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect((caught as { digest?: string }).digest).toBe("NEXT_NOT_FOUND");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
});

describe("PersonalResearchDetailPage — boundary", () => {
  it("authenticated: hands the route runId to the shell, opaque and unmodified", async () => {
    const r = await render("run-7");
    const shell = r.root.findAll((n) => n.props?.["data-testid"] === "shell")[0];
    expect(shell.props["data-run-id"]).toBe("run-7");
  });

  it("a percent-encoded id arrives decoded by the router and is passed through as-is", async () => {
    const r = await render("run with spaces & stuff");
    expect(r.root.findAll((n) => n.props?.["data-testid"] === "shell")[0].props["data-run-id"]).toBe("run with spaces & stuff");
  });

  it("unauthenticated: concealed notFound, and the shell is never constructed", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectNotFound("run-7");
  });

  it("a blank/whitespace address is not a run", async () => {
    await expectNotFound("   ");
  });

  it("§F — does NOT read Firestore, re-authorize, or infer a project", () => {
    expect(CODE).not.toMatch(/adminDb|firestore|getWorkspace|resolveProjectForOwner|resolveWorkspaceAccess/);
    expect(CODE).not.toMatch(/projectId/);
    expect(CODE).not.toMatch(/collection\(/);
  });

  it("§E/§AA — is NOT gated on Workspace or Projects UI rollout", () => {
    expect(CODE).not.toMatch(/workspaceUiEnabled|WORKSPACES_UI_ENABLED|projectsUiEnabled|PROJECTS_UI_ENABLED|resolveProjectsUiEligibility|resolvePersonalWorkspaceUiMode/);
    // ...and is not gated on Team rollout either
    expect(CODE).not.toMatch(/resolveTeamWorkspacesMode|TEAM_WORKSPACES_ENABLED/);
    // C1: the assertion above was an ENUMERATION of flag identifiers, and the real
    // env constants (PERSONAL_WORKSPACE_UI_ENABLED, …) were not among the names it
    // listed — a rollout gate written with the actual flag would have passed it.
    // Eligibility cannot be read without importing a source of it, or reading the
    // environment, so pin both instead of guessing at names.
    const imports = [...CODE.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      "@/components/workspace/PersonalResearchDetailShell",
      "@/lib/auth/resolveServerComponentIdentity",
      "next/navigation",
    ]);
    expect(CODE).not.toMatch(/process\.env/);
    expect(CODE).not.toMatch(/@\/lib\/env/);
  });

  it("§AS — force-dynamic, so an authenticated report is never statically generated or shared across users", () => {
    expect(SOURCE).toMatch(/export const dynamic = "force-dynamic"/);
    expect(SOURCE).not.toMatch(/revalidate|generateStaticParams|force-cache/);
  });
});
