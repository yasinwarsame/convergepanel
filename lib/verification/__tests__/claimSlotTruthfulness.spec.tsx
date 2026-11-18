/**
 * Doc 14 PR-1, correction round (owner ruling 2026-11-18: "count actual responses, not imaginary independent models").
 *
 * EXHAUSTIVE truthfulness check of what the claim surfaces state about the answers. Every mix of 1–5 panel slots, each
 * slot one of accurate / partially_accurate / inaccurate / unverifiable / parse_error / failed, under every provider
 * mode below, is stored the way the write path stores it (verdict from computeClaimVerdict, audit bundle from
 * buildClaimVerificationAuditBundle), reloaded through mapStoredVerificationToClientPayload, and its banner, slot note,
 * copied verdict and memo are checked against an ORACLE computed here from the raw slot outcomes — never from the
 * helpers under test.
 *
 * Provider modes (the shared gate's inputs as the claim write path records them):
 *   own            every answering slot records its own provider (Order 33);
 *   ds:0 / ds:0,1 / ds:0,1,2   those slots were answered by one substitute (DeepSeek: `substituted: true`,
 *                  provider "deepseek"), the rest by their own providers — several slots, one executing model;
 *   historic       no provider / substitution fields at all (records written before Order 33).
 * A mode whose substituted slots are all non-answering yields the same record as "own" and is skipped (deduplicated).
 *
 * The review that prompted this round found 57 of 20,028 mixes where the no-support banner divided per-verdict counts
 * of independent models by a model total (a substitute answering both "inaccurate" and "unverifiable" was counted on
 * both sides). Those mixes are all inside this enumeration (asserted below). Synthetic data only.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never),
}));
jest.mock("server-only", () => ({}));

import { claimVerdictBanner, buildClaimVerdictClipboardText, claimViewIndependence } from "@/components/verification/ClaimVerificationResultView";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { buildClaimVerificationAuditBundle } from "@/lib/verification/auditBundle";
import { claimPayloadSlotTally, claimSlotTallyNote } from "@/lib/verification/claimVerdictCounts";
import { generateVerificationMemo } from "@/lib/verification/generateMemo";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";

const SLOTS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", gemini: "google", grok: "xai", perplexity: "perplexity" };
type Outcome = "A" | "P" | "I" | "U" | "PE" | "F";
const OUTCOMES: Outcome[] = ["A", "P", "I", "U", "PE", "F"];
const VERDICT: Record<string, ModelVerdict> = { A: "accurate", P: "partially_accurate", I: "inaccurate", U: "unverifiable" };
type Mode = { name: string; substituted: number[]; historic: boolean };
const MODES: Mode[] = [
  { name: "own", substituted: [], historic: false },
  { name: "ds:0", substituted: [0], historic: false },
  { name: "ds:0,1", substituted: [0, 1], historic: false },
  { name: "ds:0,1,2", substituted: [0, 1, 2], historic: false },
  { name: "historic", substituted: [], historic: true },
];

type Row = Record<string, unknown>;
function rowsFor(outs: Outcome[], mode: Mode): Row[] {
  return outs.map((o, i) => {
    const modelId = SLOTS[i];
    if (o === "F") return { modelId, status: "failed", verdict: "failed", confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] };
    if (o === "PE") return { modelId, status: "parse_error", verdict: "parse_error", confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] };
    const base: Row = { modelId, status: "ok", verdict: VERDICT[o], confidence: "high", summary: `${modelId} ${o}`, correctParts: [], incorrectParts: [], unverifiableParts: [] };
    if (mode.historic) return base;
    return mode.substituted.includes(i) ? { ...base, substituted: true, provider: "deepseek" } : { ...base, provider: OWN[modelId] };
  });
}

function storedDoc(rows: Row[]): ClaimVerificationFirestoreDoc {
  const verdict = computeClaimVerdict(rows.map((r) => ({ status: r.status as "ok", verdict: r.status === "ok" ? (r.verdict as ModelVerdict) : undefined })));
  const stored = { verdict, consensusScore: 70, confidenceLabel: "High" as const, evidenceQuality: "mixed" as const };
  const auditBundle = buildClaimVerificationAuditBundle({ claimLength: 5, modelEvidence: rows as never, ...stored });
  return { userId: "u", claim: "Synthetic.", type: "claim_verification", ...stored, supportRatio: 0, modelResults: rows, auditBundle, selectedModels: rows.map((r) => r.modelId), timestamp: { seconds: 1, nanoseconds: 0 } } as unknown as ClaimVerificationFirestoreDoc;
}

/** The oracle: what the slots actually recorded, counted from the raw outcomes. */
function oracle(outs: Outcome[], mode: Mode) {
  const ok = outs.map((o, i) => ({ o, i })).filter((x) => ["A", "P", "I", "U"].includes(x.o));
  const count = (k: Outcome) => outs.filter((o) => o === k).length;
  const providerOf = (i: number) => (mode.substituted.includes(i) ? "deepseek" : OWN[SLOTS[i]]);
  const providers = mode.historic ? null : new Set(ok.map((x) => providerOf(x.i))).size;
  // Per executing model: the set of verdicts its slots gave.
  const byProvider = new Map<string, Set<Outcome>>();
  if (!mode.historic) for (const x of ok) byProvider.set(providerOf(x.i), new Set([...(byProvider.get(providerOf(x.i)) ?? []), x.o]));
  const consistent = !mode.historic && [...byProvider.values()].every((v) => v.size === 1);
  const modelsWith = (k: Outcome) => [...byProvider.values()].filter((v) => v.has(k)).length;
  return {
    consistent,
    modelsA: modelsWith("A"),
    slots: outs.length,
    usable: ok.length,
    A: count("A"),
    P: count("P"),
    I: count("I"),
    U: count("U"),
    failed: count("F"),
    malformed: count("PE"),
    substituted: mode.historic ? 0 : ok.filter((x) => mode.substituted.includes(x.i)).length,
    providers,
    /** Every answering slot is its own known executing model. */
    oneToOne: providers !== null && providers === ok.length,
  };
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
      // Dedup: two modes that substitute the same ANSWERING slots store the same record (a failed / malformed slot
      // records no substitution); only the first is checked.
      const seen = new Set<string>();
      for (const mode of MODES) {
        const effective = mode.substituted.filter((i) => i < n && ["A", "P", "I", "U"].includes(outs[i]));
        const key = mode.historic ? "historic" : `own:${effective.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        yield { outs, mode: mode.historic ? mode : { name: effective.length ? `ds:${effective.join(",")}` : "own", substituted: effective, historic: false } };
      }
    }
  }
}

const NO_SUPPORT = /^(\d+) of (\d+) (models?|answers?) rated this claim inaccurate(?:; (\d+) could not verify it)?$/;
const SUPPORTED_MODELS = /^This claim is supported by (\d+)\/(\d+) models$/;
const SUPPORTED_ANSWERS = /^This claim is supported by (\d+) of (\d+) answers$/;
// R3: the disclosure is stated over slot RESPONSES (with the slot note), no longer through the gate's model count.
const SLOT_NOTE = "These counts are of panel slot responses, not of agreeing models";

function check(outs: Outcome[], mode: Mode): string[] {
  const errs: string[] = [];
  const o = oracle(outs, mode);
  const payload = mapStoredVerificationToClientPayload(storedDoc(rowsFor(outs, mode)), "v");
  const view = claimViewIndependence(payload);
  const banner = claimVerdictBanner(payload);
  const support = o.A + o.P;

  // 1. Banner: every number it states is a count of recorded answers (one denominator), or — only for a run in which
  //    every answering slot is its own executing model — of models; the slots are disclosed otherwise.
  const ns = NO_SUPPORT.exec(banner.title);
  if (ns) {
    const [inacc, total, unit, unver] = [Number(ns[1]), Number(ns[2]), ns[3], Number(ns[4] ?? 0)];
    if (inacc !== o.I || unver !== o.U || total !== o.usable) errs.push(`no-support counts ${inacc}/${unver}/${total} vs I=${o.I} U=${o.U} usable=${o.usable}`);
    if (inacc + unver > total) errs.push("no-support parts exceed total");
    if (support !== 0) errs.push("no-support banner over a supporting answer");
    if (unit.startsWith("model") && !o.oneToOne) errs.push("counts stated as models without one model per slot");
    if (!unit.startsWith("model") && !banner.subtitle.includes(SLOT_NOTE)) errs.push("answer counts without the slot disclosure");
  }
  const sm = SUPPORTED_MODELS.exec(banner.title);
  if (sm) {
    // Models may be counted only when no executing model answered on two sides; then a/u = models rating it accurate /
    // executing models (a substitute in several slots counts once, C-b CB-06).
    if (!o.consistent) errs.push("'a/u models' while an executing model answered its slots differently");
    else if (Number(sm[1]) !== o.modelsA || Number(sm[2]) !== o.providers) errs.push(`supported ${sm[1]}/${sm[2]} vs models A=${o.modelsA} of ${o.providers}`);
  }
  const sa = SUPPORTED_ANSWERS.exec(banner.title);
  // R3: C-b CB-06 model wording is expected only for a majority of >= 2 consistently answering identified models.
  if (sa && o.consistent && o.providers !== null && o.modelsA >= 2 && 2 * o.modelsA > o.providers) errs.push("answer counts where a consistent identified majority exists (C-b CB-06 wording expected)");
  if (sa) {
    if (Number(sa[1]) !== o.A || Number(sa[2]) !== o.usable) errs.push(`supported answers ${sa[1]}/${sa[2]} vs A=${o.A} usable=${o.usable}`);
    if (!banner.subtitle.includes(SLOT_NOTE)) errs.push("supported-answers banner without the slot disclosure");
  }
  if (banner.title === "Models disagree on this claim" && !(support > 0 && o.I > 0)) errs.push(`"Models disagree" without answers on both sides (support=${support} I=${o.I})`);
  if (view.independence !== "independent" && (ns || sm || sa || /disagree/i.test(banner.title))) errs.push("multi-model statement on a non-independent record");
  // R4: an unverifiable record without a majority of >= 2 identified models rating it unverifiable states the answers.
  const ua = /^(\d+) of (\d+) answers rated this claim unverifiable$/.exec(banner.title);
  if (ua) {
    if (Number(ua[1]) !== o.U || Number(ua[2]) !== o.usable) errs.push(`unverifiable answers ${ua[1]}/${ua[2]} vs U=${o.U} usable=${o.usable}`);
    if (!banner.subtitle.includes(SLOT_NOTE)) errs.push("unverifiable-answers banner without the slot disclosure");
  }
  if (/\d/.test(banner.title) && !ns && !sm && !sa && !ua) errs.push(`unclassified numeric banner: ${banner.title}`);

  // 2. Slot note (consensus card / copied verdict): the recorded slot outcomes, exactly.
  const tally = claimPayloadSlotTally(payload);
  if (!tally) errs.push("tally null for a well-formed record");
  else {
    const note = claimSlotTallyNote(tally) ?? "";
    const answered = /(\d+) of (\d+) slots? answered/.exec(note);
    if ((o.usable < o.slots) !== Boolean(answered)) errs.push(`answered clause presence (note: ${note})`);
    if (answered && (Number(answered[1]) !== o.usable || Number(answered[2]) !== o.slots)) errs.push(`answered ${answered[1]}/${answered[2]}`);
    const num = (re: RegExp) => Number(re.exec(note)?.[1] ?? 0);
    if (num(/(\d+) failed/) !== o.failed) errs.push("failed count");
    if (num(/(\d+) malformed/) !== o.malformed) errs.push("malformed count");
    if (num(/(\d+) answered by a substitute model/) !== o.substituted) errs.push("substituted count");
    const prov = /(\d+) distinct executing providers?/.exec(note);
    const expectProv = o.providers !== null && o.providers < o.usable;
    if (expectProv !== Boolean(prov) || (prov && Number(prov[1]) !== o.providers)) errs.push(`providers clause (note: ${note})`);
  }

  // 3. Copied verdict and memo: the no-support sentence is over answers, with the oracle's counts.
  const clip = buildClaimVerdictClipboardText(payload);
  const sentence = (): string => `No answer supported the claim: ${o.I} of ${o.usable} rated it inaccurate${o.U > 0 ? ` and ${o.U} could not verify it` : ""}.`;
  const noSupportStored = payload.verdict === "disputed" && support === 0 && o.I > 0;
  if (noSupportStored !== clip.includes("No answer supported the claim")) errs.push("clipboard no-support presence");
  if (noSupportStored && !clip.includes(sentence())) errs.push("clipboard no-support counts");
  const exec = view.independence === "independent" && view.identity.verified && view.identity.independentModels !== null ? { independentModels: view.identity.independentModels, answeredSlots: view.identity.answeredSlots } : undefined;
  const memo = generateVerificationMemo({
    type: "claim",
    claim: payload.claim,
    verdict: payload.verdict,
    consensusScore: payload.consensusScore,
    confidenceLabel: payload.confidenceLabel,
    evidenceQuality: "mixed",
    modelEvidence: payload.modelEvidence,
    agreementPoints: payload.whereModelsAgree,
    disagreementPoints: payload.whereModelsDisagree.map((d) => d.point),
    verificationId: "v",
    claimModelIndependence: view.independence,
    ...(exec ? { claimExecution: exec } : {}),
  });
  if (view.independence === "independent" && noSupportStored && !memo.includes(sentence())) errs.push("memo no-support counts");
  if (memo.includes("No answer supported the claim") && !memo.includes(sentence())) errs.push("memo no-support sentence with other counts");
  return errs;
}

describe("exhaustive slot-response truthfulness (1–5 slots × 6 outcomes × provider modes)", () => {
  it("every mix states only the recorded answers, with one denominator, and discloses substituted slots", () => {
    let total = 0;
    let substitutedBothIU = 0;
    const failures: string[] = [];
    for (const { outs, mode } of mixes()) {
      total += 1;
      if (mode.substituted.some((i) => outs[i] === "I") && mode.substituted.some((i) => outs[i] === "U")) substitutedBothIU += 1;
      const errs = check(outs, mode);
      if (errs.length && failures.length < 25) failures.push(`${outs.join(",")} [${mode.name}]: ${errs.join("; ")}`);
      else if (errs.length) failures.push("…");
    }
    expect(failures).toEqual([]);
    // Pinned size (≥ the reviewer's 20,028): a change to the generator that drops mixes fails here.
    expect(total).toBe(37_288);
    // The reviewer's 57 failing mixes all have a substitute answering both I and U; this enumeration contains such mixes.
    expect(substitutedBothIU).toBeGreaterThan(57);
  }, 240_000);

  it("the reviewer's repro: chatgpt + claude by DeepSeek (inaccurate, unverifiable), grok (xAI) inaccurate", () => {
    const payload = mapStoredVerificationToClientPayload(storedDoc(rowsFor(["I", "U", "F", "I"], MODES[2])), "v");
    const b = claimVerdictBanner(payload);
    expect(b.title).toBe("2 of 3 answers rated this claim inaccurate; 1 could not verify it");
    expect(b.subtitle).toContain("These counts are of panel slot responses, not of agreeing models (3 of 4 slots answered; 1 failed; 2 answered by a substitute model; 2 distinct executing providers).");
    expect(b.title).not.toContain("2 of 2 models");
  });
});

describe("named scenarios", () => {
  const banner = (outs: Outcome[], mode: Mode) => claimVerdictBanner(mapStoredVerificationToClientPayload(storedDoc(rowsFor(outs, mode)), "v"));
  const note = (outs: Outcome[], mode: Mode) => {
    const t = claimPayloadSlotTally(mapStoredVerificationToClientPayload(storedDoc(rowsFor(outs, mode)), "v"));
    return t ? claimSlotTallyNote(t) : "NULL";
  };

  it("several slots answered by one substitute: slot counts, and the substitution disclosed", () => {
    expect(note(["I", "I", "I"], MODES[3])).toBe("3 answered by a substitute model; 1 distinct executing provider");
    // One executing model: not presented as agreement between models at all.
    expect(banner(["I", "I", "I"], MODES[3]).title).toBe("Disputed — One independent model's assessment — not agreement between models");
    // DeepSeek answered three slots, all accurate, plus Grok: C-b CB-06 — the substitute counts once.
    expect(banner(["A", "A", "A", "A"], MODES[3]).title).toBe("This claim is supported by 2/2 models");
    // DeepSeek answered its slots accurate AND inaccurate: it cannot be counted as a supporting model — slot responses.
    const mixed = claimVerdictBanner(mapStoredVerificationToClientPayload(storedDoc(rowsFor(["A", "I", "A", "A", "A"], MODES[2])), "v"));
    expect(mixed.title).toBe("This claim is supported by 4 of 5 answers");
    expect(mixed.subtitle).toContain("These counts are of panel slot responses, not of agreeing models (2 answered by a substitute model; 4 distinct executing providers).");
  });

  it("one model fails and another is substituted", () => {
    expect(note(["I", "F", "I", "I"], MODES[1])).toBe("3 of 4 slots answered; 1 failed; 1 answered by a substitute model");
    expect(banner(["I", "F", "I", "I"], MODES[1]).title).toBe("3 of 3 models rated this claim inaccurate");
  });

  it("some malformed answers are neither usable nor unverifiable", () => {
    expect(note(["I", "PE", "I", "PE"], MODES[0])).toBe("2 of 4 slots answered; 2 malformed (no recognized verdict)");
    expect(banner(["I", "PE", "I", "PE"], MODES[0]).title).toBe("2 of 2 models rated this claim inaccurate");
  });

  it("all usable answers agree (clean run): unchanged wording, nothing to disclose", () => {
    expect(banner(["A", "A", "A"], MODES[0]).title).toBe("This claim is supported by 3/3 models");
    expect(note(["A", "A", "A"], MODES[0])).toBeNull();
  });

  it("usable answers conflict: 'Models disagree' only with answers on both sides", () => {
    expect(banner(["A", "I", "I"], MODES[0]).title).toBe("Models disagree on this claim");
  });

  it("only one usable provider remains: one model's assessment, never a multi-model statement", () => {
    expect(banner(["I", "F", "PE"], MODES[0]).title).toBe("Disputed — One independent model's assessment — not agreement between models");
  });

  it("historic records lacking provider / substitution fields: coverage unverified, no counts stated as models", () => {
    expect(banner(["I", "I", "I"], MODES[4]).title).toBe("Disputed — Independent-model coverage unverified");
    expect(note(["I", "I", "I"], MODES[4])).toBeNull();
    expect(note(["I", "F", "I"], MODES[4])).toBe("2 of 3 slots answered; 1 failed");
  });
});
