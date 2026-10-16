"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const makeDng = require("./fixtures/flashback-dng.js");
const modules = Promise.all([
  import("../../flashback/cpu.js"),
  import("../../flashback/core/config.js"),
  import("../../flashback/core/raw-decoder.js"),
  import("../../flashback/core/one35-dng.js"),
  import("../../flashback/worker.js"),
]);
let bytes;
function fixture() {
  return bytes || (bytes = makeDng());
}
function arrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}
test("Flashback reads original 10-bit Bayer data, subtracts black, applies as-shot WB and calibrated ACEScg matrix", async () => {
  const [, config, { RawDecoder }, { decodeOne35HalfSize }, { validateDng }] =
      await modules,
    buffer = arrayBuffer(fixture());
  assert.equal(validateDng(buffer).model, "One35 V2");
  const raw = decodeOne35HalfSize(buffer);
  assert.equal(raw.width, 2072);
  assert.equal(raw.height, 1544);
  const decoded = await new RawDecoder().decode(buffer, { cameraWb: true });
  const neutral = [0.541, 1, 0.597];
  for (const i of [0, (500 * 2072 + 1000) * 3, (1000 * 2072 + 2000) * 3])
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(decoded.pixels[i + c] - raw.pixels[i + c] / neutral[c]) < 1e-6,
      );
  assert.deepEqual(decoded.ccm, config.FM1_WB_TO_ACESCG);
  assert.ok(
    decoded.pixels.some((v) => Math.abs(v * 255 - Math.round(v * 255)) > 0.01),
    "RAW is retained as linear floats, not quantised to 8-bit RGB",
  );
});
test("full-resolution Flashback decoding retains sensor dimensions and the same calibration as preview", async () => {
  const [, , { RawDecoder }] = await modules,
    buffer = arrayBuffer(fixture()),
    full = await new RawDecoder().decode(buffer, {
      full: true,
      cameraWb: true,
    }),
    half = await new RawDecoder().decode(buffer, { cameraWb: true });
  assert.equal(full.width, 4144);
  assert.equal(full.height, 3088);
  assert.deepEqual(full.ccm, half.ccm);
  const hi = (500 * 2072 + 1000) * 3,
    fi = (1000 * 4144 + 2000) * 3;
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(full.pixels[fi + c] - half.pixels[hi + c]) < 0.004);
});
test("camera validation rejects another camera, unsupported packing, and truncated DNG data", async () => {
  const [, , , , { validateDng }] = await modules;
  assert.throws(() => validateDng(new ArrayBuffer(30)), /original Flashback/);
  const wrong = Buffer.from(fixture());
  wrong.write("Panasonic", 600);
  assert.throws(() => validateDng(arrayBuffer(wrong)), /original Flashback/);
  assert.throws(
    () => validateDng(arrayBuffer(fixture().subarray(0, 8000))),
    /layout/,
  );
});
test("tetrahedral cube lookup preserves channel order in all six interpolation regions", async () => {
  const [{ parseCube, sampleLut }] = await modules;
  let text = "LUT_3D_SIZE 2\n";
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++)
      for (let r = 0; r < 2; r++)
        text += `${r * 0.7 + 0.1} ${g * 0.5 + 0.2} ${b * 0.3 + 0.4}\n`;
  const lut = parseCube(text),
    out = new Float32Array(3);
  for (const p of [
    [0.8, 0.5, 0.2],
    [0.8, 0.2, 0.5],
    [0.5, 0.8, 0.2],
    [0.5, 0.2, 0.8],
    [0.2, 0.8, 0.5],
    [0.2, 0.5, 0.8],
    [0, 0, 0],
    [1, 1, 1],
  ]) {
    sampleLut(lut, ...p, out);
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(out[c] - (p[c] * [0.7, 0.5, 0.3][c] + [0.1, 0.2, 0.4][c])) <
          1e-6,
      );
  }
  assert.throws(() => parseCube("LUT_3D_SIZE 65\n0 0 0"), /Invalid/);
});
test("all eight factory looks ship their LUTs or procedural generators and use distinct film exposure defaults", async () => {
  const [{ parseCube, renderCpu }, { factoryStateFor, VIBE_PRESETS }, , ,] =
    await modules;
  assert.equal(Object.keys(VIBE_PRESETS).length, 8);
  const { generateLut } = await import(
    "../../flashback/core/procedural-luts.js"
  );
  for (const id of Object.keys(VIBE_PRESETS)) {
    const config = factoryStateFor(id);
    let lut = null;
    if (config.lut_path)
      lut = config.lut_path.startsWith("proc:")
        ? generateLut(config.lut_path.slice(5))
        : parseCube(fs.readFileSync(new URL(config.lut_path), "utf8"));
    if (lut) assert.ok(lut.data.every(Number.isFinite));
    const settings = {
      ...config,
      enable_halation: false,
      enable_vignette: false,
      enable_bloom: false,
      enable_cnr: false,
      enable_chromatic_aberration: false,
      enable_softness: false,
      enable_sharpen: false,
      enable_grain: false,
    };
    const output = renderCpu(
      {
        pixels: Float32Array.from([0.04, 0.08, 0.12, 0.12, 0.08, 0.04]),
        width: 2,
        height: 1,
        ccm: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
      settings,
      lut,
      null,
    );
    assert.ok(
      output.rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
      id,
    );
  }
  assert.equal(factoryStateFor("flashback_v1").base_lift_ev, 0);
  assert.equal(factoryStateFor("disposable").base_lift_ev, 2);
  assert.equal(factoryStateFor("natural").enable_lut, false);
});
test("web, lab and offline packages include the isolated engine and exports request original full-resolution DNG processing", () => {
  const root = path.resolve(__dirname, "../.."),
    html = fs.readFileSync(path.join(root, "index.html"), "utf8"),
    sw = fs.readFileSync(path.join(root, "sw.js"), "utf8"),
    bridge = fs.readFileSync(
      path.join(root, "lab/public/lab-editor.js"),
      "utf8",
    );
  assert.match(
    html,
    /FilmLabFlashback\.render\(it\.file,settings,\{full:true\}\)/,
  );
  assert.match(
    html,
    /FilmLabFlashback\.render\(it\.file,settings,\{includeOriginal:true\}\)/,
  );
  assert.equal(
    (bridge.match(/file\._filmLabOriginalUrl=photo.originalUrl/g) || []).length,
    2,
  );
  assert.match(html, /#flashbackControls\[hidden\]\{display:none!important\}/);
  function walk(dir) {
    for (const file of fs.readdirSync(path.join(root, dir))) {
      const p = dir + "/" + file;
      if (fs.statSync(path.join(root, p)).isDirectory()) walk(p);
      else
        assert.ok(
          sw.includes(JSON.stringify("./" + p)),
          `Offline cache missing ${p}`,
        );
    }
  }
  walk("flashback");
});
