/**
 * #290 Increment 1 — the readable report layout rollout switch.
 *
 * Deliberately a COMPILE-TIME constant, not an environment variable, following lib/workspaces/reportReviewRollout.ts:
 * `lib/env.ts` is frozen by the Order 6 boundary suites (dsExportBoundaries / dsProvenanceUiBoundaries pin it byte for
 * byte). Off: every Personal and Team report page renders the classic layout. Turning the readable layout on therefore
 * requires a separate, reviewed change and an owner enablement decision; it cannot happen through configuration alone.
 * Tests select the layout through the shells' `reportLayout` prop or override this module with jest.mock.
 */
export const REPORT_READABLE_LAYOUT_ENABLED = false as boolean;
