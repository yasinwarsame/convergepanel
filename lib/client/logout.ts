"use client";

/**
 * ZCA L-2 — the ONE explicit-logout sequence, shared by every user-initiated sign-out entry point
 * (TopNav and the profile page).
 *
 * Order (owner decision 2026-11-27):
 *   1. `beginLogout()` — protected operations are disabled at once (`canMutate` false).
 *   2. Firebase `signOut` — LOCAL: it clears the persisted Firebase user in this browser and notifies
 *      every tab. It needs no network and cannot hang on the server. The AuthProvider's null branch
 *      then aborts any in-flight session mint, clears identity-scoped client data and sends its own
 *      defensive `DELETE`.
 *   3. A bounded, best-effort `DELETE /api/auth/session` to expire the cookie.
 *   4. The outcome is reported as it is: `cleared`, `failed` or `timed_out`.
 *
 * Why local sign-out comes first: under the zero-cookie-authority contract the `__session` cookie
 * authorizes nothing — only a bearer from the Firebase client does — so step 2 is what ends this
 * browser's access, whether or not step 3 ever reaches the server. Doing it first shrinks the window
 * in which closing the tab mid-logout would leave Firebase itself signed in. Step 3 is hygiene: it
 * removes a cookie that no route accepts any more.
 *
 * A failed or timed-out clear is never reported as a clean sign-out. The `DELETE` is not cancelled at
 * the timeout; it stays registered with `sessionSync`, so a later sign-in's mint still waits for it
 * (R-S0-7) and its late answer can never overwrite a newer cookie.
 */
import { signOut as firebaseSignOut, type Auth } from "firebase/auth";
import { clearServerSession } from "@/lib/client/sessionSync";

export const LOGOUT_CLEAR_TIMEOUT_MS = 5_000;

export type LogoutResult =
  | { signedOut: true; serverCleared: "cleared" | "failed" | "timed_out" }
  | { signedOut: false };

export type LogoutDeps = {
  auth: Auth;
  beginLogout: () => void;
  /** Injection points for tests; production uses Firebase `signOut` and `clearServerSession`. */
  signOut?: (auth: Auth) => Promise<void>;
  clear?: () => Promise<boolean>;
  timeoutMs?: number;
};

export async function performLogout(deps: LogoutDeps): Promise<LogoutResult> {
  deps.beginLogout();
  try {
    await (deps.signOut ?? firebaseSignOut)(deps.auth);
  } catch {
    // The local sign-out itself failed: this browser may still be signed in. Never claim otherwise.
    return { signedOut: false };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), deps.timeoutMs ?? LOGOUT_CLEAR_TIMEOUT_MS);
  });
  const clear = (deps.clear ?? clearServerSession)().then(
    (ok): "cleared" | "failed" => (ok ? "cleared" : "failed"),
    (): "failed" => "failed",
  );
  const serverCleared = await Promise.race([clear, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return { signedOut: true, serverCleared };
}

/** Where to go after a logout: an unconfirmed clear is surfaced, never presented as a clean sign-out. */
export function loginHrefAfterLogout(result: Extract<LogoutResult, { signedOut: true }>): string {
  return result.serverCleared === "cleared" ? "/login?signedOut=1" : "/login?signedOut=1&sessionClearFailed=1";
}
