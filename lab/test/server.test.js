"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ondevice-film-lab-test-"));
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ondevice-film-lab-state-test-"));
process.env.DATA_DIR = dataDirectory;
process.env.STATE_DIR = stateDirectory;
const { app, db, testApi } = require("../server");
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
  const nearby = testApi.nearbyPhotos(testApi.defaultAdmin.id, photoId, 9);
  assert.equal(nearby.length, 1);
  assert.equal(nearby[0].id, photoId);
  assert.equal(nearby[0].filmstrip_total, 1);
  const editor = testApi.createEditorHtml();
  assert.match(editor, /window\.__FILMLAB_SERVER_EDITOR__/);
  assert.match(editor, /window\.__FILMLAB_SERVER_MODE__=true/);
  assert.match(editor, /libraryRestorePromise=Promise\.resolve\(\)/);
  assert.match(editor, /setSinglePhotoMode/);
  assert.match(editor, /\/lab-editor\.js\?v=1\.4\.26/);
  assert.match(editor, /showAppDialog/);
  assert.match(editor, /\.thumbRemoveBtn/);
  assert.match(editor, /filmLabThumbRefresh/);
  assert.match(editor, /viewport-fit=cover/);
  assert.match(editor, /padding-top:max\(15px,var\(--lab-safe-area-top,env\(safe-area-inset-top,0px\)\)\)/);
  assert.match(editor, /<body class="serverPhotoLoading serverEdition">/);
  assert.match(editor, /<button id="zipBtn"[^>]*hidden/);
  assert.match(editor, /<button id="saveOneBtn"[^>]*>Download photo<\/button>/);
  assert.match(editor, /body\.serverEdition #zipBtn\{display:none!important\}/);
  assert.notEqual(testApi.createEditorHtml(testApi.defaultAdmin.id), testApi.createEditorHtml("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"));
});

