/**
 * Generates the PWA icons (web/public/icon-*.png) and the macOS app iconset
 * (icon.iconset/, consumed by the Electrobun build via iconutil) without any
 * image tooling: draws a terminal-prompt glyph into an RGBA buffer and
 * encodes it as a PNG via zlib.
 *
 * Usage: bun run scripts/generate-icons.ts
 */

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { deflateSync } from "zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "web", "public");

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, no interlace, filter 0)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA

  // Prefix each scanline with filter byte 0.
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Uint8Array.from([
    ...signature,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(deflateSync(raw))),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Icon drawing: dark tile, terracotta "❯" prompt, light cursor block
// ---------------------------------------------------------------------------

const BG: RGBA = [0x14, 0x16, 0x1a, 255];
const ACCENT: RGBA = [0xd9, 0x77, 0x57, 255];
const TEXT: RGBA = [0xe6, 0xe8, 0xee, 255];
type RGBA = [number, number, number, number];

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawIcon(size: number, maskable: boolean): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const radius = maskable ? 0 : size * 0.18;
  const stroke = size * 0.05;
  // "❯" chevron, scaled slightly inward on maskable icons (safe zone).
  const inset = maskable ? 0.08 : 0;
  const sx = (v: number): number => size * (v * (1 - 2 * inset) + inset);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let color: RGBA | null = BG;

      // Rounded-corner transparency for non-maskable icons.
      if (radius > 0) {
        const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
        const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
        if (Math.hypot(cx, cy) > radius) color = null;
      }

      if (color) {
        const chevron =
          distToSegment(x, y, sx(0.28), sx(0.3), sx(0.5), sx(0.5)) <= stroke ||
          distToSegment(x, y, sx(0.5), sx(0.5), sx(0.28), sx(0.7)) <= stroke;
        const cursor = x >= sx(0.58) && x <= sx(0.78) && y >= sx(0.64) && y <= sx(0.7);
        if (chevron) color = ACCENT;
        else if (cursor) color = TEXT;
      }

      const i = (y * size + x) * 4;
      if (color) rgba.set(color, i);
    }
  }
  return rgba;
}

/** Center a tile in a larger transparent canvas (macOS icons keep a margin). */
function padCanvas(tile: Uint8Array, tileSize: number, canvasSize: number): Uint8Array {
  const rgba = new Uint8Array(canvasSize * canvasSize * 4);
  const offset = Math.floor((canvasSize - tileSize) / 2);
  for (let y = 0; y < tileSize; y++) {
    rgba.set(
      tile.subarray(y * tileSize * 4, (y + 1) * tileSize * 4),
      ((y + offset) * canvasSize + offset) * 4,
    );
  }
  return rgba;
}

function drawMacIcon(size: number): Uint8Array {
  // macOS icon artwork occupies ~80% of the canvas.
  const tileSize = Math.round(size * 0.82);
  return padCanvas(drawIcon(tileSize, false), tileSize, size);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-512-maskable.png", 512, true],
] as const) {
  writeFileSync(path.join(OUT_DIR, name), encodePng(size, drawIcon(size, maskable)));
  console.log(`wrote web/public/${name}`);
}

const ICONSET_DIR = path.join(__dirname, "..", "icon.iconset");
mkdirSync(ICONSET_DIR, { recursive: true });
for (const points of [16, 32, 128, 256, 512] as const) {
  for (const scale of [1, 2] as const) {
    const name = scale === 1 ? `icon_${points}x${points}.png` : `icon_${points}x${points}@2x.png`;
    const size = points * scale;
    writeFileSync(path.join(ICONSET_DIR, name), encodePng(size, drawMacIcon(size)));
    console.log(`wrote icon.iconset/${name}`);
  }
}
