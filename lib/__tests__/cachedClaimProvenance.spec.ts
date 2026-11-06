/**
 * Review of 0ca72b0, MINOR m1 / owner order B1 — a claim payload cached in Personal history BEFORE `modelIndependence`
 * existed must not contradict the authoritative persisted record:
 *  - the server history row for the same id (computed from the persisted rows) reconciles the cached payload;
 *  - opening a cached payload that still records nothing reads the user's own record (authenticated detail API);
 *  - when the record cannot be read the payload stays UNVERIFIED — nothing is inferred from requested / cached slots;
 *  - a payload that already records independence is never changed and never re-read.
 * The real presentation helpers (claimConsensusPresentation.ts) judge every outcome. app/page.tsx cannot be mounted
 * under ts-jest here (see app/__tests__/personalResearchHistoryLoadRace.spec.tsx), so its wiring is asserted on source.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  claimPayloadRecordsIndependence,
  reconcileCachedClaimPayload,
  resolveClaimHistoryPayload,
} from "@/lib/verification/cachedClaimProvenance";
import {
  CLAIM_COVERAGE_UNVERIFIED_TEXT,
  CLAIM_SINGLE_MODEL_ASSESSMENT_TEXT,
  CONSENSUS_WITHHELD_TEXT,
  claimConsensusDisplay,
  claimHistoryConsensusSuffix,
  claimVerdictQualifier,
} from "@/lib/verification/claimConsensusPresentation";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";

const ev = (modelId: string, verdict = "accurate") => ({
  modelId,
  status: "ok",
  verdict,
  confidence: "high",
  summary: `${modelId} summary`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
});

/** A payload as cached before this deploy: ChatGPT + Claude answered, but no `modelIndependence` field. */
function legacyCached(): ClaimVerificationClientPayload {
  return {
    claim: "Water boils at 100 C at sea level.",
    verdict: "confirmed",
    consensusScore: 92,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    modelEvidence: [ev("chatgpt"), ev("claude")],
  } as unknown as ClaimVerificationClientPayload;
}

/** The persisted record the authenticated detail API maps (same function the history route uses). */
function storedRecord(modelResults: Record<string, unknown>[]) {
  return {
    userId: "uid-1",
    claim: "Water boils at 100 C at sea level.",
    verdict: "confirmed",
    consensusScore: 92,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    modelResults,
  } as any;
}
const okRow = (modelId: string, extra: Record<string, unknown> = {}) => ({ ...ev(modelId), ...extra });

const presented = (p: ClaimVerificationClientPayload | null | undefined) => ({
  consensus: claimConsensusDisplay(p?.consensusScore, p?.modelIndependence),
  qualifier: claimVerdictQualifier(p?.modelIndependence),
});

