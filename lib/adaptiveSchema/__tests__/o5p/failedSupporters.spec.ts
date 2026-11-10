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
  NO_RESPONSES_NAMES,
  NO_RESPONSES_STATUS_HEADING,
  NO_SUCCESSFUL_MODEL_RESPONSES,
  adaptiveTopIndependence,
  adaptiveTopIndependenceStatement,
  qualifiedRowResult,
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
    expect(slotAgreementLabel(1, 2, 0, 3, ri)).toBe("1 of 3 panel slots agree · 2 dispute · model independence unverified; includes panel slots with no successful model response");
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
    expect(out).toContain(FAILED_SUPPORTERS_CLAUSE);
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
  it("the UI run scope of an all-failed run with no stored claim joined is unchanged (option (b)): no qualification", () => {
    const rec = { ...CONS(), alignedClaims: [] };
    expect(ui(rec, FIVE.map((m) => failed(m)))).toBe(rec.synthesisReport);
  });
});
