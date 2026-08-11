/**
 * Adaptive Research Export, Phase 4 — the customer-facing JSON export
 * contract (`AdaptiveResearchJsonExportV1`).
 *
 * This is deliberately NOT a serialization of the internal frozen
 * `AdaptiveResearchExportV1` record. That record is an internal audit
 * artifact (Firestore document shape, `createdBy` UID, internal
 * `exportedSections` bookkeeping, `artifactStatus` lifecycle state) — none
 * of that was ever designed to be a public data contract, and exposing it
 * wholesale would (a) leak fields never intended to be external, and (b)
 * couple ConvergePanel's internal storage shape to every downstream
 * integration that parses a JSON export. `buildAdaptiveResearchJsonExport`
 * below is a dedicated, explicit projection — every field it emits is a
 * deliberate inclusion, not "whatever happened to be on the record."
 *
 * Deliberately excluded from the public contract (present internally, never
 * emitted here): `createdBy` / `exportMetadata.requestingUser` (Firebase
 * UIDs — no product requirement to expose them), `artifactStatus`
 * (Firestore lifecycle state, not report content), `exportMetadata.
 * exportedSections` (internal field-tracking bookkeeping), `exportMetadata.
 * fileHash` (an integrity hash of previously-generated PDF/DOCX bytes —
 * not meaningful for JSON's own self-referential output), `reportTypeLabel`
 * (a UI-oriented human label — `schemaId` is the real machine-readable
 * discriminator, per this file's own "no UI-oriented labels where
 * machine-readable enums exist" requirement).
 *
 * Consensus/source-grounding semantics (Part 6/7): `ConsensusLevel` and
 * `SourceGroundingLevel` already include a real `"unscored"` value in this
 * codebase (reportSummary.ts) — computed honestly at panel-run time for
 * schemas like `creative_generative` that have no consensus/grounding
 * concept, never coerced to `0` (which would falsely imply a measured
 * score of zero). This file passes that value straight through — it does
 * not reinvent a `"not_scored"` spelling the rest of the codebase doesn't
 * use; it exposes the field that's actually there.
 */

import "server-only";
import { createHash } from "crypto";
import {
  AdaptiveResearchExportV1,
  AdaptiveExportGovernanceStatus,
  AdaptiveExportClassification,
  AdaptiveExportModelSummary,
} from "./researchExport";
import { ConsensusLevel, SourceGroundingLevel } from "./reportSummary";
import { AdaptiveDecisionReceipt } from "./governanceRecord";
import { AdaptiveGateResult, AdaptiveModelResult, AdaptiveSynthesisReport, AdaptiveTrustSummary, AlignedClaim } from "./types";
import { PersistedAdaptiveSchemaId, PersistedLegacyAdaptiveSchemaId } from "./persistedOutput";

export const ADAPTIVE_RESEARCH_JSON_EXPORT_FORMAT_VERSION = "1" as const;

export type AdaptiveResearchJsonExportResult =
  | {
      schemaFamily: "milestone2";
      schemaId: PersistedAdaptiveSchemaId;
      /** The schema's own aggregated result object, passed through verbatim from the frozen snapshot — same structured shape the live UI and PDF/DOCX composers already read, never re-derived or re-interpreted here. */
      result: unknown;
      /** Absent when no governance record existed for this run at export time — never fabricated. */
      decisionReceipt?: AdaptiveDecisionReceipt;
    }
  | {
      schemaFamily: "legacy";
      schemaId: PersistedLegacyAdaptiveSchemaId;
      alignedClaims: AlignedClaim[];
      gate?: AdaptiveGateResult;
      synthesisReport?: AdaptiveSynthesisReport;
      trustSummary?: AdaptiveTrustSummary;
      modelResponses?: AdaptiveModelResult[];
    };

export interface AdaptiveResearchJsonExportV1 {
  formatVersion: typeof ADAPTIVE_RESEARCH_JSON_EXPORT_FORMAT_VERSION;

  export: {
    exportId: string;
    reportVersion: number;
    createdAt: string;
    format: "json";
  };

