/**
 * Phase 7B/7B.1 — GET /workspace/projects route gate. Calls the Server
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

const mockedResolvePersonalWorkspaceForOwner = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({
  resolvePersonalWorkspaceForOwner: (...args: any[]) => mockedResolvePersonalWorkspaceForOwner(...args),
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

function validWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "personal-owner-1",
    type: "personal",
    name: "Personal",
    ownerUserId: "owner-1",
    createdAt: "x",
    updatedAt: "x",
    ...overrides,
  };
}

beforeEach(() => {
  uiGlobal = false;
  uiCanary = undefined;
  backendGlobal = false;
  backendCanary = undefined;
  jest.clearAllMocks();
  // Default: eligible callers have a valid Personal Workspace — tests
  // that only care about the rollout gates never need to restate this.
  mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace() });
});

describe("GET /workspace/projects — rollout gate matrix", () => {
  it("unauthenticated -> real notFound() (404), regardless of flags, no Workspace lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    uiGlobal = true;
    backendGlobal = true;
    await expectRealNotFound(ProjectsPage());
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("backend ineligible (UI on, backend off) -> real notFound() (404), no Workspace lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = false;
    await expectRealNotFound(ProjectsPage());
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("UI ineligible (backend on, UI off) -> real notFound() (404), no Workspace lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = false;
    backendGlobal = true;
    await expectRealNotFound(ProjectsPage());
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("both eligible via global flags + valid Workspace -> renders the shell, no notFound() thrown", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = true;
    const result = await ProjectsPage();
    expect(result).toBeTruthy();
  });

  it("both eligible via matching canaries + valid Workspace -> renders the shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "owner-1";
    backendCanary = "owner-1";
    const result = await ProjectsPage();
    expect(result).toBeTruthy();
  });

  it("SECURITY: UI canary hit but backend canary miss -> real notFound() (404), no Workspace lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "owner-1";
    backendCanary = "someone-else";
    await expectRealNotFound(ProjectsPage());
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("SECURITY: malformed UI canary config while UI global is off -> real notFound() (404), never falls open", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "not/a/valid/uid";
    backendGlobal = true;
    await expectRealNotFound(ProjectsPage());
  });

  it("neither eligible -> real notFound() (404), no Workspace lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    await expectRealNotFound(ProjectsPage());
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
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

describe("GET /workspace/projects — Phase 7B.1 canonical Personal Workspace prerequisite", () => {
  beforeEach(() => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = true;
  });

  it("valid Personal Workspace -> renders the shell", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace() });
    const result = await ProjectsPage();
    expect(result).toBeTruthy();
  });

  it("missing Workspace -> real notFound() (404)", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(ProjectsPage());
  });

  it("malformed Workspace -> real notFound() (404)", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "malformed" });
    await expectRealNotFound(ProjectsPage());
  });

  it("embedded-ID mismatch (collapsed into resolver's own 'malformed' outcome — never a distinct status this page could leak) -> real notFound() (404)", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "malformed" });
    await expectRealNotFound(ProjectsPage());
  });

  it("wrong owner -> real notFound() (404)", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "wrong_owner" });
    await expectRealNotFound(ProjectsPage());
  });

  it("non-personal/unsupported Workspace type -> real notFound() (404)", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "wrong_type" });
    await expectRealNotFound(ProjectsPage());
  });

  it("Workspace resolver infrastructure failure (lookup_failed) -> real notFound() (404), never fabricates a valid Workspace to paper over an outage", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "lookup_failed" });
    await expectRealNotFound(ProjectsPage());
  });

  it("Workspaces globally disabled -> real notFound() (404)", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "workspaces_disabled" });
    await expectRealNotFound(ProjectsPage());
  });

  it("SECURITY: none of the Workspace failure reasons are distinguishable in the thrown error — every one produces the identical NEXT_NOT_FOUND digest, never a different error shape", async () => {
    const reasons = ["not_found", "malformed", "wrong_owner", "wrong_type", "lookup_failed", "workspaces_disabled"];
    for (const status of reasons) {
      mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status });
      let caught: unknown;
      try {
        await ProjectsPage();
      } catch (err) {
        caught = err;
      }
      expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
    }
  });

  it("SECURITY: Workspace resolution uses the server-resolved identity.uid, never a forged uid from any route-prop shape", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-2" });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace({ id: "personal-owner-2", ownerUserId: "owner-2" }) });
    const ProjectsPageAny = ProjectsPage as unknown as (props: Record<string, unknown>) => Promise<unknown>;
    await ProjectsPageAny({ searchParams: { uid: "owner-1" }, uid: "owner-1" });
    expect(mockedResolvePersonalWorkspaceForOwner).toHaveBeenCalledWith("owner-2");
  });
});

describe("GET /workspace/projects — no provisioning, no Project/run data fetching (Workspace prerequisite READ is not either of these)", () => {
  it("this page module never provisions a Personal Workspace, never fetches Project/run data, and never queries projects/runs/projectEvents directly", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    // Strip comments before matching — this page's own doc comments
    // legitimately explain what's NOT called (e.g. mentioning
    // `ensurePersonalWorkspace()` by name in prose), which a naive regex
    // would otherwise false-positive on.
    const realCodeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(realCodeOnly).not.toMatch(/fetch\([^)]*\/api\/user\/project/);
    expect(realCodeOnly).not.toMatch(/ProjectRunSummary/);
    expect(realCodeOnly).not.toMatch(/ProjectSummaryDto/);
    expect(realCodeOnly).not.toMatch(/ensurePersonalWorkspace/);
    expect(realCodeOnly).not.toMatch(/createPersonalWorkspace/);
    expect(realCodeOnly).not.toMatch(/\.create\(/);
    expect(realCodeOnly).not.toMatch(/collection\("projects"\)/);
    expect(realCodeOnly).not.toMatch(/collection\("runs"\)/);
    expect(realCodeOnly).not.toMatch(/collection\("projectEvents"\)/);
  });

  it("the only Workspace-domain import is the canonical read resolver — never a write/provisioning module", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).toMatch(/from "@\/lib\/workspaces\/resolvePersonalWorkspaceForOwner"/);
    expect(source).not.toMatch(/from "@\/lib\/firestore\/workspaces"/);
  });
});
