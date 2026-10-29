/**
 * Order 6 telemetry isolation — the DSN resolver, the server/edge Sentry
 * configs that use it, and a source-level guard that no Sentry destination is
 * hard-coded anywhere Sentry is initialized or tunnelled.
 */
import fs from "fs";
import path from "path";
import { resolveSentryDsn } from "../sentryDsn";

const ROOT = path.resolve(__dirname, "../../..");
const ISOLATED_DSN = "https://11111111111111111111111111111111@o1.ingest.example.invalid/1";

describe("resolveSentryDsn", () => {
  it.each([[undefined], [""], [" "], ["\t\n "]])("returns undefined (telemetry disabled) for %j", (raw) => {
    expect(resolveSentryDsn(raw)).toBeUndefined();
  });

  it("returns the explicitly configured DSN, trimmed, and nothing else", () => {
    expect(resolveSentryDsn(ISOLATED_DSN)).toBe(ISOLATED_DSN);
    expect(resolveSentryDsn(`  ${ISOLATED_DSN}\n`)).toBe(ISOLATED_DSN);
  });

  it("returns undefined for a non-string value instead of coercing it", () => {
    expect(resolveSentryDsn(null as unknown as string)).toBeUndefined();
    expect(resolveSentryDsn(42 as unknown as string)).toBeUndefined();
  });
});

describe.each([["sentry.server.config"], ["sentry.edge.config"]])("%s — telemetry isolation", (moduleName) => {
  const mockedInit = jest.fn();
  const ORIGINAL_DSN = process.env.SENTRY_DSN;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    mockedInit.mockReset();
    jest.doMock("@sentry/nextjs", () => ({ init: (config: unknown) => mockedInit(config) }));
  });

  afterEach(() => {
    if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = ORIGINAL_DSN;
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
    jest.dontMock("@sentry/nextjs");
  });

  const load = () => {
    require(path.join(ROOT, moduleName));
  };

  it("does not initialize Sentry when SENTRY_DSN is missing (no Production fallback)", () => {
    delete process.env.SENTRY_DSN;
    load();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "]])("does not initialize Sentry when SENTRY_DSN is empty or blank (%j)", (value) => {
    process.env.SENTRY_DSN = value;
    load();
    expect(mockedInit).not.toHaveBeenCalled();
  });

  it("initializes with exactly the configured isolated DSN", () => {
    process.env.SENTRY_DSN = ISOLATED_DSN;
    load();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(mockedInit.mock.calls[0][0]).toMatchObject({ dsn: ISOLATED_DSN });
  });

  it("initializes enabled with the configured DSN under NODE_ENV=production (explicit Production configuration)", () => {
    const configured = "https://22222222222222222222222222222222@o2.ingest.example.invalid/2";
    process.env.SENTRY_DSN = configured;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    load();
    expect(mockedInit).toHaveBeenCalledTimes(1);
    expect(mockedInit.mock.calls[0][0]).toMatchObject({ dsn: configured, enabled: true });
  });
});

describe("no hard-coded Sentry destination in any Sentry init or tunnel source", () => {
  // A Sentry DSN literal: https://<public key>@<host>/<project id>. Any such
  // literal in these files would be a fallback destination baked into a build.
  const DSN_LITERAL = /https?:\/\/[0-9a-f]{16,}@[^\s"'`]+\/\d+/i;
  const INGEST_HOST = /ingest(\.[a-z]{2})?\.sentry\.io/i;
  const FILES = ["instrumentation-client.ts", "instrumentation.ts", "sentry.server.config.ts", "sentry.edge.config.ts", "app/monitoring/route.ts", "lib/telemetry/sentryDsn.ts"];

  it.each(FILES.map((f) => [f]))("%s contains no DSN literal, no ingest host and no `??` fallback on a DSN", (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    expect(src).not.toMatch(DSN_LITERAL);
    expect(src).not.toMatch(INGEST_HOST);
    expect(src).not.toMatch(/SENTRY_DSN\s*(\?\?|\|\|)/);
  });

  it("the guard itself detects a DSN literal (self-check)", () => {
    expect("dsn: \"https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/12345\"").toMatch(DSN_LITERAL);
    expect("process.env.SENTRY_DSN ?? x").toMatch(/SENTRY_DSN\s*(\?\?|\|\|)/);
  });
});
