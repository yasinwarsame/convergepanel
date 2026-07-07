import "server-only";

/**
 * IndexNow submission helper.
 *
 * Key file lives at public/<INDEXNOW_KEY>.txt so it's served at
 * https://convergepanel.com/<INDEXNOW_KEY>.txt, satisfying the protocol's
 * key-location verification. The shared endpoint fans out to Bing, Yandex,
 * Seznam, and Naver.
 */
export const INDEXNOW_KEY = "97ce1cedaadd35047076e3cc65939bd8";
export const INDEXNOW_HOST = "convergepanel.com";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export async function submitUrlsToIndexNow(urls: string[]): Promise<{ ok: boolean; status: number; body?: string }> {
  if (urls.length === 0) return { ok: true, status: 0 };

  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  });

  return { ok: res.ok, status: res.status, body: res.ok ? undefined : await res.text() };
}
