/**
 * Phase 7B — GET /workspace/projects route gate. Calls the Server
 * Component function directly and asserts real `next/navigation`
 * `notFound()` behavior (mirrors app/workspace/__tests__/page.spec.tsx's
 * established methodology exactly, including the reasoning in that
 * file's own header comment for why a mocked `notFound` would be a
 * hollow test).
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

let uiGlobal = false;
let uiCanary: string | undefined = undefined;
let backendGlobal = false;
let backendCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get PROJECTS_UI_ENABLED() {
    return uiGlobal;
  },
  get PROJECTS_UI_CANARY_UIDS() {
    return uiCanary;
  },
  get PROJECTS_ENABLED() {
    return backendGlobal;
  },
  get PROJECTS_CANARY_UIDS() {
    return backendCanary;
  },
}));

jest.mock("@/components/projects/ProjectsShell", () => ({
  __esModule: true,
  default: () => "PROJECTS_SHELL_RENDERED_MARKER",
}));

import ProjectsPage from "@/app/workspace/projects/page";

async function expectRealNotFound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(typeof caught).toBe("object");
  expect(caught).not.toBeNull();
  expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
}

beforeEach(() => {
  uiGlobal = false;
  uiCanary = undefined;
  backendGlobal = false;
  backendCanary = undefined;
  jest.clearAllMocks();
});

describe("GET /workspace/projects — route gate matrix", () => {
  it("unauthenticated -> real notFound() (404), regardless of flags", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    uiGlobal = true;
    backendGlobal = true;
    await expectRealNotFound(ProjectsPage());
  });

  it("backend ineligible (UI on, backend off) -> real notFound() (404)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = false;
    await expectRealNotFound(ProjectsPage());
  });

  it("UI ineligible (backend on, UI off) -> real notFound() (404)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = false;
    backendGlobal = true;
    await expectRealNotFound(ProjectsPage());
  });

  it("both eligible via global flags -> renders the shell, no notFound() thrown", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = true;
    const result = await ProjectsPage();
    expect(result).toBeTruthy();
  });

  it("both eligible via matching canaries -> renders the shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "owner-1";
    backendCanary = "owner-1";
    const result = await ProjectsPage();
    expect(result).toBeTruthy();
  });

  it("SECURITY: UI canary hit but backend canary miss -> real notFound() (404)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "owner-1";
    backendCanary = "someone-else";
    await expectRealNotFound(ProjectsPage());
  });

  it("SECURITY: malformed UI canary config while UI global is off -> real notFound() (404), never falls open", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "not/a/valid/uid";
    backendGlobal = true;
    await expectRealNotFound(ProjectsPage());
  });

  it("neither eligible -> real notFound() (404)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    await expectRealNotFound(ProjectsPage());
  });

  it("SECURITY: a forged uid passed via any route-prop shape can never override the server-resolved identity — authenticated as a non-canary uid, with an eligible uid injected into an arbitrary prop, still 404s", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-2" });
    uiCanary = "owner-1";
    backendCanary = "owner-1";
    // Deliberately probes an undeclared prop shape at runtime (not a type
    // contract test) — the real page accepts no props at all; this proves
    // that even if it did, no such value could ever change eligibility.
    const ProjectsPageAny = ProjectsPage as unknown as (props: Record<string, unknown>) => Promise<unknown>;
    await expectRealNotFound(ProjectsPageAny({ searchParams: { uid: "owner-1" }, uid: "owner-1", params: { uid: "owner-1" } }));
  });
});

describe("GET /workspace/projects — no data fetching, no Workspace provisioning", () => {
  it("this page module never imports/calls a Project read API, a run-summary type, or a Workspace-provisioning function", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).not.toMatch(/fetch\([^)]*\/api\/user\/project/);
    expect(source).not.toMatch(/ProjectRunSummary/);
    expect(source).not.toMatch(/ProjectSummaryDto/);
    expect(source).not.toMatch(/ensurePersonalWorkspace/);
    expect(source).not.toMatch(/createPersonalWorkspace/);
  });
});
