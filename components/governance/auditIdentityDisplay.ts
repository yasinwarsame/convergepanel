/**
 * Governance Audit Log — identity presentation (roadmap 4.1, C1 + C3).
 *
 * The ONE place the Audit Log turns an event's identity fields into text.
 * The list card and the expanded per-run trail both call these functions,
 * so the same actor can never render differently between them.
 *
 * Rules:
 * - A raw uid is never returned. `byUid` is used only for an equality check
 *   against the signed-in viewer.
 * - `/api/governance/audit` returns only the viewer's OWN actions (both the
 *   global list and the per-run drilldown filter `byUid === viewer`), so the
 *   uid comparison is the authoritative "You" signal; the email comparison
 *   covers the same identity when the client has no uid.
 * - A name is never invented. When no identity is legitimately resolvable the
 *   result is the single neutral label below. It deliberately does not say
 *   whether the value was never recorded or is withheld from this viewer —
 *   those two cases must stay indistinguishable.
 */

import { maskEmail } from "@/lib/utils/maskEmail";

export const AUDIT_IDENTITY_UNAVAILABLE_LABEL = "Not available";

export type AuditIdentityViewer = {
  uid?: string | null;
  email?: string | null;
};

export type AuditActorFields = {
  byUid?: string;
  byEmail?: string;
};

export type AuditRunOwnerFields = {
  runOwnerEmail?: string;
  runOwnerIsViewer?: boolean;
};

function looksLikeEmail(s: string): boolean {
  return s.includes("@");
}

function sameEmail(a: string, b: string | null | undefined): boolean {
  const other = (b ?? "").trim();
  return other !== "" && a.toLowerCase() === other.toLowerCase();
}

/** Who performed the audited action. Never a raw uid. */
export function auditActorDisplay(ev: AuditActorFields, viewer: AuditIdentityViewer): string {
  const byUid = (ev.byUid ?? "").trim();
  const byEmail = (ev.byEmail ?? "").trim();
  if (byUid === "system" || byEmail === "system" || byEmail === "system@convergepanel.com") {
    return "System";
  }
  const viewerUid = (viewer.uid ?? "").trim();
  if (viewerUid && byUid === viewerUid) return "You";
  if (!looksLikeEmail(byEmail)) return AUDIT_IDENTITY_UNAVAILABLE_LABEL;
  if (sameEmail(byEmail, viewer.email)) return "You";
  return maskEmail(byEmail);
}

/** Who owns the audited run ("Run by"). Never a raw uid. */
export function auditRunOwnerDisplay(ev: AuditRunOwnerFields, viewer: AuditIdentityViewer): string {
  if (ev.runOwnerIsViewer === true) return "You";
  const email = (ev.runOwnerEmail ?? "").trim();
  if (!looksLikeEmail(email)) return AUDIT_IDENTITY_UNAVAILABLE_LABEL;
  if (sameEmail(email, viewer.email)) return "You";
  return maskEmail(email);
}
