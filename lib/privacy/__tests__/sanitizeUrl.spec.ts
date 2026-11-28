/**
 * Privacy remediation (2026-11-17) — the shared telemetry URL sanitizer.
 * Synthetic data only.
 */
import {
  REDACTED,
  SAFE_QUERY_PARAMS,
  sanitizeQueryString,
  sanitizeUrl,
  sanitizeUrlValue,
  sanitizeUrlsInText,
  scrubUrlFields,
  TRUNCATED,
} from "@/lib/privacy/sanitizeUrl";

const CLAIM = "SYNTHETIC_CLAIM_the moon is made of cheese";
const enc = encodeURIComponent(CLAIM);

describe("sanitizeUrl — sensitive params are redacted (value gone, name kept)", () => {
  it.each(["text", "claim", "q", "question", "redirect", "next", "selectedText", "email", "uid", "token", "someFutureParam"])(
    "redacts the value of ?%s=",
    (name) => {
      const out = sanitizeUrl(`https://convergepanel.com/verify?${name}=${enc}`);
      expect(out).toBe(`https://convergepanel.com/verify?${name}=${REDACTED}`);
      expect(out).not.toContain("SYNTHETIC_CLAIM");
      expect(out).not.toContain("cheese");
    }
  );

  it("redacts a claim nested inside redirect= (login/signup detour)", () => {
    const nested = encodeURIComponent(`/verify?source=extension&text=${enc}`);
    const out = sanitizeUrl(`https://convergepanel.com/signup?redirect=${nested}`);
    expect(out).toBe(`https://convergepanel.com/signup?redirect=${REDACTED}`);
    expect(out).not.toContain("cheese");
  });

  it("keeps allowlisted params verbatim alongside a redacted one, in order", () => {
    const out = sanitizeUrl(`/?tab=verify&claim=${enc}&utm_source=newsletter&page=2`);
    expect(out).toBe(`/?tab=verify&claim=${REDACTED}&utm_source=newsletter&page=2`);
  });

  it("collapses a param whose NAME is content (no '=') to a single token", () => {
    const out = sanitizeUrl(`/verify?${encodeURIComponent("Is the earth flat? yes")}`);
    expect(out).toBe(`/verify?${REDACTED}`);
    expect(out).not.toContain("earth");
  });

  it("keeps a plain identifier-shaped bare flag name (value-less)", () => {
    expect(sanitizeUrl("/verify?debug")).toBe(`/verify?debug=${REDACTED}`);
  });

  it("drops the fragment entirely (Phase 8D.3.1 invitation tokens) and redacts the query", () => {
    const out = sanitizeUrl(`https://convergepanel.com/workspace-invitations/accept?claim=${enc}#invitationId=i&token=SECRET`);
    expect(out).toBe(`https://convergepanel.com/workspace-invitations/accept?claim=${REDACTED}`);
    expect(out).not.toContain("SECRET");
  });

  it("drops a fragment-carried claim (#text=)", () => {
    expect(sanitizeUrl(`/verify?source=extension#text=${enc}`)).toBe("/verify?source=extension");
  });

  it("handles a bare ?query and an empty query", () => {
    expect(sanitizeUrl(`?q=${enc}`)).toBe(`?q=${REDACTED}`);
    expect(sanitizeUrl("/verify?")).toBe("/verify");
    expect(sanitizeUrl("/verify?&&")).toBe("/verify");
  });

  it("decodes param names before the allowlist check (utm%5Fsource) and survives malformed escapes", () => {
    expect(sanitizeUrl("/verify?utm%5Fsource=a")).toBe("/verify?utm%5Fsource=a");
    expect(sanitizeUrl("/verify?%E0%A4%A=1")).toBe(`/verify?${REDACTED}`);
  });

  it("structural hardening: a path is replaced by its route template; a non-URL word is left unchanged (control)", () => {
    expect(sanitizeUrl("https://convergepanel.com/pricing")).toBe("https://convergepanel.com/pricing");
    expect(sanitizeUrl("/workspace/team/ws-1/research/run-1")).toBe("/workspace/team/[workspaceId]/research/[runId]");
    expect(sanitizeUrl("https://convergepanel.com/dashboard")).toBe("https://convergepanel.com/[unmatched]");
    for (const u of ["", "not a url"]) expect(sanitizeUrl(u)).toBe(u);
  });

  it("keeps every allowlisted param's well-shaped value (control: non-sensitive telemetry still flows)", () => {
    const sample: Record<string, string> = { tab: "verify", page: "2", limit: "30", offset: "0", signedOut: "1", success: "true", canceled: "true", upgraded: "1" };
    for (const name of SAFE_QUERY_PARAMS) {
      const v = sample[name] ?? (name.startsWith("utm_") ? "spring-2026_news.letter" : "needs_review");
      expect(sanitizeUrl(`/pricing?${name}=${v}`)).toBe(`/pricing?${name}=${v}`);
    }
  });

  it("round 2: an allowlisted NAME with a content-shaped VALUE is redacted (?tab=<claim>)", () => {
    // R3: utm_* deliberately accept human-readable campaign text (marketer-controlled names, owner requirement);
    // every OTHER allowlisted name must reject content-shaped values.
    for (const name of SAFE_QUERY_PARAMS) {
      if (name.startsWith("utm_")) continue;
      const out = sanitizeUrl(`/pricing?${name}=${enc}`);
      expect(out).toBe(`/pricing?${name}=${REDACTED}`);
    }
    expect(sanitizeUrl("/?tab=moon")).toBe(`/?tab=${REDACTED}`); // tab is enumerated
    expect(sanitizeUrl("/?page=2abc")).toBe(`/?page=${REDACTED}`);
    expect(sanitizeUrl(`/?utm_campaign=${encodeURIComponent("x".repeat(101))}`)).toBe(`/?utm_campaign=${REDACTED}`);
  });

  it("round 2: ';' is a separator — a claim after ';' is redacted", () => {
    expect(sanitizeUrl(`/?tab=verify;claim=${enc}`)).toBe(`/?tab=verify&claim=${REDACTED}`);
    expect(sanitizeUrl(`/?source=extension;text=${enc}`)).not.toContain("cheese");
  });

  it("the allowlist contains no content-, identity- or redirect-bearing name", () => {
    for (const bad of ["text", "claim", "q", "question", "redirect", "next", "selectedText", "email", "uid", "userId", "asUid", "token", "name", "search", "session_id", "runId"]) {
      expect(SAFE_QUERY_PARAMS.has(bad)).toBe(false);
    }
  });
});

