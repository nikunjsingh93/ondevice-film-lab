"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const Database = require("better-sqlite3");
const archiver = require("archiver");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const exifReader = require("exif-reader");
const PhotoFormats = require("../photo-formats");
const PhotoCodecs = require("../photo-codecs");

const APP_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const STATE_DIR = path.resolve(process.env.STATE_DIR || DATA_DIR);
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));
const MAX_UPLOAD_BYTES = Math.max(10, Number(process.env.MAX_UPLOAD_MB) || 150) * 1024 * 1024;
const TRUST_TAILSCALE_HEADERS = String(process.env.TRUST_TAILSCALE_HEADERS || "true") === "true";
const REQUIRE_STORAGE_MARKER = String(process.env.REQUIRE_STORAGE_MARKER || "false") === "true";
const STORAGE_MARKER = path.join(DATA_DIR, ".filmlab-storage");
const SESSION_COOKIE = "film_lab_session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

if (REQUIRE_STORAGE_MARKER && !fs.existsSync(STORAGE_MARKER)) {
  throw new Error(`External storage marker is missing at ${STORAGE_MARKER}. Refusing to write to a possibly unmounted internal directory.`);
}
for (const directory of [DATA_DIR, STATE_DIR, path.join(DATA_DIR, ".incoming")]) {
  fs.mkdirSync(directory, { recursive: true });
}

const DATABASE_PATH = path.join(STATE_DIR, "film-lab.db");
const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function passwordMatches(password, encoded) {
  try {
    const [scheme, saltText, digestText] = String(encoded).split("$");
    if (scheme !== "scrypt" || !saltText || !digestText) return false;
    const expected = Buffer.from(digestText, "base64url");
    const actual = crypto.scryptSync(String(password), Buffer.from(saltText, "base64url"), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','user')),
    quota_bytes INTEGER,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

let defaultAdmin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
if (!defaultAdmin) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, username, password_hash, role, quota_bytes, must_change_password, created_at, updated_at) VALUES (?, 'admin', ?, 'admin', NULL, 1, ?, ?)")
    .run(id, passwordHash("admin"), now, now);
  defaultAdmin = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  console.warn("Created the initial Server Lab administrator. Sign in with admin / admin and change the password immediately.");
}

const photoTableSql = `CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  preview_path TEXT NOT NULL,
  working_path TEXT,
  working_byte_size INTEGER NOT NULL DEFAULT 0,
  thumbnail_path TEXT NOT NULL,
  export_path TEXT,
  export_name TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  preview_byte_size INTEGER NOT NULL DEFAULT 0,
  thumbnail_byte_size INTEGER NOT NULL DEFAULT 0,
  export_byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  captured_at TEXT,
  imported_at TEXT NOT NULL,
  edits_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(user_id, content_hash)
)`;
const stateTableSql = `CREATE TABLE app_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, key)
)`;
const lutTableSql = `CREATE TABLE luts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, content_hash)
)`;

function migrateOwnedTable(name, createSql, normalize) {
  const exists = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!exists) { db.exec(createSql); return; }
  const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name);
  const needsMigration = !columns.includes("user_id") || (name === "photos" && !columns.includes("export_byte_size"));
  if (!needsMigration) return;
  const rows = db.prepare(`SELECT * FROM ${name}`).all();
  db.transaction(() => {
    db.exec(`DROP TABLE ${name}`);
    db.exec(createSql);
    for (const row of rows) normalize(row);
  })();
}

migrateOwnedTable("photos", photoTableSql, row => {
  const storedSize = relativePath => {
    if (!relativePath) return 0;
    try { return fs.statSync(path.resolve(DATA_DIR, relativePath)).size; } catch { return 0; }
  };
  db.prepare(`
    INSERT INTO photos (id,user_id,content_hash,original_name,stored_path,preview_path,thumbnail_path,export_path,export_name,mime_type,byte_size,preview_byte_size,thumbnail_byte_size,export_byte_size,width,height,captured_at,imported_at,edits_json)
    VALUES (@id,@user_id,@content_hash,@original_name,@stored_path,@preview_path,@thumbnail_path,@export_path,@export_name,@mime_type,@byte_size,@preview_byte_size,@thumbnail_byte_size,@export_byte_size,@width,@height,@captured_at,@imported_at,@edits_json)
  `).run({
    ...row,
    user_id: row.user_id || defaultAdmin.id,
    export_name: row.export_name || null,
    preview_byte_size: row.preview_byte_size || storedSize(row.preview_path),
    thumbnail_byte_size: row.thumbnail_byte_size || storedSize(row.thumbnail_path),
    export_byte_size: row.export_byte_size || storedSize(row.export_path)
  });
});
migrateOwnedTable("app_state", stateTableSql, row => db.prepare("INSERT INTO app_state (user_id,key,value_json,updated_at) VALUES (?,?,?,?)")
  .run(row.user_id || defaultAdmin.id, row.key, row.value_json, row.updated_at));
