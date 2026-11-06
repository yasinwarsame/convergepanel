/**
 * MINOR-A (review of 1ee4982): opening History items — the loading indicator and stale completions.
 *
 * Behavioural: the REAL shipped control flow (lib/client/historyDetailOpen.ts) runs against a fake page state, with
 * every read a deferred promise the test resolves or rejects in a chosen order. The page derives its "Loading saved
 * research run…" / verify / video banners, the hidden composers and the disabled History button from `loadingId`, so
 * `loadingId` is the observable that must never get stuck. The last block pins app/page.tsx to this module (the page
 * cannot be mounted under ts-jest).
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  createHistoryDetailOpenCoordinator,
  openSavedClaimVerification,
  openSavedVideoVerification,
  VIDEO_HISTORY_LOAD_ERROR,
  type HistoryDetailOpenCoordinator,
} from "@/lib/client/historyDetailOpen";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const claim = (id: string) =>
  ({ verificationId: id, claim: `claim ${id}`, modelIndependence: "independent" }) as unknown as ClaimVerificationClientPayload;
/** Cached before model independence was recorded: opening it reads the record. */
const legacyClaim = (id: string) => ({ claim: `claim ${id}` }) as unknown as ClaimVerificationClientPayload;
const video = (id: string) => ({ verificationId: id, governanceStatus: undefined }) as unknown as VideoVerificationClientPayload;

function page() {
  const st = {
    loadingId: null as string | null,
    claim: null as ClaimVerificationClientPayload | null,
    video: null as VideoVerificationClientPayload | null,
    error: null as string | null,
    claimInput: "",
    claimRecordsRead: [] as string[],
    videoRecordsRead: [] as string[],
  };
  const opens: HistoryDetailOpenCoordinator = createHistoryDetailOpenCoordinator((id) => {
    st.loadingId = id;
  });
  // The page's synchronous surface clears before each branch, then the flow. The page ALSO calls opens.supersede()
  // first (supersedeRunningResearch); it is deliberately left out here so the module alone is proven to replace the
  // indicator and to guard stale completions (the wiring block below pins the page's extra supersede).
  const openVideo = (id: string, read: (() => Promise<{ ok?: boolean; payload?: VideoVerificationClientPayload }>) | null) => {
    st.claim = null;
    st.video = null;
    st.error = null;
    return openSavedVideoVerification(opens, id, read, {
      setPayload: (p) => (st.video = p),
      setError: (e) => (st.error = e),
      onRecordRead: (p) => st.videoRecordsRead.push(p.verificationId),
    });
  };
  const openClaim = (
    id: string,
    cached: ClaimVerificationClientPayload | undefined,
    lookup: (() => Promise<ClaimVerificationClientPayload | null>) | null
  ) => {
    st.video = null;
    return openSavedClaimVerification(opens, { id, title: `title ${id}`, payload: cached }, lookup, {
      setPayload: (p) => (st.claim = p),
      setClaimInput: (c) => (st.claimInput = c),
      onRecordRead: (r) => st.claimRecordsRead.push(r.verificationId),
    });
  };
  const openResearch = () => {
    opens.begin(null);
  };
  return { st, opens, openVideo, openClaim, openResearch };
}

