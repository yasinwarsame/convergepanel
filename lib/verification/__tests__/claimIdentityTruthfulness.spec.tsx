/**
 * Doc 14 PR-1, R3 (owner ruling 2026-11-18): agreement / disagreement wording needs the IDENTITIES behind it.
 *
 * "Models disagree on this claim", "Models diverged on important aspects…", "Partial agreement across models",
 * "Majority agreement", "Where models disagree" and any count stated in "models" are allowed only when the supporting
 * identities make them accurate: at least two distinct, reliably identified executing models on the relevant opposite
 * (or agreeing) sides. One substitute that answered several slots with contradictory verdicts produced differing SLOT
 * RESPONSES, not a disagreement between models. Unknown / non-canonical provider ids never count as identities.
 *
 * INDEPENDENT ORACLE. Everything the assertions rely on is derived here from the raw mix (outcome per slot + the
 * provider each slot recorded) with this file's own rules — this file imports no tally, provider-registry or identity
 * helper:
 *   - a provider is RELIABLE when it is one of the six registered provider tokens (literal list below);
 *   - the executing identity of a usable slot is its reliable provider; the record's identity is RELIABLE only when
 *     every usable slot has one;
 *   - the shared gate's independence (which decides whether any multi-model wording may appear at all) is re-derived:
 *     verified iff every usable slot records a registered provider; K = distinct keys, own slot → "slot:<id>",
 *     substituted slot → "substitute:<provider>"; independent iff verified and K ≥ 2.
 * Subjects: the exported banner (claimVerdictBanner), the copied verdict (buildClaimVerdictClipboardText) and the memo
 * generator given the wiring flags the Personal wrapper passes (computed here by the oracle).
 *
 * Provider modes: the reviewer's seven (substitutes in slots 2 and 4; two different substitute providers; a substitute
 * with no provider; provider "unknown"; an own slot recording another slot's provider; a non-DeepSeek substitute
 * matching an own provider; all slots substituted) plus own / DeepSeek in slots 1, 1–2, 1–3 / historic. Synthetic only.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));

import { claimVerdictBanner, buildClaimVerdictClipboardText } from "@/components/verification/ClaimVerificationResultView";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { buildClaimVerificationAuditBundle } from "@/lib/verification/auditBundle";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";

// ─── The oracle's own rules (no production helper) ─────────────────────────────────────────────────────────────────
const RELIABLE = new Set(["openai", "anthropic", "xai", "perplexity", "google", "deepseek"]);
const SLOTS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", gemini: "google", grok: "xai", perplexity: "perplexity" };
type Outcome = "A" | "P" | "I" | "U" | "PE" | "F";
const OUTCOMES: Outcome[] = ["A", "P", "I", "U", "PE", "F"];
const USABLE: ReadonlySet<Outcome> = new Set(["A", "P", "I", "U"]);
const VERDICT: Record<string, ModelVerdict> = { A: "accurate", P: "partially_accurate", I: "inaccurate", U: "unverifiable" };

/** What each slot recorded: `sub` = answered by a substitute; `provider` = the provider string as stored (or absent). */
type SlotRecord = { sub: boolean; provider?: string };
type Mode = { name: string; slot: (i: number) => SlotRecord };
const own = (i: number): SlotRecord => ({ sub: false, provider: OWN[SLOTS[i]] });
const MODES: Mode[] = [
  { name: "own", slot: own },
  { name: "ds:1", slot: (i) => (i === 0 ? { sub: true, provider: "deepseek" } : own(i)) },
  { name: "ds:1-2", slot: (i) => (i <= 1 ? { sub: true, provider: "deepseek" } : own(i)) },
  { name: "ds:1-3", slot: (i) => (i <= 2 ? { sub: true, provider: "deepseek" } : own(i)) },
  { name: "ds:slots2+4", slot: (i) => (i === 1 || i === 3 ? { sub: true, provider: "deepseek" } : own(i)) },
  { name: "two-substitute-providers", slot: (i) => (i === 0 ? { sub: true, provider: "deepseek" } : i === 1 ? { sub: true, provider: "perplexity" } : own(i)) },
  { name: "substitute-without-provider", slot: (i) => (i === 0 ? { sub: true } : own(i)) },
  { name: "provider-unknown", slot: (i) => (i === 0 ? { sub: false, provider: "unknown" } : own(i)) },
  { name: "own-slot-records-other-provider", slot: (i) => (i === 0 ? { sub: false, provider: "anthropic" } : own(i)) },
  { name: "non-ds-substitute-matches-own", slot: (i) => (i === 0 ? { sub: true, provider: "xai" } : own(i)) },
  { name: "all-substituted", slot: () => ({ sub: true, provider: "deepseek" }) },
  { name: "historic", slot: () => ({ sub: false }) },
];

