/**
 * PERSONAL-RESEARCH-URL-1 §BA — `PersonalResearchDetailShell` behaviour against a
 * real rendered tree.
 *
 * The shell's job is load arbitration and honest state selection, so that is what
 * is real here: the component, its generation guard, its ownership checks and its
 * branch selection all execute. `authedFetch` and `useAuth` are controlled
 * boundaries, and `ResultsDisplay` is stubbed — it has its own suites, it is heavy
 * to mount, and what matters here is WHICH state the shell chooses and WHAT it
 * hands down, not how the report paints.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: Record<string, unknown>) =>
    require("react").createElement("a", { href, className }, children as React.ReactNode);
  return { __esModule: true, default: MockLink };
});

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a),
}));

jest.mock("@/components/ResultsDisplay", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) =>
    require("react").createElement("div", {
      "data-testid": "results-display",
      "data-run-id": String(props.runId ?? ""),
      "data-read-only": String(props.readOnlyActions ?? ""),
      "data-adaptive": props.adaptive ? "yes" : "no",
      "data-results": String(Array.isArray(props.results) ? props.results.length : 0),
    }),
}));

import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";

const UID_A = "uid_alice";
const UID_B = "uid_bob";

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const okRun = (over: Record<string, unknown> = {}) => ({
  ok: true,
  runId: "run-7",
  question: "What changed in the source evidence?",
  status: "complete",
  viewerRole: "owner",
  results: [{ modelId: "chatgpt", status: "ok", rawText: "answer" }],
  adaptive: { status: "absent", output: null },
  legacyAdaptive: { status: "absent", output: null },
  ...over,
});

function mount(runId = "run-7") {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(PersonalResearchDetailShell, { runId }));
  });
  return {
    renderer,
    rerenderWith: (nextRunId: string) =>
      act(() => { renderer.update(createElement(PersonalResearchDetailShell, { runId: nextRunId })); }),
  };
}

const textOf = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const report = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.props?.["data-testid"] === "results-display");

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: UID_A }, authReady: true });
});

describe("PersonalResearchDetailShell — cold load", () => {
  it("T1/T2/T3 — an owner's report loads from the runId alone, with no dependency on prior page state", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer } = mount("run-7");
    await act(async () => {});
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe("/api/user/runs/run-7");
    expect(report(renderer)).toHaveLength(1);
    expect(report(renderer)[0].props["data-run-id"]).toBe("run-7");
    expect(textOf(renderer)).toContain("What changed in the source evidence?");
  });

  it("percent-encodes the runId into the request path", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ runId: "a/b" })));
    mount("a/b");
    await act(async () => {});
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe("/api/user/runs/a%2Fb");
  });

  it("shows a loading state before the read settles, and never an error", async () => {
    mockedAuthedFetch.mockReturnValue(deferred<never>().promise);
    const { renderer } = mount();
    expect(textOf(renderer)).toContain("Loading this research report");
    expect(textOf(renderer)).not.toMatch(/isn&#x27;t available|couldn&#x27;t load/);
  });

  it("§X — always offers Back to Research", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer } = mount();
    await act(async () => {});
    const back = renderer.root.findAllByType("a").filter((a) => String(a.props.href) === "/");
    expect(back.length).toBeGreaterThan(0);
  });
});

describe("PersonalResearchDetailShell — concealment and honesty", () => {
  it("T4/T7 — 403 and 404 render the SAME unavailable treatment, so ownership and existence are indistinguishable", async () => {
    const bodies: string[] = [];
    for (const status of [403, 404]) {
      jest.clearAllMocks();
      mockedUseAuth.mockReturnValue({ user: { uid: UID_A }, authReady: true });
      mockedAuthedFetch.mockResolvedValue(response(status, { ok: false, errorCode: status === 403 ? "forbidden" : "not_found" }));
      const { renderer } = mount();
      await act(async () => {});
      bodies.push(textOf(renderer));
      expect(textOf(renderer)).toContain("isn");
      expect(report(renderer)).toHaveLength(0);
    }
    expect(bodies[0]).toBe(bodies[1]);
    // and neither leaks the distinguishing error code
    expect(bodies[0]).not.toContain("forbidden");
    expect(bodies[0]).not.toContain("not_found");
  });

  it("T8 — the P0 500 renders an honest RETRYABLE state, never 'deleted/not found'", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, { ok: false, errorCode: "internal_error" }));
    const { renderer } = mount();
    await act(async () => {});
    const body = textOf(renderer);
    expect(body).toContain("couldn");
    expect(body).toContain("hasn");          // "your research hasn't gone anywhere"
    expect(body).toContain("Try again");
    expect(body).not.toContain("may have been deleted");
  });

  it("a transport failure is also retryable, not an absence claim", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const { renderer } = mount();
    await act(async () => {});
    expect(textOf(renderer)).toContain("Try again");
    expect(textOf(renderer)).not.toContain("network down");
  });

  it("§W — Retry repeats the READ only, never a model panel", async () => {
    mockedAuthedFetch.mockResolvedValue(response(500, { ok: false, errorCode: "internal_error" }));
    const { renderer } = mount();
    await act(async () => {});
    const before = mockedAuthedFetch.mock.calls.length;
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const retry = renderer.root.findAllByType("button").find((b) => JSON.stringify(b.props.children).includes("Try again"))!;
    await act(async () => { retry.props.onClick(); });
    await act(async () => {});
    expect(mockedAuthedFetch.mock.calls.length).toBe(before + 1);
    for (const call of mockedAuthedFetch.mock.calls) {
      expect(String(call[0])).not.toContain("/api/run-panel");
      expect(String(call[0])).toContain("/api/user/runs/");
    }
    expect(report(renderer)).toHaveLength(1);
  });
});

describe("PersonalResearchDetailShell — artifact and tenancy containment", () => {
  it("T5 — a TEAM viewer role is refused on the Personal address, even though the shared API authorized it", async () => {
    for (const role of ["team_member", "team_reviewer"]) {
      jest.clearAllMocks();
      mockedUseAuth.mockReturnValue({ user: { uid: UID_A }, authReady: true });
      mockedAuthedFetch.mockResolvedValue(response(200, okRun({ viewerRole: role })));
      const { renderer } = mount();
      await act(async () => {});
      expect(report(renderer)).toHaveLength(0);
      expect(textOf(renderer)).toContain("isn");
    }
  });

  it("accepts exactly the Personal roles", async () => {
    for (const role of ["owner", "personal_reviewer"]) {
      jest.clearAllMocks();
      mockedUseAuth.mockReturnValue({ user: { uid: UID_A }, authReady: true });
      mockedAuthedFetch.mockResolvedValue(response(200, okRun({ viewerRole: role })));
      const { renderer } = mount();
      await act(async () => {});
      expect(report(renderer)).toHaveLength(1);
    }
  });

  it("T22/T23 — a Claim/Video verification id is concealed: it is not in `runs`, and no fallback collection is ever tried", async () => {
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false, errorCode: "not_found" }));
    const { renderer } = mount("verification-abc");
    await act(async () => {});
    expect(report(renderer)).toHaveLength(0);
    for (const call of mockedAuthedFetch.mock.calls) {
      expect(String(call[0])).not.toContain("verifications");
      expect(String(call[0])).not.toContain("videoVerifications");
    }
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("§L — a response describing a DIFFERENT run is malformed, never rendered as the requested one", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ runId: "some-other-run" })));
    const { renderer } = mount("run-7");
    await act(async () => {});
    expect(report(renderer)).toHaveLength(0);
    expect(textOf(renderer)).toContain("couldn");
  });
});

describe("PersonalResearchDetailShell — persisted result restoration", () => {
  it("T9 — a valid adaptive envelope restores through the adaptive path", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({
      adaptive: { status: "valid", output: { schemaId: "decision_support", classification: {}, result: {} } },
    })));
    const { renderer } = mount();
    await act(async () => {});
    expect(report(renderer)[0].props["data-adaptive"]).toBe("yes");
  });

  it("T10 — legacy-adaptive restores even though `adaptive.status === \"absent\"`, which is also correct for every procedural run", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({
      adaptive: { status: "absent", output: null },
      legacyAdaptive: { status: "valid", output: { schemaId: "procedural", result: { steps: [] } } },
    })));
    const { renderer } = mount();
    await act(async () => {});
    expect(report(renderer)[0].props["data-adaptive"]).toBe("yes");
  });

  it("T11 — both envelopes genuinely absent falls back to the persisted model results", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer } = mount();
    await act(async () => {});
    expect(report(renderer)[0].props["data-adaptive"]).toBe("no");
    expect(report(renderer)[0].props["data-results"]).toBe("1");
  });

  it("§S — a malformed envelope shows a non-destructive notice and still presents the raw responses", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ adaptive: { status: "malformed", output: null } })));
    const { renderer } = mount();
    await act(async () => {});
    expect(textOf(renderer)).toContain("couldn");
    expect(report(renderer)).toHaveLength(1);
  });

  it("§U — a COMPLETED run with no structured result and no rows is an honest malformed state, not 'you haven't run this yet'", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ results: [] })));
    const { renderer } = mount();
    await act(async () => {});
    expect(report(renderer)).toHaveLength(0);
    expect(textOf(renderer)).not.toContain("No panel results yet");
    expect(textOf(renderer)).toContain("couldn");
  });

  it("§AO — the report renders in read-only action mode, so no execution affordance promises a re-run it cannot perform", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun()));
    const { renderer } = mount();
    await act(async () => {});
    expect(report(renderer)[0].props["data-read-only"]).toBe("true");
  });
});

describe("PersonalResearchDetailShell — run status honesty", () => {
  it("T12 — queued/running shows a stable in-progress state and starts nothing", async () => {
    for (const status of ["queued", "running"]) {
      jest.clearAllMocks();
      mockedUseAuth.mockReturnValue({ user: { uid: UID_A }, authReady: true });
      mockedAuthedFetch.mockResolvedValue(response(200, okRun({ status, results: [] })));
      const { renderer } = mount();
      await act(async () => {});
      expect(textOf(renderer)).toContain("still in progress");
      expect(report(renderer)).toHaveLength(0);
      for (const call of mockedAuthedFetch.mock.calls) expect(String(call[0])).not.toContain("/api/run-panel");
    }
  });

  it("T13 — a failed saved run says so, and is neither re-executed nor reported as missing", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ status: "error", results: [] })));
    const { renderer } = mount();
    await act(async () => {});
    expect(textOf(renderer)).toContain("didn");
    expect(textOf(renderer)).not.toContain("may have been deleted");
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("PersonalResearchDetailShell — ownership", () => {
  it("T16 — a slow run A response can never paint over run B", async () => {
    const a = deferred<ReturnType<typeof response>>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise);
    const h = mount("run-A");

    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ runId: "run-B", question: "B question" })));
    h.rerenderWith("run-B");
    await act(async () => {});
    expect(report(h.renderer)[0].props["data-run-id"]).toBe("run-B");

    await act(async () => {
      a.resolve(response(200, okRun({ runId: "run-A", question: "A question" })));
      await a.promise;
    });
    expect(report(h.renderer)[0].props["data-run-id"]).toBe("run-B");
    expect(textOf(h.renderer)).toContain("B question");
    expect(textOf(h.renderer)).not.toContain("A question");
  });

  it("a stale A FAILURE cannot clear B's successful report", async () => {
    const a = deferred<ReturnType<typeof response>>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise);
    const h = mount("run-A");
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ runId: "run-B" })));
    h.rerenderWith("run-B");
    await act(async () => {});

    await act(async () => {
      a.reject(new Error("A failed late"));
      await a.promise.catch(() => {});
    });
    expect(report(h.renderer)).toHaveLength(1);
    expect(report(h.renderer)[0].props["data-run-id"]).toBe("run-B");
    expect(textOf(h.renderer)).not.toContain("Try again");
  });

  it("T17a — a uid change clears the previous identity's report BEFORE the new read resolves (not merely because the new read happens to fail)", async () => {
    mockedAuthedFetch.mockResolvedValue(response(200, okRun({ question: "ALICE PRIVATE QUESTION" })));
    const h = mount("run-7");
    await act(async () => {});
    expect(textOf(h.renderer)).toContain("ALICE PRIVATE QUESTION");

    // Bob's read never settles: nothing but the synchronous pre-await clear can
    // remove Alice's report from the screen.
    mockedUseAuth.mockReturnValue({ user: { uid: UID_B }, authReady: true });
    mockedAuthedFetch.mockReturnValue(deferred<never>().promise);
    h.rerenderWith("run-7");

    expect(textOf(h.renderer)).not.toContain("ALICE PRIVATE QUESTION");
    expect(report(h.renderer)).toHaveLength(0);
    expect(textOf(h.renderer)).toContain("Loading this research report");
  });

  it("T17 — a uid change clears the previous identity's report immediately and never resurrects it", async () => {
    const a = deferred<ReturnType<typeof response>>();
    mockedAuthedFetch.mockReturnValueOnce(a.promise);
    const h = mount("run-7");

    mockedUseAuth.mockReturnValue({ user: { uid: UID_B }, authReady: true });
    mockedAuthedFetch.mockResolvedValue(response(404, { ok: false, errorCode: "not_found" }));
    h.rerenderWith("run-7");
    await act(async () => {});
    expect(report(h.renderer)).toHaveLength(0);

    await act(async () => {
      a.resolve(response(200, okRun({ question: "ALICE PRIVATE QUESTION" })));
      await a.promise;
    });
    expect(textOf(h.renderer)).not.toContain("ALICE PRIVATE QUESTION");
    expect(report(h.renderer)).toHaveLength(0);
  });

  it("§J — the in-flight request is aborted on runId change and on unmount", async () => {
    mockedAuthedFetch.mockReturnValue(deferred<never>().promise);
    const h = mount("run-A");
    // the shell dynamically imports authedFetch, so the call lands a microtask later
    await act(async () => {});
    const firstSignal = mockedAuthedFetch.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    h.rerenderWith("run-B");
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {});
    const secondSignal = mockedAuthedFetch.mock.calls[1][1].signal as AbortSignal;
    act(() => { h.renderer.unmount(); });
    expect(secondSignal.aborted).toBe(true);
  });

  it("waits for auth readiness rather than claiming the run is unavailable", async () => {
    mockedUseAuth.mockReturnValue({ user: null, authReady: false });
    const { renderer } = mount();
    await act(async () => {});
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain("Loading this research report");
  });
});
