/* GPL-3.0. Flashback One35 V2 decoder, extracted from raw-decoder.js.
 * Retains the upstream Bayer demosaic, raw-domain highlight recovery,
 * camera AsShotNeutral white balance, and calibrated FM1 -> ACEScg path.
 * Other cameras continue through Film Lab's existing RAW decoder. */
import {ASN_D50,FM1_WB_TO_ACESCG,FLASHBACK_EXPOSURE_COMP_EV} from './config.js';
import {decodeOne35HalfSize,decodeOne35Full} from './one35-dng.js';
const FLASHBACK_EDGE_CROP=0;
function recoverHighlights(pixels, asn, threshold = 0.95) {
  const n = pixels.length / 3;
  const aInv = [1 / asn[0], 1 / asn[1], 1 / asn[2]];

  // First pass: detect clipped pixels and accumulate chrominance from near-clip region.
  const clipped = new Uint8Array(pixels.length);
  let anyClipped = false;
  const sums   = [0, 0, 0];
  const counts = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const b = i * 3;
    const r = pixels[b], g = pixels[b + 1], bv = pixels[b + 2];
    const cR = r  >= threshold ? 1 : 0;
    const cG = g  >= threshold ? 1 : 0;
    const cB = bv >= threshold ? 1 : 0;
    clipped[b] = cR; clipped[b + 1] = cG; clipped[b + 2] = cB;
    if (cR || cG || cB) anyClipped = true;

    // Near-clip (but not clipped) pixels → chrominance reference sample.
    const maxRaw = Math.max(r, g, bv);
    if (maxRaw >= 0.85 && maxRaw < threshold) {
      const rw = r * aInv[0], gw = g * aInv[1], bw = bv * aInv[2];
      const Rc = Math.cbrt(rw < 0 ? 0 : rw);
      const Gc = Math.cbrt(gw < 0 ? 0 : gw);
      const Bc = Math.cbrt(bw < 0 ? 0 : bw);
      const refR = Math.pow((Gc + Bc) * 0.5, 3);
      const refG = Math.pow((Rc + Bc) * 0.5, 3);
      const refB = Math.pow((Rc + Gc) * 0.5, 3);
      if (!cR) { sums[0] += rw - refR; counts[0]++; }
      if (!cG) { sums[1] += gw - refG; counts[1]++; }
      if (!cB) { sums[2] += bw - refB; counts[2]++; }
    }
  }

  // Per-channel chrominance offset (scalar — same as OP's global mean).
  const chroma = [
    counts[0] >= 30 ? sums[0] / counts[0] : 0,
    counts[1] >= 30 ? sums[1] / counts[1] : 0,
    counts[2] >= 30 ? sums[2] / counts[2] : 0,
  ];

  // Second pass: WB-normalise every pixel; reconstruct where clipped.
  if (!anyClipped) {
    for (let i = 0; i < pixels.length; i++) pixels[i] *= aInv[i % 3];
    return;
  }
  for (let i = 0; i < n; i++) {
    const b  = i * 3;
    const r  = pixels[b], g = pixels[b + 1], bv = pixels[b + 2];
    const rw = r  * aInv[0];
    const gw = g  * aInv[1];
    const bw = bv * aInv[2];
    const Rc = Math.cbrt(rw < 0 ? 0 : rw);
    const Gc = Math.cbrt(gw < 0 ? 0 : gw);
    const Bc = Math.cbrt(bw < 0 ? 0 : bw);
    const refR = Math.pow((Gc + Bc) * 0.5, 3) + chroma[0];
    const refG = Math.pow((Rc + Bc) * 0.5, 3) + chroma[1];
    const refB = Math.pow((Rc + Gc) * 0.5, 3) + chroma[2];
    // max() prevents reconstruction from darkening non-clipped bright areas.
    pixels[b]     = clipped[b]     ? Math.max(rw, refR) : rw;
    pixels[b + 1] = clipped[b + 1] ? Math.max(gw, refG) : gw;
    pixels[b + 2] = clipped[b + 2] ? Math.max(bw, refB) : bw;
  }
}

// The Flashback CCM (raw → ACEScg) is now computed per-shot via
// computeFlashbackCCM() in _decodeBody, using whichever FM1 is available:
//  - The DNG's own ForwardMatrix1 tag (0xC714) if present (A1).
//  - The hardcoded FM1 from config.js as fallback.
// LIBRAW_PREMUL and FLASHBACK_EXPOSURE_COMP_EV are folded in the same way as
// before; per-shot AsShotNeutral scales LIBRAW_PREMUL proportionally (A2).