migrateOwnedTable("luts", lutTableSql, row => db.prepare("INSERT INTO luts (id,user_id,content_hash,name,file_name,stored_path,byte_size,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run(row.id, row.user_id || defaultAdmin.id, row.content_hash, row.name, row.file_name, row.stored_path, row.byte_size, row.created_at));
db.exec(`
  CREATE INDEX IF NOT EXISTS photos_user_imported ON photos(user_id, imported_at DESC);
  CREATE INDEX IF NOT EXISTS photos_user_captured ON photos(user_id, captured_at DESC);
`);

// Existing libraries gain optional full-resolution decoded sources without rewriting originals.
const photoColumns = db.prepare("PRAGMA table_info(photos)").all().map(column => column.name);
if (!photoColumns.includes("working_path")) db.exec("ALTER TABLE photos ADD COLUMN working_path TEXT");
if (!photoColumns.includes("working_byte_size")) db.exec("ALTER TABLE photos ADD COLUMN working_byte_size INTEGER NOT NULL DEFAULT 0");

const statements = {
  insertPhoto: db.prepare(`
    INSERT INTO photos (
      id, user_id, content_hash, original_name, stored_path, preview_path, thumbnail_path, working_path, working_byte_size,
      mime_type, byte_size, preview_byte_size, thumbnail_byte_size, width, height, captured_at, imported_at, edits_json
    ) VALUES (
      @id, @user_id, @content_hash, @original_name, @stored_path, @preview_path, @thumbnail_path, @working_path, @working_byte_size,
      @mime_type, @byte_size, @preview_byte_size, @thumbnail_byte_size, @width, @height, @captured_at, @imported_at, '{}'
    )
  `),
  byHash: db.prepare("SELECT * FROM photos WHERE user_id = ? AND content_hash = ?"),
  byId: db.prepare("SELECT * FROM photos WHERE user_id = ? AND id = ?"),
  updateEdits: db.prepare("UPDATE photos SET edits_json = ? WHERE user_id = ? AND id = ?"),
  updateExport: db.prepare("UPDATE photos SET export_path = ?, export_name = ?, export_byte_size = ? WHERE user_id = ? AND id = ?"),
  deletePhoto: db.prepare("DELETE FROM photos WHERE user_id = ? AND id = ?"),
  countPhotos: db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM photos WHERE user_id = ?"),
  usagePhotos: db.prepare("SELECT COALESCE(SUM(byte_size + preview_byte_size + thumbnail_byte_size + export_byte_size + working_byte_size), 0) AS bytes FROM photos WHERE user_id = ?"),
  usageLuts: db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM luts WHERE user_id = ?"),
  getState: db.prepare("SELECT value_json, updated_at FROM app_state WHERE user_id = ? AND key = ?"),
  setState: db.prepare(`
    INSERT INTO app_state (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `),
  listLuts: db.prepare("SELECT * FROM luts WHERE user_id = ? ORDER BY name COLLATE NOCASE"),
  lutById: db.prepare("SELECT * FROM luts WHERE user_id = ? AND id = ?"),
  lutByHash: db.prepare("SELECT * FROM luts WHERE user_id = ? AND content_hash = ?"),
  insertLut: db.prepare("INSERT INTO luts (id, user_id, content_hash, name, file_name, stored_path, byte_size, created_at) VALUES (@id, @user_id, @content_hash, @name, @file_name, @stored_path, @byte_size, @created_at)"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  userByName: db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  sessionByToken: db.prepare("SELECT sessions.*, users.id AS id, users.username, users.role, users.quota_bytes, users.must_change_password FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?")
};

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function userDirectories(userId) {
  const safeId = String(userId);
  if (!/^[a-f0-9-]{20,50}$/i.test(safeId)) throw new Error("Invalid account storage identifier");
  const root = path.join(DATA_DIR, "users", safeId);
  const result = {
    root,
    originals: path.join(root, "originals"),
    previews: path.join(root, "previews"),
    working: path.join(root, "working"),
    thumbnails: path.join(root, "thumbnails"),
    exports: path.join(root, "exports"),
    luts: path.join(root, "luts"),
    incoming: path.join(DATA_DIR, ".incoming", safeId)
  };
  for (const directory of Object.values(result)) fs.mkdirSync(directory, { recursive: true });
  return result;
}

function userUsage(userId) {
  return statements.usagePhotos.get(userId).bytes + statements.usageLuts.get(userId).bytes;
}

function quotaError(user, additionalBytes, replacedBytes = 0) {
  if (user.quota_bytes == null) return null;
  const projected = userUsage(user.id) - Math.max(0, replacedBytes) + Math.max(0, additionalBytes);
  if (projected <= user.quota_bytes) return null;
  const error = new Error("Your Server Lab storage allowance is full. Remove photos or ask the administrator for more space.");
  error.status = 413;
  error.code = "QUOTA_EXCEEDED";
  return error;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isAdmin: row.role === "admin",
    quotaBytes: row.quota_bytes == null ? null : Number(row.quota_bytes),
    mustChangePassword: Boolean(row.must_change_password)
  };
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
    isEdited: hasSavedEdits(row),
    isRaw: PhotoFormats.isRaw(row.original_name),
    editUrl: row.working_path ? `/api/photos/${row.id}/working` : null,
    thumbnailUrl: `/api/photos/${row.id}/thumbnail`,
    previewUrl: `/api/photos/${row.id}/preview`,
    originalUrl: `/api/photos/${row.id}/original`,
    exportUrl: row.export_path ? `/api/photos/${row.id}/export` : null
  };
}

function hasSavedEdits(row) {
  const edits = safeJson(row?.edits_json, null);
  if (row?.export_path) return true;
  if (!edits || typeof edits !== "object" || Array.isArray(edits) || !Object.keys(edits).length) return false;
  return Object.prototype.hasOwnProperty.call(edits, "isEdited") ? Boolean(edits.isEdited) : true;
}

function nearbyPhotos(userId, photoId, requestedLimit = 9) {
  const limit = Math.max(3, Math.min(15, Number(requestedLimit) || 9));
  const half = Math.floor(limit / 2);
  return db.prepare(`
    WITH ordered AS (
      SELECT photos.*,
        ROW_NUMBER() OVER (ORDER BY COALESCE(captured_at, imported_at) DESC, imported_at DESC, id DESC) AS filmstrip_position,
        COUNT(*) OVER () AS filmstrip_total
      FROM photos
      WHERE user_id = ?
    ), target AS (
      SELECT filmstrip_position, filmstrip_total FROM ordered WHERE id = ?
    ), bounds AS (
      SELECT MAX(1, MIN(filmstrip_position - ?, filmstrip_total - ? + 1)) AS start_position FROM target
    )
    SELECT ordered.* FROM ordered, bounds
    WHERE filmstrip_position BETWEEN start_position AND start_position + ? - 1
    ORDER BY filmstrip_position
  `).all(userId, photoId, half, limit, limit);
}

function inferExtension(file, detectedFormat = "") {
  const extension = path.extname(file.originalname || "").toLowerCase();
  if (PhotoFormats.mime(file.originalname)) return extension;
  return {jpeg:'.jpg',png:'.png',webp:'.webp',gif:'.gif',avif:'.avif',heif:'.heic',tiff:'.tiff'}[detectedFormat] || '.jpg';
}

function supportedUpload(file) { return PhotoFormats.supported(file); }

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

async function deletePhotoIds(ids, userId) {
  const uniqueIds = [...new Set(ids.map(String))];
  const rows = uniqueIds.map(id => statements.byId.get(userId, id)).filter(Boolean);
  const transaction = db.transaction(records => {
    for (const row of records) statements.deletePhoto.run(userId, row.id);
  });
  transaction(rows);
  for (const row of rows) {
    await Promise.allSettled([row.stored_path, row.preview_path, row.thumbnail_path, row.export_path, row.working_path]
      .filter(Boolean).map(filename => removeIfPresent(resolveDataPath(filename))));
  }
  return rows.length;
}

async function importPhoto(file, user) {
  if (!supportedUpload(file)) throw new Error(`${file.originalname} is not a supported photo format.`);
  const hash = await hashFile(file.path);
  const duplicate = statements.byHash.get(user.id, hash);
  if (duplicate) {
    await removeIfPresent(file.path);
    return { duplicate: true, photo: photoResponse(duplicate) };
  }

  const kind = PhotoFormats.kind(file);
  let workingBuffer = null, decodedCapture = null;
  if (kind) {
    const bytes = await fsp.readFile(file.path);
    const decoded = await PhotoCodecs.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), kind);
    workingBuffer = await sharp(Buffer.from(decoded.data), { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    if (decoded.captureTime) decodedCapture = new Date(decoded.captureTime);
  }
  const metadata = await sharp(workingBuffer || file.path, { failOn: "warning" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`${file.originalname} could not be decoded.`);
  const captureDate = decodedCapture || exifCaptureDate(metadata) || new Date();
  const year = String(captureDate.getFullYear()).padStart(4, "0");
  const month = String(captureDate.getMonth() + 1).padStart(2, "0");
  const id = crypto.randomUUID();
  const extension = inferExtension(file, metadata.format);
  const directories = userDirectories(user.id);
  const originalDirectory = path.join(directories.originals, year, month);
  await fsp.mkdir(originalDirectory, { recursive: true });
  const originalPath = path.join(originalDirectory, `${id}${extension}`);
  const previewPath = path.join(directories.previews, `${id}.jpg`);
  const thumbnailPath = path.join(directories.thumbnails, `${id}.jpg`);
  const workingPath = workingBuffer ? path.join(directories.working, `${id}.png`) : null;

  await fsp.rename(file.path, originalPath);
  try {
    if (workingPath) await fsp.writeFile(workingPath, workingBuffer);
    const source = sharp(workingBuffer || originalPath, { failOn: "none" }).rotate();
    await Promise.all([
      source.clone().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toFile(previewPath),
      source.clone().resize({ width: 520, height: 360, fit: "cover", position: "attention", withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(thumbnailPath)
    ]);
    const [previewStats, thumbnailStats] = await Promise.all([fsp.stat(previewPath), fsp.stat(thumbnailPath)]);
    const quotaFailure = quotaError(user, file.size + previewStats.size + thumbnailStats.size + (workingBuffer?.length || 0));
    if (quotaFailure) throw quotaFailure;
    const row = {
      id,
      user_id: user.id,
      content_hash: hash,
      original_name: path.basename(file.originalname || `Photo${extension}`).slice(0, 240),
      stored_path: relativeDataPath(originalPath),
      preview_path: relativeDataPath(previewPath),
      thumbnail_path: relativeDataPath(thumbnailPath),
      working_path: workingPath ? relativeDataPath(workingPath) : null,
      working_byte_size: workingBuffer?.length || 0,
      mime_type: PhotoFormats.mime(file.originalname) || file.mimetype || "application/octet-stream",
      byte_size: file.size,
      preview_byte_size: previewStats.size,
      thumbnail_byte_size: thumbnailStats.size,
      width: metadata.autoOrient?.width || metadata.width,
      height: metadata.autoOrient?.height || metadata.height,
      captured_at: captureDate.toISOString(),
      imported_at: new Date().toISOString()
    };
    statements.insertPhoto.run(row);
    return { duplicate: false, photo: photoResponse(statements.byId.get(user.id, id)) };
  } catch (error) {
    await Promise.allSettled([removeIfPresent(originalPath), removeIfPresent(previewPath), removeIfPresent(thumbnailPath), removeIfPresent(workingPath)]);
    throw error;
  }
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  for (const part of String(request.headers.cookie || "").split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return "";
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function setSessionCookie(request, response, token, maxAgeSeconds) {
  const secure = request.secure;
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, maxAgeSeconds)}${secure ? "; Secure" : ""}`);
}

function authenticate(request, _response, next) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    const tokenHash = sessionTokenHash(token);
    const row = statements.sessionByToken.get(tokenHash, Date.now());
    if (row) {
      request.user = row;
      request.sessionTokenHash = tokenHash;
    }
  }
  next();
}

function requireAuth(request, response, next) {
  if (request.user) return next();
  if (request.path.startsWith("/api/")) return response.status(401).json({ error: "Please sign in to Server Lab", code: "AUTH_REQUIRED" });
  response.redirect("/login");
}

function requireReadyAccount(request, response, next) {
  if (!request.user.must_change_password) return next();
  if (request.path.startsWith("/api/")) return response.status(403).json({ error: "Change the temporary password before using Server Lab", code: "PASSWORD_CHANGE_REQUIRED" });
  response.redirect("/login");
}

function requireAdmin(request, response, next) {
  if (request.user?.role === "admin") return next();
  response.status(403).json({ error: "Administrator access is required" });
}

function validUsername(value) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/i.test(String(value || ""));
}

function parseQuotaBytes(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 50 * 1024 * 1024) throw Object.assign(new Error("Storage allowance must be at least 50 MB or unlimited"), { status: 400 });
  return number;
}

function quotaUploadGuard(request, response, next) {
  if (request.user.quota_bytes == null) return next();
  const contentLength = Number(request.get("Content-Length"));
  const remaining = Math.max(0, request.user.quota_bytes - userUsage(request.user.id));
  if (Number.isFinite(contentLength) && contentLength > remaining) {
    return response.status(413).json({ error: "This upload is larger than your remaining Server Lab storage allowance", code: "QUOTA_EXCEEDED" });
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (request, _file, callback) => {
      try { callback(null, userDirectories(request.user.id).incoming); } catch (error) { callback(error); }
    },
    filename: (_request, _file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}.upload`)
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 500 }
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "10mb" }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_request, response) => response.json({ ok: true, version: "1.4.4" }));
app.use(authenticate);

