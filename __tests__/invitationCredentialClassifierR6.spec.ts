/**
 * GHSA-655j-5f43-92pw — review R6 MINOR-1 / MINOR-2: the bounded, tolerant, fail-closed classifier that decides
 * whether a document's URL may carry invitation-credential material (path, query or fragment; any encoding), and its
 * wiring into the once-per-document telemetry decision. Detection never makes a URL acceptable: acceptance still
 * requires the exact path and `parseInvitationFragment`.
 */
import {
  hasCredentialShapedFragment,
  isCredentialBearingUrl,
  parseInvitationFragment,
  captureInvitationCredentialFromLocation,
  takeCapturedInvitationCredential,
} from "@/lib/client/invitationAcceptance";

const O = "https://convergepanel.com";
const CRED = "invitationId=AAA&token=SECRETTOK";
const enc = (s: string, layers: number) => {
  for (let i = 0; i < layers; i++) s = encodeURIComponent(s);
  return s;
};

function freshDecision(): typeof import("@/lib/telemetry/telemetryFreeDocument") {
  let mod: typeof import("@/lib/telemetry/telemetryFreeDocument");
  jest.isolateModules(() => {
    mod = require("@/lib/telemetry/telemetryFreeDocument");
  });
  return mod!;
}
const nav = (name: string) => ({ getEntriesByType: (t: string) => (t === "navigation" ? [{ name }] : []) });

describe("R6 MINOR-2: credential material in the PATH or QUERY (e-mail-rewritten links)", () => {
  it.each([
    ["`#` rewritten to %23 (credential lands in the path)", `${O}/workspace-invitations/accept%23${enc(CRED, 1)}`],
    ["`#` rewritten to %23, key separators left raw", `${O}/workspace-invitations/accept%23${CRED}`],
    ["`#` rewritten to %2523 (double-encoded)", `${O}/workspace-invitations/accept%2523${enc(CRED, 2)}`],
    ["credential in the path on another route", `${O}/x/accept%23${enc(CRED, 1)}`],
    ["credential moved to the query", `${O}/workspace-invitations/accept?${CRED}`],
    ["credential in the query on another route", `${O}/login?${CRED}`],
    ["mixed-case key in the query", `${O}/x?ToKeN=abc`],
    ["snake-case invitation_id", `${O}/x?a=1&invitation_id=abc`],
    ["acceptance path, upper case", `${O}/Workspace-Invitations/ACCEPT`],
    ["acceptance path, repeated slashes + trailing segment", `${O}//workspace-invitations//accept/zzz`],
    ["acceptance path, percent-encoded letter", `${O}/workspace-invitations/%61ccept`],
    ["acceptance path, encoded slash", `${O}/workspace-invitations%2Faccept`],
    ["HTML-escaped `=`", `${O}/x#token&#61;abc`],
    ["relative path form", `/workspace-invitations/accept%23${CRED}`],
  ])("%s → credential-bearing", (_n, url) => {
    expect(isCredentialBearingUrl(url)).toBe(true);
  });
});

