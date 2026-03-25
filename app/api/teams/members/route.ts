/**
 * HTTP API route (teams/members): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import type { UserProfile } from "@/lib/types";
import {
  getRequestUid,
  loadUserAndTeam,
  memberRole,
  isTeamAdmin,
} from "@/lib/teams/teamApiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normEmail(e: string) {
  return e.trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

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

  let body: { email?: string; role?: "admin" | "member" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "Invalid JSON." } },
      { status: 400 }
    );
  }

  const email = typeof body.email === "string" ? normEmail(body.email) : "";
  const newRole = body.role === "admin" ? "admin" : "member";
  if (!email || !email.includes("@")) {
    return NextResponse.json(
      { ok: false, error: { code: "validation_error", message: "Valid email required." } },
      { status: 400 }
    );
  }

  const q = await adminDb.collection("users").where("email", "==", email).limit(5).get();
  if (q.empty) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "user_not_found",
          message: "User must have a ConvergePanel account first.",
        },
      },
      { status: 404 }
    );
  }

  const targetDoc = q.docs[0];
  const targetUid = targetDoc.id;
  const targetData = targetDoc.data() as UserProfile;

  if (targetData.teamId && targetData.teamId !== ctx.team.id) {
    return NextResponse.json(
      { ok: false, error: { code: "user_in_other_team", message: "User already belongs to another team." } },
      { status: 409 }
    );
  }

  if (ctx.team.members.some((m) => m.uid === targetUid)) {
    return NextResponse.json(
      { ok: false, error: { code: "already_member", message: "User is already on this team." } },
      { status: 409 }
    );
  }

  const memberEntry = {
    uid: targetUid,
    email: targetData.email || email,
    role: newRole,
    joinedAt: new Date().toISOString(),
  };

  const members = [...ctx.team.members, memberEntry];
  await adminDb.collection("teams").doc(ctx.team.id).update({ members });

  await adminDb.collection("users").doc(targetUid).set(
    {
      teamId: ctx.team.id,
      teamRole: newRole,
    },
    { merge: true }
  );

  return NextResponse.json({ ok: true, member: memberEntry });
}

export async function DELETE(req: NextRequest) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

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

  let body: { uid?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "Invalid JSON." } },
      { status: 400 }
    );
  }

  const removeUid = typeof body.uid === "string" ? body.uid : "";
  if (!removeUid) {
    return NextResponse.json(
      { ok: false, error: { code: "validation_error", message: "uid required." } },
      { status: 400 }
    );
  }

  const targetMember = ctx.team.members.find((m) => m.uid === removeUid);
  if (!targetMember) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Member not on team." } },
      { status: 404 }
    );
  }

  if (targetMember.role === "owner") {
    return NextResponse.json(
      { ok: false, error: { code: "cannot_remove_owner", message: "Owner cannot be removed." } },
      { status: 403 }
    );
  }

  const members = ctx.team.members.filter((m) => m.uid !== removeUid);
  await adminDb.collection("teams").doc(ctx.team.id).update({ members });

  await adminDb
    .collection("users")
    .doc(removeUid)
    .update({
      teamId: FieldValue.delete(),
      teamRole: FieldValue.delete(),
    });

  return NextResponse.json({ ok: true });
}