const loginFailures = new Map();
app.post("/api/auth/login", (request, response) => {
  const attemptKey = request.ip || "unknown";
  const attempt = loginFailures.get(attemptKey);
  if (attempt?.blockedUntil > Date.now()) return response.status(429).json({ error: "Too many sign-in attempts. Try again in a few minutes." });
  const username = String(request.body?.username || "").trim();
  const password = String(request.body?.password || "");
  const user = statements.userByName.get(username);
  if (!user || !passwordMatches(password, user.password_hash)) {
    const failures = (attempt?.failures || 0) + 1;
    loginFailures.set(attemptKey, { failures, blockedUntil: failures >= 8 ? Date.now() + 10 * 60 * 1000 : 0 });
    return response.status(401).json({ error: "Incorrect username or password" });
  }
  loginFailures.delete(attemptKey);
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)")
    .run(sessionTokenHash(token), user.id, now, now + SESSION_LIFETIME_MS, now);
  setSessionCookie(request, response, token, Math.floor(SESSION_LIFETIME_MS / 1000));
  response.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (request, response) => {
  if (request.sessionTokenHash) statements.deleteSession.run(request.sessionTokenHash);
  setSessionCookie(request, response, "", 0);
  response.json({ ok: true });
});

app.get("/api/auth/session", (request, response) => {
  response.json({ authenticated: Boolean(request.user), user: request.user ? publicUser(request.user) : null });
});

