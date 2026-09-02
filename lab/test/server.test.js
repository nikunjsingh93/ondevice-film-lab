"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ondevice-film-lab-test-"));
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ondevice-film-lab-state-test-"));
process.env.DATA_DIR = dataDirectory;
process.env.STATE_DIR = stateDirectory;
const { db, testApi } = require("../server");
const logoPath = path.resolve(__dirname, "../../branding/ondevice-film-lab-logo-v4.png");
let photoId = "";
let member = null;
let memberPhotoId = "";

async function uploadFixture(name = "logo.png", user = testApi.defaultAdmin) {
  const incoming = path.join(testApi.userDirectories(user.id).incoming, `${Date.now()}-${Math.random()}.upload`);
  fs.copyFileSync(logoPath, incoming);
  return testApi.importPhoto({ path: incoming, originalname: name, mimetype: "image/png", size: fs.statSync(incoming).size }, user);
}

test("starts with an empty library", () => {
  assert.equal(testApi.statements.countPhotos.get(testApi.defaultAdmin.id).count, 0);
  assert.equal(testApi.DATABASE_PATH, path.join(stateDirectory, "film-lab.db"));
  assert.ok(fs.existsSync(testApi.DATABASE_PATH));
});

test("imports a photo, generates derivatives, and detects a duplicate", async () => {
  const result = await uploadFixture();
  assert.equal(result.duplicate, false);
  photoId = result.photo.id;
  assert.ok(photoId);
  const row = testApi.statements.byId.get(testApi.defaultAdmin.id, photoId);
  assert.ok(fs.existsSync(path.join(dataDirectory, row.thumbnail_path)));
  assert.ok(fs.existsSync(path.join(dataDirectory, row.preview_path)));
  const duplicate = await uploadFixture("same-pixels-new-name.png");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.photo.id, photoId);
});

test("lists photos and injects the shared editor bridge", async () => {
  assert.equal(testApi.statements.countPhotos.get(testApi.defaultAdmin.id).count, 1);
  const editor = testApi.createEditorHtml();
  assert.match(editor, /window\.__FILMLAB_SERVER_EDITOR__/);
  assert.match(editor, /libraryRestorePromise=Promise\.resolve\(\)/);
  assert.match(editor, /\/lab-editor\.js/);
  assert.notEqual(testApi.createEditorHtml(testApi.defaultAdmin.id), testApi.createEditorHtml("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"));
});

test("persists non-destructive edit state", async () => {
  testApi.statements.updateEdits.run(JSON.stringify({ rotation: 90, settings: { fade: "25" } }), testApi.defaultAdmin.id, photoId);
  const edits = JSON.parse(testApi.statements.byId.get(testApi.defaultAdmin.id, photoId).edits_json);
  assert.equal(edits.rotation, 90);
  assert.equal(edits.settings.fade, "25");
});

test("stores shared profile state", async () => {
  const value = { activeId: "cam1-default", profiles: [{ id: "cam1-default", name: "Cam1 Profile", settings: {} }] };
  testApi.statements.setState.run(testApi.defaultAdmin.id, "camera-profiles", JSON.stringify(value), new Date().toISOString());
  const state = JSON.parse(testApi.statements.getState.get(testApi.defaultAdmin.id, "camera-profiles").value_json);
  assert.deepEqual(state, value);
});

test("stores passwords with scrypt and verifies them safely", () => {
  const encoded = testApi.passwordHash("correct-horse-battery");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(testApi.passwordMatches("correct-horse-battery", encoded), true);
  assert.equal(testApi.passwordMatches("wrong-password", encoded), false);
});

test("isolates member photos, duplicate detection and storage usage", async () => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id,username,password_hash,role,quota_bytes,must_change_password,created_at,updated_at) VALUES (?,?,?,'user',?,1,?,?)")
    .run(id, "member", testApi.passwordHash("temporary-pass"), 100 * 1024 * 1024, now, now);
  member = testApi.statements.userById.get(id);
  const imported = await uploadFixture("same-photo-private-copy.png", member);
  assert.equal(imported.duplicate, false);
  memberPhotoId = imported.photo.id;
  assert.equal(testApi.statements.countPhotos.get(member.id).count, 1);
  assert.equal(testApi.statements.countPhotos.get(testApi.defaultAdmin.id).count, 1);
  assert.equal(testApi.statements.byId.get(member.id, photoId), undefined);
  assert.equal(testApi.statements.getState.get(member.id, "camera-profiles"), undefined);
  assert.ok(testApi.userUsage(member.id) > 0);
  assert.equal(testApi.quotaError(member, 200 * 1024 * 1024).code, "QUOTA_EXCEEDED");
});

test("removes selected photos and their files", async () => {
  const result = await testApi.deletePhotoIds([photoId], testApi.defaultAdmin.id);
  assert.equal(result, 1);
  assert.equal(testApi.statements.byId.get(testApi.defaultAdmin.id, photoId), undefined);
  assert.equal(testApi.statements.countPhotos.get(testApi.defaultAdmin.id).count, 0);
  assert.equal(await testApi.deletePhotoIds([memberPhotoId], member.id), 1);
});

test.after(() => {
  db.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
});
