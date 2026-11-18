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
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
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
  mockedIdentity.mockResolvedValue({ uid: "uid-member" });
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
        expect(sanitizeUrl(`/x${search}`)).toBe(`/x?${name}=[redacted]`);
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

  it("M4: a registered routing fragment is kept only when EVERY key is registered", () => {
    const [routePath, keys] = Array.from(rules.ROUTING_FRAGMENT_KEYS.entries())[0];
    const allRegistered = keys.map((k, i) => `${k}=r5v${i}`).join("&");
    expect(scrubUrlParts({ pathname: routePath, search: "", hash: `#${allRegistered}` }).hash).toBe(`#${allRegistered}`);
    for (const extra of [`text=${SENTINEL}`, `extra=${SENTINEL}`, `${enc(`claim ${SENTINEL}`)}`]) {
      const mixed = scrubUrlParts({ pathname: routePath, search: "", hash: `#${keys[0]}=r5v0&${extra}` });
      expect(mixed.hash).toBe("");
      expect(mixed.captures).toEqual([]);
    }
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
