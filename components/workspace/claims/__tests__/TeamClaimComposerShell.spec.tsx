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

describe("R4-I4 origin-linked mode", () => {
  const ORIGIN = { runId: "run-9", claimId: "v1:key_findings:0:abc" };
  const ORIGIN_PROPS = { ...UNFILED, originTarget: ORIGIN };

  it("renders the research heading and read-only explanation", async () => {
    const r = await mount(ORIGIN_PROPS as never);
    expect(text(r)).toContain("Verify a research claim");
    expect(nodeText(byTestId(r, "team-claim-create-scope")[0])).toContain("exactly as it appears in the saved research");
  });

  it("breadcrumbs Workspace -> Claims -> Verify research claim, with Claims active", async () => {
    const r = await mount(ORIGIN_PROPS as never);
    const bc = r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")[0];
    const lis = bc.findAll((n) => n.type === "ol")[0].findAll((n) => n.type === "li");
    expect(lis.map((li) => nodeText(li).replace(/^\//, ""))).toEqual(["Acme Team", "Claims", "Verify research claim"]);
    const nav = r.root.findAll((n) => n.props?.["aria-label"] === "Workspace")[0];
    expect(nodeText(nav.findAll((n) => n.props?.["aria-current"] === "page")[0])).toBe("Claims");
  });

  it("uses the Claims breadcrumb even when mounted with a Project prop", async () => {
    const r = await mount({ ...FILED, originTarget: ORIGIN } as never);
    const bc = r.root.findAll((n) => n.props?.["aria-label"] === "Breadcrumb")[0];
    const lis = bc.findAll((n) => n.type === "ol")[0].findAll((n) => n.type === "li");
    expect(lis.map((li) => nodeText(li).replace(/^\//, ""))).toEqual(["Acme Team", "Claims", "Verify research claim"]);
  });

  it("renders NO claim textarea, counter, picker or raw locator ids", async () => {
    const r = await mount(ORIGIN_PROPS as never);
    expect(byTestId(r, "team-claim-text")).toHaveLength(0);
    expect(byTestId(r, "team-claim-char-count")).toHaveLength(0);
    expect(r.root.findAll((n) => n.type === "textarea")).toHaveLength(0);
    const rendered = text(r);
    expect(rendered).not.toContain(ORIGIN.runId);
    expect(rendered).not.toContain(ORIGIN.claimId);
  });

  it("still reuses the real ModelPicker and blocks fewer than two models", async () => {
    const r = await mount(ORIGIN_PROPS as never);
    expect(byTestId(r, "model-picker")).toHaveLength(1);
    await selectModels(r, ["chatgpt"]);
    await submitForm(r);
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(nodeText(byTestId(r, "team-claim-create-error")[0])).toContain("at least 2");
  });

  it("submits the origin-linked body with no claim text", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    const r = await mount(ORIGIN_PROPS as never);
    await submitForm(r);
    const body = JSON.parse((mockedAuthedFetch.mock.calls[0][1] as { body: string }).body);
    expect(Object.keys(body).sort()).toEqual(["claimId", "models", "runId"]);
    expect(body.runId).toBe(ORIGIN.runId);
  });

  it("navigates to the Unfiled detail when the server resolves no Project", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: null })));
    const r = await mount(ORIGIN_PROPS as never);
    await submitForm(r);
    expect(replaced).toEqual(["/workspace/team/ws-1/claims/vcl-1"]);
    expect(pushed).toEqual([]);
  });

  it("honours a SERVER-resolved Project the composer never knew about", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody({ projectId: "proj-moved" })));
    const r = await mount(ORIGIN_PROPS as never);
    await submitForm(r);
    expect(replaced).toEqual(["/workspace/team/ws-1/projects/proj-moved/claims/vcl-1"]);
  });

  it("shows the safe origin_not_eligible copy", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false, errorCode: "origin_not_eligible" }));
    const r = await mount(ORIGIN_PROPS as never);
    await submitForm(r);
    const err = byTestId(r, "team-claim-create-error")[0];
    expect(err.props.role).toBe("alert");
    expect(nodeText(err)).toBe("This research finding is no longer available for verification. Return to the research and choose a current finding.");
  });

  it("points an unconfirmed outcome at the Workspace Claims list, never a guessed Project", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, {}));
    const r = await mount({ ...FILED, originTarget: ORIGIN } as never);
    await submitForm(r);
    const box = byTestId(r, "team-claim-create-unknown")[0];
    expect(nodeText(box)).toContain("Check Claims before trying again");
    expect(box.findAll((n) => n.type === "a")[0].props.href).toBe("/workspace/team/ws-1/claims");
  });

  it("does not navigate when the composer unmounted before the response", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount(ORIGIN_PROPS as never);
    const form = r.root.findAll((n) => n.type === "form")[0];
    let pending!: Promise<void>;
    await act(async () => {
      pending = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    });
    await act(async () => { r.unmount(); });
    await act(async () => { slow.resolve(response(200, okBody())); await pending; });
    expect(replaced).toEqual([]);
  });

  it("does not navigate when the origin target changed mid-flight", async () => {
    const slow = deferred<unknown>();
    mockedAuthedFetch.mockReturnValueOnce(slow.promise);
    const r = await mount(ORIGIN_PROPS as never);
    const form = r.root.findAll((n) => n.type === "form")[0];
    let pending!: Promise<void>;
    await act(async () => {
      pending = (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    });
    // Same component instance now composes a DIFFERENT finding.
    await act(async () => {
      r.update(createElement(TeamClaimComposerShell, { ...UNFILED, originTarget: { runId: "run-9", claimId: "v1:key_findings:1:zzz" } } as never));
    });
    await act(async () => { slow.resolve(response(200, okBody())); await pending; });
    expect(replaced).toEqual([]);
  });

  it("leaves ordinary mode untouched when originTarget is null", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okBody()));
    const r = await mount({ ...UNFILED, originTarget: null } as never);
    expect(byTestId(r, "team-claim-text")).toHaveLength(1);
    expect(text(r)).toContain("Verify a claim");
    expect(text(r)).not.toContain("Verify a research claim");
  });
});

