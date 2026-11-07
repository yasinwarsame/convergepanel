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

import * as ts from "typescript";

import {
  CLAIM_AUDIT_ACTION_TYPES,
  COMPLETED_OUTCOMES,
  CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  POST_WRITE_FAILURES,
  RETIRED_REVOKE_CONFIRMATION_PREFIXES,
  REVIEW_REQUIRED_OUTCOMES,
  REVOCATION_CLOCK_ASSUMPTION,
  REVOCATION_OBSERVED_SUMMARY,
  type SessionRevocationObservations,
  checkOperatorClock,
  checkPreCallCutoff,
  expectedConfirmation,
  validSinceLowerThanBeforeDetail,
} from "../../lib/admin/systemAdminClaimSafety";
import { RERUN_GUIDANCE, REVIEW_GUIDANCE, REVOKE_SESSIONS_PLAN_LINE, revocationSummary } from "../../lib/admin/systemAdminClaimExecution";

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

const SAMPLE_EVIDENCE: SessionRevocationObservations = {
  sessionRevocationState: "CUTOFF_OBSERVED",
  effectiveRevocation: "not_observable",
  claimWrite: "confirmed",
  revocationRequested: true,
  revocationApiAcknowledged: true,
  anchorSource: "firestore-commit-time:users/{uid}.role",
  anchorServerTime: "2026-11-05T10:00:00.000Z",
  marginSeconds: 2,
  cutoff: "2026-11-05T10:00:03.000Z",
  tokensValidAfterTimeBefore: null,
  preCallCheck: { read: "read", tokensValidAfterTime: null, storedSeconds: null, localSeconds: 1793872804, decision: "call" },
  tokensValidAfterTimeAfter: "Thu, 05 Nov 2026 10:00:04 GMT",
  tokensValidAfterTimeLowerThanBefore: false,
  validSinceMinusAnchorSeconds: 4,
  cutoffObserved: true,
  clockAlignmentAssumption: REVOCATION_CLOCK_ASSUMPTION,
  currentPrivilegeEnforcement: CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  detail: null,
};

/** Every operator-facing string the tool renders from constants and builders (rendered, not source). */
function renderedOperatorStrings(): string[] {
  const gate = checkOperatorClock({ localBeforeMs: 0 + 1_793_872_800_000, localAfterMs: 1_793_872_800_100, commit: { seconds: 1_793_872_900, nanoseconds: 0 }, marginSeconds: 2 });
  const ahead = checkPreCallCutoff({ uid: "u", tokensValidAfterTime: "Thu, 05 Nov 2026 12:00:00 GMT" }, "u", 1_793_872_804_000);
  return [
    REVOCATION_CLOCK_ASSUMPTION, CURRENT_PRIVILEGE_ENFORCEMENT_NOTE, REVOCATION_OBSERVED_SUMMARY, RERUN_GUIDANCE, REVIEW_GUIDANCE, REVOKE_SESSIONS_PLAN_LINE,
    revocationSummary(SAMPLE_EVIDENCE), revocationSummary(null),
    validSinceLowerThanBeforeDetail("Thu, 05 Nov 2026 10:00:04 GMT", "Thu, 05 Nov 2026 09:59:00 GMT"),
    gate.ok ? "" : gate.detail,
    ahead.decision === "skip_stored_ahead" ? ahead.detail : "",
  ].filter(Boolean);
}

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
    ["docs/operations/admin-authority-tiers.md (Phase C5 consequence)", (t: string) => section(t, "**Consequence to know before enrolling anyone", "### BOOTSTRAP_SECRET")],
    ["docs/operations/admin-authority-tiers.md (does NOT give you)", (t: string) => t.slice(t.indexOf("### What this procedure does NOT give you"))],
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
    const strings = renderedOperatorStrings();
    expect(strings.flatMap((s) => offending(docSentences(s)))).toEqual([]);
  });
});

