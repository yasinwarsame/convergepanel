/**
 * PERSONAL-RESEARCH-URL-1 §AG / §L–§S, and C1 §E–§I / §V — CANONICAL NAVIGATION
 * OWNERSHIP AND INTENT SETTLEMENT.
 *
 * THE DEFECT THIS EXISTS FOR. Before URL-1, a late `handleRunPanel` completion
 * only wrote state; if the user had moved on, those writes landed in a dead tree
 * and were harmless, which is why the shipped comment said the run "needs no
 * isCurrent check of its own". Adding a canonical `router.replace()` on completion
 * changes the stakes: a stale completion no longer loses a write race, it drags the
 * browser to its own report. Option C was approved — ONE generation domain for
 * "latest intent", plus a mount ref for "does the originating page still exist",
 * because controls that navigate away from `/` (TopNav, WorkspaceSwitcher, browser
 * back) cannot reach this component's private guard.
 *
 * C1 ADDS TWO THINGS THE REVIEWED HEAD GOT WRONG:
 *   - invalidating a pending run on tab-leave left `runStatus === "running"`, and
 *     `panelBusy` derives from it, so the abandoned run — no longer ALLOWED to
 *     settle state — left the composer permanently busy on return (§E/§F);
 *   - the four visible tabs were not the only ways intent changes. The `?tab=`
 *     query flows, the verification/video deep links, the origin-linked verify
 *     click and the follow-up pre-fill all change intent too (§G–§I).
 *   - and the canonical redirect sat AFTER `await refreshUsage()`, leaving a window
 *     in which the finished report was interactive but the address had not moved
 *     yet (§V).
 *
 * WHAT IS REAL vs TRANSCRIBED (same constraint and convention as
 * `personalResearchHistoryLoadRace.spec.tsx` — mounting the real `app/page.tsx`
 * OOMs ts-jest's whole-program check here):
 *   - `createGenerationGuard` is the REAL shipped primitive.
 *   - `personalResearchHref` / `isCanonicalPersonalRunId` /
 *     `personalResearchVerifyClaimHref` are the REAL builders.
 *   - the handlers below are STRUCTURALLY VERBATIM transcriptions of the shipped
 *     control flow (same claim points, same ownership predicate, same early
 *     returns, same redirect placement relative to the awaits).
 *   - `personalResearchCanonicalNavigationStructure` assertions at the bottom pin
 *     each transcribed rule to the real `app/page.tsx`, so the transcription
 *     cannot silently drift from the shipped code.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import {
  personalResearchHref,
  isCanonicalPersonalRunId,
  personalResearchVerifyClaimHref,
} from "@/lib/user/personalResearchHref";

const PAGE_SOURCE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Router spy standing in for Next's `useRouter()`. */
function createRouter() {
  const calls: { method: "push" | "replace"; href: string }[] = [];
  return {
    calls,
    push: (href: string) => calls.push({ method: "push", href }),
    replace: (href: string) => calls.push({ method: "replace", href }),
    replaced: () => calls.filter((c) => c.method === "replace").map((c) => c.href),
    pushed: () => calls.filter((c) => c.method === "push").map((c) => c.href),
  };
}

type RunFetch = () => Promise<{ ok: boolean; runId?: string; results?: string[] }>;

/**
 * Verbatim transcription of the shipped Home ownership contract.
 * One guard instance + one mount ref, exactly as `app/page.tsx` creates them.
 */
