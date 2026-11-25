/**
 * R6 owner decisions B2 + B3 (PR #330) — the shared claim score renderer's two non-withholding modes.
 *
 * B2: the governance Audit Log and the admin runs tab RETAIN a valid stored number for a claim whose score is not a
 * multi-model consensus, with a qualifier that says why it is not independent model corroboration:
 *   fewer than two independent executing models → "N (fewer than two independent models, not independent corroboration)"
 *   provenance not established                  → "N (unverified: model independence not recorded)"
 *   slot responses (R4)                          → "N (computed over panel slot responses, not independent corroboration)"
 * Every other surface keeps the default (withholding) mode byte-identical.
 *
 * B3: the Personal history cache. A server-mapped history item written by the R6 server always carries `consensusBasis`
 * (the per-item marker); an item cached before it does not. Such an item's score is shown as a historical, unverified
 * figure — never as agreement between independent models, and the cache is never cleared or rewritten.
 */
import { buildCase, MODES } from "./claimStatementInventory.harness";
import * as Presentation from "@/lib/verification/claimConsensusPresentation";
import * as Sources from "@/lib/verification/claimStatementBasisSources";

const P = Presentation as unknown as Record<string, any>;
const S = Sources as unknown as Record<string, any>;
const mode = (name: string) => MODES.find((m) => m.name === name)!;

const SLOT = "computed over panel slot responses, not independent corroboration";
const INSUFFICIENT = "fewer than two independent models, not independent corroboration";
const UNVERIFIED = "unverified: model independence not recorded";
const HISTORICAL = "historical score, unverified: model independence not recorded";
const WITHHELD = "Consensus score withheld (model independence not recorded)";
const NO_CONSENSUS = "No consensus score (fewer than two independent models)";
const fmt = (n: number) => `${Math.round(n)}/100`;

describe("claimScoreText — qualify mode (R6 B2: Audit Log, admin runs)", () => {
  const q = (row: Record<string, unknown>) => P.claimScoreText(row, fmt, "—", { notIndependent: "qualify" });

  it("keeps the number and states why it is not independent corroboration", () => {
    expect(q({ consensusScore: 92, consensusWithheld: "insufficient_independent_models" })).toBe(`92/100 (${INSUFFICIENT})`);
    expect(q({ consensusScore: 92, consensusWithheld: "independence_unverified" })).toBe(`92/100 (${UNVERIFIED})`);
    expect(q({ consensusScore: 92, consensusBasis: "slot_responses" })).toBe(`92/100 (${SLOT})`);
    expect(q({ consensusScore: 92 })).toBe("92/100");
  });

  it("an unknown withheld reason is unverified (fail closed), never a bare number", () => {
    expect(q({ consensusScore: 92, consensusWithheld: "something_new" })).toBe(`92/100 (${UNVERIFIED})`);
  });

  it("no valid stored number → the surface's empty text, never an invented one", () => {
    for (const consensusScore of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "92"]) {
      expect(q({ consensusScore, consensusWithheld: "insufficient_independent_models" })).toBe("—");
    }
  });

  it("the default mode is unchanged (withholding; governance queue, Team queue, Personal history)", () => {
    expect(P.claimScoreText({ consensusScore: 92, consensusWithheld: "insufficient_independent_models" }, fmt, "—")).toBe(NO_CONSENSUS);
    expect(P.claimScoreText({ consensusScore: 92, consensusWithheld: "independence_unverified" }, fmt, "—")).toBe(WITHHELD);
    expect(P.claimScoreText({ consensusScore: 92, consensusWithheld: "independence_unverified" }, fmt, "—", { notIndependent: "withhold" })).toBe(WITHHELD);
  });

  it("the exported qualifier texts are the ones rendered", () => {
    expect(P.CLAIM_SCORE_NOT_INDEPENDENT_QUALIFIER).toEqual({ insufficient_independent_models: INSUFFICIENT, independence_unverified: UNVERIFIED });
    expect(P.CLAIM_SCORE_HISTORICAL_QUALIFIER).toBe(HISTORICAL);
  });
});

describe("storedClaimScoreBasis — the one explicit basis enum (export column, history marker)", () => {
  const own = buildCase(["A", "A", "I"], mode("own"));
  const collapsed = buildCase(["A", "A", "A", "A", "I"], mode("ds:1-4"));
  const allDs = buildCase(["A", "A"], mode("all-substituted"));
  const historic = buildCase(["A", "A"], mode("historic"));

  it("maps each stored record to exactly one of the four values; missing provenance is explicit, never inferred", () => {
    expect(S.CLAIM_SCORE_BASES).toEqual(["independent_models", "slot_responses", "insufficient_independent_models", "independence_unverified"]);
    expect(S.storedClaimScoreBasis(own.doc)).toBe("independent_models");
    expect(S.storedClaimScoreBasis(collapsed.doc)).toBe("slot_responses");
    expect(S.storedClaimScoreBasis(allDs.doc)).toBe("insufficient_independent_models");
    expect(S.storedClaimScoreBasis(historic.doc)).toBe("independence_unverified");
    expect(S.storedClaimScoreBasis({ consensusScore: 92 })).toBe("independence_unverified");
    expect(S.storedClaimScoreBasis(null)).toBe("independence_unverified");
    expect(S.storedClaimScoreBasis(undefined)).toBe("independence_unverified");
  });

  it("the history row builder always carries the marker; the score fields are the established ones", () => {
    for (const c of [own, collapsed, allDs, historic]) {
      const doc = c.doc as unknown as Record<string, unknown>;
      const row = S.storedClaimHistoryRowFields(doc);
      expect(row.consensusBasis).toBe(S.storedClaimScoreBasis(doc));
      const { consensusBasis: _b, ...rest } = row;
      const { consensusBasis: _b2, ...established } = Sources.storedClaimHistoryScoreFields(doc);
      void _b;
      void _b2;
      expect(rest).toEqual(established);
    }
  });
});

