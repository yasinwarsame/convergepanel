/**
 * Read movie duration from ISO BMFF `mvhd` (MP4 / MOV) without ffmpeg.
 * Returns seconds, or null if not found / unsupported.
 *
 * **Not used by the current video verification flow** (duration comes from the browser + client metadata).
 * Kept for possible future server-side paths (e.g. uploads parsed on Node with a `Buffer`).
 */

export function extractMp4MvhdDurationSeconds(buffer: Buffer): number | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;

  const marker = Buffer.from("mvhd");
  let searchFrom = 0;
  while (searchFrom < buffer.length - 8) {
    const idx = buffer.indexOf(marker, searchFrom);
    if (idx < 0) break;
    // "mvhd" must be the box type: 4 bytes size (BE) immediately before "mvhd"
    if (idx < 4) {
      searchFrom = idx + 4;
      continue;
    }
    const boxStart = idx - 4;
    const boxSize = buffer.readUInt32BE(boxStart);
    if (boxSize < 24 || boxStart + boxSize > buffer.length) {
      searchFrom = idx + 4;
      continue;
    }

    const version = buffer[idx + 4];
    let timescale: number;
    let durationTicks: number;

    if (version === 0) {
      if (idx + 24 > buffer.length) {
        searchFrom = idx + 4;
        continue;
      }
      timescale = buffer.readUInt32BE(idx + 16);
      durationTicks = buffer.readUInt32BE(idx + 20);
    } else if (version === 1) {
      if (idx + 36 > buffer.length) {
        searchFrom = idx + 4;
        continue;
      }
      timescale = buffer.readUInt32BE(idx + 24);
      const durationBig =
        (BigInt(buffer.readUInt32BE(idx + 28)) << 32n) | BigInt(buffer.readUInt32BE(idx + 32));
      durationTicks = Number(durationBig);
    } else {
      searchFrom = idx + 4;
      continue;
    }

    if (!Number.isFinite(timescale) || timescale <= 0) {
      searchFrom = idx + 4;
      continue;
    }
    const seconds = durationTicks / timescale;
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
    searchFrom = idx + 4;
  }

  return null;
}