function oracle(outs: Outcome[], mode: Mode) {
  const usable = outs.map((o, i) => ({ o, i, rec: mode.slot(i) })).filter((x) => USABLE.has(x.o));
  const reliableOf = (r: SlotRecord) => (r.provider !== undefined && RELIABLE.has(r.provider) ? r.provider : null);
  const reliable = usable.length > 0 && usable.every((x) => reliableOf(x.rec) !== null);
  // The shared gate, re-derived: verified iff every usable slot records a registered provider.
  const gateKeys = new Set(usable.map((x) => (x.rec.sub ? `substitute:${x.rec.provider}` : `slot:${SLOTS[x.i]}`)));
  const independent = reliable && gateKeys.size >= 2;
  const providersWith = (pred: (o: Outcome) => boolean) => new Set(usable.filter((x) => pred(x.o)).map((x) => reliableOf(x.rec)));
  const support = providersWith((o) => o === "A" || o === "P");
  const inacc = providersWith((o) => o === "I");
  const allProviders = new Set(usable.map((x) => reliableOf(x.rec)));
  // Opposite sides from two DIFFERENT reliably identified executing models.
  const crossModelDisagreement = reliable && [...support].some((s) => [...inacc].some((i) => s !== i));
  const supportAgreement = reliable && support.size >= 2;
  // Per provider: the set of verdicts its slots gave.
  const byProvider = new Map<string, Set<Outcome>>();
  for (const x of usable) {
    const p = reliableOf(x.rec) ?? `?${x.i}`;
    byProvider.set(p, new Set([...(byProvider.get(p) ?? []), x.o]));
  }
  const consistent = reliable && [...byProvider.values()].every((v) => v.size === 1);
  const count = (k: Outcome) => usable.filter((x) => x.o === k).length;
  return {
    usable: usable.length,
    A: count("A"),
    P: count("P"),
    I: count("I"),
    U: count("U"),
    reliable,
    independent,
    gateK: gateKeys.size,
    providers: allProviders.size,
    providersA: providersWith((o) => o === "A").size,
    crossModelDisagreement,
    supportAgreement,
    consistent,
    /** Each usable slot its own reliably identified executing model. */
    oneModelPerSlot: reliable && allProviders.size === usable.length && gateKeys.size === usable.length,
    providerOfSlot: (id: string) => {
      const i = SLOTS.indexOf(id);
      const x = usable.find((u) => u.i === i);
      return x ? reliableOf(x.rec) : null;
    },
  };
}

// ─── Records ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
function rowsFor(outs: Outcome[], mode: Mode): Row[] {
  return outs.map((o, i) => {
    const modelId = SLOTS[i];
    if (o === "F") return { modelId, status: "failed", verdict: "failed", confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] };
    if (o === "PE") return { modelId, status: "parse_error", verdict: "parse_error", confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] };
    const rec = mode.slot(i);
    // Distinct, long incorrect parts so the digest's opposite-side heuristic fires between I and supporting rows.
    const incorrectParts = o === "I" || o === "P" ? [`slot ${modelId} lists a distinct problem number ${i} with the claim wording`] : [];
    return {
      modelId,
      status: "ok",
      verdict: VERDICT[o],
      confidence: "high",
      summary: `${modelId} ${o}`,
      correctParts: [],
      incorrectParts,
      unverifiableParts: [],
      ...(rec.sub ? { substituted: true } : {}),
      ...(rec.provider !== undefined ? { provider: rec.provider } : {}),
    };
  });
}
function storedDoc(rows: Row[]): ClaimVerificationFirestoreDoc {
  const verdict = computeClaimVerdict(rows.map((r) => ({ status: r.status as "ok", verdict: r.status === "ok" ? (r.verdict as ModelVerdict) : undefined })));
  const stored = { verdict, consensusScore: 70, confidenceLabel: "High" as const, evidenceQuality: "mixed" as const };
  const auditBundle = buildClaimVerificationAuditBundle({ claimLength: 5, modelEvidence: rows as never, ...stored });
  return { userId: "u", claim: "Synthetic.", type: "claim_verification", ...stored, supportRatio: 0, modelResults: rows, auditBundle, selectedModels: rows.map((r) => r.modelId), timestamp: { seconds: 1, nanoseconds: 0 } } as unknown as ClaimVerificationFirestoreDoc;
}

