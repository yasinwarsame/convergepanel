/**
 * TEAM-VERIFICATION-PARITY-R4-I3 §AK — `TeamClaimComposerShell`.
 *
 * `Breadcrumb`, `WorkspaceNav`, `teamClaimDetailHref` and the rejection copy
 * are REAL. `useAuth`, `authedFetch`, the router, `useUserPlan` and
 * `ModelPicker` are controlled boundaries so the form's own contract — what it
 * blocks, what it submits once, and where it navigates — is what is tested.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className, ...rest }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className, ...rest }, children as never),
}));

const replaced: string[] = [];
const pushed: string[] = [];
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: (h: string) => replaced.push(h), push: (h: string) => pushed.push(h) }) }));

const STABLE_AUTH = { user: { uid: "uid-a" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => STABLE_AUTH }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

const STABLE_PLAN = { plan: "full", loading: false };
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => STABLE_PLAN }));

/** Records what the picker was given and lets a test drive the selection. */
const pickerProps: Record<string, unknown>[] = [];
jest.mock("@/components/ModelPicker", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    pickerProps.push(props);
    return require("react").createElement("div", { "data-testid": "model-picker" });
  },
}));

/** Mounting any Personal result renderer here is a boundary violation. */
const personalMounts: string[] = [];
jest.mock("@/components/ClaimVerificationResult", () => ({
  __esModule: true,
  default: () => {
    personalMounts.push("wrapper");
    return null;
  },
}));
jest.mock("@/components/verification/ClaimVerificationResultView", () => ({
  __esModule: true,
  default: () => {
    personalMounts.push("view");
    return null;
  },
}));

import TeamClaimComposerShell, { type TeamClaimComposerShellProps } from "@/components/workspace/claims/TeamClaimComposerShell";

const W = "ws-1";
const P = "proj-1";
const UNFILED: TeamClaimComposerShellProps = { workspaceId: W, workspaceName: "Acme Team", showAudit: true, project: null };
const FILED: TeamClaimComposerShellProps = { workspaceId: W, workspaceName: "Acme Team", showAudit: true, project: { id: P, name: "Launch Plan" } };

const okBody = (over: Record<string, unknown> = {}) => ({ ok: true, verificationId: "vcl-1", workspaceId: W, projectId: null, ...over });
const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const focused: string[] = [];
function nodeMock(element: { type: unknown }) {
  const tag = typeof element.type === "string" ? element.type : "component";
  return { focus: () => focused.push(tag), requestSubmit: () => {} };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(props: TeamClaimComposerShellProps) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(TeamClaimComposerShell, props), { createNodeMock: nodeMock });
  });
  await flush();
  return r;
}

const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
function byTestId(r: TestRenderer.ReactTestRenderer, id: string) {
  return r.root.findAll((n) => n.props?.["data-testid"] === id);
}
function nodeText(n: TestRenderer.ReactTestInstance | string): string {
  if (typeof n === "string") return n;
  return n.children.map((c) => nodeText(c as TestRenderer.ReactTestInstance | string)).join("");
}

async function typeClaim(r: TestRenderer.ReactTestRenderer, value: string) {
  const ta = byTestId(r, "team-claim-text")[0];
  await act(async () => {
    (ta.props.onChange as (e: unknown) => void)({ target: { value } });
  });
}

/** Selects models through the real picker contract. */
async function selectModels(r: TestRenderer.ReactTestRenderer, models: string[]) {
  const last = pickerProps[pickerProps.length - 1];
  await act(async () => {
    (last.onSelectionChange as (m: string[]) => void)(models);
  });
}

async function submitForm(r: TestRenderer.ReactTestRenderer) {
  const form = r.root.findAll((n) => n.type === "form")[0];
  await act(async () => {
    await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
  });
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  pickerProps.length = 0;
  personalMounts.length = 0;
  replaced.length = 0;
  pushed.length = 0;
  focused.length = 0;
});

