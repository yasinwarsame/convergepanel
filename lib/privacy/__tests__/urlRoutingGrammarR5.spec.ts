/**
 * PR #329 R5 correction (R5 review MAJOR-1) — every routing parameter the
 * pre-telemetry scrub keeps must accept the values the app's REAL generators
 * produce, not invented ids.
 *
 * The defect this exists for: `originClaimId` had the opaque-id shape
 * `^[A-Za-z0-9_-]{1,128}$`, but real claim ids come from
 * `buildDeepResearchClaimId` as `v1:<section>:<index>:<43 base64url>`. The scrub
 * dropped the parameter, so personal "Verify claim" opened an empty Verify tab
 * and a team hand-off broke on reload / back / a shared link. The earlier tests
 * used made-up ids (`claim-7`, `c1`) and passed.
 *
 * Every value below comes from the real builder (or, where the id is built
 * inline in a route, from that route's exact expression). Synthetic content only.
 */
jest.mock("@/lib/firebase/admin", () => ({ adminDb: null }));
// ZCA L-8: the composer page resolves no identity any more (neutral shell); nothing to mock.
// The page returns <TeamWorkspacePage …/>; its props (originTarget) are what this spec reads, so the client component
// itself (and its shells) need not load here.
jest.mock("@/components/workspace/TeamWorkspacePage", () => ({ __esModule: true, default: () => null }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
jest.mock("@/components/workspace/claims/TeamClaimComposerShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "composer" }),
}));

