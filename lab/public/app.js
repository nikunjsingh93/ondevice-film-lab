(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const elements = {
    photoInput: $("#photoInput"), folderInput: $("#folderInput"), uploadButton: $("#uploadButton"), folderButton: $("#folderButton"),
    emptyUploadButton: $("#emptyUploadButton"), emptyFolderButton: $("#emptyFolderButton"), selectButton: $("#selectButton"),
    selectAllButton: $("#selectAllButton"), removeButton: $("#removeButton"), selectedCount: $("#selectedCount"),
    selectionActions: $("#selectionActions"), searchInput: $("#searchInput"), gallery: $("#gallery"), emptyState: $("#emptyState"),
    loadMoreButton: $("#loadMoreButton"), photoCount: $("#photoCount"), librarySize: $("#librarySize"), freeSpace: $("#freeSpace"),
    sessionLabel: $("#sessionLabel"), dropOverlay: $("#dropOverlay"), progressOverlay: $("#progressOverlay"),
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
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function updateStats() {
    const [library, session] = await Promise.all([jsonRequest("/api/library"), jsonRequest("/api/session").catch(() => ({ user: null }))]);
    elements.photoCount.textContent = library.photos.toLocaleString();
    elements.librarySize.textContent = formatBytes(library.originalBytes);
    elements.freeSpace.textContent = library.storage ? formatBytes(library.storage.free) : "—";
    elements.sessionLabel.textContent = session.user ? `Private Tailnet · ${session.user.name}` : "Private Server Lab";
  }

  function updateSelection() {
    selectionMode = Boolean(selectionMode);
    elements.selectButton.textContent = selectionMode ? "Done" : "Select";
    elements.selectButton.setAttribute("aria-pressed", String(selectionMode));
    elements.selectionActions.hidden = !selectionMode;
    elements.selectedCount.textContent = `${selected.size} selected`;
    elements.removeButton.disabled = !selected.size;
    elements.selectAllButton.textContent = selected.size && selected.size === photos.length ? "Deselect all" : "Select all";
    document.querySelectorAll(".photoCard").forEach(card => card.classList.toggle("selected", selected.has(card.dataset.id)));
  }

  function renderGallery() {
    elements.emptyState.hidden = total > 0 || Boolean(elements.searchInput.value.trim());
    elements.gallery.innerHTML = photos.map(photo => `
      <article class="photoCard${selected.has(photo.id) ? " selected" : ""}" data-id="${photo.id}" tabindex="0" role="button" aria-label="${selectionMode ? "Select" : "Open"} ${escapeHtml(photo.name)}">
        <img src="${photo.thumbnailUrl}" alt="" loading="lazy" decoding="async">
        ${photo.hasExport ? '<span class="editedBadge">EDITED</span>' : ""}
        ${selectionMode ? '<span class="selectMark">✓</span>' : ""}
        <div class="photoInfo"><strong>${escapeHtml(photo.name)}</strong><span>${formatDate(photo.capturedAt)} · ${formatBytes(photo.size)}</span>${photo.exportUrl ? `<a class="downloadEdit" href="${photo.exportUrl}" download>Download finished JPEG</a>` : ""}</div>
      </article>`).join("");
    elements.loadMoreButton.hidden = !hasMore;
    updateSelection();
  }

  async function loadPhotos(reset = false) {
    const offset = reset ? 0 : photos.length;
    const query = elements.searchInput.value.trim();
    const result = await jsonRequest(`/api/photos?offset=${offset}&limit=60&q=${encodeURIComponent(query)}`);
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
    const files = [...fileList].filter(file => /^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name));
    if (!files.length) return notify("No supported JPEG, PNG or WebP photos were selected.");
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
  elements.cancelUploadButton.onclick = () => uploadRequest?.abort();
  elements.selectButton.onclick = () => { selectionMode = !selectionMode; selected.clear(); renderGallery(); };
  elements.selectAllButton.onclick = () => { if (selected.size === photos.length) selected.clear(); else photos.forEach(photo => selected.add(photo.id)); updateSelection(); };
  elements.removeButton.onclick = removeSelected;
  elements.loadMoreButton.onclick = () => loadPhotos(false).catch(error => notify(error.message));
  elements.gallery.addEventListener("click", event => handleCard(event.target.closest(".photoCard")));
  elements.gallery.addEventListener("click", event => { if (event.target.closest(".downloadEdit")) event.stopImmediatePropagation(); }, true);
  elements.gallery.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.closest(".photoCard")) { event.preventDefault(); handleCard(event.target.closest(".photoCard")); } });
  elements.searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadPhotos(true).catch(error => notify(error.message)), 250); });

  let dragDepth = 0;
  document.addEventListener("dragenter", event => { event.preventDefault(); dragDepth++; elements.dropOverlay.hidden = false; });
  document.addEventListener("dragover", event => event.preventDefault());
  document.addEventListener("dragleave", event => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) elements.dropOverlay.hidden = true; });
  document.addEventListener("drop", event => { event.preventDefault(); dragDepth = 0; elements.dropOverlay.hidden = true; if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files); });

  Promise.all([loadPhotos(true), updateStats()]).catch(error => notify(error.message));
})();
