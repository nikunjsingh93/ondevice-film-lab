(() => {
  "use strict";
  const bridge = window.__FILMLAB_SERVER_EDITOR__;
  const photoId = new URLSearchParams(location.search).get("photo");
  if (!bridge || !photoId) {
    location.replace("/");
    return;
  }

  const accountKey = String(window.__FILMLAB_ACCOUNT_ID__ || "server");
  const profileKey = `ondevice-film-lab-camera-profiles-v1-${accountKey}`;
  const profileSessionKey = `filmLabProfilesLoaded-${accountKey}`;
  let lastPhotoState = "";
  let lastProfileState = "";
  let autosaveTimer = 0;
  let saving = false;
  let photo = null;

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
    return { rotation: state.rotation || 0, straighten: state.straighten || 0, crop: state.crop || null, settings: state.settings || {} };
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

  function addServerChrome() {
    const style = document.createElement("style");
    style.textContent = `
      body.serverEdition .photoPicker{display:none!important}
      body.serverEdition #filmstripAddBtn,body.serverEdition #openGalleryBtn{display:none!important}
      .serverLibraryButton{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
      .serverLibraryButton svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2}
      .serverSaveButton.saved{border-color:#4d947d!important;color:#b8f0d9!important}
      .serverEditorToast{position:fixed;z-index:1000;left:50%;bottom:max(20px,env(safe-area-inset-bottom));transform:translateX(-50%);padding:11px 16px;border:1px solid #496583;border-radius:12px;background:#172338;color:#f4f7fb;box-shadow:0 12px 38px #000a;white-space:nowrap}
      .serverEditorToast.failure{border-color:#8b4f58;color:#ffdadd}
      @media(max-width:900px){.serverLibraryButton{padding:9px!important}.serverLibraryButton span{display:none}.serverEditorToast{max-width:calc(100% - 24px);white-space:normal;text-align:center}}
    `;
    document.head.appendChild(style);
    document.body.classList.add("serverEdition");
    const toolbar = document.querySelector(".toolbar");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "serverLibraryButton";
    button.title = "Return to Server Lab library";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/><path d="M8 12h12"/></svg><span>Library</span>';
    button.onclick = async () => { await saveState().catch(() => {}); location.href = "/"; };
    toolbar?.prepend(button);
    const heading = document.querySelector(".sidebarIntro h1");
    if (heading) heading.textContent = "OnDevice Film Lab Server";
    const intro = document.querySelector(".sidebarIntro .sub");
    if (intro) intro.textContent = "Editing from your private Ubuntu photo library. Changes are saved back to Server Lab.";
  }

  async function saveRenderedPhoto() {
    if (saving) return;
    const saveButton = document.querySelector("#saveOneBtn");
    saving = true;
    bridge.setBusy(true);
    saveButton.textContent = "Processing…";
    saveButton.classList.remove("saved");
    try {
      await saveState(true);
      const [blob, filename] = await Promise.all([bridge.renderCurrent(), bridge.currentOutputName()]);
      const response = await fetch(`/api/photos/${encodeURIComponent(photoId)}/export`, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg", "X-FilmLab-Filename": filename },
        body: blob
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The processed photo could not be saved");
      saveButton.textContent = "Saved to server";
      saveButton.classList.add("saved");
      bridge.setStatus("Saved processed photo to Server Lab");
      notify("Processed JPEG saved to Server Lab");
      setTimeout(() => { if (!saving) return; saveButton.textContent = "Save to server"; saving = false; bridge.setBusy(false); }, 1100);
    } catch (error) {
      saveButton.textContent = "Save to server";
      saving = false;
      bridge.setBusy(false);
      bridge.setStatus("Server save failed");
      notify(error.message, true);
    }
  }

  async function initialize() {
    addServerChrome();
    if (!await syncProfilesInitially()) return;
    await syncServerLuts();
    const result = await requestJson(`/api/photos/${encodeURIComponent(photoId)}`);
    photo = result.photo;
    const response = await fetch(photo.originalUrl);
    if (!response.ok) throw new Error("The original photo could not be loaded from Server Lab");
    const blob = await response.blob();
    const file = new File([blob], photo.name, { type: photo.mime || blob.type || "image/jpeg", lastModified: Date.parse(photo.capturedAt || photo.importedAt) || Date.now() });
    await bridge.loadPhoto(file, photo.edits);
    lastPhotoState = JSON.stringify(cleanState(bridge.captureState()));

    const saveButton = document.querySelector("#saveOneBtn");
    saveButton.textContent = "Save to server";
    saveButton.classList.add("serverSaveButton");
    saveButton.onclick = saveRenderedPhoto;
    const zipButton = document.querySelector("#zipBtn");
    if (zipButton) zipButton.hidden = true;

    document.addEventListener("input", queueStateSave, true);
    document.addEventListener("change", queueStateSave, true);
    document.querySelector("#lutFileInput")?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) uploadServerLut(file).catch(error => notify(error.message, true));
    }, true);
    document.addEventListener("click", event => {
      if (event.target.closest("#leftBtn,#rightBtn,#cropApplyBtn,#cropResetBtn,#straightenReset,#resetPhotoEditsBtn,#undoEditsBtn,#redoEditsBtn")) setTimeout(queueStateSave, 30);
    }, true);
    setInterval(() => {
      saveState().catch(error => notify(error.message, true));
      syncProfileChanges().catch(error => console.warn("Profiles could not be synchronized", error));
    }, 2200);
    window.addEventListener("pagehide", () => {
      const state = cleanState(bridge.captureState());
      if (state) navigator.sendBeacon?.(`/api/photos/${encodeURIComponent(photoId)}/edits-beacon`, new Blob([JSON.stringify({ edits: state })], { type: "application/json" }));
    });
  }

  initialize().catch(error => {
    console.error(error);
    notify(error.message, true);
    bridge.setStatus(error.message);
  });
})();
