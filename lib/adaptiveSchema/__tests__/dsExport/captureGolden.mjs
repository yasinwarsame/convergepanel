#!/usr/bin/env node
/**
 * Order 6 / S-E.2: writes __fixtures__/goldens/<fingerprintId>.json from an exportSuite.mjs result.
 *   TZ=UTC node exportSuite.mjs --out /tmp/suite.json && node captureGolden.mjs /tmp/suite.json "<who/where>"
 * `base` = PDF sha256 of every fixture rendered by the unchanged-main (0249a4e5) renderer in that runtime;
 * `versionOne` = PDF sha256 of every new Decision Support (version-1) export rendered by the current code.
 * Refuses to write unless every historical render already equals unchanged main in that run.
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const [, , input, capturedIn] = process.argv;
if (!input || !capturedIn) throw new Error("usage: captureGolden.mjs <suite.json> <capturedIn>");
const suite = JSON.parse(readFileSync(input, "utf8"));
// Render provenance (R6): unchanged-main renders come from the BASE build, candidate renders from the HEAD build.
const { head, base } = suite.bundles ?? {};
if (!head?.id || !base?.id || head.id === base.id) throw new Error("suite has no distinct HEAD/BASE build identities; not capturing");
for (const [section, want] of [["base", base.id], ["historical", head.id], ["created", head.id]])
  for (const [k, d] of Object.entries(suite[section])) if (d.bundle !== want) throw new Error(`${section}.${k} was not rendered by the expected build; not capturing`);
for (const [k, b] of Object.entries(suite.base)) {
  const h = suite.historical[k];
  const same = b.format === "docx" ? JSON.stringify(b.parts) === JSON.stringify(h.parts) : b.sha256 === h.sha256;
  if (!same) throw new Error(`historical render of ${k} differs from unchanged main; not capturing`);
}
const pick = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep(k)).map(([k, d]) => [k, d.sha256]).sort());
const golden = {
  fingerprintId: suite.fingerprintId,
  fingerprint: suite.fingerprint,
  baseSource: `${suite.baseManifest.sourceCommit} (vendored base files, blob ids in __fixtures__/base-0249a4e5/manifest.json)`,
  capturedIn,
  command: "TZ=UTC node lib/adaptiveSchema/__tests__/dsExport/exportSuite.mjs --out <suite.json> && node lib/adaptiveSchema/__tests__/dsExport/captureGolden.mjs <suite.json> <capturedIn>",
  base: pick(suite.base, (k) => k.endsWith(".pdf")),
  versionOne: pick(suite.created, (k) => k.startsWith("ds.") && k.endsWith(".pdf")),
};
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "goldens");
writeFileSync(path.join(dir, `${suite.fingerprintId}.json`), JSON.stringify(golden, null, 1) + "\n");
process.stdout.write(`golden ${suite.fingerprintId}: ${Object.keys(golden.base).length} base, ${Object.keys(golden.versionOne).length} version-1\n`);