/**
 * TEAM-VERIFICATION-PARITY-R5-I4 — the Team Claim concealment invariant.
 *
 * THE PROPERTY, and why it needed its own block. The Claim route refuses to
 * tell an unauthorized caller whether a Workspace or Project exists: no
 * membership, membership removed, rollout not admitted, capability missing,
 * Project absent and Project archived all collapse to ONE sentence. The mapper
 * does collapse them — but nothing asserted that the four branches return the
 * SAME string, and the mapper ends in `default:`, so unlike the Video mapper
 * there is not even exhaustiveness to make the branches look covered.
 *
 * Proven before this block existed: giving `project_archived`,
 * `team_workspace_not_found` or `insufficient_capability` its own
 * existence-revealing sentence broke **zero** of 502 Team Claim tests. Only
 * `project_not_found` was pinned, by a single end-to-end case. Three of the
 * four members of a security class were unguarded.
 *
 * HOW THIS AVOIDS VALIDATING AGAINST A COPY OF ITSELF. The class below is a
 * frozen literal, so it cannot shrink under the mutation it must catch. A
 * frozen list can be hand-trimmed instead, so it is checked in the opposite
 * direction against what the SERVER conceals — derived from the denial helpers
 * the Claim route imports from the Project/Team authorization modules, not
 * from this file and not from the mapper. Trim the list and the server set no
 * longer matches; add a concealing helper and it no longer matches either.
 */