describe("R6 MINOR-1: encoding never defeats detection; anything unsettled fails closed", () => {
  it.each([
    ["trailing stray %", `${O}/x#invitationId%3DA%26token%3DB%`],
    ["leading malformed %ZZ", `${O}/x#%ZZ%26invitationId%3DA%26token%3DB`],
    ["stray % between keys", `${O}/x#a=%&token%3DB`],
    ["mixed-case escapes", `${O}/x#tok%65N%3dB`],
    ["encoded key name", `${O}/x#tok%2565n=1`],
    ["4 layers (beyond the former 3-layer limit)", `${O}/x#${enc(CRED, 4)}`],
    ["8 layers (the decode limit)", `${O}/x#${enc(CRED, 8)}`],
    ["12 layers (beyond the decode limit: unsettled → fail closed)", `${O}/x#${enc(CRED, 12)}`],
    ["`+` and whitespace around the key", `${O}/x#a=1&+token+=B`],
    ["semicolon separator", `${O}/x#a=1;token=B`],
    ["question-mark separator inside the fragment", `${O}/x#/route?token=B`],
    ["over-long URL (cannot be classified confidently)", `${O}/x?q=${"a".repeat(9000)}`],
  ])("%s → credential-bearing", (_n, url) => {
    expect(isCredentialBearingUrl(url)).toBe(true);
  });

  it("an unparseable URL is treated as credential-bearing (fail closed)", () => {
    expect(isCredentialBearingUrl("https://[bad")).toBe(true);
  });

  it("unsettled after the layer limit is treated as credential-bearing even without any visible key", () => {
    expect(isCredentialBearingUrl(`${O}/x#${enc("harmless=1", 12)}`)).toBe(true);
  });

  it("the fragment-only check uses the same classifier (stray %, 4+ layers)", () => {
    expect(hasCredentialShapedFragment("#invitationId%3DA%26token%3DB%")).toBe(true);
    expect(hasCredentialShapedFragment(`#${enc(CRED, 5)}`)).toBe(true);
    expect(hasCredentialShapedFragment("#main")).toBe(false);
    expect(hasCredentialShapedFragment("no-fragment")).toBe(false);
  });

  it("bounded work: a hostile long input returns quickly", () => {
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) isCredentialBearingUrl(`${O}/x#${"%25".repeat(2700)}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("ordinary URLs keep telemetry (no unnecessary suppression)", () => {
  it.each([
    `${O}/`,
    `${O}/workspace/team/abc?tab=research#main`,
    `${O}/login?redirect=%2Fworkspace-invitations%2Faccept`,
    `${O}/research?q=100%25%20sure`,
    `${O}/blog/tokenomics-explained`,
    `${O}/workspace-invitations/acceptable`,
    `${O}/pricing#plans`,
    "",
  ])("%s → not credential-bearing", (url) => {
    expect(isCredentialBearingUrl(url)).toBe(false);
  });
});

describe("detection is not acceptance", () => {
  it("a rewritten or malformed link that is detected is still never parsed or captured as a credential", () => {
    expect(isCredentialBearingUrl(`${O}/workspace-invitations/accept%23${CRED}`)).toBe(true);
    captureInvitationCredentialFromLocation({ pathname: `/workspace-invitations/accept%23${CRED}`, hash: "" });
    expect(takeCapturedInvitationCredential()).toBeNull();
    captureInvitationCredentialFromLocation({ pathname: "/workspace-invitations/%61ccept", hash: `#${CRED}` });
    expect(takeCapturedInvitationCredential()).toBeNull();
    expect(parseInvitationFragment("#invitationId%3DA%26token%3DB%")).toEqual({ kind: "invalid" });
    expect(parseInvitationFragment(`#${enc(CRED, 4)}`)).toEqual({ kind: "invalid" });
  });
});

describe("wiring into the once-per-document telemetry decision", () => {
  it.each([
    ["navigation entry: %23-rewritten path", `${O}/workspace-invitations/accept%23${enc(CRED, 1)}`],
    ["navigation entry: credential in query", `${O}/x?${CRED}`],
    ["navigation entry: stray % fragment on a non-canonical path", `${O}/workspace-invitations/%61ccept#invitationId%3DA%26token%3DB%`],
    ["navigation entry: 6-layer fragment", `${O}/y#${enc(CRED, 6)}`],
  ])("%s → telemetry-free", (_n, name) => {
    expect(freshDecision().isTelemetryFreeDocument({ performance: nav(name), location: { pathname: "/", href: `${O}/` } })).toBe(true);
  });

  it("the current URL is classified too (credential still in the path after the fragment scrub)", () => {
    const href = `${O}/workspace-invitations/accept%23${CRED}`;
    expect(freshDecision().isTelemetryFreeDocument({ performance: nav(`${O}/pricing`), location: { pathname: "/x", href } })).toBe(true);
  });

  it("no navigation entry: falls back to classifying the current URL", () => {
    expect(freshDecision().isTelemetryFreeDocument({ performance: null, location: { pathname: "/x", href: `${O}/x?token=1` } })).toBe(true);
    expect(freshDecision().isTelemetryFreeDocument({ performance: null, location: { pathname: "/pricing", href: `${O}/pricing` } })).toBe(false);
  });

  it("a clean document keeps telemetry", () => {
    expect(freshDecision().isTelemetryFreeDocument({ performance: nav(`${O}/pricing#plans`), location: { pathname: "/pricing", href: `${O}/pricing` } })).toBe(false);
  });
});
