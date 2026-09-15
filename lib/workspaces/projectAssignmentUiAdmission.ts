/**
 * Project/Research Assignment (D10) — the server-side presentation hint
 * the Team Project pages pass to their client shells so assignment
 * controls render only for an admitted caller. Pure, zero I/O, and NEVER
 * an authorization decision: every assignment route re-derives admission
 * and capability inside its own transaction, and non-admission there is
 * concealed as an ordinary authorization denial.
 */

import "server-only";
import { PROJECT_ASSIGNMENT_ENABLED, PROJECT_ASSIGNMENT_CANARY_UIDS } from "@/lib/env";
import { resolveProjectAssignmentAdmission } from "./projectAssignmentRollout";

export function projectAssignmentUiEnabledFor(uid: string): boolean {
  return resolveProjectAssignmentAdmission({ uid, globalEnabled: PROJECT_ASSIGNMENT_ENABLED, canaryUidsRaw: PROJECT_ASSIGNMENT_CANARY_UIDS }).admitted;
}