function* mixes(): Generator<{ outs: Outcome[]; mode: Mode }> {
  for (let n = 1; n <= 5; n++) {
    const total = OUTCOMES.length ** n;
    for (let k = 0; k < total; k++) {
      const outs: Outcome[] = [];
      let x = k;
      for (let j = 0; j < n; j++) {
        outs.push(OUTCOMES[x % OUTCOMES.length]);
        x = Math.floor(x / OUTCOMES.length);
      }
      // Dedup: modes that record the same thing for every USABLE slot store the same record.
      const seen = new Set<string>();
      for (const mode of MODES) {
        const key = outs.map((o, i) => (USABLE.has(o) ? JSON.stringify(mode.slot(i)) : "-")).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        yield { outs, mode };
      }
    }
  }
}

const AGREEMENT_WORDS = /models disagree|models diverged|agreement across models|majority agreement|where models agree|where models disagree/i;

function check(outs: Outcome[], mode: Mode): string[] {
  const errs: string[] = [];
  const o = oracle(outs, mode);
  const payload = mapStoredVerificationToClientPayload(storedDoc(rowsFor(outs, mode)), "v");
  const b = claimVerdictBanner(payload);
  const text = `${b.title}\n${b.subtitle}`;

  if (!o.independent && AGREEMENT_WORDS.test(text)) errs.push(`agreement wording on a record that is not independent: ${b.title}`);
  if (/Models disagree on this claim/.test(b.title) && !o.crossModelDisagreement) errs.push("'Models disagree' without two identified models on opposite sides");
  if (/Partial agreement across models/.test(b.subtitle) && !o.supportAgreement) errs.push("'Partial agreement across models' without two identified supporting models");
  const sm = /^This claim is supported by (\d+)\/(\d+) models$/.exec(b.title);
  if (sm) {
    if (!o.consistent) errs.push("'a/u models' while one identified model answered differently");
    if (Number(sm[1]) !== o.providersA || Number(sm[2]) !== o.providers) errs.push(`'${sm[1]}/${sm[2]} models' vs identified ${o.providersA}/${o.providers}`);
    if (o.providers !== o.gateK) errs.push("model count differs from the identified providers");
  }
  if (/Majority agreement/.test(b.subtitle) && !(sm && 2 * Number(sm[1]) > Number(sm[2]) && Number(sm[1]) >= 2)) errs.push("'Majority agreement' without a majority of ≥ 2 identified models");
  const ns = /^(\d+) of (\d+) (models?|answers?) rated this claim inaccurate/.exec(b.title);
  if (ns && ns[3].startsWith("model") && !o.oneModelPerSlot) errs.push("no-support counts in 'models' without one identified model per slot");
  if (/\bmodels?\b/.test(b.title) && /\d/.test(b.title) && !sm && !(ns && o.oneModelPerSlot)) errs.push(`numeric model statement: ${b.title}`);

  // Disputed with answers on both sides but no cross-model disagreement → slot-response wording, never "disagree".
  if (o.independent && payload.verdict === "disputed" && o.A + o.P > 0 && o.I > 0 && !o.crossModelDisagreement && !/slot responses/i.test(b.title)) errs.push(`expected slot-response wording, got: ${b.title}`);

  // Copied verdict: "Where models disagree:" only over pairs of two different identified providers.
  const clip = buildClaimVerdictClipboardText(payload);
  const sec = clip.split("Where models disagree:\n")[1];
  if (sec) {
    for (const m of sec.matchAll(/^• Conflicting assessments: \((\w+)\) vs \((\w+)\)/gm)) {
      const pa = o.providerOfSlot(m[1]);
      const pb = o.providerOfSlot(m[2]);
      if (!(pa && pb && pa !== pb)) errs.push(`clipboard 'Where models disagree' pair ${m[1]}/${m[2]} is not two identified models`);
    }
  }
  if (!o.independent && /Where models (agree|disagree):/.test(clip)) errs.push("clipboard agreement heading on a non-independent record");

  // Memo, given the wiring flags (the oracle's truth): "Models diverged" only with a cross-model disagreement.
  const memo = generateVerificationMemo({
    type: "claim",
    claim: payload.claim,
    verdict: payload.verdict,
    consensusScore: payload.consensusScore,
    confidenceLabel: payload.confidenceLabel,
    evidenceQuality: "mixed",
    modelEvidence: payload.modelEvidence,
    agreementPoints: [],
    disagreementPoints: [],
    verificationId: "v",
    claimModelIndependence: o.independent ? "independent" : o.reliable ? "insufficient" : "unverified",
    ...(o.independent ? { claimExecution: { independentModels: o.gateK, answeredSlots: o.usable } } : {}),
    claimCrossModel: { disagreement: o.crossModelDisagreement, supportAgreement: o.supportAgreement },
  } as never);
  if (memo.includes("Models diverged on important aspects") && !o.crossModelDisagreement) errs.push("memo 'Models diverged' without a cross-model disagreement");
  return errs;
}

