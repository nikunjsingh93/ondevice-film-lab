/* GPL-3.0. Isolated Flashback One35 V2 development engine. */
import { RawDecoder, sniffMeta } from "./core/raw-decoder.js?v=20261016-preview-1";
import { factoryStateFor, VIBE_PRESETS } from "./core/config.js?v=20261016-preview-1";
import { generateLut } from "./core/procedural-luts.js?v=20261016-preview-1";
import { parseCube, renderCpu, rgbaFromRgb } from "./cpu.js?v=20261016-preview-1";
import {EXTRA_LOOKS,configForLook,atlasLut,finishLocalLook} from "./looks.js?v=20261016-preview-1";
export const ENGINE_VERSION="20261016-preview-1";
export function validateDng(buffer) {
  const metadata = sniffMeta(buffer);
  if (!/flashback|one35/i.test(metadata.make || ""))
    throw Error(
      "Flashback V2 mode needs an original Flashback One35 V2 DNG. Choose another camera profile for this photo.",
    );
  const dv = new DataView(buffer),
    le = dv.getUint16(0) === 0x4949,
    ifd = dv.getUint32(4, le),
    count = dv.getUint16(ifd, le),
    tags = {};
  if (count > 1024 || ifd + 2 + count * 12 + 4 > buffer.byteLength)
    throw Error("Invalid Flashback DNG header.");
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12,
      type = dv.getUint16(e + 2, le),
      n = dv.getUint32(e + 4, le);
    if (n === 1 && (type === 3 || type === 4))
      tags[dv.getUint16(e, le)] =
        type === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le);
  }
  if (
    tags[256] !== 4144 ||
    tags[257] !== 3088 ||
    tags[258] !== 10 ||
    tags[259] !== 1 ||
    !Number.isInteger(tags[273]) ||
    tags[273] < 8 ||
    tags[273] + 15995840 > buffer.byteLength
  )
    throw Error(
      "Unsupported Flashback DNG layout. This profile supports original, uncompressed One35 V2 10-bit DNGs.",
    );
  return metadata;
}
let decoded = null,
  decodedKey = null,
  processor = null,
  gpuAttempted = false,
  gpuReady = false;
const lutCache = new Map(),
  gpuLuts = new Map();
