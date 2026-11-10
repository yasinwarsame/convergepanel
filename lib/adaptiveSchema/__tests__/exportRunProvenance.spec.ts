/**
 * Step 6.2b — `freezeExportRunProvenance` / `readFrozenRunProvenance` /
 * `exportRunProvenanceLines`.
 *
 * Each case changes ONE persisted source from a run where everything is
 * present, and asserts exactly that fact disappears (or changes) — so the
 * removal of any single provenance source fails a targeted test.
 */
import {
  FROZEN_RUN_PROVENANCE_VERSION,
  NON_SUBSTITUTED_PERSISTED_STATUSES,
  PERSISTED_STATUS_OUTCOMES,
  PROVENANCE_NOT_RECORDED,
  exportRunProvenanceLines,
  freezeExportRunProvenance,
  persistedStatusOutcome,
  readFrozenRunExecutionProvenance,
  readFrozenRunProvenance,
  type ExportRunProvenancePolicySource,
} from "@/lib/adaptiveSchema/exportRunProvenance";
import { STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

const MODELS = ["chatgpt", "claude"] as never[];

function perModel() {
  return [
    { modelId: "chatgpt", status: "ok", provider: "openai", requestedModel: "gpt-RUN-1", actualModel: "gpt-RUN-1", rawTextTruncated: "x" },
    { modelId: "claude", status: "substituted", provider: "deepseek", requestedModel: "claude-RUN-1", substitutedFrom: "anthropic:claude-RUN-1", rawTextTruncated: "y" },
  ];
}
function m2(automated: Record<string, unknown> | undefined = { status: "passed", reasons: [], policyVersion: 7 }): ExportRunProvenancePolicySource {
  return { family: "milestone2", governanceRecord: (automated === undefined ? {} : { automatedGovernance: automated }) as unknown as GovernanceRecordV1 };
}
function legacy(governanceStatus: "approved" | "needs_review" | "blocked" | null = "approved", governanceMeta: unknown = { policyVersion: 4, evaluatedAt: "2026-09-01T00:00:00.000Z" }): ExportRunProvenancePolicySource {
  return { family: "legacy", governanceStatus, governanceMeta };
}
const freeze = (rows: unknown = { perModel: perModel() }, policy: ExportRunProvenancePolicySource = m2()) =>
  freezeExportRunProvenance({ selectedModels: MODELS, runDocument: rows, policy });

/** Version 2 (Order 29): every frozen entry carries the slot's recorded outcome, or unknown / absent. */
const A = { outcome: "answered", outcomeSource: "recorded" } as const;
const U = { outcome: "unknown", outcomeSource: "absent" } as const;

/** The identity facts (version-1 shape): what readFrozenRunProvenance, the JSON export and the display lines read. */
const FULL = {
  policyVersion: 7,
  models: [
    { modelId: "chatgpt", provider: "openai", requestedModel: "gpt-RUN-1", substituted: false },
    { modelId: "claude", provider: "deepseek", requestedModel: "claude-RUN-1", substituted: true, substitutedFrom: "anthropic:claude-RUN-1" },
  ],
};
/** The same run frozen at version 2: identity facts plus the recorded outcomes. */
const FULL_V2 = {
  policyVersion: 7,
  provenanceVersion: 2,
  models: [
    { ...FULL.models[0], ...A },
    { ...FULL.models[1], ...A },
  ],
};

it("freezes the persisted policy version and every persisted per-model fact, with the version-2 marker and each slot's recorded outcome", () => {
  expect(freeze()).toEqual(FULL_V2);
  expect(FROZEN_RUN_PROVENANCE_VERSION).toBe(2);
});

it("never carries actualModel, and writes no undefined value anywhere (Firestore round-trip safe)", () => {
  const frozen = freeze({ perModel: [{ modelId: "chatgpt", status: "ok" }] });
  expect(JSON.stringify(frozen)).not.toContain("actualModel");
  const walk = (v: unknown): void => {
    if (v && typeof v === "object") for (const x of Object.values(v)) {
      expect(x).not.toBeUndefined();
      walk(x);
    }
  };
  walk(frozen);
  walk(freeze());
});

describe("policy version — Milestone-2 source: automatedGovernance.policyVersion, real evaluation only", () => {
  it.each(["passed", "flagged", "blocked"])("%s → frozen", (status) => {
    expect(freeze(undefined, m2({ status, reasons: [], policyVersion: 7 })).policyVersion).toBe(7);
  });
  it.each(["not_evaluated", "error"])("%s → absent even though a version is stored", (status) => {
    expect("policyVersion" in freeze(undefined, m2({ status, reasons: [], policyVersion: 7 }))).toBe(false);
  });
  it.each([undefined, 0, 1.5, "7", null])("policyVersion %p → absent", (policyVersion) => {
    expect("policyVersion" in freeze(undefined, m2({ status: "passed", reasons: [], policyVersion }))).toBe(false);
  });
  it("no automated evaluation / no governance record → absent", () => {
    expect("policyVersion" in freeze(undefined, { family: "milestone2", governanceRecord: {} as unknown as GovernanceRecordV1 })).toBe(false);
    expect("policyVersion" in freeze(undefined, { family: "milestone2" })).toBe(false);
  });
});

describe("policy version — legacy source: governanceMeta.policyVersion, only for an evaluated run", () => {
  it.each(["approved", "needs_review", "blocked"] as const)("governanceStatus %s → frozen from governanceMeta", (status) => {
    expect(freeze(undefined, legacy(status)).policyVersion).toBe(4);
  });
  it("never-evaluated legacy run (governanceStatus null) → absent even with a stray governanceMeta", () => {
    expect("policyVersion" in freeze(undefined, legacy(null))).toBe(false);
  });
  it.each([undefined, null, {}, { policyVersion: "4" }, { policyVersion: 0 }])("governanceMeta %p → absent", (meta) => {
    expect("policyVersion" in freeze(undefined, { family: "legacy", governanceStatus: "approved", governanceMeta: meta })).toBe(false);
  });
});

describe("per-model provenance — persisted perModel rows only", () => {
  const withRow = (i: number, edit: (row: Record<string, unknown>) => void) => {
    const rows = perModel() as Array<Record<string, unknown>>;
    edit(rows[i]);
    return freeze({ perModel: rows }).models[i];
  };
  it("a row without provider (pre-6.2a) freezes no provider — never from config or modelId", () => {
    expect(withRow(0, (r) => delete r.provider)).toEqual({ modelId: "chatgpt", requestedModel: "gpt-RUN-1", substituted: false, ...A });
  });
  it("a row without requestedModel freezes no requestedModel", () => {
    expect(withRow(0, (r) => delete r.requestedModel)).toEqual({ modelId: "chatgpt", provider: "openai", substituted: false, ...A });
  });
  it("a pre-6.2a substituted row keeps the substitution fact but no invented original", () => {
    expect(withRow(1, (r) => {
      delete r.substitutedFrom;
      delete r.provider;
      delete r.requestedModel;
    })).toEqual({ modelId: "claude", substituted: true, ...A });
  });
  it("substitution state comes from the persisted status: a stray substitutedFrom on a non-substituted row is not frozen", () => {
    expect(withRow(0, (r) => (r.substitutedFrom = "openai:stray"))).toEqual({ modelId: "chatgpt", provider: "openai", requestedModel: "gpt-RUN-1", substituted: false, ...A });
  });
  it("empty strings are not facts", () => {
    expect(withRow(0, (r) => {
      r.provider = "";
      r.requestedModel = "";
    })).toEqual({ modelId: "chatgpt", substituted: false, ...A });
  });
  it("models follow selectedModels; a model with no persisted row gets only its id", () => {
    const frozen = freezeExportRunProvenance({ selectedModels: ["claude", "gemini"] as never[], runDocument: { perModel: perModel() }, policy: m2() });
    expect(frozen.models.map((m) => m.modelId)).toEqual(["claude", "gemini"]);
    // No persisted row → no substitution claim either way, not `false`; the outcome is unknown / absent.
    expect(frozen.models[1]).toEqual({ modelId: "gemini", ...U });
  });
  it.each([undefined, null, "x", {}, { perModel: "x" }])("runDocument %p → ids only, nothing synthesized (no substitution claim)", (runDocument) => {
    expect(freezeExportRunProvenance({ selectedModels: MODELS, runDocument, policy: m2() }).models).toEqual([{ modelId: "chatgpt", ...U }, { modelId: "claude", ...U }]);
  });
  // Pinned literally — never iterated from the subject's own list, which would
  // silently drop a case if a status were removed from it.
  const EXPECTED_NON_SUBSTITUTED = ["ok", "failed", "error", "timeout", "refused", "rate_limited"];
  it("the non-substitution allow-list is exactly the persisted ConnectorStatus values other than substituted", () => {
    expect([...NON_SUBSTITUTED_PERSISTED_STATUSES].sort()).toEqual([...EXPECTED_NON_SUBSTITUTED].sort());
  });
  it.each(EXPECTED_NON_SUBSTITUTED)("persisted status %s → substituted: false (an explicit recorded fact)", (status) => {
    expect(withRow(0, (r) => (r.status = status)).substituted).toBe(false);
  });
  it.each([
    ["missing", undefined],
    ["null", null],
    ["unrecognized", "SUBSTITUTED"],
    ["non-string", 1],
  ])("persisted status %s → substitution state omitted, never false", (_label, status) => {
    const row = withRow(0, (r) => {
      if (status === undefined) delete r.status;
      else r.status = status;
    });
    expect("substituted" in row).toBe(false);
    expect(row).toEqual({ modelId: "chatgpt", provider: "openai", requestedModel: "gpt-RUN-1", ...U });
  });
  it("an unknown substitution state never carries a substitutedFrom", () => {
    expect(withRow(1, (r) => delete r.status)).toEqual({ modelId: "claude", provider: "deepseek", requestedModel: "claude-RUN-1", ...U });
  });
});

describe("frozen outcome (version 2, Order 29 M-1) — the explicitly recorded persisted status only, through an exact-match map", () => {
  const withRow = (i: number, edit: (row: Record<string, unknown>) => void) => {
    const rows = perModel() as Array<Record<string, unknown>>;
    edit(rows[i]);
    return freeze({ perModel: rows }).models[i];
  };
  // Pinned literally, never iterated from the subject's own map.
  const EXPECTED_OUTCOMES: Record<string, string> = { ok: "answered", substituted: "answered", failed: "failed", error: "failed", timeout: "timeout", refused: "refused", rate_limited: "rate_limited" };
  it("the map is exactly the real ConnectorStatus values and nothing else", () => {
    expect({ ...PERSISTED_STATUS_OUTCOMES }).toEqual(EXPECTED_OUTCOMES);
    expect(Object.keys(PERSISTED_STATUS_OUTCOMES).sort()).toEqual([...NON_SUBSTITUTED_PERSISTED_STATUSES, "substituted"].sort());
  });
  it.each(Object.entries(EXPECTED_OUTCOMES))("persisted status %s → outcome %s, source recorded", (status, outcome) => {
    expect(persistedStatusOutcome(status)).toEqual({ outcome, outcomeSource: "recorded" });
    expect(withRow(0, (r) => (r.status = status))).toMatchObject({ outcome, outcomeSource: "recorded" });
  });
  it.each([
    ["trailing space", "OK "],
    ["capitalised", "Ok"],
    ["the outcome word itself", "answered"],
    ["empty", ""],
    ["the fail-closed word", "unknown"],
    ["upper-case", "TIMEOUT"],
    ["number", 1],
    ["null", null],
    ["missing", undefined],
    ["object", { status: "ok" }],
    // Order 30 n-1: prototype keys are not own properties of the map (the R3 survivor of review c2a62df).
    ["a prototype key", "toString"],
    ["a prototype key", "constructor"],
    ["a prototype key", "__proto__"],
    ["a prototype key", "hasOwnProperty"],
  ])("a status that is %s (%p) → unknown / absent, never recorded", (_label, status) => {
    expect(persistedStatusOutcome(status)).toEqual(U);
    expect(withRow(0, (r) => {
      if (status === undefined) delete r.status;
      else r.status = status;
    })).toMatchObject(U);
  });
  it("the outcome is never inferred from the provider: a failed call without a provider is a recorded failure, a statusless row with a provider is unknown", () => {
    expect(withRow(0, (r) => {
      r.status = "timeout";
      delete r.provider;
    })).toEqual({ modelId: "chatgpt", requestedModel: "gpt-RUN-1", substituted: false, outcome: "timeout", outcomeSource: "recorded" });
    expect(withRow(0, (r) => {
      r.status = "error";
      r.provider = "unknown";
    })).toEqual({ modelId: "chatgpt", provider: "unknown", requestedModel: "gpt-RUN-1", substituted: false, outcome: "failed", outcomeSource: "recorded" });
    expect(withRow(0, (r) => delete r.status)).toEqual({ modelId: "chatgpt", provider: "openai", requestedModel: "gpt-RUN-1", ...U });
  });
  it("the D-5 class of the persisted row's text is frozen (the shared oracle): the exact listed literal, the loose marker, and nothing for ordinary text", () => {
    expect(withRow(0, (r) => (r.rawTextTruncated = STORED_PLACEHOLDER_LITERALS.chatgpt))).toMatchObject({ ...A, invalidProviderOutput: true });
    expect(withRow(0, (r) => (r.rawTextTruncated = `${STORED_PLACEHOLDER_LITERALS.chatgpt} (edited)`))).toMatchObject({ ...A, validityUnknown: true });
    expect(withRow(0, (r) => (r.rawTextTruncated = "A mock response is not what this is."))).toMatchObject({ ...A, validityUnknown: true });
    const plain = withRow(0, (r) => (r.rawTextTruncated = "Paris."));
    expect("invalidProviderOutput" in plain || "validityUnknown" in plain).toBe(false);
    // Only a slot whose own literal matches: Claude's literal in the ChatGPT slot is a near miss (validity unknown, not INVALID_MOCK).
    expect(withRow(0, (r) => (r.rawTextTruncated = STORED_PLACEHOLDER_LITERALS.claude))).toMatchObject({ ...A, validityUnknown: true });
  });
  it("writes no undefined value for the version-2 fields either", () => {
    const walk = (v: unknown): void => {
      if (v && typeof v === "object") for (const x of Object.values(v)) {
        expect(x).not.toBeUndefined();
        walk(x);
      }
    };
    walk(freeze({ perModel: [{ modelId: "chatgpt" }, { modelId: "claude", status: "refused" }] }));
  });
});

describe("readFrozenRunProvenance — the record as frozen, defensively", () => {
  it.each([undefined, null, "x", {}, { models: "x" }])("%p (every pre-6.2b record) → null: render nothing", (raw) => {
    expect(readFrozenRunProvenance(raw)).toBeNull();
  });
  it("round-trips a version-1 frozen value unchanged, and reads a version-2 value as the same identity facts (the JSON export and display lines never move)", () => {
    expect(readFrozenRunProvenance(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
    expect(readFrozenRunProvenance(JSON.parse(JSON.stringify(FULL_V2)))).toEqual(FULL);
    expect(JSON.stringify(readFrozenRunProvenance(freeze()))).toBe(JSON.stringify(FULL));
  });
  it("Firestore-style nulls are absent facts, never rendered as values", () => {
    const raw = { policyVersion: null, models: [{ modelId: "chatgpt", provider: null, requestedModel: null, substituted: false, substitutedFrom: null }] };
    expect(readFrozenRunProvenance(raw)).toEqual({ models: [{ modelId: "chatgpt", substituted: false }] });
  });
  it("a frozen substitutedFrom without substituted: true is not read back — substitution state stays authoritative", () => {
    expect(readFrozenRunProvenance({ models: [{ modelId: "chatgpt", substituted: false, substitutedFrom: "openai:stray" }] })).toEqual({
      models: [{ modelId: "chatgpt", substituted: false }],
    });
  });
  it.each([
    ["absent", {}],
    ["null (Firestore)", { substituted: null }],
    ["non-boolean", { substituted: "yes" }],
    ["number", { substituted: 0 }],
  ])("a frozen substitution state that is %s is omitted, never read as false", (_label, over) => {
    expect(readFrozenRunProvenance({ models: [{ modelId: "chatgpt", ...over }] })).toEqual({ models: [{ modelId: "chatgpt" }] });
  });
  it("literal booleans are preserved", () => {
    expect(readFrozenRunProvenance({ models: [{ modelId: "a", substituted: false }, { modelId: "b", substituted: true }] })).toEqual({
      models: [{ modelId: "a", substituted: false }, { modelId: "b", substituted: true }],
    });
  });
  it("a frozen substitutedFrom with an unknown substitution state is not read back", () => {
    expect(readFrozenRunProvenance({ models: [{ modelId: "chatgpt", substitutedFrom: "openai:x" }] })).toEqual({ models: [{ modelId: "chatgpt" }] });
  });
  it("malformed entries are skipped, never repaired", () => {
    expect(readFrozenRunProvenance({ models: [null, { provider: "openai" }, { modelId: "", substituted: true }, { modelId: "grok", substituted: "yes" }] })).toEqual({
      models: [{ modelId: "grok" }],
    });
  });
});

describe("readFrozenRunExecutionProvenance — the execution facts as frozen, literal values only", () => {
  it.each([undefined, null, "x", {}, { models: "x" }])("%p (every pre-6.2b record) → null", (raw) => {
    expect(readFrozenRunExecutionProvenance(raw)).toBeNull();
  });
  it("round-trips a version-2 frozen value unchanged", () => {
    expect(readFrozenRunExecutionProvenance(JSON.parse(JSON.stringify(FULL_V2)))).toEqual(FULL_V2);
    expect(readFrozenRunExecutionProvenance(freeze())).toEqual(FULL_V2);
  });
  it("a version-1 entry (no outcome) reads as unknown / absent and carries no version marker — nothing is reconstructed from substituted or the provider", () => {
    expect(readFrozenRunExecutionProvenance(JSON.parse(JSON.stringify(FULL)))).toEqual({ policyVersion: 7, models: [{ ...FULL.models[0], ...U }, { ...FULL.models[1], ...U }] });
  });
  it.each([
    ["answered", "answered"],
    ["failed", "failed"],
    ["timeout", "timeout"],
    ["refused", "refused"],
    ["rate_limited", "rate_limited"],
  ])("a literal recorded outcome %s is preserved (inside a value carrying the version marker 2)", (outcome) => {
    expect(readFrozenRunExecutionProvenance({ provenanceVersion: 2, models: [{ modelId: "a", outcome, outcomeSource: "recorded" }] })).toEqual({ provenanceVersion: 2, models: [{ modelId: "a", outcome, outcomeSource: "recorded" }] });
  });
  it.each([
    ["no marker", {}],
    ["marker 1", { provenanceVersion: 1 }],
    ["marker '2' (string)", { provenanceVersion: "2" }],
    ["marker 3", { provenanceVersion: 3 }],
    ["marker null", { provenanceVersion: null }],
    ["marker [2]", { provenanceVersion: [2] }],
  ])("Order 30 n-4: a literal recorded outcome in a value with %s is NOT trusted → unknown / absent", (_label, marker) => {
    for (const outcome of ["answered", "failed", "timeout", "refused", "rate_limited"]) {
      expect(readFrozenRunExecutionProvenance({ ...marker, models: [{ modelId: "a", outcome, outcomeSource: "recorded" }] })).toEqual({ models: [{ modelId: "a", ...U }] });
    }
  });
  it.each([
    ["source absent", { outcome: "answered", outcomeSource: "absent" }],
    ["source missing", { outcome: "answered" }],
    ["source crafted", { outcome: "answered", outcomeSource: "Recorded" }],
    ["the fail-closed word", { outcome: "unknown", outcomeSource: "recorded" }],
    ["a persisted status word", { outcome: "ok", outcomeSource: "recorded" }],
    ["capitalised", { outcome: "Answered", outcomeSource: "recorded" }],
    ["trailing space", { outcome: "answered ", outcomeSource: "recorded" }],
    ["empty", { outcome: "", outcomeSource: "recorded" }],
    ["non-string", { outcome: 1, outcomeSource: "recorded" }],
    ["null (Firestore)", { outcome: null, outcomeSource: null }],
  ])("an outcome that is %s → unknown / absent", (_label, over) => {
    expect(readFrozenRunExecutionProvenance({ provenanceVersion: 2, models: [{ modelId: "a", ...over }] })).toEqual({ provenanceVersion: 2, models: [{ modelId: "a", ...U }] });
  });
  it("the D-5 facts are read back only as the literal true; the version marker only as the literal 2", () => {
    expect(readFrozenRunExecutionProvenance({ provenanceVersion: 2, models: [{ modelId: "a", ...A, invalidProviderOutput: true }, { modelId: "b", ...A, validityUnknown: true }] })).toEqual({
      provenanceVersion: 2,
      models: [{ modelId: "a", ...A, invalidProviderOutput: true }, { modelId: "b", ...A, validityUnknown: true }],
    });
    // Order 30 n-4: without the literal marker 2 the recorded outcome is not trusted either.
    expect(readFrozenRunExecutionProvenance({ provenanceVersion: "2", models: [{ modelId: "a", ...A, invalidProviderOutput: "true", validityUnknown: 1 }] })).toEqual({ models: [{ modelId: "a", ...U }] });
    expect(readFrozenRunExecutionProvenance({ provenanceVersion: 3, models: [] })).toEqual({ models: [] });
  });
  it("the identity reader of the same value is its version-1 projection (keys and order unchanged)", () => {
    const raw = { provenanceVersion: 2, policyVersion: 7, models: [{ modelId: "a", provider: "openai", requestedModel: "m", substituted: false, outcome: "failed", outcomeSource: "recorded", invalidProviderOutput: true }] };
    expect(JSON.stringify(readFrozenRunProvenance(raw))).toBe(JSON.stringify({ policyVersion: 7, models: [{ modelId: "a", provider: "openai", requestedModel: "m", substituted: false }] }));
  });
});

describe("display lines", () => {
  it("states each frozen fact plainly", () => {
    expect(exportRunProvenanceLines(FULL as never)).toEqual([
      "Policy: v7",
      "Model (chatgpt): gpt-RUN-1 · openai",
      "Substitution (claude): requested anthropic:claude-RUN-1 → answered by deepseek",
    ]);
  });
  it("missing facts read 'not recorded' — never a plausible substitute", () => {
    expect(exportRunProvenanceLines({ models: [{ modelId: "chatgpt" as never, substituted: false }, { modelId: "claude" as never, substituted: true }] })).toEqual([
      `Policy: ${PROVENANCE_NOT_RECORDED}`,
      `Model (chatgpt): requested model ${PROVENANCE_NOT_RECORDED} · provider ${PROVENANCE_NOT_RECORDED}`,
      `Substitution (claude): requested original model ${PROVENANCE_NOT_RECORDED} → answered by provider ${PROVENANCE_NOT_RECORDED}`,
    ]);
  });
  it("an unknown substitution state is stated as not recorded — never presented as an ordinary unsubstituted model", () => {
    expect(exportRunProvenanceLines({ models: [{ modelId: "gemini" as never }, { modelId: "chatgpt" as never, provider: "openai", requestedModel: "gpt-RUN-1" }] }).slice(1)).toEqual([
      `Model (gemini): requested model ${PROVENANCE_NOT_RECORDED} · provider ${PROVENANCE_NOT_RECORDED} · substitution ${PROVENANCE_NOT_RECORDED}`,
      `Model (chatgpt): gpt-RUN-1 · openai · substitution ${PROVENANCE_NOT_RECORDED}`,
    ]);
  });
  it("a substitution with a persisted requestedModel but no substitutedFrom keeps the requested model and names only the missing part", () => {
    expect(exportRunProvenanceLines({ models: [{ modelId: "claude" as never, provider: "deepseek", requestedModel: "claude-RUN-1", substituted: true }] })[1]).toBe(
      `Substitution (claude): requested claude-RUN-1 (original provider ${PROVENANCE_NOT_RECORDED}) → answered by deepseek`
    );
  });
  it("makes no trust, verification or scoring claim", () => {
    expect(exportRunProvenanceLines(FULL as never).join("\n").toLowerCase()).not.toMatch(/verif|trust|score|actual|attest|confirmed/);
  });
});
