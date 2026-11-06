/**
 * Owner ruling (PR #295): Firestore and Firebase Auth clocks have no
 * established drift bound, so the revoke's tokensValidAfterTime >= cutoff
 * comparison must never be described as PROOF of session revocation.
 *
 * Grep-style guard over every doc and user-facing string this tool ships:
 * no sentence that talks about revocation / sessions / the cutoff may use
 * affirmative proof language (prove, proven, proof, guarantee, verified,
 * verifies). Negated uses ("not proof", "never ... verified") are allowed.
 * Also pins that the assumption and the enforcement caveat are stated.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  REVOCATION_CLOCK_ASSUMPTION,
  REVOCATION_OBSERVED_SUMMARY,
  type SessionRevocationEvidence,
} from "../../lib/admin/systemAdminClaimSafety";
import { RERUN_IS_SAFE, revocationSummary } from "../../lib/admin/systemAdminClaimExecution";

const REPO = path.resolve(__dirname, "..", "..");
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

const REVOCATION_TERMS = /revo(ke|ked|kes|king|cation)|tokensValidAfterTime|validSince|cutoff|\bsessions?\b/i;
const PROOF_WORDS = /\b(proof|prove[sdn]?|proving|guarantee[sd]?|verified|verifies)\b/i;
/** A negation earlier in the same clause makes the proof word a denial ("not proof", "never reported as verified"). */
const NEGATED = /\b(not|never|no|nor|without|cannot)\b[^.;:]{0,60}?\b(proof|prove[sdn]?|proving|guarantee[sd]?|verified|verifies)\b/gi;

/** Sentences (docs: inline code spans removed, so identifiers like verifyIdToken never count). */
function docSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split(/\n\s*\n|(?<=[.!?])\s+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Source: each line (comments and string literals alike); comment markers removed. */
function sourceLines(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/^\s*(\/\/+|\/?\*+\/?)\s?/, "").trim()).filter(Boolean);
}

function offending(units: string[]): string[] {
  return units.filter((u) => REVOCATION_TERMS.test(u) && PROOF_WORDS.test(u.replace(NEGATED, " ")));
}

function section(text: string, from: string, to: string): string {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`section not found: ${from}`);
  return text.slice(a, b);
}

const SAMPLE_EVIDENCE: SessionRevocationEvidence = {
  claimWrite: "confirmed",
  revocationApiAcknowledged: true,
  anchorSource: "firestore-commit-time:users/{uid}.role",
  anchorServerTime: "2026-11-05T10:00:00.000Z",
  marginSeconds: 2,
  cutoff: "2026-11-05T10:00:03.000Z",
  tokensValidAfterTimeBefore: null,
  tokensValidAfterTimeAfter: "Thu, 05 Nov 2026 10:00:04 GMT",
  validSinceMinusAnchorSeconds: 4,
  cutoffObserved: true,
  clockAlignmentAssumption: REVOCATION_CLOCK_ASSUMPTION,
  currentPrivilegeEnforcement: CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  detail: null,
};