async function lutFor(config) {
  const url = config.lut_path;
  if (!url) return null;
  if (!lutCache.has(url)) {
    let value;
    if (/\.png$/i.test(url)) {
      const response=await fetch(url);if(!response.ok)throw Error("Could not load camera colour table");
      const image=await createImageBitmap(await response.blob()),canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(image,0,0);value=atlasLut(ctx.getImageData(0,0,image.width,image.height).data,image.width,image.height);image.close();
    } else if (url.startsWith("proc:")) value = generateLut(url.slice(5));
    else {
      const response = await fetch(url);
      if (!response.ok)
        throw Error(
          "Could not load the Flashback film look. Reconnect and try again.",
        );
      value = parseCube(await response.text());
    }
    lutCache.set(url, value);
  }
  return lutCache.get(url);
}
let grainPromise;
async function grainAtlas() {
  if (!grainPromise)
    grainPromise = (async () => {
      const tiles = [];
      for (let i = 1; i <= 4; i++) {
        const response = await fetch(
          new URL(`assets/grain/grain_0${i}.png`, import.meta.url),
        );
        if (!response.ok) throw Error("Could not load Flashback grain");
        const image = await createImageBitmap(await response.blob()),
          canvas = new OffscreenCanvas(image.width, image.height),
          ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, image.width, image.height).data;
        tiles.push({ w: image.width, h: image.height, data });
        image.close();
      }
      const w = tiles[0].w,
        h = tiles[0].h,
        gray = new Float32Array(w * h * 4);
      for (let q = 0; q < 4; q++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            gray[((q >> 1) * h + y) * w * 2 + (q % 2) * w + x] =
              (0.299 * tiles[q].data[i] +
                0.587 * tiles[q].data[i + 1] +
                0.114 * tiles[q].data[i + 2]) /
              255;
          }
      return { w: w * 2, h: h * 2, gray };
    })();
  return grainPromise;
}
async function gpu() {
  if (!gpuAttempted) {
    gpuAttempted = true;
    try {
      const driver = await import("./core/gpu.js?v=20261016-preview-1");
      if (await driver.init()) {
        const { FlashbackProcessor } = await import("./core/processor.js?v=20261016-preview-1");
        processor = new FlashbackProcessor();
        gpuReady = await processor.init();
      }
    } catch (error) {
      console.warn("Flashback GPU unavailable; using CPU development", error);
      processor?.dispose();
      processor = null;
    }
  }
  return gpuReady;
}
export async function develop(request) {
  const look=request.look||"disposable";
  if(!Object.hasOwn(VIBE_PRESETS,look)&&!Object.hasOwn(EXTRA_LOOKS,look))throw Error("Unsupported Flashback look: "+look);
  const key = request.key + ":" + !!request.full;
  if (key !== decodedKey) {
    validateDng(request.buffer);
    processor?.dispose();
    processor = null;
    gpuAttempted = false;
    gpuReady = false;
    for (const lut of gpuLuts.values()) lut.destroy();
    gpuLuts.clear();
    decoded = null;
    decodedKey = null;
    decoded = await new RawDecoder().decode(request.buffer, {
      full: !!request.full,
      cameraWb: true,
    });
    decodedKey = key;
  }
  const config=configForLook(look);
  // The reciprocal spectral sampling is what softens the corners/edges.
  // Full-frame film softness remains part of each factory look.
  if (!request.edgeSoftness) config.enable_chromatic_aberration = false;
  const lut = await lutFor(config);
  let image, original;
  if (!request.forceCpu && (await gpu())) {
    try {
      const driver = await import("./core/gpu.js?v=20261016-preview-1"),
        device = driver.getDevice();
      if (!device || decoded.pixels.byteLength > driver.maxStorageBindingSize())
        throw Error("Flashback image exceeds GPU buffer limits");
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("validation");
      try {
        processor.setConfig(config);
        if (lut) {
          if (!gpuLuts.has(config.lut_path)) {
            const { uploadLut } = await import("./core/lut.js?v=20261016-preview-1");
            gpuLuts.set(
              config.lut_path,
              uploadLut(lut, config.lut_path, config.lut_input_space||"native"),
            );
          }
          processor.setLut(gpuLuts.get(config.lut_path));
        } else processor.setLut(null);
        // Keep effect radii at the same sensor-relative size for preview and export.
        if (processor._filmLabKey !== key) {
          processor._isFlashback = true;
          processor._revGain = 1;
          await processor.preprocess(
            decoded.pixels,
            decoded.width,
            decoded.height,
            decoded.ccm,
          );
          processor._filmLabKey = key;
        }
        image = await processor._locked(() =>
          processor._render(processor._full, { scale: decoded.width / 2072 }),
        );
        if (request.includeOriginal)
          original = await processor.renderPreview({ original: true });
      } finally {
        const validation = await device.popErrorScope(),
          memory = await device.popErrorScope();
        if (validation || memory) throw Error((validation || memory).message);
      }
    } catch (error) {
      console.warn(
        "Flashback GPU render failed; retrying in CPU worker",
        error,
      );
      processor?.dispose();
      processor = null;
      gpuReady = false;
      image = original = null;
    }
  }
  if (!image) {
    const grain = config.enable_grain ? await grainAtlas() : null;
    image = rgbaFromRgb(renderCpu(decoded, config, lut, grain));
    if (request.includeOriginal) {
      const neutral = factoryStateFor("natural");
      neutral.display_cal_r = neutral.display_cal_g = neutral.display_cal_b = 1;
      original = rgbaFromRgb(renderCpu(decoded, neutral, null, null));
    }
  }
  finishLocalLook(image,look);
  const result = {
    look,engineVersion:ENGINE_VERSION,
    image: { data: image.data, width: image.width, height: image.height },
    original: original
      ? { data: original.data, width: original.width, height: original.height }
      : null,
    sourceWidth: 4144,
    sourceHeight: 3088,
    backend: image.constructor?.name === "ImageData" ? "WebGPU" : "CPU",
  };
  if (request.full) {
    processor?.dispose();
    processor = null;
    decoded = null;
    decodedKey = null;
    gpuAttempted = false;
    gpuReady = false;
    for (const lut of gpuLuts.values()) lut.destroy();
    gpuLuts.clear();
  }
  return result;
}
if (
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof document === "undefined"
) {
  let chain = Promise.resolve();
  self.onmessage = (event) => {
    const request = event.data;
    chain = chain
      .catch(() => {})
      .then(async () => {
        try {
          const result = await develop(request);
          self.postMessage({ id: request.id, ...result }, [
            result.image.data.buffer,
            ...(result.original ? [result.original.data.buffer] : []),
          ]);
        } catch (error) {
          self.postMessage({
            id: request.id,
            error: error.message || String(error),
          });
        }
      });
  };
}
