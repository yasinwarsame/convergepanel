/**
 * Order 6 telemetry isolation — the single rule for which Sentry destination,
 * if any, a build or process reports to.
 *
 * A DSN is used only when it is explicitly configured: the browser reads
 * `NEXT_PUBLIC_SENTRY_DSN` (inlined at build time), the Node/edge server reads
 * `SENTRY_DSN` (read at process start). A missing, empty or whitespace-only
 * value means telemetry is disabled — `Sentry.init` is not called and the
 * `/monitoring` tunnel forwards nothing. There is deliberately no hard-coded
 * fallback: a fallback is exactly what let an isolated build report to the
 * Production project, and Production monitoring is preserved by configuring
 * the Production environment, never by a literal in source.
 *
 * Pure: no environment read here. Callers pass the raw value so the client can
 * keep the literal `process.env.NEXT_PUBLIC_SENTRY_DSN` reference Next.js needs
 * for build-time inlining.
 */
export function resolveSentryDsn(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const dsn = raw.trim();
  return dsn === "" ? undefined : dsn;
}