  report: {
    runId: string;
    schemaId: PersistedAdaptiveSchemaId | PersistedLegacyAdaptiveSchemaId;
    schemaVersion: 1;
    schemaFamily: "milestone2" | "legacy";
    question: string;
    generatedAt: string;
  };

  panel: {
    models: AdaptiveExportModelSummary[];
    /** Never a fabricated score/percentage — the exact enum the panel run itself computed, including "unscored". */
    consensus: { level: ConsensusLevel };
    sourceGrounding: { level: SourceGroundingLevel };
  };

  /** Raw, family-discriminated, exactly as frozen at export time — never re-evaluated, never relabeled (Part 12). A Milestone-2 `changes_requested` status stays `changes_requested`, never coerced to `rejected` or `needs_review`. */
  governance: AdaptiveExportGovernanceStatus;

  classification: AdaptiveExportClassification;

  result: AdaptiveResearchJsonExportResult;

  provenance: {
    runId: string;
    exportId: string;
    reportVersion: number;
    contractVersion: 1;
    schemaId: PersistedAdaptiveSchemaId | PersistedLegacyAdaptiveSchemaId;
    schemaVersion: 1;
    schemaFamily: "milestone2" | "legacy";
    generatedAt: string;
    exportedAt: string;
    models: AdaptiveExportModelSummary[];
    governanceStatusAtExport: AdaptiveExportGovernanceStatus;
    classification: AdaptiveExportClassification;
  };
}

/**
 * Pure projection from the frozen internal record to the public JSON
 * contract. No I/O, no current-time reads, no randomness — every value
 * comes from `record` itself, so the same frozen record always produces
 * the same logical object (byte-identical once canonically serialized —
 * see `canonicalJsonStringify` below).
 */
/**
 * Determinism fix — creation-time rendering and regeneration rendering
 * observe two DIFFERENT in-memory representations of "the same" frozen
 * record: creation renders from the raw, never-persisted object built in
 * the route handler; regeneration always renders from the record as read
 * back from Firestore. `sanitizeForFirestore()` (lib/firestore/
 * sanitizeForFirestore.ts) recursively converts every `undefined` to
 * `null` before writing, because Firestore rejects `undefined` outright —
 * so any field that is genuinely absent (`undefined`) at creation time
 * comes back as an explicit `null` after the round-trip, even though
 * `null` was never a value this contract's schema permits for that field
 * (`AdaptiveExportModelSummary.ok`, milestone2 `conditions`/
 * `decisionReceipt`, legacy `gate`/`synthesisReport`/`trustSummary`/
 * `modelResponses` are all Zod `.optional()` WITHOUT `.nullable()` — `null`
 * has no legitimate meaning for any of them).
 *
 * `null` is treated as "absent" ONLY for this bounded, explicitly-named
 * set of fields — never a blanket `null → undefined` across the whole
 * snapshot tree, which would risk destroying a field where `null` IS a
 * real, distinct value (e.g. `AdaptiveExportGovernanceStatus`'s legacy
 * branch: `status: "approved" | "needs_review" | "blocked" | null`, where
 * `null` means "not yet evaluated" — genuinely different from any of the
 * three string states, and must never be coerced away). This normalization
 * lives in exactly one place (this function, the single JSON projection
 * boundary both the creation and regeneration routes call through) and
 * runs identically regardless of whether the input came from the raw
 * in-memory object (already `undefined`, so this is a no-op) or from
 * Firestore (was `undefined`, is now `null`, gets treated as absent) —
 * both converge on the same "omitted" output, making creation and
 * regeneration byte-identical without changing the internal
 * `AdaptiveResearchExportV1`/Firestore-persisted shape at all.
 */
function omitIfNull<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function normalizeModelSummaries(models: AdaptiveExportModelSummary[]): AdaptiveExportModelSummary[] {
  return models.map((m) => ({ modelId: m.modelId, ...(omitIfNull(m.ok) !== undefined ? { ok: omitIfNull(m.ok) } : {}) }));
}

