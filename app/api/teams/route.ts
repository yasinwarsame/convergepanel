/**
 * HTTP API route (teams): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { planHasTeamGovernance } from "@/lib/plans";
import type { UserProfile } from "@/lib/types";
import { DEFAULT_POLICIES } from "@/lib/governance/policyEngine";
import {
  getRequestUid,
  loadUserAndTeam,
  memberRole,
  parseTeamDoc,
} from "@/lib/teams/teamApiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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
  if (!ctx?.user?.teamId || !ctx.team) {
    return NextResponse.json({ ok: true, team: null, role: null });
  }

  const role = memberRole(uid, ctx.team);
  return NextResponse.json({
    ok: true,
    team: {
      id: ctx.team.id,
      name: ctx.team.name,
      memberCount: ctx.team.members.length,
      settings: ctx.team.settings,
    },
    role,
  });
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

  const ent = await getEffectiveEntitlements(uid);
  if (!planHasTeamGovernance(ent.planId)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "plan_required",
          message: "Team governance is available on the Full plan.",
        },
      },
      { status: 403 }
    );
  }

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "Invalid JSON." } },
      { status: 400 }
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json(
      { ok: false, error: { code: "validation_error", message: "Team name is required (max 120 chars)." } },
      { status: 400 }
    );
  }

  const userRef = adminDb.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.data() as UserProfile | undefined;
  if (userData?.teamId) {
    return NextResponse.json(
      { ok: false, error: { code: "already_in_team", message: "You already belong to a team." } },
      { status: 409 }
    );
  }

  const email = String(userData?.email ?? "").trim();
  if (!email) {
    return NextResponse.json(
      { ok: false, error: { code: "no_email", message: "Your profile must include an email." } },
      { status: 400 }
    );
  }

  const teamId = `team_${uid.slice(0, 8)}_${Date.now()}`;

  // TODO: move members to subcollection for teams > 100 (Firestore 1MB doc limit)
  await adminDb
    .collection("teams")
    .doc(teamId)
    .set({
      id: teamId,
      name,
      createdBy: uid,
      createdAt: Timestamp.now(),
      members: [
        {
          uid,
          email,
          role: "owner",
          joinedAt: new Date().toISOString(),
        },
      ],
      policyRules: DEFAULT_POLICIES,
      settings: {
        minimumConsensusForAction: 60,
        flagThreshold: 50,
      },
    });

  await userRef.set(
    {
      teamId,
      teamRole: "owner",
    },
    { merge: true }
  );

  const teamSnap = await adminDb.collection("teams").doc(teamId).get();
  const team = parseTeamDoc(teamId, teamSnap.data()!);

  return NextResponse.json({
    ok: true,
    team: {
      id: team.id,
      name: team.name,
      memberCount: team.members.length,
      settings: team.settings,
    },
    role: "owner" as const,
  });
}
