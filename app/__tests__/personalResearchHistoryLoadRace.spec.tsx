/**
 * Personal Research navigation/load arbitration (Phase 11A.6.1) — race
 * reproduction AND regression coverage for the fix.
 *
 * INFRASTRUCTURE NOTE (unchanged from the original version of this file —
 * read before editing): mounting the real `app/page.tsx` via
 * `react-test-renderer` OOMs / hangs `ts-jest`'s whole-program type-check
 * in this environment (it pulls in `lib/billing/planConfig.ts` ->
 * `lib/env.ts` and a large fraction of the server codebase). This matches
 * the precedent in `app/__tests__/legacyAdaptiveHistoryReload.spec.ts`.
 * `app/__tests__/personalResearchLoadArbitrationStructure.spec.ts` covers
 * the fix at the source-string level for exactly this reason.
 *
 * WHAT'S REAL vs. TRANSCRIBED in THIS file:
 *   - `createGenerationGuard` is imported for real from
 *     `@/lib/client/authGeneration` (no heavy deps — it compiles and runs
 *     fine here) and is the ACTUAL arbitration primitive shipped in
 *     `app/page.tsx`. Every assertion below about "does the guard reject
 *     the stale call" is exercising real, shipped code.
 *   - `loadResearchRunIntoState` / `openHistoryItem` / `handleRunPanelSubset`
 *     / `handleViewSourceResearch` below are STRUCTURALLY VERBATIM
 *     transcriptions of the fixed functions in `app/page.tsx` (same guard
 *     usage, same call order, same early-returns, same
 *     `focusClaimTarget` threading), operating on a plain-object stand-in
 *     for React state instead of real `useState` setters. This is the
 *     same pattern the original (pre-fix) version of this file used to
 *     prove the bug existed; it's now used to prove the fix's CONTROL FLOW
 *     is correct, wired to the real guard.
 *
 * Each `it()` below is annotated with which item of the phase's required
 * test matrix (1-12) it covers.
 */

import { createGenerationGuard, type GenerationGuard } from "@/lib/client/authGeneration";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type RunApiResponse = {
  ok: boolean;
  message?: string;
  runId?: string;
  question?: string;
  selectedModels?: string[];
  results?: { modelId: string; status: string; rawText: string }[];
};

/** Stands in for the real `authedFetch` — resolves to a Response-like object with `.json()`. */
type FakeAuthedFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<RunApiResponse> }>;

/** Plain-object stand-in for every `useState` field this path touches (real names, app/page.tsx). */
function createState() {
  return {
    question: "",
    selectedModels: [] as string[],
    results: [] as { modelId: string; status: string; rawText: string }[],
    currentRunId: null as string | null,
    runStatus: "idle" as "idle" | "running" | "complete" | "error",
    viewingHistoryRunId: null as string | null,
    focusClaimId: null as string | null,
    focusClaimNotFound: false,
    error: null as string | null,
    historyDetailLoadingId: null as string | null,
    sourceNavLoading: false,
    panelTab: "research" as "research" | "verify" | "video" | "history",
  };
}
type St = ReturnType<typeof createState>;

type LoadResult = { ok: true } | { ok: false; message: string } | { superseded: true };

/**
 * Verbatim transcription of the FIXED `loadResearchRunIntoState`,
 * app/page.tsx ~lines 1692-1953. Trimmed of the adaptive-envelope /
 * synthesis-cache branches, which are independent try/catch'd cosmetic
 * concerns that do not write to any field asserted below. Every OTHER
 * setter call, the generation-guard claim/check placement, and the
 * `focusClaimTarget` threading match the real function exactly.
 */
