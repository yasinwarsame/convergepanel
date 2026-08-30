/**
 * Team Workspace Self-Service Onboarding — client-safe typed contracts +
 * fetch helpers for the Workspace creation, member-list, and invitation
 * (create/list/resend/revoke) APIs. `authedFetch()` only — no raw
 * `fetch`, no direct Firestore access from the browser, matching every
 * other client fetcher in this codebase (see `workspaceListClient.ts`).
 *
 * Every parse function is a structural response guard, never a blind
 * cast of arbitrary JSON — mirrors `parseWorkspaceListResponse()`.
 */

"use client";

import type { User } from "firebase/auth";
import { authedFetch } from "./authedFetch";

// ── Workspace creation ──────────────────────────────────────────────────

export interface CreatedWorkspaceSummary {
  workspaceId: string;
  name: string;
}

function parseCreatedWorkspace(data: unknown): CreatedWorkspaceSummary | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return null;
  const workspace = d.workspace;
  if (typeof workspace !== "object" || workspace === null) return null;
  const w = workspace as Record<string, unknown>;
  if (typeof w.id !== "string" || w.id.length === 0) return null;
  if (typeof w.name !== "string") return null;
  return { workspaceId: w.id, name: w.name };
}

export type CreateWorkspaceResult = { status: "ok"; workspace: CreatedWorkspaceSummary } | { status: "invalid_name" } | { status: "error" };

export async function createTeamWorkspace(args: { user: User | null; authReady: boolean; name: string }): Promise<CreateWorkspaceResult> {
  try {
    const res = await authedFetch("/api/workspaces", {
      user: args.user,
      authReady: args.authReady,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: args.name }),
    });
    if (res.status === 400) return { status: "invalid_name" };
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    const workspace = parseCreatedWorkspace(json);
    if (!workspace) return { status: "error" };
    return { status: "ok", workspace };
  } catch {
    return { status: "error" };
  }
}

// ── Member list ──────────────────────────────────────────────────────────

export type WorkspaceMemberRole = "owner" | "admin" | "member" | "reviewer" | "viewer";

export interface WorkspaceMemberItem {
  uid: string;
  displayName: string;
  role: WorkspaceMemberRole;
  isCanonicalOwner: boolean;
  joinedAt: string;
}

const VALID_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "member", "reviewer", "viewer"]);

function isValidMember(value: unknown): value is WorkspaceMemberItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.uid === "string" &&
    v.uid.length > 0 &&
    typeof v.displayName === "string" &&
    typeof v.role === "string" &&
    VALID_ROLES.has(v.role) &&
    typeof v.isCanonicalOwner === "boolean" &&
    typeof v.joinedAt === "string"
  );
}

export type FetchWorkspaceMembersResult = { status: "ok"; members: WorkspaceMemberItem[] } | { status: "error" };

export async function fetchWorkspaceMembers(args: { user: User | null; authReady: boolean; workspaceId: string; signal?: AbortSignal }): Promise<FetchWorkspaceMembersResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/members`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    if (typeof json !== "object" || json === null) return { status: "error" };
    const d = json as Record<string, unknown>;
    if (d.ok !== true || !Array.isArray(d.members) || !d.members.every(isValidMember)) return { status: "error" };
    return { status: "ok", members: d.members as WorkspaceMemberItem[] };
  } catch {
    return { status: "error" };
  }
}

// ── Invitations ──────────────────────────────────────────────────────────

export type WorkspaceInvitationRole = "admin" | "member" | "reviewer" | "viewer";

export interface WorkspaceInvitationItem {
  id: string;
  normalizedEmail: string;
  role: WorkspaceInvitationRole;
  isExpired: boolean;
  expiresAt: string;
  deliveryVersion: number;
}

const VALID_INVITE_ROLES: ReadonlySet<string> = new Set(["admin", "member", "reviewer", "viewer"]);

function isValidInvitation(value: unknown): value is WorkspaceInvitationItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.normalizedEmail === "string" &&
    typeof v.role === "string" &&
    VALID_INVITE_ROLES.has(v.role) &&
    typeof v.isExpired === "boolean" &&
    typeof v.expiresAt === "string" &&
    typeof v.deliveryVersion === "number"
  );
}

export type FetchPendingInvitationsResult = { status: "ok"; invitations: WorkspaceInvitationItem[] } | { status: "error" };

export async function fetchPendingInvitations(args: { user: User | null; authReady: boolean; workspaceId: string; signal?: AbortSignal }): Promise<FetchPendingInvitationsResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/invitations`, {
      user: args.user,
      authReady: args.authReady,
      method: "GET",
      cache: "no-store",
      signal: args.signal,
    });
    if (!res.ok) return { status: "error" };
    const json = await res.json().catch(() => null);
    if (typeof json !== "object" || json === null) return { status: "error" };
    const d = json as Record<string, unknown>;
    if (d.ok !== true || !Array.isArray(d.invitations) || !d.invitations.every(isValidInvitation)) return { status: "error" };
    return { status: "ok", invitations: d.invitations as WorkspaceInvitationItem[] };
  } catch {
    return { status: "error" };
  }
}

