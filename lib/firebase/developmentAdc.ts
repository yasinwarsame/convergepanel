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

/**
 * Order 36 L (review M-1): the gcloud application-default credential file must be an IMPERSONATED service account
 * (`gcloud auth application-default login --impersonate-service-account=…`). A `service_account` key, an
 * `authorized_user`, any other type, a malformed file or a missing file (which would fall back to the metadata server's
 * shared identity) is refused. Only `type` and the impersonation URL are read; nothing else is parsed or logged.
 * Returns the impersonated service account, which admin.ts hands to the #294 guard (Production SA / project mismatch).
 */
const IMPERSONATION_URL = /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/([a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com):generateAccessToken$/;

export type AdcFileInspection =
  | { kind: "ok"; serviceAccountEmail: string }
  | { kind: "refused"; reason: "adc_file_missing" | "adc_file_unreadable" | "adc_not_impersonated_service_account" | "adc_invalid_impersonation" };

export function inspectAdcFile(text: string | null): AdcFileInspection {
  if (text === null) return { kind: "refused", reason: "adc_file_missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "refused", reason: "adc_file_unreadable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "refused", reason: "adc_file_unreadable" };
  const { type, service_account_impersonation_url: url } = parsed as { type?: unknown; service_account_impersonation_url?: unknown };
  if (type !== "impersonated_service_account") return { kind: "refused", reason: "adc_not_impersonated_service_account" };
  const m = typeof url === "string" ? IMPERSONATION_URL.exec(url) : null;
  if (!m) return { kind: "refused", reason: "adc_invalid_impersonation" };
  return { kind: "ok", serviceAccountEmail: m[1] };
}

/** The file firebase-admin and google-auth-library read for application-default credentials (gcloud well-known path). */
export function adcWellKnownFilePath(env: Record<string, string | undefined>, homedir: string): string {
  const base = env.CLOUDSDK_CONFIG && env.CLOUDSDK_CONFIG.trim() !== "" ? env.CLOUDSDK_CONFIG : `${homedir}/.config/gcloud`;
  return `${base}/application_default_credentials.json`;
}