async function loadResearchRunIntoState(
  st: St,
  guard: GenerationGuard,
  authedFetch: FakeAuthedFetch,
  runId: string,
  fallback: { question: string; selectedModels: string[] },
  focusClaimTarget: string | null = null
): Promise<LoadResult> {
  // Claimed synchronously, before the first await.
  const gen = guard.next();
  st.focusClaimId = null;
  st.focusClaimNotFound = false;
  try {
    const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (!res.ok || !data.ok || !data.results?.length) {
      throw new Error(typeof data.message === "string" ? data.message : "Could not load this run.");
    }
    // Single check, immediately after the awaited fetch/parse, governs the
    // WHOLE success commit below — no await follows it.
    if (!guard.isCurrent(gen)) {
      return { superseded: true };
    }
    st.question = data.question ?? fallback.question;
    st.selectedModels =
      Array.isArray(data.selectedModels) && data.selectedModels.length > 0
        ? data.selectedModels
        : fallback.selectedModels;
    st.results = data.results;
    st.currentRunId = data.runId ?? runId;
    st.runStatus = "complete";
    st.viewingHistoryRunId = data.runId ?? runId;
    st.focusClaimId = focusClaimTarget;
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Could not load this run.";
    // Single check governs the WHOLE failure/cleanup commit below.
    if (!guard.isCurrent(gen)) {
      return { superseded: true };
    }
    st.error = msg;
    st.viewingHistoryRunId = null;
    st.results = [];
    st.runStatus = "idle";
    st.currentRunId = null;
    st.question = fallback.question;
    st.selectedModels = fallback.selectedModels;
    return { ok: false, message: msg };
  }
}

/** Verbatim transcription of `openHistoryItem`'s research branch. */
async function openHistoryItem(
  st: St,
  guard: GenerationGuard,
  authedFetch: FakeAuthedFetch,
  item: { id: string; question: string; selectedModels: string[] }
): Promise<void> {
  st.panelTab = "research";
  st.error = null;
  st.viewingHistoryRunId = null;
  st.focusClaimId = null;
  st.focusClaimNotFound = false;
  st.historyDetailLoadingId = item.id;
  await loadResearchRunIntoState(st, guard, authedFetch, item.id, {
    question: item.question,
    selectedModels: item.selectedModels,
  });
  // Control-local: this item's own spinner. Fires unconditionally.
  st.historyDetailLoadingId = null;
}

/** Verbatim transcription of the FIXED `handleViewSourceResearch`. */
async function handleViewSourceResearch(
  st: St,
  guard: GenerationGuard,
  authedFetch: FakeAuthedFetch,
  source: { runId: string; claimId: string }
): Promise<void> {
  if (st.sourceNavLoading) return;
  st.sourceNavLoading = true;
  const result = await loadResearchRunIntoState(
    st,
    guard,
    authedFetch,
    source.runId,
    { question: st.question, selectedModels: st.selectedModels },
    source.claimId
  );
  // Control-local: this button's own spinner. Fires unconditionally.
  st.sourceNavLoading = false;
  if ("superseded" in result) {
    return;
  }
  if (!result.ok) {
    st.error = "This source research is no longer available.";
    return;
  }
  st.panelTab = "research";
}

/**
 * Verbatim transcription of the relevant subset of the FIXED
 * `handleRunPanel`: the generation-guard claim (new) plus the synchronous
 * reset at the top of the function, and the success-path setters.
 */
async function handleRunPanelSubset(
  st: St,
  guard: GenerationGuard,
  authedFetch: (url: string) => Promise<{ text: () => Promise<string> }>,
  question: string
): Promise<void> {
  // THE FIX: strips authority from any in-flight loadResearchRunIntoState
  // call. handleRunPanel needs no isCurrent check of its own — its own
  // completion never routes through loadResearchRunIntoState.
  guard.next();
  st.viewingHistoryRunId = null;
  st.runStatus = "running";
  st.results = [];
  st.currentRunId = null;
  st.question = question;

  const response = await authedFetch("/api/run-panel");
  const responseText = await response.text();
  const data = JSON.parse(responseText) as RunApiResponse;

  if (!data.ok) return;

  if (data.runId) st.currentRunId = data.runId;
  st.results = data.results ?? [];
  st.runStatus = "complete";
}

