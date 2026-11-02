/**
 * Order B, Stage B1 — Report Review rollout switch.
 *
 * Deliberately a COMPILE-TIME constant, not an environment variable: Stage B1 is authorized to ship dark only, and
 * `lib/env.ts` is frozen by the Order 6 boundary suites (dsExportBoundaries / dsProvenanceUiBoundaries pin it
 * byte-for-byte). Turning Report Review on therefore requires a separate, reviewed change and an owner enablement
 * decision — it cannot happen through configuration alone. Tests override this module with jest.mock.
 */
export const REPORT_REVIEW_ENABLED = false as boolean;