function createHome() {
  const guard = createGenerationGuard();
  const router = createRouter();
  const state = {
    panelTab: "research" as "research" | "verify" | "video" | "history",
    results: [] as string[],
    runStatus: "idle" as "idle" | "running" | "complete" | "error",
    modelStatuses: {} as Record<string, string>,
    error: null as string | null,
    question: "",
    claimInput: "",
    originLinkedTarget: null as { runId: string; claimId: string } | null,
    verificationPayload: null as unknown,
    videoVerificationPayload: null as unknown,
  };
  const mounted = { current: false };

  // mount effect
  mounted.current = true;
  const unmount = () => {
    mounted.current = false;
    guard.next(); // leaving is newer intent
  };

  const invalidateResearchIntent = () => { guard.next(); };

  /** C1 §E — newer intent, plus release of the abandoned LOCAL execution. */
  const supersedeRunningResearch = () => {
    invalidateResearchIntent();
    if (state.runStatus !== "running") return;
    state.runStatus = "idle";
    state.modelStatuses = {};
  };

  const selectPanelTab = (nextTab: typeof state.panelTab) => {
    if (nextTab !== "research") supersedeRunningResearch();
    state.panelTab = nextTab;
  };

  /** §AF — transcribed `handleRunPanel`, awaits and ownership checks in shipped order. */
  const handleRunPanel = async (
    runFetch: RunFetch,
    refreshUsage: () => Promise<void> = async () => {}
  ) => {
    const runGeneration = guard.next();
    const stillOwnsResearchIntent = () => mounted.current && guard.isCurrent(runGeneration);
    state.runStatus = "running";
    state.modelStatuses = { chatgpt: "queued" };

    let data: { ok: boolean; runId?: string; results?: string[] };
    try {
      data = await runFetch();
    } catch {
      // §D/§R — a stale FAILURE must not clobber the newer surface either.
      if (!stillOwnsResearchIntent()) return;
      state.error = "Network error. Please check your connection and try again.";
      state.runStatus = "error";
      return;
    }

    // §D — THE post-await boundary: everything below belongs to this execution.
    if (!stillOwnsResearchIntent()) return;

    if (!data.ok) {
      state.error = "Run failed.";
      state.runStatus = "error";
      return;
    }
    state.results = data.results ?? [];
    state.runStatus = "complete";

    /**
     * C1 §V — the navigation is ATOMIC with completion: no await stands between
     * the ownership check and the address change. Usage bookkeeping moves below.
     */
    if (isCanonicalPersonalRunId(data.runId) && stillOwnsResearchIntent()) {
      router.replace(personalResearchHref(data.runId!));
    }

    await refreshUsage();
  };

  /** §AD/§G — transcribed research History branch: supersede, then PUSH. */
  const openResearchHistoryItem = (runId: string) => {
    supersedeRunningResearch();
    router.push(personalResearchHref(runId));
  };

  /** §J/§AH — transcribed legacy deep-link canonicalization. */
  const canonicalizeLegacyLink = (runId: string) => {
    supersedeRunningResearch();
    router.replace(personalResearchHref(runId));
  };

  /** C1 §M — the ONE origin-linked Verify transition, shared by both entry points. */
  const enterOriginLinkedVerifyClaimMode = (target: { runId: string; claimId: string }) => {
    supersedeRunningResearch();
    state.originLinkedTarget = { runId: target.runId, claimId: target.claimId };
    state.verificationPayload = null;
    state.error = null;
    state.claimInput = "";
    state.panelTab = "verify";
  };

  /** C1 §G/§I — the `?tab=` query flow, including the origin-linked hand-off. */
  const handleTabQuery = (search: string) => {
    const params = new URLSearchParams(search);
    const tab = params.get("tab");
    if (tab === "verify") {
      const originRunId = params.get("originRunId");
      const originClaimId = params.get("originClaimId");
      if (originRunId?.trim() && originClaimId?.trim()) {
        enterOriginLinkedVerifyClaimMode({ runId: originRunId.trim(), claimId: originClaimId.trim() });
        router.replace("/");
        return;
      }
      supersedeRunningResearch();
      state.panelTab = "verify";
      const claim = params.get("claim");
      if (claim) state.claimInput = claim;
      router.replace("/");
    } else if (tab === "research") {
      supersedeRunningResearch();
      state.panelTab = "research";
      const q = params.get("q");
      if (q) state.question = q;
      router.replace("/");
    }
  };

  /** C1 §H — `?openVerification=` / `?openVideoVerification=` via openHistoryItem. */
  const openVerificationArtifact = (kind: "verification" | "video_verification") => {
    supersedeRunningResearch();
    if (kind === "video_verification") {
      state.panelTab = "video";
      state.videoVerificationPayload = { loaded: true };
    } else {
      state.panelTab = "verify";
      state.verificationPayload = { loaded: true };
    }
    router.replace("/");
  };

  /** C1 §G — the follow-up pre-fill is a newer composer intent. */
  const handleRunFollowUp = (followUpQuestion: string) => {
    supersedeRunningResearch();
    state.question = followUpQuestion;
  };

  const panelBusy = () => (state.panelTab === "research" ? state.runStatus === "running" : false);

  return {
    guard, router, state, mounted, unmount,
    invalidateResearchIntent, supersedeRunningResearch, selectPanelTab,
    handleRunPanel, openResearchHistoryItem, canonicalizeLegacyLink,
    enterOriginLinkedVerifyClaimMode, handleTabQuery, openVerificationArtifact,
    handleRunFollowUp, panelBusy,
  };
}

