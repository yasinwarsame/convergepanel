/**
 * Preview-only keyless Firebase Admin credential (Order 33, Preview isolation): the pure configuration resolver.
 *
 * A Vercel PREVIEW deployment authenticates to the isolated Preview Firebase project through Google Cloud Workload
 * Identity Federation. The Vercel OIDC token is exchanged at Google STS, and the result impersonates the Preview-only
 * service account. There is no service-account key. This module has no SDK imports: the federated client lives in
 * ./previewWorkloadIdentityClient and is loaded only on the WIF branch of admin.ts, so Production never loads it.
 *
 * `resolvePreviewWorkloadIdentity()` returns `not_applicable` (admin.ts keeps its certificate path unchanged) unless
 * `VERCEL_ENV === "preview"` and at least one WIF variable is set. When the path applies, every value is validated
 * fail-closed:
 *   - FIREBASE_PROJECT_ID, FIREBASE_WIF_AUDIENCE and FIREBASE_WIF_SERVICE_ACCOUNT must all be present;
 *   - the audience must be a workload identity provider resource, and not in the Production project;
 *   - the service account must be a well-formed `<name>@<project>.iam.gserviceaccount.com` address of the configured
 *     project. Nothing else is accepted, because the address is placed in the impersonation URL path;
 *   - neither the project nor the service account may be Production.
 * admin.ts additionally runs the #294 isolation guard on the resolved identity.
 *
 * Trust is restricted on the Google side: the provider's attribute condition requires owner_id = the ConvergePanel
 * team, project_id = the convergepanel Vercel project and environment = preview, and only the exact Preview subject is
 * a workloadIdentityUser of the service account.
 */
import { PRODUCTION_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_NUMBER } from "./projectIsolation";

export interface PreviewWorkloadIdentityConfig {
  projectId: string;
  audience: string;
  serviceAccountEmail: string;
}

const AUDIENCE_PATTERN = /^\/\/iam\.googleapis\.com\/projects\/(\d+)\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
/** A user-managed service account address: lowercase name and project id, nothing that could alter a URL path. */
const SERVICE_ACCOUNT_PATTERN = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;

export type PreviewWorkloadIdentityResolution =
  | { kind: "not_applicable" }
  | { kind: "refused"; reason: "incomplete_configuration" | "invalid_audience" | "invalid_service_account" | "production_project" | "service_account_project_mismatch" }
  | { kind: "ok"; config: PreviewWorkloadIdentityConfig };

/** Pure: decides from the given environment whether the Preview WIF path applies, and validates it fail-closed. */
export function resolvePreviewWorkloadIdentity(env: Record<string, string | undefined>): PreviewWorkloadIdentityResolution {
  if (env.VERCEL_ENV !== "preview") return { kind: "not_applicable" };
  const projectId = (env.FIREBASE_PROJECT_ID ?? "").trim().toLowerCase();
  const audience = (env.FIREBASE_WIF_AUDIENCE ?? "").trim();
  const serviceAccountEmail = (env.FIREBASE_WIF_SERVICE_ACCOUNT ?? "").trim().toLowerCase();
  // Only the two WIF-specific variables opt in: FIREBASE_PROJECT_ID alone also serves the certificate path.
  if (!audience && !serviceAccountEmail) return { kind: "not_applicable" };
  if (!projectId || !audience || !serviceAccountEmail) return { kind: "refused", reason: "incomplete_configuration" };
  const aud = AUDIENCE_PATTERN.exec(audience);
  if (!aud) return { kind: "refused", reason: "invalid_audience" };
  if (aud[1] === PRODUCTION_FIREBASE_PROJECT_NUMBER) return { kind: "refused", reason: "production_project" };
  if (projectId === PRODUCTION_FIREBASE_PROJECT_ID || projectId === PRODUCTION_FIREBASE_PROJECT_NUMBER) return { kind: "refused", reason: "production_project" };
  const sa = SERVICE_ACCOUNT_PATTERN.exec(serviceAccountEmail);
  if (!sa) return { kind: "refused", reason: "invalid_service_account" };
  const saProject = sa[2];
  if (saProject === PRODUCTION_FIREBASE_PROJECT_ID || saProject === PRODUCTION_FIREBASE_PROJECT_NUMBER) return { kind: "refused", reason: "production_project" };
  if (saProject !== projectId) return { kind: "refused", reason: "service_account_project_mismatch" };
  return { kind: "ok", config: { projectId, audience, serviceAccountEmail } };
}
