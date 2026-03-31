/**
 * Bundles lib/video/videoPure.ts with esbuild, validates pure helpers, barrel exports, and client extractor.
 */

import { buildSync } from "esbuild";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outfile = join(scriptDir, ".video-pure.bundle.mjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

buildSync({
  entryPoints: [join(root, "lib/video/videoPure.ts")],
  bundle: true,
  platform: "neutral",
  format: "esm",
  outfile,
  logLevel: "silent",
});

const { computeFrameTimestamps, analyzeMetadata } = await import(pathToFileURL(outfile).href);
if (existsSync(outfile)) unlinkSync(outfile);

const baseMeta = () => ({
  duration: 12,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  fileSize: 8_000_000,
  format: "mp4",
  createdAt: "2020-01-01T00:00:00.000Z",
  encodingSoftware: "HandBrake",
  hasAudio: true,
  cameraModel: null,
});

let a = analyzeMetadata(baseMeta());
assert(!a.flags.some((f) => f.severity === "suspicious"), "normal metadata should have no suspicious flags");

a = analyzeMetadata({ ...baseMeta(), createdAt: new Date(Date.now() + 864e5 * 365).toISOString() });
assert(a.flags.some((f) => f.observation.includes("future")), "future creation date → suspicious");

a = analyzeMetadata({ ...baseMeta(), encodingSoftware: "Runway Gen-2" });
assert(
  a.flags.some((f) => f.severity === "suspicious" && f.field === "encodingSoftware"),
  "AI-related encoding software → suspicious"
);

a = analyzeMetadata({ ...baseMeta(), createdAt: null });
assert(a.flags.some((f) => f.severity === "warning" && f.field === "createdAt"), "missing creation date → warning");

const t10 = computeFrameTimestamps(10);
assert(t10.length >= 4 && t10.length <= 13, `10s clip: expected ~10 frames, got ${t10.length}`);
assert(t10.some((x) => Math.abs(x - 0.5) < 0.25), "should include a frame near 0.5s");
assert(t10.some((x) => x > 8), "should include a frame in the last second");

const t2 = computeFrameTimestamps(2);
assert(t2.length >= 4, `very short video (<3s): min 4 frames, got ${t2.length}`);

const t59 = computeFrameTimestamps(59);
assert(t59.length >= 8 && t59.length <= 13, `~60s clip: 8–12 target frames, got ${t59.length}`);

const pv = readFileSync(join(root, "lib/video/processVideo.ts"), "utf8");
assert(/analyzeMetadata/.test(pv), "processVideo.ts must re-export analyzeMetadata");
assert(/ExtractedFrame/.test(pv), "processVideo.ts must re-export ExtractedFrame");
assert(!/@ffmpeg|createLoadedFfmpeg|ffmpeg-core/.test(pv), "processVideo.ts must not reference ffmpeg WASM");

const efc = readFileSync(join(root, "lib/video/extractFramesClient.ts"), "utf8");
assert(
  /export async function extractFramesInBrowser/.test(efc),
  "extractFramesClient.ts must export extractFramesInBrowser"
);

console.log("verify:video — all checks passed");