describe("independent identity oracle: agreement / disagreement wording needs identified models", () => {
  it("every mix (1–5 slots × 6 outcomes × 12 provider modes, deduplicated)", () => {
    let total = 0;
    const failures: string[] = [];
    let failing = 0;
    const allFailures: Array<{ mix: string; errs: string[] }> = [];
    for (const { outs, mode } of mixes()) {
      total += 1;
      const errs = check(outs, mode);
      if (errs.length) {
        failing += 1;
        if (process.env.ORACLE_DUMP) allFailures.push({ mix: `${outs.join(",")} [${mode.name}]`, errs });
        if (failures.length < 20) failures.push(`${outs.join(",")} [${mode.name}]: ${errs.join("; ")}`);
      }
    }
    if (process.env.ORACLE_DUMP) require("fs").writeFileSync(process.env.ORACLE_DUMP, JSON.stringify({ total, failing, all: allFailures }));
    expect({ failing, sample: failures }).toEqual({ failing: 0, sample: [] });
    expect(total).toBeGreaterThan(65_310 / 2);
  }, 600_000);
});

describe("named scenarios (R3)", () => {
  const banner = (outs: Outcome[], mode: Mode) => claimVerdictBanner(mapStoredVerificationToClientPayload(storedDoc(rowsFor(outs, mode)), "v"));
  const MODE = (name: string) => MODES.find((m) => m.name === name)!;

  it("reviewer repro: chatgpt=A and claude=I both via DeepSeek, gemini=U → slot responses differ, not 'Models disagree'", () => {
    const b = banner(["A", "I", "U"], MODE("ds:1-2"));
    expect(b.title).not.toContain("Models disagree");
    expect(b.title).toBe("Panel slot responses differ on this claim");
  });

  it("contradictory responses from one substitute (slots 2 and 4) with own slots unverifiable / accurate", () => {
    expect(banner(["U", "I", "U", "A"], MODE("ds:slots2+4")).title).not.toContain("Models disagree");
  });

  it("multiple genuine independent models on opposite sides keep 'Models disagree'", () => {
    expect(banner(["A", "I", "I"], MODE("own")).title).toBe("Models disagree on this claim");
  });

  it("partial support resting on one substitute is not 'Partial agreement across models'", () => {
    const b = banner(["P", "P", "U", "U"], MODE("ds:1-2"));
    expect(b.subtitle).not.toContain("Partial agreement across models");
  });

  it("unknown provider identity: no multi-model wording at all", () => {
    expect(AGREEMENT_WORDS.test(banner(["A", "I", "I"], MODE("provider-unknown")).title)).toBe(false);
  });
});
