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
 * Team Workspace Core Foundation, Phase 8B — narrowly added Team-owner
 * protection: permanently deleting, or disabling (isDisabled: true), a
 * uid that currently owns a `type: "team"` Workspace is blocked with 409
 * until ownership is transferred first (see `getTeamWorkspaceOwnershipForUid()`,
 * `lib/workspaces/teamOwnerGuard.ts`). Re-enabling (isDisabled: false) is
 * NOT blocked — only DELETE and the disable direction of PATCH consult
 * this guard. Users who own no Team Workspace (including Personal-Workspace-
 * only owners) are completely unaffected; behavior for them is byte-
 * identical to before this change. This guard never transfers ownership,
 * never picks a replacement Owner, and never cascades any Team resource
 * deletion — it only blocks the destructive/disabling action outright.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { getTeamWorkspaceOwnershipForUid } from "@/lib/workspaces/teamOwnerGuard";

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

    // Team Workspace Core Foundation, Phase 8B — only the DISABLE
    // direction is guarded. Re-enabling (isDisabled: false) never
    // consults Team ownership at all: nothing about re-enabling an
    // account is unsafe for a Team Workspace it owns.
    // A lookup failure (Firestore unreachable) deliberately does NOT
    // block the request — this guard only ever ADDS a block on a
    // positively-confirmed Team ownership; it never introduces a new way
    // for an admin operation that previously always succeeded to start
    // failing merely because ownership couldn't be determined this
    // instant. This mirrors the codebase's existing preference for
    // narrow, additive safety checks over broad fail-closed changes to
    // an already-shipped admin path.
    if (isDisabled) {
      const ownership = await getTeamWorkspaceOwnershipForUid(uid);
      if (ownership.status === "ok" && ownership.ownsTeamWorkspace) {
        return NextResponse.json(
          { error: "This user owns one or more Team Workspaces. Transfer ownership before disabling this account.", errorCode: "team_workspace_owner" },
          { status: 409 }
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

    // Team Workspace Core Foundation, Phase 8B — block permanent deletion
    // of a Team Workspace Owner outright; see this route's own top-level
    // doc comment for the full rationale, including why a lookup failure
    // deliberately does NOT block the request.
    const ownership = await getTeamWorkspaceOwnershipForUid(uid);
    if (ownership.status === "ok" && ownership.ownsTeamWorkspace) {
      return NextResponse.json(
        { error: "This user owns one or more Team Workspaces. Transfer ownership before deleting this account.", errorCode: "team_workspace_owner" },
        { status: 409 }
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

