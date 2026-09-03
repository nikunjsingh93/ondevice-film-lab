# Bundled photo decoders

These files are served locally. No photo or decoder request goes to a third-party service. Each decode runs in a disposable, single-threaded worker (no SharedArrayBuffer/COOP/COEP requirement).

| Bundle | Upstream / version | License |
| --- | --- | --- |
| `vendor/libraw.mjs` | [libraw-mini 0.1.9](https://www.npmjs.com/package/libraw-mini), [source commit fd349a3](https://github.com/xdadda/libraw-mini/tree/fd349a3e12b04dc2b775f5f4310bbf37cba11d86); embedded LibRaw reports **0.22.0-RC1** | Wrapper MIT; LibRaw LGPL 2.1 |
| `vendor/libheif.mjs` | [libheif-js 1.19.8](https://github.com/catdad-experiments/libheif-js), `libheif-wasm/libheif-bundle.mjs` | See bundled libheif license file, including codec notices |
| `vendor/utif.mjs` | [UTIF 3.1.0](https://github.com/photopea/UTIF.js), with pako 1.0.11 | MIT, pako MIT/Zlib |
| `vendor/bmp.mjs` | [bmp-js 0.1.0](https://github.com/shaozilee/bmp-js), with buffer 6.0.3 | MIT |

License texts are in `vendor/*-LICENSE.txt` and must accompany distribution. The application's MIT license does not replace these licenses.

## Rebuilding / replacing

Install the pinned packages in a temporary build directory (there is no runtime npm dependency for the browser):

```sh
npm install --ignore-scripts libraw-mini@0.1.9 libheif-js@1.19.8 utif@3.1.0 pako@1.0.11 bmp-js@0.1.0 buffer@6.0.3 esbuild@0.28.2
```

`libraw.mjs` contains the Emscripten runtime factory from `libraw-mini/dist/libraw-mini-worker.js`: retain the prefix before `async function Oj(){`, then append `export default TA;`. The upstream worker wrapper is replaced by our `decode-worker.mjs` so the same decoder runs in browsers and Node. No embedded wasm bytes are modified. For modifications to LibRaw itself, use [LibRaw 0.22.0-RC1 source](https://github.com/LibRaw/LibRaw/tree/0.22.0-RC1), the pinned wrapper repository above, and its Emscripten build. Copies of the wrapper C source and build flags are provided as `vendor/libraw-mini.c` and `vendor/libraw-build.sh`. The replaceable ES module permits using a rebuilt library without rebuilding the application. This small build does not include every optional external compression library.

Copy `libheif-js/libheif-wasm/libheif-bundle.mjs` unchanged as `libheif.mjs`. Bundle `utif/UTIF.js` with esbuild `--bundle --format=esm --minify` as `utif.mjs`.

For `bmp.mjs`, bundle this entry with the same flags, injecting a module that exports `Buffer` from `buffer` (`--inject:buffer-inject.js`) for bmp-js's global Buffer references:

```js
import { Buffer } from 'buffer';
import bmp from 'bmp-js';
export default function decode(bytes) { return bmp.decode(Buffer.from(bytes)); }
```

Run the format/RAW tests after replacing any bundle. `lab/test/fixtures/dng.js` generates synthetic Bayer sensor data for testing real RAW development without distributing a camera photograph.
