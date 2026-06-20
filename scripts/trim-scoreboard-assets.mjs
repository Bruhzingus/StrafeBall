// One-off asset prep: turn the ChatGPT-exported scoreboard images (which have a *baked-in*
// light checkerboard "transparency" background on an RGB PNG) into real RGBA PNGs with the
// background keyed to alpha, then auto-trimmed and saved under the names the HUD expects.
//
// No external deps — PNG is just zlib-compressed filtered scanlines, and Node ships zlib.
//
// Background removal uses a border flood-fill: we only erase background pixels that are
// connected to the image edge AND look like the checkerboard (light + low saturation). That
// protects the white marker bodies (which are light too) from being punched through, since
// they're surrounded by colored ink and never connect to the border.

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'ui', 'scoreboard');

const JOBS = [
  { src: 'ChatGPT Image Jun 20, 2026, 04_58_30 AM (1).png', out: 'eraser.png' },
  { src: 'ChatGPT Image Jun 20, 2026, 04_58_30 AM (2).png', out: 'marker-blue.png' },
  { src: 'ChatGPT Image Jun 20, 2026, 04_58_30 AM (3).png', out: 'marker-red.png' }
];

// ---------- minimal PNG decode (truecolor / truecolor+alpha, 8-bit, no interlace) ----------

function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // RGBA output (we add an opaque alpha for truecolor sources).
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error('bad filter ' + filter);
      }
      line[x] = val & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, rgba: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------- minimal PNG encode (RGBA, filter 0) ----------

function writePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type RGBA
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ---------- background removal ----------

// The "transparency" is a baked checkerboard of exactly TWO flat, neutral colors (a light gray
// and an off-white) that we sample from the corners. The white marker body overlaps the same
// brightness range, so we can't threshold on brightness. Instead we key only pixels that match
// one of the two background colors *closely* — the body is smoothly shaded and slightly blue, so
// it never matches the flat neutral squares. The flood-fill from the border then guarantees we
// only erase the actual background plane, never an enclosed white area.

// Sampled per image from a border region known to be pure checkerboard.
let BG_COLORS = [];

function near(r, g, b, [br, bg, bb], tol) {
  return Math.abs(r - br) <= tol && Math.abs(g - bg) <= tol && Math.abs(b - bb) <= tol;
}

function looksLikeBackground(r, g, b) {
  // Must be neutral (the checker is gray; ink and the bluish body are not) AND match a square.
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (sat > 8) return false;
  for (const c of BG_COLORS) if (near(r, g, b, c, 10)) return true;
  return false;
}

// Find the two dominant flat colors along the top edge (always pure background).
function sampleBackgroundColors(width, height, rgba) {
  const counts = new Map();
  const sampleRows = Math.min(8, height);
  for (let y = 0; y < sampleRows; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 8) continue;
      // bucket to nearest 4 to merge AA noise
      const key = `${r >> 2}|${g >> 2}|${b >> 2}`;
      const prev = counts.get(key);
      if (prev) prev.n++;
      else counts.set(key, { r, g, b, n: 1 });
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 2);
  BG_COLORS = sorted.map((c) => [c.r, c.g, c.b]);
}

function removeBackground(width, height, rgba) {
  sampleBackgroundColors(width, height, rgba);
  // Flood fill from every border pixel; clear connected background pixels to alpha 0.
  const visited = new Uint8Array(width * height);
  const stack = [];
  const pushIf = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (visited[i]) return;
    visited[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) { pushIf(x, 0); pushIf(x, height - 1); }
  for (let y = 0; y < height; y++) { pushIf(0, y); pushIf(width - 1, y); }

  while (stack.length) {
    const i = stack.pop();
    const d = i * 4;
    if (!looksLikeBackground(rgba[d], rgba[d + 1], rgba[d + 2])) continue; // edge of object: stop
    rgba[d + 3] = 0; // transparent
    const x = i % width;
    const y = (i / width) | 0;
    pushIf(x + 1, y); pushIf(x - 1, y); pushIf(x, y + 1); pushIf(x, y - 1);
  }

  // Soften the 1px halo: where a kept pixel borders transparency and is itself pale gray,
  // fade its alpha so the drop-shadow edge doesn't leave a hard light fringe.
  const result = Buffer.from(rgba);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = i * 4;
      if (rgba[d + 3] === 0) continue;
      const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      // Only soften residual checkerboard-colored fringe pixels, never the white body.
      const isFringe = sat <= 8 && BG_COLORS.some((c) => near(r, g, b, c, 18));
      if (isFringe) {
        // count transparent neighbors
        let trans = 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) { trans++; continue; }
          if (rgba[(ny * width + nx) * 4 + 3] === 0) trans++;
        }
        if (trans > 0) result[d + 3] = Math.round(255 * (1 - trans / 4) * 0.85);
      }
    }
  }
  return result;
}

// ---------- auto-trim to the visible (alpha>0) bounds, with a small margin ----------

function trim(width, height, rgba, margin = 6) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { width, height, rgba }; // nothing kept; bail
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(width - 1, maxX + margin);
  maxY = Math.min(height - 1, maxY + margin);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    rgba.copy(out, y * w * 4, ((y + minY) * width + minX) * 4, ((y + minY) * width + minX) * 4 + w * 4);
  }
  return { width: w, height: h, rgba: out };
}

for (const { src, out } of JOBS) {
  const buf = readFileSync(join(DIR, src));
  const img = readPng(buf);
  const keyed = removeBackground(img.width, img.height, img.rgba);
  const trimmed = trim(img.width, img.height, keyed);
  const png = writePng(trimmed.width, trimmed.height, trimmed.rgba);
  writeFileSync(join(DIR, out), png);
  console.log(`${out}: ${img.width}x${img.height} -> ${trimmed.width}x${trimmed.height} (${png.length} bytes)`);
}