describe("§L — the normal path still canonicalizes", () => {
  it("a run that completes with nothing newer happening redirects exactly once", async () => {
    const h = createHome();
    await h.handleRunPanel(async () => ({ ok: true, runId: "run-A", results: ["r"] }));
    expect(h.router.replaced()).toEqual(["/workspace/research/run-A"]);
    expect(h.router.replaced()).toHaveLength(1);
    expect(h.state.runStatus).toBe("complete");
  });

  it("§AF — a missing/blank/placeholder runId never fabricates an address", async () => {
    for (const runId of [undefined, "", "   ", `r-${Date.now()}`]) {
      const h = createHome();
      await h.handleRunPanel(async () => ({ ok: true, runId: runId as string | undefined, results: ["r"] }));
      expect(h.router.calls).toHaveLength(0);
      // the run itself still completed — only the address was withheld
      expect(h.state.runStatus).toBe("complete");
    }
  });
});

describe("C1 §V — no post-success interaction window", () => {
  it("the canonical address is committed BEFORE the usage refresh settles", async () => {
    const h = createHome();
    const usage = deferred<void>();
    const running = h.handleRunPanel(
      async () => ({ ok: true, runId: "run-A", results: ["r"] }),
      () => usage.promise
    );
    // one microtask is enough for the completion turn; usage is still pending
    await Promise.resolve();
    await Promise.resolve();
    expect(h.router.replaced()).toEqual(["/workspace/research/run-A"]);

    usage.resolve();
    await running;
    expect(h.router.replaced()).toEqual(["/workspace/research/run-A"]);
  });

  it("an intent expressed while usage is still refreshing cannot undo an address already committed", async () => {
    const h = createHome();
    const usage = deferred<void>();
    const running = h.handleRunPanel(
      async () => ({ ok: true, runId: "run-A", results: ["r"] }),
      () => usage.promise
    );
    await Promise.resolve();
    await Promise.resolve();
    // the user interacts with the finished report during the usage await
    h.selectPanelTab("verify");
    usage.resolve();
    await running;
    expect(h.router.replaced()).toEqual(["/workspace/research/run-A"]);
    // and the completed report was NOT erased by the tab change
    expect(h.state.results).toEqual(["r"]);
    expect(h.state.runStatus).toBe("complete");
  });
});

describe("§M — HISTORY RACE (the exact §AG reproduction)", () => {
  it("pending run A, then History selects B: A must not redirect, and B's push wins", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.openResearchHistoryItem("run-B");
    expect(h.router.pushed()).toEqual(["/workspace/research/run-B"]);

    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;

    expect(h.router.replaced()).toEqual([]);
    expect(h.router.replaced()).not.toContain("/workspace/research/run-A");
    // and A did not reclaim the display state either
    expect(h.state.results).toEqual([]);
    // C1 §E — the abandoned execution is RELEASED, not left running forever
    expect(h.state.runStatus).toBe("idle");
  });

  it("invalidation happens BEFORE navigation, so there is no window where A still owns intent", () => {
    const h = createHome();
    const gen = h.guard.current();
    h.openResearchHistoryItem("run-B");
    expect(h.guard.current()).toBeGreaterThan(gen);
  });
});

describe("§N/§O/§P — TAB RACES (why Option A alone was insufficient)", () => {
  it.each(["verify", "video", "history"] as const)(
    "pending run A, user switches to the %s tab: A cannot redirect or overwrite that surface",
    async (tab) => {
      const h = createHome();
      const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
      const running = h.handleRunPanel(() => a.promise);

      h.selectPanelTab(tab);
      expect(h.state.panelTab).toBe(tab);

      a.resolve({ ok: true, runId: "run-A", results: ["late"] });
      await running;

      expect(h.router.calls).toHaveLength(0);
      expect(h.state.results).toEqual([]);
    }
  );

  it("re-selecting the ALREADY-ACTIVE Research tab does not invalidate a run the user is waiting for", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.selectPanelTab("research");
    expect(h.state.runStatus).toBe("running");
    a.resolve({ ok: true, runId: "run-A", results: ["r"] });
    await running;

    expect(h.router.replaced()).toEqual(["/workspace/research/run-A"]);
  });
});