import { randomUUID, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { buildDeepResearchClaimId, parseDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";
import { personalResearchVerifyClaimHref } from "@/lib/user/personalResearchHref";
import { teamClaimOriginHandoffHref, parseTeamClaimOriginQuery } from "@/lib/workspaces/teamClaimOriginHandoff";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { projectFilterToParamValue } from "@/lib/client/workspaceReviewQueueClient";
import { REVIEW_QUEUE_VIEWS } from "@/lib/workspaces/reviewQueuePresentation";
import { parseTeamRunListFilters } from "@/lib/governance/teamRunListContract";
import { scrubUrlBeforeTelemetry } from "@/lib/privacy/preTelemetryUrlScrub";
import { scrubUrlParts } from "@/lib/privacy/urlContentScrub";
import { migrateContentFromUrl, __resetTabHandoffMemoryForTests } from "@/lib/client/verifyPrefill";
import { sanitizeUrl } from "@/lib/privacy/sanitizeUrl";
import * as rules from "@/lib/privacy/urlParamRules";
import TeamUnfiledClaimCreatePage from "@/app/workspace/team/[workspaceId]/claims/new/page";

const SENTINEL = "ZQX7R5GRAMMARSENTINEL";
const enc = encodeURIComponent;

// ---- the real generators -----------------------------------------------------------------------------------------

/** Firestore auto-id alphabet and length (what `collection(...).doc()` returns: projects, team workspaces). */
function firestoreAutoId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(20), (b) => chars[b % chars.length]).join("");
}
/** A Firebase-Auth-generated uid (28 characters, the same alphabet). */
function firebaseUid(): string {
  return firestoreAutoId() + firestoreAutoId().slice(0, 8);
}
/** app/api/run-panel/route.ts, lib/firestore/teamWorkspaceRuns.ts, lib/firestore/teamRunSnapshots.ts. */
const runId = () => `run-${randomUUID()}`;
/** Pre-33fc61b run ids, still present in stored history (app/api/run-panel/route.ts before 2026-05-26). */
const legacyRunId = () => `${firebaseUid()}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
/** app/api/verify-claim/route.ts, lib/firestore/teamClaimVerifications.ts (and the pre-33fc61b form). */
const verificationId = () => `vcl-${randomUUID()}`;
const legacyVerificationId = () => `${firebaseUid()}-${Date.now()}-v-${Math.random().toString(36).slice(2, 9)}`;
/** app/api/verify-video/route.ts (and the pre-33fc61b form). */
const videoVerificationId = () => `vid-${randomUUID()}`;
const legacyVideoVerificationId = () => `${firebaseUid()}-${Date.now()}-vid-${Math.random().toString(36).substring(2, 9)}`;

const finding = (summary: string) => ({ id: `f-${randomUUID()}`, summary });
function realClaimId(run: string, section: "findings" | "lowConfidenceFindings", index: number): string {
  const id = buildDeepResearchClaimId({ runId: run, section, index, finding: finding(`a finding about tides ${index}`) });
  if (id === null) throw new Error("builder refused a valid finding");
  return id;
}
function realClaimIds(): string[] {
  const r = runId();
  return [
    realClaimId(r, "findings", 0),
    realClaimId(r, "findings", 7),
    realClaimId(r, "lowConfidenceFindings", 12),
    realClaimId(legacyRunId(), "lowConfidenceFindings", Number.MAX_SAFE_INTEGER), // the longest id the builder can issue
  ];
}

/**
 * Inventory section C readers → the values their real producers write. EVERY routing parameter in the rule source must
 * appear here (pinned below), so a new routing name cannot be added without naming its generator.
 */
const ROUTING_GENERATORS: Record<string, () => string[]> = {
  openResearchRun: () => [runId(), legacyRunId()],
  openVerification: () => [verificationId(), legacyVerificationId()],
  openVideoVerification: () => [videoVerificationId(), legacyVideoVerificationId()],
  originRunId: () => [runId(), legacyRunId()],
  originClaimId: realClaimIds,
  // Stripe Checkout Session id substituted for {CHECKOUT_SESSION_ID} (app/api/billing/create-checkout-session/route.ts).
  session_id: () => [`cs_test_${firestoreAutoId()}${firestoreAutoId()}${firestoreAutoId()}`.slice(0, 66), `cs_live_${firestoreAutoId()}${firestoreAutoId()}`],
  workspace: () => {
    const p = getPersonalWorkspaceId(firebaseUid());
    if (!p.ok) throw new Error("personal workspace id refused");
    return [p.workspaceId, firestoreAutoId()];
  },
  project: () => [projectFilterToParamValue(undefined), projectFilterToParamValue(null), projectFilterToParamValue(firestoreAutoId())],
  kind: () => ["legacy", "adaptive"].filter((k) => parseTeamRunListFilters(new URLSearchParams({ kind: k })).ok),
  flagged: () => ["true", "false"].filter((v) => parseTeamRunListFilters(new URLSearchParams({ flagged: v })).ok),
  reviewable: () => ["true", "false"].filter((v) => parseTeamRunListFilters(new URLSearchParams({ reviewable: v })).ok),
};

// ---- a minimal browser Location / History --------------------------------------------------------------------------

type Win = {
  location: { pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState: (s: unknown, t: string, url: string) => void };
  document: { referrer: string };
  sessionStorage: Storage | null;
};
function setUrl(win: Win, url: string) {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const qAt = beforeHash.indexOf("?");
  win.location.pathname = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  win.location.search = qAt === -1 || qAt === beforeHash.length - 1 ? "" : beforeHash.slice(qAt);
  win.location.hash = hashAt === -1 || hashAt === url.length - 1 ? "" : url.slice(hashAt);
}
function makeWindow(url: string): Win {
  const win: Win = {
    location: { pathname: "/", search: "", hash: "" },
    history: { state: null, replaceState: (_s, _t, u) => setUrl(win, u) },
    document: { referrer: "" },
    sessionStorage: null,
  };
  setUrl(win, url);
  return win;
}
const href = (win: Win) => `${win.location.pathname}${win.location.search}${win.location.hash}`;
/** A hard load: the pre-telemetry scrub that instrumentation-client.ts runs first. */
function hardLoad(url: string): string {
  const win = makeWindow(url);
  scrubUrlBeforeTelemetry(win as never);
  return href(win);
}
/** A soft navigation: what ContentHandoffMigrator runs on every client-side route change. */
function softNavigate(url: string): string {
  const win = makeWindow(url);
  migrateContentFromUrl({ location: win.location, history: win.history as never, storage: null, currentUid: null });
  return href(win);
}
/** Next.js App Router's `searchParams` prop: one string per key, an array for a repeated key. */
function nextSearchParams(url: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  new URLSearchParams(url.slice(url.indexOf("?") + 1)).forEach((v, k) => {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  });
  return out;
}

beforeEach(() => {
  __resetTabHandoffMemoryForTests();
  mockedAccess.mockResolvedValue({
    granted: true,
    workspaceType: "team",
    workspace: { id: "w", name: "Team" },
    membership: { role: "member" },
    capabilities: ["workspace.read", "research.read", "research.create"],
  });
});

// ---- MAJOR-1: end to end ------------------------------------------------------------------------------------------

describe("personal research \"Verify claim\": the real hand-off URL survives the scrub and app/page.tsx reads it", () => {
  const PAGE = readFileSync(join(__dirname, "..", "..", "..", "app", "page.tsx"), "utf8");

  it("app/page.tsx reads the pair from window.location.search with URLSearchParams.get (the reader modelled below)", () => {
    expect(PAGE).toMatch(/const params = new URLSearchParams\(window\.location\.search\);\s*\n\s*const tab = params\.get\("tab"\);/);
    expect(PAGE).toContain('const originRunId = params.get("originRunId");');
    expect(PAGE).toContain('const originClaimId = params.get("originClaimId");');
  });

  for (const claimId of realClaimIds()) {
    const run = runId();
    it(`hard load and soft navigation keep ${claimId.split(":").slice(0, 3).join(":")}:…`, () => {
      const url = personalResearchVerifyClaimHref({ runId: run, claimId });
      expect(url).not.toBeNull();
      for (const after of [hardLoad(url!), softNavigate(url!)]) {
        expect(after).toBe(url);
        // The reader in app/page.tsx: URLSearchParams over window.location.search, then .get().
        const params = new URLSearchParams(after.slice(after.indexOf("?")));
        expect(params.get("tab")).toBe("verify");
        expect(params.get("originRunId")?.trim()).toBe(run);
        expect(params.get("originClaimId")?.trim()).toBe(claimId);
      }
    });
  }

  it("the claim id is still redacted by the telemetry sanitizer (it is routing, not telemetry-safe)", () => {
    const claimId = realClaimIds()[0];
    const url = personalResearchVerifyClaimHref({ runId: runId(), claimId })!;
    expect(sanitizeUrl(url)).not.toContain(enc(claimId));
    expect(sanitizeUrl(url)).toContain("originClaimId=[redacted]");
  });
});

describe("team research → Team claim: the real hand-off survives the first load, a reload and a shared link", () => {
  for (const claimId of realClaimIds()) {
    it(`origin mode is kept for ${claimId.split(":").slice(0, 3).join(":")}:…`, async () => {
      const ws = firestoreAutoId();
      const run = runId();
      const url = teamClaimOriginHandoffHref({ workspaceId: ws, runId: run, claimId });
      // First arrival by router.push (soft navigation) — the address bar is what a reload / back / copy-link uses.
      const addressBar = softNavigate(url);
      expect(addressBar).toBe(url);
      // Reload / shared link: a hard load of what the address bar now holds.
      const reloaded = hardLoad(addressBar);
      expect(reloaded).toBe(url);
      // The real page classifies the reloaded URL as origin mode with the exact locator pair (never "invalid").
      expect(parseTeamClaimOriginQuery(nextSearchParams(reloaded))).toEqual({ kind: "origin", target: { runId: run, claimId } });
      const el = (await TeamUnfiledClaimCreatePage({ params: { workspaceId: ws }, searchParams: nextSearchParams(reloaded) })) as unknown as {
        props: { originTarget: unknown };
      };
      expect(el.props.originTarget).toEqual({ runId: run, claimId });
    });
  }
});

// ---- the accepted grammar is the builder's, and no looser ---------------------------------------------------------

describe("originClaimId accepts exactly what the real parser accepts (differential, with breaking inputs)", () => {
  const real = realClaimIds();
  const [base] = real;
  const fp = base.split(":")[3];
  const breaking = [
    ...real,
    `${base} `,
    ` ${base}`,
    `${base}&text=${SENTINEL}`,
    `${base}=x`,
    `${base}#x`,
    `${base}?x`,
    `${base}/x`,
    `v1:findings:0:${fp}x`,
    `v1:findings:0:${fp.slice(1)}`,
    `v1:findings:01:${fp}`,
    `v1:findings:-1:${fp}`,
    `v1:findings:1.5:${fp}`,
    `v1:findings:${"9".repeat(17)}:${fp}`, // beyond the builder's safe-integer index
    `v1:findings:${"9".repeat(60)}:${fp}`, // beyond any bound
    `v2:findings:0:${fp}`,
    `v1:summary:0:${fp}`,
    `v1:findings:0:${fp.slice(0, 20)} ${SENTINEL} ${fp.slice(21)}`,
    `v1:findings:0:${SENTINEL.padEnd(43, "A")}`, // shape-valid by construction (the fingerprint segment is opaque)
    "claim-7",
    "c1",
    `the moon is hollow ${SENTINEL}`,
    "",
  ];
  for (const value of breaking) {
    it(`${JSON.stringify(value.slice(0, 70))}: kept iff parseDeepResearchClaimId accepts it`, () => {
      const accepted = parseDeepResearchClaimId(value) !== null;
      const url = `/?tab=verify&originRunId=${enc(runId())}&originClaimId=${enc(value)}`;
      const after = scrubUrlParts({ pathname: "/", search: url.slice(1), hash: "" }).search;
      expect(new URLSearchParams(after).get("originClaimId")).toBe(accepted ? value : null);
    });
  }
  it("absolute (independent of the parser): suffixed, prefixed or resized ids are dropped, and no sentinel survives", () => {
    const variants = [
      `${base}&text=${SENTINEL}`,
      `${base} ${SENTINEL}`,
      `${base}#${SENTINEL}`,
      `${base}?q=${SENTINEL}`,
      `${base}/${SENTINEL}`,
      `${base}${SENTINEL}`,
      `${SENTINEL}${base}`,
      `v1:findings:0:${fp}A`,
      `v1:findings:0:${fp.slice(1)}`,
      `v1:findings:0:${fp}${fp}`,
    ];
    for (const value of variants) {
      expect(rules.isRoutingParamValue("originClaimId", value)).toBe(false);
      const search = `?tab=verify&originClaimId=${enc(value)}`;
      const after = scrubUrlParts({ pathname: "/", search, hash: "" }).search;
      expect(after).toBe("?tab=verify");
    }
  });
  it("no accepted value can carry a space, &, =, #, ?, / or exceed the builder's longest id", () => {
    const longest = real[real.length - 1];
    for (const ch of [" ", "&", "=", "#", "?", "/", "%", "+", "\n"]) {
      expect(rules.isRoutingParamValue("originClaimId", base.slice(0, 20) + ch + base.slice(21))).toBe(false);
    }
    expect(rules.isRoutingParamValue("originClaimId", longest)).toBe(true);
    expect(rules.isRoutingParamValue("originClaimId", longest.replace(":9007199254740991:", ":90071992547409919:"))).toBe(false);
  });
});

