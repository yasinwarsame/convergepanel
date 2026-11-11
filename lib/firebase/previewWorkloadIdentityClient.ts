/**
 * Preview-only federated auth client (Order 33). Loaded ONLY on the Preview WIF branch of admin.ts (lazy require),
 * so a Production or local process never loads google-auth-library's external-account client or @vercel/oidc here.
 * The config passed in has already been validated by resolvePreviewWorkloadIdentity (./previewWorkloadIdentity).
 */
import "server-only";
import { IdentityPoolClient } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/oidc";
import type { PreviewWorkloadIdentityConfig } from "./previewWorkloadIdentity";

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
