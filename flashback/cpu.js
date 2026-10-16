/* GPL-3.0. CPU backend for the Flashback worker; colour transforms mirror
 * the vendored WGSL pipeline. Wide blurs use a pyramid; bilateral CNR is
 * separable to keep full-resolution exports usable without WebGPU. */
import {
  ACESCG_TO_PROPHOTO,
  PROPHOTO_TO_LINSRGB,
  HALATION_SCALES,
  CNR_SIGMA_SPACE,
  CNR_SIGMA_COLOR,
  CNR_THR_GREEN,
  CNR_THR_OTHER,
  GRAIN_TILE_SCALE,
  GRAIN_HIGHLIGHT_BIAS,
} from "./core/config.js";
export const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const encode = (v) =>
  v <= 0.0078125
    ? 10.5402377416545 * v + 0.0729055341958355
    : (Math.log2(Math.max(v, 1e-10)) + 9.72) / 17.52;
export function matrix(data, m) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    for (let c = 0; c < 3; c++)
      out[i + c] = m[c * 3] * r + m[c * 3 + 1] * g + m[c * 3 + 2] * b;
  }
  return out;
}
export function parseCube(text) {
  let size = 0,
    values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    if (line.startsWith("LUT_3D_SIZE")) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (/^[A-Z]/.test(line)) continue;
    const v = line.split(/\s+/).slice(0, 3).map(Number);
    if (v.length === 3 && v.every(Number.isFinite)) values.push(...v);
  }
  if (
    !Number.isInteger(size) ||
    size < 2 ||
    size > 129 ||
    values.length !== size ** 3 * 3
  )
    throw Error("Invalid bundled Flashback LUT");
  const data = new Float32Array(values.length);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const src = ((b * size + g) * size + r) * 3,
          dst = ((r * size + g) * size + b) * 3;
        data.set(values.slice(src, src + 3), dst);
      }
  return { size, data };
}
// Six-tetrahedron interpolation, identical axis order and weights to lut.wgsl.
export function sampleLut(lut, r, g, b, out, offset = 0) {
  const n = lut.size,
    rr = clamp(r) * (n - 1),
    gg = clamp(g) * (n - 1),
    bb = clamp(b) * (n - 1),
    r0 = Math.min(Math.floor(rr), n - 2),
    g0 = Math.min(Math.floor(gg), n - 2),
    b0 = Math.min(Math.floor(bb), n - 2),
    rx = rr - r0,
    gx = gg - g0,
    bx = bb - b0;
  const i = ((r0 * n + g0) * n + b0) * 3,
    R = n * n * 3,
    G = n * 3,
    B = 3;
  let j, k, a0, a1, a2, a3;
  if (rx >= gx && gx >= bx) {
    j = i + R;
    k = i + R + G;
    a0 = 1 - rx;
    a1 = rx - gx;
    a2 = gx - bx;
    a3 = bx;
  } else if (rx >= bx && bx > gx) {
    j = i + R;
    k = i + R + B;
    a0 = 1 - rx;
    a1 = rx - bx;
    a2 = bx - gx;
    a3 = gx;
  } else if (gx > rx && rx >= bx) {
    j = i + G;
    k = i + G + R;
    a0 = 1 - gx;
    a1 = gx - rx;
    a2 = rx - bx;
    a3 = bx;
  } else if (bx > rx && rx >= gx) {
    j = i + B;
    k = i + B + R;
    a0 = 1 - bx;
    a1 = bx - rx;
    a2 = rx - gx;
    a3 = gx;
  } else if (gx >= bx && bx > rx) {
    j = i + G;
    k = i + G + B;
    a0 = 1 - gx;
    a1 = gx - bx;
    a2 = bx - rx;
    a3 = rx;
  } else {
    j = i + B;
    k = i + B + G;
    a0 = 1 - bx;
    a1 = bx - gx;
    a2 = gx - rx;
    a3 = rx;
  }
  const data = lut.data,
    z = i + R + G + B;
  for (let c = 0; c < 3; c++)
    out[offset + c] =
      a0 * data[i + c] + a1 * data[j + c] + a2 * data[k + c] + a3 * data[z + c];
}
const curveX = [0, 0.02, 0.06, 0.2, 0.4, 0.78, 1],
  curveY = [0, 0.02, 0.1, 0.42, 0.7, 0.95, 1];
export function tone(v) {
  v = clamp(v);
  for (let i = 1; i < 7; i++)
    if (v <= curveX[i])
      return (
        curveY[i - 1] +
        ((curveY[i] - curveY[i - 1]) * (v - curveX[i - 1])) /
          (curveX[i] - curveX[i - 1])
      );
  return 1;
}
const oetf = (v) =>
  (v = clamp(v)) <= 0.0031308
    ? 12.92 * v
    : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
