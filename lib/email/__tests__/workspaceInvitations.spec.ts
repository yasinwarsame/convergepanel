/**
 * Team Workspace Invitations, Phase 8D.2 —
 * `sendWorkspaceInvitationEmail()` tests. `global.fetch` is fully mocked;
 * any unmocked call would throw (no real network access is possible from
 * Jest), and every test asserts the mock was — or was not — invoked.
 */

let resendApiKey: string | undefined = "re_test_key";
let transactionalFrom: string | undefined = "ConvergePanel <invitations@convergepanel.com>";
let appBaseUrl: string | undefined = "https://convergepanel.com";

jest.mock("@/lib/env", () => ({
  get RESEND_API_KEY() {
    return resendApiKey;
  },
  get TRANSACTIONAL_EMAIL_FROM() {
    return transactionalFrom;
  },
  get APP_BASE_URL() {
    return appBaseUrl;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { sendWorkspaceInvitationEmail } from "@/lib/email/workspaceInvitations";

const BASE_ARGS = {
  invitationId: "inv-123",
  deliveryVersion: 1,
  rawToken: "THE_SECRET_RAW_TOKEN_MARKER",
  to: "invitee@example.com",
  workspaceName: "Acme Team",
  inviterName: null as string | null,
  role: "member" as const,
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  resendApiKey = "re_test_key";
  transactionalFrom = "ConvergePanel <invitations@convergepanel.com>";
  appBaseUrl = "https://convergepanel.com";
  delete process.env.VERCEL_ENV;
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function getFetchMock(): jest.Mock {
  return global.fetch as unknown as jest.Mock;
}

describe("sendWorkspaceInvitationEmail — success path", () => {
  it("success: correct endpoint, Authorization Bearer header, Content-Type, Idempotency-Key, and payload fields", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { id: "msg-abc-123" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "sent", providerMessageId: "msg-abc-123" });

    expect(getFetchMock()).toHaveBeenCalledTimes(1);
    const [url, init] = getFetchMock().mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Idempotency-Key"]).toBe("workspace-invitation/inv-123/v1");

    const body = JSON.parse(init.body);
    expect(body.from).toBe(transactionalFrom);
    expect(body.to).toBe("invitee@example.com");
    expect(body.subject).toContain("Acme Team");
    expect(body.html).toContain("Acme Team");
    expect(body.text).toContain("Acme Team");
  });

  it("acceptance URL is fragment-based, contains no query-string token, and uses encodeURIComponent for both components", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    await sendWorkspaceInvitationEmail(BASE_ARGS);
    const body = JSON.parse(getFetchMock().mock.calls[0][1].body);
    // Plain-text body: the URL appears raw, unescaped.
    expect(body.text).toContain("https://convergepanel.com/workspace-invitations/accept#invitationId=inv-123&token=THE_SECRET_RAW_TOKEN_MARKER");
    expect(body.text).not.toMatch(/\?token=/);
    // HTML body: the same URL appears HTML-attribute-escaped (& -> &amp;) inside the href.
    expect(body.html).toContain("https://convergepanel.com/workspace-invitations/accept#invitationId=inv-123&amp;token=THE_SECRET_RAW_TOKEN_MARKER");
    expect(body.html).not.toMatch(/\?token=/);
    const fragmentIndex = body.html.indexOf("#invitationId=");
    const queryTokenIndex = body.html.indexOf("?token=");
    expect(queryTokenIndex).toBe(-1);
    expect(fragmentIndex).toBeGreaterThan(-1);
  });

  it("HTML escaping: <, >, &, \", ' in workspaceName and inviterName are escaped, never interpolated raw", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    await sendWorkspaceInvitationEmail({ ...BASE_ARGS, workspaceName: `<script>&"'</script>`, inviterName: `<b>Evil "Name"</b>` });
    const body = JSON.parse(getFetchMock().mock.calls[0][1].body);
    expect(body.html).not.toContain("<script>");
    expect(body.html).not.toContain(`Evil "Name"`);
    expect(body.html).toContain("&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
    expect(body.html).toContain("&lt;b&gt;Evil &quot;Name&quot;&lt;/b&gt;");
  });

  it("subject never contains the raw token, invitationId, or deliveryVersion", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    await sendWorkspaceInvitationEmail(BASE_ARGS);
    const body = JSON.parse(getFetchMock().mock.calls[0][1].body);
    expect(body.subject).not.toContain(BASE_ARGS.rawToken);
    expect(body.subject).not.toContain(BASE_ARGS.invitationId);
    expect(body.subject).not.toContain(String(BASE_ARGS.deliveryVersion));
  });

  it("idempotency key changes with deliveryVersion, contains no email/token/hash", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    await sendWorkspaceInvitationEmail({ ...BASE_ARGS, deliveryVersion: 7 });
    const key = getFetchMock().mock.calls[0][1].headers["Idempotency-Key"];
    expect(key).toBe("workspace-invitation/inv-123/v7");
    expect(key).not.toContain(BASE_ARGS.to);
    expect(key).not.toContain(BASE_ARGS.rawToken);
  });
});

