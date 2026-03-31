"use client";

/**
 * Client-side MP4/MOV metadata extraction by parsing ISO BMFF container atoms.
 *
 * Reads the first and last 2MB of the file to find the `moov` atom, which
 * contains metadata (creation date, codec, device info). iPhone/Apple
 * devices often place `moov` at the end of the file after `mdat` (video data), so
 * reading only the head would miss it.
 *
 * Does NOT decode video frames — that's handled by extractFramesClient.ts.
 */

/** Parsed container hints merged with browser metadata on the client. */
export interface FileMetadata {
  createdAt: string | null;
  encodingSoftware: string | null;
  codec: string | null;
  hasAudio: boolean;
  cameraModel: string | null;
}

/** 2MB is large enough for typical `moov` + `meta` while bounding read cost. */
const CHUNK_SIZE = 2 * 1024 * 1024;

/** Seconds between QuickTime epoch (1904-01-01) and Unix epoch (1970-01-01). */
const MAC_TO_UNIX = 2082844800;

const CONTAINER_TYPES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "udta",
  "meta",
  "ilst",
  "mdra",
  "moof",
  "traf",
  "sinf",
  "schi",
  "ipro",
  "----",
  "mean",
  "name",
]);

/** iTunes-style metadata items (e.g. ©too, ©nam) contain nested `data` boxes. */
function isItunesMetadataItem(type: string): boolean {
  return type.length === 4 && type.charCodeAt(0) === 0xa9;
}

/**
 * Maps `stsd` sample entry fourcc → human-readable video codec label.
 * Common: `avc1`/`avc3` H.264, `hvc1`/`hev1` H.265, `vp09` VP9, `av01` AV1, ProRes `ap4*`, `jpeg` MJPEG.
 */
const VIDEO_FOURCC: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "H.265",
  hev1: "H.265",
  hvc2: "H.265",
  hev2: "H.265",
  vp08: "VP8",
  vp09: "VP9",
  av01: "AV1",
  ap4h: "ProRes",
  ap4x: "ProRes",
  apch: "ProRes",
  apcn: "ProRes",
  apcs: "ProRes",
  apco: "ProRes",
  aprh: "ProRes",
  jpeg: "MJPEG",
  "png ": "PNG",
};

const AUDIO_FOURCC = new Set([
  "mp4a",
  "sowt",
  "twos",
  "alac",
  "ec-3",
  "ac-3",
  "Opus",
  "fLaC",
  "lpcm",
]);

function readU32BE(bytes: Uint8Array, o: number): number {
  return (
    (bytes[o] << 24) |
    (bytes[o + 1] << 16) |
    (bytes[o + 2] << 8) |
    bytes[o + 3]
  ) >>> 0;
}

function readU64BE(bytes: Uint8Array, o: number): bigint {
  return (BigInt(readU32BE(bytes, o)) << 32n) | BigInt(readU32BE(bytes, o + 4));
}

/** Reads a 4-byte ISO 8859-1 / ASCII box type at offset `o`. */
function typeAt(bytes: Uint8Array, o: number): string {
  if (o + 4 > bytes.length) return "";
  return String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
}

/**
 * Finds the start offset of a box whose **type** matches `fourcc`, with a plausible big-endian `size` field
 * immediately preceding the type (ISO BMFF: bytes `[pos..pos+3]` = size, `[pos+4..pos+7]` = type).
 *
 * - Rejects `size < 8` (invalid).
 * - **`size === 1`**: extended layout — 64-bit largesize at `pos+8`; header is 16 bytes (handled in {@link walkAtoms}).
 * - Accepts boxes that declare a size larger than the buffer (header still valid) so we can locate `moov` in a tail slice.
 */
function findFourccBoxStart(bytes: Uint8Array, fourcc: string): number {
  if (fourcc.length !== 4 || bytes.length < 8) return -1;
  const c0 = fourcc.charCodeAt(0);
  const c1 = fourcc.charCodeAt(1);
  const c2 = fourcc.charCodeAt(2);
  const c3 = fourcc.charCodeAt(3);
  for (let i = 4; i <= bytes.length - 4; i++) {
    if (bytes[i] !== c0 || bytes[i + 1] !== c1 || bytes[i + 2] !== c2 || bytes[i + 3] !== c3) {
      continue;
    }
    const boxStart = i - 4;
    const size = readU32BE(bytes, boxStart);
    if (size < 8) continue;
    if (size === 1) {
      if (boxStart + 16 > bytes.length) continue;
      const ls = readU64BE(bytes, boxStart + 8);
      const n = Number(ls);
      if (!Number.isFinite(n) || n < 16) continue;
      return boxStart;
    }
    if (size > 8 && size < bytes.length * 4) {
      if (boxStart + 8 <= bytes.length) return boxStart;
    }
  }
  return -1;
}

/** True if a well-formed `moov` (or other) box header for `name` exists in `bytes`. */
function containsAtom(bytes: Uint8Array, name: string): boolean {
  return findFourccBoxStart(bytes, name) >= 0;
}

