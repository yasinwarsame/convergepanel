import type { MetadataAnalysis, MetadataFlag, VideoMetadata } from "@/lib/video/videoPure";
import type { PanelHistoryGovernanceStatus } from "@/lib/user/panelHistory";
import type { VideoModelEvidenceRow, VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";

function timestampToIso(ts: unknown): string | null {
  if (
    ts &&
    typeof ts === "object" &&
    "toDate" in ts &&
    typeof (ts as { toDate: () => Date }).toDate === "function"
  ) {
    try {
      return (ts as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (typeof ts === "string" && ts.trim()) return ts.trim();
  return null;
}

function asMetadata(raw: unknown): VideoMetadata {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    duration: typeof o.duration === "number" ? o.duration : 0,
    width: typeof o.width === "number" ? o.width : 0,
    height: typeof o.height === "number" ? o.height : 0,
    codec: typeof o.codec === "string" ? o.codec : "—",
    frameRate: typeof o.frameRate === "number" ? o.frameRate : 0,
    fileSize: typeof o.fileSize === "number" ? o.fileSize : 0,
    format: typeof o.format === "string" ? o.format : "—",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : null,
    encodingSoftware: typeof o.encodingSoftware === "string" ? o.encodingSoftware : null,
    hasAudio: o.hasAudio === true,
    cameraModel: typeof o.cameraModel === "string" ? o.cameraModel : null,
  };
}

function asMetadataAnalysis(raw: unknown): MetadataAnalysis {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flagsRaw = o.flags;
  const flags: MetadataFlag[] = Array.isArray(flagsRaw)
    ? flagsRaw
        .map((f) => {
          if (!f || typeof f !== "object") return null;
          const x = f as Record<string, unknown>;
          const field = typeof x.field === "string" ? x.field : "";
          const observation = typeof x.observation === "string" ? x.observation : "";
          const sev = x.severity;
          const severity =
            sev === "suspicious" || sev === "warning" || sev === "info" ? sev : "info";
          return { field, observation, severity };
        })
        .filter((x): x is MetadataFlag => x != null)
    : [];
  const summary = typeof o.summary === "string" ? o.summary : "";
  return { flags, summary };
}

function asModelRow(raw: unknown): VideoModelEvidenceRow | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    modelId: typeof m.modelId === "string" ? m.modelId : "unknown",
    modelName: typeof m.modelName === "string" ? m.modelName : typeof m.modelId === "string" ? m.modelId : "Model",
    status: typeof m.status === "string" ? m.status : "ok",
    verdict: typeof m.verdict === "string" ? m.verdict : "inconclusive",
    confidence: typeof m.confidence === "string" ? m.confidence : "low",
    contentType: typeof m.contentType === "string" ? m.contentType : undefined,
    summary: typeof m.summary === "string" ? m.summary : "",
    visualIndicators: asStrArr(m.visualIndicators),
    metadataIndicators: asStrArr(m.metadataIndicators),
    manipulationSignals: asStrArr(m.manipulationSignals),
    authenticitySignals: asStrArr(m.authenticitySignals),
    productionSignals: asStrArr(m.productionSignals),
    deceptionIndicators: asStrArr(m.deceptionIndicators),
    compressionNotes: asStrArr(m.compressionNotes),
    limitations: asStrArr(m.limitations),
  };
}

function normalizeGovernance(v: unknown): PanelHistoryGovernanceStatus | null {
  if (v === "approved" || v === "needs_review" || v === "blocked") return v;
  return null;
}

function coerceConfidence(v: unknown): "High" | "Medium" | "Low" {
  if (v === "High" || v === "Medium" || v === "Low") return v;
  return "Low";
}

function coerceEvidence(v: unknown): "strong" | "mixed" | "weak" {
  if (v === "strong" || v === "mixed" || v === "weak") return v;
  return "weak";
}

/**
 * Map a Firestore `videoVerifications` document to the client payload used by {@link VideoVerificationResult}.
 */
export function mapStoredVideoVerificationToClientPayload(
  docId: string,
  data: Record<string, unknown>
): VideoVerificationClientPayload {
  const modelSource = data.modelResults ?? data.modelEvidence;
  const rows: VideoModelEvidenceRow[] = Array.isArray(modelSource)
    ? (modelSource.map(asModelRow).filter(Boolean) as VideoModelEvidenceRow[])
    : [];

  const sr = data.supportRatio;
  const supportRatio =
    typeof sr === "number" && Number.isFinite(sr) ? Math.round(Math.min(100, Math.max(0, sr))) : 0;

  return {
    verificationId: docId,
    fileName: typeof data.fileName === "string" ? data.fileName : "Uploaded video",
    verdict: typeof data.verdict === "string" ? data.verdict : "inconclusive",
    contentType: typeof data.contentType === "string" ? data.contentType : undefined,
    consensusScore:
      typeof data.consensusScore === "number" && Number.isFinite(data.consensusScore)
        ? Math.round(data.consensusScore)
        : 0,
    confidenceLabel: coerceConfidence(data.confidenceLabel),
    evidenceQuality: coerceEvidence(data.evidenceQuality),
    supportRatio,
    metadata: asMetadata(data.metadata),
    metadataAnalysis: asMetadataAnalysis(data.metadataAnalysis),
    modelEvidence: rows,
    agreementPoints: Array.isArray(data.agreementPoints)
      ? data.agreementPoints.map((x) => String(x))
      : [],
    disagreementPoints: Array.isArray(data.disagreementPoints)
      ? data.disagreementPoints.map((x) => String(x))
      : [],
    frameCount: typeof data.frameCount === "number" ? data.frameCount : 0,
    warnings: Array.isArray(data.warnings) ? data.warnings.map((x) => String(x)) : [],
    governanceStatus: normalizeGovernance(data.governanceStatus),
    timestampIso: timestampToIso(data.timestamp),
  };
}