export type CreateInvitationResult = { status: "ok"; invitation: WorkspaceInvitationItem } | { status: "denied"; errorCode: string; message: string } | { status: "error" };

export async function createInvitation(args: { user: User | null; authReady: boolean; workspaceId: string; email: string; role: WorkspaceInvitationRole }): Promise<CreateInvitationResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/invitations`, {
      user: args.user,
      authReady: args.authReady,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: args.email, role: args.role }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const errorCode = typeof (json as Record<string, unknown> | null)?.errorCode === "string" ? ((json as Record<string, unknown>).errorCode as string) : "unknown_error";
      const message = typeof (json as Record<string, unknown> | null)?.message === "string" ? ((json as Record<string, unknown>).message as string) : "This invitation could not be sent.";
      return { status: "denied", errorCode, message };
    }
    if (typeof json !== "object" || json === null) return { status: "error" };
    const d = json as Record<string, unknown>;
    const inv = d.invitation;
    if (typeof inv !== "object" || inv === null) return { status: "error" };
    const i = inv as Record<string, unknown>;
    if (typeof i.id !== "string" || typeof i.normalizedEmail !== "string" || typeof i.role !== "string" || typeof i.expiresAt !== "string" || typeof i.deliveryVersion !== "number") {
      return { status: "error" };
    }
    return {
      status: "ok",
      invitation: { id: i.id, normalizedEmail: i.normalizedEmail, role: i.role as WorkspaceInvitationRole, isExpired: false, expiresAt: i.expiresAt, deliveryVersion: i.deliveryVersion },
    };
  } catch {
    return { status: "error" };
  }
}

export type InvitationActionResult = { status: "ok" } | { status: "denied"; errorCode: string; message: string } | { status: "error" };

export async function resendInvitation(args: { user: User | null; authReady: boolean; workspaceId: string; invitationId: string; expectedDeliveryVersion: number }): Promise<InvitationActionResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/invitations/${encodeURIComponent(args.invitationId)}/resend`, {
      user: args.user,
      authReady: args.authReady,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedDeliveryVersion: args.expectedDeliveryVersion }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      const errorCode = typeof (json as Record<string, unknown> | null)?.errorCode === "string" ? ((json as Record<string, unknown>).errorCode as string) : "unknown_error";
      const message = typeof (json as Record<string, unknown> | null)?.message === "string" ? ((json as Record<string, unknown>).message as string) : "This invitation could not be resent.";
      return { status: "denied", errorCode, message };
    }
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}

export async function revokeInvitation(args: { user: User | null; authReady: boolean; workspaceId: string; invitationId: string; expectedDeliveryVersion: number }): Promise<InvitationActionResult> {
  try {
    const res = await authedFetch(`/api/workspaces/${encodeURIComponent(args.workspaceId)}/invitations/${encodeURIComponent(args.invitationId)}/revoke`, {
      user: args.user,
      authReady: args.authReady,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedDeliveryVersion: args.expectedDeliveryVersion }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      const errorCode = typeof (json as Record<string, unknown> | null)?.errorCode === "string" ? ((json as Record<string, unknown>).errorCode as string) : "unknown_error";
      const message = typeof (json as Record<string, unknown> | null)?.message === "string" ? ((json as Record<string, unknown>).message as string) : "This invitation could not be revoked.";
      return { status: "denied", errorCode, message };
    }
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}
