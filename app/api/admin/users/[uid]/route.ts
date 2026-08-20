/**
 * Admin User Management Endpoint (Individual User)
 *
 * Allows admins to manage individual users:
 * - Disable/enable user accounts
 * - Delete user accounts
 *
 * Security:
 * - Only admins can access (verified via requireAdmin())
 * - Updates both Firebase Auth and Firestore for consistency
 *
 * Routes:
 * - PATCH /api/admin/users/[uid] - Disable/enable user
 * - DELETE /api/admin/users/[uid] - Delete user
 *
 * Team Workspace Core Foundation, Phase 8B, corrected in Phase 8B.1 —
 * narrowly added Team-owner protection: permanently deleting, or
 * disabling (isDisabled: true), a uid that currently owns a `type: "team"`
 * Workspace is blocked with 409 until ownership is transferred first (see
 * `checkTeamWorkspaceOwnershipForUid()`, `lib/workspaces/teamOwnerGuard.ts`).
 * Re-enabling (isDisabled: false) is NOT blocked — only DELETE and the
 * disable direction of PATCH consult this guard. Users who own no Team
 * Workspace (including Personal-Workspace-only owners) are completely
 * unaffected; behavior for them is byte-identical to before this change.
 * This guard never transfers ownership, never picks a replacement Owner,
 * and never cascades any Team resource deletion — it only blocks the
 * destructive/disabling action outright.
 *
 * Phase 8B.1 correction: the ownership check now FAILS CLOSED. A failed
 * Firestore lookup means ownership status is UNKNOWN, never "clear" — an
 * account-management action must never proceed on an unknown ownership
 * state, since a transient Firestore failure could otherwise delete/
 * disable a Team Workspace's sole Owner and leave it administratively
 * ownerless, exactly the condition this guard exists to prevent. A
 * lookup failure returns a controlled 503
 * (`team_workspace_ownership_check_failed`) and performs zero mutation —
 * `adminAuth.deleteUser()`/`adminAuth.updateUser(...disabled:true)` and
 * the corresponding `users/{uid}` Firestore mutation are never reached.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { checkTeamWorkspaceOwnershipForUid } from "@/lib/workspaces/teamOwnerGuard";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

/**
 * PATCH - Update user (disable/enable)
 * 
 * Allows admins to disable or enable a user account.
 * Disabled users cannot sign in (enforced by Firebase Auth).
 * 
 * @param request - Next.js request object with isDisabled boolean in body
 * @param params - Route parameters containing user UID
 * @returns Success response
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { uid: string } }
) {
  // Verify admin authentication
  const auth = await requireAdmin(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { uid } = params;
    const body = await request.json();
    const { isDisabled } = body;

    // Validate isDisabled is a boolean
    if (typeof isDisabled !== "boolean") {
      return NextResponse.json(
        { error: "isDisabled must be a boolean" },
        { status: 400 }
      );
    }

    // Verify Firebase Admin services are available
    if (!adminAuth || !adminDb) {
      console.error("[admin/users/[uid]] Firebase Admin services are not available");
      return NextResponse.json(
        { error: "Firebase Admin services are not available" },
        { status: 500 }
      );
    }

    // Team Workspace Core Foundation, Phase 8B.1 — only the DISABLE
    // direction is guarded. Re-enabling (isDisabled: false) never
    // consults Team ownership at all: nothing about re-enabling an
    // account is unsafe for a Team Workspace it owns.
    //
    // FAILS CLOSED: a lookup failure ("lookup_failed") is UNKNOWN
    // ownership status, never treated as "clear." Proceeding on an
    // unknown ownership state could delete/disable a Team Workspace's
    // sole Owner, leaving it administratively ownerless — exactly what
    // this guard exists to prevent.
    if (isDisabled) {
      const ownership = await checkTeamWorkspaceOwnershipForUid(uid);
      if (ownership.kind === "owns_team_workspace") {
        return NextResponse.json(
          { error: "This user owns one or more Team Workspaces. Transfer ownership before disabling this account.", errorCode: "team_workspace_owner" },
          { status: 409 }
        );
      }
      if (ownership.kind === "lookup_failed") {
        return NextResponse.json(
          { error: "Unable to verify Team Workspace ownership right now. Please try again.", errorCode: "team_workspace_ownership_check_failed" },
          { status: 503 }
        );
      }
    }

    /**
     * Update Firebase Auth user
     *
     * Setting disabled: true prevents the user from signing in.
     * This is enforced by Firebase Auth at the authentication level.
     */
    await adminAuth.updateUser(uid, {
      disabled: isDisabled,
    });

    /**
     * Update Firestore document
     * 
     * Also update the isDisabled flag in Firestore for consistency
     * and for querying disabled users.
     */
    await adminDb.collection("users").doc(uid).set(
      {
        isDisabled,
      },
      { merge: true } // Don't overwrite other fields
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Error updating user:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Delete user
 * 
 * Permanently deletes a user account from both Firebase Auth and Firestore.
 * This action cannot be undone.
 * 
 * WARNING: This is a destructive operation. Consider disabling users
 * instead of deleting them unless absolutely necessary.
 * 
 * @param request - Next.js request object
 * @param params - Route parameters containing user UID
 * @returns Success response
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { uid: string } }
) {
  // Verify admin authentication
  const auth = await requireAdmin(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { uid } = params;

    // Verify Firebase Admin services are available
    if (!adminAuth || !adminDb) {
      console.error("[admin/users/[uid]] Firebase Admin services are not available");
      return NextResponse.json(
        { error: "Firebase Admin services are not available" },
        { status: 500 }
      );
    }

    // Team Workspace Core Foundation, Phase 8B.1 — block permanent
    // deletion of a Team Workspace Owner outright; see this route's own
    // top-level doc comment for the full rationale. FAILS CLOSED: a
    // lookup failure is UNKNOWN ownership status, never "clear" — see
    // the PATCH handler's identical comment above.
    const ownership = await checkTeamWorkspaceOwnershipForUid(uid);
    if (ownership.kind === "owns_team_workspace") {
      return NextResponse.json(
        { error: "This user owns one or more Team Workspaces. Transfer ownership before deleting this account.", errorCode: "team_workspace_owner" },
        { status: 409 }
      );
    }
    if (ownership.kind === "lookup_failed") {
      return NextResponse.json(
        { error: "Unable to verify Team Workspace ownership right now. Please try again.", errorCode: "team_workspace_ownership_check_failed" },
        { status: 503 }
      );
    }

    /**
     * Delete from Firebase Auth
     *
     * This removes the user from Firebase Authentication.
     * They will no longer be able to sign in.
     */
    await adminAuth.deleteUser(uid);

    /**
     * Delete from Firestore
     * 
     * Also remove the user document from Firestore.
     * This ensures complete removal of user data.
     */
    await adminDb.collection("users").doc(uid).delete();

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