describe("route-bound presentation", () => {
  it("Unfiled: Workspace -> Claims -> New claim, with Claims active", async () => {
    const r = await mount(UNFILED);
    const nav = r.root.findAll((n) => n.props?.["aria-label"] === "Workspace")[0];
    expect(nodeText(nav.findAll((n) => n.props?.["aria-current"] === "page")[0])).toBe("Claims");

    const bc = r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")[0];
    const lis = bc.findAll((n) => n.type === "ol")[0].findAll((n) => n.type === "li");
    expect(lis.map((li) => nodeText(li).replace(/^\//, ""))).toEqual(["Acme Team", "Claims", "New claim"]);
    expect(lis[1].findAll((n) => n.type === "a")[0].props.href).toBe("/workspace/team/ws-1/claims");
    expect(nodeText(byTestId(r, "team-claim-create-scope")[0])).toContain("Unfiled");
  });

  it("Project: Workspace -> Projects -> Project -> New claim, with Projects active", async () => {
    const r = await mount(FILED);
    const nav = r.root.findAll((n) => n.props?.["aria-label"] === "Workspace")[0];
    expect(nodeText(nav.findAll((n) => n.props?.["aria-current"] === "page")[0])).toBe("Projects");

    const bc = r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")[0];
    const lis = bc.findAll((n) => n.type === "ol")[0].findAll((n) => n.type === "li");
    expect(lis.map((li) => nodeText(li).replace(/^\//, ""))).toEqual(["Acme Team", "Projects", "Launch Plan", "New claim"]);
    expect(nodeText(byTestId(r, "team-claim-create-scope")[0])).toContain("Launch Plan");
  });

  it("renders the heading and no Project picker", async () => {
    const r = await mount(FILED);
    expect(text(r)).toContain("Verify a claim");
    expect(text(r)).not.toContain("Change project");
    expect(text(r)).not.toContain("Select a project");
    expect(r.root.findAll((n) => n.type === "select")).toHaveLength(0);
  });

  it("mounts no Claim result renderer", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    expect(personalMounts).toEqual([]);
  });
});

describe("validation", () => {
  it("blocks an empty claim before any POST", async () => {
    const r = await mount(UNFILED);
    await submitForm(r);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(nodeText(byTestId(r, "team-claim-create-error")[0])).toContain("Enter a claim");
  });

  it("blocks a whitespace-only claim", async () => {
    const r = await mount(UNFILED);
    await typeClaim(r, "     ");
    await submitForm(r);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("blocks a claim over 2000 characters before any POST", async () => {
    const r = await mount(UNFILED);
    await typeClaim(r, "x".repeat(2001));
    await submitForm(r);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(nodeText(byTestId(r, "team-claim-create-error")[0])).toContain("2000");
  });

  it("caps the textarea at 2000 and shows a live count", async () => {
    const r = await mount(UNFILED);
    expect(byTestId(r, "team-claim-text")[0].props.maxLength).toBe(2000);
    await typeClaim(r, "abc");
    expect(nodeText(byTestId(r, "team-claim-char-count")[0])).toBe("3/2000");
  });

  it("blocks fewer than two models before any POST", async () => {
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");
    await selectModels(r, ["chatgpt"]);
    await submitForm(r);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(nodeText(byTestId(r, "team-claim-create-error")[0])).toContain("at least 2");
  });

  it("trims the claim before submitting", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    const r = await mount(UNFILED);
    await typeClaim(r, "   The sky is blue.   ");
    await submitForm(r);
    expect(JSON.parse((mockedAuthedFetch.mock.calls[0][1] as { body: string }).body).claim).toBe("The sky is blue.");
  });

  it("reuses ModelPicker with a plan-derived default selection", async () => {
    const r = await mount(UNFILED);
    expect(byTestId(r, "model-picker")).toHaveLength(1);
    const last = pickerProps[pickerProps.length - 1];
    expect((last.selectedModels as string[]).length).toBeGreaterThanOrEqual(2);
    expect(last.plan).toBe("full");
  });
});

describe("submission", () => {
  it("shows a submitting status and disables the controls", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");

    const form = r.root.findAll((n) => n.type === "form")[0];
    let pending!: Promise<void>;
    await act(async () => {
      pending = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    });

    expect(byTestId(r, "team-claim-submit")[0].props.disabled).toBe(true);
    expect(byTestId(r, "team-claim-text")[0].props.disabled).toBe(true);
    expect(text(r)).toContain("Verifying…");
    expect(byTestId(r, "team-claim-submitting")[0].props.role).toBe("status");

    await act(async () => {
      slow.resolve(response(200, okBody()));
      await pending;
    });
  });

  it("issues exactly ONE POST for a double submission", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");

    const form = r.root.findAll((n) => n.type === "form")[0];
    let a!: Promise<void>;
    let b!: Promise<void>;
    await act(async () => {
      a = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
      b = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve(response(200, okBody()));
      await Promise.all([a, b]);
    });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("Cmd/Ctrl+Enter goes through the same form submit path", async () => {
    const r = await mount(UNFILED);
    const ta = byTestId(r, "team-claim-text")[0];
    let requested = 0;
    await act(async () => {
      (ta.props.onKeyDown as (e: unknown) => void)({
        metaKey: true,
        key: "Enter",
        preventDefault: () => {},
        currentTarget: { form: { requestSubmit: () => { requested += 1; } } },
      });
    });
    expect(requested).toBe(1);
  });
});

describe("navigation on success", () => {
  it("REPLACES history with the canonical Unfiled detail address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    expect(replaced).toEqual(["/workspace/team/ws-1/claims/vcl-1"]);
    expect(pushed).toEqual([]);
  });

  it("REPLACES history with the canonical Project detail address", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: P })));
    const r = await mount(FILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    expect(replaced).toEqual(["/workspace/team/ws-1/projects/proj-1/claims/vcl-1"]);
    expect(pushed).toEqual([]);
  });

  it("does not navigate when the composer unmounted before the response", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");

    const form = r.root.findAll((n) => n.type === "form")[0];
    let pending!: Promise<void>;
    await act(async () => {
      pending = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    });
    await act(async () => {
      r.unmount();
    });
    await act(async () => {
      slow.resolve(response(200, okBody()));
      await pending;
    });
    expect(replaced).toEqual([]);
  });

  it("does not navigate when the route context changed mid-flight", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");

    const form = r.root.findAll((n) => n.type === "form")[0];
    let pending!: Promise<void>;
    await act(async () => {
      pending = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    });
    // The same client instance now composes against a different Project.
    await act(async () => {
      r.update(createElement(TeamClaimComposerShell, FILED));
    });
    await act(async () => {
      slow.resolve(response(200, okBody()));
      await pending;
    });
    expect(replaced).toEqual([]);
  });
});

