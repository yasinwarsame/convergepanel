/**
 * Whether a STORED claim verification's consensus score may be presented as agreement between models, judged only from
 * what `verifications/{verificationId}` persisted — the claim-verification counterpart of
 * `storedRunConsensusIndependence` (lib/panel/independentVoices.ts).
 *
 * A claim verification asks every requested model for a verdict; its stored `consensusScore` is a cross-model figure.
 * Since C-b (CB-01) the judgement is the ONE shared presentation gate (lib/panel/executionIdentity.ts,
 * `runExecutionIdentity` / `executionIdentityVerified`) over the stored rows (`claimIdentityRow`); nothing here
 * re-implements it:
 *  - "independent": the gate verifies the rows (every answering row records who executed it — a provider for an `ok`
 *    row, the substitute's provider for a substituted one) and K ≥ 2 independent executing models answered (a
 *    substitute model that answered several slots is ONE model; failed / parse_error slots never answer);
 *  - "insufficient": the gate verifies the rows and exactly one independent executing model answered;
 *  - "unverified": everything else — no `modelResults`, a row that is not an object, a row without a non-empty
 *    `modelId` naming a known panel slot, a row without a recorded status (`ok` / `parse_error` / `failed`), a requested
 *    model (`selectedModels`) with no row, an `ok` row without a recorded provider (claim rows written before Order 33
 *    record none for an own-provider answer — m-B — so such records stay unverified; since Order 33 the claim dispatch
 *    stamps the invoked connector's canonical provider, lib/verification/runClaimVerificationPanel.ts), an unrecorded substitute, or no answering row
 *    at all (K = 0 is never presented as verified). Nothing is inferred and no provider history is reconstructed.
 *
 * `storedVerificationExecutingRows` keeps its shape (it is the queue builder's row adapter); with the gate holding no
 * unrecorded substitute answers, so its key resolution never merges anything for a verified record.
 *
 * Pure, server- and client-safe; never mutates its input.
 */

import { MIN_INDEPENDENT_SYNTHESIS_MODELS, type StoredConsensusIndependence, type VoiceRow } from "./independentVoices";
import { runExecutionIdentity, type IdentityRow, type RunExecutionIdentity } from "./executionIdentity";
import { RUN_MODEL_FAMILY_NAMES } from "./runModelIdentity";

const STORED_CLAIM_ROW_STATUSES = new Set(["ok", "parse_error", "failed"]);

function isKnownSlot(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUN_MODEL_FAMILY_NAMES, modelId);
}

/**
 * The stored claim rows as executing-identity rows (`VoiceRow`), or null when execution identity is missing or
 * incomplete (see the module header). `answered` marks rows with a usable verdict (`status: "ok"`).
 */
export function storedVerificationExecutingRows(
  data: Record<string, unknown> | null | undefined
): Array<VoiceRow & { answered: boolean }> | null {
  if (!data || typeof data !== "object") return null;
  const mr = data.modelResults;
  if (!Array.isArray(mr) || mr.length === 0) return null;
  const rows: Array<VoiceRow & { answered: boolean }> = [];
  const slots = new Set<string>();
  for (const raw of mr) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.modelId !== "string") return null;
    const modelId = r.modelId.trim().toLowerCase();
    if (modelId.length === 0 || !isKnownSlot(modelId)) return null;
    if (typeof r.status !== "string" || !STORED_CLAIM_ROW_STATUSES.has(r.status)) return null;
    slots.add(modelId);
    rows.push({
      modelId,
      status: r.substituted === true ? "substituted" : "ok",
      provider: r.provider,
      answered: r.status === "ok",
    });
  }
  const selected = data.selectedModels;
  if (selected !== undefined) {
    if (!Array.isArray(selected)) return null;
    for (const s of selected) {
      if (typeof s !== "string" || !slots.has(s.trim().toLowerCase())) return null;
    }
  }
  return rows;
}

/**
 * C-b (CB-01): one stored / client claim row as the row the shared gate reads (lib/panel/executionIdentity.ts). Recorded
 * facts only, nothing inferred:
 *  - `status: "ok"` with `substituted: true` → "substituted" (the substitute's recorded `provider`, if any, as recorded);
 *  - `status: "ok"` otherwise → "ok" with the row's recorded `provider` — written since Order 33 for a successful
 *    own-provider answer (buildClaimModelEvidence); a record written before then has none, so the gate does not verify
 *    it (no provider is reconstructed);
 *  - `status: "parse_error"` / `"failed"` → "failed": the call produced no usable verdict, so the slot is never an
 *    answering (supporting) slot;
 *  - any other status (not a stored claim status — "timeout", "error", a crafted value, none) is not recorded as a
 *    claim outcome: the row carries no status, so the gate fails closed (it is never read as a known failure).
 * Claim rows carry no model text the gate could read (`summary` is the model's verdict summary, not its answer), so
 * no text key is passed: a stored placeholder answer cannot be an `ok` claim row (it does not parse as a verdict).
 */
