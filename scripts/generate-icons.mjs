import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const outputDirectory = process.argv[2];
const palette = {
  background: [25, 28, 25],
  panel: [32, 36, 32],
  lime: [216, 255, 114],
  orange: [242, 140, 40]
};

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

const mountains = [[126, 359], [217, 247], [278, 316], [319, 271], [386, 359]];

function colorAt(x, y) {
  let color = palette.background;

  if (insideRoundedRect(x, y, 78, 78, 356, 356, 83)) color = palette.lime;
  if (insideRoundedRect(x, y, 104, 104, 304, 304, 57)) color = palette.panel;
  if ((x - 336) ** 2 + (y - 177) ** 2 <= 34 ** 2) color = palette.orange;
  if (insidePolygon(x, y, mountains)) color = palette.lime;
  if (distanceToSegment(x, y, 126, 359, 386, 359) <= 12) color = palette.lime;

  return color;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function renderIcon(size, filename) {
  const samples = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const scale = 512 / size;

  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const totals = [0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) * scale;
          const py = (y + (sy + 0.5) / samples) * scale;
          const color = colorAt(px, py);
          totals[0] += color[0];
          totals[1] += color[1];
          totals[2] += color[2];
        }
      }
      const offset = row + 1 + x * 4;
      raw[offset] = Math.round(totals[0] / (samples * samples));
      raw[offset + 1] = Math.round(totals[1] / (samples * samples));
      raw[offset + 2] = Math.round(totals[2] / (samples * samples));
      raw[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
  writeFileSync(join(outputDirectory, filename), png);
}

renderIcon(512, "icon-512.png");
renderIcon(192, "icon-192.png");
renderIcon(180, "apple-touch-icon.png");
