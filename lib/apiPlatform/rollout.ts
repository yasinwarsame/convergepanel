/**
 * Compile-time rollout switches for the API platform (OD-21; Addendum 1). Both are false: there is no
 * data-plane or management route in this stage, and turning either on is a separately authorized,
 * reviewed PR. Pinned by apiPrincipalBoundary.spec.ts.
 */
export const API_PLATFORM_DATA_PLANE_ENABLED = false as const;
export const API_PLATFORM_MANAGEMENT_ENABLED = false as const;
