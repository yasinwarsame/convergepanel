/**
 * GHSA-655j-5f43-92pw — review R7 F1 / F2: key-less token-shaped material and mangled credential keys.
 * Detection only: a match turns telemetry off for the document; it never makes anything acceptable or redeemable.
 */
import { randomBytes } from "crypto";
import { isCredentialBearingUrl, parseInvitationFragment, captureInvitationCredentialFromLocation, takeCapturedInvitationCredential } from "@/lib/client/invitationAcceptance";
import { generateWorkspaceInvitationToken } from "@/lib/workspaces/invitationToken";

const O = "https://convergepanel.com";
const TOK = "Zq7Xk2LmN9pQr4StUv6WxYz8AbCdEfGh1IjKlMnOpQr";
const enc = (s: string, n: number) => {
  for (let i = 0; i < n; i++) s = encodeURIComponent(s);
  return s;
};
const pctAll = (s: string) => s.split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()).join("");

describe("fixture matches the real token format", () => {
  it("the sample token and generated tokens are 43-character base64url", () => {
    expect(TOK).toHaveLength(43);
    for (let i = 0; i < 20; i++) expect(generateWorkspaceInvitationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("every one of 2000 freshly generated tokens is detected key-less in a path and in a bare query component", () => {
    for (let i = 0; i < 2000; i++) {
      const t = generateWorkspaceInvitationToken();
      expect(isCredentialBearingUrl(`${O}/pricing/${t}`)).toBe(true);
      expect(isCredentialBearingUrl(`${O}/pricing?${t}`)).toBe(true);
    }
  });
});

describe("R7 F1: key-less token-shaped material → credential-bearing", () => {
  it.each([
    ["standalone path segment", `${O}/pricing/${TOK}`],
    ["path segment on a nested route", `${O}/workspace/team/x/${TOK}`],
    ["bare query component", `${O}/pricing?${TOK}`],
    ["bare query component after another", `${O}/pricing?a=1&${TOK}`],
    ["bare query component with `;`", `${O}/pricing?a=1;${TOK}`],
    ["token as a query value under any key", `${O}/pricing?ref=${TOK}`],
    ["fully percent-encoded token in the path", `${O}/pricing/${pctAll(TOK)}`],
    ["fully percent-encoded token in the query", `${O}/pricing?${pctAll(TOK)}`],
    ["double-encoded token", `${O}/pricing?${enc(pctAll(TOK), 1)}`],
    ["token after an encoded slash", `${O}/pricing%2F${TOK}`],
    ["token in the fragment", `${O}/pricing#${TOK}`],
    ["key glued to the token (missing separator)", `${O}/pricing?token${TOK}`],
  ])("%s", (_n, url) => {
    expect(isCredentialBearingUrl(url)).toBe(true);
  });
});

describe("R7 F2: mangled key spellings → credential-bearing", () => {
  it.each([
    ["fullwidth =", `${O}/x?token＝${TOK}`],
    ["fullwidth = (encoded, as Chromium stores it)", `${O}/x?token%EF%BC%9DSECRET`],
    ["small form-variant =", `${O}/x?token﹦SECRET`],
    ["fullwidth key letters", `${O}/x?ｔｏｋｅｎ=SECRET`],
    ["overlong = %C0%BD", `${O}/x?token%C0%BDSECRET`],
    ["NUL inside the key", `${O}/x?t%00oken=SECRET`],
    ["TAB inside the key", `${O}/x?to%09ken=SECRET`],
    ["zero-width space inside the key", `${O}/x?tok%E2%80%8Ben=SECRET`],
    ["soft hyphen inside the key", `${O}/x?tok%C2%ADen=SECRET`],
    ["Cyrillic о", `${O}/x?t%D0%BEken=SECRET`],
    ["Greek ο and Cyrillic е", `${O}/x?tοkеn=SECRET`],
    ["Cyrillic і in invitationId", `${O}/x#іnvitationId=A`],
    ["colon separator", `${O}/x?token:SECRET`],
    ["array suffix", `${O}/x?token[]=SECRET`],
    ["plural key", `${O}/x?tokens=SECRET`],
    ["prefixed key", `${O}/x?xtoken=SECRET`],
    ["mangled &amp; prefix", `${O}/x?a=1&amptoken=SECRET`],
    ["double HTML escape", `${O}/x?token&amp;#61;SECRET`],
    ["named entity filler", `${O}/x?token&lowbar;=SECRET`],
    ["dotted invitation.id", `${O}/x?invitation.id=A`],
    ["invalid UTF-8 inside the key", `${O}/x?tok%FFen=SECRET`],
  ])("%s", (_n, url) => {
    expect(isCredentialBearingUrl(url)).toBe(true);
  });

  it.each([
    ["accept;x", `${O}/workspace-invitations/accept;x`],
    ["accept.", `${O}/workspace-invitations/accept.`],
    ["accept%20", `${O}/workspace-invitations/accept%20`],
    ["accept%3B", `${O}/workspace-invitations/accept%3B`],
    ["Unicode hyphen in the path", `${O}/workspace‐invitations/accept`],
    ["Cyrillic а in the path", `${O}/workspace-invitаtions/accept`],
  ])("acceptance path alias %s", (_n, url) => {
    expect(isCredentialBearingUrl(url)).toBe(true);
  });
});

describe("benign URLs keep telemetry (bounded false positives)", () => {
  it.each([
    ["43-char lower-case slug", `${O}/blog/how-to-compare-answers-from-many-llms-fast`],
    ["43 chars inside a longer identifier (path)", `${O}/pricing/${TOK}xyz`],
    ["43 chars inside a longer identifier (query value)", `${O}/pricing?ref=a${TOK}`],
    ["upper-case-only 43-char identifier", `${O}/x/${"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFG"}`],
    ["Firestore id", `${O}/workspace/team/AbCdEfGhIjKlMnOpQrSt`],
    ["UUID", `${O}/r/123e4567-e89b-12d3-a456-426614174000`],
    ["SHA-256 hex", `${O}/x?h=${"a1".repeat(32)}`],
    ["Stripe checkout session id", `${O}/billing?session_id=cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6`],
    ["blog post about tokens", `${O}/blog/token-limits`],
    ["tokenomics slug", `${O}/blog/tokenomics-explained`],
    ["search query", `${O}/search?q=a+b`],
    ["password-reset style code", `${O}/reset?oobCode=abcDEF123`],
    ["redirect to the acceptance page", `${O}/login?redirect=%2Fworkspace-invitations%2Faccept`],
    ["claim hand-off text", `${O}/verify#text=the%20moon%20is%20hollow`],
    ["acceptable is not accept", `${O}/workspace-invitations/acceptable`],
    ["unrelated non-ASCII text", `${O}/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E`],
    ["claim id with a 43-char SHA-256 base64url suffix (personal Verify claim hand-off)", `${O}/?tab=verify&originRunId=run-f3fdb5e5-248b-4458-9609-344b6bcadd67&originClaimId=v1%3Afindings%3A4%3AgxtQa2BU57dpwfMOPDpg78aT27KyCXckXZjqJxG7fVc`],
    ["claim id in a team hand-off", `${O}/workspace/team/Wq8k2LmN4pR7sT1vX3yZ/claims/new?originRunId=run-1&originClaimId=v1%3AlowConfidenceFindings%3A0%3AooWnlDjZXrpyRTgQCpqrqCj8qzGKYkcMiO6onW_jM6E`],
    ["43 chars joined by a colon", `${O}/x/a:${TOK}`],
  ])("%s → not credential-bearing", (_n, url) => {
    expect(isCredentialBearingUrl(url)).toBe(false);
  });

  it("false-positive rate on random lower-case slugs and random 20-char ids is zero", () => {
    for (let i = 0; i < 500; i++) {
      const id = randomBytes(15).toString("base64url").slice(0, 20);
      expect(isCredentialBearingUrl(`${O}/workspace/team/${id}`)).toBe(false);
      const slug = randomBytes(30).toString("hex").slice(0, 43).replace(/[0-9]/g, "-");
      expect(isCredentialBearingUrl(`${O}/blog/${slug}`)).toBe(false);
    }
  });
});

describe("bounded work and separation from acceptance", () => {
  it("normalization that would expand past its bound fails closed (suppress), never silently passes", () => {
    expect(isCredentialBearingUrl(`${O}/x?q=${"\uFDFA".repeat(2000)}`)).toBe(true); // NFKC expands each to 18 chars
    expect(isCredentialBearingUrl(`${O}/x?q=${"\uFDFA".repeat(10)}`)).toBe(false);
  });

  it("hostile inputs return quickly", () => {
    const hostile = [`${O}/x#${"%25".repeat(2700)}`, `${O}/x?${"token".repeat(1600)}`, `${O}/x?${"&#".repeat(4000)}`, `${O}/x?${"ｔ".repeat(4000)}`, `${O}/${"A".repeat(8000)}`, `${O}/x?${"&amp;".repeat(1600)}`, `${O}/x?${"%C0".repeat(2700)}`];
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) for (const h of hostile) isCredentialBearingUrl(h);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a detected key-less or mangled link is never parsed or captured as a credential", () => {
    captureInvitationCredentialFromLocation({ pathname: `/workspace-invitations/accept/${TOK}`, hash: "" });
    expect(takeCapturedInvitationCredential()).toBeNull();
    captureInvitationCredentialFromLocation({ pathname: "/workspace-invitations/accept", hash: `#${TOK}` });
    expect(takeCapturedInvitationCredential()).toEqual({ kind: "invalid" });
    expect(parseInvitationFragment(`#invitationId=A&token＝${TOK}`)).toEqual({ kind: "invalid" });
  });

  it("the classifier source never logs", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/client/invitationAcceptance.ts"), "utf8");
    expect(src).not.toMatch(/console\.|logger\.|captureMessage|captureException/);
  });
});
