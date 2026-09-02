"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const Database = require("better-sqlite3");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const exifReader = require("exif-reader");

const APP_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const STATE_DIR = path.resolve(process.env.STATE_DIR || DATA_DIR);
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));
const MAX_UPLOAD_BYTES = Math.max(10, Number(process.env.MAX_UPLOAD_MB) || 150) * 1024 * 1024;
const TRUST_TAILSCALE_HEADERS = String(process.env.TRUST_TAILSCALE_HEADERS || "true") === "true";
const REQUIRE_STORAGE_MARKER = String(process.env.REQUIRE_STORAGE_MARKER || "false") === "true";
const STORAGE_MARKER = path.join(DATA_DIR, ".filmlab-storage");
const directories = {
  originals: path.join(DATA_DIR, "originals"),
  previews: path.join(DATA_DIR, "previews"),
  thumbnails: path.join(DATA_DIR, "thumbnails"),
  exports: path.join(DATA_DIR, "exports"),
  incoming: path.join(DATA_DIR, ".incoming"),
  luts: path.join(DATA_DIR, "luts")
};

if (REQUIRE_STORAGE_MARKER && !fs.existsSync(STORAGE_MARKER)) {
  throw new Error(`External storage marker is missing at ${STORAGE_MARKER}. Refusing to write to a possibly unmounted internal directory.`);
}
for (const directory of [DATA_DIR, STATE_DIR, ...Object.values(directories)]) {
  fs.mkdirSync(directory, { recursive: true });
}

