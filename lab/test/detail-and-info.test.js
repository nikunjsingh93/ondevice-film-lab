const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const PhotoExif = require('../../photo-exif');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
function functionSource(name, next) {
  return html.slice(html.indexOf(`  function ${name}(`), html.indexOf(`  ${next}`, html.indexOf(`  function ${name}(`)));
}

test('EXIF panel reads camera, date, exposure and ISO from a JPEG TIFF segment', () => {
  const segment = new Uint8Array(180);
  const view = new DataView(segment.buffer);
  const tiff = 10;
  view.setUint16(tiff, 0x4949, false);
  view.setUint16(tiff + 2, 42, true);
  view.setUint32(tiff + 4, 8, true);
  view.setUint16(tiff + 8, 2, true);
  // Camera make points to an ASCII string.
  view.setUint16(tiff + 10, 0x010f, true); view.setUint16(tiff + 12, 2, true);
  view.setUint32(tiff + 14, 6, true); view.setUint32(tiff + 18, 120, true);
  // EXIF subdirectory.
  view.setUint16(tiff + 22, 0x8769, true); view.setUint16(tiff + 24, 4, true);
  view.setUint32(tiff + 26, 1, true); view.setUint32(tiff + 30, 40, true);
  view.setUint16(tiff + 40, 2, true);
  view.setUint16(tiff + 42, 0x9003, true); view.setUint16(tiff + 44, 2, true);
  view.setUint32(tiff + 46, 20, true); view.setUint32(tiff + 50, 130, true);
  view.setUint16(tiff + 54, 0x8827, true); view.setUint16(tiff + 56, 3, true);
  view.setUint32(tiff + 58, 1, true); view.setUint16(tiff + 62, 800, true);
  segment.set(Buffer.from('Canon\0'), tiff + 120);
  segment.set(Buffer.from('2026:09:25 13:01:02\0'), tiff + 130);
  const rows = Object.fromEntries(PhotoExif.readEntries(segment));
  assert.equal(rows.Camera, 'Canon');
  assert.equal(rows.Captured, '2026:09:25 13:01:02');
  assert.equal(rows.ISO, '800');
  const rw2 = segment.slice(tiff);
  new DataView(rw2.buffer).setUint16(2, 85, true);
  assert.equal(Object.fromEntries(PhotoExif.readEntries(rw2)).Camera, 'Canon');
});

test('luminance reduction and signed vignette affect shared preview and export', () => {
  assert.match(html, /id="luminanceNoise" type="range" min="0" max="100" value="0"/);
  assert.match(html, /id="vignette" type="range" min="-100" max="100" value="0"/);
  assert.equal((html.match(/applyLuminanceNoiseReduction\((?:layer|editedBase|out),/g) || []).length, 3);
  assert.match(html, /if\(strength<=0&&vignetteStrength===0\) return canvas/);
  assert.match(html, /id="infoBtn"[\s\S]*?aria-pressed="false"/);
});

test('sharpness defaults to zero and increases edge contrast without changing flat areas', () => {
  assert.match(html, /id="sharpness" type="range" min="0" max="100" value="0"/);
  assert.equal((html.match(/applySharpness\((?:layer|editedBase|out),/g) || []).length, 3);
  const sharpen = vm.runInNewContext(`${functionSource('sharpenPixels', 'function applySharpness')};sharpenPixels`);
  const source = new Uint8ClampedArray([100,100,100,255,90,90,90,255,150,150,150,255]);
  const smooth = new Uint8ClampedArray([100,100,100,255,100,100,100,255,130,130,130,255]);
  const unchanged = new Uint8ClampedArray(source);
  sharpen(unchanged,smooth,0);
  assert.deepEqual(unchanged,source);
  const result = new Uint8ClampedArray(source);
  sharpen(result,smooth,.5);
  assert.equal(result[0],100);
  assert.ok(result[4]<90);
  assert.ok(result[8]>150);
  assert.equal(result[11],255);
});

test('luminance denoise acts before 85%, suppresses flat grain and protects a hard edge', () => {
  const denoise = vm.runInNewContext(`${functionSource('denoiseLuminancePixels', 'function applyLuminanceNoiseReduction')};denoiseLuminancePixels`);
  const width = 64, height = 32;
  const original = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const grain = ((x * 17 + y * 43 + x * y * 13) % 23) - 11;
    original[i] = (x < 32 ? 80 : 180) + grain;
    original[i + 1] = original[i] - 10;
    original[i + 2] = original[i] - 20;
    original[i + 3] = 173;
  }
  const filtered = strength => {
    const pixels = new Uint8ClampedArray(original);
    denoise(pixels, width, height, strength);
    return pixels;
  };
  const deviation = pixels => {
    let total = 0, count = 0;
    for (let y = 3; y < height - 3; y++) for (let x = 3; x < width - 3; x++) {
      if (x > 27 && x < 36) continue;
      total += Math.abs(pixels[(y * width + x) * 4] - (x < 32 ? 80 : 180));
      count++;
    }
    return total / count;
  };
  const low = filtered(.25), mid = filtered(.5), high = filtered(1);
  assert.ok(deviation(low) < deviation(original) * .9, '25% should visibly reduce fine grain');
  assert.ok(deviation(mid) < deviation(low), '50% should reduce more grain than 25%');
  assert.ok(deviation(high) < deviation(mid), 'the high end should continue progressively');
  const edge = pixels => pixels[(16 * width + 34) * 4] - pixels[(16 * width + 29) * 4];
  assert.ok(edge(high) > 85, 'the sharp transition should remain distinct');
  assert.equal(mid[0] - mid[1], 10, 'color differences should remain');
  assert.equal(mid[3], 173, 'alpha should remain');
  assert.deepEqual(filtered(0), original);
});

test('Server Lab injects its editor bridge from a Windows CRLF checkout', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = server.indexOf('function createEditorHtml(');
  const end = server.indexOf('\napp.get("/editor"', start);
  const create = vm.runInNewContext(`${server.slice(start, end)};createEditorHtml`, {
    fs: { readFileSync: () => html.replace(/\r?\n/g, '\r\n') },
    path, APP_ROOT: '.'
  });
  const page = create('local-test');
  assert.match(page, /window\.__FILMLAB_SERVER_MODE__=true/);
  assert.match(page, /window\.__FILMLAB_SERVER_EDITOR__=/);
  assert.match(page, /return makePreview\(i\)/);
  assert.match(page, /libraryRestorePromise=Promise\.resolve\(\)/);
  assert.match(page, /item\.cameraProfileId=typeof state\.cameraProfileId/);
  const loadPhoto=page.slice(page.indexOf('    async loadPhoto(file,state,decoded=false){'),page.indexOf('    getCopiedEdits(){'));
  assert.match(loadPhoto, /appendLibraryItem\(item\)/);
  assert.doesNotMatch(loadPhoto, /addFiles\(\[file\]\)/);
});
