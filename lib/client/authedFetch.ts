/**
 * Authenticated Fetch Helper
 * 
 * A robust client-side utility that automatically adds Firebase ID token to fetch requests.
 * Ensures all protected API routes receive proper authentication headers.
 * 
 * Features:
 * - Waits for Firebase auth state to resolve before making requests
 * - Throws clear error if user is not signed in
 * - Retries token fetch with force refresh if first attempt fails
 * - Uses proper Headers API for header construction
 * - Adds dev-only debug logging (no secrets)
 * 
 * Usage:
 *   import { authedFetch } from '@/lib/client/authedFetch';
 *   import { useAuth } from '@/components/AuthProvider';
 * 
 *   const { user, loading: authLoading } = useAuth();
 *   const response = await authedFetch('/api/user/usage', {
 *     user,
 *     authLoading,
 *     method: 'GET',
 *   });
 */

"use client";

import { User } from "firebase/auth";

/**
 * Error thrown when user is not signed in
 */
export class NotSignedInError extends Error {
  constructor(endpoint: string) {
    super(`Authentication required for ${endpoint}. Please sign in.`);
    this.name = "NotSignedInError";
  }
}

/**
 * Error thrown when auth is still loading
 */
export class AuthLoadingError extends Error {
  constructor() {
    super("Authentication state is still loading. Please wait.");
    this.name = "AuthLoadingError";
  }
}

/**
 * Error thrown when token fetch fails after retry
 */
export class TokenFetchError extends Error {
  constructor(endpoint: string, cause?: Error) {
    super(`Failed to get authentication token for ${endpoint}: ${cause?.message || "Unknown error"}`);
    this.name = "TokenFetchError";
    this.cause = cause;
  }
}

/**
 * Get Firebase ID token with retry logic
 * 
 * Attempts to get token, and if it fails, retries once with force refresh.
 * 
 * @param user - Firebase user object
 * @returns Promise<string> - ID token
 * @throws TokenFetchError if both attempts fail
 */
async function getIdTokenWithRetry(user: User): Promise<string> {
  try {
    // First attempt: get cached token
    return await user.getIdToken(false);
  } catch (firstError: any) {
    // First attempt failed, retry with force refresh
    try {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[authedFetch] First token fetch failed, retrying with force refresh:", firstError?.message);
      }
      return await user.getIdToken(true);
    } catch (retryError: any) {
      // Both attempts failed
      throw new TokenFetchError("token fetch", retryError);
    }
  }
}

/**
 * Authenticated fetch wrapper
 * 
 * Automatically adds Firebase ID token to request headers.
 * Waits for auth state to resolve and throws if user is not signed in.
 * 
 * @param url - API endpoint URL (must be relative, e.g., '/api/user/usage')
 * @param options - Fetch options including user and authLoading
 * @returns Promise<Response> - Fetch response
 * @throws NotSignedInError if user is null
 * @throws AuthLoadingError if auth is still loading
 * @throws TokenFetchError if token fetch fails after retry
 * 
 * Example:
 *   const { user, loading: authLoading } = useAuth();
 *   const response = await authedFetch('/api/user/usage', {
 *     user,
 *     authLoading,
 *     method: 'GET',
 *   });
 */
export async function authedFetch(
  url: string,
  options: RequestInit & {
    user: User | null;
    authReady?: boolean;
    forceTokenRefresh?: boolean;
  }
): Promise<Response> {
  const {
    user,
    authReady = true, // Default to true for backward compatibility (call sites should check authReady)
    forceTokenRefresh = false,
    headers: initHeaders = {},
    ...restOptions
  } = options;

  // Check if auth is ready (first onAuthStateChanged callback has executed)
  if (!authReady) {
    throw new AuthLoadingError();
  }

  // Check if user is signed in
  if (!user) {
    throw new NotSignedInError(url);
  }

  // Convert initHeaders to Headers object
  const headers = new Headers(initHeaders);

  // Ensure Content-Type is set if body is provided and not already set
  if (restOptions.body && !headers.has("Content-Type")) {
    if (typeof restOptions.body === "string") {
      headers.set("Content-Type", "application/json");
    }
  }

  // Get Firebase ID token with retry logic
  let idToken: string;
  try {
    if (forceTokenRefresh) {
      idToken = await user.getIdToken(true);
    } else {
      idToken = await getIdTokenWithRetry(user);
    }
  } catch (tokenError: any) {
    if (tokenError instanceof TokenFetchError) {
      throw tokenError;
    }
    // Fallback: try one more time
    try {
      idToken = await user.getIdToken(true);
    } catch (finalError: any) {
      throw new TokenFetchError(url, finalError);
    }
  }

  // Set Authorization header
  headers.set("Authorization", `Bearer ${idToken}`);

  // Dev-only debug logging (no secrets)
  if (process.env.NODE_ENV !== "production") {
    console.debug("[authedFetch]", {
      endpoint: url,
      hasAuthHeader: headers.has("Authorization"),
      method: restOptions.method || "GET",
    });
  }

  // Execute fetch with authenticated headers
  return fetch(url, {
    ...restOptions,
    headers,
  });
}

/**
 * Prepare authenticated headers for use with fetchWithTimeout or other fetch wrappers
 * 
 * This is a lower-level helper for cases where you need headers but want to use
 * a different fetch wrapper (e.g., fetchWithTimeout).
 * 
 * @param user - Firebase user object (must not be null)
 * @param existingHeaders - Existing headers to merge with
 * @param forceTokenRefresh - Force token refresh (default: false)
 * @returns Promise<Headers> - Headers object with Authorization header
 * @throws NotSignedInError if user is null
 * @throws TokenFetchError if token fetch fails
 */
export async function prepareAuthedHeaders(
  user: User | null,
  existingHeaders: HeadersInit = {},
  forceTokenRefresh: boolean = false
): Promise<Headers> {
  if (!user) {
    throw new NotSignedInError("header preparation");
  }

  const headers = new Headers(existingHeaders);

  // Get Firebase ID token with retry logic
  let idToken: string;
  try {
    if (forceTokenRefresh) {
      idToken = await user.getIdToken(true);
    } else {
      idToken = await getIdTokenWithRetry(user);
    }
  } catch (tokenError: any) {
    if (tokenError instanceof TokenFetchError) {
      throw tokenError;
    }
    // Fallback: try one more time
    try {
      idToken = await user.getIdToken(true);
    } catch (finalError: any) {
      throw new TokenFetchError("header preparation", finalError);
    }
  }

  headers.set("Authorization", `Bearer ${idToken}`);
  return headers;
}