const DATABASE_PATH = path.join(STATE_DIR, "film-lab.db");
const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    preview_path TEXT NOT NULL,
    thumbnail_path TEXT NOT NULL,
    export_path TEXT,
    export_name TEXT,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    captured_at TEXT,
    imported_at TEXT NOT NULL,
    edits_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS photos_imported_at ON photos(imported_at DESC);
  CREATE INDEX IF NOT EXISTS photos_captured_at ON photos(captured_at DESC);
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS luts (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
if (!db.prepare("PRAGMA table_info(photos)").all().some(column => column.name === "export_name")) {
  db.exec("ALTER TABLE photos ADD COLUMN export_name TEXT");
}

const statements = {
  insertPhoto: db.prepare(`
    INSERT INTO photos (
      id, content_hash, original_name, stored_path, preview_path, thumbnail_path,
      mime_type, byte_size, width, height, captured_at, imported_at, edits_json
    ) VALUES (
      @id, @content_hash, @original_name, @stored_path, @preview_path, @thumbnail_path,
      @mime_type, @byte_size, @width, @height, @captured_at, @imported_at, '{}'
    )
  `),
  byHash: db.prepare("SELECT * FROM photos WHERE content_hash = ?"),
  byId: db.prepare("SELECT * FROM photos WHERE id = ?"),
  updateEdits: db.prepare("UPDATE photos SET edits_json = ? WHERE id = ?"),
  updateExport: db.prepare("UPDATE photos SET export_path = ?, export_name = ? WHERE id = ?"),
  deletePhoto: db.prepare("DELETE FROM photos WHERE id = ?"),
  countPhotos: db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM photos"),
  getState: db.prepare("SELECT value_json, updated_at FROM app_state WHERE key = ?"),
  setState: db.prepare(`
    INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `),
  listLuts: db.prepare("SELECT * FROM luts ORDER BY name COLLATE NOCASE"),
  lutById: db.prepare("SELECT * FROM luts WHERE id = ?"),
  lutByHash: db.prepare("SELECT * FROM luts WHERE content_hash = ?"),
  insertLut: db.prepare("INSERT INTO luts (id, content_hash, name, file_name, stored_path, byte_size, created_at) VALUES (@id, @content_hash, @name, @file_name, @stored_path, @byte_size, @created_at)")
};

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function relativeDataPath(absolutePath) {
  return path.relative(DATA_DIR, absolutePath).split(path.sep).join("/");
}

function resolveDataPath(relativePath) {
  const resolved = path.resolve(DATA_DIR, String(relativePath || ""));
  if (resolved !== DATA_DIR && !resolved.startsWith(`${DATA_DIR}${path.sep}`)) {
    throw new Error("Invalid library path");
  }
  return resolved;
}

function photoResponse(row) {
  return {
    id: row.id,
    name: row.original_name,
    mime: row.mime_type,
    size: row.byte_size,
    width: row.width,
    height: row.height,
    capturedAt: row.captured_at,
    importedAt: row.imported_at,
    edits: safeJson(row.edits_json),
    hasExport: Boolean(row.export_path),
    thumbnailUrl: `/api/photos/${row.id}/thumbnail`,
    previewUrl: `/api/photos/${row.id}/preview`,
    originalUrl: `/api/photos/${row.id}/original`,
    exportUrl: row.export_path ? `/api/photos/${row.id}/export` : null
  };
}

function inferExtension(file, detectedFormat = "") {
  if (detectedFormat === "png") return ".png";
  if (detectedFormat === "webp") return ".webp";
  if (["jpeg", "jpg"].includes(detectedFormat)) return ".jpg";
  const extension = path.extname(file.originalname || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(extension)) return extension === ".jpeg" ? ".jpg" : extension;
  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  return ".jpg";
}

function supportedUpload(file) {
  return /^image\/(jpeg|png|webp)$/i.test(file.mimetype || "") || /\.(jpe?g|png|webp)$/i.test(file.originalname || "");
}

function lutResponse(row) {
  return { id: row.id, name: row.name, fileName: row.file_name, size: row.byte_size, createdAt: row.created_at, url: `/api/luts/${row.id}` };
}

function cubeLutId(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `lut-${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filename), hash);
  return hash.digest("hex");
}

function exifCaptureDate(metadata) {
  if (!metadata.exif) return null;
  try {
    const parsed = exifReader(metadata.exif);
    const candidate = parsed?.Photo?.DateTimeOriginal || parsed?.Photo?.DateTimeDigitized || parsed?.Image?.DateTime;
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate;
    if (candidate) {
      const normalized = String(candidate).replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
      const date = new Date(normalized);
      if (!Number.isNaN(date.getTime())) return date;
    }
  } catch (error) {
    console.warn("Could not parse EXIF capture date:", error.message);
  }
  return null;
}

async function removeIfPresent(filename) {
  if (!filename) return;
  try { await fsp.unlink(filename); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function deletePhotoIds(ids) {
  const uniqueIds = [...new Set(ids.map(String))].slice(0, 1000);
  const rows = uniqueIds.map(id => statements.byId.get(id)).filter(Boolean);
  const transaction = db.transaction(records => {
    for (const row of records) statements.deletePhoto.run(row.id);
  });
  transaction(rows);
  for (const row of rows) {
    await Promise.allSettled([row.stored_path, row.preview_path, row.thumbnail_path, row.export_path]
      .filter(Boolean).map(filename => removeIfPresent(resolveDataPath(filename))));
  }
  return rows.length;
}

async function importPhoto(file) {
  if (!supportedUpload(file)) throw new Error(`${file.originalname} is not a supported JPEG, PNG, or WebP photo.`);
  const hash = await hashFile(file.path);
  const duplicate = statements.byHash.get(hash);
  if (duplicate) {
    await removeIfPresent(file.path);
    return { duplicate: true, photo: photoResponse(duplicate) };
  }

  const metadata = await sharp(file.path, { failOn: "warning" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`${file.originalname} could not be decoded.`);
  const captureDate = exifCaptureDate(metadata) || new Date();
  const year = String(captureDate.getFullYear()).padStart(4, "0");
  const month = String(captureDate.getMonth() + 1).padStart(2, "0");
  const id = crypto.randomUUID();
  const extension = inferExtension(file, metadata.format);
  const originalDirectory = path.join(directories.originals, year, month);
  await fsp.mkdir(originalDirectory, { recursive: true });
  const originalPath = path.join(originalDirectory, `${id}${extension}`);
  const previewPath = path.join(directories.previews, `${id}.jpg`);
  const thumbnailPath = path.join(directories.thumbnails, `${id}.jpg`);

  await fsp.rename(file.path, originalPath);
  try {
    const source = sharp(originalPath, { failOn: "none" }).rotate();
    await Promise.all([
      source.clone().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toFile(previewPath),
      source.clone().resize({ width: 520, height: 360, fit: "cover", position: "attention", withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(thumbnailPath)
    ]);
    const row = {
      id,
      content_hash: hash,
      original_name: path.basename(file.originalname || `Photo${extension}`).slice(0, 240),
      stored_path: relativeDataPath(originalPath),
      preview_path: relativeDataPath(previewPath),
      thumbnail_path: relativeDataPath(thumbnailPath),
      mime_type: metadata.format === "png" ? "image/png" : metadata.format === "webp" ? "image/webp" : "image/jpeg",
      byte_size: file.size,
      width: metadata.autoOrient?.width || metadata.width,
      height: metadata.autoOrient?.height || metadata.height,
      captured_at: captureDate.toISOString(),
      imported_at: new Date().toISOString()
    };
    statements.insertPhoto.run(row);
    return { duplicate: false, photo: photoResponse(statements.byId.get(id)) };
  } catch (error) {
    await Promise.allSettled([removeIfPresent(originalPath), removeIfPresent(previewPath), removeIfPresent(thumbnailPath)]);
    throw error;
  }
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, directories.incoming),
    filename: (_request, _file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}.upload`)
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 500 }
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "2mb" }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_request, response) => response.json({ ok: true, version: "1.0.1" }));