app.put("/api/account", requireAuth, (request, response) => {
  const current = statements.userById.get(request.user.user_id);
  const currentPassword = String(request.body?.currentPassword || "");
  if (!passwordMatches(currentPassword, current.password_hash)) return response.status(400).json({ error: "Current password is incorrect" });
  const username = String(request.body?.username || current.username).trim();
  const newPassword = String(request.body?.newPassword || "");
  if (!validUsername(username)) return response.status(400).json({ error: "Username must be 3–32 characters using letters, numbers, dots, dashes or underscores" });
  if ((newPassword || current.must_change_password) && (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 256)) return response.status(400).json({ error: `New password must be ${MIN_PASSWORD_LENGTH}–256 characters` });
  const conflict = statements.userByName.get(username);
  if (conflict && conflict.id !== current.id) return response.status(409).json({ error: "That username is already in use" });
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET username = ?, password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?")
    .run(username, newPassword ? passwordHash(newPassword) : current.password_hash, now, current.id);
  if (newPassword) db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(current.id, request.sessionTokenHash);
  response.json({ user: publicUser(statements.userById.get(current.id)) });
});

app.get("/login", (_request, response) => response.sendFile(path.join(PUBLIC_DIR, "login.html")));
app.get("/login.html", (_request, response) => response.redirect("/login"));
app.get("/auth.js", (_request, response) => response.sendFile(path.join(PUBLIC_DIR, "auth.js")));
app.get(["/theme.css", "/theme.js"], (request, response) => response.sendFile(path.join(APP_ROOT, request.path.slice(1))));
app.get("/styles.css", (_request, response) => response.sendFile(path.join(PUBLIC_DIR, "styles.css")));
app.use("/branding", express.static(path.join(APP_ROOT, "branding"), { maxAge: "7d" }));
app.use("/icons", express.static(path.join(APP_ROOT, "icons"), { maxAge: "7d" }));