describe("each open owns its loading indicator", () => {
  it("a slow read shows its own id while pending and clears it when it settles", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const done = p.openVideo("A", () => a.promise);
    expect(p.st.loadingId).toBe("A");
    a.resolve({ ok: true, payload: video("A") });
    await done;
    expect(p.st).toMatchObject({ loadingId: null, video: { verificationId: "A" }, error: null });
  });

  it("slow video A, then cached claim B: B clears A's indicator at once and A's late completion changes nothing", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneA = p.openVideo("A", () => a.promise);
    expect(p.st.loadingId).toBe("A");
    await p.openClaim("B", claim("B"), async () => {
      throw new Error("a cached independent payload must not be re-read");
    });
    expect(p.st.loadingId).toBeNull();
    expect(p.st.claim?.verificationId).toBe("B");
    a.resolve({ ok: true, payload: video("A") });
    await doneA;
    expect(p.st).toMatchObject({ loadingId: null, video: null, error: null, claim: { verificationId: "B" } });
    expect(p.st.videoRecordsRead).toEqual([]);
  });

  it("slow claim A (record lookup), then cached claim B: same", async () => {
    const p = page();
    const a = deferred<ClaimVerificationClientPayload | null>();
    const doneA = p.openClaim("A", undefined, () => a.promise);
    expect(p.st.loadingId).toBe("A");
    await p.openClaim("B", claim("B"), null);
    expect(p.st.loadingId).toBeNull();
    a.resolve(claim("A"));
    await doneA;
    expect(p.st).toMatchObject({ loadingId: null, claim: { verificationId: "B" }, claimInput: "claim B" });
    expect(p.st.claimRecordsRead).toEqual([]);
  });

  it("cached claim A, then slow video B: B's indicator is shown until B settles", async () => {
    const p = page();
    await p.openClaim("A", claim("A"), null);
    expect(p.st.loadingId).toBeNull();
    const b = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneB = p.openVideo("B", () => b.promise);
    expect(p.st.loadingId).toBe("B");
    b.resolve({ ok: true, payload: video("B") });
    await doneB;
    expect(p.st).toMatchObject({ loadingId: null, video: { verificationId: "B" } });
  });

  it("slow video A, then a research run (navigates, reads nothing here): A's indicator is cleared at once", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneA = p.openVideo("A", () => a.promise);
    p.openResearch();
    expect(p.st.loadingId).toBeNull();
    a.resolve({ ok: true, payload: video("A") });
    await doneA;
    expect(p.st).toMatchObject({ loadingId: null, video: null });
  });

  it("slow video A, then a signed-out video open B (no read): A's indicator is cleared", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneA = p.openVideo("A", () => a.promise);
    await p.openVideo("B", null);
    expect(p.st.loadingId).toBeNull();
    a.resolve({ ok: true, payload: video("A") });
    await doneA;
    expect(p.st).toMatchObject({ loadingId: null, video: null, error: null });
  });

  it("a tab change (supersede) clears a pending open's indicator and its late completion commits nothing", async () => {
    const p = page();
    const a = deferred<ClaimVerificationClientPayload | null>();
    const doneA = p.openClaim("A", undefined, () => a.promise);
    p.opens.supersede();
    expect(p.st.loadingId).toBeNull();
    a.resolve(claim("A"));
    await doneA;
    expect(p.st.claim).toBeNull();
    expect(p.st.claimRecordsRead).toEqual([]);
  });
});

describe("quick switching between slow reads: only the latest selection commits", () => {
  it("A then B, A finishes LAST: B is shown, A never overwrites it, B's indicator was B's", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const b = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneA = p.openVideo("A", () => a.promise);
    const doneB = p.openVideo("B", () => b.promise);
    expect(p.st.loadingId).toBe("B");
    b.resolve({ ok: true, payload: video("B") });
    await doneB;
    expect(p.st).toMatchObject({ loadingId: null, video: { verificationId: "B" } });
    a.resolve({ ok: true, payload: video("A") });
    await doneA;
    expect(p.st).toMatchObject({ loadingId: null, video: { verificationId: "B" }, error: null });
    expect(p.st.videoRecordsRead).toEqual(["B"]);
  });

  it("A then B, A finishes FIRST: A commits nothing and does not clear B's indicator", async () => {
    const p = page();
    const a = deferred<ClaimVerificationClientPayload | null>();
    const b = deferred<ClaimVerificationClientPayload | null>();
    const doneA = p.openClaim("A", undefined, () => a.promise);
    const doneB = p.openClaim("B", undefined, () => b.promise);
    a.resolve(claim("A"));
    await doneA;
    expect(p.st).toMatchObject({ loadingId: "B", claim: null, claimInput: "title B" });
    b.resolve(claim("B"));
    await doneB;
    expect(p.st).toMatchObject({ loadingId: null, claim: { verificationId: "B" }, claimInput: "claim B" });
    expect(p.st.claimRecordsRead).toEqual(["B"]);
  });

  it("claim A then video B then claim C, resolved in reverse: only C is shown", async () => {
    const p = page();
    const a = deferred<ClaimVerificationClientPayload | null>();
    const b = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const c = deferred<ClaimVerificationClientPayload | null>();
    const doneA = p.openClaim("A", undefined, () => a.promise);
    const doneB = p.openVideo("B", () => b.promise);
    const doneC = p.openClaim("C", undefined, () => c.promise);
    c.resolve(claim("C"));
    await doneC;
    b.resolve({ ok: true, payload: video("B") });
    a.resolve(claim("A"));
    await Promise.all([doneA, doneB]);
    expect(p.st).toMatchObject({ loadingId: null, claim: { verificationId: "C" }, video: null, error: null });
  });
});