function normalizeGovernanceStatus(status: AdaptiveExportGovernanceStatus): AdaptiveExportGovernanceStatus {
  if (status.family !== "milestone2") return status; // legacy's `status: ... | null` is a real, distinct value — never touched.
  const conditions = omitIfNull(status.conditions);
  return { family: "milestone2", kind: status.kind, isOwnerOverride: status.isOwnerOverride, ...(conditions !== undefined ? { conditions } : {}) };
}

/**
 * Final review, Step 3 — `legacy.modelResponses` is passed through into the
 * JSON contract via `z.array(z.unknown())` (the Zod schema deliberately
 * does not validate its internal shape — per-model-schema producer
 * concern, not this export layer's). But each entry's TypeScript shape,
 * `AdaptiveModelResult`, is NOT opaque to this file (already imported,
 * already concretely typed) and has five of its own optional-not-nullable
 * fields subject to the exact same undefined-to-null Firestore round-trip
 * drift as the outer fields above: `parseError?`, `truncatedFields?`,
 * `invalidFields?`, `coercions?`, `retried?`. Confirmed live with a
 * fixture before this fix: `retried: undefined` at creation produced
 * `"retried": null` after a round-trip, breaking byte-identity exactly
 * like `ok` did. `data: Record<...> | null` is deliberately excluded —
 * its type already includes `null` as a real, distinct value, never an
 * artifact of persistence.
 *
 * Producer canonicalization follow-up (Milestone-2 Producer Canonicalization
 * pass): `milestone2.result` is no longer a theoretical risk — it was
 * audited field-by-field (all 9 active Milestone-2 alignment producers:
 * comparisonAlignment.ts, enumAlignment.ts, definitionAlignment.ts,
 * causalAlignment.ts, checklistAlignment.ts, deepResearchAlignment.ts,
 * evidenceReviewAlignment.ts, biasBlindspotAlignment.ts,
 * decisionSupportAlignment.ts) and 6 of the 9 were confirmed to construct
 * explicit-undefined own-properties; all 6 have since been fixed at their
 * own producer boundary (conditional-spread, matching this file's own
 * pattern) — see each file's "Producer canonicalization" comment. The
 * other 3 were read in full and confirmed already safe by construction.
 * `modelResponses[].data`'s own per-model raw fields (Claim/Metric/Step/
 * Scenario/etc.) were separately confirmed safe: they come from Zod
 * `.optional()` parsing (validator.ts), which genuinely omits an absent
 * key rather than ever setting it to explicit `undefined` — verified
 * directly against Zod's own parse behavior, not inferred from types.
 * `AdaptiveModelResult`'s own top-level optional fields (`parseError?`,
 * `truncatedFields?`, `invalidFields?`, `coercions?`, `retried?` — the
 * fields `normalizeModelResponses` below exists to guard) were likewise
 * confirmed safe at their producer boundary (validator.ts's
 * `validateAdaptiveResponse` return statements, orchestrate.ts's
 * `mergeRetriedResult`/`finalizeAdaptiveRun`) — all already use
 * conditional spread or assign only real values, never an explicit
 * `undefined`. Given all of this, `normalizeModelResponses` is now
 * REDUNDANT for any NEW write (the producer never emits the bad shape in
 * the first place) but is explicitly RETAINED here — unchanged — because
 * it is still load-bearing for regenerating a JSON export from a
 * Firestore record persisted before this producer fix, where the old
 * `undefined`-own-property shape may already be sitting on disk as
 * `null`. This file's own outer-contract normalization (`ok`/
 * `conditions`/`decisionReceipt`/`gate`/`synthesisReport`/`trustSummary`)
 * is unrelated to Milestone-2 alignment and comes from separate pipeline
 * stages (export snapshot freezing in researchExport.ts/exportSnapshot.ts,
 * decision receipt building, governance record management) — those
 * producers were never in scope for this pass and remain unaudited, so
 * their normalization here is unchanged and still necessary regardless of
 * write recency.
 */