describe("sanitizeQueryString / sanitizeUrlValue", () => {
  it("sanitizes with or without a leading '?'", () => {
    expect(sanitizeQueryString(`?text=${enc}&tab=verify`)).toBe(`text=${REDACTED}&tab=verify`);
    expect(sanitizeQueryString(`text=${enc}`)).toBe(`text=${REDACTED}`);
    expect(sanitizeQueryString("")).toBe("");
  });

  it("passes non-strings through", () => {
    expect(sanitizeUrlValue(42)).toBe(42);
    expect(sanitizeUrlValue(null)).toBeNull();
  });
});

describe("sanitizeUrlsInText", () => {
  it("sanitizes absolute and relative URLs inside free text, leaving the rest", () => {
    const text = `GET https://convergepanel.com/api/verify-claim?q=${enc} then "/verify?text=${enc}" done`;
    const out = sanitizeUrlsInText(text);
    expect(out).toBe(`GET https://convergepanel.com/api/verify-claim?q=${REDACTED} then "/verify?text=${REDACTED}" done`);
  });

  it("round 2: uppercase schemes, scheme-less host/path?q=, bare ?q= and app:/// frames are sanitized", () => {
    const text = `HTTPS://CONVERGEPANEL.COM/verify?text=${enc} and convergepanel.com/verify?text=${enc} and ?q=${enc} at app:///_next/x.js?claim=${enc}`;
    const out = sanitizeUrlsInText(text);
    expect(out).not.toContain("cheese");
    // Structural hardening: a scheme-less `host/path` cannot be told apart from a relative path, so its path is replaced.
    expect(out).toBe(`HTTPS://CONVERGEPANEL.COM/verify?text=${REDACTED} and [relative-path]?text=${REDACTED} and ?q=${REDACTED} at app:///_next/x.js?claim=${REDACTED}`);
  });

  it("leaves text with no URL unchanged (control)", () => {
    expect(sanitizeUrlsInText("TypeError: x is not a function?")).toBe("TypeError: x is not a function?");
    expect(sanitizeUrlsInText("GET /api/run-panel")).toBe("GET /api/run-panel");
  });
});