export function sniffMeta(buffer) {
  const out = { make: null, model: null, exposureS: null, iso: null, fNumber: null,
                focalLength: null, dateTaken: null, asn: null, fm1: null, baselineExposure: null };
  try {
    const dv = new DataView(buffer);
    if (dv.byteLength < 16) return out;
    const order = dv.getUint16(0, false);
    let le;
    if (order === 0x4949) le = true;        // "II"
    else if (order === 0x4D4D) le = false;  // "MM"
    else return out;
    if (dv.getUint16(2, le) !== 42) return out;

    /** Scan one IFD; returns a map of wanted tag id → entry offset. */
    const scan = (ifd, wanted) => {
      const found = {};
      if (ifd <= 0 || ifd + 2 > dv.byteLength) return found;
      const n = dv.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > dv.byteLength) break;
        const tag = dv.getUint16(e, le);
        if (wanted.includes(tag)) found[tag] = e;
      }
      return found;
    };

    /** Read an ASCII tag's string value from an entry offset. */
    const ascii = (e) => {
      const count = dv.getUint32(e + 4, le);
      const off = count <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      if (off + count > dv.byteLength) return null;
      let s = '';
      for (let k = 0; k < count - 1; k++) s += String.fromCharCode(dv.getUint8(off + k));
      return s.trim();
    };

    // DNG writers scatter these: DateTimeOriginal (0x9003) can live in IFD0
    // (Leica does this) or in the Exif sub-IFD; 0x0132 ModifyDate is the
    // last-ditch fallback. Scan both IFDs for everything.
    const ifd0 = scan(dv.getUint32(4, le), [0x010F, 0x0110, 0x0132, 0x8769, 0x9003, 0xC628, 0xC714, 0xC62A]);

    if (ifd0[0x010F] !== undefined) out.make = ascii(ifd0[0x010F]);
    if (ifd0[0x0110] !== undefined) out.model = ascii(ifd0[0x0110]);

    // BaselineExposure (0xC62A): one SRATIONAL (type 10) EV — the manufacturer/
    // ACR intended lift from raw mid-grey to display mid-grey. Tier-1 signal for
    // generic-RAW exposure anchoring (foreign DNGs / ProRAW). Mirrors upstream.
    if (ifd0[0xC62A] !== undefined) {
      const e = ifd0[0xC62A];
      const type = dv.getUint16(e + 2, le);
      if (type === 10 || type === 5) {
        const off = dv.getUint32(e + 8, le);   // SRATIONAL is 8 bytes → out-of-line
        if (off + 8 <= dv.byteLength) {
          const n = type === 10 ? dv.getInt32(off, le)     : dv.getUint32(off, le);
          const d = type === 10 ? dv.getInt32(off + 4, le) : dv.getUint32(off + 4, le);
          if (d) out.baselineExposure = n / d;
        }
      }
    }

    // AsShotNeutral (0xC628), 3 values — the One35 stores them as SHORT/LONG
    // integers (e.g. [480,1024,583]) rather than the usual RATIONALs, so read
    // by the entry's actual type and normalise to G=1.
    if (ifd0[0xC628] !== undefined) {
      const e = ifd0[0xC628];
      const type = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      if (count === 3) {
        const sz = type === 5 ? 8 : (type === 3 ? 2 : 4);
        const off = sz * 3 <= 4 ? e + 8 : dv.getUint32(e + 8, le);
        if (off + sz * 3 <= dv.byteLength) {
          const v = [];
          for (let k = 0; k < 3; k++) {
            const p = off + k * sz;
            if (type === 5) { const n = dv.getUint32(p, le), d = dv.getUint32(p + 4, le); v.push(d ? n / d : 0); }
            else if (type === 3) v.push(dv.getUint16(p, le));
            else v.push(dv.getUint32(p, le));
          }
          if (v[0] > 0 && v[1] > 0 && v[2] > 0) out.asn = [v[0] / v[1], 1, v[2] / v[1]];
        }
      }
    }

    // ForwardMatrix1 (0xC714): 9 SRATIONAL (type 10) or RATIONAL (type 5) values,
    // row-major camera-sensor-RGB → XYZ_D50. rawpy reads this from the DNG directly;
    // we previously hardcoded it as FM1 in config.js. Reading it per-shot lets us
    // use the camera's own calibration matrix, matching rawpy's pipeline exactly.
    if (ifd0[0xC714] !== undefined) {
      const e     = ifd0[0xC714];
      const type  = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      if (count === 9 && (type === 5 || type === 10)) {
        const off = dv.getUint32(e + 8, le);
        if (off + 72 <= dv.byteLength) {
          const fm = [];
          for (let k = 0; k < 9; k++) {
            const p = off + k * 8;
            // SRATIONAL uses signed int32, RATIONAL uses unsigned uint32.
            const n = type === 10 ? dv.getInt32(p, le)     : dv.getUint32(p, le);
            const d = type === 10 ? dv.getInt32(p + 4, le) : dv.getUint32(p + 4, le);
            fm.push(d ? n / d : 0);
          }
          out.fm1 = fm;
        }
      }
    }

    // Read a RATIONAL (8 bytes, out-of-line) at an entry offset → number | null.
    const ratAt = (e) => {
      const off = dv.getUint32(e + 8, le);
      if (off + 8 > dv.byteLength) return null;
      const num = dv.getUint32(off, le), den = dv.getUint32(off + 4, le);
      return den > 0 ? num / den : null;
    };
    // Read a SHORT/LONG (inline) at an entry offset → number.
    const intAt = (e) => (dv.getUint16(e + 2, le) === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le));

    if (ifd0[0x8769] !== undefined) {
      const exifIfd = dv.getUint32(ifd0[0x8769] + 8, le);
      // ExposureTime, ISO, FNumber, FocalLength, DateTimeOriginal
      const exif = scan(exifIfd, [0x829A, 0x8827, 0x829D, 0x920A, 0x9003]);
      if (exif[0x829A] !== undefined) { const v = ratAt(exif[0x829A]); if (v) out.exposureS = v; }
      if (exif[0x8827] !== undefined) { const v = intAt(exif[0x8827]); if (v) out.iso = v; }
      if (exif[0x829D] !== undefined) { const v = ratAt(exif[0x829D]); if (v) out.fNumber = v; }
      if (exif[0x920A] !== undefined) { const v = ratAt(exif[0x920A]); if (v) out.focalLength = v; }
      if (exif[0x9003] !== undefined) out.dateTaken = ascii(exif[0x9003]);
    }
    if (!out.dateTaken && ifd0[0x9003] !== undefined) out.dateTaken = ascii(ifd0[0x9003]);
    if (!out.dateTaken && ifd0[0x0132] !== undefined) out.dateTaken = ascii(ifd0[0x0132]);
    return out;
  } catch {
    return out;
  }
}