describe("B1: cached claim with missing inline provenance but valid authoritative run provenance", () => {
  it("control: the cached payload alone presents as unverified (the 0ca72b0 contradiction)", () => {
    expect(presented(legacyCached())).toEqual({
      consensus: { kind: "withheld", reason: "independence_unverified", text: CONSENSUS_WITHHELD_TEXT.independence_unverified },
      qualifier: CLAIM_COVERAGE_UNVERIFIED_TEXT,
    });
    // ... while the server history row for the same record says " · 92 consensus".
    expect(claimHistoryConsensusSuffix({ consensusScore: 92, modelIndependence: "independent" })).toBe(" · 92 consensus");
  });

  it("history merge: the server row's 'independent' reconciles the cached payload — score kept, no qualifier", () => {
    const merged = reconcileCachedClaimPayload(legacyCached(), "independent");
    expect(merged?.modelIndependence).toBe("independent");
    expect(presented(merged)).toEqual({ consensus: { kind: "score", score: 92 }, qualifier: null });
    // Line and detail now agree.
    expect(claimHistoryConsensusSuffix({ consensusScore: 92, modelIndependence: merged?.modelIndependence })).toBe(" · 92 consensus");
    // Stored fields are untouched.
    expect({ ...merged, modelIndependence: undefined }).toEqual({ ...legacyCached(), modelIndependence: undefined });
  });

  it("opening it: the user's own persisted record (detail API mapping) is read and presented — score kept", async () => {
    const record = mapStoredVerificationToClientPayload(storedRecord([okRow("chatgpt"), okRow("claude")]), "ver-1");
    const lookup = jest.fn(async () => record);
    const r = await resolveClaimHistoryPayload("ver-1", legacyCached(), lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(r.fromRecord).toBe(true);
    expect(r.payload?.modelIndependence).toBe("independent");
    expect(presented(r.payload)).toEqual({ consensus: { kind: "score", score: 92 }, qualifier: null });
  });
});

describe("B1: multiple slots executed by one fallback model (authoritative record)", () => {
  it("server row 'insufficient' reconciles to no consensus score and the one-model qualifier", () => {
    const merged = reconcileCachedClaimPayload(legacyCached(), "insufficient");
    expect(presented(merged)).toEqual({
      consensus: { kind: "withheld", reason: "insufficient_independent_models", text: CONSENSUS_WITHHELD_TEXT.insufficient_independent_models },
      qualifier: CLAIM_SINGLE_MODEL_ASSESSMENT_TEXT,
    });
  });

  it("opening it: the record (ChatGPT + Claude both answered by DeepSeek) is 'insufficient', never 'independent'", async () => {
    const ds = { substituted: true, provider: "deepseek" };
    const record = mapStoredVerificationToClientPayload(storedRecord([okRow("chatgpt", ds), okRow("claude", ds)]), "ver-2");
    const r = await resolveClaimHistoryPayload("ver-2", legacyCached(), async () => record);
    expect(r.payload?.modelIndependence).toBe("insufficient");
    expect(presented(r.payload).consensus.kind).toBe("withheld");
  });
});

describe("B1: cached claim whose source record is unavailable stays UNVERIFIED", () => {
  const unverified = {
    consensus: { kind: "withheld", reason: "independence_unverified", text: CONSENSUS_WITHHELD_TEXT.independence_unverified },
    qualifier: CLAIM_COVERAGE_UNVERIFIED_TEXT,
  };

  it("record read returns nothing (404 / not ok) → the cached payload, unverified (not inferred from its two slots)", async () => {
    const r = await resolveClaimHistoryPayload("ver-3", legacyCached(), async () => null);
    expect(r.fromRecord).toBe(false);
    expect(r.payload?.verificationId).toBe("ver-3");
    expect(r.payload?.modelEvidence.map((m) => m.modelId)).toEqual(["chatgpt", "claude"]);
    expect(presented(r.payload)).toEqual(unverified);
  });

  it("record read throws → unverified", async () => {
    const r = await resolveClaimHistoryPayload("ver-3", legacyCached(), async () => {
      throw new Error("network");
    });
    expect(presented(r.payload)).toEqual(unverified);
  });

  it("signed out (no authorized lookup) → unverified", async () => {
    const r = await resolveClaimHistoryPayload("ver-3", legacyCached(), null);
    expect(presented(r.payload)).toEqual(unverified);
  });

  it("server row without a definite independence ('unverified' / absent / junk) leaves the cached payload unrecorded", () => {
    for (const s of ["unverified", undefined, null, "INDEPENDENT", 1]) {
      const merged = reconcileCachedClaimPayload(legacyCached(), s);
      expect(merged?.modelIndependence).toBeUndefined();
      expect(claimPayloadRecordsIndependence(merged)).toBe(false);
      expect(presented(merged)).toEqual(unverified);
    }
  });
});

describe("B1: payloads that record independence are unchanged (fresh results, two genuinely independent models)", () => {
  it("never overwritten by a server row and never re-read", async () => {
    for (const own of ["independent", "insufficient", "unverified"] as const) {
      const p = { ...legacyCached(), modelIndependence: own, verificationId: "v" };
      for (const s of ["independent", "insufficient", "unverified", undefined]) {
        expect(reconcileCachedClaimPayload(p, s)).toBe(p);
      }
      const lookup = jest.fn(async () => null);
      const r = await resolveClaimHistoryPayload("v", p, lookup);
      expect(lookup).not.toHaveBeenCalled();
      expect(r).toEqual({ payload: p, fromRecord: false });
    }
  });

  it("no cached payload: the record is read; nothing read → null (as before)", async () => {
    expect(reconcileCachedClaimPayload(undefined, "independent")).toBeUndefined();
    expect(await resolveClaimHistoryPayload("v", undefined, async () => null)).toEqual({ payload: null, fromRecord: false });
    expect(await resolveClaimHistoryPayload("v", null, null)).toEqual({ payload: null, fromRecord: false });
  });
});

describe("B1 wiring (app/page.tsx)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "app", "page.tsx"), "utf8");
  const merge = src.slice(src.indexOf("function mergeHistoryById("), src.indexOf("type HistoryItem ="));
  const open = src.slice(src.indexOf("const openHistoryItem = async"), src.indexOf("openHistoryItemRef.current = openHistoryItem;"));

  it("mergeHistoryById reconciles the kept claim payload with the server row's independence", () => {
    expect(merge).toContain("reconcileCachedClaimPayload(it.payload ?? prev.payload, it.modelIndependence)");
    expect(merge).not.toMatch(/const payload = it\.payload \?\? prev\.payload;/);
  });

  it("openHistoryItem uses a cached payload directly only when it records independence; otherwise reads the record", () => {
    expect(open).toContain("if (item.payload && claimPayloadRecordsIndependence(item.payload)) {");
    expect(open).not.toMatch(/if \(item\.payload\) \{/);
    expect(open).toContain("resolveClaimHistoryPayload(item.id, cachedPayload, lookup)");
    expect(open).toContain("`/api/user/verifications/${encodeURIComponent(item.id)}`");
    expect(open).toContain("setVerificationPayload(resolved.payload);");
    // The refreshed history row carries the record's independence, so the line and the detail agree.
    expect(open).toContain("modelIndependence: claimModelIndependence(record.modelIndependence),");
  });
});