/**
 * C1 §F — THE SAME-PAGE TAB RETURN REGRESSION.
 *
 * A1 took authority away from the abandoned run but left `runStatus === "running"`,
 * and `panelBusy` is derived from exactly that value. The run was then forbidden
 * from ever settling it, so Research was busy forever.
 */
describe("C1 §E/§F — abandoned same-page execution is released", () => {
  it.each(["verify", "video", "history"] as const)(
    "leave Research via the %s tab mid-run, come back before A settles: NOT busy, and a new run can start",
    async (tab) => {
      const h = createHome();
      const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
      const running = h.handleRunPanel(() => a.promise);
      expect(h.panelBusy()).toBe(true);

      h.selectPanelTab(tab);
      // authority lost
      expect(h.guard.isCurrent(h.guard.current() - 1)).toBe(false);

      h.selectPanelTab("research");
      expect(h.state.runStatus).toBe("idle");
      expect(h.state.modelStatuses).toEqual({});
      expect(h.panelBusy()).toBe(false);

      // a NEW run is startable, and it is the one that owns the outcome
      const b = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
      const runningB = h.handleRunPanel(() => b.promise);
      expect(h.state.runStatus).toBe("running");

      // now A settles: it must not reclaim state or navigate
      a.resolve({ ok: true, runId: "run-A", results: ["late A"] });
      await running;
      expect(h.router.calls).toHaveLength(0);
      expect(h.state.results).toEqual([]);

      b.resolve({ ok: true, runId: "run-B", results: ["B"] });
      await runningB;
      expect(h.router.replaced()).toEqual(["/workspace/research/run-B"]);
      expect(h.state.results).toEqual(["B"]);
    }
  );

  it("no error is fabricated for the abandoned run", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);
    h.selectPanelTab("history");
    expect(h.state.error).toBeNull();
    expect(h.state.runStatus).toBe("idle");
    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;
    expect(h.state.error).toBeNull();
  });

  it("a COMPLETE report is NOT erased by switching tabs — only an actively running execution is released", async () => {
    const h = createHome();
    await h.handleRunPanel(async () => ({ ok: true, runId: "run-A", results: ["keep me"] }));
    expect(h.state.runStatus).toBe("complete");

    h.selectPanelTab("verify");
    h.selectPanelTab("research");
    expect(h.state.results).toEqual(["keep me"]);
    expect(h.state.runStatus).toBe("complete");
  });

  it("an ERRORED run is left alone too: release applies to 'running' only", async () => {
    const h = createHome();
    await h.handleRunPanel(async () => ({ ok: false }));
    expect(h.state.runStatus).toBe("error");
    h.selectPanelTab("verify");
    expect(h.state.runStatus).toBe("error");
    expect(h.state.error).toBe("Run failed.");
  });
});

/**
 * C1 §G/§H/§I — PROGRAMMATIC NEWER INTENT. The four visible tabs were never the
 * only way Home changes what the user is looking at.
 */
describe("C1 §G/§I — programmatic intent paths beat a pending run", () => {
  it("?tab=verify&claim= — the extension flow is newer intent", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.handleTabQuery("?tab=verify&claim=Remote%20work%20claim");
    expect(h.state.panelTab).toBe("verify");
    expect(h.state.runStatus).toBe("idle");

    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;
    expect(h.router.replaced()).toEqual(["/"]);
    expect(h.state.panelTab).toBe("verify");
    expect(h.state.results).toEqual([]);
  });

  it("?tab=research&q= — a new composer question is not overwritten and is not redirected over", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.handleTabQuery("?tab=research&q=A brand new question");
    expect(h.state.question).toBe("A brand new question");
    expect(h.state.runStatus).toBe("idle");

    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;
    // the older run neither replaced the question nor navigated to its own report
    expect(h.state.question).toBe("A brand new question");
    expect(h.router.replaced()).toEqual(["/"]);
    expect(h.state.results).toEqual([]);
  });

  it("§H — openVerification: the loaded verification is not displaced by run A's canonical redirect", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.openVerificationArtifact("verification");
    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;

    expect(h.state.verificationPayload).toEqual({ loaded: true });
    expect(h.state.panelTab).toBe("verify");
    expect(h.router.replaced()).toEqual(["/"]);
    expect(h.router.replaced()).not.toContain("/workspace/research/run-A");
  });

  it("§H — openVideoVerification: same protection", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.openVerificationArtifact("video_verification");
    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;

    expect(h.state.videoVerificationPayload).toEqual({ loaded: true });
    expect(h.state.panelTab).toBe("video");
    expect(h.router.replaced()).not.toContain("/workspace/research/run-A");
  });

  it("Run follow-up — the pre-filled question survives an older run's completion", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.handleRunFollowUp("What did the replication find?");
    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;

    expect(h.state.question).toBe("What did the replication find?");
    expect(h.router.calls).toHaveLength(0);
  });
});

