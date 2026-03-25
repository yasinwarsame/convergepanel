/**
 * HTTP API route (teams/runs/[runId]/decision): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import {
  getRequestUid,
  loadUserAndTeam,
  memberRole,
  isTeamAdmin,
} from "@/lib/teams/teamApiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { runId: string } }
) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const runId = params.runId;
  if (!runId) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "runId required" } },
      { status: 400 }
    );
  }

  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable." } },
      { status: 500 }
    );
  }

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Team access required" } },
      { status: 403 }
    );
  }

  const role = memberRole(uid, ctx.team);
  if (!isTeamAdmin(role)) {
    return NextResponse.json(
      { ok: false, error: { code: "insufficient_role", message: "Admin access required" } },
      { status: 403 }
    );
  }

  let body: { action?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "Invalid JSON." } },
      { status: 400 }
    );
  }

  const action = body.action;
  if (!["approved", "rejected", "escalated"].includes(String(action))) {
    return NextResponse.json(
      { ok: false, error: { code: "validation_error", message: "Invalid action." } },
      { status: 400 }
    );
  }

  const ref = adminDb.collection("teamRuns").doc(runId);
  const doc = await ref.get();
  if (!doc.exists) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Run not found." } },
      { status: 404 }
    );
  }

  const data = doc.data()!;
  if (data.teamId !== ctx.team.id) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Team access required" } },
      { status: 403 }
    );
  }

  const humanDecision = {
    action: action as "approved" | "rejected" | "escalated",
    decidedBy: uid,
    decidedAt: new Date().toISOString(),
    notes: typeof body.notes === "string" ? body.notes.slice(0, 4000) : "",
  };

  await ref.update({ humanDecision });

  return NextResponse.json({ ok: true, humanDecision });
}