function normalizeModelResponses(modelResponses: AdaptiveModelResult[]): AdaptiveModelResult[] {
  return modelResponses.map((m) => {
    const { parseError, truncatedFields, invalidFields, coercions, retried, ...rest } = m;
    return {
      ...rest,
      ...(omitIfNull(parseError) !== undefined ? { parseError: omitIfNull(parseError) } : {}),
      ...(omitIfNull(truncatedFields) !== undefined ? { truncatedFields: omitIfNull(truncatedFields) } : {}),
      ...(omitIfNull(invalidFields) !== undefined ? { invalidFields: omitIfNull(invalidFields) } : {}),
      ...(omitIfNull(coercions) !== undefined ? { coercions: omitIfNull(coercions) } : {}),
      ...(omitIfNull(retried) !== undefined ? { retried: omitIfNull(retried) } : {}),
    } as AdaptiveModelResult;
  });
}

export function buildAdaptiveResearchJsonExport(record: AdaptiveResearchExportV1): AdaptiveResearchJsonExportV1 {
  const snapshot = record.reportSnapshot;
  const governanceStatusAtExport = normalizeGovernanceStatus(record.governanceStatusAtExport);
  const models = normalizeModelSummaries(snapshot.models);

  const result: AdaptiveResearchJsonExportResult =
    record.schemaFamily === "milestone2" && snapshot.milestone2
      ? {
          schemaFamily: "milestone2",
          schemaId: snapshot.milestone2.schemaId,
          result: snapshot.milestone2.result,
          ...(omitIfNull(snapshot.milestone2.decisionReceipt) !== undefined ? { decisionReceipt: snapshot.milestone2.decisionReceipt! } : {}),
        }
      : record.schemaFamily === "legacy" && snapshot.legacy
        ? {
            schemaFamily: "legacy",
            schemaId: snapshot.legacy.schemaId,
            alignedClaims: snapshot.legacy.alignedClaims,
            ...(omitIfNull(snapshot.legacy.gate) !== undefined ? { gate: snapshot.legacy.gate! } : {}),
            ...(omitIfNull(snapshot.legacy.synthesisReport) !== undefined ? { synthesisReport: snapshot.legacy.synthesisReport! } : {}),
            ...(omitIfNull(snapshot.legacy.trustSummary) !== undefined ? { trustSummary: snapshot.legacy.trustSummary! } : {}),
            ...(omitIfNull(snapshot.legacy.modelResponses) !== undefined ? { modelResponses: normalizeModelResponses(snapshot.legacy.modelResponses!) } : {}),
          }
        : // Structurally unreachable — `schemaFamily` and the matching `reportSnapshot` branch are always set together at freeze time (researchExport.ts's own invariant). Fails loudly rather than silently emitting an empty/wrong-shaped result if that invariant is ever violated by a corrupted record.
          (() => {
            throw new Error(`AdaptiveResearchExportV1 record has schemaFamily "${record.schemaFamily}" but no matching reportSnapshot branch`);
          })();

  return {
    formatVersion: ADAPTIVE_RESEARCH_JSON_EXPORT_FORMAT_VERSION,
    export: {
      exportId: record.exportId,
      reportVersion: record.reportVersion,
      createdAt: record.createdAt,
      format: "json",
    },
    report: {
      runId: record.runId,
      schemaId: record.schemaId,
      schemaVersion: record.schemaVersion,
      schemaFamily: record.schemaFamily,
      question: snapshot.question,
      generatedAt: snapshot.reportGeneratedAt,
    },
    panel: {
      models,
      consensus: { level: snapshot.consensusLevel },
      sourceGrounding: { level: snapshot.sourceGroundingLevel },
    },
    governance: governanceStatusAtExport,
    classification: record.classification,
    result,
    provenance: {
      runId: record.runId,
      exportId: record.exportId,
      reportVersion: record.reportVersion,
      contractVersion: record.version,
      schemaId: record.schemaId,
      schemaVersion: record.schemaVersion,
      schemaFamily: record.schemaFamily,
      generatedAt: snapshot.reportGeneratedAt,
      exportedAt: record.createdAt,
      models,
      governanceStatusAtExport,
      classification: record.classification,
    },
  };
}

