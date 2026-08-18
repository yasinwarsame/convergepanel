/**
 * Phase 7B — the single combined-eligibility decision point for the
 * Projects UI, used identically by both call sites that need it
 * (`GET /api/user/usage`, which surfaces the result to `TopNav` via
 * `useUserPlan()`, and `/workspace/projects`'s own route gate) so the
 * AND relationship below can never drift between them.
 *
 * A user must see the Projects UI only when BOTH:
 *   - the UI rollout itself is enabled for this uid
 *     (`resolveProjectsUiMode()`, Phase 7B's own flag)
 *   - the Project backend is enabled for this uid
 *     (`resolveProjectsMode()`, Phase 6B's flag)
 *
 * This is a deliberate security/operability invariant, not an incidental
 * detail: the UI rollout cohort must never be allowed to run ahead of the
 * backend cohort, which would otherwise show a route/nav entry that then
 * 503s on every Project API call. The dependency direction is one-way —
 * UI eligibility requires backend eligibility, but backend authorization
 * (every `app/api/user/project*` route) never checks this module or the
 * UI flag at all.
 */

import "server-only";
import { resolveProjectsUiMode } from "./projectsUiRollout";
import { resolveProjectsMode } from "./projectsRollout";

export function resolveProjectsUiEligibility(args: {
  uid: string;
  uiGlobalEnabled: boolean;
  uiCanaryUidsRaw: string | undefined;
  backendGlobalEnabled: boolean;
  backendCanaryUidsRaw: string | undefined;
}): boolean {
  const uiMode = resolveProjectsUiMode({ uid: args.uid, globalEnabled: args.uiGlobalEnabled, canaryUidsRaw: args.uiCanaryUidsRaw });
  if (!uiMode.enabled) {
    return false;
  }
  const backendMode = resolveProjectsMode({ uid: args.uid, globalEnabled: args.backendGlobalEnabled, canaryUidsRaw: args.backendCanaryUidsRaw });
  return backendMode.enabled;
}
