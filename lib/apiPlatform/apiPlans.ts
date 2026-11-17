/**
 * Compile-time API plan definitions (Addendum 1: OD-1 narrowed; beta plans assigned by reviewed PR).
 * EMPTY until the owner approves the beta plans: an org's `plan.planId` enables live keys ONLY if it is
 * listed here, so Firestore data alone can never turn on live access.
 */
export interface ApiPlanDefinition {
  readonly planId: string;
  readonly includedCredits: number;
  readonly hardCapCredits: number;
}

export const API_PLANS: readonly ApiPlanDefinition[] = Object.freeze([]);

export function isApprovedApiPlanId(planId: unknown): boolean {
  return typeof planId === "string" && API_PLANS.some((p) => p.planId === planId);
}