describe("scrubUrlFields", () => {
  it("scrubs URL keys, url arrays, query keys and URL-bearing text at any depth; leaves other fields", () => {
    const payload: any = {
      $current_url: `https://convergepanel.com/?claim=${enc}`,
      nested: { deeper: { href: `/signup?redirect=${enc}`, label: `keep ${CLAIM}?x=1` } },
      urls: [`/verify?text=${enc}`, 7],
      request: { query_string: `text=${enc}&tab=verify` },
      spans: [{ description: `GET /api/verify-claim?q=${enc}`, data: { "url.full": `https://h/x?q=${enc}`, "http.query": `?q=${enc}` } }],
      count: 3,
    };
    scrubUrlFields(payload);
    expect(payload.$current_url).toBe(`https://convergepanel.com/?claim=${REDACTED}`);
    expect(payload.nested.deeper.href).toBe(`/signup?redirect=${REDACTED}`);
    // Structural hardening: every string is URL-sanitized, whatever its key (an un-named SDK field cannot carry a query).
    expect(payload.nested.deeper.label).toBe(`keep ${CLAIM}?x=${REDACTED}`);
    expect(payload.urls).toEqual([`/verify?text=${REDACTED}`, 7]);
    expect(payload.request.query_string).toBe(`text=${REDACTED}&tab=verify`);
    expect(payload.spans[0].description).toBe(`GET /api/verify-claim?q=${REDACTED}`);
    expect(payload.spans[0].data["url.full"]).toBe(`https://h/[external-path]?q=${REDACTED}`);
    expect(payload.spans[0].data["http.query"]).toBe(`q=${REDACTED}`);
    expect(payload.count).toBe(3);
  });

  it("scrubs query_string in pair-array and object forms", () => {
    const a: any = { query_string: [["claim", CLAIM], ["tab", "verify"], ["Is it?", "x"]] };
    scrubUrlFields(a);
    expect(a.query_string).toEqual([["claim", REDACTED], ["tab", "verify"], [REDACTED, REDACTED]]);
    const o: any = { query_string: { claim: CLAIM, tab: "verify" } };
    scrubUrlFields(o);
    expect(o.query_string).toEqual({ claim: REDACTED, tab: "verify" });
  });

  it("round 2: DOM src/srcset/action, stack-frame filename/abs_path, exception value and fragment keys are scrubbed", () => {
    const p: any = {
      attributes: { src: `/img?q=${enc}`, srcset: `/a.png?text=${enc} 2x`, action: `/submit?claim=${enc}` },
      frames: [{ filename: `app:///page.js?claim=${enc}`, abs_path: `https://h/x.js?q=${enc}`, function: "f" }],
      values: [{ type: "Error", value: `failed at https://h/?claim=${enc}` }],
      "http.fragment": `text=${enc}`,
      "url.fragment": `#text=${enc}`,
      $exception_message: `boom ?q=${enc}`,
    };
    scrubUrlFields(p);
    expect(JSON.stringify(p)).not.toContain("cheese");
    expect(p.frames[0].function).toBe("f");
    expect(p["http.fragment"]).toBe(REDACTED);
  });

  it("round 2: depth bound FAILS CLOSED — an object below the bound is replaced, never sent unscrubbed", () => {
    let deep: any = { url: `/verify?q=${enc}`, inner: { href: `/y?q=${enc}` } };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    scrubUrlFields(deep); // default bound 12
    expect(JSON.stringify(deep)).not.toContain("cheese");
    expect(JSON.stringify(deep)).toContain(TRUNCATED);
    const arr: any = { a: [[[[[[[[[[[[[{ url: `/verify?q=${enc}` }]]]]]]]]]]]]] };
    scrubUrlFields(arr);
    expect(JSON.stringify(arr)).not.toContain("cheese");
  });

  it("is cycle-safe and honours maxDepth", () => {
    const a: any = { url: `/verify?q=${enc}` };
    a.self = a;
    expect(() => scrubUrlFields(a)).not.toThrow();
    expect(a.url).toBe(`/verify?q=${REDACTED}`);

    let deep: any = { url: `/verify?q=${enc}` };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    scrubUrlFields(deep, { maxDepth: 256 });
    let cursor = deep;
    while (cursor.child) cursor = cursor.child;
    expect(cursor.url).toBe(`/verify?q=${REDACTED}`);
  });
});

describe("R3 (review MINOR) — legitimate UTM and tab values are not dropped; sensitive names still redacted", () => {
  it.each([
    "/?utm_campaign=Black+Friday",
    "/?utm_campaign=Black%20Friday",
    "/?utm_source=news-letter&utm_medium=email",
    "/?utm_content=Spring%20Sale%3A%2020%25%20off",
    "/admin?tab=users",
    "/admin?tab=runs",
    "/admin?tab=policies",
    "/governance?tab=queue",
    "/governance?tab=audit",
  ])("keeps %s", (u) => {
    expect(sanitizeUrl(u)).toBe(u);
  });
  it("still redacts sensitive names regardless of value shape, and over-long / control-char UTM values", () => {
    expect(sanitizeUrl("/?claim=Black+Friday")).toBe(`/?claim=${REDACTED}`);
    expect(sanitizeUrl(`/?utm_campaign=${"x".repeat(101)}`)).toBe(`/?utm_campaign=${REDACTED}`);
    expect(sanitizeUrl("/?utm_campaign=a%0Ab")).toBe(`/?utm_campaign=${REDACTED}`);
    expect(sanitizeUrl(`/?tab=${encodeURIComponent("the moon is cheese")}`)).toBe(`/?tab=${REDACTED}`);
  });
});