describe("no proof language about revocation (owner ruling: unbounded Firestore/Auth clock skew)", () => {
  it("CONTROL: the scanner flags affirmative proof wording and passes negated wording", () => {
    expect(offending(docSentences("Every revoke calls the API and then proves, against a SERVER clock, that the revocation covers the moment."))).toHaveLength(1);
    expect(offending(docSentences("The read-back is verified against the cutoff."))).toHaveLength(1);
    expect(offending(docSentences("A server-timestamp guarantees the revocation anchor."))).toHaveLength(1);
    expect(offending(docSentences("It is not proof that sessions were revoked."))).toEqual([]);
    expect(offending(docSentences("The cutoff comparison is an observation."))).toEqual([]);
    expect(offending(sourceLines(" * proves that against a server clock: the revocation"))).toHaveLength(1);
  });

  it.each([
    ["docs/operations/system-admin-claim-script.md", (t: string) => t],
    ["docs/operations/admin-authority-tiers.md (Option 1)", (t: string) => section(t, "**Option 1", "**Option 2")],
    ["docs/technical-documentation.md (operator claim tool)", (t: string) => section(t, "**Operator claim tool:**", "\n\n")],
  ])("%s", (label, pick) => {
    const file = label.split(" ")[0];
    expect({ file, offending: offending(docSentences(pick(read(file)))) }).toEqual({ file, offending: [] });
  });

  it.each([
    "lib/admin/systemAdminClaimSafety.ts",
    "lib/admin/systemAdminClaimExecution.ts",
    "scripts/admin/set-system-admin-claim.ts",
    "lib/admin/auditLog.ts",
  ])("source (comments, messages, audit evidence text): %s", (file) => {
    expect({ file, offending: offending(sourceLines(read(file))) }).toEqual({ file, offending: [] });
  });

  it("exported message constants and the rendered revoke summary", () => {
    const strings = [REVOCATION_CLOCK_ASSUMPTION, CURRENT_PRIVILEGE_ENFORCEMENT_NOTE, REVOCATION_OBSERVED_SUMMARY, RERUN_IS_SAFE, revocationSummary(SAMPLE_EVIDENCE), revocationSummary(null)];
    expect(strings.flatMap((s) => offending(docSentences(s)))).toEqual([]);
  });
});

describe("the assumption and the enforcement caveat are stated", () => {
  it("the success summary names acknowledgment, the observed cutoff, the unbounded 2 s assumption and S2", () => {
    const m = revocationSummary(SAMPLE_EVIDENCE);
    expect(m).toContain("revocation acknowledged; cutoff observed at/after server-anchored cutoff (assumes Firestore/Auth clock skew < 2 s, unbounded)");
    expect(m).toContain(REVOCATION_CLOCK_ASSUMPTION);
    expect(m).toContain(CURRENT_PRIVILEGE_ENFORCEMENT_NOTE);
    expect(REVOCATION_CLOCK_ASSUMPTION).toMatch(/ASSUMPTION/);
    expect(REVOCATION_CLOCK_ASSUMPTION).toMatch(/unbounded/);
    expect(REVOCATION_CLOCK_ASSUMPTION).toMatch(/not proof/);
    expect(CURRENT_PRIVILEGE_ENFORCEMENT_NOTE).toMatch(/without checkRevoked/);
    expect(CURRENT_PRIVILEGE_ENFORCEMENT_NOTE).toMatch(/S2/);
  });

  it("the runbook states (a)-(e), the S2 dependency, the guard locations and the fast-clock recovery", () => {
    const doc = read("docs/operations/system-admin-claim-script.md");
    for (const needle of [
      "**(a) API acknowledgment.**",
      "**(b) Observed cutoff.**",
      "**(c) Clock-alignment ASSUMPTION.**",
      "**(d) Enforcement of current admin privileges: not provided.**",
      "**(e) Incomplete outcomes.**",
      "It is not proof\n  that sessions were revoked",
      "S2 (live admin authorization in route\n  guards)",
      "`lib/firebase/auth-helpers.ts:56`",
      "`verifySessionCookie(raw, true)`",
      "**Fast operator clock: recovery.**",
    ]) {
      expect({ needle, present: doc.includes(needle) }).toEqual({ needle, present: true });
    }
  });

  it("the Option 1 paragraph and technical documentation state the assumption and the enforcement gap", () => {
    const opt1 = section(read("docs/operations/admin-authority-tiers.md"), "**Option 1", "**Option 2");
    expect(opt1).toMatch(/not proof of revocation/);
    expect(opt1).toMatch(/ASSUMES/);
    expect(opt1).toMatch(/S2/);
    const tech = section(read("docs/technical-documentation.md"), "**Operator claim tool:**", "\n\n");
    expect(tech).toMatch(/NOT proof of revocation/);
    expect(tech).toMatch(/S2/);
  });
});