describe("every routing parameter in the rule source keeps the values its real generator produces", () => {
  it("the generator table names every routing parameter (and nothing else)", () => {
    expect(Object.keys(ROUTING_GENERATORS).sort()).toEqual(Array.from(rules.ROUTING_PARAM_SHAPES.keys()).sort());
  });
  for (const [name, gen] of Object.entries(ROUTING_GENERATORS)) {
    it(`${name}: every generated value is kept byte-for-byte, and its telemetry value is redacted`, () => {
      const values = gen();
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        const search = `?${name}=${enc(v)}`;
        expect(scrubUrlParts({ pathname: "/x", search, hash: "" }).search).toBe(search);
        expect(sanitizeUrl(`/verify${search}`)).toBe(`/verify?${name}=[redacted]`);
      }
    });
  }
  it("the telemetry-safe enum parameters keep their real producers' values", () => {
    const keep = (name: string, v: string) => expect(scrubUrlParts({ pathname: "/x", search: `?${name}=${enc(v)}`, hash: "" }).search).toBe(`?${name}=${enc(v)}`);
    for (const v of REVIEW_QUEUE_VIEWS) keep("view", v);
    for (const v of ["free", "lite", "full"]) keep("plan", v); // lib/plans.ts PlanId (components/PricingSection.tsx)
    for (const v of ["month", "year"]) keep("interval", v);
    for (const v of ["verify", "research"]) keep("tab", v);
    keep("source", "extension");
    keep("scope", "unfiled");
  });
});