/** Converts `mvhd` creation_time from QuickTime seconds since 1904-01-01 to ISO UTC. */
function macTimeToIso(macSeconds: number): string | null {
  if (!Number.isFinite(macSeconds) || macSeconds <= 0 || macSeconds === 0xffffffff) return null;
  const unix = macSeconds - MAC_TO_UNIX;
  if (unix <= 0 || unix > 4102444800) return null;
  return new Date(unix * 1000).toISOString();
}

function parseMvhdCreation(bytes: Uint8Array, ds: number, de: number): string | null {
  if (de - ds < 12) return null;
  const version = bytes[ds];
  if (version === 1) {
    if (de - ds < 20) return null;
    const mac = Number(readU64BE(bytes, ds + 4));
    return macTimeToIso(mac);
  }
  const mac = readU32BE(bytes, ds + 4);
  return macTimeToIso(mac);
}

/** Parses `stsd` sample descriptions: FullBox + entry_count, then repeated (size, fourcc) sample entries. */
function parseStsdCodecs(bytes: Uint8Array, ds: number, de: number): string[] {
  const out: string[] = [];
  if (de - ds < 8) return out;
  const count = readU32BE(bytes, ds + 4);
  let off = ds + 8;
  const safeCount = Math.min(count, 32);
  for (let i = 0; i < safeCount && off + 8 <= de; i++) {
    const sz = readU32BE(bytes, off);
    if (sz < 8 || off + sz > de) break;
    out.push(typeAt(bytes, off + 4));
    off += sz;
  }
  return out;
}

function pickVideoCodec(fourccs: string[]): string | null {
  for (const f of fourccs) {
    const human = VIDEO_FOURCC[f];
    if (human) return human;
  }
  return null;
}

function anyAudioFourcc(fourccs: string[]): boolean {
  return fourccs.some((f) => AUDIO_FOURCC.has(f));
}

/**
 * Walks ISO BMFF boxes from `[start,end)`.
 * Each box: **4-byte big-endian size**, **4-byte type**, then payload (or nested boxes for known containers).
 * `size === 0` → box extends to `end`. `size === 1` → real size in **8-byte big-endian** at offset 8.
 */
function walkAtoms(
  bytes: Uint8Array,
  start: number,
  end: number,
  onLeaf: (type: string, d0: number, d1: number) => void,
  depth: number,
  atomsEncountered: Set<string>
): void {
  if (depth > 48 || start >= end) return;
  let pos = start;
  while (pos + 8 <= end) {
    let size = readU32BE(bytes, pos);
    const typ = typeAt(bytes, pos + 4);
    let header = 8;
    let boxEnd = pos + size;

    if (size === 0) {
      boxEnd = end;
    } else if (size === 1) {
      if (pos + 16 > end) break;
      const ls = readU64BE(bytes, pos + 8);
      header = 16;
      const n = Number(ls);
      boxEnd = Number.isFinite(n) && n > 0 ? pos + n : end;
    }

    if (size !== 0 && size < 8) break;
    if (boxEnd > end || boxEnd < pos + header) break;

    const d0 = pos + header;
    const d1 = boxEnd;

    atomsEncountered.add(typ);

    if (CONTAINER_TYPES.has(typ) || isItunesMetadataItem(typ)) {
      walkAtoms(bytes, d0, d1, onLeaf, depth + 1, atomsEncountered);
    } else {
      onLeaf(typ, d0, d1);
    }

    pos = boxEnd;
  }
}

/** Apple ©too: scan for atom then nested `data` box; UTF-8 tool string after data full header. */
function sniffEncoderFromIlst(bytes: Uint8Array): string | null {
  const dec = new TextDecoder("utf-8", { fatal: false });
  const tooB = [0xa9, 0x74, 0x6f, 0x6f];
  for (let i = 0; i < bytes.length - 40; i++) {
    if (
      bytes[i] !== tooB[0] ||
      bytes[i + 1] !== tooB[1] ||
      bytes[i + 2] !== tooB[2] ||
      bytes[i + 3] !== tooB[3]
    ) {
      continue;
    }
    let p = i + 4;
    const limit = Math.min(i + 4096, bytes.length);
    while (p + 8 <= limit) {
      const sz = readU32BE(bytes, p);
      if (sz < 8 || p + sz > limit) break;
      const t = typeAt(bytes, p + 4);
      if (t === "data" && sz >= 16) {
        const strBytes = bytes.subarray(p + 8 + 8, p + sz);
        const s = dec.decode(strBytes).replace(/\0/g, "").trim();
        if (s.length >= 2 && s.length < 240) return s;
      }
      p += sz;
    }
  }
  return null;
}

const ENCODER_SCAN = [
  "HandBrake",
  "FFmpeg",
  "Lavf",
  "Lavc",
  "Adobe",
  "Premiere",
  "Runway",
  "Pika",
  "Sora",
  "Kling",
  "Luma",
  "MiniMax",
  "Hailuo",
  "DaVinci",
  "Resolve",
  "Final Cut",
  "Compressor",
  "Telegram",
  "WhatsApp",
  "CapCut",
  "Google Pixel",
  "Samsung",
  "Android",
] as const;

