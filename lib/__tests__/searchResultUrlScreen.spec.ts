/**
 * Order 5 Phase 0 — search-result URL validation + credential screen.
 * Table-driven running fixtures: every DROP class and every KEEP class
 * (including the false-positive protections the owner requires).
 */

import { randomUUID, randomBytes } from "crypto";
import { screenSearchResultUrl, SEARCH_RESULT_URL_MAX_BYTES, SEARCH_RESULT_URL_MAX_PROCESSING_BYTES } from "@/lib/providers/searchResultUrlScreen";

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

  it("processing-safety ceiling: oversized raw input is over_limit without inspection; long signed URLs below it are still privacy-screened", () => {
    expect(SEARCH_RESULT_URL_MAX_PROCESSING_BYTES).toBe(16_384);
    const huge = "https://example.com/a?access_token=abc&pad=" + "a".repeat(SEARCH_RESULT_URL_MAX_PROCESSING_BYTES);
    expect(screenSearchResultUrl(huge)).toEqual({ kind: "over_limit" });
    const longSigned = "https://bucket.s3.amazonaws.com/o?X-Amz-Signature=abc&pad=" + "a".repeat(4000);
    expect(screenSearchResultUrl(longSigned)).toEqual({ kind: "privacy_dropped", signal: "credential_query_name" });
    const longPlain = "https://example.com/a?pad=" + "a".repeat(4000);
    expect(screenSearchResultUrl(longPlain)).toEqual({ kind: "over_limit" });
  });

  it("an unforeseen runtime error inside the screen fails closed (screen_error)", () => {
    const spy = jest.spyOn(String.prototype, "normalize").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      expect(screenSearchResultUrl("https://example.com/a?x=1")).toEqual({ kind: "privacy_dropped", signal: "screen_error" });
    } finally {
      spy.mockRestore();
    }
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
    ["Bearer in query value", "https://example.com/a?h=Bearer%20dGhpc2lzYXRva2VuMTIz%3D%3D", "credential_value"],
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
    ["fragment JWT", `https://example.com/page#${JWT}`, "credential_fragment"],
    ["Slack webhook host", "https://hooks.slack.com/services/T000/B000/XXXXXXXX", "credential_host"],
    ["Discord webhook subdomain", "https://canary.discord.com/api/webhooks/123/abc", "credential_host"],
    ["Telegram bot", "https://api.telegram.org/bot123456:ABCdef/getMe", "credential_host"],
    ["nested next URL with token", "https://example.com/login?next=%2Freset%3Ftoken%3Dabc", "credential_query_name"],
    ["nested absolute URL with signature", "https://example.com/r?u=https%3A%2F%2Fcdn.example.com%2Ff%3FX-Amz-Signature%3Dx", "credential_query_name"],
    ["credential", "https://example.com/a?credential=abc", "credential_query_name"],
    ["credentials", "https://example.com/a?credentials=abc", "credential_query_name"],
    ["private_key", "https://example.com/a?private_key=abc", "credential_query_name"],
    ["secret_key", "https://example.com/a?secret_key=abc", "credential_query_name"],
    ["camelCase secretKey", "https://example.com/a?secretKey=abc", "credential_query_name"],
    ["access_key", "https://example.com/a?access_key=abc", "credential_query_name"],
    ["camelCase accessKeyId", "https://example.com/a?accessKeyId=abc", "credential_query_name"],
    ["auth_key", "https://example.com/a?auth_key=abc", "credential_query_name"],
    ["percent-encoded name %61ccess_token", "https://example.com/a?%61ccess_token=abc", "credential_query_name"],
    ["plus-joined name access+token", "https://example.com/a?access+token=abc", "credential_query_name"],
    ["dot-joined name access.token", "https://example.com/a?access.token=abc", "credential_query_name"],
    ["zero-width inside a name", "https://example.com/a?acc%E2%80%8Bess_token=abc", "credential_query_name"],
    ["dot-joined api.key (normalisation only)", "https://example.com/a?api.key=abc", "credential_query_name"],
    ["plus-joined api+key (normalisation only)", "https://example.com/a?api+key=abc", "credential_query_name"],
    ["zero-width inside passwd (normalisation only)", "https://example.com/a?pass%E2%80%8Bwd=abc", "credential_query_name"],
    ["encoded space next to an invalid byte before a key prefix (ASCII fallback only)", "https://example.com/a?x=%FF%20ghp_abcdefghijklmnopqrstuvwxyz0123456789", "credential_value"],
    ["semicolon-separated query", "https://example.com/a?a=1;token=abc", "credential_query_name"],
    ["Bearer token with + as space", "https://example.com/a?h=Bearer+ghp_abcdefghijklmnopqrstuvwxyz0123456789", "credential_value"],
    ["Basic credential", "https://example.com/a?h=Basic%20dXNlcjpwYXNz", "credential_value"],
    ["path segment access_token=…", "https://example.com/access_token=abc/next", "credential_path"],
    ["path segment token=…", "https://example.com/files/token=abc/", "credential_path"],
    ["bracket name access_token[]", "https://example.com/a?access_token[]=abc", "credential_query_name"],
    ["bracket name access_token[0]", "https://example.com/a?access_token%5B0%5D=abc", "credential_query_name"],
    ["nested bracket name data[access_token]", "https://example.com/a?data[access_token]=abc", "credential_query_name"],
    ["encoded '=' inside the name", "https://example.com/a?access_token%3Dabc", "credential_query_name"],
    ["unseparated xApiKey", "https://example.com/a?xApiKey=abc", "credential_query_name"],
    ["unseparated userPassword", "https://example.com/a?userPassword=abc", "credential_query_name"],
    ["unseparated OSSAccessKeyId", "https://bucket.oss.example.com/o?OSSAccessKeyId=abc&Signature=x", "credential_query_name"],
    ["sasToken", "https://example.com/a?sasToken=abc", "credential_query_name"],
    ["sharedAccessSignature", "https://example.com/a?sharedAccessSignature=abc", "credential_query_name"],
    ["sessionKey", "https://example.com/a?sessionKey=abc", "credential_query_name"],
    ["auth with a token-shaped value", "https://example.com/a?auth=a1b2c3d4e5f6g7h8i9j0", "credential_query_name"],
    ["Token auth scheme (token68 punctuation)", "https://example.com/a?h=Token%20abcDEF123%2Fxyz789", "credential_value"],
    ["Google Books sig (signature form, dropped by the owner's rule)", "https://books.google.com/books?id=abc&pg=PA12&sig=ACfU3U0abcdef", "credential_query_name"],
    // ── Option-B hardening (R3 reproductions) ──
    ["Discord versioned webhook", "https://discord.com/api/v10/webhooks/1/abcdef", "credential_host"],
    ["Discord webhook, trailing-dot host", "https://discord.com./api/webhooks/1/abcdef", "credential_host"],
    ["Slack webhook, trailing-dot host", "https://hooks.slack.com./services/T000/B000/XXXX", "credential_host"],
    ["Discord webhook, subdomain + version", "https://ptb.discord.com/api/v9/webhooks/1/abc", "credential_host"],
    ["nested scheme-less host/path value", "https://example.com/login?next=y.com/reset?token=abc", "credential_query_name"],
    ["nested protocol-relative value", "https://example.com/go?u=%2F%2Fcdn.example.net%2Ff%3Faccess_token%3Dabc", "credential_query_name"],
    ["nested query-relative value", "https://example.com/go?u=%3Fsig%3Dabc", "credential_query_name"],
    ["bare credential context path /access_token/<v>", "https://x.com/access_token/ya29.abcdef123456", "credential_path"],
    ["reset-password context with UUID token", "https://example.com/account/reset-password/3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f", "credential_path"],
    ["password-reset context with opaque token", "https://example.com/password-reset/Zx81kQp4Lm", "credential_path"],
    ["password-only userinfo", "https://:hunter2@example.com/a", "userinfo"],
    ["pass", "https://example.com/a?pass=hunter2", "credential_query_name"],
    ["pw", "https://example.com/a?pw=hunter2", "credential_query_name"],
    ["sid", "https://example.com/a?sid=9f2b1c", "credential_query_name"],
    ["fragment credential with a value", "https://example.com/page#token=abc", "credential_fragment"],
    ["full-width credential name (NFKC)", "https://example.com/a?%EF%BD%81%EF%BD%83%EF%BD%83%EF%BD%85%EF%BD%93%EF%BD%93_%EF%BD%94%EF%BD%8F%EF%BD%8B%EF%BD%85%EF%BD%8E=abc", "credential_query_name"],
    ["soft hyphen inside a name", "https://example.com/a?access_t%C2%ADoken=abc", "credential_query_name"],
    ["Bearer: colon syntax", "https://example.com/a?h=Bearer%3A%20eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIzNA", "credential_value"],
    ["Bearer:token without space", "https://example.com/a?h=Bearer%3AdGhpc2lzYXRva2VuMTIz%3D%3D", "credential_value"],
    ["Basic base64 user:password", "https://example.com/a?h=Basic%20dXNlcjpwYXNz", "credential_value"],
    ["key with an independent credential value (JWT)", `https://example.com/a?key=${JWT}`, "credential_value"],
    ["joined family clientSecret", "https://example.com/a?clientSecret=abc", "credential_query_name"],
    ["joined family refreshToken", "https://example.com/a?refreshToken=abc", "credential_query_name"],
    ["joined family adminPassword", "https://example.com/a?adminPassword=abc", "credential_query_name"],
    ["joined family AWSAccessKeyId", "https://example.com/a?AWSAccessKeyId=abc", "credential_query_name"],
    // ── Round-4 reproductions (must drop) ──
    ["hash-route reset link", "https://example.com/#/reset-password?token=abc123XYZ", "credential_fragment"],
    ["hash-route OAuth callback", "https://app.example.com/#/auth/callback?access_token=abc", "credential_fragment"],
    ["hashbang route", "https://example.com/#!/cb?token=abc", "credential_fragment"],
    ["hash-route credential path context", "https://example.com/#/reset-password/3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f", "credential_fragment"],
    ["nested password-only userinfo", "https://example.com/r?next=https%3A%2F%2F%3Ap%40x.com%2F", "userinfo"],
    ["nested protocol-relative userinfo", "https://example.com/r?next=%2F%2Fu%3Ap%40x.com%2F", "userinfo"],
    ["nested host + query, no path", "https://example.com/r?u=x.com%3Ftoken%3D1", "credential_query_name"],
    ["nested localhost", "https://example.com/r?u=localhost%2Fa%3Ftoken%3D1", "credential_query_name"],
    ["nested IPv4", "https://example.com/r?u=10.0.0.1%2Fa%3Ftoken%3D1", "credential_query_name"],
    ["nested value with surrounding whitespace", "https://example.com/r?u=%20https%3A%2F%2Fx.com%2F%3Ftoken%3D1%20", "credential_query_name"],
    ["double-encoded nested URL", "https://example.com/r?next=https%253A%252F%252Fx.com%252F%253Ftoken%253Dabc", "credential_query_name"],
    ["Discord webhook, encoded path", "https://discord.com/api/%77ebhooks/1/abc", "credential_host"],
    ["Discord webhook, doubled slash", "https://discord.com/api//webhooks/1/abc", "credential_host"],
    ["Discord webhook, upper-case path", "https://discord.com/API/Webhooks/1/abc", "credential_host"],
    ["Discord webhook, encoded slashes", "https://discord.com/api/webhooks%2F1%2Fabc", "credential_host"],
    ["personal_access_token", "https://example.com/a?personal_access_token=abc", "credential_query_name"],
    ["consumer_secret", "https://example.com/a?consumer_secret=abc", "credential_query_name"],
    ["consumer_key", "https://example.com/a?consumer_key=abc", "credential_query_name"],
    ["new_password", "https://example.com/a?new_password=abc", "credential_query_name"],
    ["newPassword", "https://example.com/a?newPassword=abc", "credential_query_name"],
    ["verify_token", "https://example.com/a?verify_token=abc", "credential_query_name"],
    ["unsubscribe_token", "https://example.com/a?unsubscribe_token=abc", "credential_query_name"],
    ["magic_link_token", "https://example.com/a?magic_link_token=abc", "credential_query_name"],
    ["github_token", "https://example.com/a?github_token=abc", "credential_query_name"],
    ["hf_token", "https://example.com/a?hf_token=abc", "credential_query_name"],
    ["bot_token", "https://example.com/a?bot_token=abc", "credential_query_name"],
    ["hmac", "https://example.com/a?hmac=abc", "credential_query_name"],
    ["otp", "https://example.com/a?otp=123456", "credential_query_name"],
    ["passcode", "https://example.com/a?passcode=1234", "credential_query_name"],
    ["control character inside a name", "https://example.com/a?access%01_token=abc", "credential_query_name"],
    ["double underscore access__token", "https://example.com/a?access__token=abc", "credential_query_name"],
    ["Key-Pair-Id alone", "https://d1.cloudfront.net/v.mp4?Key-Pair-Id=K2JCJMDEHXQW5F", "credential_query_name"],
    ["Basic unpadded base64 user:password", "https://example.com/a?h=Basic%20aGVsbG86d29ybGQ", "credential_value"],
    ["Bearer + padded base64 (plus read as space)", "https://example.com/a?h=Bearer+dGhpc2lzYXRva2VuMTIz%3D%3D", "credential_value"],
    ["Bearer: + long mixed token with interior slash", "https://example.com/a?h=Bearer%3A%20AbC123xyz%2FDEF456uvw", "credential_value"],
    ["long presigned URL counts as a privacy drop, not over-limit", "https://bucket.s3.amazonaws.com/" + "k".repeat(500) + "?X-Amz-Signature=abc", "credential_query_name"],
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
    ["text fragment mentioning Bearer prose", "https://example.com/page#:~:text=Bearer%20authentication%20scheme"],
    ["Bearer prose in a search query", "https://www.google.com/search?q=Bearer%20authentication%20explained"],
    ["Bearer prose with + spaces", "https://www.google.com/search?q=Bearer+authentication+explained"],
    ["Bearer heading fragment", "https://example.com/docs#Bearer%20authentication"],
    ["docs anchor #code=sample (ambiguous name)", "https://example.com/docs#code=sample"],
    ["percent sign in a slug", "https://example.com/100%-guide"],
    ["trailing percent in a query", "https://example.com/?q=100%"],
    ["percent in a fragment", "https://en.wikipedia.org/wiki/Percent_sign#100%"],
    ["legacy-charset query (Latin-1 %E9)", "https://example.fr/recherche?q=caf%E9"],
    ["legacy-charset query (EUC-KR)", "https://example.kr/search?q=%C7%D1%B1%DB"],
    ["truncated UTF-8 escape", "https://example.com/a?q=%E0%A4%A"],
    ["pagination page_token", "https://example.com/list?page_token=CAESABC"],
    ["pagination next_token", "https://example.com/list?next_token=abc"],
    ["pagination continuation_token", "https://example.com/list?continuation_token=abc"],
    ["pagination sync_token", "https://example.com/list?sync_token=abc"],
    ["sort_key (no bare _key suffix rule)", "https://example.com/list?sort_key=date&designer_key=abc"],
    // ── Option-B hardening: ordinary names / prose / contexts that must stay usable ──
    ["designToken", "https://example.com/ui?designToken=primary"],
    ["design_token", "https://example.com/ui?design_token=blue"],
    ["cryptoToken", "https://example.com/coins?cryptoToken=BTC"],
    ["crypto-token", "https://example.com/coins?crypto-token=BTC"],
    ["timeSignature / keySignature", "https://example.com/music?timesignature=4-4&keysignature=Cmajor"],
    ["mailSignature", "https://example.com/settings?mailsignature=on"],
    ["forgotPassword / resetPassword flags", "https://example.com/help?forgotpassword=1&resetpassword=true"],
    ["topSecret / showSecret", "https://example.com/film?topsecret=yes&showsecret=no&songsecret=1"],
    ["gameOfToken", "https://example.com/game?gameoftoken=1"],
    ["Bearer prose with a digit", "https://example.com/a?ref=Bearer+authentication2"],
    ["token prose with a digit", "https://www.google.com/search?q=token+economics2026"],
    ["Basic prose with a digit", "https://example.com/tag/Basic%20Python3Course"],
    ["Token conference name", "https://example.com/events?q=Token+2049Dubai"],
    ["Bearer bonds with a digit", "https://example.com/a?ref=Bearer+Bonds1990s"],
    ["Token Ring fragment", "https://en.wikipedia.org/wiki/Token_Ring#Token%20passing2"],
    ["Bearer: colon prose", "https://example.com/a?q=Bearer%3A%20the%20movie"],
    ["q=/… search for a path with a token is a search, not a link", "https://www.google.com/search?q=%2Fapi%2Fv1%3Ftoken%3Dabc"],
    ["nested value that is prose, not a URL", "https://example.com/r?next=see%20page.com%2Fdocs%20for%20info"],
    ["generic key with plain hex", "https://example.com/obj?key=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["generic key with a UUID", "https://example.com/obj?key=3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f"],
    ["reset-password page without a token", "https://example.com/account/reset-password"],
    ["reset-password followed by a slug", "https://example.com/help/reset-password/how-to-reset.html"],
    ["UUID article path (no credential context)", "https://example.com/articles/3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f"],
    ["empty fragment credential value", "https://example.com/page#token="],
    ["absent fragment credential value", "https://example.com/page#token"],
    ["ordinary Unicode names", "https://example.com/a?caf%C3%A9=cr%C3%A8me&%E6%A4%9C%E7%B4%A2=%E3%83%86%E3%82%B9%E3%83%88"],
    ["Discord non-webhook API path", "https://discord.com/api/v10/channels/1/messages"],
    ["lookalike host (not the webhook host)", "https://notdiscord.com/api/webhooks/1/abc"],
    ["lookalike suffix host", "https://discord.com.evil.example/api/webhooks/1/abc"],
    // ── Round-4 reproductions (must stay usable) ──
    ["colon prose with + space (Bearer:+authentication)", "https://example.com/?title=Bearer%3A+authentication"],
    ["Token:+The+Movie", "https://example.com/?title=Token:+The+Movie"],
    ["Basic:+cooking", "https://example.com/?title=Basic:+cooking"],
    ["q=Bearer:+what+is+it", "https://example.com/?q=Bearer:+what+is+it"],
    ["search Token: a novel", "https://example.com/search?q=Token%3A+a+novel"],
    ["path Token:+A+Novel", "https://example.com/book/Token:+A+Novel"],
    ["slash prose Token economy/web3", "https://example.com/?t=Token+economy%2Fweb3"],
    ["slash prose Basic chemistry/biology", "https://example.com/?t=Basic+chemistry/biology"],
    ["masterkey", "https://example.com/music?masterkey=C"],
    ["id_key", "https://example.com/a?id_key=3"],
    ["user_key", "https://example.com/a?user_key=alice"],
    ["account_key", "https://example.com/a?account_key=12345"],
    ["share_key", "https://example.com/a?share_key=7"],
    ["download_key", "https://example.com/a?download_key=ebook"],
    ["confirmation_key", "https://example.com/a?confirmation_key=yes"],
    ["service_key", "https://example.com/a?service_key=hvac"],
    ["securityKey", "https://example.com/a?securityKey=yubikey"],
    ["app_key=public", "https://example.com/a?app_key=public"],
    ["appSig / idsig", "https://example.com/a?appSig=1&idsig=1"],
    ["api_key_id (a key identifier)", "https://example.com/a?api_key_id=12345"],
    ["docs access-token v2", "https://example.com/docs/access-token/v2"],
    ["docs access-token OAuth2", "https://example.com/docs/access-token/OAuth2"],
    ["docs api-key Overview", "https://example.com/docs/api-key/Overview"],
    ["docs reset-password index.md", "https://example.com/docs/reset-password/index.md"],
    ["tag reset-password page 2", "https://example.com/tag/reset-password/2/"],
    ["PyPI api-key version", "https://pypi.org/project/api-key/0.1.2/"],
    ["upper-case slug ASIAPACIFICECONOMICS", "https://example.com/ASIAPACIFICECONOMICS"],
    ["prose beginning like a path is not a nested URL", "https://example.com/r?note=%2Fa%3Ftoken%3Dx%20for%20details"],
    ["NYT share link auth=login-email", "https://www.nytimes.com/2026/10/01/world/story.html?auth=login-email&login=email"],
    ["empty credential values carry no secret", "https://example.com/a?sessionid=&sig=&token="],
    ["value-less credential names", "https://example.com/a?token&access_token"],
    ["nextPageToken pagination", "https://example.com/list?nextPageToken=CAESABC"],
    ["search query mentioning api key", "https://www.bing.com/search?q=how+to+rotate+an+api+key"],
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