describe("Personal history cache migration (R6 B3) — claimHistoryConsensusSuffix", () => {
  const suffix = (item: Record<string, unknown>) => Presentation.claimHistoryConsensusSuffix(item as never);
  const own = buildCase(["A", "A", "A", "A", "I"], mode("own"));
  const collapsed = buildCase(["A", "A", "A", "A", "I"], mode("ds:1-4"));
  const historic = buildCase(["A", "A", "A", "A", "I"], mode("historic"));

  it("a server-mapped item cached before the marker (no basis, no payload) is historical and unverified, never bare", () => {
    expect(suffix({ consensusScore: 92, modelIndependence: "independent" })).toBe(` · 92 consensus (${HISTORICAL})`);
  });

  it("items whose recorded independence already withheld the score are unchanged", () => {
    expect(suffix({ consensusScore: 92 })).toBe(` · ${WITHHELD}`);
    expect(suffix({ consensusScore: null, modelIndependence: "insufficient" })).toBe(` · ${NO_CONSENSUS}`);
    expect(suffix({ consensusScore: null, modelIndependence: "unverified" })).toBe(` · ${WITHHELD}`);
  });

  it("an R6 server item (marker present) is presented exactly as the server states it", () => {
    expect(suffix({ consensusScore: 92, modelIndependence: "independent", consensusBasis: "independent_models" })).toBe(" · 92 consensus");
    expect(suffix({ consensusScore: 92, modelIndependence: "independent", consensusBasis: "slot_responses" })).toBe(` · 92 consensus (${SLOT})`);
    expect(suffix({ consensusScore: null, modelIndependence: "insufficient", consensusWithheld: "insufficient_independent_models", consensusBasis: "insufficient_independent_models" })).toBe(` · ${NO_CONSENSUS}`);
    expect(suffix({ consensusScore: null, modelIndependence: "unverified", consensusWithheld: "independence_unverified", consensusBasis: "independence_unverified" })).toBe(` · ${WITHHELD}`);
  });

  it("a marker that contradicts the recorded independence, or an unknown marker, fails closed", () => {
    expect(suffix({ consensusScore: 92, modelIndependence: "unverified", consensusBasis: "independent_models" })).toBe(` · ${WITHHELD}`);
    expect(suffix({ consensusScore: 92, modelIndependence: "independent", consensusBasis: "insufficient_independent_models" })).toBe(` · ${NO_CONSENSUS}`);
    expect(suffix({ consensusScore: 92, modelIndependence: "independent", consensusBasis: "independence_unverified" })).toBe(` · ${WITHHELD}`);
    expect(suffix({ consensusScore: 92, modelIndependence: "independent", consensusBasis: "corroborated" })).toBe(` · ${WITHHELD}`);
    expect(suffix({ consensusScore: 92, modelIndependence: "independent", consensusBasis: 1 })).toBe(` · ${WITHHELD}`);
  });

  it("a live / cached payload whose rows prove the basis is unchanged (R5)", () => {
    expect(suffix({ consensusScore: 70, modelIndependence: "independent", payload: own.payload })).toBe(" · 70 consensus");
    expect(suffix({ consensusScore: 70, modelIndependence: "independent", payload: collapsed.payload })).toBe(` · 70 consensus (${SLOT})`);
  });

  it("a cached payload whose rows do not prove independence is historical and unverified (was a bare score)", () => {
    expect(suffix({ consensusScore: 70, modelIndependence: "independent", payload: historic.payload })).toBe(` · 70 consensus (${HISTORICAL})`);
    // The item's own recorded independence is never upgraded by its payload.
    expect(suffix({ consensusScore: 70, modelIndependence: "unverified", payload: own.payload })).toBe(` · ${WITHHELD}`);
  });

  it("over every item shape, a bare 'N consensus' appears only when an R6 marker or the payload rows prove it", () => {
    const shapes: Array<[Record<string, unknown>, boolean]> = [
      [{ consensusScore: 92, modelIndependence: "independent" }, false],
      [{ consensusScore: 92, modelIndependence: "independent", payload: { ...own.payload, modelEvidence: undefined } }, false],
      [{ consensusScore: 92, modelIndependence: "independent", payload: historic.payload }, false],
      [{ consensusScore: 92, modelIndependence: "independent", consensusBasis: "slot_responses" }, false],
      [{ consensusScore: 92, modelIndependence: "independent", consensusBasis: "independent_models" }, true],
      [{ consensusScore: 92, modelIndependence: "independent", payload: own.payload }, true],
    ];
    for (const [item, bare] of shapes) expect([item, /^ · \d+ consensus$/.test(suffix(item))]).toEqual([item, bare]);
  });
});