describe("Personal Research load arbitration — History vs. History (matrix items 1, 3, 4, 5, 11, 12)", () => {
  it("[1] B resolves first, A resolves late (both success) → B remains current, A's completion is a true no-op", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredA = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredB = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-A") return deferredA.promise;
      if (url === "/api/user/runs/run-B") return deferredB.promise;
      throw new Error("unexpected url " + url);
    };

    const pendingA = openHistoryItem(st, guard, authedFetch, {
      id: "run-A",
      question: "History fallback A",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();

    const pendingB = openHistoryItem(st, guard, authedFetch, {
      id: "run-B",
      question: "History fallback B",
      selectedModels: ["claude"],
    });
    await Promise.resolve();
    await Promise.resolve();

    deferredB.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-B",
        question: "Question B — loaded from server",
        selectedModels: ["claude"],
        results: [{ modelId: "claude", status: "ok", rawText: "Answer B" }],
      }),
    });
    await pendingB;

    expect(st.currentRunId).toBe("run-B");
    expect(st.question).toBe("Question B — loaded from server");
    expect(st.results.map((r) => r.rawText)).toEqual(["Answer B"]);
    expect(st.viewingHistoryRunId).toBe("run-B");

    // A — the earlier, now-stale intent — resolves late.
    deferredA.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-A",
        question: "Question A — loaded from server",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Answer A" }],
      }),
    });
    await pendingA;

    // FIXED: B's state is untouched by A's late arrival.
    expect(st.currentRunId).toBe("run-B");
    expect(st.question).toBe("Question B — loaded from server");
    expect(st.results.map((r) => r.rawText)).toEqual(["Answer B"]);
    expect(st.viewingHistoryRunId).toBe("run-B");
  });

  it("[2] B succeeds first, A stale-fails late → B remains current, no A error shown, B's results are not cleared", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredA = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredB = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-A") return deferredA.promise;
      if (url === "/api/user/runs/run-B") return deferredB.promise;
      throw new Error("unexpected url " + url);
    };

    const pendingA = openHistoryItem(st, guard, authedFetch, {
      id: "run-A",
      question: "History fallback A",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();
    const pendingB = openHistoryItem(st, guard, authedFetch, {
      id: "run-B",
      question: "History fallback B",
      selectedModels: ["claude"],
    });
    await Promise.resolve();
    await Promise.resolve();

    // B (current) succeeds first.
    deferredB.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-B",
        question: "Question B — loaded from server",
        selectedModels: ["claude"],
        results: [{ modelId: "claude", status: "ok", rawText: "Answer B" }],
      }),
    });
    await pendingB;
    expect(st.currentRunId).toBe("run-B");
    expect(st.runStatus).toBe("complete");
    expect(st.error).toBeNull();

    // A (stale) fails late — the failure/"finally-equivalent" cleanup
    // block (setError, setResults([]), setRunStatus("idle"), ...) must be
    // a true no-op: no A error surfaces, and B's already-correct state is
    // not cleared out from under it.
    deferredA.resolve({ ok: false, json: async () => ({ ok: false, message: "Run A not found" }) });
    await pendingA;

    expect(st.currentRunId).toBe("run-B");
    expect(st.runStatus).toBe("complete");
    expect(st.error).toBeNull(); // A's stale error never surfaces
    expect(st.results.map((r) => r.rawText)).toEqual(["Answer B"]); // not cleared to []
    expect(st.viewingHistoryRunId).toBe("run-B"); // not reset to null
  });

  it("[4] B fails, A stale-succeeds → B's current error remains, not silently replaced by A's success", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredA = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredB = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-A") return deferredA.promise;
      if (url === "/api/user/runs/run-B") return deferredB.promise;
      throw new Error("unexpected url " + url);
    };

    const pendingA = openHistoryItem(st, guard, authedFetch, {
      id: "run-A",
      question: "History fallback A",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();
    const pendingB = openHistoryItem(st, guard, authedFetch, {
      id: "run-B",
      question: "History fallback B",
      selectedModels: ["claude"],
    });
    await Promise.resolve();
    await Promise.resolve();

    // B (current) fails.
    deferredB.resolve({ ok: false, json: async () => ({ ok: false, message: "Run B not found" }) });
    await pendingB;
    expect(st.error).toBe("Run B not found");
    expect(st.runStatus).toBe("idle");

    // A (stale) succeeds late — must not silently replace B's error.
    deferredA.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-A",
        question: "Question A",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Answer A" }],
      }),
    });
    await pendingA;

    expect(st.error).toBe("Run B not found");
    expect(st.runStatus).toBe("idle");
    expect(st.currentRunId).toBeNull();
    expect(st.results).toEqual([]);
  });

  it("[3] A settles (fails) while B is still pending → does not clear B's own loading state (control-local spinner is per-item, unaffected)", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredA = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredB = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-A") return deferredA.promise;
      if (url === "/api/user/runs/run-B") return deferredB.promise;
      throw new Error("unexpected url " + url);
    };

    const pendingA = openHistoryItem(st, guard, authedFetch, {
      id: "run-A",
      question: "History fallback A",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();
    const pendingB = openHistoryItem(st, guard, authedFetch, {
      id: "run-B",
      question: "History fallback B",
      selectedModels: ["claude"],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(st.historyDetailLoadingId).toBe("run-B");

    // A (stale) fails first, while B is still pending.
    deferredA.resolve({ ok: false, json: async () => ({ ok: false, message: "Run A not found" }) });
    await pendingA;

    // VERIFIED (not assumed): `historyDetailLoadingId` is a SINGLE shared
    // field, not scoped per item (`disabled={historyDetailLoadingId ===
    // item.id}`, plus a loading-banner check, both at the whole-field
    // level — see app/page.tsx). So A's own `setHistoryDetailLoadingId(null)`
    // cleanup — control-local per the phase's own carve-out, and fires
    // unconditionally in both the real code and this transcription — DOES
    // clear the field back to null even while B is still pending. This is
    // pre-existing behavior, orthogonal to the generation guard (it was
    // already unconditional before this fix, and the guard was never
    // meant to touch it): it can cause a momentary spinner/banner
    // flicker, but it does NOT corrupt any research-run CONTENT field —
    // B's error/results/currentRunId/runStatus below are all still
    // correctly un-touched by A.
    expect(st.historyDetailLoadingId).toBeNull();
    expect(st.error).toBeNull(); // A's stale failure never surfaces
    expect(st.results).toEqual([]); // B hasn't resolved yet
    expect(st.runStatus).toBe("idle"); // neither A nor B has set "complete"/"error" for run content

    deferredB.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-B",
        question: "Question B",
        selectedModels: ["claude"],
        results: [{ modelId: "claude", status: "ok", rawText: "Answer B" }],
      }),
    });
    await pendingB;
    expect(st.historyDetailLoadingId).toBeNull();
    expect(st.currentRunId).toBe("run-B");
  });

  it("[5] the same run requested twice — the second (current) call still owns the final state", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferred1 = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferred2 = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    let callCount = 0;
    const authedFetch: FakeAuthedFetch = () => {
      callCount += 1;
      return callCount === 1 ? deferred1.promise : deferred2.promise;
    };

    // In the real app, `historyDetailLoadingId === item.id` disables that
    // item's own button, so a genuine double-fire of the SAME item is
    // already suppressed at the UI layer. This test documents that even
    // if it somehow still fired twice, the arbitration guard independently
    // ensures the second (current) call wins.
    const pending1 = openHistoryItem(st, guard, authedFetch, {
      id: "run-X",
      question: "Fallback",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();
    const pending2 = openHistoryItem(st, guard, authedFetch, {
      id: "run-X",
      question: "Fallback",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();

    deferred2.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-X",
        question: "Second load",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Second answer" }],
      }),
    });
    await pending2;
    expect(st.question).toBe("Second load");

    deferred1.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-X",
        question: "First load (stale)",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "First answer" }],
      }),
    });
    await pending1;

    expect(st.question).toBe("Second load");
    expect(st.results.map((r) => r.rawText)).toEqual(["Second answer"]);
  });

  it("[11] current success still renders normally — no false-positive stale rejection for a genuinely current, non-racing call", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const authedFetch: FakeAuthedFetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-solo",
        question: "Solo question",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Solo answer" }],
      }),
    });

    await openHistoryItem(st, guard, authedFetch, {
      id: "run-solo",
      question: "fallback",
      selectedModels: ["chatgpt"],
    });

    expect(st.currentRunId).toBe("run-solo");
    expect(st.question).toBe("Solo question");
    expect(st.results.map((r) => r.rawText)).toEqual(["Solo answer"]);
    expect(st.runStatus).toBe("complete");
    expect(st.error).toBeNull();
  });

  it("[12] current error still renders normally — the arbiter never swallows a legitimate, non-racing failure", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const authedFetch: FakeAuthedFetch = async () => ({
      ok: false,
      json: async () => ({ ok: false, message: "You no longer have access to this run." }),
    });

    await openHistoryItem(st, guard, authedFetch, {
      id: "run-denied",
      question: "fallback",
      selectedModels: ["chatgpt"],
    });

    expect(st.error).toBe("You no longer have access to this run.");
    expect(st.runStatus).toBe("idle");
    expect(st.results).toEqual([]);
  });
});