/**
 * C1 §L/§M/§P — THE ROOT ORIGIN-LINKED CONSUMER.
 */
describe("C1 §L/§P — the root consumes the canonical verify hand-off", () => {
  it("both selectors present: enters origin-linked mode with EXACTLY runId + claimId", () => {
    const h = createHome();
    const href = personalResearchVerifyClaimHref({ runId: "run-A", claimId: "claim-B" })!;
    h.handleTabQuery(href.slice(href.indexOf("?")));

    expect(h.state.originLinkedTarget).toEqual({ runId: "run-A", claimId: "claim-B" });
    expect(Object.keys(h.state.originLinkedTarget!).sort()).toEqual(["claimId", "runId"]);
    expect(h.state.panelTab).toBe("verify");
    // ordinary free-text claim mode is cleared, exactly as the click path does
    expect(h.state.claimInput).toBe("");
    expect(h.state.verificationPayload).toBeNull();
    // the temporary hand-off URL is canonicalized away
    expect(h.router.replaced()).toEqual(["/"]);
  });

  it("the target carries no claim text, project or workspace id", () => {
    const h = createHome();
    h.handleTabQuery("?tab=verify&originRunId=run-A&originClaimId=claim-B&claim=Remote%20work%20reduces%20output&projectId=p1&workspaceId=w1");
    expect(h.state.originLinkedTarget).toEqual({ runId: "run-A", claimId: "claim-B" });
    expect(JSON.stringify(h.state.originLinkedTarget)).not.toContain("Remote work");
    expect(JSON.stringify(h.state.originLinkedTarget)).not.toContain("p1");
    expect(JSON.stringify(h.state.originLinkedTarget)).not.toContain("w1");
    // and a claim text riding along is NOT adopted as the subject
    expect(h.state.claimInput).toBe("");
  });

  it.each([
    ["only runId", "?tab=verify&originRunId=run-A"],
    ["only claimId", "?tab=verify&originClaimId=claim-B"],
    ["blank runId", "?tab=verify&originRunId=%20&originClaimId=claim-B"],
    ["blank claimId", "?tab=verify&originRunId=run-A&originClaimId=%20"],
  ])("a malformed pair (%s) constructs NO origin-linked target from partial data", (_l, search) => {
    const h = createHome();
    h.handleTabQuery(search);
    expect(h.state.originLinkedTarget).toBeNull();
    // it still behaves as the ordinary verify hand-off
    expect(h.state.panelTab).toBe("verify");
  });

  it("the hand-off is newer intent: a pending run cannot redirect over the Verify surface", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.handleTabQuery("?tab=verify&originRunId=run-A&originClaimId=claim-B");
    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;

    expect(h.router.replaced()).toEqual(["/"]);
    expect(h.state.panelTab).toBe("verify");
    expect(h.state.originLinkedTarget).toEqual({ runId: "run-A", claimId: "claim-B" });
  });

  it("§M — the click path and the query path reach the SAME state", () => {
    const viaClick = createHome();
    viaClick.enterOriginLinkedVerifyClaimMode({ runId: "run-A", claimId: "claim-B" });
    const viaQuery = createHome();
    viaQuery.handleTabQuery("?tab=verify&originRunId=run-A&originClaimId=claim-B");

    const shape = (h: ReturnType<typeof createHome>) => ({
      originLinkedTarget: h.state.originLinkedTarget,
      panelTab: h.state.panelTab,
      claimInput: h.state.claimInput,
      verificationPayload: h.state.verificationPayload,
      error: h.state.error,
    });
    expect(shape(viaQuery)).toEqual(shape(viaClick));
  });
});