app.get("/api/library", asyncRoute(async (_request, response) => {
  const counts = statements.countPhotos.get();
  let storage = null;
  try {
    const stats = await fsp.statfs(DATA_DIR);
    storage = { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch { /* Storage totals are optional. */ }
  response.json({ photos: counts.count, originalBytes: counts.bytes, storage });
}));

app.get("/api/photos", (request, response) => {
  const limit = Math.max(1, Math.min(120, Number(request.query.limit) || 60));
  const offset = Math.max(0, Number(request.query.offset) || 0);
  const query = String(request.query.q || "").trim();
  const rows = query
    ? db.prepare("SELECT * FROM photos WHERE original_name LIKE ? ESCAPE '\\' ORDER BY COALESCE(captured_at, imported_at) DESC LIMIT ? OFFSET ?")
      .all(`%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`, limit, offset)
    : db.prepare("SELECT * FROM photos ORDER BY COALESCE(captured_at, imported_at) DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = query
    ? db.prepare("SELECT COUNT(*) AS count FROM photos WHERE original_name LIKE ? ESCAPE '\\'").get(`%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`).count
    : statements.countPhotos.get().count;
  response.json({ photos: rows.map(photoResponse), total, offset, limit, hasMore: offset + rows.length < total });
});

app.get("/api/photos/:id", (request, response) => {
  const row = statements.byId.get(request.params.id);
  if (!row) return response.status(404).json({ error: "Photo not found" });
  response.json({ photo: photoResponse(row) });
});

function sendPhotoFile(column, download = false) {
  return (request, response, next) => {
    try {
      const row = statements.byId.get(request.params.id);
      if (!row || !row[column]) return response.status(404).json({ error: "Photo file not found" });
      const filename = resolveDataPath(row[column]);
      response.setHeader("Cache-Control", column === "stored_path" ? "private, max-age=3600" : "private, max-age=86400");
      if (download) return response.download(filename, row.export_name || `${path.parse(row.original_name).name}_FilmLab.jpg`);
      response.type(path.extname(filename)).sendFile(filename, error => { if (error) next(error); });
    } catch (error) { next(error); }
  };
}

app.get("/api/photos/:id/original", sendPhotoFile("stored_path"));
app.get("/api/photos/:id/preview", sendPhotoFile("preview_path"));
app.get("/api/photos/:id/thumbnail", sendPhotoFile("thumbnail_path"));
app.get("/api/photos/:id/export", sendPhotoFile("export_path", true));

app.post("/api/photos", upload.array("photos", 500), asyncRoute(async (request, response) => {
  const files = request.files || [];
  if (!files.length) return response.status(400).json({ error: "No photos were selected" });
  const imported = [];
  const duplicates = [];
  const errors = [];
  for (const file of files) {
    try {
      const result = await importPhoto(file);
      (result.duplicate ? duplicates : imported).push(result.photo);
    } catch (error) {
      await removeIfPresent(file.path).catch(() => {});
      errors.push({ name: file.originalname, error: error.message });
    }
  }
  response.status(imported.length || duplicates.length ? 201 : 400).json({ imported, duplicates, errors });
}));

app.patch("/api/photos/:id/edits", (request, response) => {
  const row = statements.byId.get(request.params.id);
  if (!row) return response.status(404).json({ error: "Photo not found" });
  const edits = request.body?.edits;
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return response.status(400).json({ error: "Invalid edits" });
  const encoded = JSON.stringify(edits);
  if (encoded.length > 250_000) return response.status(413).json({ error: "Edit data is too large" });
  statements.updateEdits.run(encoded, row.id);
  response.json({ ok: true });
});

app.post("/api/photos/:id/edits-beacon", (request, response) => {
  const row = statements.byId.get(request.params.id);
  if (!row) return response.status(404).end();
  const edits = request.body?.edits;
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return response.status(400).end();
  const encoded = JSON.stringify(edits);
  if (encoded.length > 250_000) return response.status(413).end();
  statements.updateEdits.run(encoded, row.id);
  response.status(204).end();
});

app.put("/api/photos/:id/export", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: `${Math.ceil(MAX_UPLOAD_BYTES / 1024 / 1024)}mb` }), asyncRoute(async (request, response) => {
  const row = statements.byId.get(request.params.id);
  if (!row) return response.status(404).json({ error: "Photo not found" });
  if (!Buffer.isBuffer(request.body) || request.body.length < 4 || request.body[0] !== 0xff || request.body[1] !== 0xd8) {
    return response.status(400).json({ error: "The processed file is not a JPEG" });
  }
  const outputName = String(request.get("X-FilmLab-Filename") || `${path.parse(row.original_name).name}_FilmLab.jpg`)
    .replace(/[^a-z0-9._' -]/gi, "_").slice(0, 240);
  const exportPath = path.join(directories.exports, `${row.id}.jpg`);
  await fsp.writeFile(exportPath, request.body, { mode: 0o640 });
  statements.updateExport.run(relativeDataPath(exportPath), outputName, row.id);
  response.json({ ok: true, filename: outputName, url: `/api/photos/${row.id}/export` });
}));

app.delete("/api/photos", asyncRoute(async (request, response) => {
  const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids.map(String))].slice(0, 1000) : [];
  if (!ids.length) return response.status(400).json({ error: "No photos selected" });
  response.json({ removed: await deletePhotoIds(ids) });
}));

app.get("/api/state/:key", (request, response) => {
  if (!/^[a-z0-9-]{1,40}$/i.test(request.params.key)) return response.status(400).json({ error: "Invalid state key" });
  const row = statements.getState.get(request.params.key);
  response.json({ value: row ? safeJson(row.value_json, null) : null, updatedAt: row?.updated_at || null });
});

app.put("/api/state/:key", (request, response) => {
  if (!/^[a-z0-9-]{1,40}$/i.test(request.params.key)) return response.status(400).json({ error: "Invalid state key" });
  const value = request.body?.value;
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > 500_000) return response.status(413).json({ error: "State is too large" });
  const updatedAt = new Date().toISOString();
  statements.setState.run(request.params.key, encoded, updatedAt);
  response.json({ ok: true, updatedAt });
});

