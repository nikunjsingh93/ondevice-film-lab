module.exports = function flashbackDng() {
  const w = 4144,
    h = 3088,
    offset = 2048,
    buffer = Buffer.alloc(offset + (w * h * 10) / 8),
    entries = [];
  function tag(id, type, count, value) {
    entries.push({ id, type, count, value });
  }
  function ascii(id, text, pos) {
    buffer.write(text + "\0", pos);
    tag(id, 2, text.length + 1, pos);
  }
  buffer.write("II");
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  tag(254, 4, 1, 0);
  tag(256, 4, 1, w);
  tag(257, 4, 1, h);
  tag(258, 3, 1, 10);
  tag(259, 3, 1, 1);
  tag(262, 3, 1, 32803);
  ascii(271, "Flashback", 600);
  ascii(272, "One35 V2", 630);
  tag(273, 4, 1, offset);
  tag(274, 3, 1, 1);
  tag(277, 3, 1, 1);
  tag(278, 4, 1, h);
  tag(279, 4, 1, (w * h * 10) / 8);
  tag(284, 3, 1, 1);
  tag(33421, 3, 2, 2 | (2 << 16));
  tag(33422, 1, 4, 0x02010100);
  tag(50706, 1, 4, 0x00000401);
  tag(50707, 1, 4, 0x00000101);
  tag(50714, 3, 1, 64);
  tag(50717, 4, 1, 1023);
  tag(50728, 3, 3, 660);
  buffer.writeUInt16LE(541, 660);
  buffer.writeUInt16LE(1000, 662);
  buffer.writeUInt16LE(597, 664);
  // D65 colour matrix: enough metadata for the standard RAW importer too.
  tag(50721, 10, 9, 700);
  const matrix = [0.53, 0.22, 0.21, 0.085, 0.989, -0.075, 0.045, -0.372, 1.152];
  for (let i = 0; i < 9; i++) {
    buffer.writeInt32LE(Math.round(matrix[i] * 100000), 700 + i * 8);
    buffer.writeInt32LE(100000, 704 + i * 8);
  }
  tag(50778, 3, 1, 21);
  entries.sort((a, b) => a.id - b.id);
  buffer.writeUInt16LE(entries.length, 8);
  entries.forEach((e, i) => {
    const p = 10 + i * 12;
    buffer.writeUInt16LE(e.id, p);
    buffer.writeUInt16LE(e.type, p + 2);
    buffer.writeUInt32LE(e.count, p + 4);
    buffer.writeUInt32LE(e.value, p + 8);
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x += 4) {
      const values = [];
      for (let k = 0; k < 4; k++) {
        const channel =
            y % 2 === 0
              ? (x + k) % 2 === 0
                ? 0
                : 1
              : (x + k) % 2 === 0
                ? 1
                : 2,
          light = 0.06 + (0.5 * (x + k)) / w,
          scale = [0.541, 1, 0.597][channel];
        values.push(Math.round(64 + 959 * light * scale));
      }
      const [a, b, c, d] = values,
        p = offset + ((y * w + x) * 10) / 8;
      buffer[p] = a >> 2;
      buffer[p + 1] = ((a & 3) << 6) | (b >> 4);
      buffer[p + 2] = ((b & 15) << 4) | (c >> 6);
      buffer[p + 3] = ((c & 63) << 2) | (d >> 8);
      buffer[p + 4] = d & 255;
    }
  return buffer;
};