describe("the assumption and the enforcement caveat are stated", () => {
  it("the success summary names acknowledgment, the observed cutoff, the unbounded 2 s assumption and S2", () => {
    const m = revocationSummary(SAMPLE_EVIDENCE);
    expect(m).toContain("revocation requested and acknowledged; cutoff observed at or after the server-anchored cutoff under the Firestore≈Auth clock assumption (skew < 2 s assumed, unbounded); effective revocation not observable");
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
      "**(d) Enforcement of current admin privileges: not provided (until S2).**",
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
 * PR #295 doc sweep (owner order B). Six classes of UNCONDITIONAL claim about
 * the revoke path are unsupported by what the tool can observe:
 *   R1 the target is signed / logged out everywhere / on every device;
 *   R2 a revoke always revokes refresh tokens / sessions, or never fails to
 *      (it always REQUESTS revocation; the call can fail, and a thrown call is
 *      an unknown outcome);
 *   R3 session cookies are rejected immediately on revocation (only cookies
 *      whose auth_time is earlier than the stamped validSince, and only if the
 *      request was applied);
 *   R4 already-issued / bearer ID tokens are invalidated or lose admin at once
 *      (they do not: the bearer guards skip checkRevoked until S2);
 *   R5 an observed cutoff establishes end-to-end revocation / "the revocation
 *      worked" (it rests on an unproven cross-service clock assumption);
 *   R6 a repeated revocation request is harmless, idempotent, monotonic, "safe",
 *      or can only reduce access (revokeRefreshTokens OVERWRITES validSince with
 *      the caller's clock, so a later call from a slower clock can lower it).
 * A match is ignored when a negation ends the text right before it, so
 * accurate denials ("is not a sign-out from every device") pass. The positive
 * controls below are accurate conditional sentences that must keep passing.
 *
 * Docs are scanned with inline code spans KEPT as text (so "`cutoffObserved:
 * true` means the revocation worked" is caught); the proof-word scan above
 * still strips them (identifiers like verifyIdToken).
 */
type ClaimRule = {
  id: string;
  re: RegExp;
  negatable: boolean;
  /** Skip a match preceded (same clause) by a conditional: "whether a re-run is safe depends on ...". */
  conditionalOk?: boolean;
  sentenceAlso?: RegExp[];
};

/** Excludes a hedge between a verb and its object ("means the session MAY still be rejected"). */
const NO_HEDGE = String.raw`(?:(?!\b(?:may|might|could|if|whether|unless|only|not|when)\b)[^.;])`;
const REVO = String.raw`revo(?:ke|ked|kes|king|cation)`;

const CLAIM_RULES: ClaimRule[] = [
  {
    id: "R1-signed-out-everywhere",
    re: new RegExp(
      String.raw`\b(?:sign|log)(?:s|ged|ed|ing)?\b(?:\s+[\w'’-]+){0,4}?\s+(?:out|off)\s+(?:everywhere\b|of\s+(?:any|every|all)\b|(?:on|from|across)\s+(?:every|all)\b)` +
      String.raw`|\b(?:sign|log)-?\s?outs?\s+(?:everywhere\b|(?:on|from|across)\s+(?:every|all)\b)|\bglobal\s+(?:sign|log)-?\s?out\b`,
      "gi",
    ),
    negatable: true,
  },
  {
    id: "R2-always-revokes",
    re: new RegExp(
      String.raw`\b(?:always|every\s+(?:executed\s+)?revoke)\s+(?:revokes?|invalidates?|kills?|ends?(?!\s+(?:with|by|in|up|at)\b))\b[^.;]{0,40}?\b(?:refresh[- ]tokens?|tokens?|sessions?)\b` +
      String.raw`|\b(?:refresh[- ]tokens?|sessions?)\s+(?:are|is|were|get)\s+always\s+(?:revoked|invalidated)\b` +
      String.raw`|\bnever\s+fails?\s+to\s+(?:revoke|invalidate|sign|log|end|kill)\b`,
      "gi",
    ),
    negatable: true,
  },
  {
    id: "R3-cookie-rejected-immediately",
    re: new RegExp(
      String.raw`\b(?:cookies?|sessions?)\b[^.;]{0,60}?\b(?:rejected|invalid(?:ated)?|revoked|stop\s+working|fail|ends?)\b[^.;]{0,30}?\b(?:immediately|instantly|at\s+once|right\s+away)\b` +
      String.raw`|\b(?:immediately|instantly|at\s+once|right\s+away)\s+(?:rejects?|invalidates?|revokes?|ends?|kills?)\b[^.;]{0,40}?\b(?:cookies?|sessions?)\b` +
      String.raw`|\b${REVO}\b[^.;]{0,60}?\btakes?\s+effect\b[^.;]{0,40}?\b(?:immediately|instantly|at\s+once|right\s+away)\b`,
      "gi",
    ),
    negatable: true,
    sentenceAlso: [/\bcookies?\b/i, new RegExp(String.raw`\b${REVO}\b`, "i")],
  },
  {
    id: "R4-bearer-tokens-lose-admin",
    re: new RegExp(
      String.raw`\b(?:already[- ]issued|existing|outstanding|current)\s+(?:admin\s+)?(?:ID|bearer)\s+tokens?\b[^.;]{0,60}?\b(?:(?:is|are)\s+(?:invalidated|revoked|rejected|invalid)\b|stops?\s+working\b|lose[sd]?\b|no\s+longer\b)` +
      String.raw`|\b${REVO}[^.;]{0,40}?\b(?:immediately|instantly)\s+(?:removes?|ends?|cuts?\s+off|strips?)\b[^.;]{0,40}?\b(?:admin|privileges?|access)\b` +
      String.raw`|\b(?:ID|bearer)(?:\s+ID)?\s+tokens?\s+(?:are|is|were|get|will\s+be)\s+(?:invalidated|revoked|rejected|cut\s+off)\b(?!\s+(?:only|when|if|where|unless)\b)`,
      "gi",
    ),
    negatable: true,
  },
  {
    id: "R4-bearer-counterfactual",
    re: /\bwithout\s+(?:this|it|revocation|the\s+revo\w+)\b[^.;]{0,40}?\b(?:ID|bearer)\s+tokens?\s+keeps?\s+working\b/gi,
    negatable: false,
  },
  {
    id: "R5-cutoff-establishes-revocation",
    re: new RegExp(
      String.raw`\bcutoff\w*\b[^.;]{0,60}?\b(?:means|shows|confirms|establishes|demonstrates|ensures)\b${NO_HEDGE}{0,60}?\b(?:revoked|invalid(?:ated)?|signed\s+out|rejected|cut\s+off|worked|succeeded|took\s+effect)\b` +
      String.raw`|\bend-to-end\s+revocation\b|\b(?:revocation|sessions?)\s+(?:is|are|was|were)\s+(?:confirmed|complete|effective|in\s+effect)\b` +
      String.raw`|\b(?:means|shows|confirms|establishes|demonstrates|ensures)\b${NO_HEDGE}{0,60}?\b(?:revocation|revoke|sessions?)\b${NO_HEDGE}{0,30}?\b(?:worked|succeeded|took\s+effect|is\s+effective|was\s+effective|happened)\b` +
      String.raw`|\b(?:revocation|revoke)\s+(?:worked|succeeded|took\s+effect)\b`,
      "gi",
    ),
    negatable: true,
  },
  {
    id: "R6-repeat-is-harmless",
    re: /\b(?:harmless|idempotent|monotonic(?:ally)?|non-decreasing)\b/gi,
    negatable: true,
    sentenceAlso: [new RegExp(String.raw`\b${REVO}\b|validSince|tokensValidAfterTime|cutoff|\bsessions?\b|re-?run|repeat|retry`, "i")],
  },
  {
    id: "R6-rerun-is-safe",
    re: /\b(?:re-?run(?:ning)?|repeat(?:ing|ed)?|retry(?:ing)?|running\s+it\s+again|(?:the\s+)?same\s+command)\b[^.;:]{0,60}?\b(?:is|are|stays?|remains?)\s+(?:always\s+|completely\s+|perfectly\s+)?(?:safe|harmless|a\s+no-op)\b/gi,
    negatable: true,
    conditionalOk: true,
  },
  {
    id: "R6-only-reduces-access",
    re: /\bonly\s+(?:ever\s+)?(?:reduces?|removes?|restricts?|narrows?|lowers?)\b[^.;]{0,30}?\b(?:access|privileges?|authority)\b|\bcan\s+never\s+(?:grant|restore|re-?admit|widen)\b|\bnever\s+(?:grants?|restores?|re-?admits?)\s+(?:it|access|a\s+session|sessions)\b|\bcannot\s+(?:lower|re-?admit|move\b[^.;]{0,20}\bbackward)/gi,
    negatable: true,
    sentenceAlso: [new RegExp(String.raw`\b${REVO}\b|validSince|tokensValidAfterTime|cutoff`, "i")],
  },
];

/**
 * The match is negated only when the text right before it ENDS in a negation,
 * optionally followed by up to three filler words ("is not a sign-out", "does
 * not immediately revoke"). A negation that governs something else ("a user who
 * never had admin signs that user out ...") does not excuse the claim.
 */
const NEGATED_PREFIX = /\b(?:not|never|no|nor|cannot|without|isn't|doesn't)\s+(?:(?:a|an|the|be|been|is|are|it|always|immediately|itself)\s+){0,3}$/i;
const CONDITIONAL_PREFIX = /\b(?:whether|if|unless|only\s+when|only\s+if)\b[^.;:]{0,60}$/i;

/** Rule ids a sentence violates. */
function claimViolations(sentence: string): string[] {
  const out: string[] = [];
  for (const rule of CLAIM_RULES) {
    if (rule.sentenceAlso && !rule.sentenceAlso.every((r) => r.test(sentence))) continue;
    for (const m of sentence.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      const prefix = sentence.slice(Math.max(0, (m.index ?? 0) - 80), m.index);
      if (rule.negatable && NEGATED_PREFIX.test(prefix)) continue;
      if (rule.conditionalOk && CONDITIONAL_PREFIX.test(prefix)) continue;
      out.push(rule.id);
      break;
    }
  }
  return out;
}

/** Doc sentences with inline code spans KEPT as plain text (fenced blocks dropped). */
function docSentencesKeepCode(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .split(/\n\s*\n|(?<=[.!?])\s+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function claimOffending(text: string): { sentence: string; rules: string[] }[] {
  return docSentencesKeepCode(text)
    .map((sentence) => ({ sentence, rules: claimViolations(sentence) }))
    .filter((x) => x.rules.length > 0);
}

/**
 * Operator-facing text of a TypeScript file, from the real AST: every string
 * literal and template literal (substitutions shown as "X"), and every comment.
 * With `testTitlesOnly`, only the titles passed to describe/it/test (spec files).
 */
function sourceTexts(file: string, opts: { testTitlesOnly?: boolean } = {}): string[] {
  const text = read(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const lit = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => `X${s.literal.text}`).join("");
    return null;
  };
  const seenComments = new Set<number>();
  const visit = (n: ts.Node): void => {
    if (opts.testTitlesOnly) {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const callee = n.expression.getText(sf);
        if (/^(?:describe|it|test)(?:\.(?:each|only|skip)(?:\([\s\S]*\))?)?$/.test(callee) || /^(?:describe|it|test)\.each\b/.test(callee)) {
          const t = lit(n.arguments[0]);
          if (t !== null) out.push(t);
        }
      }
    } else {
      const t = lit(n);
      if (t !== null) out.push(t);
      for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) {
        if (seenComments.has(r.pos)) continue;
        seenComments.add(r.pos);
        out.push(text.slice(r.pos, r.end).replace(/^\/\*+|\*+\/$/g, "").replace(/^\s*(?:\/\/+|\*)\s?/gm, ""));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sourceClaimOffending(file: string, opts: { testTitlesOnly?: boolean } = {}): { sentence: string; rules: string[] }[] {
  return sourceTexts(file, opts).flatMap((t) => claimOffending(t));
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

/**
 * The b7c23de review (MINOR-1, NITs, carried MINOR): the statements it cited,
 * verbatim, and the paraphrases it showed passing the lexical scan. Each must
 * now be flagged.
 */
const CITED_B7C23DE = [
  // MINOR-1, runbook :225-226.
  ["R6-only-reduces-access", "`setCustomUserClaims` may have applied\n   server-side before it threw, and a revocation request can only reduce\n   access, never grant it."],
  // NIT, runbook :322.
  ["R6-repeat-is-harmless", "calls `revokeRefreshTokens` again (repeating the request is\n  harmless; it re-stamps `validSince` from the operator's clock)"],
  // Carried MINOR: printed strings and comments.
  ["R1-signed-out-everywhere", "Sessions:       the target's refresh tokens WILL be revoked (mandatory on revoke; signs the user out everywhere)."],
  ["R2-always-revokes", "Refusing --revoke-sessions: the flag was removed. Revoking admin ALWAYS revokes the target's refresh tokens (owner policy); there is no opt-out."],
  ["R6-rerun-is-safe", "Re-running the same command is safe: it never re-applies a claim already in place, never changes any other claim, and a revoke re-run whose claim is already absent only completes the outstanding session revocation (no claim write)."],
  ["R6-only-reduces-access", "Attempted even when step 3 failed, and even when the claim write in step 2 threw (it may have applied server-side): revoking only removes access — but such a run is INCOMPLETE (exit 3)."],
  ["R2-always-revokes", "Revoke ALWAYS revokes refresh tokens (owner policy); grant never does."],
  ["R2-always-revokes", "Revoke always revokes refresh tokens; grant never does."],
  // Paraphrases that passed the b7c23de scan.
  ["R2-always-revokes", "The tool never fails to revoke the target's sessions."],
  ["R1-signed-out-everywhere", "A revoke logs the user out on every device."],
  ["R4-bearer-tokens-lose-admin", "Bearer tokens are invalidated by the revoke."],
  ["R5-cutoff-establishes-revocation", "`cutoffObserved: true` means the revocation worked."],
  ["R6-repeat-is-harmless", "A repeated revocation is monotonic: validSince never moves backward."],
  ["R6-rerun-is-safe", "Retrying the revoke is always safe."],
  ["R6-only-reduces-access", "A re-run cannot lower the cutoff."],
  // b7c23de test title (spec :261), not caught by the "refresh tokens" form.
  ["R2-always-revokes", "revoke removes only admin, writes the role anchor, ALWAYS revokes tokens, verifies against the server cutoff"],
  // Needs the code span KEPT: stripped, this sentence has no revocation term left.
  ["R6-repeat-is-harmless", "`validSince` is monotonic."],
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
  // Accurate conditionals the b7c23de rules rejected (false positives now fixed).
  "Disabling the account denies email-derived authority immediately; a cookie is rejected after a revocation only when its auth_time is earlier than validSince.",
  "Every revoke ends with an outcome row that records the session evidence.",
  "A cutoff that is not observed means the session may still be valid or may already be rejected.",
  "Bearer ID tokens are rejected only where checkRevoked is used.",
  // Accurate R6 statements.
  "A repeated revocation request is not monotonic: a re-run from a slow clock can move the cutoff backward.",
  "Repeating the request is not harmless: it overwrites validSince with the operator's clock.",
  "Whether a re-run is safe depends on the operator clock.",
  "Re-running the same command is how an incomplete run is finished.",
  "The re-run never re-applies a claim already in place and never changes any other claim.",
  "A grant never revokes sessions.",
  "That request is not guaranteed to narrow access: from a slow clock it can lower validSince.",
  "`cutoffObserved: true` means only that the read-back is at or after the cutoff, under the clock assumption.",
];

const tiersAfter = (from: string) => (t: string) => {
  const a = t.indexOf(from);
  if (a < 0) throw new Error(`section not found: ${from}`);
  return t.slice(a);
};

const REVOKE_DOC_SCOPES: [string, (t: string) => string][] = [
  ["docs/operations/system-admin-claim-script.md", (t) => t],
  ["docs/operations/admin-authority-tiers.md (Option 1)", (t) => section(t, "**Option 1", "**Option 2")],
  ["docs/operations/admin-authority-tiers.md (Phase C5 consequence)", (t) => section(t, "**Consequence to know before enrolling anyone", "### BOOTSTRAP_SECRET")],
  ["docs/operations/admin-authority-tiers.md (incident procedure)", (t) => section(t, "## Incident procedure", "### What this procedure does NOT give you")],
  ["docs/operations/admin-authority-tiers.md (does NOT give you)", tiersAfter("### What this procedure does NOT give you")],
  ["docs/technical-documentation.md (operator claim tool)", (t) => section(t, "**Operator claim tool:**", "\n\n")],
];

const SOURCE_FILES = [
  ...fs.readdirSync(path.join(REPO, "lib/admin")).filter((f) => /^systemAdminClaim.*\.ts$/.test(f)).map((f) => `lib/admin/${f}`),
  "scripts/admin/set-system-admin-claim.ts",
];
const SPEC_FILES = [
  "lib/admin/__tests__/systemAdminClaimExecution.spec.ts",
  "lib/admin/__tests__/systemAdminClaimSafety.spec.ts",
  "scripts/admin/__tests__/setSystemAdminClaimCli.spec.ts",
  "scripts/admin/__tests__/setSystemAdminClaimRealPorts.spec.ts",
];

describe("no unconditional revoke-effect claims (PR #295 sweep, owner order B)", () => {
  it.each(CITED_A528F9E.map(([rule, s]) => [rule, s]))("CONTROL (cited at a528f9e): %s flags %j", (rule, s) => {
    const hits = claimOffending(s);
    expect(hits.flatMap((h) => h.rules)).toContain(rule);
  });

  it.each(FIXED_ELSEWHERE.map(([rule, s]) => [rule, s]))("CONTROL (fixed in the sweep): %s flags %j", (rule, s) => {
    expect(claimOffending(s).flatMap((h) => h.rules)).toContain(rule);
  });

  it.each(CITED_B7C23DE.map(([rule, s]) => [rule, s]))("CONTROL (cited at b7c23de / paraphrase): %s flags %j", (rule, s) => {
    expect(claimOffending(s).flatMap((h) => h.rules)).toContain(rule);
  });

  it("CONTROL: every rule has at least one failing example", () => {
    const covered = new Set([...CITED_A528F9E, ...FIXED_ELSEWHERE, ...CITED_B7C23DE].map(([r]) => r));
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

  it("CONTROL: the claim scan keeps code spans (stripping them would hide `validSince` is monotonic.)", () => {
    expect(docSentencesKeepCode("`validSince` is monotonic.")).toEqual(["validSince is monotonic."]);
    expect(claimViolations(docSentences("`validSince` is monotonic.").join(" "))).toEqual([]);
  });

  it("the tiers 'does NOT give you' scope is the real body (not just the heading)", () => {
    // Read through the SAME picker the scope test uses, so an emptied scope fails here.
    const pick = REVOKE_DOC_SCOPES.find(([label]) => label.endsWith("(does NOT give you)"))![1];
    const body = pick(read("docs/operations/admin-authority-tiers.md"));
    expect(body.length).toBeGreaterThan(300);
    expect(body).toMatch(/S2/);
    expect(body).toMatch(/lower that value/);
  });

  it("the source extractor really reads string literals, template literals and comments (falsifiable)", () => {
    const texts = sourceTexts("lib/admin/systemAdminClaimExecution.ts");
    expect(texts).toContain("Claim write:    SKIPPED - the admin claim is already absent; claims will NOT be rewritten.");
    expect(texts.some((t) => t.startsWith("Completed: the admin claim was already absent, so no claim was written. X"))).toBe(true);
    expect(texts.some((t) => /SYSTEM_ADMIN claim operator tool: orchestration over injected ports/.test(t))).toBe(true);
    expect(SOURCE_FILES).toEqual(expect.arrayContaining([
      "lib/admin/systemAdminClaimExecution.ts", "lib/admin/systemAdminClaimSafety.ts", "scripts/admin/set-system-admin-claim.ts",
    ]));
    const titles = sourceTexts("lib/admin/__tests__/systemAdminClaimExecution.spec.ts", { testTitlesOnly: true });
    expect(titles).toContain("performs ZERO writes, exits 2 (not completed), and prints the exact confirmation");
    expect(titles.length).toBeGreaterThan(50);
  });

  it.each(SOURCE_FILES)("source string literals and comments: %s", (file) => {
    expect({ file, offending: sourceClaimOffending(file) }).toEqual({ file, offending: [] });
  });

  it.each(SPEC_FILES)("test titles: %s", (file) => {
    expect({ file, offending: sourceClaimOffending(file, { testTitlesOnly: true }) }).toEqual({ file, offending: [] });
  });

  it("exported operator strings (rendered) pass the claim rules", () => {
    const strings = renderedOperatorStrings();
    expect(strings.flatMap((s) => claimOffending(s))).toEqual([]);
    expect(strings.flatMap((s) => offending(docSentences(s)))).toEqual([]);
  });

  it("the sweep keeps the distinctions: requested, acknowledged, cutoff observed, assumption, S2, incomplete/retry, lowered cutoffs, exit 4", () => {
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
      "### Lowered cutoffs (unresolved risk; narrowed for this tool only)",
      "It OVERWRITES the stored value; it does not keep the later of the two.",
      "Nothing more is claimed: the cutoff stays overwrite-only for every other caller.",
      "**Owner policy (amended, D-2a).**",
      "if `V < S` the call is **not made** (exit 4 `stored_cutoff_ahead`)",
      "**Precedence 3 > 4 > 0.**",
      "`tokensValidAfterTimeLowerThanBefore`",
      "exit 4 `revocation_cutoff_lowered`",
      "`operator_clock_out_of_tolerance`",
      "`pre_call_read_failed`",
      "`effectiveRevocation: \"not_observable\"`",
      "What is NOT covered.",
      "Sync the operator clock (NTP) before every revoke and every re-run.",
    ]) {
      expect({ needle, present: runbook.includes(needle) }).toEqual({ needle, present: true });
    }
    // The retracted statements are gone everywhere in the runbook.
    for (const gone of [
      "can only reduce access", "repeating the request is harmless", "any exit 3 is safe", "**Re-running the same command is safe**", "The printed sessions line overstates",
      "WARNING (not a clean success)", "moved BACKWARD", "The local clock is never compared with anything", "this run's call LOWERED",
    ]) {
      expect({ gone, present: runbook.includes(gone) }).toEqual({ gone, present: false });
    }
    const opt1 = flat(section(read("docs/operations/admin-authority-tiers.md"), "**Option 1", "**Option 2"));
    expect(opt1).toMatch(/requests revocation of the target's refresh tokens/);
    expect(opt1).toMatch(/unknown outcome/);
    expect(opt1).toMatch(/overwrite-only/);
    const c5 = flat(section(read("docs/operations/admin-authority-tiers.md"), "**Consequence to know before enrolling anyone", "### BOOTSTRAP_SECRET"));
    expect(c5).toMatch(/Neither of them shortens that ≤1 hour window for an already-issued ID token/);
    expect(c5).toMatch(/S2/);
    const tech = flat(section(read("docs/technical-documentation.md"), "**Operator claim tool:**", "\n\n"));
    expect(tech).toMatch(/requests refresh-token revocation/);
    expect(tech).toMatch(/unknown outcome, not a confirmed no-op/);
    expect(tech).toMatch(/overwrite-only/);
    expect(tech).not.toMatch(/re-run is safe/);
  });
});

/**
 * PR #295 G5 (owner Order 18): no text may claim global monotonicity. Because
 * the Auth API is overwrite-only (no compare-and-set), the words below are
 * forbidden outright in every shipped doc scope, source string/comment and
 * rendered operator string — negated or not. The allowed statement is: "this
 * tool refuses to write a value lower than the one it reads immediately before
 * the call, and reports any lowering it observes within its own run".
 *
 * R7: no effect-implying "revoked" (sessions/tokens/cookies/access "were
 * revoked", "sessions-revoked"), unless the same clause negates or
 * conditions it ("not proof that sessions were revoked", "whether ...").
 */
const FORBIDDEN_MONOTONIC = /\bmonotonic(?:ally|ity)?\b|\bcannot\s+be\s+lowered\b|\bprevents?\s+(?:any\s+)?lowering\b/gi;
const R7_EFFECT_REVOKED = new RegExp(
  String.raw`\b(?:sessions?|refresh[- ]tokens?|tokens?|cookies?|access|privileges?)\b[^.;:]{0,40}?\b(?:is|are|was|were|been|be|gets?|got)\s+(?:now\s+|all\s+|fully\s+|successfully\s+)?revoked\b` +
  String.raw`|sessions?[_ -]revoked\b|\brevoked\s+(?:the\s+(?:target'?s?\s+)?)?(?:sessions?|refresh[- ]tokens?)\b|\b(?:successfully|fully)\s+revoked\b`,
  "gi",
);
const R7_EXCUSE = /\b(?:not|never|no|nor|without|cannot|isn't|doesn't|whether|if|unless|only\s+when|retired|refused|formerly)\b[^.;]*$/i;

function forbiddenMonotonic(units: string[]): string[] {
  return units.filter((u) => new RegExp(FORBIDDEN_MONOTONIC.source, "gi").test(u));
}
function effectRevoked(units: string[]): string[] {
  return units.filter((u) => [...u.matchAll(new RegExp(R7_EFFECT_REVOKED.source, "gi"))].some((m) => !R7_EXCUSE.test(u.slice(Math.max(0, (m.index ?? 0) - 100), m.index))));
}

describe("G5: no monotonicity claims and no effect-implying 'revoked' (PR #295 Order 18)", () => {
  it("CONTROL: the forbidden-phrase scan flags every form, negated or not, and passes the allowed statement", () => {
    for (const bad of [
      "validSince is monotonic.", "The cutoff is not monotonic.", "A revocation is monotonically increasing.",
      "The cutoff cannot be lowered by this tool.", "G2 prevents lowering.", "The check prevents any lowering of the cutoff.",
    ]) {
      expect({ bad, hits: forbiddenMonotonic(docSentencesKeepCode(bad)).length }).toEqual({ bad, hits: 1 });
    }
    expect(forbiddenMonotonic(docSentencesKeepCode("This tool refuses to write a value lower than the one it reads immediately before the call, and reports any lowering it observes within its own run."))).toEqual([]);
  });

  it("CONTROL: the effect-revoked scan flags effect claims and identifiers, and passes negated/conditional/retired uses", () => {
    for (const bad of [
      "The target's sessions were revoked.", "Refresh tokens are revoked by the run.", "Sessions revoked; exit 0.",
      "outcome claim_already_absent_sessions_revoked", "confirmation revoke:admin:removed:sessions-revoked:p:u", "The run revoked the target's sessions.",
      "Access was successfully revoked.",
    ]) {
      expect({ bad, hits: effectRevoked(docSentencesKeepCode(bad)).length }).toEqual({ bad, hits: 1 });
    }
    for (const ok of [
      "It is not proof that sessions were revoked.",
      "Whether any session was revoked is not observable.",
      "The retired `revoke:admin:removed:sessions-revoked:<project>:<uid>` string is refused.",
      "Refusing: Firebase reports the operator's ID token as revoked (auth/id-token-revoked).",
      "operator_token_revoked",
    ]) {
      expect({ ok, hits: effectRevoked(docSentencesKeepCode(ok)) }).toEqual({ ok, hits: [] });
    }
  });

  it.each(REVOKE_DOC_SCOPES)("doc scope %s", (label, pick) => {
    const file = label.split(" ")[0];
    const units = docSentencesKeepCode(pick(read(file)));
    expect({ file, monotonic: forbiddenMonotonic(units), revoked: effectRevoked(units) }).toEqual({ file, monotonic: [], revoked: [] });
  });

  it.each([...SOURCE_FILES, "lib/admin/auditLog.ts", "app/admin/users/[uid]/page.tsx"])("source strings and comments: %s", (file) => {
    // The retired-confirmation list is the one allow-listed place for an old form.
    const units = sourceTexts(file).filter((t) => !RETIRED_REVOKE_CONFIRMATION_PREFIXES.includes(t)).flatMap((t) => docSentencesKeepCode(t));
    expect({ file, monotonic: forbiddenMonotonic(units), revoked: effectRevoked(units) }).toEqual({ file, monotonic: [], revoked: [] });
  });

  it.each(SPEC_FILES)("test titles: %s", (file) => {
    const units = sourceTexts(file, { testTitlesOnly: true });
    expect({ file, monotonic: forbiddenMonotonic(units), revoked: effectRevoked(units) }).toEqual({ file, monotonic: [], revoked: [] });
  });

  it("rendered operator strings", () => {
    const units = renderedOperatorStrings().flatMap((t) => docSentencesKeepCode(t));
    expect({ monotonic: forbiddenMonotonic(units), revoked: effectRevoked(units) }).toEqual({ monotonic: [], revoked: [] });
  });

  it("the allowed statement is present in the runbook, the tiers doc and the technical documentation", () => {
    const allowed = "this tool refuses to write a value lower than the one it reads immediately before the call, and reports any lowering it observes within its own run";
    for (const [file, pick] of [
      ["docs/operations/system-admin-claim-script.md", (t: string) => t],
      ["docs/operations/admin-authority-tiers.md", (t: string) => section(t, "**Option 1", "**Option 2")],
      ["docs/technical-documentation.md", (t: string) => section(t, "**Operator claim tool:**", "\n\n")],
    ] as const) {
      expect({ file, present: pick(read(file)).replace(/\s+/g, " ").toLowerCase().includes(allowed) }).toEqual({ file, present: true });
    }
  });
});

/**
 * PR #295 G4 identifier scan. No confirmation, outcome, run status or
 * actionType identifier may contain "revoked" or "_SESSIONS" (they would read
 * as an effect on sessions). The union members are read from the real AST, so
 * a new member cannot dodge the scan; the exported inventories must equal them.
 * The retired confirmation forms are allow-listed only in
 * RETIRED_REVOKE_CONFIRMATION_PREFIXES (and in refusal tests).
 */
function unionMembers(file: string, typeName: string): string[] {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === typeName) {
      const walk = (t: ts.Node): void => {
        if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
        ts.forEachChild(t, walk);
      };
      walk(n.type);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (out.length === 0) throw new Error(`no string members found for ${typeName} in ${file}`);
  return out;
}

const BAD_IDENTIFIER = /revoked|_SESSIONS/i;
const RETIRED_IDENTIFIERS = [
  "claim_already_absent_sessions_revoked", "REVOKE_SYSTEM_ADMIN_SESSIONS", "tokensValidAfterTimeMovedBackward",
  "sessionRevocationEvidence", "SessionRevocationEvidence", "validSinceMovedBackward", "sessions-revoked",
];

describe("G4: identifier scan (no confirmation, outcome, status or actionType identifier implies an effect)", () => {
  const SAFETY = "lib/admin/systemAdminClaimSafety.ts";
  const EXEC = "lib/admin/systemAdminClaimExecution.ts";
  const unions: [string, string][] = [
    [SAFETY, "CompletedOutcome"], [SAFETY, "ReviewRequiredOutcome"], [SAFETY, "PostWriteFailure"], [SAFETY, "ClaimAuditActionType"],
    [SAFETY, "SessionRevocationState"], [EXEC, "RunStatus"], ["lib/admin/auditLog.ts", "AdminActionType"],
  ];

  it("CONTROL: the scan pattern flags the retired identifiers", () => {
    for (const id of ["claim_already_absent_sessions_revoked", "REVOKE_SYSTEM_ADMIN_SESSIONS", "revoke:admin:removed:sessions-revoked:p:u"]) {
      expect({ id, bad: BAD_IDENTIFIER.test(id) }).toEqual({ id, bad: true });
    }
  });

  it.each(unions)("%s %s members", (file, name) => {
    const members = unionMembers(file, name);
    expect({ name, bad: members.filter((m) => BAD_IDENTIFIER.test(m)) }).toEqual({ name, bad: [] });
  });

  it("the exported inventories equal the type unions (a new member cannot dodge the scan)", () => {
    expect([...COMPLETED_OUTCOMES].sort()).toEqual(unionMembers(SAFETY, "CompletedOutcome").sort());
    expect([...REVIEW_REQUIRED_OUTCOMES].sort()).toEqual(unionMembers(SAFETY, "ReviewRequiredOutcome").sort());
    expect([...POST_WRITE_FAILURES].sort()).toEqual(unionMembers(SAFETY, "PostWriteFailure").sort());
    expect([...CLAIM_AUDIT_ACTION_TYPES].sort()).toEqual(unionMembers(SAFETY, "ClaimAuditActionType").sort());
  });

  it("the typed confirmations carry no effect identifier; only the retired list names the old forms", () => {
    for (const operation of ["grant", "revoke"] as const) {
      const c = expectedConfirmation({ operation, projectId: "cp-rehearsal-1", targetUid: "u" });
      expect({ c, bad: BAD_IDENTIFIER.test(c) }).toEqual({ c, bad: false });
    }
    expect(RETIRED_REVOKE_CONFIRMATION_PREFIXES).toContain("revoke:admin:removed:sessions-revoked:");
  });

  it.each([
    "lib/admin/systemAdminClaimSafety.ts", "lib/admin/systemAdminClaimExecution.ts", "scripts/admin/set-system-admin-claim.ts",
    "lib/admin/auditLog.ts", "app/admin/users/[uid]/page.tsx",
  ])("no retired identifier remains in %s (except the retired-confirmation list)", (file) => {
    const text = read(file).replace('"revoke:admin:removed:sessions-revoked:",', "");
    expect({ file, found: RETIRED_IDENTIFIERS.filter((id) => text.includes(id)) }).toEqual({ file, found: [] });
  });

  it("the admin UI labels every claim action type (the new one included) instead of showing it raw", () => {
    const page = read("app/admin/users/[uid]/page.tsx");
    for (const t of CLAIM_AUDIT_ACTION_TYPES) expect({ t, labelled: new RegExp(`\\b${t}:\\s*"`).test(page) }).toEqual({ t, labelled: true });
    expect(page).toContain("{auditActionTypeLabel(log.actionType)}");
  });
});
