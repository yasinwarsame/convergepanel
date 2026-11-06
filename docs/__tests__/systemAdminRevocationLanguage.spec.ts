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