test("Android requests bypass lab shell iframe wrapper", () => {
  let nextCalled = false;
  let sentFile = "";
  const mockReq = {
    query: {},
    get(header) {
      if (header.toLowerCase() === "user-agent") return "Mozilla/5.0 (Linux; Android 14; Pixel 8)";
      return "";
    }
  };
  const mockRes = {
    set() { return this; },
    sendFile(file) { sentFile = file; return this; }
  };
  testApi.sendLabShell(mockReq, mockRes, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(sentFile, "");

  // Desktop non-iframe request receives lab-shell.html
  let desktopNextCalled = false;
  let desktopSentFile = "";
  const desktopReq = {
    query: {},
    get() { return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"; }
  };
  const desktopRes = {
    set() { return this; },
    sendFile(file) { desktopSentFile = file; return this; }
  };
  testApi.sendLabShell(desktopReq, desktopRes, () => { desktopNextCalled = true; });
  assert.equal(desktopNextCalled, false);
  assert.match(desktopSentFile, /lab-shell\.html$/);
});

test("persists non-destructive edit state", async () => {
  testApi.statements.updateEdits.run(JSON.stringify({ rotation: 90, settings: { fade: "25" } }), testApi.defaultAdmin.id, photoId);
  let row = testApi.statements.byId.get(testApi.defaultAdmin.id, photoId);
  const edits = JSON.parse(row.edits_json);
  assert.equal(edits.rotation, 90);
  assert.equal(edits.settings.fade, "25");
  assert.equal(testApi.hasSavedEdits(row), true);
  testApi.statements.updateEdits.run(JSON.stringify({ rotation: 0, settings: {}, isEdited: false }), testApi.defaultAdmin.id, photoId);
  row = testApi.statements.byId.get(testApi.defaultAdmin.id, photoId);
  assert.equal(testApi.hasSavedEdits(row), false);
});

test("thumbnail URL includes cache-busting editRev and updatePhotoThumbnail updates thumbnail file on disk", async () => {
  testApi.statements.updateEdits.run("{}", testApi.defaultAdmin.id, photoId);
  let row = testApi.statements.byId.get(testApi.defaultAdmin.id, photoId);
  const uneditedThumbUrl = testApi.photoResponse(row).thumbnailUrl;
  assert.match(uneditedThumbUrl, /\/api\/photos\/[^/]+\/thumbnail\?v=0/);

  // Update with rotation
  const edits = { rotation: 90, straighten: 0, crop: null, settings: {}, isEdited: true };
  await testApi.updatePhotoThumbnail(row, edits);
  testApi.statements.updateEdits.run(JSON.stringify(edits), testApi.defaultAdmin.id, photoId);

  row = testApi.statements.byId.get(testApi.defaultAdmin.id, photoId);
  const editedThumbUrl = testApi.photoResponse(row).thumbnailUrl;
  assert.notEqual(editedThumbUrl, uneditedThumbUrl);
  assert.match(editedThumbUrl, /\/api\/photos\/[^/]+\/thumbnail\?v=[a-f0-9]{8}/);

  // Verify file on disk exists and was written
  const thumbPath = path.resolve(testApi.DATA_DIR, row.thumbnail_path);
  assert.ok(fs.existsSync(thumbPath));
  assert.ok(row.thumbnail_byte_size > 0);
});

test("filmLabThumbRefresh updates active filmstrip thumbnail and saveState includes thumbnail", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../public/lab-editor.js"), "utf8");
  const saveStart = source.indexOf("  let latestThumbDataUrl = null;");
  const saveEnd = source.indexOf("\n  function queueStateSave()", saveStart);
  assert.ok(saveStart > 0 && saveEnd > saveStart);

  let capturedPayload = null;
  const cards = [
    { dataset: { photoId: "photo-1" }, classList: { toggle() {} }, querySelector: sel => (sel === "img" ? cards[0].img : cards[0].rot) },
    { dataset: { photoId: "photo-2" }, classList: { toggle() {} }, querySelector: sel => (sel === "img" ? cards[1].img : cards[1].rot) }
  ];
  cards[0].img = { src: "original-thumb.jpg" };
  cards[0].rot = { textContent: "" };
  cards[1].img = { src: "other-thumb.jpg" };
  cards[1].rot = { textContent: "" };

  const thumbs = {
    querySelector: sel => {
      if (sel.includes("photo-1")) return cards[0];
      return null;
    }
  };

  let listener = null;
  const context = {
    photoId: "photo-1",
    lastPhotoState: "",
    serverFilmstripThumbs: thumbs,
    photo: { isEdited: true },
    window: {
      addEventListener: (type, handler) => {
        if (type === "filmLabThumbRefresh") listener = handler;
      }
    },
    bridge: {
      captureState: () => ({ rotation: 90, straighten: 0, crop: null, settings: {}, masks: [], isEdited: true })
    },
    requestJson: async (url, opts) => {
      capturedPayload = JSON.parse(opts.body);
    },
    deletedPhotoIds: new Set(),
    clearTimeout: () => {},
    setTimeout: () => 0
  };

  vm.runInNewContext(source.slice(saveStart, saveEnd), context);

  // Trigger filmLabThumbRefresh event
  assert.ok(listener);
  listener({ detail: { dataUrl: "data:image/jpeg;base64,mockthumb", rot: "90°", rotation: 90 } });

  assert.equal(cards[0].img.src, "data:image/jpeg;base64,mockthumb");
  assert.equal(cards[0].rot.textContent, "90°");

  // Run saveState()
  await context.saveState();
  assert.ok(capturedPayload);
  assert.equal(capturedPayload.edits.rotation, 90);
  assert.equal(capturedPayload.thumbnail, "data:image/jpeg;base64,mockthumb");
});

test("openServerPhoto navigates in-place using history.pushState and loads photo without full page reload", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../public/lab-editor.js"), "utf8");
  const openStart = source.indexOf("  async function openServerPhoto(");
  const openEnd = source.indexOf("\n  document.addEventListener(\"keydown\",", openStart);
  assert.ok(openStart > 0 && openEnd > openStart);

  let pushStateUrl = "";
  let loadedPhoto = null;
  let singlePhotoModeCalled = false;
  let loadingClassAdded = false;
  let loadingClassRemoved = false;
  const cards = [
    { dataset: { photoId: "photo-1" }, active: true, classList: { toggle(_cls, val) { cards[0].active = Boolean(val); } }, setAttribute() {}, querySelector: () => ({ textContent: "P1" }) },
    { dataset: { photoId: "photo-2" }, active: false, classList: { toggle(_cls, val) { cards[1].active = Boolean(val); } }, setAttribute() {}, querySelector: () => ({ textContent: "P2" }) }
  ];
  const thumbs = {
    querySelectorAll: () => cards,
    querySelector: () => ({ offsetLeft: 100, clientWidth: 50, offsetWidth: 50 }),
    scrollTo() {}
  };
  const context = {
    photoId: "photo-1",
    deletedPhotoIds: new Set(),
    openingPhoto: false,
    autosaveTimer: 0,
    clearTimeout: () => {},
    serverFilmstripThumbs: thumbs,
    cleanState: s => s,
    saveState: async () => {},
    notify() {},
    requestJson: async () => ({ photo: { id: "photo-2", name: "IMG_0002.JPG", editUrl: null, originalUrl: "/api/photos/photo-2/original" } }),
    fetch: async () => ({ ok: true, blob: async () => ({ type: "image/jpeg" }) }),
    File: class MockFile { constructor(parts, name, opts) { this.name = name; } },
    document: {
      title: "",
      body: {
        classList: {
          add: c => { if (c === "serverPhotoLoading") loadingClassAdded = true; },
          remove: c => { if (c === "serverPhotoLoading") loadingClassRemoved = true; }
        }
      }
    },
    history: {
      pushState: (_state, _title, url) => { pushStateUrl = url; }
    },
    bridge: {
      loadPhoto: async (file) => { loadedPhoto = file; },
      setSinglePhotoMode: () => { singlePhotoModeCalled = true; },
      captureState: () => ({ exposure: "10" })
    },
    loadServerFilmstrip: async () => {}
  };

  vm.runInNewContext(source.slice(openStart, openEnd), context);
  await context.openServerPhoto("photo-2");

  assert.equal(context.photoId, "photo-2");
  assert.equal(pushStateUrl, "/editor?photo=photo-2");
  assert.equal(loadedPhoto?.name, "IMG_0002.JPG");
  assert.equal(singlePhotoModeCalled, true);
  assert.equal(loadingClassAdded, true);
  assert.equal(loadingClassRemoved, true);
  assert.equal(cards[0].active, false);
  assert.equal(cards[1].active, true);
});

