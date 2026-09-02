"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ondevice-film-lab-test-"));
process.env.DATA_DIR = dataDirectory;
const { db, testApi } = require("../server");
const logoPath = path.resolve(__dirname, "../../branding/ondevice-film-lab-logo-v4.png");
let photoId = "";

async function uploadFixture(name = "logo.png") {
  const incoming = path.join(testApi.directories.incoming, `${Date.now()}-${Math.random()}.upload`);
  fs.copyFileSync(logoPath, incoming);
  return testApi.importPhoto({ path: incoming, originalname: name, mimetype: "image/png", size: fs.statSync(incoming).size });
}

test("starts with an empty library", () => {
  assert.equal(testApi.statements.countPhotos.get().count, 0);
});

test("imports a photo, generates derivatives, and detects a duplicate", async () => {
  const result = await uploadFixture();
  assert.equal(result.duplicate, false);
  photoId = result.photo.id;
  assert.ok(photoId);
  const row = testApi.statements.byId.get(photoId);
  assert.ok(fs.existsSync(path.join(dataDirectory, row.thumbnail_path)));
  assert.ok(fs.existsSync(path.join(dataDirectory, row.preview_path)));
  const duplicate = await uploadFixture("same-pixels-new-name.png");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.photo.id, photoId);
});

test("lists photos and injects the shared editor bridge", async () => {
  assert.equal(testApi.statements.countPhotos.get().count, 1);
  const editor = testApi.createEditorHtml();
  assert.match(editor, /window\.__FILMLAB_SERVER_EDITOR__/);
  assert.match(editor, /libraryRestorePromise=Promise\.resolve\(\)/);
  assert.match(editor, /\/lab-editor\.js/);
});

test("persists non-destructive edit state", async () => {
  testApi.statements.updateEdits.run(JSON.stringify({ rotation: 90, settings: { fade: "25" } }), photoId);
  const edits = JSON.parse(testApi.statements.byId.get(photoId).edits_json);
  assert.equal(edits.rotation, 90);
  assert.equal(edits.settings.fade, "25");
});

test("stores shared profile state", async () => {
  const value = { activeId: "cam1-default", profiles: [{ id: "cam1-default", name: "Cam1 Profile", settings: {} }] };
  testApi.statements.setState.run("camera-profiles", JSON.stringify(value), new Date().toISOString());
  const state = JSON.parse(testApi.statements.getState.get("camera-profiles").value_json);
  assert.deepEqual(state, value);
});

test("removes selected photos and their files", async () => {
  const result = await testApi.deletePhotoIds([photoId]);
  assert.equal(result, 1);
  assert.equal(testApi.statements.byId.get(photoId), undefined);
  assert.equal(testApi.statements.countPhotos.get().count, 0);
});

test.after(() => {
  db.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});