app.get("/api/luts", (_request, response) => response.json({ luts: statements.listLuts.all().map(lutResponse) }));

app.get("/api/luts/:id", (request, response, next) => {
  try {
    const row = statements.lutById.get(request.params.id);
    if (!row) return response.status(404).json({ error: "LUT not found" });
    response.type("text/plain").sendFile(resolveDataPath(row.stored_path), error => { if (error) next(error); });
  } catch (error) { next(error); }
});

app.post("/api/luts", upload.single("lut"), asyncRoute(async (request, response) => {
  const file = request.file;
  if (!file) return response.status(400).json({ error: "No LUT was selected" });
  try {
    if (!/\.cube$/i.test(file.originalname || "")) throw Object.assign(new Error("Only .cube LUT files are supported"), { status: 400 });
    if (file.size > 20 * 1024 * 1024) throw Object.assign(new Error("The LUT exceeds the 20 MB safety limit"), { status: 413 });
    const text = await fsp.readFile(file.path, "utf8");
    if (!/^\s*(?:#.*\n\s*)*(?:TITLE\s+"[^"]*"\s*\n\s*)*(?:DOMAIN_|LUT_(?:1D|3D)_SIZE)/im.test(text)) {
      throw Object.assign(new Error("This does not appear to be a valid .cube LUT"), { status: 400 });
    }
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const existing = statements.lutByHash.get(hash);
    if (existing) {
      await removeIfPresent(file.path);
      return response.json({ duplicate: true, lut: lutResponse(existing) });
    }
    const id = cubeLutId(text);
    const title = text.match(/^\s*TITLE\s+"([^"]+)"/im)?.[1]?.trim();
    const fileName = path.basename(file.originalname).slice(0, 180);
    const destination = path.join(directories.luts, `${id}.cube`);
    await fsp.rename(file.path, destination);
    const row = {
      id,
      content_hash: hash,
      name: (title || fileName.replace(/\.cube$/i, "") || "Custom LUT").slice(0, 80),
      file_name: fileName,
      stored_path: relativeDataPath(destination),
      byte_size: file.size,
      created_at: new Date().toISOString()
    };
    statements.insertLut.run(row);
    response.status(201).json({ duplicate: false, lut: lutResponse(row) });
  } catch (error) {
    await removeIfPresent(file.path).catch(() => {});
    throw error;
  }
}));

