/**
 * Adaptive Research Export, Phase 2 — GET /api/user/runs/[runId]/exports.
 * Lists every export record for a run, newest `reportVersion` first,
 * metadata only (Part 3 — never the full frozen `reportSnapshot`; that only
 * ever leaves the server as a rendered PDF, via the regeneration route).
 *
 * Flow: authenticate → load run → authorize access to run → check
 * ADAPTIVE_RESEARCH_EXPORT_ENABLED → list export records → project to
 * metadata-only DTOs → return, newest first.
 *
 * Deliberately does NOT re-run `canExportAdaptiveResearch()` here — this
 * endpoint is a read of the run owner's own export history, gated on run
 * ownership + the feature flag, same as `GET /api/user/runs/[runId]`
 * itself. Per-item export/regeneration authorization (plan, governance
 * state) is evaluated by the regeneration route when an item is actually
 * opened, not here — this list is metadata, not report content.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { ADAPTIVE_RESEARCH_EXPORT_ENABLED } from "@/lib/env";
import { listAdaptiveExportRecords } from "@/lib/firestore/adaptiveExports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/runs/[runId]/exports", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function errorResponse(status: number, errorCode: string, message: string) {
  return NextResponse.json({ ok: false, errorCode, message }, { status });
}

export interface AdaptiveExportListItem {
  exportId: string;
  reportVersion: number;
  schemaId: string;
  schemaFamily: "milestone2" | "legacy";
  format: string;
  artifactStatus: string;
  createdAt: string;
  createdBy: string;
  governanceStatusAtExport: unknown;
  classification: string;
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!ADAPTIVE_RESEARCH_EXPORT_ENABLED) {
    return errorResponse(404, "not_found", "Not found.");
  }

  const { runId } = await context.params;
  if (!runId?.trim() || !adminDb) {
    return errorResponse(404, "not_found", "Run not found.");
  }

  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");
  if (owner !== uid) {
    return errorResponse(403, "forbidden", "You do not have access to this run.");
  }

  const listResult = await listAdaptiveExportRecords(runId);
  if (!listResult.ok) {
    return errorResponse(500, "list_failed", "Could not load export history. Please try again.");
  }

  const items: AdaptiveExportListItem[] = listResult.records.map((r) => ({
    exportId: r.exportId,
    reportVersion: r.reportVersion,
    schemaId: r.schemaId,
    schemaFamily: r.schemaFamily,
    format: r.format,
    artifactStatus: r.artifactStatus,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    governanceStatusAtExport: r.governanceStatusAtExport,
    classification: r.classification,
  }));

  return NextResponse.json({ ok: true, runId, exports: items });
}