export function claimIdentityRow(raw: unknown): IdentityRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const status =
    r.status === "ok" ? (r.substituted === true ? "substituted" : "ok") : r.status === "parse_error" || r.status === "failed" ? "failed" : undefined;
  return {
    modelId: typeof r.modelId === "string" ? r.modelId.trim().toLowerCase() : r.modelId,
    ...(status !== undefined ? { status } : {}),
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
  };
}

/**
 * The execution identity of a STORED claim verification, judged by the shared gate (C-b CB-01): UV whenever the record's
 * shape is not established (`storedVerificationExecutingRows` returns null: no rows, an unknown slot or status, a
 * requested model without a row), else `runExecutionIdentity` over the rows as `claimIdentityRow` presents them.
 */
export function storedVerificationExecutionIdentity(data: Record<string, unknown> | null | undefined): RunExecutionIdentity {
  if (!storedVerificationExecutingRows(data)) return runExecutionIdentity([]);
  return runExecutionIdentity((data!.modelResults as unknown[]).map(claimIdentityRow));
}

/**
 * The execution identity of the claim rows a CLIENT payload holds (live result, saved payload), by the shared gate. The
 * client has no `selectedModels`; the server's `modelIndependence` already covers that check
 * (`claimPresentedIndependence`).
 */
export function claimRowsExecutionIdentity(rows: readonly unknown[] | null | undefined): RunExecutionIdentity {
  return runExecutionIdentity(Array.isArray(rows) ? rows.map(claimIdentityRow) : []);
}

/**
 * Distinct independent executing models among the stored rows that answered (the shared gate's K), or null when the
 * gate does not verify the record's execution identity (C-b CB-01: an `ok` row without a recorded provider, an
 * unrecorded substitute, no answering row, an unknown status, a requested model without a row).
 */
export function storedVerificationIndependentAnswerCount(data: Record<string, unknown> | null | undefined): number | null {
  const identity = storedVerificationExecutionIdentity(data);
  return identity.verified ? identity.independentModels : null;
}

export function storedVerificationConsensusIndependence(data: Record<string, unknown> | null | undefined): StoredConsensusIndependence {
  const n = storedVerificationIndependentAnswerCount(data);
  if (n === null) return "unverified";
  return n >= MIN_INDEPENDENT_SYNTHESIS_MODELS ? "independent" : "insufficient";
}

/**
 * The independence a claim CLIENT surface presents: the server's `modelIndependence` (fail closed: anything but
 * "independent" / "insufficient" is "unverified"), confirmed by the shared gate over the rows the payload holds. A
 * payload the server marks "independent" whose rows do not themselves verify ≥ 2 independent executing models (a payload
 * cached before the rows carried their recorded provider) is presented "unverified" — never with a count it cannot
 * state. Never upgrades the server's value.
 */
export function claimPresentedIndependence(serverValue: unknown, rows: readonly unknown[] | null | undefined): StoredConsensusIndependence {
  if (serverValue !== "independent") return serverValue === "insufficient" ? "insufficient" : "unverified";
  const identity = claimRowsExecutionIdentity(rows);
  if (!identity.verified || identity.independentModels === null) return "unverified";
  return identity.independentModels >= MIN_INDEPENDENT_SYNTHESIS_MODELS ? "independent" : "insufficient";
}

/**
 * C-b (PQ-2 (a) STRICT): the independence of a STORED video verification, by the shared gate. Video rows record
 * `modelId` and `status` and no provider (lib/video/videoVerificationExecution.ts `VisionModelRow`), so the gate never
 * verifies them and every video surface reads "unverified". No video-family rule exists: `modelId` + `status` is not
 * recorded executing identity. Video `parse_error` is a call with no usable verdict ("failed"); every other status is
 * passed as recorded (an unknown one fails the gate closed).
 */
export function storedVideoConsensusIndependence(modelResults: unknown): StoredConsensusIndependence {
  const rows = Array.isArray(modelResults)
    ? modelResults.map((raw): IdentityRow => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const r = raw as Record<string, unknown>;
        return { modelId: r.modelId, status: r.status === "parse_error" ? "failed" : r.status, ...(r.provider !== undefined ? { provider: r.provider } : {}) };
      })
    : [];
  const identity = runExecutionIdentity(rows);
  if (!identity.verified || identity.independentModels === null) return "unverified";
  return identity.independentModels >= MIN_INDEPENDENT_SYNTHESIS_MODELS ? "independent" : "insufficient";
}
