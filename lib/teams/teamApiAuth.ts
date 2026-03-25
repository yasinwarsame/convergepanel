/**
 * Teams API helpers: auth context, policy validation, and membership rules.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { adminDb } from "@/lib/firebase/admin";
import type { UserProfile } from "@/lib/types";
import type { TeamDocument, TeamMemberRole } from "@/lib/governance/teamTypes";
import { DEFAULT_POLICIES } from "@/lib/governance/policyEngine";
import type { DocumentData } from "firebase-admin/firestore";

export async function getRequestUid(req: NextRequest): Promise<string | NextResponse> {
  try {
    const auth = await verifySessionCookie(req);
    if (auth) return auth.uid;
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { ok: false, error: { code: "unauthorized", message: "Please sign in." } },
        { status: 401 }
      );
    }
    const token = authHeader.split("Bearer ")[1];
    const decoded = await verifyIdToken(token);
    return decoded.uid;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Authentication failed." } },
      { status: 401 }
    );
  }
}

export function parseTeamDoc(id: string, data: DocumentData): TeamDocument {
  const settings = data.settings ?? {};
  return {
    id,
    name: String(data.name ?? ""),
    createdBy: String(data.createdBy ?? ""),
    createdAt: data.createdAt,
    members: Array.isArray(data.members) ? data.members : [],
    policyRules: Array.isArray(data.policyRules) ? data.policyRules : DEFAULT_POLICIES,
    settings: {
      minimumConsensusForAction: Number(settings.minimumConsensusForAction ?? 60),
      flagThreshold: Number(settings.flagThreshold ?? 50),
    },
  };
}

export function memberRole(uid: string, team: TeamDocument): TeamMemberRole | null {
  const m = team.members.find((x) => x.uid === uid);
  return m?.role ?? null;
}

export function isTeamAdmin(role: TeamMemberRole | null): boolean {
  return role === "owner" || role === "admin";
}

export async function loadUserAndTeam(uid: string): Promise<{
  user: UserProfile | null;
  team: TeamDocument | null;
} | null> {
  if (!adminDb) return null;
  const uSnap = await adminDb.collection("users").doc(uid).get();
  const user = (uSnap.data() as UserProfile) ?? null;
  const teamId = user?.teamId;
  if (!teamId) return { user, team: null };
  const tSnap = await adminDb.collection("teams").doc(teamId).get();
  if (!tSnap.exists) return { user, team: null };
  return { user, team: parseTeamDoc(teamId, tSnap.data()!) };
}