app.use(requireAuth);

app.get("/api/admin/users", requireReadyAccount, requireAdmin, (request, response) => {
  const rows = db.prepare(`SELECT users.id,users.username,users.role,users.quota_bytes,users.must_change_password,users.created_at,
    COALESCE((SELECT SUM(byte_size + preview_byte_size + thumbnail_byte_size + export_byte_size + working_byte_size) FROM photos WHERE photos.user_id=users.id),0) +
    COALESCE((SELECT SUM(byte_size) FROM luts WHERE luts.user_id=users.id),0) AS used_bytes
    FROM users ORDER BY role='admin' DESC, username COLLATE NOCASE`).all();
  response.json({ users: rows.map(row => ({ ...publicUser(row), usedBytes: row.used_bytes, createdAt: row.created_at })) });
});

app.post("/api/admin/users", requireReadyAccount, requireAdmin, (request, response) => {
  const username = String(request.body?.username || "").trim();
  const password = String(request.body?.password || "");
  if (!validUsername(username)) return response.status(400).json({ error: "Username must be 3–32 characters using letters, numbers, dots, dashes or underscores" });
  if (password.length < MIN_PASSWORD_LENGTH) return response.status(400).json({ error: `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  if (statements.userByName.get(username)) return response.status(409).json({ error: "That username is already in use" });
  const quotaBytes = parseQuotaBytes(request.body?.quotaBytes);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id,username,password_hash,role,quota_bytes,must_change_password,created_at,updated_at) VALUES (?,?,?,'user',?,1,?,?)")
    .run(id, username, passwordHash(password), quotaBytes, now, now);
  response.status(201).json({ user: publicUser(statements.userById.get(id)) });
});

app.patch("/api/admin/users/:id", requireReadyAccount, requireAdmin, (request, response) => {
  const target = statements.userById.get(request.params.id);
  if (!target) return response.status(404).json({ error: "Account not found" });
  const username = request.body?.username == null ? target.username : String(request.body.username).trim();
  const password = String(request.body?.password || "");
  if (!validUsername(username)) return response.status(400).json({ error: "Invalid username" });
  if (password && password.length < MIN_PASSWORD_LENGTH) return response.status(400).json({ error: `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  const conflict = statements.userByName.get(username);
  if (conflict && conflict.id !== target.id) return response.status(409).json({ error: "That username is already in use" });
  const quotaBytes = target.role === "admin" ? null : Object.prototype.hasOwnProperty.call(request.body || {}, "quotaBytes") ? parseQuotaBytes(request.body.quotaBytes) : target.quota_bytes;
  if (quotaBytes != null && quotaBytes < userUsage(target.id)) return response.status(400).json({ error: "The allowance cannot be lower than the account's current usage" });
  const resetPassword = password ? passwordHash(password) : target.password_hash;
  db.prepare("UPDATE users SET username=?,password_hash=?,quota_bytes=?,must_change_password=?,updated_at=? WHERE id=?")
    .run(username, resetPassword, quotaBytes, password ? 1 : target.must_change_password, new Date().toISOString(), target.id);
  if (password) db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(target.id, target.id === request.user.user_id ? request.sessionTokenHash : "");
  response.json({ user: publicUser(statements.userById.get(target.id)) });
});

app.delete("/api/admin/users/:id", requireReadyAccount, requireAdmin, asyncRoute(async (request, response) => {
  const target = statements.userById.get(request.params.id);
  if (!target) return response.status(404).json({ error: "Account not found" });
  if (target.id === request.user.user_id || target.role === "admin") return response.status(400).json({ error: "The administrator account cannot be removed" });
  db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  await fsp.rm(path.join(DATA_DIR, "users", target.id), { recursive: true, force: true });
  await fsp.rm(path.join(DATA_DIR, ".incoming", target.id), { recursive: true, force: true });
  response.json({ ok: true });
}));

// Keep the outer document alive while gallery, editor and settings navigate.
// Fullscreen therefore ends only when the user exits it, not on photo changes.
function sendLabShell(request, response, next) {
  if (request.query.labFrame === "1" || request.get("Sec-Fetch-Dest") === "iframe") return next();
  response.set("Cache-Control", "no-store").sendFile(path.join(PUBLIC_DIR, "lab-shell.html"));
}
app.get(["/", "/index.html", "/editor", "/settings", "/settings.html"], requireReadyAccount, sendLabShell);

app.get("/settings", requireReadyAccount, (_request, response) => response.sendFile(path.join(PUBLIC_DIR, "settings.html")));
app.get("/settings.js", requireReadyAccount, (_request, response) => response.sendFile(path.join(PUBLIC_DIR, "settings.js")));
app.use(requireReadyAccount);

app.get("/api/library", asyncRoute(async (_request, response) => {
  const counts = statements.countPhotos.get(_request.user.id);
  const usedBytes = userUsage(_request.user.id);
  let storage = null;
  try {
    const stats = await fsp.statfs(DATA_DIR);
    storage = { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch { /* Storage totals are optional. */ }
  response.json({ photos: counts.count, originalBytes: counts.bytes, usedBytes, quotaBytes: _request.user.quota_bytes, storage });
}));

function dateSelectionIds(userId, { start, end, unknown, sort, q = "" }) {
  const dateColumn = sort === "imported" ? "imported_at" : "COALESCE(captured_at, imported_at)";
  const params = [userId];
  let dateFilter;
  if (unknown === "1") dateFilter = `julianday(${dateColumn}) IS NULL`;
  else {
    const startTime = Date.parse(start), endTime = Date.parse(end);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || endTime - startTime > 27 * 3600000) {
      const error = new Error("Choose a valid gallery date"); error.status = 400; throw error;
    }
    dateFilter = `julianday(${dateColumn}) >= julianday(?) AND julianday(${dateColumn}) < julianday(?)`;
    params.push(new Date(startTime).toISOString(), new Date(endTime).toISOString());
  }
  const query = String(q).trim();
  const nameFilter = query ? " AND original_name LIKE ? ESCAPE '\\'" : "";
  if (query) params.push(`%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`);
  return db.prepare(`SELECT id FROM photos WHERE user_id = ? AND ${dateFilter}${nameFilter}`).all(...params).map(row => row.id);
}

app.get("/api/photo-date-selection", (request, response) => {
  response.json({ ids: dateSelectionIds(request.user.id, request.query) });
});

app.get("/api/photos", (request, response) => {
  const limit = Math.max(1, Math.min(120, Number(request.query.limit) || 60));
  const offset = Math.max(0, Number(request.query.offset) || 0);
  const query = String(request.query.q || "").trim();
  const sort = request.query.sort === "imported" ? "imported" : "captured";
  const order = sort === "imported"
    ? "imported_at DESC, id DESC"
    : "COALESCE(captured_at, imported_at) DESC, imported_at DESC, id DESC";
  const rows = query
    ? db.prepare(`SELECT * FROM photos WHERE user_id = ? AND original_name LIKE ? ESCAPE '\\' ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(request.user.id, `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`, limit, offset)
    : db.prepare(`SELECT * FROM photos WHERE user_id = ? ORDER BY ${order} LIMIT ? OFFSET ?`).all(request.user.id, limit, offset);
  const total = query
    ? db.prepare("SELECT COUNT(*) AS count FROM photos WHERE user_id = ? AND original_name LIKE ? ESCAPE '\\'").get(request.user.id, `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`).count
    : statements.countPhotos.get(request.user.id).count;
  response.json({ photos: rows.map(photoResponse), total, offset, limit, sort, hasMore: offset + rows.length < total });
});

app.post("/api/photos/download.zip", (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids.map(String))] : [];
    if (!ids.length) return response.status(400).json({ error: "No photos selected" });
    const rows = db.prepare(`SELECT * FROM photos WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY COALESCE(captured_at, imported_at) DESC, id DESC`)
      .all(request.user.id, JSON.stringify(ids));
    if (!rows.length) return response.status(404).json({ error: "No selected photos were found" });

    const archive = archiver("zip", { zlib: { level: 0 } });
    const usedNames = new Map();
    response.type("application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="OnDevice-Film-Lab-${rows.length}-photos.zip"`);
    response.setHeader("Cache-Control", "no-store");
    archive.on("warning", error => { if (error.code !== "ENOENT") console.warn("ZIP warning", error); });
    archive.on("error", error => response.destroy(error));
    archive.pipe(response);
    for (const row of rows) {
      const clean = path.basename(row.original_name).replace(/[^a-z0-9._' ()-]/gi, "_") || `${row.id}.jpg`;
      const count = usedNames.get(clean.toLowerCase()) || 0;
      usedNames.set(clean.toLowerCase(), count + 1);
      const parsed = path.parse(clean);
      const name = count ? `${parsed.name} (${count + 1})${parsed.ext}` : clean;
      archive.file(resolveDataPath(row.stored_path), { name });
    }
    void archive.finalize();
  } catch (error) { next(error); }
});

app.get("/api/photos/:id", (request, response) => {
  const row = statements.byId.get(request.user.id, request.params.id);
  if (!row) return response.status(404).json({ error: "Photo not found" });
  response.json({ photo: photoResponse(row) });
});

app.get("/api/photos/:id/filmstrip", (request, response) => {
  const rows = nearbyPhotos(request.user.id, request.params.id, request.query.limit);
  if (!rows.length) return response.status(404).json({ error: "Photo not found" });
  response.json({ photos: rows.map(photoResponse), total: rows[0].filmstrip_total });
});

function sendPhotoFile(column, download = false) {
  return (request, response, next) => {
    try {
      const row = statements.byId.get(request.user.id, request.params.id);
      if (!row || !row[column]) return response.status(404).json({ error: "Photo file not found" });
      const filename = resolveDataPath(row[column]);
      response.setHeader("Cache-Control", column === "stored_path" ? "private, max-age=3600" : "private, max-age=86400");
      if (download) return response.download(filename, row.export_name || `${path.parse(row.original_name).name}_FilmLab.jpg`);
      response.type(path.extname(filename)).sendFile(filename, error => { if (error) next(error); });
    } catch (error) { next(error); }
  };
}

app.get("/api/photos/:id/original", sendPhotoFile("stored_path"));
app.get("/api/photos/:id/working", sendPhotoFile("working_path"));
app.get("/api/photos/:id/preview", sendPhotoFile("preview_path"));
app.get("/api/photos/:id/thumbnail", sendPhotoFile("thumbnail_path"));
app.get("/api/photos/:id/export", sendPhotoFile("export_path", true));

app.post("/api/photos", quotaUploadGuard, upload.array("photos", 500), asyncRoute(async (request, response) => {
  const files = request.files || [];
  if (!files.length) return response.status(400).json({ error: "No photos were selected" });
  const imported = [];
  const duplicates = [];
  const errors = [];
  for (const file of files) {
    try {
      const earlyQuotaFailure = quotaError(request.user, file.size);
      if (earlyQuotaFailure) throw earlyQuotaFailure;
      const result = await importPhoto(file, request.user);
      (result.duplicate ? duplicates : imported).push(result.photo);
    } catch (error) {
      await removeIfPresent(file.path).catch(() => {});
      errors.push({ name: file.originalname, error: error.message, code: error.code || null, status: Number(error.status) || 400 });
    }
  }
  const succeeded = imported.length || duplicates.length;
  response.status(succeeded ? 201 : errors[0]?.status || 400).json({ imported, duplicates, errors, ...(succeeded ? {} : { error: errors[0]?.error || "No photos could be added" }) });
}));

app.patch("/api/photos/:id/edits", (request, response) => {
  const row = statements.byId.get(request.user.id, request.params.id);
  if (!row) return response.status(404).json({ error: "Photo not found" });
  const edits = request.body?.edits;
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return response.status(400).json({ error: "Invalid edits" });
  const encoded = JSON.stringify(edits);
  if (Buffer.byteLength(encoded) > 8_000_000) return response.status(413).json({ error: "Edit data is too large" });
  statements.updateEdits.run(encoded, request.user.id, row.id);
  response.json({ ok: true });
});

app.post("/api/photos/:id/edits-beacon", (request, response) => {
  const row = statements.byId.get(request.user.id, request.params.id);
  if (!row) return response.status(404).end();
  const edits = request.body?.edits;
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return response.status(400).end();
  const encoded = JSON.stringify(edits);
  if (Buffer.byteLength(encoded) > 8_000_000) return response.status(413).end();
  statements.updateEdits.run(encoded, request.user.id, row.id);
  response.status(204).end();
});

app.put("/api/photos/:id/export", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: `${Math.ceil(MAX_UPLOAD_BYTES / 1024 / 1024)}mb` }), asyncRoute(async (request, response) => {
  const row = statements.byId.get(request.user.id, request.params.id);
  if (!row) return response.status(404).json({ error: "Photo not found" });
  if (!Buffer.isBuffer(request.body) || request.body.length < 4 || request.body[0] !== 0xff || request.body[1] !== 0xd8) {
    return response.status(400).json({ error: "The processed file is not a JPEG" });
  }
  const outputName = String(request.get("X-FilmLab-Filename") || `${path.parse(row.original_name).name}_FilmLab.jpg`)
    .replace(/[^a-z0-9._' -]/gi, "_").slice(0, 240);
  const quotaFailure = quotaError(request.user, request.body.length, row.export_byte_size);
  if (quotaFailure) throw quotaFailure;
  const exportPath = path.join(userDirectories(request.user.id).exports, `${row.id}.jpg`);
  await fsp.writeFile(exportPath, request.body, { mode: 0o640 });
  statements.updateExport.run(relativeDataPath(exportPath), outputName, request.body.length, request.user.id, row.id);
  response.json({ ok: true, filename: outputName, url: `/api/photos/${row.id}/export` });
}));

app.delete("/api/photos", asyncRoute(async (request, response) => {
  const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids.map(String))] : [];
  if (!ids.length) return response.status(400).json({ error: "No photos selected" });
  response.json({ removed: await deletePhotoIds(ids, request.user.id) });
}));

app.get("/api/state/:key", (request, response) => {
  if (!/^[a-z0-9-]{1,40}$/i.test(request.params.key)) return response.status(400).json({ error: "Invalid state key" });
  const row = statements.getState.get(request.user.id, request.params.key);
  response.json({ value: row ? safeJson(row.value_json, null) : null, updatedAt: row?.updated_at || null });
});

app.put("/api/state/:key", (request, response) => {
  if (!/^[a-z0-9-]{1,40}$/i.test(request.params.key)) return response.status(400).json({ error: "Invalid state key" });
  const value = request.body?.value;
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > 500_000) return response.status(413).json({ error: "State is too large" });
  const updatedAt = new Date().toISOString();
  statements.setState.run(request.user.id, request.params.key, encoded, updatedAt);
  response.json({ ok: true, updatedAt });
});

app.get("/api/luts", (request, response) => response.json({ luts: statements.listLuts.all(request.user.id).map(lutResponse) }));

app.get("/api/luts/:id", (request, response, next) => {
  try {
    const row = statements.lutById.get(request.user.id, request.params.id);
    if (!row) return response.status(404).json({ error: "LUT not found" });
    response.type("text/plain").sendFile(resolveDataPath(row.stored_path), error => { if (error) next(error); });
  } catch (error) { next(error); }
});

app.post("/api/luts", quotaUploadGuard, upload.single("lut"), asyncRoute(async (request, response) => {
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
    const existing = statements.lutByHash.get(request.user.id, hash);
    if (existing) {
      await removeIfPresent(file.path);
      return response.json({ duplicate: true, lut: lutResponse(existing) });
    }
    const quotaFailure = quotaError(request.user, file.size);
    if (quotaFailure) throw quotaFailure;
    const id = crypto.randomUUID();
    const title = text.match(/^\s*TITLE\s+"([^"]+)"/im)?.[1]?.trim();
    const fileName = path.basename(file.originalname).slice(0, 180);
    const destination = path.join(userDirectories(request.user.id).luts, `${id}.cube`);
    await fsp.rename(file.path, destination);
    const row = {
      id,
      user_id: request.user.id,
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
  response.json({ user: publicUser(request.user), tailscaleUser: login ? { login, name: name || login } : null });
});

function createEditorHtml(userId = "server") {
  let html = fs.readFileSync(path.join(APP_ROOT, "index.html"), "utf8");
  const accountKey = String(userId).replace(/[^a-z0-9-]/gi, "");
  // Include the loading state in the response so it is present before scripts run.
  html = html.replace("</head>", `<style>
    .serverPhotoLoader{display:none}
    body.serverPhotoLoading .viewerShell{position:relative}
    body.serverPhotoLoading #viewer{visibility:hidden}
    body.serverPhotoLoading .serverPhotoLoader{display:flex;position:absolute;inset:0;z-index:30;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:var(--bg,#101722);color:var(--muted);font-size:14px}
    .serverPhotoSpinner{width:30px;height:30px;border:3px solid #40516a;border-top-color:var(--accent,#c7dbed);border-radius:50%;animation:serverPhotoSpin .8s linear infinite}
    @keyframes serverPhotoSpin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.serverPhotoSpinner{animation:none}}
  </style></head>`);
  html = html.replace("<body>", '<body class="serverPhotoLoading">');
  html = html.replace('<div class="viewerShell">', '<div class="viewerShell"><div class="serverPhotoLoader" role="status" aria-live="polite"><span class="serverPhotoSpinner" aria-hidden="true"></span><span>Loading photo…</span></div>');
  html = html.replace("    makePreview(i);\n  }", "    return makePreview(i);\n  }");
  html = html.replace("<script>\n(() => {", "<script>\nwindow.__FILMLAB_SERVER_MODE__=true;\n(() => {");
  const bridgeApi = `
  window.__FILMLAB_SERVER_EDITOR__={
    async loadPhoto(file,state,decoded=false){
      if(decoded)photoSources.set(file,{blob:file});
      await addFiles([file]);
      const index=items.length-1,item=items[index];
      if(!item)throw new Error("The photo could not be opened");
      if(state&&item){
        item.rotation=Number(state.rotation)||0;
        item.straighten=Number(state.straighten)||0;
        item.crop=state.crop||null;
        item.masks=JSON.parse(JSON.stringify(state.masks||[]));
        item.settings=state.settings
          ? {...cloneSettings(initialPhotoSettings),...cloneSettings(state.settings)}
          : cloneSettings(batchSettings);
        loadPhotoSettings(item.settings);
        refreshThumb(index);
      }
      await select(index);
    },
    canNavigate(){return !busy&&!cropOpen&&!straightenDragging&&!activeMask()},
    captureState(){return current>=0&&items[current]?{...storedStateFor(items[current]),isEdited:itemHasCustomEdits(items[current])}:null},
    setSinglePhotoMode(){editScope="photo";updateEditScopeUI()},
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
  html = html.replace('const LIBRARY_DB_NAME="ondevice-film-lab-library";', `const LIBRARY_DB_NAME="ondevice-film-lab-library-${accountKey}";`);
  html = html.replace('const SETTINGS_STORAGE_KEY="ondevice-film-lab-settings-v1";', `const SETTINGS_STORAGE_KEY="ondevice-film-lab-settings-v1-${accountKey}";`);
  html = html.replace('const CAMERA_PROFILE_STORAGE_KEY="ondevice-film-lab-camera-profiles-v1";', `const CAMERA_PROFILE_STORAGE_KEY="ondevice-film-lab-camera-profiles-v1-${accountKey}";`);
  html = html.replace("    const persisted=await persistImportedItems(added);", "    const persisted=true;");
  html = html.replace('if ("serviceWorker" in navigator && location.protocol !== "file:") {', 'if (false && "serviceWorker" in navigator && location.protocol !== "file:") {');
  html = html.replace("</body>", `<script>window.__FILMLAB_ACCOUNT_ID__=${JSON.stringify(accountKey)}</script><script src="/lab-editor.js?v=1.4.4"></script>\n</body>`);
  return html;
}

app.get("/editor", (request, response) => response.set("Cache-Control", "no-store").type("html").send(createEditorHtml(request.user.id)));
app.use("/branding", express.static(path.join(APP_ROOT, "branding"), { maxAge: "7d" }));
app.use("/icons", express.static(path.join(APP_ROOT, "icons"), { maxAge: "7d" }));
app.get("/manifest.webmanifest", (_request, response) => response.sendFile(path.join(APP_ROOT, "manifest.webmanifest")));
app.get("/photo-formats.js", (_request, response) => response.sendFile(path.join(APP_ROOT, "photo-formats.js")));
app.get("/photo-codecs.js", (_request, response) => response.sendFile(path.join(APP_ROOT, "photo-codecs.js")));
app.use("/codecs", express.static(path.join(APP_ROOT, "codecs"), { maxAge: 0 }));
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: 0 }));

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
  testApi: { DATA_DIR, STATE_DIR, DATABASE_PATH, statements, defaultAdmin, userDirectories, userUsage, quotaError, passwordHash, passwordMatches, importPhoto, deletePhotoIds, nearbyPhotos, createEditorHtml, hasSavedEdits, dateSelectionIds }
};