// ---- review MINORs: pin the surviving mutants ----------------------------------------------------------------------

describe("R5 review mutant pins", () => {
  it("M5: an opaque routing id with a space (or other free-text punctuation) is dropped", () => {
    for (const v of ["run abc", "run+abc", `run-${SENTINEL} tides`, "a&b", "a=b", "a/b", "a:b", "a.b"]) {
      const out = scrubUrlParts({ pathname: "/", search: `?openResearchRun=${enc(v)}&tab=research`, hash: "" }).search;
      expect(out).toBe("?tab=research");
    }
  });

  it("M4 (GHSA-655j-5f43-92pw): no key=value fragment is kept on any path — the former invitation routing exception is gone", () => {
    expect((rules as Record<string, unknown>).ROUTING_FRAGMENT_KEYS).toBeUndefined();
    const credential = `#invitationId=r5v0&token=${SENTINEL}`;
    for (const path of ["/workspace-invitations/accept", "/workspace-invitations/accept/", "/", "/workspace"]) {
      const out = scrubUrlParts({ pathname: path, search: "", hash: credential });
      expect(out.hash).toBe("");
      expect(out.captures).toEqual([]);
      expect(out.changed).toBe(true);
    }
    // A plain in-page anchor is still kept.
    expect(scrubUrlParts({ pathname: "/workspace-invitations/accept", search: "", hash: "#faq" }).hash).toBe("#faq");
  });

  it("M1: a protocol-relative nested target (`//host/...`) is not a local path: dropped", () => {
    for (const target of ["//evil.example/verify", "//evil.example", `//evil.example/verify?text=${enc(SENTINEL)}`]) {
      expect(hardLoad(`/login?redirect=${enc(target)}&utm_source=x`)).toBe("/login?utm_source=x");
    }
    for (const target of ["/\\evil.example/verify"]) {
      expect(hardLoad(`/login?redirect=${enc(target)}`)).toBe("/login");
    }
  });

  it("M3: exactly MAX_EXTRA_DECODE_PASSES extra decodes are accepted, one more is dropped", () => {
    expect(rules.MAX_EXTRA_DECODE_PASSES).toBe(3);
    const target = `/verify?source=extension&text=${enc(SENTINEL)}`;
    const encodedTimes = (n: number) => {
      let v = target;
      for (let i = 0; i < n; i++) v = enc(v);
      return v;
    };
    // The query decode removes one layer; the remaining layers are the "extra" passes.
    const atBound = scrubUrlParts({ pathname: "/login", search: `?redirect=${encodedTimes(1 + rules.MAX_EXTRA_DECODE_PASSES)}`, hash: "" });
    expect(atBound.search).toBe(`?redirect=${enc("/verify?source=extension")}`);
    expect(atBound.captures).toEqual([{ kind: "pending", text: SENTINEL }]);
    const beyond = scrubUrlParts({ pathname: "/login", search: `?redirect=${encodedTimes(2 + rules.MAX_EXTRA_DECODE_PASSES)}`, hash: "" });
    expect(beyond.search).toBe("");
    expect(beyond.captures).toEqual([]);
  });
});

// ---- R6 (review MINORs Y10 / Y11): the claim-id grammar, position by position ----------------------------------
//
// Y10: an index segment that accepted whitespace survived (the earlier absolute check inserted characters at one
// position only, inside the fingerprint). Y11: a fingerprint alphabet that accepted `.` or `~` survived (the earlier
// list omitted unreserved punctuation). Every positive value below is issued by the real builder; every negative is
// derived from one, and each negative is checked next to its own builder-issued control through the same flows
// (personal hand-off, Team hand-off, reload, shared link), so rejecting a malformed id can never hide a real one.

