/**
 * Development-only impersonated auth client (Order 35 G, D-2; D-2 confirmation review MATERIAL). Loaded ONLY on the
 * development ADC branch of admin.ts (lazy require).
 *
 * firebase-admin's own impersonated credential (what applicationDefault() returns for an impersonated ADC file) only
 * refreshes the SOURCE user's token and never calls iamcredentials, so Firebase Auth ran as the developer's own Google
 * user. This builds an explicit google-auth-library `Impersonated` client instead: source = the developer's
 * authorized_user from the EXACT bytes admin.ts already read and validated (never re-read), target = the validated
 * service account. admin.ts hands the SAME client to Firebase Auth (through the credential below) and to Firestore.
 */
import "server-only";
import { Impersonated, UserRefreshClient } from "google-auth-library";
import { inspectAdcFile } from "./developmentAdc";

/** cloud-platform covers Firestore and Identity Toolkit; the explicit scopes match firebase-admin's own credentials. */
export const DEVELOPMENT_ADC_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/identitytoolkit",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** Marks a credential built here, so a reused default app (dev-mode reload) yields the same client for Firestore. */
const CLIENT_KEY = Symbol.for("convergepanel.firebase.developmentAdcClient");

/**
 * Builds the impersonated client from the validated ADC text. Fails closed (no fallback to the unimpersonated user)
 * unless the text inspects to exactly `serviceAccountEmail` and carries a complete authorized_user source.
 * Error messages never include credential values.
 */
export function createDevelopmentImpersonatedClient(adcText: string, serviceAccountEmail: string): Impersonated {
  const inspected = inspectAdcFile(adcText);
  if (inspected.kind !== "ok" || inspected.serviceAccountEmail !== serviceAccountEmail) throw new Error("development ADC client refused: service account does not match the validated file");
  const source = (JSON.parse(adcText) as { source_credentials?: Record<string, unknown> }).source_credentials ?? {};
  const { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } = source;
  if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret || typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("development ADC client refused: incomplete authorized_user source credential");
  }
  const sourceClient = new UserRefreshClient({ clientId, clientSecret, refreshToken });
  return new Impersonated({ sourceClient, targetPrincipal: serviceAccountEmail, targetScopes: DEVELOPMENT_ADC_SCOPES, lifetime: 3600 });
}

/**
 * A firebase-admin `Credential` (getAccessToken only) backed by the impersonated client. A class instance, not a plain
 * object: firebase-admin deep-copies plain objects in app options, which would drop the client reference below.
 */
class DevelopmentImpersonatedCredential {
  declare readonly [CLIENT_KEY]: Impersonated;
  constructor(client: Impersonated) {
    Object.defineProperty(this, CLIENT_KEY, { value: client, enumerable: false });
  }
  async getAccessToken(): Promise<{ access_token: string; expires_in: number }> {
    const client = this[CLIENT_KEY];
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Development impersonated credential returned no access token");
    const expiry = client.credentials?.expiry_date;
    const expiresIn = typeof expiry === "number" ? Math.max(0, Math.floor((expiry - Date.now()) / 1000)) : 300;
    return { access_token: token, expires_in: expiresIn };
  }
}

export function developmentImpersonatedCredential(client: Impersonated): DevelopmentImpersonatedCredential {
  return new DevelopmentImpersonatedCredential(client);
}

/**
 * The client behind an existing default app's credential, only when this module built it for exactly
 * `serviceAccountEmail`; otherwise null (admin.ts refuses, never reuses an unvalidated credential).
 */
export function developmentClientOf(credential: unknown, serviceAccountEmail: string): Impersonated | null {
  const client = credential && typeof credential === "object" ? (credential as { [CLIENT_KEY]?: unknown })[CLIENT_KEY] : undefined;
  if (!client || typeof client !== "object" || (client as Impersonated).getTargetPrincipal?.() !== serviceAccountEmail) return null;
  return client as Impersonated;
}
