# Project Knowledge

## Purpose and editions

OnDevice Film Lab processes photos with film-inspired effects and exports JPEGs. This repository contains two editions sharing the editor:

- Offline web/PWA: static GitHub Pages app; processing and persistent photo/edit storage stay in the browser.
- Server Lab: private self-hosted photo library with accounts, server originals and saved edits; editing still runs in the browser.

The separate `flashback-raw-editor-web` project discussed in earlier chats is a different repository. Do not confuse its UI or deployment with this app.

## Stack and layout

- `index.html`: main shared editor, including inline JavaScript, rendering, controls, browser persistence, and exports. No frontend build step or root npm package.
- `theme.js`, `theme.css`: shared appearance.
- `tone-curve.js`: tone curve implementation.
- `photo-formats.js`, `photo-codecs.js`, `photo-exif.js`, `codecs/`: format handling, local decoding and metadata. See `codecs/SOURCES.md` for provenance.
- `manifest.webmanifest`, `sw.js`, `icons/`, `branding/`: installable/offline assets.
- `flashback.js`: adapter for isolated Flashback processing worker.
- `flashback/`: worker, GPU and CPU backends, source modules, shaders, film tables and grain assets; `NOTICE.md` and `COPYING` document provenance and licensing.
- `lab/server.js`: Node.js 22+ / Express 5 backend, SQLite via better-sqlite3, Sharp, Multer uploads, Archiver ZIPs.
- `lab/public/`: gallery (`app.js`), editor integration (`lab-editor.js`), authentication, settings and fullscreen shell.
- `lab/test/`: Node test runner tests, including synthetic RAW fixtures and source/asset regression checks.
- `lab/Dockerfile`, `docker-compose.lab.yml`: Linux container deployment.
- `.github/workflows/pages.yml`, `server-lab-image.yml`: independent Pages and GHCR deployments.

## Editing and export architecture

Server Lab adapts the root editor at runtime rather than maintaining a second image-processing UI. Changes must account for its integration hooks. Browser photos and per-photo recipes persist locally; Lab synchronizes account-owned originals, recipes, profiles and LUTs. Editing scopes and per-photo overrides must remain isolated when navigating.

Implemented capabilities include RAW/HEIF and common raster imports, EXIF, profiles, custom 1D/3D cube LUTs, exposure/colour adjustments, luminance/chroma noise reduction, sharpening/de-sharpening, colour mix/grading, masks, film effects, grain, curves/presets (including S curve), crop ratios/rotation/straightening, zoom/comparison, filmstrip/gallery selection, JPEG and ZIP exports, capture-date names and optional megapixel export limits. Export resizing never enlarges smaller photos.

Lab edited ZIPs use the browser to render edited JPEGs, upload staged results through `/api/edited-zip`, then stream a server-assembled ZIP. This differs from the original-file ZIP route. Preserve edited pixels, capture-date names, cancellation, cleanup and progress/error handling. Offline ZIP exports stay in the browser.

## Flashback V2 mode

Only the Flashback V2 camera profile activates the dedicated developer and look controls. It reads preserved original One35 V2 uncompressed 10-bit RGGB DNGs (4144 x 3088), applies sensor black correction, white balance, highlight handling and calibrated colour processing. Preview is half-size; export develops the full sensor before normal edits/crop/resizing.

Original film LUTs use ACEScct; imported One35 camera PNG atlases use display sRGB. Do not interchange those spaces or treat engine LUTs as generic photo LUTs. Natural uses a ProPhoto tone curve. WebGPU and CPU workers support different browser capabilities; wide blur/chroma filtering can differ slightly spatially.

Looks include Natural, Disposable, Point & Shoot, Rangefinder, Monochrome, Flashback V1, procedural Gold and Expired Superia, plus Classic, Beta, camera Gold, Retro Haze, Dispo, local Monochrome, Cine and DMG. Edge softness is optional and off by default.

## Important fixes and pitfalls

- `2776946`: edited filmstrip/gallery thumbnails follow saved recipes; per-recipe browser cache and server thumbnail revision URLs prevent stale washed-out previews. Preserve asynchronous photo identity guards.
- `3409aee`: stale cached worker accepted new look IDs and silently rendered Disposable for all of them. Version the entire module graph together, validate worker engine/look responses, reject unknown looks, and snapshot settings before asynchronous reads. Current version token is `20261016-preview-1`; service worker cache is `ondevice-film-lab-v1.10.28` at this documentation baseline. Recheck before future edits.
- Update the service worker asset list/cache and Pages/Docker packaging when adding runtime assets. Test upgrade behaviour as well as a fresh load.
- Camera profile state must not leak between photos. Original RAW metadata must come from the original file, not merely a decoded preview.
- Do not replace noise reduction with a blur that removes detail. Existing luminance reduction was revised after that user-reported failure.
- Prior Windows ARM Docker photo-opening and ZIP stalls were reported in conversation; do not assume the same root cause on Mac/Linux or mark a fresh issue fixed without reproduction. Current tests/source are the evidence.
- Root application license is MIT; bundled codecs retain their licenses. Flashback imported engine is GPL-3.0, with source and notices included. Manufacturer camera atlas rights remain separate. Keep required notices; UI access to credits is in Settings.

## Development and verification

From repository root in PowerShell:

```powershell
# Static edition (Python must be installed)
python -m http.server 8000
# Server dependencies, syntax checks and regression suite
npm --prefix lab ci
npm --prefix lab run check
npm --prefix lab test
# Lab server (configure storage/environment first)
npm --prefix lab start
# Docker local test (configure the two bind paths first; see README)
docker compose -f docker-compose.lab.yml up -d --build
```

Use localhost for PWA/worker testing; direct file opening is not equivalent. Node native dependencies may need a compatible runtime/platform; Docker provides the Linux environment. UI changes need relevant browser checks beyond source-level tests.

## Deployment and storage

Pages URL: https://nikunjsingh93.github.io/ondevice-film-lab/
Image: `ghcr.io/nikunjsingh93/ondevice-film-lab-server:latest` (also SHA tags).
Relevant main-branch pushes trigger the workflows. Verify workflow success; a pushed commit alone does not prove deployment. Portainer must pull the new image and redeploy.

Compose binds `FILMLAB_DATA_PATH` to `/data` and `FILMLAB_STATE_PATH` to `/state`, publishes port 3000 and requires the `.filmlab-storage` marker. Keep SQLite state on a local filesystem with reliable locking; preserve and back up both state and originals. Never use destructive cleanup against a user's photo library. See README for platform-specific setup and private HTTPS access.

## Evidence scope

Architecture, commands and baseline commits above were checked against repository files on 2026-10-22. Some bug context comes from this conversation, not an independent reproduction during documentation setup. No claim is made that all historic chat work or external deployment state is accessible to a new agent.
