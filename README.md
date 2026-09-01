<h1><img src="branding/ondevice-film-lab-logo-v4.png" alt="OnDevice Film Lab logo" width="48" height="48" align="absmiddle"> OnDevice Film Lab</h1>

OnDevice Film Lab is a private, browser-based photo processor. It softens harsh digital sharpening and halos, adds film-inspired fade, bloom, halation, chromatic aberration and grain, provides a side-by-side comparison, and exports finished photos without uploading them to a server.

## [Open OnDevice Film Lab](https://nikunjsingh93.github.io/ondevice-film-lab/)

## Screenshots Desktop and Mobile

<p align="center">
  <img src="screenshots/desktop-editor.png" alt="OnDevice Film Lab desktop editor" width="70%">&nbsp;&nbsp;&nbsp;&nbsp;<img src="screenshots/mobile-editor.png" alt="OnDevice Film Lab mobile editor" width="23%">
</p>

### Before and after

<p align="center">
  <img src="screenshots/before-after-comparison.png" alt="OnDevice Film Lab before and after comparison, with the original photo on the left and edited photo on the right" width="94%">
</p>

<p align="center"><em>Original on the left · Edited on the right</em></p>

## Install the app

Install OnDevice Film Lab from the live link above. Once it has loaded successfully, the installed app can open and process photos without an internet connection.

### iPhone and iPad

1. Open the app link in **Safari**.
2. Tap the **Share** button.
3. Tap **Add to Home Screen**. If it is hidden, scroll down, tap **Edit Actions**, and add it.
4. Turn on **Open as Web App**, then tap **Add**.

### Android

1. Open the app link in **Chrome**.
2. Tap the three-dot menu.
3. Tap **Install app** or **Add to Home screen**.
4. Confirm the installation.

### Mac

**Safari on macOS Sonoma 14 or later:** open the app link, choose **File → Add to Dock** (or **Share → Add to Dock**), then click **Add**.

**Chrome:** open the app link, click the install icon in the address bar. If it is not shown, choose **More → Cast, save, and share → Install page as app**, then confirm.

### Windows

**Microsoft Edge:** open the app link, click the app-available icon in the address bar. Alternatively, choose **Settings and more → More tools → Apps → Install this site as an app**.

**Chrome:** open the app link, click the install icon in the address bar. If it is not shown, choose **More → Cast, save, and share → Install page as app**, then confirm.

## Features

- Processes photos locally on your device
- Imports individual photos or an entire DCIM folder
- Keeps imported photos and their individual edits on the device after a refresh until they are removed from the app
- Saves reusable camera profiles locally, so a complete set of edit settings can be applied to all photos or one selected photo in a single step
- Supports JPEG, PNG, and WebP input
- Basic exposure, highlights, shadows, contrast, and saturation adjustments
- Custom `.cube` LUT import with **No LUT** as the default, adjustable LUT strength, 1D and 3D LUT support, tetrahedral 3D interpolation, live preview, matching export, and on-device persistence
- Adjustable de-sharpen strength, halo radius, and edge threshold
- Old-film fade with adjustable strength, set to 30% by default
- Diffusion-style highlight bloom inspired by black-mist filters, set to 30% by default
- Highlight-sensitive red/orange film halation, set to 30% by default with adjustable strength
- Radial red/cyan chromatic aberration, set to 30% by default
- Film grain enabled by default, with adjustable strength, size, and roughness
- Original-versus-edited comparison preview
- Vertically scrolling gallery for reviewing all imported photos, multi-selecting, and removing several at once
- Batch-first editing with optional per-photo overrides, Custom filmstrip badges, copy/paste edits, one-click reset, and session undo/redo
- Preview zoom from 50% to 400%, with reset and drag-to-pan close inspection
- Manual cropping with a movable, resizable rule-of-thirds frame, plus 90° rotation and fine ±15° straightening, baked into exports
- Preserves the original JPEG EXIF metadata, including camera, capture time, exposure, ISO, focal length, technical comments, and GPS data when present, while removing CampSnap's generic `My favorite picture` description
- Left and Right Arrow navigation between photos
- Retro segmented date stamp enabled by default, with selectable date formats and a soft orange film-like glow
- Capture-date filenames such as `20260809_124041_FilmLab.jpg`
- Individual JPEG downloads or cancellable **Download all .zip** batch export with progress
- Responsive layout for phones, tablets, and desktop browsers
- Lightroom-style mobile tool bar, settings sheets, and hamburger import menu
- Fixed desktop editing workspace that keeps the preview and filmstrip visible
- Whole-app fullscreen mode
- Collapsible desktop and phone-landscape chrome for a larger preview
- Installable PWA with offline access after the first successful load

## Privacy

Your photos never leave your browser. Processing and exporting happen locally on your device, with no account, upload, or cloud service required.

Imported working photos and their individual edits are kept in the browser's on-device storage so they can return after a refresh. **Remove current photo** deletes that photo from the local library, and **Clear all photos** deletes the whole local library. Clearing the site's browser data or using private/incognito browsing can also remove locally stored photos.

## How to use

1. Open the [web app](https://nikunjsingh93.github.io/ondevice-film-lab/).
2. Choose individual photos or select a folder.
3. Adjust the softening, basic color, film-look, LUT, and optional film-grain controls, then compare the original with the processed preview.
4. Optionally rotate photos, rename them using their capture dates, or add a film date stamp.
5. Save the selected photo or download the entire batch as a ZIP file.

## Browser compatibility

OnDevice Film Lab works in modern versions of Safari, Chrome, Edge, and Firefox. Folder selection and download behavior can vary by browser and operating system. For large batches on older phones, process fewer photos at a time if memory is limited.

## Run locally

Download or clone this repository. You can open `index.html` directly for basic use, with no installation or build process. To test PWA installation and offline support, serve the repository through `localhost` because browsers do not enable service workers for files opened directly from disk.

For example, from the repository folder:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a modern browser.

## License

Released under the [MIT License](LICENSE).
