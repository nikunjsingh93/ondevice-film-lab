# OnDevice Film Lab

## [Open OnDevice Film Lab](https://nikunjsingh93.github.io/ondevice-film-lab/)

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

OnDevice Film Lab is a private, browser-based photo processor. It softens harsh digital sharpening and halos, provides a side-by-side comparison, adds an optional retro film date stamp, and exports finished photos without uploading them to a server.

## Features

- Processes photos locally on your device
- Imports individual photos or an entire DCIM folder
- Supports JPEG, PNG, and WebP input
- Adjustable de-sharpen strength, halo radius, and edge threshold
- Original-versus-softened comparison preview
- Manual rotation with orientation baked into exports
- Optional retro segmented date stamp with a soft orange film-like glow
- Capture-date filenames such as `20260809_124041_FilmLab.jpg`
- Individual JPEG downloads or batch ZIP export
- Responsive layout for phones, tablets, and desktop browsers
- Installable PWA with offline access after the first successful load

## Privacy

Your photos never leave your browser. Processing and exporting happen locally on your device, with no account, upload, or cloud service required.

## How to use

1. Open the [web app](https://nikunjsingh93.github.io/ondevice-film-lab/).
2. Choose photos, select a folder, or drag photos into the page.
3. Adjust the softening controls and compare the original with the processed preview.
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