export class RawDecoder {
 async decode(buffer,opts={}) {
 const sniffed=sniffMeta(buffer),halfSize=!opts.full;
 if(!/flashback|one35/i.test(sniffed.make||''))throw Error('Choose an original Flashback V2 DNG.');
        let { pixels, width, height } = halfSize
          ? decodeOne35HalfSize(buffer)
          : decodeOne35Full(buffer);

        // Highlight recovery white-balances on the CPU (returns raw / neutral).
        // Default: the fixed ASN_D50 daylight neutral — one calibrated WB for
        // every shot. Camera WB (opt-in): use THIS file's AsShotNeutral so warm/
        // cool scenes self-correct like the desktop's per-file WB. Either way the
        // result is WB-normalised (neutral → [1,1,1]), so FM1_WB_TO_ACESCG stays
        // the correct matrix. evComp=0 so no extra CCM scaling.
        const wbAsn = (opts.cameraWb && sniffed.asn) ? sniffed.asn : ASN_D50;
        recoverHighlights(pixels, wbAsn);
        const k = Math.pow(2, FLASHBACK_EXPOSURE_COMP_EV);
        const ccm = k === 1 ? FM1_WB_TO_ACESCG : FM1_WB_TO_ACESCG.map(v => v * k);

        return {
          pixels, width, height, ccm, isFlashback: true,
          asn:       sniffed.asn,
          exposureS: sniffed.exposureS,
          dateTaken: sniffed.dateTaken,
          make:      sniffed.make,  model: sniffed.model,
          iso:       sniffed.iso,   fNumber: sniffed.fNumber, focalLength: sniffed.focalLength,
          metadata:  null,
        };
 }
}