test("removeServerPhoto deletes photo and navigates to adjacent photo", async () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../public/lab-editor.js"), "utf8");
  const removeStart = source.indexOf("  async function removeServerPhoto(targetId) {");
  const removeEnd = source.indexOf("\n  document.addEventListener(\"keydown\",", removeStart);
  assert.ok(removeStart > 0 && removeEnd > removeStart);

  let deletedIds = null;
  let openedPhotoId = null;
  let notified = [];

  const context = {
    openingPhoto: false,
    photoId: "photo-1",
    nearbyPhotos: [
      { id: "photo-1", name: "P1.jpg" },
      { id: "photo-2", name: "P2.jpg" }
    ],
    notify: msg => notified.push(msg),
    requestJson: async (url, opts) => {
      deletedIds = JSON.parse(opts.body).ids;
      return { removed: 1 };
    },
    deletedPhotoIds: new Set(),
    openServerPhoto: async (id, pushHistory, savePrevious) => {
      openedPhotoId = id;
      assert.equal(savePrevious, false);
    },
    loadServerFilmstrip: async () => {},
    window: { location: { href: "" } }
  };

  vm.runInNewContext(source.slice(removeStart, removeEnd), context);
  await context.removeServerPhoto("photo-1");

  assert.deepEqual(deletedIds, ["photo-1"]);
  assert.equal(openedPhotoId, "photo-2");
  assert.ok(notified.includes("Photo removed"));
});

