/**
 * Step 6.2b — `freezeExportRunProvenance` / `readFrozenRunProvenance` /
 * `exportRunProvenanceLines`.
 *
 * Each case changes ONE persisted source from a run where everything is
 * present, and asserts exactly that fact disappears (or changes) — so the
 * removal of any single provenance source fails a targeted test.
 */
import {
  PROVENANCE_NOT_RECORDED,
  exportRunProvenanceLines,
  freezeExportRunProvenance,
  readFrozenRunProvenance,
  type ExportRunProvenancePolicySource,
} from "@/lib/adaptiveSchema/exportRunProvenance";
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

const FULL = {
  policyVersion: 7,
  models: [
    { modelId: "chatgpt", provider: "openai", requestedModel: "gpt-RUN-1", substituted: false },
    { modelId: "claude", provider: "deepseek", requestedModel: "claude-RUN-1", substituted: true, substitutedFrom: "anthropic:claude-RUN-1" },
  ],
};

it("freezes the persisted policy version and every persisted per-model fact", () => {
  expect(freeze()).toEqual(FULL);
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
    expect(withRow(0, (r) => delete r.provider)).toEqual({ modelId: "chatgpt", requestedModel: "gpt-RUN-1", substituted: false });
  });
  it("a row without requestedModel freezes no requestedModel", () => {
    expect(withRow(0, (r) => delete r.requestedModel)).toEqual({ modelId: "chatgpt", provider: "openai", substituted: false });
  });
  it("a pre-6.2a substituted row keeps the substitution fact but no invented original", () => {
    expect(withRow(1, (r) => {
      delete r.substitutedFrom;
      delete r.provider;
      delete r.requestedModel;
    })).toEqual({ modelId: "claude", substituted: true });
  });
  it("substitution state comes from the persisted status: a stray substitutedFrom on a non-substituted row is not frozen", () => {
    expect(withRow(0, (r) => (r.substitutedFrom = "openai:stray"))).toEqual({ modelId: "chatgpt", provider: "openai", requestedModel: "gpt-RUN-1", substituted: false });
  });
  it("empty strings are not facts", () => {
    expect(withRow(0, (r) => {
      r.provider = "";
      r.requestedModel = "";
    })).toEqual({ modelId: "chatgpt", substituted: false });
  });
  it("models follow selectedModels; a model with no persisted row gets only its id", () => {
    const frozen = freezeExportRunProvenance({ selectedModels: ["claude", "gemini"] as never[], runDocument: { perModel: perModel() }, policy: m2() });
    expect(frozen.models.map((m) => m.modelId)).toEqual(["claude", "gemini"]);
    expect(frozen.models[1]).toEqual({ modelId: "gemini", substituted: false });
  });
  it.each([undefined, null, "x", {}, { perModel: "x" }])("runDocument %p → ids only, nothing synthesized", (runDocument) => {
    expect(freezeExportRunProvenance({ selectedModels: MODELS, runDocument, policy: m2() }).models).toEqual([
      { modelId: "chatgpt", substituted: false },
      { modelId: "claude", substituted: false },
    ]);
  });
});

describe("readFrozenRunProvenance — the record as frozen, defensively", () => {
  it.each([undefined, null, "x", {}, { models: "x" }])("%p (every pre-6.2b record) → null: render nothing", (raw) => {
    expect(readFrozenRunProvenance(raw)).toBeNull();
  });
  it("round-trips a frozen value unchanged", () => {
    expect(readFrozenRunProvenance(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
  });
  it("Firestore-style nulls are absent facts, never rendered as values", () => {
    const raw = { policyVersion: null, models: [{ modelId: "chatgpt", provider: null, requestedModel: null, substituted: false, substitutedFrom: null }] };
    expect(readFrozenRunProvenance(raw)).toEqual({ models: [{ modelId: "chatgpt", substituted: false }] });
  });
  it("malformed entries are skipped, never repaired", () => {
    expect(readFrozenRunProvenance({ models: [null, { provider: "openai" }, { modelId: "", substituted: true }, { modelId: "grok", substituted: "yes" }] })).toEqual({
      models: [{ modelId: "grok", substituted: false }],
    });
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
  it("makes no trust, verification or scoring claim", () => {
    expect(exportRunProvenanceLines(FULL as never).join("\n").toLowerCase()).not.toMatch(/verif|trust|score|actual|attest|confirmed/);
  });
});
