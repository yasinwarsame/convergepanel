/**
 * TEST-ONLY egress guard (PR #329 R5, R4 review MINOR-2). Preloaded with
 * `node --require __tests__/helpers/egressGuard.cjs` into the `next start`
 * (and `next build`) processes the production-build harness launches. Never
 * imported by application code; no effect on production.
 *
 * Every outbound TCP connection goes through `net.Socket.prototype.connect`
 * (http, https, tls, undici `fetch`, http-proxy used by Next rewrites — e.g.
 * the `/monitoring` Sentry tunnel and the `/ingest` PostHog rewrite). This
 * guard refuses any connection whose host is not loopback BEFORE the DNS
 * lookup or the connect happens: the socket is destroyed asynchronously with
 * an error whose `code` is `CP_EGRESS_BLOCKED`, and the attempt (host, port,
 * time — never a payload) is appended as a JSON line to the file named by
 * `CP_EGRESS_GUARD_LOG`. Unix-domain / IPC sockets and loopback are allowed.
 */
"use strict";
const net = require("net");
const fs = require("fs");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", ""]);
const logFile = process.env.CP_EGRESS_GUARD_LOG || "";

function record(host, port) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ host: String(host), port: Number(port) || null, at: new Date().toISOString(), pid: process.pid }) + "\n");
  } catch {
    /* the refusal itself still happens */
  }
}

function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // internal normalized form: [options, cb]
  if (first && typeof first === "object") {
    if (typeof first.path === "string" && first.path) return { ipc: true };
    return { host: first.host === undefined ? "localhost" : first.host, port: first.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { ipc: true }; // connect(path)
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const t = target(args);
  if (!t.ipc) {
    const host = String(t.host).toLowerCase();
    if (!LOOPBACK.has(host) && !/^127\.\d+\.\d+\.\d+$/.test(host)) {
      record(host, t.port);
      const err = new Error(`CP egress guard: outbound connection to ${host} refused`);
      err.code = "CP_EGRESS_BLOCKED";
      process.nextTick(() => this.destroy(err));
      return this;
    }
  }
  return realConnect.apply(this, args);
};

module.exports = { LOOPBACK };
