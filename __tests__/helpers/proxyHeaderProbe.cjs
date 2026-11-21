/**
 * TEST-ONLY probe (structural telemetry hardening). Preloaded AFTER the egress guard into `next start` by
 * __tests__/telemetryStructuralHardening.spec.ts. Records, for every outbound http/https request the server
 * process STARTS to a non-loopback host (e.g. the `/ingest` PostHog rewrite proxy), the host and the request
 * header NAMES only (never values) to the file named by `CP_PROXY_PROBE_LOG`. The egress guard still refuses the
 * connection; nothing leaves the machine. Never imported by application code.
 */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");

const logFile = process.env.CP_PROXY_PROBE_LOG || "";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;

function wrap(mod, scheme) {
  const real = mod.request;
  mod.request = function probedRequest(...args) {
    try {
      let opts = args[0];
      if (typeof opts === "string" || opts instanceof URL) opts = typeof args[1] === "object" && !(typeof args[1] === "function") ? { ...args[1], host: new URL(String(args[0])).hostname } : { host: new URL(String(args[0])).hostname };
      const host = String((opts && (opts.hostname || opts.host)) || "").replace(/:\d+$/, "");
      if (logFile && host && !LOOPBACK.test(host)) {
        const names = Object.keys((opts && opts.headers) || {}).map((k) => k.toLowerCase()).sort();
        fs.appendFileSync(logFile, JSON.stringify({ scheme, host, path: String((opts && opts.path) || "").split("?")[0], headerNames: names }) + "\n");
      }
    } catch {
      /* probe never interferes */
    }
    return real.apply(this, args);
  };
}
wrap(http, "http");
wrap(https, "https");