app.get("/api/session", (request, response) => {
  const login = TRUST_TAILSCALE_HEADERS ? request.get("Tailscale-User-Login") : null;
  const name = TRUST_TAILSCALE_HEADERS ? request.get("Tailscale-User-Name") : null;
  response.json({ user: login ? { login, name: name || login } : null });
});

function createEditorHtml() {
  let html = fs.readFileSync(path.join(APP_ROOT, "index.html"), "utf8");
  const bridgeApi = `
  window.__FILMLAB_SERVER_EDITOR__={
    async loadPhoto(file,state){
      await addFiles([file]);
      const index=items.length-1,item=items[index];
      if(state&&item){
        item.rotation=Number(state.rotation)||0;
        item.straighten=Number(state.straighten)||0;
        item.crop=state.crop||null;
        item.settings={...cloneSettings(batchSettings),...(state.settings||{})};
        loadPhotoSettings(item.settings);
        refreshThumb(index);
      }
      select(index);
    },
    captureState(){return current>=0&&items[current]?storedStateFor(items[current]):null},
    async renderCurrent(){
      if(current<0||!items[current])throw new Error("No photo is open");
      return processItem(items[current]);
    },
    async currentOutputName(){return current>=0&&items[current]?outputName(items[current].file):"FilmLab.jpg"},
    listLutIds(){return [...customLuts.keys()]},
    async importLutText(text,fileName){
      const lut=parseCubeLut(text,fileName);
      customLuts.set(lut.id,lut);
      addLutOption(lut);
      await persistCustomLut(lut);
      return lut.id;
    },
    setBusy,
    setStatus,
    rerender
  };
`;
  html = html.replace("  updateButtons();\n  lutRestorePromise=restoreCustomLuts();\n  libraryRestorePromise=lutRestorePromise.then(()=>restoreStoredLibrary());", `${bridgeApi}\n  updateButtons();\n  lutRestorePromise=restoreCustomLuts();\n  libraryRestorePromise=Promise.resolve();`);
  html = html.replace("    const persisted=await persistImportedItems(added);", "    const persisted=true;");
  html = html.replace('if ("serviceWorker" in navigator && location.protocol !== "file:") {', 'if (false && "serviceWorker" in navigator && location.protocol !== "file:") {');
  html = html.replace("</body>", '<script src="/lab-editor.js"></script>\n</body>');
  return html;
}

const editorHtml = createEditorHtml();
app.get("/editor", (_request, response) => response.type("html").send(editorHtml));
app.use("/branding", express.static(path.join(APP_ROOT, "branding"), { maxAge: "7d" }));
app.use("/icons", express.static(path.join(APP_ROOT, "icons"), { maxAge: "7d" }));
app.get("/manifest.webmanifest", (_request, response) => response.sendFile(path.join(APP_ROOT, "manifest.webmanifest")));
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));

app.use((error, request, response, _next) => {
  console.error(error);
  if (request.file?.path) removeIfPresent(request.file.path).catch(() => {});
  for (const file of request.files || []) removeIfPresent(file.path).catch(() => {});
  const status = error instanceof multer.MulterError ? 400 : Number(error.status) || 500;
  response.status(status).json({ error: status >= 500 ? "Server Lab could not complete that request" : error.message });
});

let server = null;
function startServer(port = PORT, host = "0.0.0.0") {
  if (server) return server;
  server = app.listen(port, host, () => {
    console.log(`OnDevice Film Lab Server listening on http://${host}:${port}`);
    console.log(`Library storage: ${DATA_DIR}`);
    console.log(`Database storage: ${DATABASE_PATH}`);
  });
  return server;
}

function shutdown(signal) {
  console.log(`${signal} received; closing Server Lab`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

if (require.main === module) {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  startServer();
}
module.exports = {
  app,
  db,
  startServer,
  testApi: { DATA_DIR, STATE_DIR, DATABASE_PATH, directories, statements, importPhoto, deletePhotoIds, createEditorHtml }
};