describe("sendWorkspaceInvitationEmail — configuration gates (zero fetch)", () => {
  it("missing API key -> configuration_missing, zero fetch", async () => {
    resendApiKey = undefined;
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "configuration_missing" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it("missing From -> configuration_missing, zero fetch", async () => {
    transactionalFrom = undefined;
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "configuration_missing" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it("missing base URL -> configuration_missing, zero fetch", async () => {
    appBaseUrl = undefined;
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "configuration_missing" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it("invalid base URL -> configuration_missing, zero fetch", async () => {
    appBaseUrl = "not-a-url";
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "configuration_missing" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it("Production non-HTTPS base URL -> configuration_missing, zero fetch", async () => {
    process.env.VERCEL_ENV = "production";
    appBaseUrl = "http://convergepanel.com";
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "configuration_missing" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it("non-Production http base URL is accepted (local/dev flexibility)", async () => {
    appBaseUrl = "http://localhost:3000";
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "sent", providerMessageId: "msg-1" });
  });

  it("preview -> preview_delivery_disabled, zero fetch", async () => {
    process.env.VERCEL_ENV = "preview";
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "preview_delivery_disabled" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });

  it("preview check takes precedence even when config is otherwise fully valid", async () => {
    process.env.VERCEL_ENV = "preview";
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "preview_delivery_disabled" });
    expect(getFetchMock()).not.toHaveBeenCalled();
  });
});

describe("sendWorkspaceInvitationEmail — retry policy", () => {
  it("network failure then success -> 2 calls, sent", async () => {
    getFetchMock().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(jsonResponse(200, { id: "msg-retry-1" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "sent", providerMessageId: "msg-retry-1" });
    expect(getFetchMock()).toHaveBeenCalledTimes(2);
  });

  it("5xx then success -> 2 calls, sent", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(500, { message: "internal" })).mockResolvedValueOnce(jsonResponse(200, { id: "msg-retry-2" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "sent", providerMessageId: "msg-retry-2" });
    expect(getFetchMock()).toHaveBeenCalledTimes(2);
  });

  it("concurrent_idempotent_requests then success -> 2 calls, sent", async () => {
    getFetchMock()
      .mockResolvedValueOnce(jsonResponse(409, { name: "concurrent_idempotent_requests", message: "in flight" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "msg-retry-3" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "sent", providerMessageId: "msg-retry-3" });
    expect(getFetchMock()).toHaveBeenCalledTimes(2);
  });

  it("network failure twice -> provider_unavailable after 2 calls, no third attempt", async () => {
    getFetchMock().mockRejectedValueOnce(new Error("network down")).mockRejectedValueOnce(new Error("network down again"));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "provider_unavailable" });
    expect(getFetchMock()).toHaveBeenCalledTimes(2);
  });

  it("invalid_idempotent_request -> 1 call, no retry, idempotency_conflict", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(409, { name: "invalid_idempotent_request", message: "payload differs" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "idempotency_conflict" });
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it("invalid_idempotency_key (400) -> 1 call, provider_rejected", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(400, { name: "invalid_idempotency_key", message: "bad key" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "provider_rejected" });
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it("429 -> 1 call, provider_rate_limited, no retry within this invocation", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(429, { message: "too many requests" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "provider_rate_limited" });
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it("ordinary provider 4xx (422 validation error) -> 1 call, provider_rejected", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(422, { message: "invalid from address" }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "provider_rejected" });
    expect(getFetchMock()).toHaveBeenCalledTimes(1);
  });

  it("malformed provider success (2xx, no id) -> send_failed, not treated as sent", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await sendWorkspaceInvitationEmail(BASE_ARGS);
    expect(result).toEqual({ status: "send_failed" });
  });

  it("same-retry request body is byte-identical across attempts", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(500, {})).mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    await sendWorkspaceInvitationEmail(BASE_ARGS);
    const call1Body = getFetchMock().mock.calls[0][1].body;
    const call2Body = getFetchMock().mock.calls[1][1].body;
    expect(call1Body).toBe(call2Body); // reference-level string equality check
    expect(typeof call1Body).toBe("string");
  });

  it("same-retry Idempotency-Key is identical across attempts", async () => {
    getFetchMock().mockResolvedValueOnce(jsonResponse(500, {})).mockResolvedValueOnce(jsonResponse(200, { id: "msg-1" }));
    await sendWorkspaceInvitationEmail(BASE_ARGS);
    const key1 = getFetchMock().mock.calls[0][1].headers["Idempotency-Key"];
    const key2 = getFetchMock().mock.calls[1][1].headers["Idempotency-Key"];
    expect(key1).toBe(key2);
  });
});

describe("sendWorkspaceInvitationEmail — secret logging", () => {
  it("never logs the raw token, recipient email, RESEND_API_KEY, or acceptance URL", async () => {
    const { logger } = jest.requireMock("@/lib/logger") as { logger: { warn: jest.Mock } };
    getFetchMock().mockResolvedValueOnce(jsonResponse(500, {})).mockResolvedValueOnce(jsonResponse(500, {}));
    await sendWorkspaceInvitationEmail(BASE_ARGS);
    const allLoggedArgs = JSON.stringify(logger.warn.mock.calls);
    expect(allLoggedArgs).not.toContain(BASE_ARGS.rawToken);
    expect(allLoggedArgs).not.toContain(BASE_ARGS.to);
    expect(allLoggedArgs).not.toContain(resendApiKey as string);
    expect(allLoggedArgs).not.toContain("workspace-invitations/accept#");
  });
});