/**
 * Recursively rebuilds `value` with every plain object's keys sorted
 * alphabetically, leaving array element order completely untouched (Part
 * 16 — array order is frequently semantic here: ranked results, scenario
 * order, model order; object *key* order never is). This is what makes
 * serialization deterministic regardless of the order Firestore happens to
 * return a document's fields in on a given read — the same logical data
 * always canonicalizes to the same key order before stringification.
 *
 * Built with `Object.fromEntries` rather than a `target[key] = value`
 * assignment loop deliberately (Part 19): `Object.fromEntries` uses
 * define-property semantics, so a malicious/adversarial key literally named
 * `"__proto__"` becomes an inert OWN property on the result object, never
 * triggers the `Object.prototype.__proto__` accessor the way bracket
 * assignment in a loop would. No object spreading, no `for...in`, no
 * merging into a shared/trusted object anywhere in this function.
 */
/**
 * Non-finite numbers (Part 9 — reviewed as a real risk, not a hypothetical
 * one: `MetricZod`/`ScenarioZod` in validator.ts use bare `z.number()`,
 * which accepts `NaN`/`Infinity` just as happily as any other JS number —
 * neither Zod nor `RESULT_SHAPE_CHECKS` in persistedOutput.ts guard against
 * them). `JSON.stringify` silently turns all three into `null`, which is
 * indistinguishable from a field that was legitimately never populated —
 * unacceptable for a public data contract downstream integrations may
 * parse programmatically. Fails loudly instead, reusing the exact same
 * failure path the size guard below already exercises (caught by the
 * export route's existing try/catch → `markAdaptiveExportFailed` + a
 * failure audit event + a clean 500 — never a silently-misleading `null`
 * shipped as if it were valid report data).
 */
class NonFiniteNumberError extends Error {}

export function canonicalizeForSerialization(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new NonFiniteNumberError(`JSON export encountered a non-finite number (${value}) — refusing to silently serialize it as null`);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeForSerialization);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalizeForSerialization((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Deterministic JSON serialization (Part 15): canonical key order (see
 * above), fixed 2-space indentation, fixed trailing newline, UTF-8 (the
 * platform's native string encoding — `Buffer.from(str, "utf-8")` at the
 * call site is the only encoding step). No current-time reads, no random
 * IDs are ever introduced by this function — every value already came from
 * the frozen `record` passed to `buildAdaptiveResearchJsonExport`.
 *
 * `undefined`-valued object properties are already omitted by
 * `JSON.stringify` itself (Part 17's "prefer omission" policy) —
 * `buildAdaptiveResearchJsonExport` above only ever sets an optional key at
 * all when the source value is present, so there is nothing to omit here
 * beyond `JSON.stringify`'s own default behavior.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeForSerialization(value), null, 2) + "\n";
}

export interface RenderedAdaptiveJson {
  bytes: Buffer;
  sha256: string;
}

/**
 * Size guard (Part 20): reuses the export route's EXISTING failure
 * semantics (this function throwing is caught by the same try/catch every
 * other renderer's failure already goes through — `markAdaptiveExportFailed`
 * + a failure audit event + a clean 500, never a truncated/corrupt
 * download). Set generously above any realistic report size (typical
 * reports are 10-20KB) so it can only ever fire on genuinely pathological
 * content, never a legitimate report.
 */
const MAX_JSON_EXPORT_BYTES = 25 * 1024 * 1024;

export function renderAdaptiveResearchJsonV1(record: AdaptiveResearchExportV1): RenderedAdaptiveJson {
  const jsonExport = buildAdaptiveResearchJsonExport(record);
  const text = canonicalJsonStringify(jsonExport);
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length > MAX_JSON_EXPORT_BYTES) {
    throw new Error(`JSON export exceeds maximum size (${bytes.length} bytes > ${MAX_JSON_EXPORT_BYTES} bytes)`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}