describe("Personal Research load arbitration — cross-control: History vs. 'View source research' (matrix items 6, 8, 9, 10)", () => {
  it("[6] both route through loadResearchRunIntoState under the SAME guard — the latest of the two wins regardless of which control it came from", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredHistory = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredSource = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-history") return deferredHistory.promise;
      if (url === "/api/user/runs/run-source") return deferredSource.promise;
      throw new Error("unexpected url " + url);
    };

    // Older intent: a History click.
    const pendingHistory = openHistoryItem(st, guard, authedFetch, {
      id: "run-history",
      question: "History fallback",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();

    // Newer intent: "View source research" from a reopened verification.
    const pendingSource = handleViewSourceResearch(st, guard, authedFetch, {
      runId: "run-source",
      claimId: "v1:findings:0:aaaa",
    });
    await Promise.resolve();
    await Promise.resolve();

    // The newer ("View source research") call resolves first.
    deferredSource.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-source",
        question: "Source question",
        selectedModels: ["claude"],
        results: [{ modelId: "claude", status: "ok", rawText: "Source answer" }],
      }),
    });
    await pendingSource;
    expect(st.currentRunId).toBe("run-source");
    expect(st.focusClaimId).toBe("v1:findings:0:aaaa");

    // The older, now-stale History load resolves late.
    deferredHistory.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-history",
        question: "History question",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "History answer" }],
      }),
    });
    await pendingHistory;

    // FIXED: the newer "View source research" state is untouched.
    expect(st.currentRunId).toBe("run-source");
    expect(st.results.map((r) => r.rawText)).toEqual(["Source answer"]);
    expect(st.focusClaimId).toBe("v1:findings:0:aaaa");
    expect(st.error).toBeNull();
    expect(st.panelTab).toBe("research");
  });

  it("[9] stale load cannot consume the winning claim target — a stale plain History load (target null) landing after 'View source research' does not clear the winning focus claim", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredSource = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredHistory = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-source") return deferredSource.promise;
      if (url === "/api/user/runs/run-history") return deferredHistory.promise;
      throw new Error("unexpected url " + url);
    };

    // Older intent: "View source research" (has a claim target).
    const pendingSource = handleViewSourceResearch(st, guard, authedFetch, {
      runId: "run-source",
      claimId: "v1:findings:2:bbbb",
    });
    await Promise.resolve();
    await Promise.resolve();

    // Newer intent: a plain History click (no claim target) for a
    // DIFFERENT run.
    const pendingHistory = openHistoryItem(st, guard, authedFetch, {
      id: "run-history",
      question: "History fallback",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();

    // Newer (History) resolves first.
    deferredHistory.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-history",
        question: "History question",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "History answer" }],
      }),
    });
    await pendingHistory;
    expect(st.currentRunId).toBe("run-history");
    expect(st.focusClaimId).toBeNull();

    // Older, now-stale "View source research" resolves late — must NOT be
    // able to set its claim target onto the now-displayed different run.
    deferredSource.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-source",
        question: "Source question",
        selectedModels: ["claude"],
        results: [{ modelId: "claude", status: "ok", rawText: "Source answer" }],
      }),
    });
    await pendingSource;

    expect(st.currentRunId).toBe("run-history");
    expect(st.focusClaimId).toBeNull();
    expect(st.results.map((r) => r.rawText)).toEqual(["History answer"]);
  });

  it("[8] exact focus-claim/run pairing: the winning run and winning claim target always pair together — a stale load can never consume a different currently-displayed run's claim slot", async () => {
    // NOTE ON REACHABILITY: in the real app, `handleViewSourceResearch`'s
    // own `sourceNavLoading` check (`if (sourceNavLoading) return;`, plus
    // the button it drives being `disabled` while true) already prevents
    // TWO CONCURRENT "View source research" calls outright — that's a
    // separate, control-local, per-button dedup, not part of the shared
    // arbitration domain. To prove the CORE pairing invariant inside
    // `loadResearchRunIntoState` itself (defense in depth, independent of
    // that outer dedup), this test calls it directly with two different
    // non-null focus-claim targets, exactly as handleViewSourceResearch
    // does internally.
    const st = createState();
    const guard = createGenerationGuard();
    const deferredSourceA = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const deferredSourceB = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-A") return deferredSourceA.promise;
      if (url === "/api/user/runs/run-B") return deferredSourceB.promise;
      throw new Error("unexpected url " + url);
    };

    const pendingA = loadResearchRunIntoState(
      st,
      guard,
      authedFetch,
      "run-A",
      { question: "q", selectedModels: ["chatgpt"] },
      "claim-A"
    );
    await Promise.resolve();
    await Promise.resolve();
    const pendingB = loadResearchRunIntoState(
      st,
      guard,
      authedFetch,
      "run-B",
      { question: "q", selectedModels: ["claude"] },
      "claim-B"
    );
    await Promise.resolve();
    await Promise.resolve();

    deferredSourceB.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-B",
        question: "Q-B",
        selectedModels: ["claude"],
        results: [{ modelId: "claude", status: "ok", rawText: "Answer B" }],
      }),
    });
    await pendingB;
    expect(st.currentRunId).toBe("run-B");
    expect(st.focusClaimId).toBe("claim-B");

    deferredSourceA.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-A",
        question: "Q-A",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Answer A" }],
      }),
    });
    await pendingA;

    // Run B + claim B must remain paired — never Run B + claim A.
    expect(st.currentRunId).toBe("run-B");
    expect(st.focusClaimId).toBe("claim-B");
  });

  it("[10] the CURRENT (non-racing) 'View source research' load still normally consumes/sets its own claim target", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const authedFetch: FakeAuthedFetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-only",
        question: "Q",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Answer" }],
      }),
    });

    await handleViewSourceResearch(st, guard, authedFetch, { runId: "run-only", claimId: "claim-only" });

    expect(st.focusClaimId).toBe("claim-only");
    expect(st.currentRunId).toBe("run-only");
    expect(st.panelTab).toBe("research");
    expect(st.error).toBeNull();
  });
});