describe("§Q — UNMOUNT RACE (Option A alone would pass the History race and still fail here)", () => {
  it("pending run A, Home unmounts via global navigation, A resolves: ZERO navigation", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.unmount(); // TopNav / WorkspaceSwitcher / browser back — cannot touch the guard itself

    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;

    expect(h.router.calls).toHaveLength(0);
    expect(h.state.results).toEqual([]);
  });

  it("the mount ref alone is decisive: even with the generation still current, a dead page cannot navigate", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    // simulate ONLY unmount-without-invalidation to isolate the mount dimension
    h.mounted.current = false;

    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;
    expect(h.router.calls).toHaveLength(0);
  });

  it("§T/C1 §V — ownership is still re-checked immediately before the redirect, with no await in between", async () => {
    const h = createHome();
    // ownership is lost during the RESPONSE await — i.e. before the success commit
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);
    h.unmount();
    a.resolve({ ok: true, runId: "run-A", results: ["r"] });
    await running;
    expect(h.router.calls).toHaveLength(0);
  });
});

describe("§R — STALE ERROR RACE", () => {
  it("an obsolete run's failure does not overwrite the newer surface", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.openResearchHistoryItem("run-B");

    a.reject(new Error("A failed late"));
    await running;

    expect(h.state.error).toBeNull();
    // C1 §E — released rather than stuck on "running"
    expect(h.state.runStatus).toBe("idle");
    expect(h.router.replaced()).toEqual([]);
  });

  it("an obsolete run's API-level failure is equally a no-op", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);
    h.selectPanelTab("verify");
    a.resolve({ ok: false });
    await running;
    expect(h.state.error).toBeNull();
  });
});

describe("§J/§AH — legacy link canonicalization", () => {
  it("canonicalizes with REPLACE and claims intent, so a pending run cannot redirect over it", async () => {
    const h = createHome();
    const a = deferred<{ ok: boolean; runId?: string; results?: string[] }>();
    const running = h.handleRunPanel(() => a.promise);

    h.canonicalizeLegacyLink("run-legacy");
    expect(h.router.replaced()).toEqual(["/workspace/research/run-legacy"]);

    a.resolve({ ok: true, runId: "run-A", results: ["late"] });
    await running;
    expect(h.router.replaced()).toEqual(["/workspace/research/run-legacy"]);
  });
});

/**
 * These pin the transcription above to the SHIPPED control flow, so the behavioural
 * tests cannot drift into testing a fiction.
 */