function sniffEncoderAscii(bytes: Uint8Array): string | null {
  const ascii = new TextDecoder("latin1", { fatal: false }).decode(bytes);
  for (const enc of ENCODER_SCAN) {
    if (ascii.includes(enc)) return enc;
  }
  if (ascii.includes("Apple")) return "Apple";
  return null;
}

function sniffCamera(bytes: Uint8Array): string | null {
  const ascii = new TextDecoder("latin1", { fatal: false }).decode(bytes);
  const iphone = ascii.match(
    /iPhone\s+(?:SE(?:\s*\([^)]*\))?|\d{1,2})(?:\s*Pro(?:\s*Max)?|\s*Plus|\s*mini|\s*e)?/i
  );
  if (iphone) return iphone[0].replace(/\s+/g, " ").trim();
  const pixel = ascii.match(/Pixel\s+\d+[a-zA-Z]*/i);
  if (pixel) return pixel[0];
  const galaxy = ascii.match(/Galaxy\s+S\d+|Galaxy\s+Z\s+Fold|Galaxy\s+Z\s+Flip|SM-[A-Z0-9]+/i);
  if (galaxy) return galaxy[0];
  return null;
}

/**
 * Reads MP4/MOV header metadata using head + optional tail chunks.
 *
 * **Strategy**
 * 1. Read first {@link CHUNK_SIZE} bytes (or entire file if smaller).
 * 2. If `moov` is missing and the file is larger than one chunk, read the **last** chunk — Apple often writes `mdat` then `moov` at EOF.
 * 3. When walking the tail, start at the located `moov` box (the slice may begin inside `mdat` binary garbage).
 * 4. Run ASCII/ilst sniffers on both chunks when two chunks were loaded, to pick up device strings that appear only in one region.
 */
export async function extractMp4Metadata(file: File): Promise<FileMetadata> {
  const empty: FileMetadata = {
    createdAt: null,
    encodingSoftware: null,
    codec: null,
    hasAudio: false,
    cameraModel: null,
  };

  if (file.size < 16) return empty;

  const headLen = Math.min(file.size, CHUNK_SIZE);
  const headBytes = new Uint8Array(await file.slice(0, headLen).arrayBuffer());

  console.log(
    `[extractMp4Metadata] file=${file.name} size=${file.size} headBytes=${headBytes.length}`
  );

  const hasMoovInHead = containsAtom(headBytes, "moov");
  let walkBytes: Uint8Array = headBytes;
  let tailBytes: Uint8Array | null = null;
  let tailStart = 0;
  let usedTailForMoov = false;

  if (!hasMoovInHead && file.size > CHUNK_SIZE) {
    tailStart = Math.max(0, file.size - CHUNK_SIZE);
    tailBytes = new Uint8Array(await file.slice(tailStart).arrayBuffer());
    if (containsAtom(tailBytes, "moov")) {
      walkBytes = tailBytes;
      usedTailForMoov = true;
    }
  }

  let walkStart = 0;
  if (usedTailForMoov) {
    const moovAt = findFourccBoxStart(walkBytes, "moov");
    if (moovAt >= 0) walkStart = moovAt;
  }

  let createdAt: string | null = null;
  let hasAudio = false;
  const stsdFourccs: string[] = [];
  const atomsEncountered = new Set<string>();

  walkAtoms(
    walkBytes,
    walkStart,
    walkBytes.length,
    (type, d0, d1) => {
      if (type === "mvhd") {
        const iso = parseMvhdCreation(walkBytes, d0, d1);
        if (iso && !createdAt) createdAt = iso;
      } else if (type === "hdlr" && d1 - d0 >= 12) {
        const h = typeAt(walkBytes, d0 + 8);
        if (h === "soun") hasAudio = true;
      } else if (type === "stsd") {
        stsdFourccs.push(...parseStsdCodecs(walkBytes, d0, d1));
      }
    },
    0,
    atomsEncountered
  );

  if (!hasAudio && anyAudioFourcc(stsdFourccs)) {
    hasAudio = true;
  }

  const codec = pickVideoCodec(stsdFourccs);
  const ilstEnc = sniffEncoderFromIlst(walkBytes);
  let encodingSoftware = ilstEnc ?? sniffEncoderAscii(walkBytes);
  let cameraModel = sniffCamera(walkBytes);

  const otherChunk =
    tailBytes && walkBytes.buffer === tailBytes.buffer ? headBytes : tailBytes;
  if (otherChunk) {
    if (!encodingSoftware) {
      encodingSoftware = sniffEncoderFromIlst(otherChunk) ?? sniffEncoderAscii(otherChunk);
    }
    if (!cameraModel) {
      cameraModel = sniffCamera(otherChunk);
    }
  }

  const moovFound = atomsEncountered.has("moov");
  let moovLog: string;
  if (moovFound) {
    moovLog = usedTailForMoov ? `tail@fileOffset~${tailStart + walkStart}` : "head";
  } else {
    moovLog = "not_found";
  }
  console.log(`[extractMp4Metadata] moov=${moovLog}`);

  return {
    createdAt,
    encodingSoftware,
    codec,
    hasAudio,
    cameraModel,
  };
}