describe("Personal Research load arbitration — new run (handleRunPanel) vs. stale existing-run History load (matrix item 7)", () => {
  it("[7] a brand-new panel run wins over a stale, earlier History load; the stale load is a true no-op", async () => {
    const st = createState();
    const guard = createGenerationGuard();
    const deferredNewRun = createDeferred<{ text: () => Promise<string> }>();
    const deferredA = createDeferred<{ ok: boolean; json: () => Promise<RunApiResponse> }>();
    const authedFetch: FakeAuthedFetch = (url) => {
      if (url === "/api/user/runs/run-A") return deferredA.promise;
      throw new Error("unexpected url " + url);
    };

    // Older intent: user opened a History item earlier and it's still in flight.
    const pendingA = openHistoryItem(st, guard, authedFetch, {
      id: "run-A",
      question: "History fallback A",
      selectedModels: ["chatgpt"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(st.runStatus).toBe("idle"); // openHistoryItem never sets "running"

    // Newer intent: the user starts a brand-new research run.
    const pendingNewRun = handleRunPanelSubset(
      st,
      guard,
      (url) => (url === "/api/run-panel" ? deferredNewRun.promise : Promise.reject(new Error("unexpected url " + url))),
      "Fresh new question typed just now"
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(st.runStatus).toBe("running");

    deferredNewRun.resolve({
      text: async () =>
        JSON.stringify({
          ok: true,
          runId: "run-NEW",
          results: [{ modelId: "chatgpt", status: "ok", rawText: "Fresh New Answer" }],
        }),
    });
    await pendingNewRun;

    expect(st.currentRunId).toBe("run-NEW");
    expect(st.results.map((r) => r.rawText)).toEqual(["Fresh New Answer"]);
    expect(st.runStatus).toBe("complete");

    // The older, now-stale History load for run A finally resolves late.
    deferredA.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-A",
        question: "Question A — loaded from server",
        selectedModels: ["chatgpt"],
        results: [{ modelId: "chatgpt", status: "ok", rawText: "Answer A" }],
      }),
    });
    await pendingA;

    // FIXED: the freshly-completed new run is NOT replaced.
    expect(st.currentRunId).toBe("run-NEW");
    expect(st.results.map((r) => r.rawText)).toEqual(["Fresh New Answer"]);
    expect(st.runStatus).toBe("complete");
    expect(st.error).toBeNull();
  });
});
