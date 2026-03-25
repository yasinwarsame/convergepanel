/**
 * Firestore paths and shapes for org governance policy (appConfig/governancePolicy).
 */

import type { Timestamp } from "firebase-admin/firestore";
import type { GovernancePolicy } from "./evaluateGovernance";

export const GOVERNANCE_POLICY_DOC_PATH = { collection: "appConfig", docId: "governancePolicy" } as const;

export type GovernancePolicyFirestoreDoc = GovernancePolicy & {
  updatedAt: Timestamp;
  updatedBy: string;
};

export type GovernancePolicyAuditEvent = {
  action: "policy_updated";
  byUid: string;
  byEmail: string;
  at: string;
  policyVersion: number;
  comment?: string;
  changes?: string[];
};
