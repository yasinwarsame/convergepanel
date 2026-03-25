/**
 * HTTP API route (user/runs/[runId]): returns a single panel run for the signed-in owner,
 * including rehydrated model rows and optional cached structured synthesis fields.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import type { RunDocument } from "@/lib/panel/schemas";
import type { ModelId } from "@/lib/types";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import { publicizePanelResults } from "@/lib/panel/publicize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  try {
    const auth = await verifySessionCookie(req);
    if (auth) return auth.uid;
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { ok: false, errorCode: "unauthorized", message: "Please sign in." },
        { status: 401 }
      );
    }
    const token = authHeader.split("Bearer ")[1];
    const decoded = await verifyIdToken(token);
    return decoded.uid;
  } catch (e: unknown) {
    logger.error("[user/runs/id] auth failed", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, errorCode: "auth_error", message: "Authentication failed." },
      { status: 401 }
    );
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { runId } = await context.params;
  if (!runId?.trim() || !adminDb) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }

  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }

  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");
  if (owner !== uid) {
    return NextResponse.json(
      { ok: false, errorCode: "forbidden", message: "You do not have access to this run." },
      { status: 403 }
    );
  }

  const runDocument = data.runDocument as RunDocument | undefined;
  let results = runDocumentToPublicResults(runDocument);
  if (results.length === 0 && Array.isArray(data.results)) {
    results = publicizePanelResults(data.results as unknown[]) as unknown as typeof results;
  }

  const question = String(data.question ?? "");
  const selectedModels = (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[];
  const status = typeof data.status === "string" ? data.status : undefined;

  const synthesisCache =
    data.synthesizedStructuredReport && data.schemaVersion === 1
      ? {
          report: data.synthesizedStructuredReport,
          schemaVersion: 1 as const,
          synthesizedBy: (data.synthesizedBy as string) || "cached",
          consensusSummary: data.synthesisConsensusSummary ?? null,
        }
      : null;

  const rawGovStatus = data.governanceStatus;
  const orgGovernanceStatus =
    rawGovStatus === "approved" || rawGovStatus === "needs_review" || rawGovStatus === "blocked"
      ? rawGovStatus
      : null;

  const g = data.teamGovernance as
    | {
        policyFlags?: string[];
        blocked?: boolean;
        blockMessage?: string;
        governanceReviewRequired?: boolean;
      }
    | undefined;

  const governance =
    g &&
    (g.policyFlags?.length ||
      g.blocked ||
      g.governanceReviewRequired ||
      (g.blockMessage && String(g.blockMessage).length > 0))
      ? {
          governanceReviewRequired: !!g.governanceReviewRequired,
          blockedByPolicy: !!g.blocked,
          policyBlockMessage: g.blockMessage ? String(g.blockMessage) : undefined,
          policyFlags: Array.isArray(g.policyFlags) ? g.policyFlags : undefined,
        }
      : null;

  return NextResponse.json({
    ok: true,
    runId,
    question,
    selectedModels,
    status,
    results,
    synthesisCache,
    governance,
    governanceStatus: orgGovernanceStatus,
  });
}
