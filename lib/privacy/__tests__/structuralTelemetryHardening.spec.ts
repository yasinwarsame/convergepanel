/**
 * Structural telemetry hardening (private advisory GHSA-655j-5f43-92pw follow-up). Synthetic values only.
 *
 * Invariants:
 *   S1  a first-party path leaves the app only as the template of a real route (dynamic values never emitted;
 *       enumerated SEO slugs excepted), a safe build asset, or the fixed `/[unmatched]` placeholder;
 *   S2  third-party paths are replaced; userinfo and credential-shaped hosts are dropped; opaque schemes redacted;
 *   S3  every string anywhere in a telemetry payload is URL-sanitized, whatever its key;
 *   S4  the Sentry transmission boundary sanitizes every envelope item, including the Replay recording's meta
 *       `href` and DOM URL attributes, and drops what it cannot parse; the `dsn` header is untouched;
 *   S6  the `/ingest` reverse proxy forwards no Cookie / Authorization header (middleware);
 *   S5  the SDK configuration wires the boundary, the no-referrer transport, Replay attribute masking, the span /
 *       log / metric hooks and the disabled PostHog `/flags` request; the site header is `strict-origin`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { sanitizeUrl, sanitizeUrlsInText, scrubUrlFields, REDACTED } from "@/lib/privacy/sanitizeUrl";
import { TELEMETRY_ROUTE_PATTERNS, TELEMETRY_SLUG_ALLOWLIST } from "@/lib/privacy/telemetryRouteManifest.generated";
import { scrubReplayRecordingPayload, scrubSentryEnvelope } from "@/lib/privacy/sentryEnvelopeScrub";
import { REPLAY_MASKED_ATTRIBUTES, scrubSentryLogOrMetric, scrubSentrySpan } from "@/lib/privacy/sentryScrub";

const ROOT = join(__dirname, "../../..");
// 43 characters, base64url, both letter cases: the invitation token shape (randomBytes(32).toString("base64url")).
const TOK = "Zq7xK2mPvR9tLwB4nYc8HdJ3fGs6Ue1Ao5Ti0Vb-W_y";
const INV = "INVsynthetic0123456789";
const WS = "WSsynthetic7777";
const ORIGIN = "https://convergepanel.com";

const noSecret = (s: string) => !s.includes(TOK) && !s.includes(INV) && !s.includes(WS) && !s.includes(TOK.slice(0, 20));

test("the synthetic token has the real token shape", () => {
  expect(TOK).toHaveLength(43);
  expect(TOK).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

describe("S1 first-party paths: route templates only", () => {
  it("every dynamic slot of every real route: a credential-shaped value is replaced by the slot name", () => {
    let checked = 0;
    for (const pattern of TELEMETRY_ROUTE_PATTERNS) {
      if (!pattern.includes("[")) continue;
      const path = pattern.replace(/\[\.\.\.[A-Za-z0-9_]+\]/g, `${TOK}/${INV}`).replace(/\[[A-Za-z0-9_]+\]/g, TOK);
      const out = sanitizeUrl(`${ORIGIN}${path}?token=${TOK}&invitationId=${INV}#invitationId=${INV}&token=${TOK}`);
      expect(out).toBe(`${ORIGIN}${pattern}?token=${REDACTED}&invitationId=${REDACTED}`);
      expect(noSecret(out)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("every static route is kept exactly (control: route-level analytics keep working)", () => {
    for (const pattern of TELEMETRY_ROUTE_PATTERNS.filter((p) => !p.includes("["))) {
      expect(sanitizeUrl(`${ORIGIN}${pattern}`)).toBe(`${ORIGIN}${pattern}`);
    }
  });

  it("static segments win over dynamic ones (Next.js precedence)", () => {
    expect(sanitizeUrl(`/workspace/team/${WS}/claims/new`)).toBe("/workspace/team/[workspaceId]/claims/new");
    expect(sanitizeUrl(`/workspace/team/${WS}/claims/${TOK}`)).toBe("/workspace/team/[workspaceId]/claims/[verificationId]");
    expect(sanitizeUrl(`/workspace/team/${WS}/projects/p1/research/new`)).toBe("/workspace/team/[workspaceId]/projects/[projectId]/research/new");
  });

  it("only an enumerated SEO slug keeps its value", () => {
    const slug = TELEMETRY_SLUG_ALLOWLIST["/learn/[slug]"][0];
    expect(sanitizeUrl(`/learn/${slug}`)).toBe(`/learn/${slug}`);
    expect(sanitizeUrl(`/learn/${slug}-x`)).toBe("/learn/[slug]");
    expect(sanitizeUrl(`/learn/${TOK}`)).toBe("/learn/[slug]");
    expect(sanitizeUrl(`/learn/${slug.toUpperCase()}`)).toBe("/learn/[slug]");
  });

  it.each([
    ["%23-rewritten acceptance link", `/workspace-invitations/accept%23invitationId%3D${INV}%26token%3D${TOK}`],
    ["partly encoded", `/workspace-invitations/accept%23invitationId=${INV}&token=${TOK}`],
    ["double-encoded", `/workspace-invitations/accept%2523invitationId%253D${INV}%2526token%253D${TOK}`],
    ["token as an extra segment", `/workspace-invitations/accept/${TOK}`],
    ["token in place of a static segment", `/workspace-invitations/${TOK}`],
    ["matrix parameter", `/workspace-invitations/accept;token=${TOK}`],
    ["case variant", `/Workspace-Invitations/accept/${TOK}`],
    ["empty segment", `/workspace-invitations//accept/${TOK}`],
    ["dot segments", `/workspace-invitations/../${TOK}`],
    ["malformed escape", `/workspace-invitations/accept%E0%A4%A${TOK}`],
    ["fullwidth solidus", `/workspace-invitations／accept／${TOK}`],
    ["unknown route", `/no-such-route/${INV}/${TOK}`],
    ["bare token path", `/${TOK}`],
    ["token-named asset", `/_next/static/chunks/${TOK}.js`],
    ["asset with escapes", `/_next/static/chunks/a%3D${TOK}.js`],
    ["overlong", `/${"a/".repeat(2000)}${TOK}`],
  ])("%s -> /[unmatched]", (_name, path) => {
    for (const url of [path, `${ORIGIN}${path}`, `http://127.0.0.1:4041${path}`]) {
      const out = sanitizeUrl(`${url}#token=${TOK}`);
      expect(out.endsWith("/[unmatched]")).toBe(true);
      expect(noSecret(out)).toBe(true);
    }
  });

  it("an unrelated route carrying a credential-shaped id keeps only its template", () => {
    expect(sanitizeUrl(`${ORIGIN}/workspace/team/${TOK}/members`)).toBe(`${ORIGIN}/workspace/team/[workspaceId]/members`);
    expect(sanitizeUrl(`${ORIGIN}/api/workspace-invitations/${INV}/accept`)).toBe(`${ORIGIN}/api/workspace-invitations/[invitationId]/accept`);
  });

  it("a trailing slash is normalized; build assets are kept for source maps", () => {
    expect(sanitizeUrl(`${ORIGIN}/pricing/`)).toBe(`${ORIGIN}/pricing`);
    const chunk = `${ORIGIN}/_next/static/chunks/app/workspace/team/%5BworkspaceId%5D/page-0a1b2c3d4e5f6a7b.js`;
    expect(sanitizeUrl(chunk)).toBe(chunk);
    expect(sanitizeUrl(`${chunk}:12:345`)).toBe(`${chunk}:12:345`);
  });

  it("code-file paths are kept only in code-location fields (stack frames), never in page URLs", () => {
    const serverFrame = "/var/task/.next/server/app/api/workspace-invitations/[invitationId]/accept/route.js:10:4";
    expect(sanitizeUrl(serverFrame)).toBe("/[unmatched]");
    expect(sanitizeUrl(serverFrame, { codeLocation: true })).toBe(serverFrame);
    const frames: any = { frames: [{ filename: serverFrame, abs_path: `app:///_next/static/chunks/x-0a1b.js`, function: "f" }] };
    scrubUrlFields(frames);
    expect(frames.frames[0].filename).toBe(serverFrame);
    expect(frames.frames[0].abs_path).toBe("app:///_next/static/chunks/x-0a1b.js");
    expect(sanitizeUrl(`/var/task/${TOK}.js`, { codeLocation: true })).toBe("/[unmatched]");
    expect(sanitizeUrl(`app:///${TOK}.js`, { codeLocation: true })).toBe(`app:${REDACTED}`);
  });

  it("output is a fixed point (the sanitizer may run at several boundaries)", () => {
    const corpus = [
      `${ORIGIN}/workspace/team/${WS}/members?tab=claims&utm_source=x#t=${TOK}`,
      `/workspace-invitations/accept%23token%3D${TOK}`,
      `https://fonts.gstatic.com/s/${TOK}.woff2`,
      `blob:${ORIGIN}/${TOK}`,
      `team/${TOK}`,
      `GET ${ORIGIN}/api/user/runs/${TOK}/export?x=1 then /learn/${TOK}.`,
    ];
    for (const c of corpus) {
      const once = sanitizeUrlsInText(sanitizeUrl(c));
      expect(sanitizeUrlsInText(sanitizeUrl(once))).toBe(once);
    }
  });
});

describe("S2 origins, hosts and schemes", () => {
  it("third-party paths are replaced, origins kept", () => {
    expect(sanitizeUrl(`https://fonts.gstatic.com/s/${TOK}/a.woff2?x=1`)).toBe(`https://fonts.gstatic.com/[external-path]?x=${REDACTED}`);
    expect(sanitizeUrl(`//cdn.example.com/${TOK}`)).toBe("//cdn.example.com/[external-path]");
    expect(sanitizeUrl("https://us.i.posthog.com/")).toBe("https://us.i.posthog.com/");
  });

  it("userinfo and credential-shaped hosts are dropped", () => {
    expect(sanitizeUrl(`https://user:${TOK}@convergepanel.com/pricing`)).toBe(`${ORIGIN}/pricing`);
    expect(sanitizeUrl(`https://${TOK}.example.com/x`)).toBe("https://[redacted-host]/[external-path]");
    expect(sanitizeUrl(`HTTPS://CONVERGEPANEL.COM/pricing`)).toBe("HTTPS://CONVERGEPANEL.COM/pricing");
  });

  it("opaque schemes are reduced to scheme:[redacted]", () => {
    for (const scheme of ["blob", "data", "javascript", "mailto", "tel"]) {
      expect(sanitizeUrl(`${scheme}:${TOK}`)).toBe(`${scheme}:${REDACTED}`);
    }
    expect(sanitizeUrl("about:blank")).toBe("about:blank");
  });

  it("relative URLs with a path cannot be resolved and are replaced; bare words are kept unless credential-shaped", () => {
    expect(sanitizeUrl(`members/${TOK}`)).toBe("[relative-path]");
    expect(sanitizeUrl("<anonymous>")).toBe("<anonymous>");
    expect(sanitizeUrl(TOK)).toBe(REDACTED);
  });
});

describe("S3 every string, any key, any depth", () => {
  it("URLs and paths inside un-named SDK fields are sanitized", () => {
    const payload: any = {
      "next.span_name": `GET /workspace/team/${WS}/members`,
      "some.future.sdk.field": { list: [`see ${ORIGIN}/workspace-invitations/accept%23token%3D${TOK}`, `/admin/users/${INV}`] },
      $pathname: `/workspace/projects/${INV}`,
      $initial_pathname: `/workspace/team/${WS}`,
      "url.path": `/api/user/runs/${INV}`,
      plain: "keeps 50/50 and/or prose, issue #1",
      token: "phc_projectkey_not_a_url",
    };
    scrubUrlFields(payload);
    const json = JSON.stringify(payload);
    expect(noSecret(json)).toBe(true);
    expect(payload["next.span_name"]).toBe("GET /workspace/team/[workspaceId]/members");
    expect(payload.$pathname).toBe("/workspace/projects/[projectId]");
    expect(payload.plain).toBe("keeps 50/50 and/or prose, issue #1");
    expect(payload.token).toBe("phc_projectkey_not_a_url");
  });

  it("span, log and metric hooks sanitize their whole payload", () => {
    const span: any = { description: `GET /api/workspace-invitations/${INV}/accept`, data: { "url.full": `${ORIGIN}/workspace/team/${WS}`, transaction: `/workspace/team/${WS}` } };
    expect(noSecret(JSON.stringify(scrubSentrySpan(span)))).toBe(true);
    const log: any = { body: `navigated to /workspace/team/${WS}`, attributes: { "sentry.message.parameter.0": { value: `/admin/users/${INV}` } } };
    expect(noSecret(JSON.stringify(scrubSentryLogOrMetric(log)))).toBe(true);
  });
});

describe("S4 Sentry transmission boundary", () => {
  const recording = (events: unknown[]) => `${JSON.stringify({ segment_id: 0 })}\n${JSON.stringify(events)}`;
  const events = () => [
    { type: 4, data: { href: `${ORIGIN}/workspace/team/${WS}/members?openResearchRun=${INV}#token=${TOK}`, width: 1, height: 1 }, timestamp: 1 },
    {
      type: 2,
      data: {
        node: { type: 0, childNodes: [{ type: 2, tagName: "a", attributes: { href: `/workspace/team/${WS}`, class: "x" }, childNodes: [{ type: 3, textContent: "***" }] }] },
      },
      timestamp: 2,
    },
    { type: 3, data: { source: 0, adds: [{ node: { type: 2, tagName: "img", attributes: { src: `/admin/users/${INV}` } } }], attributes: [{ id: 1, attributes: { href: `/workspace/team/${WS}` } }] }, timestamp: 3 },
    { type: 5, data: { tag: "breadcrumb", payload: { category: "navigation", data: { from: `/workspace/team/${WS}`, to: `/workspace-invitations/accept%23token%3D${TOK}` } } }, timestamp: 4 },
    { type: 3, data: { source: 2, text: "/* css comment */ a { b: 1 / 2 }" }, timestamp: 5 },
  ];

  it("replay recording: meta href, snapshot and mutation attributes and custom events are sanitized", () => {
    const out = scrubReplayRecordingPayload(recording(events()));
    expect(out).not.toBeNull();
    expect(noSecret(out!)).toBe(true);
    const parsed = JSON.parse(out!.slice(out!.indexOf("\n") + 1));
    expect(parsed[0].data.href).toBe(`${ORIGIN}/workspace/team/[workspaceId]/members?openResearchRun=${REDACTED}`);
    expect(parsed[1].data.node.childNodes[0].attributes).toEqual({ href: "/workspace/team/[workspaceId]", class: "x" });
    expect(parsed[4].data.text).toBe("/* css comment */ a { b: 1 / 2 }"); // non-URL recording content untouched
    expect(JSON.parse(out!.slice(0, out!.indexOf("\n")))).toEqual({ segment_id: 0 });
  });

  it("an unparseable (e.g. compressed) recording is dropped, never sent", () => {
    expect(scrubReplayRecordingPayload(new Uint8Array([0x1f, 0x8b, 0x08, 0xff, 0xfe]))).toBeNull();
    expect(scrubReplayRecordingPayload("not json")).toBeNull();
    expect(scrubReplayRecordingPayload(`{}\n{"not":"an array"}`)).toBeNull();
  });

  it("envelope: every item sanitized, recording length recomputed, unscrubbable items dropped, dsn untouched", () => {
    const dsn = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
    const env: any = [
      { event_id: "e", dsn, sent_at: "t", trace: { transaction: `/workspace/team/${WS}`, public_key: "0" } },
      [
        [{ type: "transaction" }, { transaction: `/workspace/team/${WS}`, request: { url: `${ORIGIN}/workspace/team/${WS}` }, spans: [{ description: `GET /api/user/runs/${INV}` }] }],
        [{ type: "replay_event" }, { urls: [`${ORIGIN}/workspace/team/${WS}`] }],
        [{ type: "replay_recording", length: 1 }, recording(events())],
        [{ type: "replay_recording", length: 5 }, new Uint8Array([0x1f, 0x8b, 0x08, 0xff, 0xfe])],
        [{ type: "attachment" }, `raw ${TOK}`],
      ],
    ];
    scrubSentryEnvelope(env);
    expect(env[0].dsn).toBe(dsn);
    expect(env[0].trace.transaction).toBe("/workspace/team/[workspaceId]");
    expect(env[1].map((i: any) => i[0].type)).toEqual(["transaction", "replay_event", "replay_recording"]);
    expect(noSecret(JSON.stringify(env))).toBe(true);
    expect(env[1][2][0].length).toBe(new TextEncoder().encode(env[1][2][1]).length);
  });
});

