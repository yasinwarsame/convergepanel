/**
 * PERSONAL-RESEARCH-URL-1 §AG / §L–§S — CANONICAL NAVIGATION OWNERSHIP.
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
 * WHAT IS REAL vs TRANSCRIBED (same constraint and convention as
 * `personalResearchHistoryLoadRace.spec.tsx` — mounting the real `app/page.tsx`
 * OOMs ts-jest's whole-program check here):
 *   - `createGenerationGuard` is the REAL shipped primitive.
 *   - `personalResearchHref` / `isCanonicalPersonalRunId` are the REAL builders.
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
import { personalResearchHref, isCanonicalPersonalRunId } from "@/lib/user/personalResearchHref";

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
    error: null as string | null,
  };
  const mounted = { current: false };

  // mount effect
  mounted.current = true;
  const unmount = () => {
    mounted.current = false;
    guard.next(); // leaving is newer intent
  };

  const invalidateResearchIntent = () => { guard.next(); };

  const selectPanelTab = (nextTab: typeof state.panelTab) => {
    if (nextTab !== "research") invalidateResearchIntent();
    state.panelTab = nextTab;
  };

  /** §AF — transcribed `handleRunPanel`, awaits and ownership checks in shipped order. */
  const handleRunPanel = async (
    runFetch: () => Promise<{ ok: boolean; runId?: string; results?: string[] }>,
    refreshUsage: () => Promise<void> = async () => {}
  ) => {
    const runGeneration = guard.next();
    const stillOwnsResearchIntent = () => mounted.current && guard.isCurrent(runGeneration);
    state.runStatus = "running";

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

    await refreshUsage();

    // §F/§T — re-checked AFTER the await, not trusted from before it.
    if (isCanonicalPersonalRunId(data.runId) && stillOwnsResearchIntent()) {
      router.replace(personalResearchHref(data.runId!));
    }
  };

  /** §AD/§G — transcribed research History branch: invalidate, then PUSH. */
  const openResearchHistoryItem = (runId: string) => {
    invalidateResearchIntent();
    router.push(personalResearchHref(runId));
  };

  /** §J/§AH — transcribed legacy deep-link canonicalization. */
  const canonicalizeLegacyLink = (runId: string) => {
    invalidateResearchIntent();
    router.replace(personalResearchHref(runId));
  };

  return { guard, router, state, mounted, unmount, invalidateResearchIntent, selectPanelTab, handleRunPanel, openResearchHistoryItem, canonicalizeLegacyLink };
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
    expect(h.state.runStatus).toBe("running");
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
    a.resolve({ ok: true, runId: "run-A", results: ["r"] });
    await running;

    expect(h.router.replaced()).toEqual(["/workspace/research/run-A"]);
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

  it("§T — ownership is re-checked AFTER the post-success await, not trusted from before it", async () => {
    const h = createHome();
    // ownership is lost DURING refreshUsage — i.e. after the earlier check passed
    await h.handleRunPanel(
      async () => ({ ok: true, runId: "run-A", results: ["r"] }),
      async () => { h.unmount(); }
    );
    expect(h.router.calls).toHaveLength(0);
    // the success state committed before the await is retained; only the redirect is withheld
    expect(h.state.runStatus).toBe("complete");
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
    expect(h.state.runStatus).toBe("running");
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

  it("the redirect sits AFTER the post-success await it must be re-checked against", () => {
    const i = CODE.indexOf("await refreshUsage();");
    const j = CODE.indexOf("router.replace(personalResearchHref(data.runId))");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });

  it("the research History branch invalidates before pushing, and does not load first", () => {
    const i = CODE.indexOf('if (item.type === "research")');
    const branch = CODE.slice(i, i + 400);
    const inv = branch.indexOf("invalidateResearchIntent()");
    const push = branch.indexOf("router.push(personalResearchHref(item.id))");
    expect(inv).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(inv);
    expect(branch).not.toContain("loadResearchRunIntoState");
  });

  it("the tab controls route through selectPanelTab, which invalidates on leaving Research", () => {
    expect(CODE).toMatch(/if \(nextTab !== "research"\) invalidateResearchIntent\(\);/);
    expect(CODE).not.toMatch(/onClick=\{\(\) => setPanelTab\(/);
  });

  it("the legacy research link canonicalizes without loading or re-running, and verification/video keep their old behaviour", () => {
    expect(CODE).toMatch(/invalidateResearchIntent\(\);\s*\n\s*router\.replace\(personalResearchHref\(r\), \{ scroll: false \}\);/);
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
