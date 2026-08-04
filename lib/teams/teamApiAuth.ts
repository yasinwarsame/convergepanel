/**
 * Teams API helpers: auth context, policy validation, and membership rules.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import type { UserProfile } from "@/lib/types";
import type { TeamDocument, TeamMemberRole } from "@/lib/governance/teamTypes";
import { DEFAULT_POLICIES } from "@/lib/governance/policyEngine";
import { parseAdaptiveReviewSettings, parseAdaptiveMultiReviewerSettings } from "@/lib/governance/adaptiveTeamReview";
import type { DocumentData } from "firebase-admin/firestore";

/**
 * Auth Identity Consistency Remediation, Step 7 — now a thin wrapper
 * around the shared `resolveRequestIdentity()` (`lib/auth/`), which is
 * itself the generalized form of the fix Step 6 applied here directly
 * (see git history for that version's full root-cause comment, preserved
 * in `docs/operations/auth-session-sync-runbook.md`). Behavior is
 * byte-identical to the pre-Step-7 version of this function for every
 * existing caller: `missing_credentials` maps to "Please sign in.", every
 * other unauthenticated reason (invalid/expired/revoked cookie or bearer,
 * or a confirmed cookie/bearer uid mismatch) maps to "Authentication
 * failed." — the exact two messages this function has always returned.
 */
export async function getRequestUid(req: NextRequest): Promise<string | NextResponse> {
  const result = await resolveRequestIdentity(req);
  if (result.status === "authenticated") return result.uid;

  logIdentityResolutionFailure({ route: "teamApiAuth.getRequestUid", failureCategory: result.reason });
  const message = result.reason === "missing_credentials" ? "Please sign in." : "Authentication failed.";
  return NextResponse.json(
    { ok: false, error: { code: "unauthorized", message } },
    { status: 401 }
  );
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
    // Query-Routing Redesign, Phase 2A, Step 7, Part C — additive only.
    // parseAdaptiveReviewSettings fails closed to fully disabled on
    // anything absent or malformed; existing teams and every existing
    // caller of this function are entirely unaffected (this field is
    // simply never read by legacy code).
    adaptiveReviewSettings: parseAdaptiveReviewSettings(data.adaptiveReviewSettings),
    // Multi-Reviewer Panel Foundation, Part B — additive only. Absent for
    // every existing team; parseAdaptiveMultiReviewerSettings fails closed
    // to fully disabled on anything absent or malformed, so no existing
    // caller of parseTeamDoc is affected.
    adaptiveMultiReviewerSettings: parseAdaptiveMultiReviewerSettings(data.adaptiveMultiReviewerSettings),
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
