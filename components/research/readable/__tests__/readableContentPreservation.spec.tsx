/**
 * #290 Increment 1 — review R2 MINOR M-1 and M-2: the readable layout must not silently drop stored content, and must
 * never read stronger than the stored data.
 *
 *   M1. Content preservation, asserted on the distinctive stored text (never just a container):
 *       a. the top point's contested note (verdictCard.topConsensusContested) — ExecutiveAnswer
 *       b. the key disagreement's detail line (verdictCard.disagreementDetail) — ExecutiveAnswer
 *       c. the schema key-facts block (SchemaKeyFactsStrip: legal jurisdiction, medical red flags) — readable details tier
 *       d. the stored caveat (presentVerdictCaveat) and the per-model uncertainties — answer tier / details tier
 *       plus "never stronger": a contested / split result is not presented as plain agreement.
 *   M2. Sources requested but every model failed (trustSignals.sourcesSignal, total === 0 && schemaRequestsSources):
 *       pure and rendered — no percentage for sources, never "N/A (not requested)", nothing reads as passed / verified.
 *
 * Fixtures are the o5p historical records (read only, deep-copied), with single fields edited per test.
 */
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u-290" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: () => new Promise(() => {}) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SchemaKeyFactsStrip from "@/components/adaptive/SchemaKeyFactsStrip";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { READABLE_ANSWER_COPY, READABLE_TRUST_COPY } from "@/lib/research/readableReport/copy";
import { buildTrustSignals, sourcesSignal } from "@/lib/research/readableReport/trustSignals";
import { PILOT_SCENARIOS, htmlText, record, renderPanel, slotRows, tierHtml } from "./readableFixtures";