export function displayTransform(linear, lut, config = {}) {
  let rgb;
  if (lut && config.lut_input_space==="srgb") {
    const natural=displayTransform(linear,null,{});rgb=new Float32Array(linear.length);
    for(let i=0;i<linear.length;i+=3)sampleLut(lut,natural[i],natural[i+1],natural[i+2],rgb,i);
  } else if (lut) {
    rgb = new Float32Array(linear.length);
    for (let i = 0; i < linear.length; i += 3)
      sampleLut(
        lut,
        encode(linear[i]),
        encode(linear[i + 1]),
        encode(linear[i + 2]),
        rgb,
        i,
      );
  } else {
    const pro = matrix(linear, ACESCG_TO_PROPHOTO);
    for (let i = 0; i < pro.length; i++) pro[i] = tone(pro[i]);
    rgb = matrix(pro, PROPHOTO_TO_LINSRGB);
    for (let i = 0; i < rgb.length; i++) rgb[i] = oetf(rgb[i]);
  }
  const cal = [
    config.display_cal_r ?? 1,
    config.display_cal_g ?? 1,
    config.display_cal_b ?? 1,
  ];
  for (let i = 0; i < rgb.length; i++) rgb[i] *= cal[i % 3];
  return rgb;
}
export function sample(data, w, h, x, y, c) {
  x = clamp(x, 0, w - 1);
  y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(w - 1, x0 + 1),
    y1 = Math.min(h - 1, y0 + 1),
    fx = x - x0,
    fy = y - y0;
  return (
    (data[(y0 * w + x0) * 3 + c] * (1 - fx) +
      data[(y0 * w + x1) * 3 + c] * fx) *
      (1 - fy) +
    (data[(y1 * w + x0) * 3 + c] * (1 - fx) +
      data[(y1 * w + x1) * 3 + c] * fx) *
      fy
  );
}
function reduce(data, w, h, factor) {
  const nw = Math.ceil(w / factor),
    nh = Math.ceil(h / factor),
    out = new Float32Array(nw * nh * 3);
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      let count = 0;
      const i = (y * nw + x) * 3;
      for (let dy = 0; dy < factor && y * factor + dy < h; dy++)
        for (let dx = 0; dx < factor && x * factor + dx < w; dx++) {
          const j = ((y * factor + dy) * w + x * factor + dx) * 3;
          for (let c = 0; c < 3; c++) out[i + c] += data[j + c];
          count++;
        }
      for (let c = 0; c < 3; c++) out[i + c] /= count;
    }
  return { data: out, w: nw, h: nh };
}
export function blur(data, w, h, sigma) {
  if (sigma < 0.05) return data.slice();
  if (sigma > 4 && Math.min(w, h) > 8) {
    const small = reduce(data, w, h, 2),
      soft = blur(small.data, small.w, small.h, sigma / 2),
      out = new Float32Array(data.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++)
          out[(y * w + x) * 3 + c] = sample(
            soft,
            small.w,
            small.h,
            (x + 0.5) / 2 - 0.5,
            (y + 0.5) / 2 - 0.5,
            c,
          );
    return out;
  }
  const radius = Math.max(1, Math.ceil(sigma * 3)),
    kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
      Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
    ),
    sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  let src = data;
  for (let axis = 0; axis < 2; axis++) {
    const out = new Float32Array(data.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        for (let k = -radius; k <= radius; k++) {
          const j =
              (clamp(y + (axis ? k : 0), 0, h - 1) * w +
                clamp(x + (axis ? 0 : k), 0, w - 1)) *
              3,
            weight = kernel[k + radius];
          for (let c = 0; c < 3; c++) out[i + c] += src[j + c] * weight;
        }
      }
    src = out;
  }
  return src;
}
const xyz = [
    0.6624541811, 0.1340042065, 0.1561876744, 0.2722287168, 0.6740817658,
    0.0536895174, -0.0055746495, 0.0040607335, 1.0103391685,
  ],
  inv = [
    1.6410233797, -0.3248032942, -0.2364246952, -0.6636628587, 1.6153315917,
    0.0167563477, 0.0117218943, -0.008284442, 0.9883948585,
  ],
  white = [0.95265, 1, 1.00883];
