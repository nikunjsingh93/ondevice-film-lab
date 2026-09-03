(() => {
  "use strict";
  // Fullscreen belongs to this persistent document, not to a navigating editor.
  // The explicit flag also supports browsers without Fetch Metadata headers.
  const initial = new URL(location.href);
  initial.searchParams.set("labFrame", "1");
  if (window.parent !== window) {
    location.replace(initial.pathname + initial.search + initial.hash);
    return;
  }
  // Android's installed Chromium app can move a persistent iframe underneath
  // the status bar after its first navigation. The offline app has no iframe,
  // so use that same direct-page model for Android Lab navigation.
  if (/Android/i.test(globalThis.navigator?.userAgent || "")) {
    location.replace(initial.pathname + initial.search + initial.hash);
    return;
  }
  const frame = document.querySelector("#labPage");
  let pageDocument = null;

  function syncFullscreen() {
    if (!pageDocument) return;
    const active = Boolean(document.fullscreenElement);
    for (const button of pageDocument.querySelectorAll("#fullBtn,#labFullscreenButton")) {
      const label = active ? "Exit full screen" : "Full screen";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      syncFullscreen();
    } catch (error) {
      frame.contentWindow.__FILMLAB_SERVER_EDITOR__?.setStatus("Full screen not available in this browser");
      console.warn("Could not change fullscreen:", error);
    }
  }

  frame.addEventListener("load", () => {
    // Only our own pages are permitted to update the shell or fullscreen controls.
    let current;
    try { current = new URL(frame.contentWindow.location.href); }
    catch { pageDocument = null; return; }
    if (current.origin !== location.origin || current.protocol === "about:") return;
    pageDocument = frame.contentDocument;
    current.searchParams.delete("labFrame");
    history.replaceState(null, "", current.pathname + current.search + current.hash);
    document.title = pageDocument.title || "Lab Server";

    // A capturing listener replaces the editor's per-document fullscreen action.
    pageDocument.addEventListener("click", event => {
      if (!event.target.closest?.("#fullBtn,#labFullscreenButton")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggleFullscreen();
    }, true);

    if (!pageDocument.querySelector("#fullBtn") && document.fullscreenEnabled) {
      const header = pageDocument.querySelector(".headerActions,.appHeader");
      if (header && !pageDocument.querySelector("#labFullscreenButton")) {
        const button = pageDocument.createElement("button");
        button.id = "labFullscreenButton";
        button.type = "button";
        button.innerHTML = '<svg class="fullscreenExpand" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg><svg class="fullscreenContract" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/></svg>';
        header.appendChild(button);
      }
    }
    syncFullscreen();
  });
  document.addEventListener("fullscreenchange", syncFullscreen);
  frame.src = initial.pathname + initial.search + initial.hash;
})();