describe("the Team Claim concealment class renders indistinguishably", () => {
  /**
   * Each entry is a denial the server answers without disclosing whether the
   * resource exists, with the status the route actually returns — the status
   * matters, because the hook classifies >= 500 as `outcome_unknown` and a
   * mis-stated status would test a different path than the real one.
   */
  const CONCEALED: [code: string, status: number][] = [
    ["team_workspace_not_found", 404],
    ["insufficient_capability", 403],
    ["project_not_found", 404],
    ["project_archived", 409],
  ];

  async function copyFor(code: string, status: number): Promise<string> {
    mockedAuthedFetch.mockResolvedValue(response(status, { ok: false, errorCode: code }));
    const r = await mount(FILED);
    await typeClaim(r, "The sky is blue.");
    await submitForm(r);
    const box = byTestId(r, "team-claim-create-error");
    expect(box).toHaveLength(1);
    return nodeText(box[0]);
  }

  it("every concealed denial produces byte-identical copy", async () => {
    const rendered: string[] = [];
    for (const [code, status] of CONCEALED) rendered.push(await copyFor(code, status));
    // The canonical answer is taken from a member of the class rather than
    // re-typed here, so a legitimate reword stays green while the moment the
    // members disagree with each other this fails.
    const canonical = rendered[0];
    expect(new Set(rendered).size).toBe(1);
    for (const [i, copy] of rendered.entries()) {
      expect(`${CONCEALED[i][0]} => ${copy}`).toBe(`${CONCEALED[i][0]} => ${canonical}`);
    }
  });

  it("the canonical answer is a real sentence, not an empty string", async () => {
    // Positive control: a mapper returning "" for everything would otherwise
    // satisfy the equality assertion above.
    const canonical = await copyFor("insufficient_capability", 403);
    expect(canonical.trim().length).toBeGreaterThan(20);
    expect(canonical.trim().endsWith(".")).toBe(true);
  });

  it.each(CONCEALED)("%s discloses no resource state", async (code, status) => {
    const copy = (await copyFor(code, status)).toLowerCase();
    // Scoped to the concealment class ONLY — other arms legitimately say
    // "claim", "plan" or "models", because those are the caller's own.
    for (const leak of [
      "archiv",
      "does not exist",
      "could not be found",
      "no longer a member",
      "removed from",
      "permission to",
      "capabilit",
      "research.create",
      "research.organize",
      "not admitted",
      "rollout",
    ]) {
      expect(copy).not.toContain(leak);
    }
  });
});

/**
 * COMPLETENESS — the other half, derived from the server rather than the table.
 */
describe("the Team Claim concealment class matches what the SERVER conceals", () => {
  const { importMap, helperBody, emissions } =
    require("@/lib/workspaces/__tests__/teamVideoRouteContract") as typeof import("@/lib/workspaces/__tests__/teamVideoRouteContract");
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");

  const CLAIM_ROUTE = "app/api/workspaces/[workspaceId]/verifications/route.ts";
  const routeSrc = readFileSync(join(process.cwd(), CLAIM_ROUTE), "utf8");

  /**
   * The rule, stated as the route's own posture: a denial helper imported from
   * the Project / Team-Project authorization modules answers an authorization
   * question without disclosing existence, so everything it emits belongs to
   * the concealment class. Helpers from `teamWorkspaceErrorResponse` are NOT
   * concealed — `invalid_request_body` and `unexpected_field` describe the
   * caller's own request and are safe to name.
   */
  const CONCEALING_MODULES = ["lib/projects/teamProjectErrorResponse.ts", "lib/projects/projectErrorResponse.ts"];

  function serverConcealedCodes(): string[] {
    const imports = importMap(routeSrc);
    const out: string[] = [];
    for (const [symbol, module] of imports) {
      if (!CONCEALING_MODULES.includes(module)) continue;
      if (!/Response$/.test(symbol)) continue;
      if (!new RegExp(`\\b${symbol}\\s*\\(`).test(routeSrc)) continue; // imported AND called
      const body = helperBody(symbol, routeSrc);
      expect(body).not.toBeNull();
      for (const e of emissions(body!)) out.push(e.code);
    }
    return [...new Set(out)].sort();
  }

  it("reads real, route-imported concealing helpers", () => {
    // Positive control: a failed resolution would make the comparison below
    // pass against an empty set.
    const imports = importMap(routeSrc);
    expect(imports.get("teamProjectAuthorizationDeniedResponse")).toBe("lib/projects/teamProjectErrorResponse.ts");
    expect(imports.get("runProjectAssociationTargetNotFoundResponse")).toBe("lib/projects/projectErrorResponse.ts");
    expect(imports.get("projectArchivedTargetResponse")).toBe("lib/projects/projectErrorResponse.ts");
    expect(serverConcealedCodes().length).toBeGreaterThan(3);
  });

  it("every code the server conceals is in the class, and nothing else is", () => {
    expect(serverConcealedCodes()).toEqual(
      ["team_workspace_not_found", "insufficient_capability", "project_not_found", "project_archived"].sort()
    );
  });
});
