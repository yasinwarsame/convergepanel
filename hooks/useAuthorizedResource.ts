"use client";

/**
 * ZCA (D-4) — the shared client loader behind every neutral workspace shell.
 *
 * A workspace page's server render no longer resolves any identity: it sends the same neutral
 * markup to everyone, whatever cookie the browser holds. Identity-specific content is loaded here,
 * from a bearer-authorized endpoint, ONLY when the Firebase client has a signed-in user:
 *
 *   - Firebase not ready yet                 → `loading` (nothing sent)
 *   - no Firebase user (signed out locally)  → `signed_out` (nothing sent; a leftover cookie is irrelevant)
 *   - 200 with a body `parse` accepts        → `ready`
 *   - 404 / 403                              → `not_found` (concealed: the caller renders the page's 404)
 *   - 401                                    → `unauthorized` (the bearer was refused: revoked, disabled,
 *                                               mismatched cookie … — nothing is shown)
 *   - 503 / any other status / network / unparseable body → `unavailable`
 *
 * Identity changes: the request is keyed by (uid, url). When the Firebase user changes or signs out,
 * the previous data is dropped at once and any answer to an earlier request is discarded, so a
 * response for account A can never be rendered while the page shows account B (or nobody).
 */
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";

export type AuthorizedResource<T> =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "ready"; data: T }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "unavailable" };

export function useAuthorizedResource<T>(url: string | null, parse: (body: unknown) => T | null): AuthorizedResource<T> & { retry: () => void } {
  const { user, authReady } = useAuth();
  // Every stored outcome carries the (uid, url) it was obtained for. The value returned below is
  // derived for the CURRENT key, so stored data can never be returned for another identity — not
  // even for the single render between an identity change and the effect that refetches.
  const [stored, setStored] = useState<{ key: string; value: AuthorizedResource<T> }>({ key: "", value: { status: "loading" } });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const uid = user?.uid ?? null;
  const key = `${uid ?? ""}|${url ?? ""}`;

  useEffect(() => {
    const myGeneration = ++generation.current;
    const current = () => generation.current === myGeneration;
    const setState = (value: AuthorizedResource<T>) => setStored({ key, value });
    if (!authReady) {
      setState({ status: "loading" });
      return;
    }
    if (!user || uid === null) {
      setState({ status: "signed_out" });
      return;
    }
    if (url === null) {
      setState({ status: "not_found" });
      return;
    }
    setState({ status: "loading" });
    (async () => {
      let res: Response;
      try {
        res = await authedFetch(url, { user, authReady, method: "GET", cache: "no-store" });
      } catch {
        if (current()) setState({ status: "unavailable" });
        return;
      }
      if (!current()) return;
      if (res.status === 404 || res.status === 403) return setState({ status: "not_found" });
      if (res.status === 401) return setState({ status: "unauthorized" });
      if (res.status !== 200) return setState({ status: "unavailable" });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (current()) setState({ status: "unavailable" });
        return;
      }
      if (!current()) return;
      const data = parseRef.current(body);
      setState(data === null ? { status: "unavailable" } : { status: "ready", data });
    })();
    return () => {
      // Invalidate on unmount / identity change / url change: a late answer is dropped.
      generation.current += 1;
    };
    // `user` is keyed by uid: a token refresh of the same account does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, uid, url, attempt]);

  const retry = () => setAttempt((n) => n + 1);
  if (!authReady) return { status: "loading", retry };
  if (!user || uid === null) return { status: "signed_out", retry };
  if (stored.key !== key) return { status: "loading", retry };
  return { ...stored.value, retry };
}
