/**
 * PR #329 R5 (R4 review MAJOR-1, owner ruling) — the pre-telemetry URL scrub
 * contract, derived from the PRODUCTION URL PRODUCERS (source inventory at
 * origin/main cabbdbb and at the branch; see the PR body), not from the
 * scrub's implementation.
 *
 * Contract under test (`scrubUrlBeforeTelemetry`, which runs first in
 * instrumentation-client.ts and immediately before posthog.init):
 *   - nested `redirect=` / `next=` targets are decoded recursively within
 *     explicit bounds; content found inside is moved into the identity-bound
 *     hand-off (memory hold when storage is blocked) and the nested target is
 *     rewritten to its clean form, so the post-auth redirect still lands there;
 *     beyond the bounds the parameter is dropped entirely (fail closed);
 *   - every other content-bearing parameter / fragment is dropped; only
 *     telemetry-safe and registered routing parameters stay, byte-for-byte;
 *   - the telemetry sanitizer and the scrub share ONE rule source.
 * Every inventory entry (P*, R*, H*) maps to at least one case below, plus a
 * seeded property test over random nesting / encoding. Synthetic sentinels only.
 */
jest.mock("@/lib/firebase/admin", () => ({ adminDb: null }));
import { randomUUID } from "crypto";
import * as prefill from "@/lib/client/verifyPrefill";
import { buildDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";
import { personalResearchVerifyClaimHref } from "@/lib/user/personalResearchHref";
import { teamClaimOriginHandoffHref } from "@/lib/workspaces/teamClaimOriginHandoff";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { scrubUrlBeforeTelemetry } from "@/lib/privacy/preTelemetryUrlScrub";
import { SAFE_QUERY_PARAMS, sanitizeUrl } from "@/lib/privacy/sanitizeUrl";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { FakeStorage } from "@/lib/client/__tests__/helpers/fakeStorage";

const SENTINEL = "ZQX7R5SENTINEL";
const CLAIM = `the moon is hollow ${SENTINEL} & tides obey wind farms?`;
const UTM = "utm_source=newsletter&utm_campaign=Spring%20Sale";
const enc = encodeURIComponent;

// R5 correction (review MAJOR-1): routing ids come from the REAL generators, never invented literals.
const RUN_ID = `run-${randomUUID()}`; // app/api/run-panel/route.ts
const CLAIM_ID = buildDeepResearchClaimId({ runId: RUN_ID, section: "findings", index: 3, finding: { id: "f-1", summary: "a finding" } })!;
const LOW_CLAIM_ID = buildDeepResearchClaimId({ runId: RUN_ID, section: "lowConfidenceFindings", index: 0, finding: { id: "f-2", summary: "another" } })!;
const VERIFY_CLAIM_HREF = personalResearchVerifyClaimHref({ runId: RUN_ID, claimId: CLAIM_ID })!;
const TEAM_CLAIM_HREF = teamClaimOriginHandoffHref({ workspaceId: "Wq8k2LmN4pR7sT1vX3yZ", runId: RUN_ID, claimId: LOW_CLAIM_ID });
const PERSONAL_WS = (getPersonalWorkspaceId("Ab3dE5gH7jK9mN1pQ3sT5vX7zB9d") as { workspaceId: string }).workspaceId;
const VCL_ID = `vcl-${randomUUID()}`; // app/api/verify-claim/route.ts
const VID_ID = `vid-${randomUUID()}`; // app/api/verify-video/route.ts

type Win = {
  location: { pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState: (s: unknown, t: string, url: string) => void };
  document: { referrer: string };
  sessionStorage: Storage | null;
};

function makeWindow(path: string, opts: { storage?: "normal" | "blocked"; referrer?: string } = {}): Win & { storageObj: FakeStorage } {
  const storageObj = new FakeStorage();
  const win: any = {
    location: { pathname: "/", search: "", hash: "" },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => setUrl(win, url) },
    document: { referrer: opts.referrer ?? "" },
    storageObj,
  };
  if (opts.storage === "blocked") {
    Object.defineProperty(win, "sessionStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
  } else {
    win.sessionStorage = storageObj;
  }
  setUrl(win, path);
  return win;
}

function setUrl(win: any, url: string) {
  // Split exactly like a browser Location (no normalization of the query / fragment bytes).
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const qAt = beforeHash.indexOf("?");
  win.location.pathname = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  win.location.search = qAt === -1 ? "" : beforeHash.slice(qAt);
  if (win.location.search === "?") win.location.search = "";
  win.location.hash = hash === "#" ? "" : hash;
}
const href = (win: Win) => `${win.location.pathname}${win.location.search}${win.location.hash}`;

/** Decodes repeatedly so a sentinel hidden under any number of encodings is still found. */
function deepDecode(s: string): string {
  let cur = s;
  for (let i = 0; i < 8; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur.replace(/\+/g, " "));
    } catch {
      next = unescape(cur);
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function pendingText(win: Win & { storageObj: FakeStorage }, blocked: boolean): string {
  return prefill.readVisiblePendingVerifyInput(blocked ? null : win.storageObj, null);
}
function handoff(win: Win & { storageObj: FakeStorage }, kind: "verify" | "research", blocked: boolean): string | null {
  return prefill.consumeAppHandoff(kind, null, blocked ? null : win.storageObj);
}

beforeEach(() => {
  prefill.__resetTabHandoffMemoryForTests();
});

type Expect = { url: string; pending?: string; verify?: string; research?: string; landing?: string };
/** [inventory id, label, url, expected] — derived from the producer inventory (url-producer-inventory.md). */
const INVENTORY: Array<[string, string, string, Expect]> = [
  // A. content-bearing producers
  ["P1 main", "extension query link", `/verify?source=extension&text=${enc(CLAIM)}&${UTM}`, { url: `/verify?source=extension&${UTM}`, pending: CLAIM }],
  ["P1/P2 branch", "extension fragment link", `/verify?source=extension#text=${enc(CLAIM)}`, { url: `/verify?source=extension`, pending: CLAIM }],
  [
    "P3 main",
    "verify signup CTA (nested ?text=)",
    `/signup?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}&${UTM}`,
    { url: `/signup?redirect=${enc("/verify?source=extension")}&${UTM}`, pending: CLAIM, landing: "/verify?source=extension" },
  ],
  [
    "P4 main",
    "verify login link (nested ?text=)",
    `/login?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}`,
    { url: `/login?redirect=${enc("/verify?source=extension")}`, pending: CLAIM, landing: "/verify?source=extension" },
  ],
  ["P5 main", "Run Claim Verification", `/?tab=verify&claim=${enc(CLAIM)}&${UTM}`, { url: `/?tab=verify&${UTM}`, verify: CLAIM }],
  ["P6 main", "Run Deep Research", `/?tab=research&q=${enc(CLAIM)}`, { url: `/?tab=research`, research: CLAIM }],
  ["P7 main", "Run follow-up (personalResearchFollowUpHref)", `/?tab=research&q=${enc(CLAIM.trim())}`, { url: `/?tab=research`, research: CLAIM.trim() }],
  [
    "P8",
    "signup -> onboarding (safeRedirect decoded twice: raw claim inside the nested target)",
    `/onboarding?redirect=${enc(`/verify?source=extension&text=${CLAIM}`)}`,
    // The over-decoded claim is split at its own "&": the part before it is moved to the hand-off, the rest is dropped.
    { url: `/onboarding?redirect=${enc("/verify?source=extension")}`, pending: `the moon is hollow ${SENTINEL} `, landing: "/verify?source=extension" },
  ],
  [
    "P8 next=",
    "signup reads `next` too",
    `/onboarding?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`,
    { url: `/onboarding?redirect=${enc("/verify")}`, pending: CLAIM, landing: "/verify" },
  ],
  [
    "P9",
    "login 'Sign up free' copies the nested target",
    `/signup?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`,
    { url: `/signup?redirect=${enc("/verify")}`, pending: CLAIM, landing: "/verify" },
  ],
  ["P10/P11", "post-auth landing on the nested target", `/verify?text=${enc(CLAIM)}`, { url: `/verify`, pending: CLAIM }],
  ["P12", "legacy main-app reader (bookmark)", `/?tab=verify&claim=${enc(CLAIM)}`, { url: `/?tab=verify`, verify: CLAIM }],
  ["H2 next", "login ?next= with nested claim", `/login?next=${enc(`/verify?text=${enc(CLAIM)}`)}`, { url: `/login?next=${enc("/verify")}`, pending: CLAIM, landing: "/verify" }],
  [
    "H3",
    "login -> signup -> verify (two levels of nesting)",
    `/login?redirect=${enc(`/signup?redirect=${enc(`/verify?source=extension&text=${enc(CLAIM)}`)}`)}`,
    { url: `/login?redirect=${enc(`/signup?redirect=${enc("/verify?source=extension")}`)}`, pending: CLAIM },
  ],
  [
    "H5a",
    "nested legacy main-app claim link",
    `/login?redirect=${enc(`/?tab=verify&claim=${enc(CLAIM)}`)}`,
    { url: `/login?redirect=${enc("/?tab=verify")}`, verify: CLAIM, landing: "/?tab=verify" },
  ],
  [
    "H5a research",
    "nested legacy main-app question link",
    `/signup?redirect=${enc(`/?tab=research&q=${enc(CLAIM)}`)}`,
    { url: `/signup?redirect=${enc("/?tab=research")}`, research: CLAIM, landing: "/?tab=research" },
  ],
  [
    "H5b",
    "nested extension fragment",
    `/signup?redirect=${enc(`/verify?source=extension#text=${enc(CLAIM)}`)}`,
    { url: `/signup?redirect=${enc("/verify?source=extension")}`, pending: CLAIM, landing: "/verify?source=extension" },
  ],
  [
    "H5c",
    "double-encoded nested target",
    `/login?redirect=${enc(enc(`/verify?text=${enc(CLAIM)}`))}`,
    { url: `/login?redirect=${enc("/verify")}`, pending: CLAIM, landing: "/verify" },
  ],
  ["H1 trailing", "/verify/ with fragment", `/verify/#text=${enc(CLAIM)}`, { url: `/verify/`, pending: CLAIM }],
  // B. routing-only producers: unchanged byte-for-byte
  ["R1", "middleware ?next=", `/login?next=%2Fadmin%2Fusers`, { url: `/login?next=%2Fadmin%2Fusers`, landing: "/admin/users" }],
  ["R2", "admin layout ?next=", `/login?next=/admin`, { url: `/login?next=/admin`, landing: "/admin" }],
  ["R3", "invitation login redirect", `/login?redirect=%2Fworkspace-invitations%2Faccept`, { url: `/login?redirect=%2Fworkspace-invitations%2Faccept`, landing: "/workspace-invitations/accept" }],
  ["R4", "invitation fragment (pre-existing, out of scope)", `/workspace-invitations/accept#invitationId=inv_123&token=tok_ABC-9`, { url: `/workspace-invitations/accept#invitationId=inv_123&token=tok_ABC-9` }],
  ["R5", "Stripe success_url", `/billing?success=true&session_id=cs_test_a1B2c3D4e5`, { url: `/billing?success=true&session_id=cs_test_a1B2c3D4e5` }],
  ["R5 cancel", "Stripe cancel_url", `/billing?canceled=true`, { url: `/billing?canceled=true` }],
  ["R7", "pricing -> billing", `/billing?plan=lite&interval=year&upgraded=1`, { url: `/billing?plan=lite&interval=year&upgraded=1` }],
  ["R8", "signed out", `/login?signedOut=1&sessionClearFailed=1`, { url: `/login?signedOut=1&sessionClearFailed=1` }],
  ["R9", "origin-linked claim mode (real builders)", VERIFY_CLAIM_HREF, { url: VERIFY_CLAIM_HREF }],
  ["R10", "team claim origin (real builders)", TEAM_CLAIM_HREF, { url: TEAM_CLAIM_HREF }],
  ["R11", "governance deep link", `/?openResearchRun=${RUN_ID}&${UTM}`, { url: `/?openResearchRun=${RUN_ID}&${UTM}` }],
  ["R11 v", "verification deep link", `/?openVerification=${VCL_ID}&openVideoVerification=${VID_ID}`, { url: `/?openVerification=${VCL_ID}&openVideoVerification=${VID_ID}` }],
  ["R12", "team review queue", `/team/reviews?kind=adaptive&flagged=true&reviewable=false&page=2`, { url: `/team/reviews?kind=adaptive&flagged=true&reviewable=false&page=2` }],
  ["R13", "workspace review queue", `/workspace/reviews?workspace=${PERSONAL_WS}&view=needs_review&project=unfiled`, { url: `/workspace/reviews?workspace=${PERSONAL_WS}&view=needs_review&project=unfiled` }],
  ["R14/R15", "branch return path + tab", `/signup?redirect=%2Fverify%3Fsource%3Dextension`, { url: `/signup?redirect=%2Fverify%3Fsource%3Dextension`, landing: "/verify?source=extension" }],
  ["anchor", "plain in-page anchor", `/pricing#faq`, { url: `/pricing#faq` }],
  ["utm +", "UTM with + kept byte-for-byte", `/pricing?utm_campaign=Spring+Sale&utm_source=x`, { url: `/pricing?utm_campaign=Spring+Sale&utm_source=x` }],
  // Unknown content-bearing shapes: fail closed (dropped, never captured).
  ["unknown 1", "question param on any page", `/pricing?question=${enc(CLAIM)}&${UTM}`, { url: `/pricing?${UTM}` }],
  ["unknown 2", "claim without tab", `/?claim=${enc(CLAIM)}`, { url: `/` }],
  ["unknown 3", "text param off /verify", `/signup?text=${enc(CLAIM)}`, { url: `/signup` }],
  ["unknown 4", "unregistered param name", `/pricing?foo=${enc(CLAIM)}`, { url: `/pricing` }],
  ["unknown 5", "content in key position", `/pricing?${enc(CLAIM)}`, { url: `/pricing` }],
  ["unknown 6", "routing name, content-shaped value", `/?openResearchRun=${enc(CLAIM)}&tab=research`, { url: `/?tab=research` }],
  ["unknown 7", "fragment text on another page", `/#text=${enc(CLAIM)}`, { url: `/` }],
  ["unknown 8", "free-text fragment", `/pricing#${enc(CLAIM)}`, { url: `/pricing` }],
  ["unknown 9", "selectedText", `/verify?selectedText=${enc(CLAIM)}`, { url: `/verify` }],
  ["unknown 10", "nested path segment carrying content", `/login?redirect=${enc(`/learn/${enc(CLAIM)}`)}`, { url: `/login` }],
  ["unknown 11", "nested external target", `/login?redirect=${enc(`https://evil.example/?q=${enc(CLAIM)}`)}`, { url: `/login` }],
  ["unknown 12", "nested unknown param", `/login?redirect=${enc(`/pricing?foo=${enc(CLAIM)}`)}`, { url: `/login?redirect=${enc("/pricing")}`, landing: "/pricing" }],
  ["unknown 13", "tab enum carrying content", `/?tab=${enc(CLAIM)}`, { url: `/` }],
  ["unknown 14", "semicolon smuggling", `/?tab=verify;claim=${enc(CLAIM)}`, { url: `/` }],
];

describe("pre-init scrub: every producer in the inventory (sessionStorage working and blocked)", () => {
  for (const [id, label, url, exp] of INVENTORY) {
    for (const mode of ["normal", "blocked"] as const) {
      it(`${id} ${label} [${mode}]`, () => {
        const win = makeWindow(url, { storage: mode });
        scrubUrlBeforeTelemetry(win as any);
        expect(href(win)).toBe(exp.url);
        expect(deepDecode(href(win))).not.toContain(SENTINEL);
        const blocked = mode === "blocked";
        expect(pendingText(win, blocked)).toBe(exp.pending ?? "");
        expect(deepDecode(href(win))).not.toContain("tides");
        // The app hand-off is one-time (consuming ANY kind removes it), so each kind is read from its own fresh load.
        for (const kind of ["verify", "research"] as const) {
          prefill.__resetTabHandoffMemoryForTests();
          const fresh = makeWindow(url, { storage: mode });
          scrubUrlBeforeTelemetry(fresh as any);
          expect(handoff(fresh, kind, blocked)).toBe(exp[kind] ?? null);
        }
        if (exp.landing !== undefined) {
          // The post-auth redirect (login/signup/onboarding read `redirect || next`, then safeRedirect) still lands there.
          const params = new URLSearchParams(win.location.search);
          expect(safeRedirect(params.get("redirect") || params.get("next"), "/")).toBe(exp.landing);
        }
        // Idempotent: a second scrub (PostHogProvider, ContentHandoffMigrator) changes nothing.
        const before = href(win);
        scrubUrlBeforeTelemetry(win as any);
        expect(href(win)).toBe(before);
      });
    }
  }
});

describe("pre-init scrub: explicit bounds, fail closed", () => {
  const nest = (inner: string, levels: number) => {
    let t = inner;
    for (let i = 0; i < levels; i++) t = `/login?redirect=${enc(t)}`;
    return t;
  };
  it("nesting within the depth bound is cleaned and kept", () => {
    const win = makeWindow(nest(`/verify?text=${enc(CLAIM)}`, 3));
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe(nest("/verify", 3));
    expect(pendingText(win, false)).toBe(CLAIM);
  });
  it("nesting beyond the depth bound: the top-level parameter is dropped entirely", () => {
    const win = makeWindow(nest(`/verify?text=${enc(CLAIM)}`, 6));
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe("/login");
    expect(deepDecode(href(win))).not.toContain(SENTINEL);
  });
  it("beyond the depth bound even when the innermost target carries nothing", () => {
    const win = makeWindow(nest(`/verify`, 6));
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe("/login");
  });
  it("a nested target longer than the length bound is dropped", () => {
    const long = `/verify?text=${enc(`${SENTINEL} ${"x".repeat(5000)}`)}`;
    const win = makeWindow(`/signup?redirect=${enc(long)}&${UTM}`);
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe(`/signup?${UTM}`);
  });
  it("encoded more times than the decode bound: dropped", () => {
    let v = `/verify?text=${enc(CLAIM)}`;
    for (let i = 0; i < 6; i++) v = enc(v);
    const win = makeWindow(`/login?redirect=${v}`);
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe("/login");
    expect(deepDecode(href(win))).not.toContain(SENTINEL);
  });
  it("malformed percent-encoding in a nested target: dropped", () => {
    const win = makeWindow(`/login?redirect=%2Fverify%3Ftext%3D${SENTINEL}%E0%A4%A`);
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe("/login");
  });
});

describe("one rule source for the telemetry sanitizer and the pre-init scrub", () => {
  it("lib/privacy/urlParamRules exports the shared registry and the sanitizer uses it", () => {
    const rules = require("@/lib/privacy/urlParamRules");
    expect(rules.SAFE_QUERY_PARAM_SHAPES).toBeDefined();
    expect(Array.from(rules.SAFE_QUERY_PARAM_SHAPES.keys())).toEqual(Array.from(SAFE_QUERY_PARAMS));
    // Routing values stay in the address bar but are NEVER transmitted: the sanitizer redacts them.
    for (const name of Array.from(rules.ROUTING_PARAM_SHAPES.keys()) as string[]) {
      expect(SAFE_QUERY_PARAMS.has(name)).toBe(false);
      expect(sanitizeUrl(`/x?${name}=abc`)).toBe(`/x?${name}=[redacted]`);
    }
    for (const name of [...rules.NESTED_TARGET_PARAMS, ...rules.CONTENT_PARAMS] as string[]) {
      expect(SAFE_QUERY_PARAMS.has(name)).toBe(false);
      expect(rules.ROUTING_PARAM_SHAPES.has(name)).toBe(false);
    }
  });
  it("PostHog's personal-data mask list is derived from the same registry", () => {
    const rules = require("@/lib/privacy/urlParamRules");
    jest.isolateModules(() => {
      jest.doMock("posthog-js", () => ({ __esModule: true, default: {} }));
      jest.doMock("posthog-js/react", () => ({ PostHogProvider: () => null }));
      jest.doMock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
      const { POSTHOG_CONTENT_PARAMS } = require("@/components/PostHogProvider");
      expect([...POSTHOG_CONTENT_PARAMS].sort()).toEqual([...rules.CONTENT_PARAMS, ...rules.NESTED_TARGET_PARAMS].sort());
    });
  });
});

// ── property test: random nesting / encoding of content inside redirect / next ──
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PUNCT = [" ", " & ", "=", "?", "#", "%", "/", "+", ";", ":", "'", '"', "<", ">", ",", "!", "é", "中", "\u{1F600}", "%25", "%26", "&amp;", "\n"];
const WORDS = ["vaccines", "tides", "the", "Moon", "is", "hollow", "wind", "farms", "cure", "thirst", "x=1", "a&b", "tab=verify", "redirect=/x"];

function randomContent(rnd: () => number, n: number): string {
  const parts: string[] = [];
  const len = 2 + Math.floor(rnd() * 8);
  const at = Math.floor(rnd() * len);
  for (let i = 0; i < len; i++) {
    if (i === at) parts.push(`${SENTINEL}${n}`);
    else parts.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    parts.push(PUNCT[Math.floor(rnd() * PUNCT.length)]);
  }
  return parts.join("");
}
type Encoding = "once" | "twice" | "raw";
function encodeAs(value: string, how: Encoding): string {
  if (how === "raw") {
    // Over-decoding producer (P8: signup's safeRedirect decodes the nested target once more, then encodes once).
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      /* safeRedirect would throw here; keep the value */
    }
    return enc(decoded);
  }
  return how === "twice" ? enc(enc(value)) : enc(value);
}

describe("property: random nesting / encoding of content inside redirect / next never survives the scrub", () => {
  const rnd = mulberry32(0x5eed_329);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const N = 400;
  const cases: Array<{ url: string; utm: boolean; n: number }> = [];
  for (let n = 0; n < N; n++) {
    const content = randomContent(rnd, n);
    const base = pick([
      (c: string) => `/verify?source=extension&text=${enc(c)}`,
      (c: string) => `/verify?source=extension#text=${enc(c)}`,
      (c: string) => `/?tab=verify&claim=${enc(c)}`,
      (c: string) => `/?tab=research&q=${enc(c)}`,
      (c: string) => `/pricing?question=${enc(c)}`,
      (c: string) => `/?foo=${enc(c)}&tab=research`,
      (c: string) => `/verify?text=${c.replace(/[&#?]/g, " ")}`,
    ])(content);
    let target = base;
    const depth = Math.floor(rnd() * 4);
    for (let d = 0; d < depth; d++) {
      const page = pick(["/signup", "/login", "/onboarding"]);
      const param = pick(["redirect", "next"]);
      target = `${page}?${param}=${encodeAs(target, pick(["once", "once", "twice", "raw"] as const))}`;
    }
    const utm = rnd() < 0.5 && !target.includes("#");
    if (utm) target += `${target.includes("?") ? "&" : "?"}${UTM}`;
    cases.push({ url: target, utm, n });
  }

  for (const mode of ["normal", "blocked"] as const) {
    it(`${N} generated URLs [${mode}]: no sentinel in the address bar or referrer; only allowlisted / routing params remain; UTM byte-for-byte`, () => {
      const rules = require("@/lib/privacy/urlParamRules");
      const failures: string[] = [];
      for (const c of cases) {
        prefill.__resetTabHandoffMemoryForTests();
        const win = makeWindow(c.url, { storage: mode, referrer: `https://convergepanel.com${c.url}` });
        scrubUrlBeforeTelemetry(win as any);
        const out = href(win);
        const decoded = deepDecode(out);
        if (decoded.includes(SENTINEL)) failures.push(`#${c.n} url: ${out}`);
        if (deepDecode(win.document.referrer).includes(SENTINEL)) failures.push(`#${c.n} referrer`);
        if (c.utm && !out.includes(UTM)) failures.push(`#${c.n} utm lost: ${out}`);
        for (const [name, value] of Array.from(new URLSearchParams(win.location.search).entries())) {
          const safe = SAFE_QUERY_PARAMS.has(name);
          const routing = rules.ROUTING_PARAM_SHAPES.has(name) || rules.NESTED_TARGET_PARAMS.includes(name);
          if (!safe && !routing) failures.push(`#${c.n} unregistered param ${name}`);
          if (rules.NESTED_TARGET_PARAMS.includes(name) && deepDecode(value).includes(SENTINEL)) failures.push(`#${c.n} nested`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("NIT (R4 review): isTabStorageUsable is the /verify useSyncExternalStore snapshot — it must not write on every call", () => {
  it("probes a given storage at most once", () => {
    const s = new FakeStorage();
    const setItem = jest.spyOn(s, "setItem");
    for (let i = 0; i < 10; i++) expect(prefill.isTabStorageUsable(s)).toBe(true);
    expect(setItem.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("a storage that refuses writes is reported unusable, also on repeated calls", () => {
    const s = new FakeStorage();
    const setItem = jest.spyOn(s, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    for (let i = 0; i < 10; i++) expect(prefill.isTabStorageUsable(s)).toBe(false);
    expect(setItem.mock.calls.length).toBeLessThanOrEqual(1);
    expect(prefill.isTabStorageUsable(null)).toBe(false);
  });
});

describe("R5 (orchestrator A2 finding): Replay navigation.push `data.previous` is a URL key", () => {
  it("a navigation custom event's previous / from / to are sanitized", () => {
    const { scrubReplayRecordingEvent } = require("@/lib/privacy/sentryScrub");
    const dirty = `https://convergepanel.com/signup?redirect=${enc(`/verify?text=${enc(CLAIM)}`)}`;
    const ev = { type: 5, data: { tag: "performanceSpan", payload: { op: "navigation.push", data: { previous: dirty, from: dirty, to: dirty } } } };
    scrubReplayRecordingEvent(ev);
    expect(deepDecode(JSON.stringify(ev))).not.toContain(SENTINEL);
    expect(ev.data.payload.data.previous).toBe("https://convergepanel.com/signup?redirect=[redacted]");
  });
});

describe("over-decoded nested targets (P8): a claim that itself contains `&<allowlisted name>=` cannot smuggle a param", () => {
  it.each([
    ["utm_source", `hello & utm_source=${SENTINEL} world`],
    ["source", `hello &source=zqx7r5sentinel`],
    ["tab", `hello &tab=verify&utm_campaign=${SENTINEL}`],
    ["redirect", `x &redirect=/verify?text=${SENTINEL}`],
  ])("%s", (_name, claim) => {
    const win = makeWindow(`/onboarding?redirect=${enc(`/verify?source=extension&text=${claim}`)}`);
    scrubUrlBeforeTelemetry(win as any);
    expect(href(win)).toBe(`/onboarding?redirect=${enc("/verify?source=extension")}`);
    expect(deepDecode(href(win)).toLowerCase()).not.toContain(SENTINEL.toLowerCase());
  });
});