describe("failure presentation", () => {
  it("shows a definite rejection as an alert and does not navigate", async () => {
    mockedAuthedFetch.mockResolvedValue(response(400, { ok: false, errorCode: "invalid_claim" }));
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    expect(byTestId(r, "team-claim-create-error")[0].props.role).toBe("alert");
    expect(replaced).toEqual([]);
  });

  it("collapses Workspace/Project drift without revealing what exists", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false, errorCode: "project_not_found" }));
    const r = await mount(FILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    expect(nodeText(byTestId(r, "team-claim-create-error")[0])).toBe("This Workspace or Project is no longer available for claim creation.");
  });

  it.each([
    ["a transport failure", null],
    ["HTTP 500", 500],
  ])("shows the check-before-retry copy for %s", async (_l, status) => {
    if (status === null) mockedAuthedFetch.mockRejectedValue(new Error("network"));
    else mockedAuthedFetch.mockResolvedValue(response(status as number, {}));
    const r = await mount(UNFILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);

    const box = byTestId(r, "team-claim-create-unknown")[0];
    expect(box.props.role).toBe("alert");
    expect(nodeText(box)).toContain("couldn't confirm whether the claim was created");
    expect(nodeText(box)).toContain("Check Claims before trying again");
    // Never phrased as a definite failure, and never auto-resubmitted.
    expect(nodeText(box)).not.toContain("failed");
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    expect(replaced).toEqual([]);
  });

  it("points the unknown-outcome check link at the right parent", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, {}));
    const rU = await mount(UNFILED);
    await typeClaim(rU, "The sky is blue.");
    await submitForm(rU);
    expect(byTestId(rU, "team-claim-create-unknown")[0].findAll((n) => n.type === "a")[0].props.href).toBe("/workspace/team/ws-1/claims");

    const rP = await mount(FILED);
    await typeClaim(rP, "The sky is blue.");
    await submitForm(rP);
    expect(byTestId(rP, "team-claim-create-unknown")[0].findAll((n) => n.type === "a")[0].props.href).toBe("/workspace/team/ws-1/projects/proj-1");
  });

  it("reports a containment mismatch as unknown rather than navigating elsewhere", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: "proj-other" })));
    const r = await mount(FILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    expect(byTestId(r, "team-claim-create-unknown")).toHaveLength(1);
    expect(replaced).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("moves focus to the error once", async () => {
    const r = await mount(UNFILED);
    await submitForm(r);
    expect(focused.filter((f) => f === "p")).toHaveLength(1);
  });
});