describe("S5 configuration wiring", () => {
  let initConfig: any;
  let replayOptions: any;
  beforeEach(() => {
    jest.resetModules();
    initConfig = undefined;
    replayOptions = undefined;
  });

  function loadClient(): void {
    jest.doMock("@sentry/nextjs", () => ({
      init: (c: any) => (initConfig = c),
      addEventProcessor: () => undefined,
      replayIntegration: (o: any) => ((replayOptions = o), { name: "Replay" }),
      makeFetchTransport: (o: any) => ({ send: jest.fn(async (e: any) => ({ sent: e, options: o })), flush: jest.fn(async () => true) }),
      captureRouterTransitionStart: jest.fn(),
    }));
    const saved = process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
    try {
      jest.isolateModules(() => require("../../../instrumentation-client"));
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
      else process.env.NEXT_PUBLIC_SENTRY_DSN = saved;
    }
  }

  it("browser Sentry: no-referrer transport, envelope boundary, uncompressed Replay with URL attributes masked, span/log/metric hooks", async () => {
    loadClient();
    expect(initConfig.transportOptions.fetchOptions.referrerPolicy).toBe("no-referrer");
    expect(replayOptions.useCompression).toBe(false);
    expect(replayOptions.maskAttributes).toEqual(REPLAY_MASKED_ATTRIBUTES);
    for (const a of ["href", "src", "srcset", "action", "title", "placeholder", "aria-label"]) expect(REPLAY_MASKED_ATTRIBUTES).toContain(a);
    expect(typeof initConfig.beforeSendSpan).toBe("function");
    expect(typeof initConfig.beforeSendLog).toBe("function");
    expect(typeof initConfig.beforeSendMetric).toBe("function");
    // The transport wrapper hands the INNER transport a sanitized envelope.
    const transport = initConfig.transport({ url: "x" });
    const env: any = [{ dsn: "d" }, [[{ type: "event" }, { request: { url: `${ORIGIN}/workspace/team/${WS}?token=${TOK}` } }]]];
    const result: any = await transport.send(env);
    expect(noSecret(JSON.stringify(result.sent))).toBe(true);
    expect(result.sent[1][0][1].request.url).toBe(`${ORIGIN}/workspace/team/[workspaceId]?token=${REDACTED}`);
    expect(initConfig.beforeSendSpan({ description: `GET /admin/users/${INV}` }).description).toBe("GET /admin/users/[uid]");
  });

  it.each(["sentry.server.config", "sentry.edge.config"])("%s: span, log and metric hooks sanitize", (file) => {
    jest.doMock("@sentry/nextjs", () => ({ init: (c: any) => (initConfig = c) }));
    const saved = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://00000000000000000000000000000000@o0.ingest.example.invalid/0";
    try {
      jest.isolateModules(() => require(`../../../${file}`));
    } finally {
      if (saved === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = saved;
    }
    expect(initConfig.beforeSendSpan({ description: `GET /api/workspace-invitations/${INV}/accept` }).description).toBe(
      "GET /api/workspace-invitations/[invitationId]/accept"
    );
    expect(noSecret(JSON.stringify(initConfig.beforeSendLog({ body: `/workspace/team/${WS}` })))).toBe(true);
    expect(noSecret(JSON.stringify(initConfig.beforeSendMetric({ name: "m", attributes: { route: `/workspace/team/${WS}` } })))).toBe(true);
  });

  it("PostHog: the /flags request (person properties from the landing URL, outside before_send) is disabled", () => {
    const src = readFileSync(join(ROOT, "components/PostHogProvider.tsx"), "utf8");
    expect(src).toMatch(/\n\s+advanced_disable_flags: true,\n/);
  });

  it("site-wide Referrer-Policy is strict-origin (same-origin requests carry the origin only)", async () => {
    // The real next.config.js headers() (withSentryConfig only adds build options; identity here).
    jest.doMock("@sentry/nextjs", () => ({ withSentryConfig: (c: unknown) => c }));
    let config: any;
    jest.isolateModules(() => {
      config = require("../../../next.config.js");
    });
    if (typeof config === "function") config = await config("phase-production-server", { defaultConfig: {} });
    const rules: Array<{ source: string; headers: Array<{ key: string; value: string }> }> = await config.headers();
    const values = rules.flatMap((r) => r.headers.filter((h) => h.key.toLowerCase() === "referrer-policy").map((h) => `${r.source} ${h.value}`));
    expect(values).toEqual(["/:path* strict-origin"]);
  });
});

describe("S6 the /ingest reverse proxy forwards no first-party credentials", () => {
  const { middleware, config, PROXY_STRIPPED_REQUEST_HEADERS } = require("../../../middleware");
  const { NextRequest } = require("next/server");

  const request = (path: string) =>
    new NextRequest(`${ORIGIN}${path}`, {
      headers: { cookie: `__session=SESSIONSENTINEL; ph_x=${INV}`, authorization: "Bearer AUTHSENTINEL", "content-type": "application/json", "user-agent": "UA" },
    });

  it.each(["/ingest", "/ingest/e/?ip=0", "/ingest/static/array.js", "/ingest/flags/?v=2"])("%s: Cookie and Authorization are removed, other headers kept", (path) => {
    const res = middleware(request(path));
    const overridden = String(res.headers.get("x-middleware-override-headers") ?? "").split(",").map((h: string) => h.trim());
    expect(overridden.length).toBeGreaterThan(0); // the request headers ARE overridden
    for (const h of PROXY_STRIPPED_REQUEST_HEADERS) expect(overridden).not.toContain(h);
    expect(overridden).toEqual(expect.arrayContaining(["content-type", "user-agent"]));
    expect(res.headers.get("x-middleware-request-cookie")).toBeNull();
    expect(res.headers.get("x-middleware-request-authorization")).toBeNull();
  });

  it("the matcher covers the proxy; /admin gating is unchanged (control)", () => {
    expect(config.matcher).toEqual(expect.arrayContaining(["/admin/:path*", "/ingest", "/ingest/:path*"]));
    const admin = middleware(new NextRequest(`${ORIGIN}/admin/users`));
    expect(admin.status).toBe(307);
    expect(admin.headers.get("location")).toContain("/login?next=%2Fadmin%2Fusers");
    const pricing = middleware(request("/admin/keys"));
    expect(pricing.headers.get("x-middleware-override-headers")).toBeNull();
  });
});
