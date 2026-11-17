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
    expect(sanitizeUrl("/x?debug")).toBe(`/x?debug=${REDACTED}`);
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
    expect(sanitizeUrl("/x?")).toBe("/x");
    expect(sanitizeUrl("/x?&&")).toBe("/x");
  });

  it("decodes param names before the allowlist check (utm%5Fsource) and survives malformed escapes", () => {
    expect(sanitizeUrl("/x?utm%5Fsource=a")).toBe("/x?utm%5Fsource=a");
    expect(sanitizeUrl("/x?%E0%A4%A=1")).toBe(`/x?${REDACTED}`);
  });

  it("leaves a URL without query or fragment byte-for-byte unchanged (control)", () => {
    for (const u of ["https://convergepanel.com/dashboard", "/workspace/team/ws-1/research/run-1", "", "not a url"]) {
      expect(sanitizeUrl(u)).toBe(u);
    }
  });

  it("keeps every allowlisted param's value (control: non-sensitive telemetry still flows)", () => {
    for (const name of SAFE_QUERY_PARAMS) {
      expect(sanitizeUrl(`/p?${name}=v1`)).toBe(`/p?${name}=v1`);
    }
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
    const text = `GET https://convergepanel.com/api/x?q=${enc} then "/verify?text=${enc}" done`;
    const out = sanitizeUrlsInText(text);
    expect(out).toBe(`GET https://convergepanel.com/api/x?q=${REDACTED} then "/verify?text=${REDACTED}" done`);
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
      spans: [{ description: `GET /api/x?q=${enc}`, data: { "url.full": `https://h/x?q=${enc}`, "http.query": `?q=${enc}` } }],
      count: 3,
    };
    scrubUrlFields(payload);
    expect(payload.$current_url).toBe(`https://convergepanel.com/?claim=${REDACTED}`);
    expect(payload.nested.deeper.href).toBe(`/signup?redirect=${REDACTED}`);
    expect(payload.nested.deeper.label).toBe(`keep ${CLAIM}?x=1`); // not a URL key: untouched (control)
    expect(payload.urls).toEqual([`/verify?text=${REDACTED}`, 7]);
    expect(payload.request.query_string).toBe(`text=${REDACTED}&tab=verify`);
    expect(payload.spans[0].description).toBe(`GET /api/x?q=${REDACTED}`);
    expect(payload.spans[0].data["url.full"]).toBe(`https://h/x?q=${REDACTED}`);
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

  it("is cycle-safe and honours maxDepth", () => {
    const a: any = { url: `/x?q=${enc}` };
    a.self = a;
    expect(() => scrubUrlFields(a)).not.toThrow();
    expect(a.url).toBe(`/x?q=${REDACTED}`);

    let deep: any = { url: `/x?q=${enc}` };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    scrubUrlFields(deep, { maxDepth: 256 });
    let cursor = deep;
    while (cursor.child) cursor = cursor.child;
    expect(cursor.url).toBe(`/x?q=${REDACTED}`);
  });
});
