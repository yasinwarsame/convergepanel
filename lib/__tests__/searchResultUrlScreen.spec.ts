/**
 * Order 5 Phase 0 — search-result URL validation + credential screen.
 * Table-driven running fixtures: every DROP class and every KEEP class
 * (including the false-positive protections the owner requires).
 */

import { randomUUID, randomBytes } from "crypto";
import { screenSearchResultUrl, SEARCH_RESULT_URL_MAX_BYTES } from "@/lib/providers/searchResultUrlScreen";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PjwP2kSf1ZQA";

describe("structural validation", () => {
  it.each([
    ["valid http", "http://example.com/a", "usable"],
    ["valid https", "https://www.example.org/news/2026/10/story", "usable"],
    ["unsupported scheme (ftp)", "ftp://example.com/file", "invalid"],
    ["unsupported scheme (javascript)", "javascript:alert(1)", "invalid"],
    ["unsupported scheme (mailto)", "mailto:someone@example.com", "invalid"],
    ["malformed", "not a url", "invalid"],
    ["relative path", "/news/story", "invalid"],
    ["no hostname", "http://", "invalid"],
    ["no hostname (query only)", "https://?q=1", "invalid"],
    ["file scheme", "file:///etc/passwd", "invalid"],
    ["empty string", "", "invalid"],
  ])("%s", (_label, url, kind) => {
    expect(screenSearchResultUrl(url).kind).toBe(kind);
  });

  it.each([[null], [undefined], [42], [{ url: "https://example.com" }], [["https://example.com"]]])("non-string %p is invalid", (value) => {
    expect(screenSearchResultUrl(value).kind).toBe("invalid");
  });

  it("the 512-byte boundary is measured on the serialized URL", () => {
    const base = "https://example.com/";
    const atLimit = base + "a".repeat(SEARCH_RESULT_URL_MAX_BYTES - base.length);
    expect(Buffer.byteLength(new URL(atLimit).href)).toBe(512);
    expect(screenSearchResultUrl(atLimit).kind).toBe("usable");
    expect(screenSearchResultUrl(atLimit + "a").kind).toBe("over_limit");
    // multi-byte characters count as bytes (percent-encoded when serialized)
    expect(screenSearchResultUrl(base + "é".repeat(100)).kind).toBe("over_limit");
  });

  it("never throws on hostile input", () => {
    for (const v of ["http://%zz", "https://example.com/%E0%A4%A", "https://exa mple.com", "http://[::1", "https://example.com/?a=%", "\u0000", "h".repeat(100_000)]) {
      expect(() => screenSearchResultUrl(v)).not.toThrow();
    }
  });
});

