/**
 * Team Workspace Invitations, Phase 8D.3.4-O2E.1 —
 * `app/monitoring/route.ts` Sentry tunnel byte-preservation coverage.
 *
 * The prior implementation read the incoming envelope via `req.text()`,
 * forcing a lossy UTF-8 decode/re-encode round-trip. Sentry's own
 * `serializeEnvelope()` (node_modules/@sentry/core/build/cjs/utils/envelope.js)
 * emits a raw `Uint8Array` — not a string — whenever any envelope item
 * (e.g. a compressed Replay recording) carries a binary payload, so that
 * round-trip corrupts non-UTF-8-safe bytes before they ever reach Sentry.
 *
 * Verified pre-fix: the "forwards a binary Replay envelope" test below fails
 * against the original req.text()-based route — 4 invalid-UTF-8 bytes
 * (0x80, 0xc0, 0xff, 0xfe) each get replaced with the 3-byte U+FFFD
 * sequence (ef bf bd), inflating a 21-byte payload to 33 bytes.
 */

import { NextRequest } from "next/server";

const DSN = "https://0d1785e8cafc519f0e99ecc4501ffc06@o4511503698624512.ingest.us.sentry.io/4511503843065856";
const WRONG_DSN = "https://0d1785e8cafc519f0e99ecc4501ffc06@o9999999999999999.ingest.us.sentry.io/9999999999";
const TUNNEL_URL = "http://localhost/monitoring";

function envelopeOf(header: object, items: Array<{ header: object; payload: Buffer | object }>): Uint8Array {
  const parts: Buffer[] = [Buffer.from(`${JSON.stringify(header)}\n`, "utf8")];
  for (const { header: itemHeader, payload } of items) {
    parts.push(Buffer.from(`${JSON.stringify(itemHeader)}\n`, "utf8"));
    parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * Deliberately non-UTF-8-safe bytes: gzip magic (0x1f 0x8b), a lone
 * continuation byte (0x80), an overlong-encoding lead byte (0xc0), a null
 * byte, 0xff/0xfe, and — critically — literal embedded newline bytes (0x0a)
 * inside the binary payload itself, which must NOT be treated as an
 * envelope line separator once the item's declared `length` is in use.
 */
function binaryReplayPayload(): Buffer {
  return Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x80, 0xc0, 0xff, 0xfe, 0x00, 0x41, 0x0a, 0x42, 0x9c, 0x3f]);
}

function buildBinaryReplayEnvelope(): Uint8Array {
  const payload = binaryReplayPayload();
  return envelopeOf({ dsn: DSN }, [{ header: { type: "replay_recording", length: payload.length }, payload }]);
}

function mockFetchCapturingBody(status = 200) {
  let capturedBody: Uint8Array | null = null;
  const fn = jest.fn(async (_url: string, init: RequestInit) => {
    const body = init.body;
    if (body instanceof Uint8Array) {
      capturedBody = body;
    } else if (typeof body === "string") {
      capturedBody = new Uint8Array(Buffer.from(body, "utf8"));
    } else if (body && typeof (body as { byteLength?: number }).byteLength === "number") {
      capturedBody = new Uint8Array(body as ArrayBuffer);
    }
    return new Response(null, { status });
  });
  return { fn, getCapturedBody: () => capturedBody };
}

describe("POST /monitoring — Sentry tunnel (Phase 8D.3.4-O2E.1)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
    jest.resetModules();
  });

  it("A — forwards a plain JSON error envelope byte-for-byte", async () => {
    const original = envelopeOf({ dsn: DSN }, [{ header: { type: "event" }, payload: { message: "boom", level: "error" } }]);
    const { fn: mockFetch, getCapturedBody } = mockFetchCapturingBody(200);
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: original }));

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(Buffer.from(getCapturedBody() as unknown as Uint8Array).equals(Buffer.from(original))).toBe(true);
  });

  it("B — forwards a binary Replay envelope to Sentry byte-for-byte, unmodified (regression)", async () => {
    const original = buildBinaryReplayEnvelope();
    const { fn: mockFetch, getCapturedBody } = mockFetchCapturingBody(200);
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: original }));

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const captured = getCapturedBody();
    expect(captured).not.toBeNull();
    expect(captured!.length).toBe(original.length);
    expect(Buffer.from(captured as unknown as Uint8Array).equals(Buffer.from(original))).toBe(true);
  });

  it("C — a wrong-project-endpoint transaction/span envelope still forwards byte-for-byte when the DSN is allowed", async () => {
    const original = envelopeOf({ dsn: DSN }, [{ header: { type: "transaction" }, payload: { spans: [{ op: "http.client" }] } }]);
    const { fn: mockFetch, getCapturedBody } = mockFetchCapturingBody(200);
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: original }));

    expect(res.status).toBe(200);
    expect(Buffer.from(getCapturedBody() as unknown as Uint8Array).equals(Buffer.from(original))).toBe(true);
  });

  it("D — a compressed-like Replay payload matches upstream by SHA-256", async () => {
    const crypto = await import("crypto");
    const payload = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256))]);
    const original = envelopeOf({ dsn: DSN }, [{ header: { type: "replay_recording", length: payload.length }, payload }]);
    const { fn: mockFetch, getCapturedBody } = mockFetchCapturingBody(200);
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: original }));

    const expectedHash = crypto.createHash("sha256").update(original).digest("hex");
    const actualHash = crypto.createHash("sha256").update(Buffer.from(getCapturedBody() as unknown as Uint8Array)).digest("hex");
    expect(actualHash).toBe(expectedHash);
  });

  it("E — a binary payload containing an embedded newline byte still parses using the declared length only", async () => {
    const payload = Buffer.from([0x41, 0x0a, 0x42, 0x0a, 0x43, 0x0a]);
    const original = envelopeOf({ dsn: DSN }, [{ header: { type: "replay_recording", length: payload.length }, payload }]);
    const { fn: mockFetch, getCapturedBody } = mockFetchCapturingBody(200);
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: original }));

    expect(res.status).toBe(200);
    expect(Buffer.from(getCapturedBody() as unknown as Uint8Array).equals(Buffer.from(original))).toBe(true);
  });

  it("F — an unparseable envelope is rejected with 400 and upstream is never called", async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const malformed = new Uint8Array(Buffer.from("not-json-at-all\n", "utf8"));
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: malformed }));

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("G — a DSN outside the allowlist is rejected and upstream is never called", async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const envelope = envelopeOf({ dsn: WRONG_DSN }, [{ header: { type: "event" }, payload: { message: "x" } }]);
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: envelope }));

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("H — propagates a 429 rate-limit status from upstream Sentry", async () => {
    const mockFetch = jest.fn(async () => new Response(null, { status: 429 }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const envelope = envelopeOf({ dsn: DSN }, [{ header: { type: "event" }, payload: { message: "x" } }]);
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: envelope }));

    expect(res.status).toBe(429);
  });

  it("H2 — propagates a 500 upstream failure status", async () => {
    const mockFetch = jest.fn(async () => new Response(null, { status: 500 }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const { POST } = await import("../route");
    const envelope = envelopeOf({ dsn: DSN }, [{ header: { type: "event" }, payload: { message: "x" } }]);
    const res = await POST(new NextRequest(TUNNEL_URL, { method: "POST", body: envelope }));

    expect(res.status).toBe(500);
  });
});