describe("rejected and failed reads", () => {
  it("the latest video read rejects: error shown, indicator cleared", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneA = p.openVideo("A", () => a.promise);
    a.reject(new Error("network"));
    await doneA;
    expect(p.st).toMatchObject({ loadingId: null, video: null, error: VIDEO_HISTORY_LOAD_ERROR });
  });

  it("the latest video read returns not-ok: error shown, indicator cleared", async () => {
    const p = page();
    await p.openVideo("A", async () => ({ ok: false }));
    expect(p.st).toMatchObject({ loadingId: null, video: null, error: VIDEO_HISTORY_LOAD_ERROR });
  });

  it("a STALE video read rejects: no error is set over the current selection, its indicator untouched", async () => {
    const p = page();
    const a = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const b = deferred<{ ok?: boolean; payload?: VideoVerificationClientPayload }>();
    const doneA = p.openVideo("A", () => a.promise);
    const doneB = p.openVideo("B", () => b.promise);
    a.reject(new Error("network"));
    await doneA;
    expect(p.st).toMatchObject({ loadingId: "B", error: null, video: null });
    b.resolve({ ok: true, payload: video("B") });
    await doneB;
    expect(p.st).toMatchObject({ loadingId: null, error: null, video: { verificationId: "B" } });
  });

  it("the latest claim record read rejects: the cached payload is presented as cached (unverified), indicator cleared", async () => {
    const p = page();
    const cached = legacyClaim("A");
    const a = deferred<ClaimVerificationClientPayload | null>();
    const doneA = p.openClaim("A", cached, () => a.promise);
    expect(p.st.loadingId).toBe("A");
    a.reject(new Error("network"));
    await doneA;
    expect(p.st.loadingId).toBeNull();
    expect(p.st.claim).toEqual({ ...cached, verificationId: "A" });
    expect(p.st.claim?.modelIndependence).toBeUndefined();
    expect(p.st.claimRecordsRead).toEqual([]);
  });

  it("a STALE claim read rejects after a cached claim B: B stays, no indicator", async () => {
    const p = page();
    const a = deferred<ClaimVerificationClientPayload | null>();
    const doneA = p.openClaim("A", legacyClaim("A"), () => a.promise);
    await p.openClaim("B", claim("B"), null);
    a.reject(new Error("network"));
    await doneA;
    await flush();
    expect(p.st).toMatchObject({ loadingId: null, claim: { verificationId: "B" }, claimInput: "claim B" });
  });

  it("signed out, no cached claim: nothing to read, no indicator, nothing presented", async () => {
    const p = page();
    await p.openClaim("A", undefined, null);
    expect(p.st).toMatchObject({ loadingId: null, claim: null, claimInput: "title A" });
  });
});

describe("app/page.tsx is wired to the module (the page cannot be mounted under ts-jest)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "app", "page.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const open = code.slice(code.indexOf("const openHistoryItem = async"), code.indexOf("openHistoryItemRef.current = openHistoryItem;"));

  it("the only writer of the History loading indicator is the coordinator", () => {
    expect(code).toContain("createHistoryDetailOpenCoordinator(setHistoryDetailLoadingId)");
    expect(code.match(/setHistoryDetailLoadingId\(/g)).toBeNull();
    expect(code).not.toContain("historyOpenSeq");
  });

  it("every branch of openHistoryItem goes through it", () => {
    const research = open.slice(open.indexOf('if (item.type === "research")'), open.indexOf('if (item.type === "video_verification")'));
    expect(research.indexOf("opens.begin(null);")).toBeGreaterThan(research.indexOf("supersedeRunningResearch();"));
    expect(research.indexOf("opens.begin(null);")).toBeLessThan(research.indexOf("router.push("));
    expect(open).toContain("await openSavedVideoVerification(opens, item.id, read, {");
    expect(open).toContain("await openSavedClaimVerification(opens, item, lookup, {");
    expect(open).not.toMatch(/setVerificationPayload\(\{|setVideoVerificationPayload\(data/);
  });

  it("newer intent (supersedeRunningResearch) and every tab change end pending opens", () => {
    const sup = code.slice(code.indexOf("const supersedeRunningResearch = useCallback("), code.indexOf("}, [invalidateResearchIntent]);"));
    expect(sup).toContain("historyDetailOpensRef.current.supersede();");
    const tab = code.slice(code.indexOf("const selectPanelTab = useCallback("), code.indexOf("[supersedeRunningResearch]", code.indexOf("const selectPanelTab = useCallback(")));
    expect(tab.indexOf("historyDetailOpensRef.current.supersede();")).toBeGreaterThan(-1);
    expect(tab.indexOf("historyDetailOpensRef.current.supersede();")).toBeLessThan(tab.indexOf("setPanelTab(nextTab);"));
  });
});
