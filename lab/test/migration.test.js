"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

test("migrates a single-user library to the administrator account", () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "film-lab-migration-data-"));
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "film-lab-migration-state-"));
  const databasePath = path.join(stateDirectory, "film-lab.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE photos (id TEXT PRIMARY KEY,content_hash TEXT NOT NULL UNIQUE,original_name TEXT NOT NULL,stored_path TEXT NOT NULL,preview_path TEXT NOT NULL,thumbnail_path TEXT NOT NULL,export_path TEXT,export_name TEXT,mime_type TEXT NOT NULL,byte_size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,captured_at TEXT,imported_at TEXT NOT NULL,edits_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE app_state (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE luts (id TEXT PRIMARY KEY,content_hash TEXT NOT NULL UNIQUE,name TEXT NOT NULL,file_name TEXT NOT NULL,stored_path TEXT NOT NULL,byte_size INTEGER NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO photos VALUES ('legacy-photo','hash','old.jpg','originals/old.jpg','previews/old.jpg','thumbnails/old.jpg',NULL,NULL,'image/jpeg',100,10,10,NULL,'2026-01-01T00:00:00.000Z','{}');
    INSERT INTO app_state VALUES ('camera-profiles','{}','2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const serverPath = path.resolve(__dirname, "../server.js");
  const result = spawnSync(process.execPath, ["-e", `const {db}=require(${JSON.stringify(serverPath)});db.close()`], { env: { ...process.env, DATA_DIR: dataDirectory, STATE_DIR: stateDirectory }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const migrated = new Database(databasePath);
  const admin = migrated.prepare("SELECT * FROM users WHERE role='admin'").get();
  assert.ok(admin);
  assert.equal(migrated.prepare("SELECT user_id FROM photos WHERE id='legacy-photo'").get().user_id, admin.id);
  assert.equal(migrated.prepare("SELECT user_id FROM app_state WHERE key='camera-profiles'").get().user_id, admin.id);
  assert.ok(migrated.prepare("PRAGMA table_info(photos)").all().some(column => column.name === "export_byte_size"));
  migrated.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
});
