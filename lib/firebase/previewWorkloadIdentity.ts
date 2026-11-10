/**
 * Preview-only keyless Firebase Admin credential (Order 33, Preview isolation).
 *
 * A Vercel PREVIEW deployment authenticates to the isolated Preview Firebase project through Google Cloud Workload
 * Identity Federation. Vercel's OIDC token is exchanged at Google STS for a federated token, which then impersonates
 * the Preview-only service account. There is no service-account key.
 *
 * This path applies ONLY when every condition below holds. Otherwise `previewWorkloadIdentityConfig()` returns null
 * and admin.ts keeps its existing certificate path unchanged:
 *   - `VERCEL_ENV === "preview"` (Production and local runs never take this path);
 *   - FIREBASE_PROJECT_ID, FIREBASE_WIF_AUDIENCE and FIREBASE_WIF_SERVICE_ACCOUNT are all set;
 *   - the audience is a Workload Identity provider resource;
 *   - the service account belongs to the configured project, and that project is NOT Production.
 *     admin.ts also runs the #294 isolation guard on the resolved identity.
 *
 * Trust is restricted on the Google side: the provider's attribute condition requires
 * owner_id = the ConvergePanel team, project_id = the convergepanel Vercel project and environment = preview, and only
 * the exact Preview subject is a workloadIdentityUser of the service account.
 */
import "server-only";
import { IdentityPoolClient } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/oidc";
import { PRODUCTION_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_NUMBER, serviceAccountProject } from "./projectIsolation";

export interface PreviewWorkloadIdentityConfig {
  projectId: string;
  audience: string;
  serviceAccountEmail: string;
}

const AUDIENCE_PATTERN = /^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;

export type PreviewWorkloadIdentityResolution =
  | { kind: "not_applicable" }
  | { kind: "refused"; reason: "incomplete_configuration" | "invalid_audience" | "production_project" | "service_account_project_mismatch" }
  | { kind: "ok"; config: PreviewWorkloadIdentityConfig };

/** Pure: decides from the given environment whether the Preview WIF path applies, and validates it fail-closed. */
export function resolvePreviewWorkloadIdentity(env: Record<string, string | undefined>): PreviewWorkloadIdentityResolution {
  if (env.VERCEL_ENV !== "preview") return { kind: "not_applicable" };
  const projectId = (env.FIREBASE_PROJECT_ID ?? "").trim();
  const audience = (env.FIREBASE_WIF_AUDIENCE ?? "").trim();
  const serviceAccountEmail = (env.FIREBASE_WIF_SERVICE_ACCOUNT ?? "").trim();
  // Only the two WIF-specific variables opt in: FIREBASE_PROJECT_ID alone also serves the certificate path.
  if (!audience && !serviceAccountEmail) return { kind: "not_applicable" };
  if (!projectId || !audience || !serviceAccountEmail) return { kind: "refused", reason: "incomplete_configuration" };
  if (!AUDIENCE_PATTERN.test(audience)) return { kind: "refused", reason: "invalid_audience" };
  const pid = projectId.toLowerCase();
  const saProject = serviceAccountProject(serviceAccountEmail);
  if (pid === PRODUCTION_FIREBASE_PROJECT_ID || pid === PRODUCTION_FIREBASE_PROJECT_NUMBER) return { kind: "refused", reason: "production_project" };
  if (saProject === PRODUCTION_FIREBASE_PROJECT_ID || saProject === PRODUCTION_FIREBASE_PROJECT_NUMBER) return { kind: "refused", reason: "production_project" };
  if (saProject !== pid) return { kind: "refused", reason: "service_account_project_mismatch" };
  return { kind: "ok", config: { projectId: pid, audience, serviceAccountEmail } };
}

/** The federated auth client: Vercel OIDC token → Google STS → impersonated Preview service account. */
export function createPreviewWorkloadIdentityClient(config: PreviewWorkloadIdentityConfig): IdentityPoolClient {
  return new IdentityPoolClient({
    type: "external_account",
    audience: config.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccountEmail}:generateAccessToken`,
    subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
}

/** A firebase-admin `Credential` (getAccessToken only) backed by the federated client. */
export function previewWorkloadIdentityCredential(client: IdentityPoolClient): { getAccessToken(): Promise<{ access_token: string; expires_in: number }> } {
  return {
    async getAccessToken() {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error("Preview workload identity returned no access token");
      const expiry = client.credentials?.expiry_date;
      const expiresIn = typeof expiry === "number" ? Math.max(0, Math.floor((expiry - Date.now()) / 1000)) : 300;
      return { access_token: token, expires_in: expiresIn };
    },
  };
}
