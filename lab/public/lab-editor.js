(() => {
  "use strict";
  const bridge = window.__FILMLAB_SERVER_EDITOR__;
  const photoId = new URLSearchParams(location.search).get("photo");
  if (!bridge || !photoId) {
    location.replace("/");
    return;
  }

  const accountKey = String(window.__FILMLAB_ACCOUNT_ID__ || "server");
  const copiedEditsKey = `filmLabCopiedEdits-${accountKey}`;
  const profileKey = `ondevice-film-lab-camera-profiles-v1-${accountKey}`;
  const profileSessionKey = `filmLabProfilesLoaded-${accountKey}`;
  let lastPhotoState = "";
  let lastProfileState = "";
  let autosaveTimer = 0;
  let saving = false;
  let photo = null;
  let serverFilmstripCount = null;
  let serverFilmstripThumbs = null;
  let openingPhoto = false;
  let nearbyPhotos = [];
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      openingPhoto = false;
      document.body.classList.remove("serverPhotoLoading");
    }
  });

  function notify(message, failure = false) {
    let toast = document.querySelector(".serverEditorToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "serverEditorToast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle("failure", failure);
    toast.hidden = false;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => { toast.hidden = true; }, 3200);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { location.replace("/login"); throw new Error("Please sign in"); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function cleanState(state) {
    if (!state) return null;
    return { rotation: state.rotation || 0, straighten: state.straighten || 0, crop: state.crop || null, settings: state.settings || {}, masks: state.masks || [], isEdited: Boolean(state.isEdited) };
  }

  async function saveState(force = false) {
    const state = cleanState(bridge.captureState());
    if (!state) return;
    const encoded = JSON.stringify(state);
    if (!force && encoded === lastPhotoState) return;
    await requestJson(`/api/photos/${encodeURIComponent(photoId)}/edits`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits: state })
    });
    lastPhotoState = encoded;
  }

  function queueStateSave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveState().catch(error => notify(error.message, true)), 650);
  }

  async function syncProfilesInitially() {
    const remote = await requestJson("/api/state/camera-profiles");
    const local = localStorage.getItem(profileKey) || "";
    if (remote.value) {
      const encoded = JSON.stringify(remote.value);
      if (encoded !== local && !sessionStorage.getItem(profileSessionKey)) {
        localStorage.setItem(profileKey, encoded);
        sessionStorage.setItem(profileSessionKey, "1");
        location.reload();
        return false;
      }
      lastProfileState = encoded;
    } else if (local) {
      const value = JSON.parse(local);
      await requestJson("/api/state/camera-profiles", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
      lastProfileState = local;
    }
    return true;
  }

  async function syncProfileChanges() {
    const current = localStorage.getItem(profileKey) || "";
    if (!current || current === lastProfileState) return;
    await requestJson("/api/state/camera-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.parse(current) })
    });
    lastProfileState = current;
  }

  async function syncServerLuts() {
    const result = await requestJson("/api/luts");
    const localIds = new Set(bridge.listLutIds());
    for (const lut of result.luts || []) {
      if (localIds.has(lut.id)) continue;
      const response = await fetch(lut.url);
      if (!response.ok) throw new Error(`Could not download LUT “${lut.name}”`);
      await bridge.importLutText(await response.text(), lut.fileName);
      localIds.add(lut.id);
    }
  }

  async function uploadServerLut(file) {
    if (!(file instanceof File) || !/\.cube$/i.test(file.name)) return;
    const form = new FormData();
    form.append("lut", file, file.name);
    const response = await fetch("/api/luts", { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The LUT could not be saved to Server Lab");
    notify(result.duplicate ? "LUT is already in Server Lab" : "LUT saved for all Server Lab devices");
  }

  const formatBytes = bytes => {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB"];
    let number = value / 1024, unit = 0;
    while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
    return `${number >= 10 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
  };

  async function openServerPhoto(id) {
    if (id === photoId || openingPhoto) return;
    openingPhoto = true;
    document.body.classList.add("serverPhotoLoading");
    try { await saveState(); } catch (error) { notify(error.message, true); }
    location.href = `/editor?photo=${encodeURIComponent(id)}`;
  }

  document.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
    if (event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="tab"],[role="slider"]')) return;
    if (openingPhoto || document.body.classList.contains("serverPhotoLoading") || !bridge.canNavigate()) return;
    if (document.querySelector('dialog[open],.sidebar.mobileOpen,.menuOpen')) return;
    const index = nearbyPhotos.findIndex(entry => entry.id === photoId);
    const next = nearbyPhotos[index + (event.key === "ArrowLeft" ? -1 : 1)];
    if (index < 0 || !next) return;
    event.preventDefault();
    openServerPhoto(next.id);
  });

  function renderServerFilmstrip(nearby, total = nearby.length) {
    nearbyPhotos = nearby;
    if (!serverFilmstripThumbs) return;
    serverFilmstripCount.textContent = `Photos (${Number(total).toLocaleString()})`;
    const fragment = document.createDocumentFragment();
    for (const entry of nearby) {
      const card = document.createElement("div");
      card.className = `thumb${entry.id === photoId ? " active" : ""}`;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", entry.id === photoId ? `${entry.name}, currently open` : `Open ${entry.name}`);
      const image = document.createElement("img");
      image.src = entry.thumbnailUrl;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = entry.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      const date = new Date(entry.capturedAt || entry.importedAt);
      meta.textContent = `${Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString()} · ${formatBytes(entry.size)}`;
      const status = document.createElement("div");
      status.className = "rot";
      status.textContent = entry.isEdited ? "Edited" : "";
      card.append(image, name, meta, status);
      if (entry.isRaw) { const badge=document.createElement("span");badge.className="rawBadge";badge.textContent="RAW";card.appendChild(badge); }
      const open = () => openServerPhoto(entry.id);
      card.addEventListener("click", open);
      card.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
      fragment.appendChild(card);
    }
    serverFilmstripThumbs.replaceChildren(fragment);
    serverFilmstripThumbs.querySelector(".active")?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "center" });
  }

  async function loadServerFilmstrip() {
    const result = await requestJson(`/api/photos/${encodeURIComponent(photoId)}/filmstrip?limit=9`);
    renderServerFilmstrip(result.photos || [photo], result.total);
  }

  function addServerChrome() {
    const style = document.createElement("style");
    style.textContent = `
      body.serverEdition .photoPicker{display:none!important}
      body.serverEdition #filmstripAddBtn,body.serverEdition #openGalleryBtn{display:none!important}
      body.serverEdition .serverCoreFilmstrip{display:none!important}
      body.serverEdition .editScopeSwitch,body.serverEdition .editScopeHint{display:none!important}
      body.serverEdition .previewPreferences,body.serverEdition .editScopeTitle{display:none!important}
      body.serverEdition #editScopeBar{position:static;padding:0;border:0;background:none;box-shadow:none;backdrop-filter:none;flex:0 0 auto}
      body.serverEdition #editScopeMenuBtn{display:grid;place-items:center;height:38px;margin:0;letter-spacing:0}
      body.serverEdition #editScopeBar .editScopeActions{position:fixed;z-index:2400;width:min(230px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow-y:auto}
      body.serverEdition #editScopeBar .editScopeActions button{min-height:40px;font-size:12px}
      @media(max-width:900px){body.serverEdition #editScopeMenuBtn{height:44px}}
      .serverLibraryButton{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
      .serverLibraryButton svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2}
      .serverSaveButton.saved{border-color:#4d947d!important;color:#b8f0d9!important}
      .serverEditorToast{position:fixed;z-index:1000;left:50%;bottom:max(20px,env(safe-area-inset-bottom));transform:translateX(-50%);padding:11px 16px;border:1px solid #496583;border-radius:12px;background:#172338;color:#f4f7fb;box-shadow:0 12px 38px #000a;white-space:nowrap}
      .serverEditorToast.failure{border-color:#8b4f58;color:#ffdadd}
      @media(max-width:900px){.mobileTitleRow>.serverLibraryButton{order:0}.mobileTitleRow>#mobileMenuBtn{order:1}.mobileTitleRow>.filename{order:2}.serverLibraryButton{width:44px!important;min-width:44px!important;height:44px!important;min-height:44px!important;flex:0 0 44px;padding:9px!important}.serverLibraryButton span{display:none}.serverEditorToast{max-width:calc(100% - 24px);white-space:normal;text-align:center}}
    `;
    document.head.appendChild(style);
    document.body.classList.add("serverEdition");
    const editMenu = document.querySelector("#editScopeBar");
    const editMenuButton = document.querySelector("#editScopeMenuBtn");
    const fullscreen = document.querySelector("#fullBtn");
    if (editMenu && editMenuButton && fullscreen) {
      fullscreen.after(editMenu);
      editMenuButton.classList.add("iconButton");
      editMenuButton.title = "Photo edit actions";
      editMenuButton.setAttribute("aria-label", "Photo edit actions");
      editMenuButton.innerHTML = '<svg class="toolbarIcon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="20" cy="12" r="1.5"/></svg>';
      const positionEditMenu = () => {
        if (!editMenu.classList.contains("menuOpen")) return;
        const actions = editMenu.querySelector(".editScopeActions");
        const rect = editMenuButton.getBoundingClientRect();
        const viewport = window.visualViewport;
        const width = viewport?.width || window.innerWidth;
        const height = viewport?.height || window.innerHeight;
        const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
        actions.style.right = "auto";
        actions.style.left = `${Math.max(left + 12, Math.min(rect.right - actions.offsetWidth, left + width - actions.offsetWidth - 12))}px`;
        actions.style.top = `${Math.max(top + 12, Math.min(rect.bottom + 6, top + height - actions.offsetHeight - 12))}px`;
      };
      editMenuButton.addEventListener("click", positionEditMenu);
      window.addEventListener("resize", positionEditMenu);
      window.addEventListener("scroll", positionEditMenu, true);
      window.visualViewport?.addEventListener("resize", positionEditMenu);
    }
    const coreFilmstrip = document.querySelector(".filmstripWrap");
    if (coreFilmstrip) {
      coreFilmstrip.classList.add("serverCoreFilmstrip");
      const serverFilmstrip = document.createElement("section");
      serverFilmstrip.className = "filmstripWrap serverFilmstrip";
      serverFilmstrip.innerHTML = '<div class="filmstripHead"><div class="filmstripHeadLeft"><span class="serverFilmstripCount">Photos (1)</span></div><span>Nearby photos</span></div><div class="thumbs serverFilmstripThumbs" aria-label="Nearby library photos"></div>';
      coreFilmstrip.insertAdjacentElement("afterend", serverFilmstrip);
      serverFilmstripCount = serverFilmstrip.querySelector(".serverFilmstripCount");
      serverFilmstripThumbs = serverFilmstrip.querySelector(".serverFilmstripThumbs");
    }
    const toolbar = document.querySelector(".toolbar");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "serverLibraryButton";
    button.title = "Return to Server Lab library";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/><path d="M8 12h12"/></svg><span>Library</span>';
    button.onclick = async () => { await saveState().catch(() => {}); location.href = "/"; };
    const mobileTitleRow = toolbar?.querySelector(".mobileTitleRow");
    const mobileMenuButton = toolbar?.querySelector("#mobileMenuBtn");
    if (mobileTitleRow && mobileMenuButton) mobileTitleRow.prepend(button);
    else toolbar?.prepend(button);
    const heading = document.querySelector(".sidebarIntro h1");
    if (heading) heading.textContent = "OnDevice Film Lab Server";
    const intro = document.querySelector(".sidebarIntro .sub");
    if (intro) intro.textContent = "Editing from your private Ubuntu photo library. Changes are saved back to Server Lab.";
    const outputButton = document.querySelector("#saveOneBtn");
    if (outputButton) outputButton.textContent = "Download photo";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "FilmLab.jpg";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function downloadRenderedPhoto() {
    if (saving) return;
    const saveButton = document.querySelector("#saveOneBtn");
    saving = true;
    bridge.setBusy(true);
    saveButton.textContent = "Processing…";
    saveButton.classList.remove("saved");
    try {
      await saveState();
      const [blob, filename] = await Promise.all([bridge.renderCurrent(), bridge.currentOutputName()]);
      downloadBlob(blob, filename);
      saveButton.textContent = "Downloaded";
      saveButton.classList.add("saved");
      bridge.setStatus("Downloaded edited photo");
      notify("Edited JPEG downloaded to this device");
      setTimeout(() => { if (!saving) return; saveButton.textContent = "Download photo"; saving = false; bridge.setBusy(false); }, 1100);
    } catch (error) {
      saveButton.textContent = "Download photo";
      saving = false;
      bridge.setBusy(false);
      bridge.setStatus("Download failed");
      notify(error.message, true);
    }
  }

  function restoreEditClipboard() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(copiedEditsKey) || "null");
      if (saved?.version === 1) bridge.restoreCopiedEdits(saved.settings);
    } catch { /* Ignore unavailable storage or an invalid saved clipboard. */ }
  }

  function saveEditClipboard() {
    const settings = bridge.getCopiedEdits();
    if (!settings) return;
    try { sessionStorage.setItem(copiedEditsKey, JSON.stringify({ version: 1, settings })); }
    catch { notify("Copied edits could not be kept for the next photo. Browser session storage is unavailable.", true); }
  }

  async function initialize() {
    addServerChrome();
    bridge.setSinglePhotoMode();
    restoreEditClipboard();
    if (!await syncProfilesInitially()) return;
    await syncServerLuts();
    const result = await requestJson(`/api/photos/${encodeURIComponent(photoId)}`);
    photo = result.photo;
    renderServerFilmstrip([photo], 1);
    const response = await fetch(photo.editUrl || photo.originalUrl);
    if (!response.ok) throw new Error("The original photo could not be loaded from Server Lab");
    const blob = await response.blob();
    const file = new File([blob], photo.name, { type: photo.editUrl ? "image/png" : photo.mime || blob.type || "image/jpeg", lastModified: Date.parse(photo.capturedAt || photo.importedAt) || Date.now() });
    await bridge.loadPhoto(file, photo.edits, Boolean(photo.editUrl));
    document.body.classList.remove("serverPhotoLoading");
    bridge.setSinglePhotoMode();
    lastPhotoState = JSON.stringify(cleanState(bridge.captureState()));
    loadServerFilmstrip().catch(error => notify(`Nearby photos could not be loaded: ${error.message}`, true));

    const saveButton = document.querySelector("#saveOneBtn");
    saveButton.textContent = "Download photo";
    saveButton.classList.add("serverSaveButton");
    saveButton.onclick = downloadRenderedPhoto;
    const zipButton = document.querySelector("#zipBtn");
    if (zipButton) zipButton.hidden = true;

    document.addEventListener("filmLabMaskChange", queueStateSave);
    document.addEventListener("input", queueStateSave, true);
    document.addEventListener("change", queueStateSave, true);
    document.querySelector("#lutFileInput")?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) uploadServerLut(file).catch(error => notify(error.message, true));
    }, true);
    document.addEventListener("click", event => {
      if (event.target.closest("#copyEditsBtn")) saveEditClipboard();
      if (event.target.closest("#pasteEditsBtn,#leftBtn,#rightBtn,#cropApplyBtn,#cropResetBtn,#straightenReset,#resetPhotoEditsBtn,#undoEditsBtn,#redoEditsBtn,.sectionResetButton")) setTimeout(queueStateSave, 30);
    });
    setInterval(() => {
      saveState().catch(error => notify(error.message, true));
      syncProfileChanges().catch(error => console.warn("Profiles could not be synchronized", error));
    }, 2200);
    window.addEventListener("pagehide", () => {
      const state = cleanState(bridge.captureState());
      const encoded = state ? JSON.stringify(state) : "";
      if (state && encoded !== lastPhotoState) navigator.sendBeacon?.(`/api/photos/${encodeURIComponent(photoId)}/edits-beacon`, new Blob([JSON.stringify({ edits: state })], { type: "application/json" }));
    });
  }

  initialize().catch(error => {
    console.error(error);
    const viewer = document.querySelector("#viewer");
    const message = document.createElement("div");
    message.className = "empty";
    message.textContent = "Could not load this photo. Please return to the library and try again.";
    viewer?.replaceChildren(message);
    document.body.classList.remove("serverPhotoLoading");
    notify(error.message, true);
    bridge.setStatus(error.message);
  });
})();
