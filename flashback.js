/* Film Lab adapter for the separately loaded Flashback development worker. */
(function (root) {
  const workerUrl = new URL("flashback/worker.js", document.currentScript.src),
    keys = new WeakMap();
  let nextKey = 0,
    worker = null,
    nextId = 0;
  const pending = new Map();
  let previewCache = null;
  function stop(message) {
    worker?.terminate();
    worker = null;
    previewCache = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(Error(message));
    }
    pending.clear();
  }
  function getWorker() {
    if (!worker) {
      worker = new Worker(workerUrl, { type: "module" });
      worker.onmessage = (event) => {
        const result = event.data,
          job = pending.get(result.id);
        if (!job) return;
        clearTimeout(job.timer);
        pending.delete(result.id);
        result.error ? job.reject(Error(result.error)) : job.resolve(result);
      };
      worker.onerror = (event) =>
        stop(event.message || "Flashback processing could not start.");
    }
    return worker;
  }
  const enabled = (settings) => settings?.flashbackMode === "1";
  const canvasFrom = (raw) => {
    const canvas = document.createElement("canvas");
    canvas.width = raw.width;
    canvas.height = raw.height;
    canvas
      .getContext("2d", { willReadFrequently: true })
      .putImageData(
        new ImageData(raw.data, raw.width, raw.height),
        0,
        0,
      );
    return canvas;
  };
  async function renderUncached(
    file,
    settings,
    { full = false, includeOriginal = false } = {},
  ) {
    if (!keys.has(file)) keys.set(file, ++nextKey);
    let source = file;
    if (file._filmLabOriginalUrl) {
      const response = await fetch(file._filmLabOriginalUrl);
      if (!response.ok)
        throw Error(
          "The original Flashback DNG could not be loaded from Server Lab.",
        );
      source = await response.blob();
    }
    const buffer = await source.arrayBuffer(),
      runner = getWorker();
    const result = await new Promise((resolve, reject) => {
      const id = ++nextId,
        timer = setTimeout(
          () =>
            stop(
              "Flashback processing took too long. Please try this photo again.",
            ),
          180000,
        );
      pending.set(id, { resolve, reject, timer });
      runner.postMessage(
        {
          id,
          key: keys.get(file),
          buffer,
          full,
          includeOriginal,
          look: settings.flashbackLook,
          edgeSoftness: settings.flashbackEdgeSoftness === true,
        },
        [buffer],
      );
    });
    return {
      image: canvasFrom(result.image),
      original: result.original ? canvasFrom(result.original) : null,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      backend: result.backend,
      sourceLong: Math.max(result.sourceWidth, result.sourceHeight),
    };
  }
  async function render(file, settings, options = {}) {
    if (!keys.has(file)) keys.set(file, ++nextKey);
    if (options.full) return renderUncached(file, settings, options);
    const key =
      keys.get(file) +
      ":" +
      settings.flashbackLook +
      ":" +
      (settings.flashbackEdgeSoftness === true);
    if (previewCache?.key === key) return previewCache.job;
    const job = renderUncached(file, settings, {
      ...options,
      includeOriginal: true,
    });
    previewCache = { key, job };
    try {
      return await job;
    } catch (error) {
      if (previewCache?.job === job) previewCache = null;
      throw error;
    }
  }
  root.FilmLabFlashback = {
    enabled,
    render,
    dispose: () => stop("Flashback processing cancelled."),
  };
})(globalThis);
