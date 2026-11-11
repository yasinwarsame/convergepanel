/**
 * Development-only keyless Firebase Admin credential (Order 35 G, Development isolation package D-2): the pure resolver.
 *
 * A developer opts in with FIREBASE_ADMIN_CREDENTIAL_SOURCE=adc and authenticates with their own Google identity,
 * impersonating the non-Production developer service account:
 *   gcloud auth application-default login --impersonate-service-account=cp-dev-admin@<project>.iam.gserviceaccount.com
 * No service-account key exists or is read. The Production boundary is enforced twice: here (no Production project,
 * no key file, never on a Vercel Preview or Production deployment) and by the #294 isolation guard in admin.ts. The
 * developer service account holds roles on the non-Production project only, so even a misconfiguration cannot reach
 * Production data.
 *
 * `not_applicable` (admin.ts keeps its existing paths) unless FIREBASE_ADMIN_CREDENTIAL_SOURCE is set. When it is set,
 * everything is validated fail-closed, and a refusal throws in admin.ts: there is no fallback to a certificate.
 */
import { PRODUCTION_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_NUMBER } from "./projectIsolation";

export type DevelopmentAdcResolution =
  | { kind: "not_applicable" }
  | { kind: "refused"; reason: "unknown_credential_source" | "adc_outside_development" | "missing_project_id" | "production_project" | "key_file_credentials" }
  | { kind: "ok"; projectId: string };

/** Pure: decides from the given environment whether the development ADC path applies, and validates it fail-closed. */
export function resolveDevelopmentAdc(env: Record<string, string | undefined>): DevelopmentAdcResolution {
  const source = env.FIREBASE_ADMIN_CREDENTIAL_SOURCE;
  if (source === undefined || source === "") return { kind: "not_applicable" };
  if (source !== "adc") return { kind: "refused", reason: "unknown_credential_source" };
  // Local runs (VERCEL_ENV unset) and `vercel dev` (development) only — never a Preview or Production deployment.
  if (env.VERCEL_ENV !== undefined && env.VERCEL_ENV !== "" && env.VERCEL_ENV !== "development") return { kind: "refused", reason: "adc_outside_development" };
  // Keyless only: a key file named by GOOGLE_APPLICATION_CREDENTIALS would make ADC a key credential again.
  if (typeof env.GOOGLE_APPLICATION_CREDENTIALS === "string" && env.GOOGLE_APPLICATION_CREDENTIALS.trim() !== "") return { kind: "refused", reason: "key_file_credentials" };
  // Explicit only: admin.ts defaults FIREBASE_PROJECT_ID to Production, so the default is never used here.
  const projectId = (env.FIREBASE_PROJECT_ID ?? "").trim().toLowerCase();
  if (!projectId) return { kind: "refused", reason: "missing_project_id" };
  if (projectId === PRODUCTION_FIREBASE_PROJECT_ID || projectId === PRODUCTION_FIREBASE_PROJECT_NUMBER) return { kind: "refused", reason: "production_project" };
  return { kind: "ok", projectId };
}