describe("personalResearchCanonicalNavigationStructure — the transcription matches app/page.tsx", () => {
  const CODE = PAGE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");

  it("one mount ref, set on mount and cleared on unmount, with unmount also invalidating the generation", () => {
    expect(CODE).toMatch(/const researchPageMountedRef = useRef\(false\);/);
    expect(CODE).toMatch(/researchPageMountedRef\.current = true;/);
    expect(CODE).toMatch(/researchPageMountedRef\.current = false;\s*\n\s*researchLoadGuard\.next\(\);/);
  });

  it("the ownership predicate requires BOTH mount and generation", () => {
    expect(CODE).toMatch(/researchPageMountedRef\.current && researchLoadGuard\.isCurrent\(runGeneration\)/);
  });

  it("the canonical redirect is guarded by a real run id AND ownership, and uses replace", () => {
    expect(CODE).toMatch(/if \(isCanonicalPersonalRunId\(data\.runId\) && stillOwnsResearchIntent\(\)\) \{\s*\n\s*router\.replace\(personalResearchHref\(data\.runId\)\);/);
  });

  it("C1 §V — NO await stands between the success commit and the canonical replace, and the usage refresh comes after it", () => {
    const complete = CODE.indexOf('setRunStatus("complete");');
    const replace = CODE.indexOf("router.replace(personalResearchHref(data.runId))");
    const usage = CODE.indexOf("await refreshUsage();", complete);
    expect(complete).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(complete);
    expect(usage).toBeGreaterThan(replace);
    // the decisive property: nothing awaited in the window that used to exist
    expect(CODE.slice(complete, replace)).not.toContain("await ");
  });

  it("C1 §E — runStatus is mirrored into a ref, and the superseding helper releases ONLY a running execution", () => {
    expect(CODE).toMatch(/const runStatusRef = useRef<RunStatus>\("idle"\);/);
    expect(CODE).toMatch(/runStatusRef\.current = runStatus;/);
    const i = CODE.indexOf("const supersedeRunningResearch = useCallback(");
    expect(i).toBeGreaterThan(-1);
    const body = CODE.slice(i, CODE.indexOf("}, [invalidateResearchIntent]);", i));
    expect(body).toContain("invalidateResearchIntent();");
    expect(body).toMatch(/if \(runStatusRef\.current !== "running"\) return;/);
    expect(body).toContain('setRunStatus("idle");');
    expect(body).toContain("setModelStatuses(");
    // no fabricated error, and no attempt to cancel or mutate the server-side run
    expect(body).not.toContain("setError(");
    expect(body).not.toContain("fetch(");
    expect(body).not.toContain("abort");
    // the invalidation precedes the release
    expect(body.indexOf("invalidateResearchIntent();")).toBeLessThan(body.indexOf('setRunStatus("idle");'));
  });

  it("the tab controls route through selectPanelTab, which supersedes on leaving Research", () => {
    expect(CODE).toMatch(/if \(nextTab !== "research"\) supersedeRunningResearch\(\);/);
    expect(CODE).not.toMatch(/onClick=\{\(\) => setPanelTab\(/);
  });

  it("the research History branch supersedes before pushing, and does not load first", () => {
    const i = CODE.indexOf('if (item.type === "research")');
    const branch = CODE.slice(i, i + 400);
    const inv = branch.indexOf("supersedeRunningResearch()");
    const push = branch.indexOf("router.push(personalResearchHref(item.id))");
    expect(inv).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(inv);
    expect(branch).not.toContain("loadResearchRunIntoState");
  });

  it("C1 §H — the verification and video History/deep-link branches declare intent before committing their surface", () => {
    const vid = CODE.indexOf('if (item.type === "video_verification")');
    expect(vid).toBeGreaterThan(-1);
    const vidBranch = CODE.slice(vid, vid + 300);
    expect(vidBranch.indexOf("supersedeRunningResearch()")).toBeLessThan(vidBranch.indexOf('setPanelTab("video")'));
    // the fall-through verification branch
    const ver = CODE.indexOf('setPanelTab("verify");\n    setVideoVerificationPayload(null);');
    expect(ver).toBeGreaterThan(-1);
    expect(CODE.slice(Math.max(0, ver - 120), ver)).toContain("supersedeRunningResearch();");
  });

  it("C1 §G/§I — the ?tab= query flow declares intent on BOTH branches", () => {
    const i = CODE.indexOf('const tab = params.get("tab");');
    expect(i).toBeGreaterThan(-1);
    const effect = CODE.slice(i, i + 1600);
    const verify = effect.indexOf('if (tab === "verify")');
    const research = effect.indexOf('} else if (tab === "research")');
    expect(verify).toBeGreaterThan(-1);
    expect(research).toBeGreaterThan(verify);
    expect(effect.slice(verify, research)).toContain("supersedeRunningResearch();");
    expect(effect.slice(research)).toContain("supersedeRunningResearch();");
  });

  it("C1 §L — the origin-linked consumer requires BOTH selectors, enters the shared transition, and copies no claim text", () => {
    const i = CODE.indexOf('const originRunId = params.get("originRunId");');
    expect(i).toBeGreaterThan(-1);
    const block = CODE.slice(i, i + 700);
    expect(block).toMatch(/if \(originRunId\?\.trim\(\) && originClaimId\?\.trim\(\)\) \{/);
    expect(block).toContain("enterOriginLinkedVerifyClaimMode({");
    expect(block).toContain("runId: originRunId.trim()");
    expect(block).toContain("claimId: originClaimId.trim()");
    // the origin-linked branch returns before the free-text claim handling
    const ret = block.indexOf("return;");
    const claim = block.indexOf('params.get("claim")');
    expect(ret).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(ret);
    // and no verification is executed by navigation
    expect(block).not.toContain("/api/verify-claim");
    expect(block).not.toContain("handleVerifyClaim(");
  });

  it("C1 §M — ONE shared origin-linked transition, used by the click path too", () => {
    expect(CODE).toMatch(/const enterOriginLinkedVerifyClaimMode = useCallback\(/);
    const helperStart = CODE.indexOf("const enterOriginLinkedVerifyClaimMode = useCallback(");
    const helper = CODE.slice(helperStart, CODE.indexOf("[supersedeRunningResearch]", helperStart));
    expect(helper).toContain("supersedeRunningResearch();");
    expect(helper).toContain("setOriginLinkedTarget({ runId: target.runId, claimId: target.claimId });");
    expect(helper).toContain("setClaimInput(\"\");");
    expect(helper).toContain('setPanelTab("verify");');
    // and it executes nothing
    expect(helper).not.toContain("fetch(");
    expect(helper).not.toContain("handleVerifyClaim(");

    // the click handler delegates rather than keeping a second copy
    const click = CODE.indexOf("const handleVerifyClaimFromFindingClick = (");
    const clickBody = CODE.slice(click, CODE.indexOf("};", click));
    expect(clickBody).toContain("enterOriginLinkedVerifyClaimMode({ runId: args.runId, claimId: args.claimId });");
    expect(clickBody).not.toContain("setOriginLinkedTarget(");
  });

  it("C1 §G — the follow-up pre-fill declares newer intent and still auto-runs nothing", () => {
    const i = CODE.indexOf("const handleRunFollowUp = (followUpQuestion: string) => {");
    expect(i).toBeGreaterThan(-1);
    const body = CODE.slice(i, CODE.indexOf("};", i));
    expect(body).toContain("supersedeRunningResearch();");
    expect(body).toContain("setQuestion(followUpQuestion);");
    expect(body).not.toContain("handleRunPanel(");
  });

  it("the legacy research link canonicalizes without loading or re-running, and verification/video keep their old behaviour", () => {
    expect(CODE).toMatch(/supersedeRunningResearch\(\);\s*\n\s*router\.replace\(personalResearchHref\(r\), \{ scroll: false \}\);/);
    expect(CODE).toMatch(/type: "verification"/);
    expect(CODE).toMatch(/type: "video_verification"/);
    expect(CODE).toMatch(/router\.replace\("\/", \{ scroll: false \}\)/);
  });

  it("§D/§R — the stale-FAILURE commit is ownership-guarded in the shipped source, not only in the transcription", () => {
    const i = CODE.indexOf('setError("Network error. Please check your connection and try again.");');
    expect(i).toBeGreaterThan(-1);
    const before = CODE.slice(Math.max(0, i - 260), i);
    expect(before).toContain("if (!stillOwnsResearchIntent()) return;");
  });

  it("§D — an ownership boundary sits between the fetch and the response-body read, so every downstream commit is unreachable once authority is lost", () => {
    const textRead = CODE.indexOf("responseText = await response.text();");
    expect(textRead).toBeGreaterThan(-1);
    // the nearest preceding ownership check, with no intervening commit
    const guardBefore = CODE.lastIndexOf("if (!stillOwnsResearchIntent()) return;", textRead);
    expect(guardBefore).toBeGreaterThan(-1);
    const between = CODE.slice(guardBefore, textRead);
    expect(between).not.toMatch(/setResults\(|setRunStatus\(|setAdaptivePanel\(/);
  });

  it("§E — the queued->thinking timer is owned by the execution generation", () => {
    // Anchored on the queued->thinking timer specifically: the first setTimeout in
    // this file is an unrelated performance log.
    const timerEnd = CODE.indexOf("}, 100);");
    expect(timerEnd).toBeGreaterThan(-1);
    const i = CODE.lastIndexOf("setTimeout(() => {", timerEnd);
    expect(i).toBeGreaterThan(-1);
    // the guard is the first statement in the callback, before any status write
    const callback = CODE.slice(i, timerEnd);
    expect(callback).toContain("if (!stillOwnsResearchIntent()) return;");
    expect(callback.indexOf("if (!stillOwnsResearchIntent()) return;")).toBeLessThan(callback.indexOf("setModelStatuses("));
  });

  it("the obsolete 'needs no isCurrent check of its own' claim is gone", () => {
    expect(PAGE_SOURCE).not.toMatch(/needs\s*\n?\s*\/\/\s*no isCurrent check of its own/);
    expect(PAGE_SOURCE).not.toMatch(/needs no isCurrent check of its own/);
  });
});