describe("privacy screen — DROP the whole entry", () => {
  it.each([
    ["userinfo user:pass", "https://user:pass@example.com/a", "userinfo"],
    ["userinfo user only", "https://user@example.com/a", "userinfo"],
    ["access_token", "https://example.com/a?access_token=abc123", "credential_query_name"],
    ["id_token", "https://example.com/a?id_token=abc", "credential_query_name"],
    ["refresh_token", "https://example.com/a?refresh_token=abc", "credential_query_name"],
    ["token", "https://example.com/a?token=abc", "credential_query_name"],
    ["api_key", "https://example.com/a?api_key=abc", "credential_query_name"],
    ["apikey", "https://example.com/a?apikey=abc", "credential_query_name"],
    ["API-Key upper", "https://example.com/a?API-Key=abc", "credential_query_name"],
    ["authorization", "https://example.com/a?authorization=abc", "credential_query_name"],
    ["client_secret", "https://example.com/a?client_secret=abc", "credential_query_name"],
    ["password", "https://example.com/login?user=x&password=abc", "credential_query_name"],
    ["S3 presigned X-Amz-Signature", "https://bucket.s3.amazonaws.com/doc.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=abcd", "credential_query_name"],
    ["GCS X-Goog-Signature", "https://storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4&X-Goog-Signature=abcd", "credential_query_name"],
    ["GCS legacy GoogleAccessId", "https://storage.googleapis.com/b/o?GoogleAccessId=x&Expires=1&Signature=abc", "credential_query_name"],
    ["Azure SAS sig", "https://acct.blob.core.windows.net/c/b?sv=2021-01-01&se=2026-01-01&sr=b&sp=r&sig=abc%2Bdef", "credential_query_name"],
    ["CloudFront Signature", "https://d111.cloudfront.net/v.mp4?Expires=1&Signature=abc&Key-Pair-Id=K1", "credential_query_name"],
    ["oauth_signature", "https://example.com/a?oauth_consumer_key=x&oauth_signature=y", "credential_query_name"],
    ["jsessionid query", "https://example.com/a?JSESSIONID=ABCDEF0123", "credential_query_name"],
    ["suffix auth_token", "https://example.com/a?auth_token=abc", "credential_query_name"],
    ["suffix reset_token", "https://example.com/reset?reset_token=abc", "credential_query_name"],
    ["camelCase accessToken", "https://example.com/a?accessToken=abc", "credential_query_name"],
    ["camelCase apiKey", "https://example.com/a?apiKey=abc", "credential_query_name"],
    ["x-api-key", "https://example.com/a?x-api-key=abc", "credential_query_name"],
    ["JWT in benign query value", `https://example.com/a?t=${JWT}`, "credential_value"],
    ["Bearer in query value", "https://example.com/a?h=Bearer%20abcdefghijkl", "credential_value"],
    ["Stripe live key value", "https://example.com/a?k=sk_live_51HabcdefghijKLMN", "credential_value"],
    ["GitHub token value", "https://example.com/a?x=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "credential_value"],
    ["AWS access key id value", "https://example.com/a?x=AKIAIOSFODNN7EXAMPLE", "credential_value"],
    ["Google API key value", "https://example.com/a?x=AIzaSyA1234567890abcdefghijklmnopqrstuv", "credential_value"],
    ["Slack token value", "https://example.com/a?x=xoxb-1234567890-abcdef", "credential_value"],
    ["GitLab PAT value", "https://example.com/a?x=glpat-abcdefghijklmnopqrstuv", "credential_value"],
    ["JWT in path", `https://example.com/share/${JWT}`, "credential_path"],
    ["Stripe key in path", "https://example.com/files/sk_live_51HabcdefghijKLMN/download", "credential_path"],
    ["matrix jsessionid", "https://example.com/catalog;jsessionid=ABC123DEF456/item", "credential_path"],
    ["matrix token", "https://example.com/dl;token=abc/file.pdf", "credential_path"],
    ["fragment access_token", "https://example.com/callback#access_token=abc&expires_in=3600", "credential_fragment"],
    ["fragment token=", "https://example.com/page#token=abc", "credential_fragment"],
    ["fragment code=", "https://example.com/page#state=x&code=abc", "credential_fragment"],
    ["fragment JWT", `https://example.com/page#${JWT}`, "credential_fragment"],
    ["Slack webhook host", "https://hooks.slack.com/services/T000/B000/XXXXXXXX", "credential_host"],
    ["Discord webhook subdomain", "https://canary.discord.com/api/webhooks/123/abc", "credential_host"],
    ["Telegram bot", "https://api.telegram.org/bot123456:ABCdef/getMe", "credential_host"],
    ["nested next URL with token", "https://example.com/login?next=%2Freset%3Ftoken%3Dabc", "credential_query_name"],
    ["nested absolute URL with signature", "https://example.com/r?u=https%3A%2F%2Fcdn.example.com%2Ff%3FX-Amz-Signature%3Dx", "credential_query_name"],
    ["malformed percent-encoding fails closed", "https://example.com/a?q=%E0%A4%A", "decode_error"],
  ])("%s", (_label, url, signal) => {
    expect(screenSearchResultUrl(url)).toEqual({ kind: "privacy_dropped", signal });
  });
});

describe("privacy screen — KEEP ordinary source URLs (no entropy-only drops)", () => {
  it.each([
    ["dashed UUID path", "https://example.com/articles/3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f"],
    ["undashed 32-hex content id", "https://example.com/content/9f86d081884c7d659a2feaa0c55ad015"],
    ["40-hex commit SHA", "https://github.com/org/repo/commit/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"],
    ["64-hex hash path", "https://cdn.example.com/assets/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.js"],
    ["long numeric id", "https://www.example.com/news/world-12345678901234567890"],
    ["numeric query id", "https://example.com/article?id=987654321012345"],
    ["Google Docs id", "https://docs.google.com/document/d/1aBcD2eFgH3iJkL4mNoP5qRsT6uVwX7yZ8aBcD9eFgH0/edit"],
    ["YouTube video", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["YouTube playlist", "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"],
    ["slug starting with sk-", "https://example.com/sk-hynix-reports-record-quarterly-earnings"],
    ["slug sk-ant-", "https://example.com/blog/sk-ant-farm-guide-for-kids"],
    ["slug skincare", "https://example.com/skincare-routine-for-beginners"],
    ["Wikipedia title", "https://en.wikipedia.org/wiki/2024_United_States_presidential_election"],
    ["DOI", "https://doi.org/10.1038/s41586-020-2649-2"],
    ["arXiv", "https://arxiv.org/abs/2301.12345v2"],
    ["Amazon sr param without sig", "https://www.amazon.com/dp/B08N5WRWNW?sr=8-3&keywords=widget"],
    ["ordinary query params", "https://example.com/search?q=skyscrapers-of-new-york&page=2&sort=date"],
    ["code param (ambiguous name, kept)", "https://example.com/course?code=PY101"],
    ["key param (ambiguous name, kept)", "https://example.com/doc?key=value"],
    ["text fragment", "https://example.com/page#:~:text=token%20economics"],
    ["heading fragment", "https://example.com/page#section-2"],
    ["utm params", "https://example.com/a?utm_source=news&utm_medium=email&utm_campaign=fall"],
    ["page_number style", "https://example.com/a?pagetoken_hint=3&page=4"],
    ["tokenomics slug", "https://example.com/what-is-tokenomics"],
    ["bearer slug", "https://example.com/the-bearer-bond-explained"],
  ])("%s", (_label, url) => {
    expect(screenSearchResultUrl(url)).toEqual({ kind: "usable" });
  });

  it("1 000 random UUIDv4 paths and query values are all kept", () => {
    for (let i = 0; i < 1000; i++) {
      const id = randomUUID();
      expect(screenSearchResultUrl(`https://example.com/items/${id}`)).toEqual({ kind: "usable" });
      expect(screenSearchResultUrl(`https://example.com/view?id=${id}`)).toEqual({ kind: "usable" });
    }
  });

  it("1 000 random hex / numeric content ids are all kept", () => {
    for (let i = 0; i < 1000; i++) {
      const hex = randomBytes(16 + (i % 17)).toString("hex");
      const num = BigInt("0x" + randomBytes(8).toString("hex")).toString();
      expect(screenSearchResultUrl(`https://example.com/c/${hex}`)).toEqual({ kind: "usable" });
      expect(screenSearchResultUrl(`https://example.com/n/${num}?ref=${hex}`)).toEqual({ kind: "usable" });
    }
  });
});
