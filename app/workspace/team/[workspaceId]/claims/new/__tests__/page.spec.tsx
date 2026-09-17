/**
 * TEAM-VERIFICATION-PARITY-R4-I3 §AH — the Unfiled Claim creation gate
 * `/workspace/team/{workspaceId}/claims/new`.
 */

import { readFileSync } from "fs";
import { join } from "path";

const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
jest.mock("@/components/workspace/claims/TeamClaimComposerShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "composer" }),
}));

import Page from "@/app/workspace/team/[workspaceId]/claims/new/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const WS = "ws-1";
const UID = "uid-member";
const call = () => Page({ params: { workspaceId: WS } });
const propsOf = async () => ((await call()) as unknown as { props: Record<string, unknown> }).props;

async function expectNotFound(p: Promise<unknown>) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
}

const granted = (capabilities: string[]) => ({ granted: true, workspaceType: "team", workspace: { id: WS, name: "Acme Team" }, membership: { role: "member" }, capabilities });
const CREATE = ["workspace.read", "research.read", "research.create"];

beforeEach(() => {
  jest.clearAllMocks();
  mockedIdentity.mockResolvedValue({ uid: UID });
  mockedAccess.mockResolvedValue(granted(CREATE));
});

describe("gate", () => {
  it("conceals an unauthenticated visitor", async () => {
    mockedIdentity.mockResolvedValue(null);
    await expectNotFound(call());
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it("throws on a transient lookup failure", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it.each([
    ["a non-member", { granted: false, reason: "not_a_member" }],
    ["a missing Workspace", { granted: false, reason: "not_found" }],
  ])("conceals %s", async (_l, access) => {
    mockedAccess.mockResolvedValue(access);
    await expectNotFound(call());
  });

  it("conceals a Personal Workspace", async () => {
    mockedAccess.mockResolvedValue({ ...granted(CREATE), workspaceType: "personal" });
    await expectNotFound(call());
  });

  it("conceals a member lacking research.create", async () => {
    mockedAccess.mockResolvedValue(granted(["workspace.read", "research.read"]));
    await expectNotFound(call());
  });

  it("renders for research.create WITHOUT requiring research.organize", async () => {
    mockedAccess.mockResolvedValue(granted(CREATE));
    const props = await propsOf();
    expect(props.workspaceId).toBe(WS);
    expect(CODE).not.toContain('research.organize');
  });
});

describe("what crosses to the client", () => {
  it("passes a null project and only the audit hint", async () => {
    const props = await propsOf();
    expect(Object.keys(props).sort()).toEqual(["project", "showAudit", "workspaceId", "workspaceName"]);
    expect(props.project).toBeNull();
    expect(props.workspaceName).toBe("Acme Team");
  });

  it("never hands the capability array or membership to the client", async () => {
    const s = JSON.stringify(await propsOf());
    expect(s).not.toContain("capabilities");
    expect(s).not.toContain("membership");
    expect(CODE).not.toMatch(/capabilities=\{/);
  });

  it("requires research.create, the capability the POST gates enforce", () => {
    expect(CODE).toContain('access.capabilities.includes("research.create")');
  });
});