/**
 * PR #295 doc sweep (owner order B). Five classes of UNCONDITIONAL claim about
 * the revoke path are unsupported by what the tool can observe:
 *   R1 the target is signed out everywhere / of every session;
 *   R2 a revoke always revokes refresh tokens / sessions (it always REQUESTS
 *      revocation; the call can fail, and a thrown call is an unknown outcome);
 *   R3 session cookies are rejected immediately on revocation (only cookies
 *      whose auth_time is earlier than the stamped validSince, and only if the
 *      request was applied);
 *   R4 already-issued bearer ID tokens lose admin privileges at once (they do
 *      not: the bearer guards skip checkRevoked until S2);
 *   R5 an observed cutoff establishes end-to-end revocation (it rests on an
 *      unproven cross-service clock assumption).
 * A match is ignored when a negation precedes it in the same clause, so
 * accurate denials ("is not a sign-out from every device") pass. The positive
 * controls below are accurate conditional sentences that must keep passing.
 */
type ClaimRule = { id: string; re: RegExp; negatable: boolean; sentenceAlso?: RegExp[] };

const CLAIM_RULES: ClaimRule[] = [
  {
    id: "R1-signed-out-everywhere",
    re: /\bsign(?:s|ed|ing)?\b(?:\s+[\w'’-]+){0,4}?\s+out\s+(?:everywhere\b|of\s+(?:any|every|all)\b|(?:on|from)\s+(?:every|all)\b)|\bsign-?outs?\s+(?:everywhere\b|(?:on|from)\s+(?:every|all)\b)|\bglobal\s+sign-?\s?out\b/gi,
    negatable: true,
  },
  {
    id: "R2-always-revokes",
    re: /\b(?:always|every\s+(?:executed\s+)?revoke)\s+(?:revokes?|invalidates?|kills?|ends?)\b[^.;]{0,40}?\b(?:refresh[- ]tokens?|sessions?)\b|\b(?:refresh[- ]tokens?|sessions?)\s+(?:are|is|were|get)\s+always\s+(?:revoked|invalidated)\b/gi,
    negatable: true,
  },
  {
    id: "R3-cookie-rejected-immediately",
    re: /\b(?:immediately|instantly|at\s+once|right\s+away)\b/gi,
    negatable: true,
    sentenceAlso: [/\bcookies?\b/i, /\brevo(?:ke|ked|kes|king|cation)\b/i],
  },
  {
    id: "R4-bearer-tokens-lose-admin",
    re: /\b(?:already[- ]issued|existing|outstanding|current)\s+(?:admin\s+)?(?:ID|bearer)\s+tokens?\b[^.;]{0,60}?\b(?:(?:is|are)\s+(?:invalidated|revoked|rejected|invalid)\b|stops?\s+working\b|lose[sd]?\b|no\s+longer\b)|\brevo\w+[^.;]{0,40}?\b(?:immediately|instantly)\s+(?:removes?|ends?|cuts?\s+off|strips?)\b[^.;]{0,40}?\b(?:admin|privileges?|access)\b/gi,
    negatable: true,
  },
  {
    id: "R4-bearer-counterfactual",
    re: /\bwithout\s+(?:this|it|revocation|the\s+revo\w+)\b[^.;]{0,40}?\b(?:ID|bearer)\s+tokens?\s+keeps?\s+working\b/gi,
    negatable: false,
  },
  {
    id: "R5-cutoff-establishes-revocation",
    re: /\bcutoff\b[^.;]{0,60}?\b(?:means|shows|confirms|establishes|demonstrates|ensures)\b[^.;]{0,60}?\b(?:revoked|invalid(?:ated)?|signed\s+out|rejected|cut\s+off)\b|\bend-to-end\s+revocation\b|\b(?:revocation|sessions?)\s+(?:is|are|was|were)\s+(?:confirmed|complete|effective|in\s+effect)\b/gi,
    negatable: true,
  },
];

/**
 * The match is negated only when the text right before it ENDS in a negation,
 * optionally followed by up to three filler words ("is not a sign-out", "does
 * not immediately revoke"). A negation that governs something else ("a user who
 * never had admin signs that user out ...") does not excuse the claim.
 */
const NEGATED_PREFIX = /\b(?:not|never|no|nor|cannot|without|isn't|doesn't)\s+(?:(?:a|an|the|be|been|is|are|it|always|immediately|itself)\s+){0,3}$/i;

/** Rule ids an (already code-span-stripped) sentence violates. */
function claimViolations(sentence: string): string[] {
  const out: string[] = [];
  for (const rule of CLAIM_RULES) {
    if (rule.sentenceAlso && !rule.sentenceAlso.every((r) => r.test(sentence))) continue;
    for (const m of sentence.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      const prefix = sentence.slice(Math.max(0, (m.index ?? 0) - 80), m.index);
      if (rule.negatable && NEGATED_PREFIX.test(prefix)) continue;
      out.push(rule.id);
      break;
    }
  }
  return out;
}

function claimOffending(text: string): { sentence: string; rules: string[] }[] {
  return docSentences(text)
    .map((sentence) => ({ sentence, rules: claimViolations(sentence) }))
    .filter((x) => x.rules.length > 0);
}

/** The six sentences the a528f9e review cited (MINOR-1, MINOR-2), verbatim, code spans included. */
const CITED_A528F9E = [
  ["R1-signed-out-everywhere", "Side effect of the policy: the target is signed out everywhere, including\nordinary (non-admin) use."],
  ["R1-signed-out-everywhere", "- Note: this also means a revoke aimed at a user who never had `admin` signs\n  that user out everywhere."],
  ["R1-signed-out-everywhere", "The re-run also signs the target out\nof any session it did manage to start; that is the policy for every revoke."],
  ["R2-always-revokes", "A revoke always revokes the target's refresh tokens\n(owner policy) and reports success only when Firebase acknowledged the\nrevocation call AND the read-back `tokensValidAfterTime` is at or after a\ncutoff anchored on a Firestore server commit time taken after the claim\nremoval."],
  ["R2-always-revokes", "Revoke always revokes refresh tokens and is allowed on a disabled account (grant is refused for one; the tool never changes `disabled`)."],
  ["R2-always-revokes", "- **Revoke always revokes sessions.** Owner policy: removing `admin` ALWAYS\n  calls `revokeRefreshTokens` for the target, with no opt-out."],
] as const;

/** Other overstated sentences fixed in the same sweep (admin-authority-tiers.md containment section). */
const FIXED_ELSEWHERE = [
  ["R3-cookie-rejected-immediately", "Session cookies are a separate artifact and are verified with\n   `verifySessionCookie(cookie, true)`, so revocation and disablement DO take\n   effect there immediately."],
  ["R4-bearer-counterfactual", "**Revoke refresh tokens** — `adminAuth.revokeRefreshTokens(uid)`. Without this\n   the already-issued ID token keeps working."],
] as const;

/** Accurate, conditional or negated explanations: every rule must pass these. */
const POSITIVE_CONTROLS = [
  "Every revoke requests session revocation.",
  "Every executed revoke requests revocation of the target's refresh tokens (owner policy).",
  "Where Firebase applies it, it ends the target's ordinary (non-admin) sessions too, and the target may have to sign in again.",
  "It is not a sign-out from every device: already-issued ID tokens keep working until they expire.",
  "Only if Firebase applied the request (an acknowledged call; a thrown call's effect is unknown): on its next request, a cookie whose session auth_time is earlier than the stored validSince fails the revocation check and is rejected.",
  "so disablement takes effect there on the next request, and so does an applied revocation — but only for a cookie whose session auth_time is earlier than the stored validSince.",
  "Existing session cookies stop working immediately once the account is disabled.",
  "A refresh-token revocation request, even an acknowledged one, is NOT sufficient to cut SYSTEM_ADMIN access off immediately.",
  "An already-issued ID token is NOT invalidated by the revoke.",
  "It does not immediately revoke CLAIM-derived authority.",
  "The observed cutoff is not proof that sessions were revoked, and the tool never reports revocation as complete.",
  "A thrown call is an UNKNOWN outcome, not a confirmed no-op: re-run the same command.",
  "If the call is acknowledged, a session the target did manage to start is rejected wherever revocation is checked only when its auth_time is earlier than the new validSince.",
];

const REVOKE_DOC_SCOPES: [string, (t: string) => string][] = [
  ["docs/operations/system-admin-claim-script.md", (t) => t],
  ["docs/operations/admin-authority-tiers.md (Option 1)", (t) => section(t, "**Option 1", "**Option 2")],
  ["docs/operations/admin-authority-tiers.md (Phase C5 consequence)", (t) => section(t, "**Consequence to know before enrolling anyone", "### BOOTSTRAP_SECRET")],
  ["docs/operations/admin-authority-tiers.md (incident procedure)", (t) => section(t, "## Incident procedure", "Immediate, guaranteed cutoff for a claim-derived SYSTEM_ADMIN")],
  ["docs/technical-documentation.md (operator claim tool)", (t) => section(t, "**Operator claim tool:**", "\n\n")],
];

describe("no unconditional revoke-effect claims (PR #295 sweep, owner order B)", () => {
  it.each(CITED_A528F9E.map(([rule, s]) => [rule, s]))("CONTROL (cited at a528f9e): %s flags %j", (rule, s) => {
    const hits = claimOffending(s);
    expect(hits.flatMap((h) => h.rules)).toContain(rule);
  });

  it.each(FIXED_ELSEWHERE.map(([rule, s]) => [rule, s]))("CONTROL (fixed in the sweep): %s flags %j", (rule, s) => {
    expect(claimOffending(s).flatMap((h) => h.rules)).toContain(rule);
  });

  it("CONTROL: every rule has at least one failing example", () => {
    const covered = new Set([...CITED_A528F9E, ...FIXED_ELSEWHERE].map(([r]) => r));
    const synthetic: Record<string, string> = {
      "R4-bearer-tokens-lose-admin": "After the revoke, existing ID tokens no longer carry admin.",
      "R5-cutoff-establishes-revocation": "An observed cutoff confirms the sessions were revoked.",
    };
    for (const [id, s] of Object.entries(synthetic)) {
      expect({ id, rules: claimOffending(s).flatMap((h) => h.rules) }).toEqual({ id, rules: [id] });
      covered.add(id);
    }
    expect(claimOffending("Revocation was effective end-to-end.").flatMap((h) => h.rules)).toEqual(["R5-cutoff-establishes-revocation"]);
    // A negation that governs something else does not excuse the claim.
    expect(claimOffending("A user who never had admin is signed out everywhere.").flatMap((h) => h.rules)).toEqual(["R1-signed-out-everywhere"]);
    expect(claimOffending("This shows end-to-end revocation.").flatMap((h) => h.rules)).toEqual(["R5-cutoff-establishes-revocation"]);
    expect([...covered].sort()).toEqual(CLAIM_RULES.map((r) => r.id).sort());
  });

  it.each(POSITIVE_CONTROLS)("POSITIVE CONTROL passes: %s", (s) => {
    expect(claimOffending(s)).toEqual([]);
  });

  it.each(REVOKE_DOC_SCOPES)("%s", (label, pick) => {
    const file = label.split(" ")[0];
    expect({ file, offending: claimOffending(pick(read(file))) }).toEqual({ file, offending: [] });
  });

  it("the sweep keeps the six distinctions: requested, acknowledged, cutoff observed, assumption, S2, incomplete/retry", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    const runbook = flat(read("docs/operations/system-admin-claim-script.md"));
    for (const needle of [
      "revocation is REQUESTED",
      "a thrown call is an UNKNOWN outcome",
      "**(a) API acknowledgment.**",
      "**(b) Observed cutoff.**",
      "**(c) Clock-alignment ASSUMPTION.**",
      "is ASSUMED to apply the same rule",
      "S2 (live admin authorization in route guards)",
      "Treat every credential in this table as still valid",
      "and re-run the same command",
    ]) {
      expect({ needle, present: runbook.includes(needle) }).toEqual({ needle, present: true });
    }
    const opt1 = flat(section(read("docs/operations/admin-authority-tiers.md"), "**Option 1", "**Option 2"));
    expect(opt1).toMatch(/requests revocation of the target's refresh tokens/);
    expect(opt1).toMatch(/unknown outcome/);
    const tech = flat(section(read("docs/technical-documentation.md"), "**Operator claim tool:**", "\n\n"));
    expect(tech).toMatch(/requests refresh-token revocation/);
    expect(tech).toMatch(/unknown outcome, not a confirmed no-op/);
  });
});
