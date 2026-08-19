/**
 * Phase 7E-B — GET /workspace/projects/{projectId} route gate. Calls the
 * Server Component function directly and asserts real `next/navigation`
 * `notFound()` behavior, mirroring `app/workspace/projects/__tests__/page.spec.tsx`'s
 * established methodology exactly. The one deliberate deviation from that
 * file's own gate — `resolveProjectForOwner()`'s `lookup_failed` must NOT
 * produce `notFound()` — has its own dedicated describe block.
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

const mockedResolveProjectForOwner = jest.fn();
jest.mock("@/lib/projects/resolveProjectForOwner", () => ({
  resolveProjectForOwner: (...args: any[]) => mockedResolveProjectForOwner(...args),
}));

jest.mock("@/components/projects/ProjectDetailShell", () => ({
  __esModule: true,
  default: (props: any) => `PROJECT_DETAIL_SHELL_RENDERED:${JSON.stringify(props)}`,
}));

import ProjectDetailPage from "@/app/workspace/projects/[projectId]/page";

async function expectRealNotFound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
}

function validWorkspace(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: "personal-owner-1", type: "personal", name: "Personal", ownerUserId: "owner-1", createdAt: "x", updatedAt: "x", ...overrides };
}

function foundProject(overrides: Record<string, unknown> = {}) {
  return {
    status: "found",
    project: { id: "proj-1", name: "My Project", status: "active", workspaceId: "personal-owner-1", createdByUserId: "owner-1", ...overrides },
    documentUpdateTime: { seconds: 1, nanoseconds: 0 },
  };
}

beforeEach(() => {
  uiGlobal = false;
  uiCanary = undefined;
  backendGlobal = false;
  backendCanary = undefined;
  jest.clearAllMocks();
  mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace() });
  mockedResolveProjectForOwner.mockResolvedValue(foundProject());
});

const PARAMS = { params: { projectId: "proj-1" } };

describe("GET /workspace/projects/{projectId} — inherits the identical rollout gate matrix", () => {
  it("unauthenticated -> real notFound(), no Workspace/Project lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    uiGlobal = true;
    backendGlobal = true;
    await expectRealNotFound(ProjectDetailPage(PARAMS));
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("Projects rollout ineligible -> real notFound(), no Workspace/Project lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = false;
    backendGlobal = false;
    await expectRealNotFound(ProjectDetailPage(PARAMS));
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("invalid/missing Workspace -> real notFound(), no Project lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = true;
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(ProjectDetailPage(PARAMS));
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });
});

describe("GET /workspace/projects/{projectId} — Project resolution outcomes", () => {
  beforeEach(() => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = true;
  });

  it.each(["invalid_project_id", "not_found", "malformed", "workspace_mismatch", "workspaces_disabled", "workspace_missing", "workspace_invalid", "unsupported_workspace"])(
    "%s -> real notFound() (404), concealed identically",
    async (status) => {
      mockedResolveProjectForOwner.mockResolvedValue({ status });
      await expectRealNotFound(ProjectDetailPage(PARAMS));
    }
  );

  it("SECURITY: every concealed outcome produces the identical NEXT_NOT_FOUND digest, never a distinguishable error", async () => {
    const reasons = ["invalid_project_id", "not_found", "malformed", "workspace_mismatch", "workspaces_disabled", "workspace_missing", "workspace_invalid", "unsupported_workspace"];
    for (const status of reasons) {
      mockedResolveProjectForOwner.mockResolvedValue({ status });
      let caught: unknown;
      try {
        await ProjectDetailPage(PARAMS);
      } catch (err) {
        caught = err;
      }
      expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
    }
  });

  it("found + active Project -> renders the detail shell with {id, name, status}", async () => {
    mockedResolveProjectForOwner.mockResolvedValue(foundProject({ status: "active" }));
    const result: any = await ProjectDetailPage(PARAMS);
    expect(result).toBeTruthy();
    expect(result.props.project).toEqual({ id: "proj-1", name: "My Project", status: "active" });
  });

  it("found + archived Project -> renders the detail shell (archived Projects are readable, never redirected)", async () => {
    mockedResolveProjectForOwner.mockResolvedValue(foundProject({ status: "archived" }));
    const result: any = await ProjectDetailPage(PARAMS);
    expect(result.props.project.status).toBe("archived");
  });

  it("the shell never receives documentUpdateTime or any other lifecycle-OCC field — only {id, name, status}", async () => {
    mockedResolveProjectForOwner.mockResolvedValue(foundProject());
    const result: any = await ProjectDetailPage(PARAMS);
    expect(Object.keys(result.props.project).sort()).toEqual(["id", "name", "status"]);
  });

  it("SECURITY: Project resolution uses the server-resolved identity.uid, never a forged uid from any route-prop shape", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-2" });
    mockedResolveProjectForOwner.mockResolvedValue(foundProject());
    const ProjectDetailPageAny = ProjectDetailPage as unknown as (props: Record<string, unknown>) => Promise<unknown>;
    await ProjectDetailPageAny({ params: { projectId: "proj-1" }, uid: "owner-1" });
    expect(mockedResolveProjectForOwner).toHaveBeenCalledWith("owner-2", "proj-1");
  });

  it("uses the projectId route param, unmodified, as the second resolveProjectForOwner argument", async () => {
    mockedResolveProjectForOwner.mockResolvedValue(foundProject());
    await ProjectDetailPage({ params: { projectId: "some-other-id" } });
    expect(mockedResolveProjectForOwner).toHaveBeenCalledWith("owner-1", "some-other-id");
  });
});

describe("GET /workspace/projects/{projectId} — infrastructure failure is distinct from concealment (spec item 6)", () => {
  beforeEach(() => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiGlobal = true;
    backendGlobal = true;
  });

  it("lookup_failed -> throws a plain Error, NOT notFound() — caught by the app's error boundary, not concealed as non-existence", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "lookup_failed" });
    let caught: unknown;
    try {
      await ProjectDetailPage(PARAMS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as any)?.digest).not.toBe("NEXT_NOT_FOUND");
  });
});

describe("GET /workspace/projects/{projectId} — no new Project-detail GET API", () => {
  it("this page module never fetches GET /api/user/projects/{id} or any new detail endpoint", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    const realCodeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(realCodeOnly).not.toMatch(/fetch\(/);
    expect(realCodeOnly).toMatch(/from "@\/lib\/projects\/resolveProjectForOwner"/);
  });
});
