/**
 * Phase 5C — GET /workspace route gate. Calls the Server Component
 * function directly and asserts real `next/navigation` `notFound()`
 * behavior (it throws a special digest-marked error caught by Next's own
 * rendering pipeline) rather than mocking `notFound` itself — a mocked
 * `notFound` could pass even if the real one wouldn't actually produce a
 * 404, which is exactly the kind of hollow test this session's earlier
 * mutation-testing lesson (the disproven synthesize-panel regex test)
 * warns against.
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

let uiGlobal = false;
let uiCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get PERSONAL_WORKSPACE_UI_ENABLED() {
    return uiGlobal;
  },
  get PERSONAL_WORKSPACE_UI_CANARY_UIDS() {
    return uiCanary;
  },
}));

jest.mock("@/components/workspace/WorkspaceShell", () => ({
  __esModule: true,
  default: () => "WORKSPACE_SHELL_RENDERED_MARKER",
}));

import WorkspacePage from "@/app/workspace/page";

// next/navigation's real notFound() throws an Error whose `.digest` is
// exactly "NEXT_NOT_FOUND" (confirmed directly against this repo's
// installed Next.js 14.2.33, not assumed from unrelated version
// documentation) — the actual, real signal Next's rendering pipeline
// checks for, not a string we're inventing for the test. Asserted via a
// plain try/catch (no jest-extended matcher installed in this repo) so a
// passing test proves the REAL notFound() was thrown, not just that
// "something" rejected.
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
  jest.clearAllMocks();
});

describe("GET /workspace — route gate matrix", () => {
  it("unauthenticated -> real notFound() (404), regardless of global flag", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    uiGlobal = true; // even with the feature globally on, no identity means no page
    await expectRealNotFound(WorkspacePage());
  });

  it("authenticated, global off, non-canary -> real notFound() (404)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    await expectRealNotFound(WorkspacePage());
  });

  it("authenticated, canary match -> renders the shell, no notFound() thrown", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "owner-1";
    const result = await WorkspacePage();
    expect(result).toBeTruthy();
  });

  it("SECURITY: authenticated, canary list present but uid does NOT match -> real notFound() (404)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-2" });
    uiCanary = "owner-1";
    await expectRealNotFound(WorkspacePage());
  });

  it("authenticated, global true -> renders the shell for any authenticated uid", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "any-uid-at-all" });
    uiGlobal = true;
    const result = await WorkspacePage();
    expect(result).toBeTruthy();
  });

  it("SECURITY: malformed canary config while global is off -> real notFound() (404), never falls open", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    uiCanary = "not/a/valid/uid";
    await expectRealNotFound(WorkspacePage());
  });
});

describe("GET /workspace — independence from Phase 5B APIs", () => {
  it("this page module never IMPORTS or CALLS the Workspace runs endpoint or its types (a doc-comment mention explaining independence is fine; functional usage is not)", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    expect(source).not.toMatch(/import[\s\S]*workspace\/runs/);
    expect(source).not.toMatch(/fetch\([^)]*\/api\/user\/workspace\/runs/);
    expect(source).not.toMatch(/WorkspaceRunSummary/);
  });
});