test("editor loads new photos with neutral settings and preserves saved edits", async () => {
  const html = testApi.createEditorHtml();
  const source = html.slice(html.indexOf("    async loadPhoto(file,state,decoded=false){"), html.indexOf("    captureState(){"));
  const batchSettings = { amount: "0", fade: "0", grainEnabled: false, dateStamp: false };
  const initialPhotoSettings = { amount: "50", fade: "30", grainEnabled: true, dateStamp: true };
  const maskState = { settings: { fade: "25" }, masks: [{ id: "mask", settings: { exposure: "40" }, strokes: [{ radius: .1, points: [{ x: .2, y: .3 }] }] }] };
  for (const state of [null, {}, { settings: { ...batchSettings, fade: "45" }, rotation: 90 }, maskState]) {
    const items = [];
    const bridge = vm.runInNewContext(`({${source}})`, {
      items, batchSettings, initialPhotoSettings, cloneSettings: settings => ({ ...settings }),
      async addFiles() { items.push({ settings: { ...batchSettings } }); },
      loadPhotoSettings() {}, refreshThumb() {}, select() {}
    });
    await bridge.loadPhoto({}, state);
    assert.deepEqual(JSON.parse(JSON.stringify(items[0].settings)), state?.settings ? { ...initialPhotoSettings, ...state.settings } : batchSettings);
    if (state?.rotation) assert.equal(items[0].rotation, state.rotation);
    assert.deepEqual(JSON.parse(JSON.stringify(items[0].masks||[])),state?.masks||[]);
  }
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

test("RAW imports preserve the original and account for the full working image", async () => {
  const original = require("./fixtures/dng")();
  const incoming = path.join(testApi.userDirectories(testApi.defaultAdmin.id).incoming, "sensor.upload");
  fs.writeFileSync(incoming, original);
  const before = testApi.userUsage(testApi.defaultAdmin.id);
  const result = await testApi.importPhoto({ path: incoming, originalname: "sensor.DNG", mimetype: "application/octet-stream", size: original.length }, testApi.defaultAdmin);
  assert.equal(result.photo.isRaw, true);
  assert.equal(result.photo.editUrl, `/api/photos/${result.photo.id}/working`);
  const row = testApi.statements.byId.get(testApi.defaultAdmin.id, result.photo.id);
  assert.equal(row.width, 128); assert.equal(row.height, 96);
  assert.deepEqual(fs.readFileSync(path.join(dataDirectory, row.stored_path)), original);
  assert.ok(row.working_byte_size > 0);
  assert.equal(testApi.userUsage(testApi.defaultAdmin.id) - before, row.byte_size + row.preview_byte_size + row.thumbnail_byte_size + row.working_byte_size);
  const working = path.join(dataDirectory, row.working_path);
  assert.ok(fs.existsSync(working));
  await testApi.deletePhotoIds([result.photo.id], testApi.defaultAdmin.id);
  assert.equal(fs.existsSync(working), false);
  assert.equal(testApi.userUsage(testApi.defaultAdmin.id), before);
});

test("date selection includes unloaded photos, respects local day boundaries, search and account", () => {
  const insert = db.prepare(`INSERT INTO photos (id,user_id,content_hash,original_name,stored_path,preview_path,thumbnail_path,mime_type,byte_size,width,height,captured_at,imported_at)
    VALUES (?,?,?,?,'unused','unused','unused','image/jpeg',0,1,1,?,?)`);
  const userId = testApi.defaultAdmin.id;
  const add = (id, captured, imported = "2026-03-10T04:00:00.000Z", owner = userId, name = "trip.jpg") => insert.run(id,owner,id,name,captured,imported);
  db.exec("SAVEPOINT date_test");
  try {
    // New York's spring-forward date is 23 hours, including both exact edges.
    const range = {start:"2026-03-08T05:00:00.000Z",end:"2026-03-09T04:00:00.000Z",sort:"captured"};
    for(let i=0;i<130;i++) add(`day-${i}`,range.start);
    add("last", "2026-03-09T03:59:59.999Z");
    add("before", "2026-03-08T04:59:59.999Z");
    add("after", range.end);
    add("other-user",range.start,undefined,member.id);
    add("search",range.start,undefined,userId,"100%_trip.jpg");
    add("fallback",null,range.start);
    const ids = testApi.dateSelectionIds(userId,range);
    assert.equal(ids.length,133);
    assert.ok(ids.includes("day-129"));assert.ok(ids.includes("last"));assert.ok(ids.includes("fallback"));
    assert.ok(!ids.includes("before"));assert.ok(!ids.includes("after"));assert.ok(!ids.includes("other-user"));
    assert.deepEqual(testApi.dateSelectionIds(userId,{...range,q:"100%_"}),["search"]);
    assert.deepEqual(testApi.dateSelectionIds(userId,{...range,sort:"imported"}),["fallback"]);
    assert.throws(()=>testApi.dateSelectionIds(userId,{start:"bad",end:range.end}),/valid gallery date/);
  } finally {db.exec("ROLLBACK TO date_test; RELEASE date_test");}
});

test("offline gallery supports sorting by date taken and date uploaded with day grouping", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  assert.match(html, /<select id="gallerySortSelect"/);
  assert.match(html, /<option value="captured">Date taken<\/option>/);
  assert.match(html, /<option value="imported">Date uploaded<\/option>/);
  assert.match(html, /\.dateGroupHeader/);
  assert.match(html, /\.dateGroupSelect/);
  assert.match(html, /id="galleryDownloadZipBtn"/);
  assert.match(html, /\.galleryDownloadZipBtn/);
  assert.match(html, /downloadGallerySelectionZip/);

  const dateGroupStart = html.indexOf("  function dateGroup(value){");
  const dateGroupEnd = html.indexOf("\n  function toggleDateGroup", dateGroupStart);
  assert.ok(dateGroupStart > 0 && dateGroupEnd > dateGroupStart);

  const context = {
    Intl,
    Date
  };
  vm.runInNewContext(html.slice(dateGroupStart, dateGroupEnd), context);

  const now = new Date();
  const todayGroup = context.dateGroup(now);
  assert.equal(todayGroup.label, "Today");

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
  const yesterdayGroup = context.dateGroup(yesterday);
  assert.equal(yesterdayGroup.label, "Yesterday");

  const older = new Date(2023, 4, 15, 12, 0, 0);
  const olderGroup = context.dateGroup(older);
  assert.match(olderGroup.label, /May 15, 2023/);

  const themeCss = fs.readFileSync(path.resolve(__dirname, "../../theme.css"), "utf8");
  assert.match(themeCss, /html\[data-theme="black"\]\s*:is\([^)]*\.galleryRemoveBtn[^)]*\):not\(:disabled\)\s*\{[^}]*background(-color)?:\s*#e03131/);
});

test("unauthenticated and expired session requests to / redirect to /login without 500 error", () => {
  assert.ok(testApi.statements.sessionByToken);
  assert.ok(testApi.statements.userByName);

  let redirectedTo = "";
  const mockRes = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    set(k, v) { return this.setHeader(k, v); },
    status() { return this; },
    redirect(url) { redirectedTo = url; }
  };

  const req = {
    method: "GET",
    url: "/",
    headers: { cookie: "film_lab_session=invalid_token" },
    query: {},
    get(h) { return this.headers[h.toLowerCase()] || ""; }
  };
  app.handle(req, mockRes);
  assert.equal(redirectedTo, "/login");
});

test.after(() => {
  db.close();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
});