const READABLE = { reportLayout: "readable" };

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** The rendered trust signal group (outer HTML) for one signal id. */
function signalGroup(trust: string, id: string): string {
  const at = trust.indexOf(`data-trust-signal="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const open = trust.lastIndexOf("<div", at);
  const re = /<div\b|<\/div>/g;
  re.lastIndex = open;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trust))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return trust.slice(open, m.index + m[0].length);
  }
  throw new Error(`unbalanced signal ${id}`);
}
function signalValue(trust: string, id: string): string {
  const m = /data-trust-signal-value=""[^>]*>([^<]*)</.exec(signalGroup(trust, id));
  return m![1];
}
function signalState(trust: string, id: string): string {
  return /data-state="([^"]*)"/.exec(signalGroup(trust, id))![1];
}

// ── M1. content preservation ────────────────────────────────────────────────

/** The answer tier's top-point block: from its "Models agree" heading to the "Models disagree" heading. */
function topBlock(answer: string): string {
  const start = answer.indexOf(READABLE_ANSWER_COPY.topPointLabel);
  const end = answer.indexOf(READABLE_ANSWER_COPY.keyPointLabel, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return answer.slice(start, end);
}
/** The answer tier's key-point block: from its "Models disagree" heading to the end of the tier. */
function keyBlock(answer: string): string {
  const start = answer.indexOf(READABLE_ANSWER_COPY.keyPointLabel, answer.indexOf(READABLE_ANSWER_COPY.topPointLabel));
  expect(start).toBeGreaterThan(-1);
  return answer.slice(start);
}
/** The frozen model-caveat label negates "verified"; it is the only "verified" the lead may carry. */
const withoutFrozenNegation = (text: string) => text.split("not a verified finding").join("");

const CONTESTED = "Grok disputes this using the 2024 Seattle panel data (sentinel-contested-7Q)";
const DETAIL = "ChatGPT and Claude read the tariff evidence in opposite directions (sentinel-detail-4K)";
const CAVEAT = "Claude's estimate rests on a single 2019 survey (sentinel-caveat-9P)";
const UNCERTAINTY = "Long-run effects beyond five years are not measured (sentinel-uncertainty-2M)";

describe("M1a. the contested note on the top point", () => {
  function contestedHtml() {
    const rec = record("generic-mixed");
    rec.synthesisReport.verdictCard.topConsensusContested = CONTESTED;
    return { rec, html: renderPanel(rec, slotRows("generic-mixed"), READABLE) };
  }

  it("is shown in the readable answer, labelled Contested, with the stored text", () => {
    const answer = htmlText(tierHtml(contestedHtml().html, "answer")!);
    expect(answer).toContain(`Contested: ${CONTESTED}`);
  });

  it("sits inside the top-point block, after the claim and its stored consensus result — never shown uncontested", () => {
    const { rec, html } = contestedHtml();
    const answer = htmlText(tierHtml(html, "answer")!);
    const vc = rec.synthesisReport.verdictCard;
    const top = topBlock(answer);
    const claimAt = top.indexOf(vc.topConsensus);
    const resultAt = top.indexOf("consensus: all 5 dispatched models support it");
    const contestedAt = top.indexOf(`Contested: ${CONTESTED}`);
    expect(claimAt).toBeGreaterThan(-1);
    expect(resultAt).toBeGreaterThan(claimAt);
    expect(contestedAt).toBeGreaterThan(resultAt);
    // Not upgraded to a stronger word than the stored result.
    expect(withoutFrozenNegation(answer)).not.toMatch(/\b(uncontested|unanimous|verified|all models agree)\b/i);
  });

  it("control: without a stored contested value no Contested note appears", () => {
    const answer = htmlText(tierHtml(renderPanel(record("generic-mixed"), slotRows("generic-mixed"), READABLE), "answer")!);
    expect(answer).not.toContain("Contested:");
  });
});

describe("M1b. the key disagreement's detail line", () => {
  it("is shown in the readable answer with the stored text, next to the split claim and its stored split result", () => {
    const rec = record("generic-mixed");
    rec.synthesisReport.verdictCard.disagreementDetail = DETAIL;
    const answer = htmlText(tierHtml(renderPanel(rec, slotRows("generic-mixed"), READABLE), "answer")!);
    const vc = rec.synthesisReport.verdictCard;
    const key = keyBlock(answer);
    const claimAt = key.indexOf(vc.keyDisagreement);
    const splitAt = key.indexOf("split: 1 of 5 dispatched models support it and 1 disputes it");
    const detailAt = key.indexOf(DETAIL);
    expect(claimAt).toBeGreaterThan(-1);
    expect(splitAt).toBeGreaterThan(claimAt);
    expect(detailAt).toBeGreaterThan(splitAt);
    // A split is never presented as "no disagreement" or as agreement.
    expect(key).not.toContain(READABLE_ANSWER_COPY.noKeyPoint);
    expect(key).not.toMatch(/consensus:/);
    expect(withoutFrozenNegation(answer)).not.toMatch(/\b(unanimous|verified|all models agree)\b/i);
  });

  it.each(PILOT_SCENARIOS.filter((n) => record(n).synthesisReport?.verdictCard?.disagreementDetail))(
    "%s: the stored disagreementDetail and key disagreement appear in the readable answer",
    (name) => {
      const rec = record(name);
      const vc = rec.synthesisReport.verdictCard;
      const answer = htmlText(tierHtml(renderPanel(rec, slotRows(name), READABLE), "answer")!);
      const key = keyBlock(answer);
      expect(key).toContain(vc.keyDisagreement);
      expect(key).toContain(vc.disagreementDetail);
      expect(key).not.toContain(READABLE_ANSWER_COPY.noKeyPoint);
    }
  );
});

describe("M1c. the schema key-facts block", () => {
  it.each([
    ["legal-regulatory", "Jurisdiction", "Ninth Circuit, California (sentinel-jurisdiction-3R)"],
    ["medical-health", "Red flags", "Fainting after the first dose (sentinel-redflag-8T)"],
  ])("%s: the readable details tier carries the key-facts markup and its distinctive value", (name, label, sentinel) => {
    const rec = record(name);
    if (name === "legal-regulatory") rec.alignedClaims.find((c: any) => c.id === "jurisdiction").claimText = sentinel;
    else for (const r of rec.results) if (r.ok) r.data.redFlags = [...r.data.redFlags, sentinel];
    const strip = renderToStaticMarkup(createElement(SchemaKeyFactsStrip as any, { schemaId: rec.schemaId, results: rec.results, alignedClaims: rec.alignedClaims }));
    expect(htmlText(strip)).toContain(label);
    expect(htmlText(strip)).toContain(sentinel);

    const rows = slotRows(name);
    const classic = renderPanel(rec, rows);
    const details = tierHtml(renderPanel(rec, rows, READABLE), "details")!;
    // Byte-for-byte the classic strip, exactly once — present, not duplicated, not reworded.
    expect(classic.split(strip).length - 1).toBe(1);
    expect(details.split(strip).length - 1).toBe(1);
    // And it leads the details tier (before the dedicated view), as in classic.
    expect(details.indexOf(strip)).toBeLessThan(details.indexOf('id="readable-model-responses"'));
  });
});

describe("M1d. caveats and uncertainty", () => {
  it("a model-bias caveat is shown in the readable answer, labelled and attributed to the model, with the stored text", () => {
    const rec = record("generic-mixed");
    rec.synthesisReport.verdictCard.caveat = CAVEAT;
    rec.synthesisReport.verdictCard.caveatSource = "model_bias_check";
    const answerHtml = tierHtml(renderPanel(rec, slotRows("generic-mixed"), READABLE), "answer")!;
    expect(htmlText(answerHtml)).toContain(CAVEAT);
    const at = answerHtml.indexOf(CAVEAT.replace("'", "&#x27;"));
    expect(at).toBeGreaterThan(-1);
    const openTag = answerHtml.slice(answerHtml.lastIndexOf("<p", at), at);
    expect(openTag).toContain('data-source="model_bias"');
  });

  it("a legacy caveat (no caveatSource) is still shown with its stored text", () => {
    const rec = record("generic-mixed");
    rec.synthesisReport.verdictCard.caveat = CAVEAT;
    delete rec.synthesisReport.verdictCard.caveatSource;
    const answer = htmlText(tierHtml(renderPanel(rec, slotRows("generic-mixed"), READABLE), "answer")!);
    expect(answer).toContain(CAVEAT);
  });

  it.each(PILOT_SCENARIOS.filter((n) => record(n).synthesisReport?.verdictCard?.caveat))("%s: the stored caveat text appears in the readable answer", (name) => {
    const rec = record(name);
    const answer = htmlText(tierHtml(renderPanel(rec, slotRows(name), READABLE), "answer")!);
    expect(answer).toContain(rec.synthesisReport.verdictCard.caveat);
  });

  it("per-model uncertainties stay visible in the readable details tier with their stored text and model count", () => {
    const rec = record("generic-mixed");
    for (const r of rec.results) if (r.ok) r.data.uncertainties = [UNCERTAINTY];
    const rows = slotRows("generic-mixed");
    const n = rec.results.filter((r: any) => r.ok).length;
    const expected = `${UNCERTAINTY} (raised by ${n} models)`;
    expect(htmlText(renderPanel(rec, rows))).toContain(expected);
    const details = htmlText(tierHtml(renderPanel(rec, rows, READABLE), "details")!);
    expect(details).toContain("Uncertainties");
    expect(details).toContain(expected);
  });
});

// ── M2. sources requested, every model failed ───────────────────────────────

/** financial_valuation (asks for metric sources) where every dispatched model failed. */
function allFailedSourcedRecord(withGate: boolean) {
  const rec = record("generic-all-failed");
  rec.schemaId = "financial_valuation";
  rec.classification = { ...rec.classification, queryType: "financial_valuation" };
  for (const r of rec.results) r.schemaId = "financial_valuation";
  if (withGate) rec.gate = { status: "fail", runCertainty: 0, loadBearingSplitCount: 0, loadBearingClaims: [] };
  return rec;
}

describe("M2. sources requested but every model failed", () => {
  const schema = getResultSchema("financial_valuation");

  it("precondition: the schema requests sources and the fixture has no parsed response", () => {
    expect(schema.fields.some((f) => f.type === "metric[]")).toBe(true);
    const rec = allFailedSourcedRecord(false);
    expect(rec.results.length).toBeGreaterThan(0);
    expect(rec.results.every((r: any) => !r.ok && r.data == null)).toBe(true);
  });

  it("pure: sourcesSignal reports none recorded (0 of 0), never a percentage, never not-requested", () => {
    const s = sourcesSignal({ schema, results: allFailedSourcedRecord(false).results });
    expect(s.value).toBe(READABLE_TRUST_COPY.sourcesNone(0));
    expect(s.value).toBe("None recorded (0 of 0 values)");
    expect(s.state).toBe("none_recorded");
    expect(s.details).toEqual([READABLE_TRUST_COPY.sourcesNoneDetail]);
    for (const text of [s.value, ...s.details]) {
      expect(text).not.toMatch(/%/);
      expect(text).not.toMatch(/verified|checked and|100/i);
    }
    expect(s.value).not.toBe(READABLE_TRUST_COPY.sourcesNotRequested);
  });

  it.each([[false], [true]])("pure: buildTrustSignals (stored fail gate: %p) — no signal reads passed / verified, no source % anywhere", (withGate) => {
    const rec = allFailedSourcedRecord(withGate);
    const signals = buildTrustSignals({ schema, results: rec.results, alignedClaims: rec.alignedClaims, gate: rec.gate, synthesisReport: rec.synthesisReport, trustSummary: rec.trustSummary, slotStatuses: new Map(slotRows("generic-all-failed").map((r) => [r.modelId, String(r.status ?? "")])) });
    const byId = Object.fromEntries(signals.map((s) => [s.id, s]));
    expect(byId.sources.state).toBe("none_recorded");
    expect(byId.gate.state).not.toBe("pass");
    expect(byId.gate.value).not.toMatch(/pass|verified/i);
    expect(byId.coverage.value).toBe("Responded: 0 of 5 dispatched");
    const all = signals.flatMap((s) => [s.value, ...s.details]).join(" \n ");
    expect(all).not.toMatch(/\bPass\b|verified|Citations[^\n]*%|100%/i);
  });

  it.each([[false], [true]])("rendered (stored fail gate: %p): the Sources signal shows no %, the page shows no citations %, nothing reads verified", (withGate) => {
    const rec = allFailedSourcedRecord(withGate);
    const html = renderPanel(rec, slotRows("generic-all-failed"), READABLE);
    const trust = tierHtml(html, "trust")!;
    const sources = htmlText(signalGroup(trust, "sources"));
    expect(signalValue(trust, "sources")).toBe("None recorded (0 of 0 values)");
    expect(signalState(trust, "sources")).toBe("none_recorded");
    expect(sources).not.toMatch(/%/);
    expect(sources).not.toContain(READABLE_TRUST_COPY.sourcesNotRequested);
    // The gate signal: the stored word (or Not recorded), never Pass.
    expect(signalValue(trust, "gate")).toBe(withGate ? "Fail" : READABLE_TRUST_COPY.gateNotRecorded);
    expect(signalState(trust, "gate")).not.toBe("pass");
    const lead = htmlText(tierHtml(html, "answer")! + trust);
    expect(lead).not.toMatch(/\bPass\b|verified/i);
    expect(lead).not.toMatch(/Citations[^.]*\d+%|100%/i);
    expect(htmlText(html)).not.toMatch(/Citations\s*100%/i);
  });
});