describe("R6: originClaimId grammar is exactly the builder's, at every position", () => {
  const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const INDICES = [0, 1, 2, 9, 10, 11, 99, 100, 101, 999_999, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 10 ** 15, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
  const SECTIONS = ["findings", "lowConfidenceFindings"] as const;
  /** Real-shaped finding ids, including versioned / punctuated / non-ASCII ones: the builder hashes them, never embeds them. */
  const RAW_FINDING_IDS = () => [`f-${randomUUID()}`, "finding_3", "v2:finding:7", "f/1?x=y#z", "f 1", "étude-1", "x".repeat(500)];

  const parts = (id: string) => {
    const [version, section, index, fingerprint] = id.split(":");
    return { version, section, index, fingerprint };
  };
  const withIndex = (id: string, index: string) => {
    const p = parts(id);
    return `${p.version}:${p.section}:${index}:${p.fingerprint}`;
  };
  const withFingerprint = (id: string, fingerprint: string) => {
    const p = parts(id);
    return `${p.version}:${p.section}:${p.index}:${fingerprint}`;
  };

  /** A builder-issued corpus that covers both sections, every boundary index, both run-id generators and every fingerprint character class. */
  function builderCorpus(): string[] {
    const out: string[] = [];
    for (const run of [runId(), legacyRunId()]) {
      for (const section of SECTIONS) {
        for (const index of INDICES) {
          for (const rawId of RAW_FINDING_IDS()) {
            const id = buildDeepResearchClaimId({ runId: run, section, index, finding: { id: rawId, summary: `a finding about tides ${index}` } });
            if (id === null) throw new Error("builder refused a valid finding");
            out.push(id);
          }
        }
      }
    }
    // Keep issuing until `-` and `_` have each been seen as the first, a middle and the last-but-one fingerprint character.
    const need = new Set(["-@0", "_@0", "-@mid", "_@mid", "-@41", "_@41"]);
    for (let i = 0; need.size > 0 && i < 20_000; i++) {
      const id = buildDeepResearchClaimId({ runId: runId(), section: SECTIONS[i % 2], index: i, finding: finding(`coverage ${i}`) })!;
      const fp = parts(id).fingerprint;
      const before = need.size;
      for (const ch of ["-", "_"]) {
        need.delete(fp[0] === ch ? `${ch}@0` : "");
        need.delete(fp.slice(1, 41).includes(ch) ? `${ch}@mid` : "");
        need.delete(fp[41] === ch ? `${ch}@41` : "");
      }
      if (need.size < before) out.push(id);
    }
    if (need.size > 0) throw new Error(`corpus did not cover ${[...need].join(", ")}`);
    return out;
  }
  const CORPUS = builderCorpus();
  const [findingsId] = CORPUS;
  const longestId = buildDeepResearchClaimId({ runId: runId(), section: "lowConfidenceFindings", index: Number.MAX_SAFE_INTEGER, finding: finding("longest") })!;
  /** A builder id whose index has several digits, so there are interior index positions. */
  const multiDigitId = CORPUS.find((id) => parts(id).index === String(Number.MAX_SAFE_INTEGER))!;

  // ---- the flows (each returns what the reading page would see) ----

  const personalFlows = (claimId: string) => {
    const run = runId();
    const url = `/?tab=verify&originRunId=${enc(run)}&originClaimId=${enc(claimId)}`;
    return { run, url, results: [hardLoad(url), softNavigate(url), hardLoad(softNavigate(url))] };
  };
  const teamFlows = (claimId: string) => {
    const ws = firestoreAutoId();
    const run = runId();
    const url = teamClaimOriginHandoffHref({ workspaceId: ws, runId: run, claimId });
    const addressBar = softNavigate(url); // first arrival by router.push
    return { ws, run, url, addressBar, reloaded: hardLoad(addressBar), shared: hardLoad(url) };
  };

  function expectKept(claimId: string) {
    expect(rules.isRoutingParamValue("originClaimId", claimId)).toBe(true);
    const p = personalFlows(claimId);
    for (const after of p.results) {
      expect(after).toBe(p.url);
      const params = new URLSearchParams(after.slice(after.indexOf("?")));
      expect(params.get("tab")).toBe("verify");
      expect(params.get("originRunId")?.trim()).toBe(p.run);
      expect(params.get("originClaimId")?.trim()).toBe(claimId);
    }
    const t = teamFlows(claimId);
    for (const after of [t.addressBar, t.reloaded, t.shared]) {
      expect(after).toBe(t.url);
      expect(parseTeamClaimOriginQuery(nextSearchParams(after))).toEqual({ kind: "origin", target: { runId: t.run, claimId } });
    }
  }

  /** `value` is malformed: dropped by every flow (the rest of the URL intact). Its builder-issued `control` is then re-checked through the same flows when the test ends. */
  function expectDropped(value: string, control: string) {
    expect(rules.isRoutingParamValue("originClaimId", value)).toBe(false);
    expect(parseDeepResearchClaimId(value)).toBeNull(); // the server parser agrees: one grammar
    const p = personalFlows(value);
    for (const after of p.results) {
      expect(after).toBe(`/?tab=verify&originRunId=${enc(p.run)}`);
    }
    const t = teamFlows(value);
    for (const after of [t.addressBar, t.reloaded, t.shared]) {
      const q = new URLSearchParams(after.slice(after.indexOf("?")));
      expect(q.get("originClaimId")).toBeNull();
      expect(q.get("originRunId")).toBe(t.run);
      expect(parseTeamClaimOriginQuery(nextSearchParams(after))).toEqual({ kind: "invalid" });
    }
    controls.add(control);
  }
  /** Each test's builder-issued controls, re-checked through the same flows after its negatives. */
  const controls = new Set<string>();
  afterEach(() => {
    for (const control of controls) expectKept(control);
    controls.clear();
  });

  /** The cheap form for exhaustive position sweeps: the shared rule, the server parser and the address-bar scrub. */
  function expectRejected(value: string) {
    expect(rules.isRoutingParamValue("originClaimId", value)).toBe(false);
    expect(parseDeepResearchClaimId(value)).toBeNull();
    expect(scrubUrlParts({ pathname: "/", search: `?tab=verify&originClaimId=${enc(value)}`, hash: "" }).search).toBe("?tab=verify");
  }
  /** Fingerprint positions run through the full flows (first, second, middle, last-but-one, last, one past the end); every other position gets `expectRejected`. */
  const FULL_FLOW_FP_POSITIONS = new Set([0, 1, 21, 41, 42, 43]);

  // ---- positives ----

  it("every builder-issued id (both sections, boundary indices, both run-id forms, odd finding ids) survives every flow", () => {
    expect(CORPUS.length).toBeGreaterThan(400);
    for (const id of CORPUS) expectKept(id);
  });

  it("the builder never emits a leading zero, a sign or whitespace in the index, and only base64url in the fingerprint", () => {
    for (const id of CORPUS) {
      const p = parts(id);
      expect(p.version).toBe("v1");
      expect(SECTIONS as readonly string[]).toContain(p.section);
      expect(p.index).toBe(String(Number(p.index)));
      expect(/^[0-9]+$/.test(p.index)).toBe(true);
      expect(p.fingerprint).toHaveLength(43);
      for (const ch of p.fingerprint) expect(BASE64URL).toContain(ch);
    }
  });

  it("length: the longest id the builder can issue is exactly 85 characters and is kept; every 86-character neighbour is dropped", () => {
    expect(longestId).toHaveLength(85);
    expectKept(longestId);
    const fp = parts(longestId).fingerprint;
    const neighbours = [
      withIndex(longestId, "10000000000000000"), // 17 digits
      withIndex(longestId, String(Number.MAX_SAFE_INTEGER) + "0"),
      withFingerprint(longestId, fp + "A"),
      `${longestId}A`,
      `A${longestId}`,
      `${longestId} `,
      longestId.replace("v1:", "v1::"),
    ];
    for (const v of neighbours) {
      expect(v).toHaveLength(86);
      expectDropped(v, longestId);
    }
    // And one shorter than any builder id for its section: a 42-character fingerprint.
    expectDropped(withFingerprint(findingsId, parts(findingsId).fingerprint.slice(0, 42)), findingsId);
  });

  it("index bounds: 0 and MAX_SAFE_INTEGER are kept; MAX_SAFE_INTEGER + 1 (which the builder refuses) and beyond are dropped", () => {
    const zero = CORPUS.find((id) => parts(id).index === "0")!;
    expectKept(zero);
    expectKept(multiDigitId);
    expect(buildDeepResearchClaimId({ runId: runId(), section: "findings", index: Number.MAX_SAFE_INTEGER + 1, finding: finding("x") })).toBeNull();
    expect(buildDeepResearchClaimId({ runId: runId(), section: "findings", index: -1, finding: finding("x") })).toBeNull();
    for (const index of ["9007199254740992", "9007199254740993", "9999999999999999", "10000000000000000", "9".repeat(60)]) {
      expectDropped(withIndex(multiDigitId, index), multiDigitId);
    }
  });

  // ---- Y10: the index segment ----

  const WHITESPACE = [" ", "\t", "\n", "\r", "\v", "\f", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿", "​"];
  const UNICODE_DIGITS = ["١", "۳", "५", "߁", "໑", "１", "\u{1d7cf}", "²", "Ⅰ"];
  const NUMERIC_PUNCTUATION = ["+", "-", ".", ",", "_", "e", "E", "x", "n", "'", "%", "/", "=", "~"];

  it("Y10: whitespace at EVERY index position (before, between and after each digit, and alone) is dropped", () => {
    for (const control of [findingsId, multiDigitId, longestId]) {
      const index = parts(control).index;
      for (const ws of WHITESPACE) {
        for (let at = 0; at <= index.length; at++) {
          expectDropped(withIndex(control, index.slice(0, at) + ws + index.slice(at)), control);
        }
        for (let at = 0; at < index.length; at++) {
          expectDropped(withIndex(control, index.slice(0, at) + ws + index.slice(at + 1)), control); // a digit replaced
        }
        expectDropped(withIndex(control, ws), control);
        expectDropped(withIndex(control, ws + ws), control);
      }
    }
  });

  it("Y10: signs, numeric punctuation and unicode digits at every index position are dropped", () => {
    for (const control of [findingsId, multiDigitId]) {
      const index = parts(control).index;
      for (const ch of [...NUMERIC_PUNCTUATION, ...UNICODE_DIGITS]) {
        for (let at = 0; at <= index.length; at++) {
          expectDropped(withIndex(control, index.slice(0, at) + ch + index.slice(at)), control);
        }
        for (let at = 0; at < index.length; at++) {
          expectDropped(withIndex(control, index.slice(0, at) + ch + index.slice(at + 1)), control);
        }
      }
    }
  });

  it("Y10: number spellings the builder never emits (leading zeros, signed zero, exponent, hex, decimals) are dropped", () => {
    const spellings = [
      "", "00", "01", "007", `0${Number.MAX_SAFE_INTEGER}`, "-0", "+0", "-1", "+1", "1e3", "1E3", "0x1", "0X1", "0b1", "0o7",
      "1.0", "1.", ".5", "Infinity", "-Infinity", "NaN", "1n", "1_000", "1,000", ...UNICODE_DIGITS, ...UNICODE_DIGITS.map((d) => `1${d}`),
    ];
    for (const index of spellings) expectDropped(withIndex(findingsId, index), findingsId);
  });

  // ---- Y11: the fingerprint segment ----

  /** Every printable and control ASCII character outside base64url, and non-ASCII lookalikes. */
  const NOT_BASE64URL = [
    ...Array.from({ length: 128 }, (_, c) => String.fromCharCode(c)).filter((ch) => !BASE64URL.includes(ch)),
    " ", "​", "﻿", "é", "ａ", "А", "ı", "́", "\u{1f600}", "−", "‐",
  ];

  it("Y11: the punctuation list names every unreserved and reserved URL character, including . ~ + / = %", () => {
    for (const ch of [".", "~", "+", "/", "=", "%", "!", "*", "'", "(", ")", ":", ";", "@", "&", "$", ",", "?", "#", "[", "]", " "]) {
      expect(NOT_BASE64URL).toContain(ch);
    }
    // `-` and `_` ARE base64url: the builder emits them, so they are positive controls, not negatives.
    expect(NOT_BASE64URL).not.toContain("-");
    expect(NOT_BASE64URL).not.toContain("_");
  });

  it("Y11: any non-base64url character at EVERY fingerprint position (replaced or inserted) is dropped", () => {
    for (const control of [findingsId, longestId]) {
      const fp = parts(control).fingerprint;
      for (const ch of NOT_BASE64URL) {
        for (let at = 0; at <= 43; at++) {
          const check = FULL_FLOW_FP_POSITIONS.has(at) ? (v: string) => expectDropped(v, control) : expectRejected;
          if (at < 43) check(withFingerprint(control, fp.slice(0, at) + ch + fp.slice(at + 1))); // same length
          check(withFingerprint(control, fp.slice(0, at) + ch + fp.slice(at))); // one longer
        }
      }
    }
  });

  it("Y11: . and ~ arrive unescaped in a URL (encodeURIComponent leaves them) and are still dropped; %2E / %7E too", () => {
    const fp = parts(findingsId).fingerprint;
    for (const [raw, escaped] of [[".", "%2E"], ["~", "%7E"], ["+", "%2B"], ["/", "%2F"], ["=", "%3D"], ["%", "%25"]]) {
      for (const at of [0, 21, 42]) {
        const value = withFingerprint(findingsId, fp.slice(0, at) + raw + fp.slice(at + 1));
        expectDropped(value, findingsId);
        const literal = `/?tab=verify&originClaimId=${enc(findingsId).replace(enc(fp), enc(fp.slice(0, at)) + escaped + enc(fp.slice(at + 1)))}`;
        expect(new URLSearchParams(literal.slice(1)).get("originClaimId")).toBe(value);
        expect(hardLoad(literal)).toBe("/?tab=verify");
      }
    }
    // A raw `+` in a query is a space after decoding: also dropped.
    const plus = `/?tab=verify&originClaimId=${enc(withFingerprint(findingsId, fp.slice(0, 21))).replace(/$/, "+" + fp.slice(22))}`;
    expect(hardLoad(plus)).toBe("/?tab=verify");
  });

  it("Y11 positive control: - and _ at every fingerprint position a builder id holds them are kept", () => {
    const withDash = CORPUS.filter((id) => /[-_]/.test(parts(id).fingerprint));
    expect(withDash.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const id of withDash) {
      const fp = parts(id).fingerprint;
      for (let at = 0; at < 43; at++) if (fp[at] === "-" || fp[at] === "_") seen.add(`${fp[at]}@${at === 0 ? "0" : at === 41 ? "41" : "mid"}`);
      expectKept(id);
    }
    expect([...seen].sort()).toEqual(["-@0", "-@41", "-@mid", "_@0", "_@41", "_@mid"]);
  });

  // ---- the whole id: every position, every separator ----

  it("a character outside [A-Za-z0-9_:-] anywhere in the id (replaced or inserted) is dropped", () => {
    const foreign = NOT_BASE64URL.filter((ch) => ch !== ":");
    for (const control of [findingsId, longestId]) {
      expectKept(control);
      for (let at = 0; at <= control.length; at++) {
        for (const ch of foreign) {
          if (at < control.length) expectRejected(control.slice(0, at) + ch + control.slice(at + 1));
          expectRejected(control.slice(0, at) + ch + control.slice(at));
        }
      }
    }
  });

  it("versions, sections and separators the builder never emits are dropped", () => {
    const { section, index, fingerprint } = parts(findingsId);
    const variants = [
      `v0:${section}:${index}:${fingerprint}`, `v2:${section}:${index}:${fingerprint}`, `v10:${section}:${index}:${fingerprint}`,
      `V1:${section}:${index}:${fingerprint}`, `v01:${section}:${index}:${fingerprint}`, `1:${section}:${index}:${fingerprint}`,
      `:${section}:${index}:${fingerprint}`, `v1:Findings:${index}:${fingerprint}`, `v1:finding:${index}:${fingerprint}`,
      `v1:summary:${index}:${fingerprint}`, `v1:lowconfidencefindings:${index}:${fingerprint}`, `v1::${index}:${fingerprint}`,
      `v1:${section}::${fingerprint}`, `v1:${section}:${index}:`, `v1:${section}:${index}`, `v1:${section}:${index}::${fingerprint}`,
      `v1:${section}:${index}:${fingerprint}:`, `v1:${section}:${index}:${fingerprint}:${fingerprint}`, `v1-${section}-${index}-${fingerprint}`,
      `v1:${section}:${fingerprint}`, `${fingerprint}`,
    ];
    for (const v of variants) expectDropped(v, findingsId);
  });

  it("a double-encoded id (%253A) is dropped; the single encoding every producer writes (%3A) is kept", () => {
    const once = enc(findingsId);
    expect(once).toContain("%3A");
    expect(hardLoad(`/?tab=verify&originClaimId=${once}`)).toBe(`/?tab=verify&originClaimId=${once}`);
    expect(hardLoad(`/?tab=verify&originClaimId=${enc(once)}`)).toBe("/?tab=verify");
  });

  it("dropping a malformed id leaves no state behind: the next real hand-off, in the same session, is kept", async () => {
    const ws = firestoreAutoId();
    for (const bad of [withIndex(findingsId, ` ${parts(findingsId).index}`), withFingerprint(findingsId, `.${parts(findingsId).fingerprint.slice(1)}`)]) {
      const run = runId();
      expect(softNavigate(teamClaimOriginHandoffHref({ workspaceId: ws, runId: run, claimId: bad }))).not.toContain("originClaimId");
      const goodUrl = teamClaimOriginHandoffHref({ workspaceId: ws, runId: run, claimId: findingsId });
      const reloaded = hardLoad(softNavigate(goodUrl));
      expect(reloaded).toBe(goodUrl);
      const el = (await TeamUnfiledClaimCreatePage({ params: { workspaceId: ws }, searchParams: nextSearchParams(reloaded) })) as unknown as {
        props: { originTarget: unknown };
      };
      expect(el.props.originTarget).toEqual({ runId: run, claimId: findingsId });
    }
  });

  it("the Team page: a malformed id after reload is the not-found 'invalid hand-off', its builder control renders origin mode", async () => {
    const fp = parts(findingsId).fingerprint;
    const malformed = [
      withIndex(findingsId, ` ${parts(findingsId).index}`),
      withIndex(findingsId, `${parts(findingsId).index} `),
      withIndex(findingsId, `+${parts(findingsId).index}`),
      withFingerprint(findingsId, `${fp.slice(0, 42)}.`),
      withFingerprint(findingsId, `~${fp.slice(1)}`),
      withIndex(longestId, "9007199254740992"),
    ];
    for (const bad of malformed) {
      const ws = firestoreAutoId();
      const t = teamFlows(bad);
      let caught: unknown;
      try {
        await TeamUnfiledClaimCreatePage({ params: { workspaceId: ws }, searchParams: nextSearchParams(t.reloaded) });
      } catch (e) {
        caught = e;
      }
      expect((caught as { digest?: string } | undefined)?.digest).toBe("NEXT_NOT_FOUND");
      const control = teamFlows(findingsId);
      const el = (await TeamUnfiledClaimCreatePage({ params: { workspaceId: ws }, searchParams: nextSearchParams(control.reloaded) })) as unknown as {
        props: { originTarget: unknown };
      };
      expect(el.props.originTarget).toEqual({ runId: control.run, claimId: findingsId });
    }
  });
});
