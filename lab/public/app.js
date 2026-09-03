(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const elements = {
    photoInput: $("#photoInput"), folderInput: $("#folderInput"), uploadButton: $("#uploadButton"), folderButton: $("#folderButton"),
    emptyUploadButton: $("#emptyUploadButton"), emptyFolderButton: $("#emptyFolderButton"), selectButton: $("#selectButton"),
    selectAllButton: $("#selectAllButton"), downloadZipButton: $("#downloadZipButton"), removeButton: $("#removeButton"), selectedCount: $("#selectedCount"),
    selectionActions: $("#selectionActions"), searchInput: $("#searchInput"), sortSelect: $("#sortSelect"), gallery: $("#gallery"), emptyState: $("#emptyState"),
    loadMoreButton: $("#loadMoreButton"), photoCount: $("#photoCount"), librarySize: $("#librarySize"), freeSpace: $("#freeSpace"),
    userGreeting: $("#userGreeting"), gridSizeSelect: $("#gridSizeSelect"), dropOverlay: $("#dropOverlay"), progressOverlay: $("#progressOverlay"),
    progressTitle: $("#progressTitle"), progressText: $("#progressText"), progressBar: $("#progressBar"), progressPercent: $("#progressPercent"),
    cancelUploadButton: $("#cancelUploadButton"), dialogOverlay: $("#dialogOverlay"), dialogTitle: $("#dialogTitle"),
    dialogMessage: $("#dialogMessage"), dialogCancel: $("#dialogCancel"), dialogConfirm: $("#dialogConfirm"), toast: $("#toast")
  };
  let photos = [];
  let total = 0;
  let hasMore = false;
  let selectionMode = false;
  const selected = new Set();
  let uploadRequest = null;
  let downloadController = null;
  let sortMode = localStorage.getItem("filmLabServerSort") === "imported" ? "imported" : "captured";
  let searchTimer = 0;
  let toastTimer = 0;

  const formatBytes = bytes => {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let number = value / 1024, unit = 0;
    while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
    return `${number >= 10 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
  };
  const formatDate = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unknown date";
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

  function notify(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
  }

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { location.replace("/login"); throw new Error("Please sign in"); }
    if (payload.code === "PASSWORD_CHANGE_REQUIRED") { location.replace("/login"); throw new Error(payload.error); }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function updateStats() {
    const [library, session] = await Promise.all([jsonRequest("/api/library"), jsonRequest("/api/session").catch(() => ({ user: null }))]);
    elements.photoCount.textContent = library.photos.toLocaleString();
    elements.librarySize.textContent = formatBytes(library.originalBytes);
    elements.freeSpace.textContent = library.quotaBytes == null
      ? (library.storage ? formatBytes(library.storage.free) : "—")
      : formatBytes(Math.max(0, library.quotaBytes - library.usedBytes));
    elements.userGreeting.textContent = session.user ? `Hi, ${session.user.username}` : "";
  }

  function updateSelection() {
    selectionMode = Boolean(selectionMode);
    elements.selectButton.textContent = selectionMode ? "Done" : "Select";
    elements.selectButton.setAttribute("aria-pressed", String(selectionMode));
    elements.selectionActions.hidden = !selectionMode;
    elements.selectedCount.textContent = `${selected.size} selected`;
    elements.removeButton.disabled = !selected.size;
    elements.downloadZipButton.disabled = !selected.size;
    elements.selectAllButton.textContent = selected.size && selected.size === photos.length ? "Deselect all" : "Select all";
    document.querySelectorAll(".photoCard").forEach(card => card.classList.toggle("selected", selected.has(card.dataset.id)));
  }

  function galleryDate(photo) {
    return sortMode === "imported" ? photo.importedAt : (photo.capturedAt || photo.importedAt);
  }

  function dateGroup(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return { key: "unknown", label: "Unknown date" };
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAgo = Math.round((startToday - startDate) / 86400000);
    const label = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : new Intl.DateTimeFormat(undefined, {
      month: "long", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" })
    }).format(date);
    return { key, label };
  }

  function renderGallery() {
    elements.emptyState.hidden = total > 0 || Boolean(elements.searchInput.value.trim());
    let previousGroup = "";
    elements.gallery.innerHTML = photos.map(photo => {
      const group = dateGroup(galleryDate(photo));
      const heading = group.key === previousGroup ? "" : `<h2 class="dateGroupHeader">${escapeHtml(group.label)}</h2>`;
      previousGroup = group.key;
      return `${heading}
      <article class="photoCard${selected.has(photo.id) ? " selected" : ""}" data-id="${photo.id}" tabindex="0" role="button" aria-label="${selectionMode ? "Select" : "Open"} ${escapeHtml(photo.name)}">
        <img src="${photo.thumbnailUrl}" alt="" loading="lazy" decoding="async">
        ${photo.isRaw ? '<span class="rawBadge">RAW</span>' : ""}
        ${photo.isEdited ? '<span class="editedBadge">EDITED</span>' : ""}
        ${selectionMode ? '<span class="selectMark">✓</span>' : ""}
        <div class="photoInfo"><strong>${escapeHtml(photo.name)}</strong><span>${formatDate(galleryDate(photo))} · ${formatBytes(photo.size)}</span></div>
      </article>`;
    }).join("");
    elements.loadMoreButton.hidden = !hasMore;
    updateSelection();
  }

  async function loadPhotos(reset = false) {
    const offset = reset ? 0 : photos.length;
    const query = elements.searchInput.value.trim();
    const result = await jsonRequest(`/api/photos?offset=${offset}&limit=60&q=${encodeURIComponent(query)}&sort=${sortMode}`);
    photos = reset ? result.photos : photos.concat(result.photos);
    total = result.total;
    hasMore = result.hasMore;
    if (reset) selected.clear();
    renderGallery();
  }

  function setProgress(percent, text) {
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progressBar.style.width = `${bounded}%`;
    elements.progressPercent.textContent = `${bounded}%`;
    if (text) elements.progressText.textContent = text;
  }

  function uploadBatch(files, completed, totalFiles) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      files.forEach(file => form.append("photos", file, file.name));
      const request = new XMLHttpRequest();
      uploadRequest = request;
      request.open("POST", "/api/photos");
      request.upload.addEventListener("progress", event => {
        const current = event.lengthComputable ? event.loaded / event.total : 0;
        const percent = ((completed + current * files.length) / totalFiles) * 100;
        setProgress(percent, `Uploading ${Math.min(totalFiles, completed + Math.max(1, Math.ceil(current * files.length)))} of ${totalFiles}`);
      });
      request.addEventListener("load", () => {
        uploadRequest = null;
        let payload = {};
        try { payload = JSON.parse(request.responseText || "{}"); } catch { /* handled below */ }
        if (request.status >= 200 && request.status < 300) resolve(payload);
        else reject(new Error(payload.error || `Upload failed (${request.status})`));
      });
      request.addEventListener("error", () => { uploadRequest = null; reject(new Error("The upload connection was interrupted")); });
      request.addEventListener("abort", () => { uploadRequest = null; reject(new DOMException("Upload cancelled", "AbortError")); });
      request.send(form);
    });
  }

  async function uploadFiles(fileList) {
    const files = [...fileList].filter(file => PhotoFormats.supported(file));
    if (!files.length) return notify("No supported photos were selected.");
    elements.progressOverlay.hidden = false;
    elements.progressTitle.textContent = "Adding photos…";
    setProgress(0, `Preparing ${files.length} ${files.length === 1 ? "photo" : "photos"}`);
    let imported = 0, duplicates = 0, failed = 0;
    try {
      for (let offset = 0; offset < files.length; offset += 10) {
        const batch = files.slice(offset, offset + 10);
        const result = await uploadBatch(batch, offset, files.length);
        imported += result.imported?.length || 0;
        duplicates += result.duplicates?.length || 0;
        failed += result.errors?.length || 0;
        setProgress(((offset + batch.length) / files.length) * 100, `Stored ${Math.min(files.length, offset + batch.length)} of ${files.length}`);
      }
      await Promise.all([loadPhotos(true), updateStats()]);
      notify(`${imported} added${duplicates ? ` · ${duplicates} already in the library` : ""}${failed ? ` · ${failed} failed` : ""}`);
    } catch (error) {
      if (error.name !== "AbortError") notify(error.message);
      else notify("Upload cancelled");
      await Promise.all([loadPhotos(true), updateStats()]);
    } finally {
      elements.progressOverlay.hidden = true;
      elements.photoInput.value = "";
      elements.folderInput.value = "";
    }
  }

  function confirmDialog(title, message, confirmText = "Remove") {
    return new Promise(resolve => {
      elements.dialogTitle.textContent = title;
      elements.dialogMessage.textContent = message;
      elements.dialogConfirm.textContent = confirmText;
      elements.dialogOverlay.hidden = false;
      const finish = value => {
        elements.dialogOverlay.hidden = true;
        elements.dialogConfirm.onclick = null;
        elements.dialogCancel.onclick = null;
        resolve(value);
      };
      elements.dialogConfirm.onclick = () => finish(true);
      elements.dialogCancel.onclick = () => finish(false);
    });
  }

  async function removeSelected() {
    const count = selected.size;
    if (!count || !await confirmDialog(`Remove ${count} ${count === 1 ? "photo" : "photos"}?`, `This permanently removes ${count === 1 ? "the original, preview and finished export" : `all ${count} originals, previews and finished exports`} from Server Lab storage.`)) return;
    elements.removeButton.disabled = true;
    try {
      const result = await jsonRequest("/api/photos", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected] }) });
      selectionMode = false;
      selected.clear();
      await Promise.all([loadPhotos(true), updateStats()]);
      notify(`Removed ${result.removed} ${result.removed === 1 ? "photo" : "photos"}`);
    } catch (error) { notify(error.message); }
  }

  async function downloadSelectedZip() {
    if (!selected.size || downloadController) return;
    downloadController = new AbortController();
    elements.progressOverlay.hidden = false;
    elements.progressTitle.textContent = "Preparing download…";
    setProgress(15, `Collecting ${selected.size} ${selected.size === 1 ? "photo" : "photos"}`);
    try {
      const response = await fetch("/api/photos/download.zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
        signal: downloadController.signal
      });
      if (response.status === 401) { location.replace("/login"); return; }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Download failed (${response.status})`);
      }
      setProgress(85, "Finishing ZIP file");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] || "OnDevice-Film-Lab-photos.zip";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setProgress(100, "Download ready");
      notify(`Downloaded ${selected.size} ${selected.size === 1 ? "photo" : "photos"}`);
    } catch (error) {
      notify(error.name === "AbortError" ? "Download cancelled" : error.message);
    } finally {
      downloadController = null;
      elements.progressOverlay.hidden = true;
    }
  }

  function handleCard(card) {
    const id = card?.dataset.id;
    if (!id) return;
    if (!selectionMode) { location.href = `/editor?photo=${encodeURIComponent(id)}`; return; }
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    updateSelection();
  }

  const choosePhotos = () => elements.photoInput.click();
  const chooseFolder = () => elements.folderInput.click();
  elements.uploadButton.onclick = choosePhotos;
  elements.emptyUploadButton.onclick = choosePhotos;
  elements.folderButton.onclick = chooseFolder;
  elements.emptyFolderButton.onclick = chooseFolder;
  elements.photoInput.onchange = event => uploadFiles(event.target.files);
  elements.folderInput.onchange = event => uploadFiles(event.target.files);
  elements.cancelUploadButton.onclick = () => { uploadRequest?.abort(); downloadController?.abort(); };
  elements.selectButton.onclick = () => { selectionMode = !selectionMode; selected.clear(); renderGallery(); };
  elements.selectAllButton.onclick = () => { if (selected.size === photos.length) selected.clear(); else photos.forEach(photo => selected.add(photo.id)); updateSelection(); };
  elements.downloadZipButton.onclick = downloadSelectedZip;
  elements.removeButton.onclick = removeSelected;
  elements.loadMoreButton.onclick = () => loadPhotos(false).catch(error => notify(error.message));
  elements.gallery.addEventListener("click", event => handleCard(event.target.closest(".photoCard")));
  elements.gallery.addEventListener("click", event => { if (event.target.closest(".downloadEdit")) event.stopImmediatePropagation(); }, true);
  elements.gallery.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.closest(".photoCard")) { event.preventDefault(); handleCard(event.target.closest(".photoCard")); } });
  elements.searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadPhotos(true).catch(error => notify(error.message)), 250); });
  elements.sortSelect.value = sortMode;
  function applyGridSize(value) {
    const size = ["small", "medium", "large"].includes(value) ? value : "medium";
    elements.gridSizeSelect.value = size;
    elements.gallery.dataset.size = size;
  }
  try { applyGridSize(localStorage.getItem("filmLabServerGridSize")); } catch { applyGridSize("medium"); }
  elements.gridSizeSelect.addEventListener("change", () => {
    applyGridSize(elements.gridSizeSelect.value);
    try { localStorage.setItem("filmLabServerGridSize", elements.gridSizeSelect.value); } catch { /* Session-only preference if storage is unavailable. */ }
  });
  elements.sortSelect.addEventListener("change", () => {
    sortMode = elements.sortSelect.value === "imported" ? "imported" : "captured";
    localStorage.setItem("filmLabServerSort", sortMode);
    loadPhotos(true).catch(error => notify(error.message));
  });

  let dragDepth = 0;
  document.addEventListener("dragenter", event => { event.preventDefault(); dragDepth++; elements.dropOverlay.hidden = false; });
  document.addEventListener("dragover", event => event.preventDefault());
  document.addEventListener("dragleave", event => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) elements.dropOverlay.hidden = true; });
  document.addEventListener("drop", event => { event.preventDefault(); dragDepth = 0; elements.dropOverlay.hidden = true; if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files); });

  Promise.all([loadPhotos(true), updateStats()]).catch(error => notify(error.message));
})();
