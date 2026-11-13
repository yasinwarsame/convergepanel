/**
 * Order 30 A1 / A2 — the UI side of the standing attribution default (the export side is exportOutcomeIndependence.spec.tsx).
 *
 * A2 (review m-3): a stored claim whose supporting / positioned slots include a slot recorded as a failed call is an
 * inconsistent record. It never renders an unqualified support count: it is unverified, with the reason, and — when no
 * considered slot answered — states NO_SUCCESSFUL_MODEL_RESPONSES. Unknown / missing slots stay unverified (no basis).
 * The run scope (no stored claim joined) is unchanged (Order 29 option (b)).
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  FAILED_SUPPORTERS_CLAUSE,
  TOO_FEW_ANSWERS_NAMES_SUFFIX,
  NO_RESPONSES_NAMES,
  NO_RESPONSES_STATUS_HEADING,
  NO_SUCCESSFUL_MODEL_RESPONSES,
  adaptiveTopIndependence,
  adaptiveTopIndependenceStatement,
  qualifiedRowResult,
  qualifiedRowText,
  qualifiedStatusHeading,
  raisedByText,
  rowIndependence,
  runIndependence,
  runIndependenceNote,
  runScopeQualifier,
  legacyRunScopeQualifier,
  answerIndependenceNote,
  slotAgreementLabel,
  NO_RESPONSES_RUN,
  TOO_FEW_ANSWERS_RUN,
  TOO_FEW_ANSWERS_STATEMENT,
  FAILED_SLOTS_ROW_LABEL,
  FAILED_SLOTS_COUNT_NOTE,
  NO_SUCCESS_RUN_CLAUSE,
  reportStatesAgreement,
  shownRunIndependence,
  storedSynthesisRunIndependence,
  sharePanelPhrase,
  uniformityBadge,
  qualifiedPanelVerdict,
  independenceQualification,
  presentIndependenceQualifiedReport,
} from "@/lib/adaptiveSchema/verdictIndependence";
import { presentPositionSafeReport, rowView } from "@/lib/adaptiveSchema/positionPresentation";
import { runModelProvenanceFromResultRow, type RunModelProvenanceFacts } from "@/lib/panel/runModelIdentity";

const records: Record<string, any> = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "records.json"), "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];
const PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };
const ok = (m: string) => ({ modelId: m, status: "ok", provider: PROVIDER[m] });
const failed = (m: string, status = "timeout") => ({ modelId: m, status });
const facts = (rows: Array<Record<string, unknown>>): RunModelProvenanceFacts[] => rows.map((r) => runModelProvenanceFromResultRow(r as never));
const CLAIMS = /all \d+ dispatched models support it|consensus of \d+|\d+ independent model|agreed by \d+|Top consensus(?! \()/;

describe("Order 30 A2: a stored claim naming failed slots among its supporters", () => {
  it("supporters all failed → unverified, basis no_responses; some failed → basis failed_supporters; never a count", () => {
    const p = facts([ok("chatgpt"), failed("claude"), failed("grok", "error"), failed("perplexity", "refused"), failed("gemini", "rate_limited")]);
    expect(adaptiveTopIndependence(["claude", "grok"], p)).toEqual({ kind: "unverified", scope: "supporters", basis: "no_responses" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], p)).toEqual({ kind: "unverified", scope: "supporters", basis: "failed_supporters" });
    expect(adaptiveTopIndependence(FIVE, p)).toEqual({ kind: "unverified", scope: "supporters", basis: "failed_supporters" });
    // control: the one answered slot alone is an independent supporter
    expect(adaptiveTopIndependence(["chatgpt"], p)).toEqual({ kind: "independent" });
    // run scope is unchanged (option (b)): failed slots are no voices, the answered slot is verified
    expect(adaptiveTopIndependence(null, p)).toEqual({ kind: "independent" });
    expect(runIndependence(facts(FIVE.map((m) => failed(m))))).toBeNull();
  });
  it("a stored placeholder beside failed supporters is no response either: basis no_responses", () => {
    const p = [{ modelId: "chatgpt", status: "ok", provider: "openai", invalidProviderOutput: true as const }, { modelId: "claude", status: "timeout" }, { modelId: "grok", status: "ok", provider: "xai" }];
    expect(adaptiveTopIndependence(["chatgpt", "claude"], p)).toEqual({ kind: "unverified", scope: "supporters", basis: "no_responses" });
    expect(adaptiveTopIndependence(["chatgpt", "claude", "grok"], p)).toEqual({ kind: "unverified", scope: "supporters", basis: "failed_supporters" });
  });
  it("the shared wording is pinned literally", () => {
    expect(NO_SUCCESSFUL_MODEL_RESPONSES).toBe("No successful model responses. Consensus unavailable. Model independence unverified.");
  });
  it("a supporter slot that does not exist, or whose status is unknown, is unverified without a failure basis", () => {
    const p = facts(FIVE.map(ok));
    expect(adaptiveTopIndependence(["chatgpt", "ghost"], p)).toEqual({ kind: "unverified", scope: "supporters" });
    const crafted = facts([ok("chatgpt"), { modelId: "claude", status: "OK ", provider: "anthropic" }]);
    expect(adaptiveTopIndependence(["chatgpt", "claude"], crafted)).toEqual({ kind: "unverified", scope: "supporters" });
    expect(adaptiveTopIndependence(["chatgpt", "claude"], facts([ok("chatgpt"), { modelId: "claude", status: "toString", provider: "anthropic" }]))).toEqual({ kind: "unverified", scope: "supporters" });
  });
  it("wording: no count, the shared constant when nothing answered", () => {
    const row = { claimText: "c", status: "consensus", cells: FIVE.map((m) => ({ modelId: m, stance: "agrees" })) };
    expect(qualifiedRowResult(row, { kind: "unverified", scope: "supporters", basis: "no_responses" })).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    const fs = qualifiedRowResult(row, { kind: "unverified", scope: "supporters", basis: "failed_supporters" });
    expect(fs).toBe(`recorded as consensus; model independence unverified — ${FAILED_SUPPORTERS_CLAUSE}`);
    expect(CLAIMS.test(fs) || /\d/.test(fs)).toBe(false);
    // control: the unverified wording without a basis keeps its recorded slot count
    expect(qualifiedRowResult(row, { kind: "unverified", scope: "supporters" })).toContain("of 5 panel slots");
    expect(adaptiveTopIndependenceStatement({ kind: "unverified", scope: "supporters", basis: "no_responses" }, 5)).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(adaptiveTopIndependenceStatement({ kind: "unverified", scope: "supporters", basis: "failed_supporters" }, 5)).toBe(`Model independence unverified: ${FAILED_SUPPORTERS_CLAUSE}.`);
    expect(adaptiveTopIndependenceStatement({ kind: "unverified", scope: "supporters" }, 5)).toContain("5 panel slots");
    expect(qualifiedStatusHeading("consensus", { kind: "unverified", scope: "supporters", basis: "no_responses" })).toBe(NO_RESPONSES_STATUS_HEADING);
    expect(qualifiedStatusHeading("consensus", { kind: "unverified", scope: "supporters", basis: "failed_supporters" })).toBe("Consensus (model independence unverified)");
    expect(raisedByText(["chatgpt", "claude"], facts([ok("chatgpt"), failed("claude")]))).toBe("(raised by panel slots that include slots with no successful model response; model independence unverified)");
    expect(raisedByText(["chatgpt", "claude"], facts([ok("chatgpt"), { modelId: "claude" }]))).toBe("(raised by 2 panel slots; model independence unverified)");
    for (const f of [runScopeQualifier, legacyRunScopeQualifier, runIndependenceNote, answerIndependenceNote]) expect(f(NO_RESPONSES_RUN)).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    for (const f of [runScopeQualifier, legacyRunScopeQualifier, runIndependenceNote, answerIndependenceNote]) expect(f({ kind: "unverified", scope: "run" })).not.toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
  });
  it("a split row's sides: a failed side names no count", () => {
    const cell = (modelId: string, stance: string) => ({ modelId, stance, rawStance: stance === "agrees" ? "asserts" : "disputes", confidence: "majority_view", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" }, excerpt: "x", evidenceType: "empirical" });
    const row = { id: "s", claimText: "s", status: "split", cells: [cell("chatgpt", "agrees"), cell("claude", "disputes"), cell("grok", "disputes")] };
    const p = facts([ok("chatgpt"), failed("claude"), failed("grok")]);
    const ri = rowIndependence(row, p)!;
    expect(ri.t).toEqual({ kind: "unverified", scope: "supporters", basis: "failed_supporters" });
    expect(ri.dispute).toEqual({ kind: "unverified", scope: "supporters", basis: "no_responses" });
    expect(qualifiedRowText(row, ri)).toBe("recorded as split: 1 panel slot supports it (ChatGPT); no successful model response disputes it");
    // Order 30 round 2 (review m-A / A2): such a row states no count at all (was "1 of 3 panel slots agree · 2 dispute · …").
    expect(slotAgreementLabel(1, 2, 0, 3, ri)).toBe(FAILED_SLOTS_ROW_LABEL);
    expect(slotAgreementLabel(0, 2, 0, 2, rowIndependence({ ...row, cells: [row.cells[1], row.cells[2]] }, p)!)).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    // control: a row whose positioned slots all answered keeps its counts
    expect(slotAgreementLabel(1, 0, 0, 3, null)).toBe("1 of 3 panel slots agree");
    const view = rowView(row, ["chatgpt", "claude", "grok"], p);
    expect(view.disputers).toEqual([]);
    expect(view.text).toContain("Model independence unverified: panel slots that returned no successful model response are recorded as taking a position here.");
  });
});

describe("Order 30 A2 on the UI presentation (presentPositionSafeReport over result-row provenance)", () => {
  const CONS = () => clone(records["generic-consensus"]);
  const ui = (rec: any, rows: Array<Record<string, unknown>>) => presentPositionSafeReport(rec.synthesisReport, { rows: rec.alignedClaims, roster: FIVE, provenance: facts(rows) });
  it("one genuine answer + 4 failed slots named as supporters: no unqualified support count anywhere", () => {
    const out = JSON.stringify(ui(CONS(), [ok("chatgpt"), ...["claude", "grok", "perplexity", "gemini"].map((m) => failed(m))]));
    expect(out).not.toMatch(CLAIMS);
    // Order 31 R-1: one answering model — the too-few statement replaces the failed-supporters clause on every row.
    expect(out).toContain(TOO_FEW_ANSWERS_STATEMENT);
    expect(out).not.toContain(FAILED_SUPPORTERS_CLAUSE);
  });
  it("every slot failed with a stored consensus joined: every joined statement states the shared constant; supporters named as none", () => {
    const out = ui(CONS(), FIVE.map((m) => failed(m))) as any;
    const s = JSON.stringify(out);
    expect(s).not.toMatch(CLAIMS);
    expect(out.presentation.answer.claims.map((c: any) => c.result)).toEqual(out.presentation.answer.claims.map(() => NO_SUCCESSFUL_MODEL_RESPONSES));
    expect(out.presentation.answer.claims.map((c: any) => c.supporters)).toEqual(out.presentation.answer.claims.map(() => NO_RESPONSES_NAMES));
    expect(out.verdictCard.topConsensusAgreement).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
  });
  it("a marked report: the same inputs name no supporter and state the constant", () => {
    const rec = CONS();
    rec.synthesisReport.presentation.disagreementPositionVersion = 1;
    const out = ui(rec, FIVE.map((m) => failed(m))) as any;
    expect(out.presentation.answer.claims.every((c: any) => c.result === NO_SUCCESSFUL_MODEL_RESPONSES && c.supporters === undefined)).toBe(true);
  });
  it("controls: 5 verified independent answers render the stored claims unchanged (the same object)", () => {
    const rec = CONS();
    expect(ui(rec, FIVE.map(ok))).toBe(rec.synthesisReport);
  });
  // Order 30 round 2 (review m-A; coordinator ruling: UI BEHAVIOUR on a stored synthesis follows the standing default —
  // supersedes the Order 29 option (b) acceptance for the stored-synthesis case only). Was: the same object, unqualified.
  it("a stored synthesis over an all-failed run with no stored claim joined: every statement and count is the constant (m-A)", () => {
    const rec = { ...CONS(), alignedClaims: [] };
    const out = ui(rec, FIVE.map((m) => failed(m))) as any;
    expect(out).not.toBe(rec.synthesisReport);
    expect(independenceQualification(out)!.run).toBe(NO_RESPONSES_RUN);
    expect(JSON.stringify(out)).not.toMatch(CLAIMS);
    expect(out.presentation.panelAgreement).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(out.certaintyAssessment).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(out.panelVerdict).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(out.verdictCard.topConsensusAgreement).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(out.presentation.answer.claims.map((c: any) => [c.result, c.supporters])).toEqual(out.presentation.answer.claims.map(() => [NO_SUCCESSFUL_MODEL_RESPONSES, NO_RESPONSES_NAMES]));
  });
  it("controls: the run rule without a stored synthesis is unchanged (the real all-failed record has none — Order 29 option (b))", () => {
    const p = facts(FIVE.map((m) => failed(m)));
    expect(runIndependence(p)).toBeNull();
    expect(shownRunIndependence(undefined, p)).toBeNull();
    expect(shownRunIndependence(null, p)).toBeNull();
    expect(shownRunIndependence({}, p)).toBe(NO_RESPONSES_RUN);
    expect(storedSynthesisRunIndependence(p)).toBe(NO_RESPONSES_RUN);
    expect(storedSynthesisRunIndependence([])).toBeNull();
    expect(storedSynthesisRunIndependence(null)).toBeNull();
  });
  it("m-B: one genuine answer + 4 failed slots, a stored consensus with NO joined rows → no 'all 5 … support it', no supporters list as models", () => {
    const rec = { ...CONS(), alignedClaims: [] };
    const out = ui(rec, [ok("chatgpt"), ...["claude", "grok", "perplexity", "gemini"].map((m) => failed(m))]) as any;
    expect(independenceQualification(out)!.run).toBe(TOO_FEW_ANSWERS_RUN);
    expect(JSON.stringify(out)).not.toMatch(CLAIMS);
    expect(out.presentation.answer.claims.map((c: any) => c.result)).toEqual(out.presentation.answer.claims.map(() => TOO_FEW_ANSWERS_STATEMENT));
    expect(out.presentation.answer.claims.every((c: any) => c.supporters.endsWith(TOO_FEW_ANSWERS_NAMES_SUFFIX))).toBe(true);
    expect(out.presentation.panelAgreement).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(out.panelVerdict).toBe(TOO_FEW_ANSWERS_STATEMENT);
  });
  it("m-B rule boundaries: two answering models, no failures, or no stated agreement → not TOO_FEW_ANSWERS_RUN", () => {
    const one = facts([ok("chatgpt"), ...["claude", "grok"].map((m) => failed(m))]);
    expect(storedSynthesisRunIndependence(one, true)).toBe(TOO_FEW_ANSWERS_RUN);
    expect(storedSynthesisRunIndependence(one, false)).toBeNull();
    expect(storedSynthesisRunIndependence(facts([ok("chatgpt"), ok("claude"), failed("grok")]), true)).toBeNull();
    expect(storedSynthesisRunIndependence(facts([ok("chatgpt")]), true)).toBeNull();
    // Order 31 R-1: one responding model once the stored placeholder is set aside, beside a recorded failure → too few
    // answers (judged before the run's own kind); without a stated agreement the run's own kind (placeholder) stands.
    expect(storedSynthesisRunIndependence([...facts([ok("chatgpt")]), { modelId: "claude", status: "ok", provider: "anthropic", invalidProviderOutput: true }, ...facts([failed("grok")])], true)).toBe(TOO_FEW_ANSWERS_RUN);
    expect(storedSynthesisRunIndependence([...facts([ok("chatgpt")]), { modelId: "claude", status: "ok", provider: "anthropic", invalidProviderOutput: true }, ...facts([failed("grok")])], false)).toMatchObject({ kind: "placeholder" });
  });
  it("reportStatesAgreement reads only stored agreement statements", () => {
    expect(reportStatesAgreement(CONS().synthesisReport)).toBe(true);
    expect(reportStatesAgreement(records["factual-single"].synthesisReport)).toBe(false);
    expect(reportStatesAgreement({ verdictCard: { topConsensus: "No consensus identified." } })).toBe(false);
    expect(reportStatesAgreement({ verdictCard: { topConsensus: "x" } })).toBe(true);
    expect(reportStatesAgreement({ presentation: { agree: [{ claim: "a" }] } })).toBe(true);
    expect(reportStatesAgreement({ presentation: { answer: { claims: [{ claim: "a" }] } } })).toBe(true);
    expect(reportStatesAgreement({ gate: "fail", presentation: { answer: { claims: [{ claim: "a" }] } } })).toBe(false);
    expect(reportStatesAgreement({ whereModelsAgree: ["a"] })).toBe(true);
    expect(reportStatesAgreement({ whereModelsAgree: [] })).toBe(false);
    expect(reportStatesAgreement(null)).toBe(false);
  });
});

describe("Order 30 A1: the export-only no-successful-responses override of the qualified view", () => {
  it("a legacy report (no presentation): every joined 'Where models agree' line and the stored answer state the constant, even when the rows name slots the run does not hold", () => {
    const rows = clone(records["generic-consensus"].alignedClaims);
    const line = `“${rows[0].claimText}”`;
    const report = { whereModelsAgree: [line], unifiedAnswer: "All five models agree.", verdictCard: { topConsensus: rows[0].claimText, topConsensusAgreement: "consensus: all 5 dispatched models support it" } };
    const out = presentIndependenceQualifiedReport(report, { rows, provenance: [], noSuccessfulResponses: true }) as any;
    const q = independenceQualification(out)!;
    expect(q.run).toBe(NO_RESPONSES_RUN);
    expect(q.legacyAgree.get(line)).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(out.unifiedAnswer).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(out.verdictCard.topConsensusAgreement).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    // control: without the override the same inputs are the ordinary unverified family, never the constant
    const plain = presentIndependenceQualifiedReport(report, { rows, provenance: [] }) as any;
    expect(independenceQualification(plain)?.legacyAgree.get(line)).not.toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(plain.verdictCard.topConsensusAgreement).not.toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
  });
});

describe("Order 30 round 2 (review m-D): the three reviewer survivors V17, V19, V21 are pinned", () => {
  const cell = (modelId: string, stance: string) => ({ modelId, stance, rawStance: stance === "agrees" ? "asserts" : "disputes", confidence: "majority_view", origin: { kind: "claim", field: "keyClaims", fieldClass: "unclassified" }, excerpt: "x", evidenceType: "empirical" });
  it("V17: a split row whose DISPUTING side includes one failed slot states no dispute count", () => {
    const row = { id: "s", claimText: "s", status: "split", cells: [cell("chatgpt", "agrees"), cell("claude", "disputes"), cell("grok", "disputes")] };
    const p = facts([ok("chatgpt"), ok("claude"), failed("grok")]);
    const ri = rowIndependence(row, p)!;
    expect(ri.dispute).toEqual({ kind: "unverified", scope: "supporters", basis: "failed_supporters" });
    const text = qualifiedRowText(row, ri);
    // C-b (C-a review note): the disputing side mixes an answering slot (Claude) with a failed one (Grok), so the clause
    // never reads as if every disputing slot returned no successful response.
    expect(text).toBe("recorded as split: 1 panel slot supports it (ChatGPT); panel slots are recorded as disputing it, some of which returned no successful model response (model independence unverified; no count stated)");
    expect(/\d+ panel slots? disputes? it/.test(text)).toBe(false);
  });
  it("C-b (C-a review note): a split row in a ONE-answer run whose disputing side holds the single answering slot and failed slots — the clause never says every disputer returned no response", () => {
    const row = { id: "s1", claimText: "s1", status: "split", cells: [cell("claude", "agrees"), cell("chatgpt", "disputes"), cell("grok", "disputes"), cell("gemini", "disputes")] };
    // chatgpt is the only answering slot; claude, grok and gemini recorded failed calls (stored count 4 positioned slots).
    const p = facts([ok("chatgpt"), failed("claude"), failed("grok"), failed("gemini", "error"), failed("perplexity")]);
    const ri = rowIndependence(row, p)!;
    expect(ri.support).toEqual({ kind: "unverified", scope: "supporters", basis: "no_responses" });
    expect(ri.dispute).toEqual({ kind: "unverified", scope: "supporters", basis: "failed_supporters" });
    const text = qualifiedRowText(row, ri);
    expect(text).toBe(
      "recorded as split: no successful model response supports it; panel slots are recorded as disputing it, some of which returned no successful model response (model independence unverified; no count stated)"
    );
    expect(text).not.toContain("panel slots that returned no successful model response are recorded as disputing it");
    expect(/\d+ panel slots? disputes? it/.test(text)).toBe(false);
    // The supporting-side analogue (FAILED_SUPPORTERS_CLAUSE) also says "some": a mixed side is never described as all-failed.
    expect(FAILED_SUPPORTERS_CLAUSE.startsWith("some panel slots recorded as supporting it returned no successful model response")).toBe(true);
    const mixedSupport = { id: "s2", claimText: "s2", status: "split", cells: [cell("chatgpt", "agrees"), cell("claude", "agrees"), cell("grok", "disputes")] };
    const p2 = facts([ok("chatgpt"), failed("claude"), ok("grok"), ok("gemini"), ok("perplexity")]);
    expect(qualifiedRowText(mixedSupport, rowIndependence(mixedSupport, p2)!)).toBe(
      "recorded as split: panel slots are recorded as supporting it, some of which returned no successful model response (model independence unverified; no count stated); 1 panel slot disputes it (Grok)"
    );
  });
  it("V19: the stored panel verdict is replaced by the constant / the too-few statement, never prefixed with the claim", () => {
    const stored = "5/5 models converge on “X”; certainty 100%; gate: pass.";
    expect(qualifiedPanelVerdict(stored, NO_SUCCESSFUL_MODEL_RESPONSES, true, NO_RESPONSES_RUN)).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(qualifiedPanelVerdict(stored, NO_SUCCESSFUL_MODEL_RESPONSES, false, NO_RESPONSES_RUN)).toBe(NO_SUCCESSFUL_MODEL_RESPONSES);
    expect(qualifiedPanelVerdict(stored, TOO_FEW_ANSWERS_STATEMENT, false, TOO_FEW_ANSWERS_RUN)).toBe(TOO_FEW_ANSWERS_STATEMENT);
    // control: any other result keeps the stored certainty
    expect(qualifiedPanelVerdict(stored, "r", true, null)).toBe("Top finding “X” — r; certainty 100%; gate: pass.");
  });
  it("V21: a joined claim whose supporters include failed slots names them as panel slots including non-responses (UI presentation)", () => {
    const rec = clone(records["generic-consensus"]);
    const out = presentPositionSafeReport(rec.synthesisReport, { rows: rec.alignedClaims, roster: FIVE, provenance: facts([ok("chatgpt"), ok("claude"), ok("grok"), ok("perplexity"), failed("gemini")]) }) as any;
    for (const c of out.presentation.answer.claims) {
      expect(c.supporters).toBe("ChatGPT, Claude, Grok, Perplexity, Gemini (panel slots; includes slots with no successful model response)");
      expect(c.result).toContain(FAILED_SUPPORTERS_CLAUSE);
    }
    // A2 on the UI run level: the summary bar / banner are gated by the qualification's run (as the exports are)
    expect(independenceQualification(out)!.run).toEqual({ kind: "unverified", scope: "run", basis: "failed_supporters" });
    expect(out.presentation.panelAgreement).toBe(`Of 2 scored claims across 5 dispatched models: consensus on 2. ${FAILED_SLOTS_COUNT_NOTE}`);
  });
  it("run-level wording for a failed-call basis (summary badge, share phrase)", () => {
    expect(uniformityBadge(NO_RESPONSES_RUN)).toEqual({ label: "Unusually uniform responses (model independence unverified)", title: NO_SUCCESS_RUN_CLAUSE });
    expect(uniformityBadge({ kind: "unverified", scope: "run" }).title).not.toBe(NO_SUCCESS_RUN_CLAUSE);
    expect(sharePanelPhrase(TOO_FEW_ANSWERS_RUN)).toBe("an AI panel (model independence unverified: panel slots of this run returned no successful model response)");
    expect(sharePanelPhrase({ kind: "unverified", scope: "run" })).toBe("an AI panel (model independence unverified: which models answered is not recorded)");
    for (const f of [runScopeQualifier, legacyRunScopeQualifier, runIndependenceNote, answerIndependenceNote]) expect(f(TOO_FEW_ANSWERS_RUN)).toBe(TOO_FEW_ANSWERS_STATEMENT);
    expect(runIndependenceNote({ kind: "unverified", scope: "run", basis: "failed_supporters" })).toBe(FAILED_SLOTS_COUNT_NOTE);
    expect(answerIndependenceNote({ kind: "unverified", scope: "run", basis: "failed_supporters" })).toBe(FAILED_SLOTS_COUNT_NOTE);
    expect(TOO_FEW_ANSWERS_STATEMENT).toBe("Not an agreement between models: fewer than two independent models returned a successful response in this run. Model independence unverified.");
  });
});