function cnr(data, w, h) {
  const lab = matrix(data, xyz),
    f = (v) =>
      v > 0.00885645167 ? Math.cbrt(v) : 7.78703703704 * v + 0.13793103448;
  for (let i = 0; i < lab.length; i += 3) {
    const x = f(Math.max(0, lab[i]) / white[0]),
      y = f(Math.max(0, lab[i + 1])),
      z = f(Math.max(0, lab[i + 2]) / white[2]);
    lab[i] = 116 * y - 16;
    lab[i + 1] = 500 * (x - y);
    lab[i + 2] = 200 * (y - z);
  }
  let src = lab.slice();
  const a = new Float32Array(9),
    b = new Float32Array(9);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 3;
          a[k] = lab[j + 1];
          b[k++] = lab[j + 2];
        }
      a.sort();
      b.sort();
      src[i + 1] = clamp(
        lab[i + 1],
        a[4] - CNR_THR_GREEN,
        a[4] + CNR_THR_OTHER,
      );
      src[i + 2] = clamp(
        lab[i + 2],
        b[4] - CNR_THR_OTHER,
        b[4] + CNR_THR_OTHER,
      );
    }
  for (let axis = 0; axis < 2; axis++) {
    const out = src.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        let sa = 0,
          sb = 0,
          wa = 0,
          wb = 0;
        for (let k = -6; k <= 6; k++) {
          const j =
              (clamp(y + (axis ? k : 0), 0, h - 1) * w +
                clamp(x + (axis ? 0 : k), 0, w - 1)) *
              3,
            sp = Math.exp((-0.5 * k * k) / CNR_SIGMA_SPACE ** 2),
            da = src[j + 1] - src[i + 1],
            db = src[j + 2] - src[i + 2],
            aa = sp * Math.exp((-0.5 * da * da) / CNR_SIGMA_COLOR ** 2),
            bb = sp * Math.exp((-0.5 * db * db) / CNR_SIGMA_COLOR ** 2);
          sa += src[j + 1] * aa;
          sb += src[j + 2] * bb;
          wa += aa;
          wb += bb;
        }
        out[i + 1] = sa / wa;
        out[i + 2] = sb / wb;
      }
    src = out;
  }
  const fi = (t) =>
    t > 0.20689655172 ? t * t * t : (t - 0.13793103448) / 7.78703703704;
  for (let i = 0; i < src.length; i += 3) {
    const fy = (src[i] + 16) / 116;
    src[i] = fi(src[i + 1] / 500 + fy) * white[0];
    src[i + 1] = fi(fy);
    src[i + 2] = fi(fy - src[i + 2] / 200) * white[2];
  }
  return matrix(src, inv);
}
function preEffects(data, w, h, c, scale, ev) {
  let cur = data;
  if (c.enable_halation && c.halation_strength > 0) {
    const threshold =
      (Math.log2(0.18 * 2 ** ((c.halation_threshold_stops ?? 4.5) + ev)) +
        9.72) /
      17.52;
    cur = data.slice();
    for (const [rad, off, weight, gf, bf] of HALATION_SCALES) {
      const mask = new Float32Array(data.length),
        strength = weight * c.halation_strength,
        warm = (c.halation_warmth_pct ?? 120) / 100,
        tints = [strength, strength * gf ** warm, strength * bf ** warm];
      for (let i = 0; i < data.length; i += 3) {
        const max = Math.max(data[i], data[i + 1], data[i + 2]),
          log = max <= 0 ? 0 : (Math.log2(max) + 9.72) / 17.52,
          m = 1 / (1 + Math.exp(-20 * (log - Math.min(threshold + off, 0.98))));
        for (let k = 0; k < 3; k++) mask[i + k] = data[i + k] * m * tints[k];
      }
      const glow = blur(
        mask,
        w,
        h,
        Math.max(1, c.halation_blur_radius ?? 8) * scale * rad,
      );
      for (let i = 0; i < cur.length; i++) cur[i] += glow[i];
    }
  }
  if (c.enable_vignette && c.vignette_strength > 0)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d =
            Math.hypot((x - w * 0.5) / (w * 0.5), (y - h * 0.5) / (h * 0.5)) /
            Math.SQRT2,
          start = 1 - clamp(c.vignette_feather ?? 1),
          t = clamp((d - start) / Math.max(1e-9, 1 - start)),
          fall = t * t * (3 - 2 * t),
          v = 1 - c.vignette_strength * fall,
          cs = c.vignette_color_shift ?? 0.05,
          i = (y * w + x) * 3;
        cur[i] = Math.max(0, cur[i] * (v - cs * fall));
        cur[i + 1] = Math.max(0, cur[i + 1] * v);
        cur[i + 2] = Math.max(0, cur[i + 2] * (v + cs * 0.4 * fall));
      }
  if (c.enable_bloom && c.bloom_strength > 0) {
    const small = reduce(cur, w, h, 4),
      threshold =
        (Math.log2(0.18 * 2 ** (c.bloom_threshold_stops ?? 3)) + 9.72) / 17.52;
    for (let i = 0; i < small.data.length; i += 3) {
      const lum =
          small.data[i] * 0.2722 +
          small.data[i + 1] * 0.6741 +
          small.data[i + 2] * 0.0537,
        log = lum <= 0 ? 0 : (Math.log2(lum) + 9.72) / 17.52,
        m = clamp((log - threshold) / Math.max(0.001, 1 - threshold));
      for (let k = 0; k < 3; k++) small.data[i + k] *= m;
    }
    const glow = blur(
      small.data,
      small.w,
      small.h,
      Math.max(2, Math.max(small.w, small.h) / 5),
    );
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let k = 0; k < 3; k++)
          cur[(y * w + x) * 3 + k] +=
            sample(
              glow,
              small.w,
              small.h,
              ((x + 0.5) * small.w) / w - 0.5,
              ((y + 0.5) * small.h) / h - 0.5,
              k,
            ) * c.bloom_strength;
  }
  return c.enable_cnr ? cnr(cur, w, h) : cur;
}
function liveEffects(data, w, h, c, scale, grain) {
  let cur = data;
  if (c.enable_chromatic_aberration && c.ca_strength > 0) {
    const out = new Float32Array(cur.length),
      weights = Array.from({ length: 8 }, (_, i) => {
        const t = i / 7;
        return [
          Math.exp(-t * t * 8),
          Math.exp(-((t - 0.5) ** 2) * 8),
          Math.exp(-((t - 1) ** 2) * 8),
        ];
      }),
      sums = [0, 1, 2].map((k) => weights.reduce((a, v) => a + v[k], 0));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          for (let t = 0; t < 8; t++) {
            const sc = 1 / (1 + (c.ca_strength * t) / 7);
            sum +=
              sample(
                cur,
                w,
                h,
                w * 0.5 + (x - w * 0.5) * sc,
                h * 0.5 + (y - h * 0.5) * sc,
                k,
              ) * weights[t][k];
          }
          out[(y * w + x) * 3 + k] = sum / sums[k];
        }
    cur = out;
  }
  if (c.enable_softness && c.softness_sigma > 0.01)
    cur = blur(cur, w, h, c.softness_sigma * scale);
  if (c.enable_sharpen && c.sharpen_strength > 0) {
    const soft = blur(cur, w, h, Math.max(0.3, c.sharpen_radius ?? 1) * scale);
    for (let i = 0; i < cur.length; i++)
      cur[i] = clamp(cur[i] + (cur[i] - soft[i]) * c.sharpen_strength);
  }
  if (c.enable_grain && c.grain_strength > 0 && grain)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const g =
            grain.gray[
              (Math.floor((y * GRAIN_TILE_SCALE) / scale) % grain.h) * grain.w +
                (Math.floor((x * GRAIN_TILE_SCALE) / scale) % grain.w)
            ],
          delta = (2 * g - 1) * c.grain_strength;
        for (let k = 0; k < 3; k++) {
          const i = (y * w + x) * 3 + k,
            v = cur[i],
            weight =
              (1 - GRAIN_HIGHLIGHT_BIAS) * (1 - v) + GRAIN_HIGHLIGHT_BIAS * v;
          cur[i] = clamp(v + delta * (0.2 + weight * 0.8));
        }
      }
  return cur;
}
export function renderCpu(decoded, config, lut, grain) {
  const { width: w, height: h } = decoded,
    scale = w / 2072,
    ev = lut && config.lut_input_space!=="srgb" ? (config.base_lift_ev ?? 2) : 0;
  let data = matrix(decoded.pixels, decoded.ccm);
  const gain = 2 ** ev;
  for (let i = 0; i < data.length; i++) data[i] *= gain;
  data = preEffects(data, w, h, config, scale, ev);
  data = displayTransform(data, lut, config);
  data = liveEffects(data, w, h, config, scale, grain);
  const k = lut && config.lut_input_space!=="srgb" ? (config.base_push_ev ?? 0) / 2 : 0;
  if (Math.abs(k) > 1e-4)
    for (let i = 0; i < data.length; i++) {
      const d = clamp(data[i]);
      data[i] =
        k >= 0 ? d + (d * d * (3 - 2 * d) - d) * k : d + (0.5 - d) * (-k * 0.4);
    }
  return { rgb: data, width: w, height: h };
}
export function rgbaFromRgb({ rgb, width, height }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    data[j] = rgb[i] * 255;
    data[j + 1] = rgb[i + 1] * 255;
    data[j + 2] = rgb[i + 2] * 255;
    data[j + 3] = 255;
  }
  return { data, width, height };
}
