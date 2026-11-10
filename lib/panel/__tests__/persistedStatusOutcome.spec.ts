/**
 * Order 30 A3 / n-1 — the ONE shared exact-match status map, read by the export freeze and by the UI's shared gate.
 * Pinned literally (never iterated from the subject's own map).
 */
import { PERSISTED_STATUS_OUTCOMES, isRecordedAnswerStatus, isRecordedFailureStatus, recordedSlotOutcome } from "@/lib/panel/persistedStatusOutcome";
import { PERSISTED_STATUS_OUTCOMES as EXPORT_MAP, persistedStatusOutcome } from "@/lib/adaptiveSchema/exportRunProvenance";
import { executionIdentityVerified, identityRowFromFacts, identityRowRecordedFailure, identityRowStatusUnknown, runExecutionIdentity } from "@/lib/panel/executionIdentity";
import { runModelProvenanceFromResultRow } from "@/lib/panel/runModelIdentity";

const EXPECTED: Record<string, string> = { ok: "answered", substituted: "answered", failed: "failed", error: "failed", timeout: "timeout", refused: "refused", rate_limited: "rate_limited" };
const CRAFTED: unknown[] = ["OK ", "Ok", "", "answered", "unknown", "TIMEOUT", "Substituted", " ok", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", 1, null, undefined, {}, ["ok"]];
const PROTOTYPE_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty"];
const okRow = (modelId: string, provider: string) => ({ modelId, status: "ok", provider, rawTextTruncated: "Paris." });

describe("Order 30 A3: one shared exact-match status map", () => {
  it("is exactly the real ConnectorStatus values and is the very object the export freeze uses", () => {
    expect({ ...PERSISTED_STATUS_OUTCOMES }).toEqual(EXPECTED);
    expect(EXPORT_MAP).toBe(PERSISTED_STATUS_OUTCOMES);
    expect(Object.isFrozen(PERSISTED_STATUS_OUTCOMES)).toBe(true);
  });
  it.each(Object.entries(EXPECTED))("%s → %s (answer / failure predicates agree)", (status, outcome) => {
    expect(recordedSlotOutcome(status)).toBe(outcome);
    expect(isRecordedAnswerStatus(status)).toBe(outcome === "answered");
    expect(isRecordedFailureStatus(status)).toBe(outcome !== "answered");
    expect(identityRowRecordedFailure({ modelId: "a", status })).toBe(outcome !== "answered");
    expect(identityRowStatusUnknown({ modelId: "a", status })).toBe(false);
  });
  it.each(CRAFTED.map((s) => [s]))("crafted status %p → unknown: never a known answer, never a known failure", (status) => {
    expect(recordedSlotOutcome(status)).toBeNull();
    expect(isRecordedAnswerStatus(status)).toBe(false);
    expect(isRecordedFailureStatus(status)).toBe(false);
    expect(identityRowRecordedFailure({ modelId: "a", status })).toBe(false);
    expect(identityRowStatusUnknown({ modelId: "a", status })).toBe(true);
  });
  it.each(PROTOTYPE_KEYS.map((k) => [k]))("n-1: prototype key %p freezes as unknown / absent in the export (own-property lookup only)", (status) => {
    expect(persistedStatusOutcome(status)).toEqual({ outcome: "unknown", outcomeSource: "absent" });
    expect(typeof persistedStatusOutcome(status).outcome).toBe("string");
  });
  it.each(["OK ", "Ok", "", "toString", "__proto__", "constructor", "hasOwnProperty"])("UI path: a result row with status %p fails the shared gate closed (unverified), never read as a failure", (status) => {
    const rows = [okRow("chatgpt", "openai"), { modelId: "claude", status, provider: "anthropic", rawTextTruncated: "Paris." }];
    expect(executionIdentityVerified(rows)).toBe(false);
    // the crafted row is never counted as an answered slot either
    expect(runExecutionIdentity(rows)).toMatchObject({ kind: "UV", verified: false, independentModels: null, answeredSlots: 1 });
    const facts = rows.map((r) => identityRowFromFacts(runModelProvenanceFromResultRow(r)));
    expect(executionIdentityVerified(facts)).toBe(false);
    // control: the same run with a recorded failure is verified over its one answer
    expect(executionIdentityVerified([okRow("chatgpt", "openai"), { modelId: "claude", status: "timeout", rawTextTruncated: "" }])).toBe(true);
  });
});
