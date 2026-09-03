"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
const slice = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const plain = value => JSON.parse(JSON.stringify(value));

function editor({ server = false, saved = null, batch = {} } = {}) {
  const els = {};
  for (const match of html.matchAll(/<(input|select)\b([^>]+)>/g)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (!attributes.id) continue;
    const control = { ...attributes, tagName: match[1].toUpperCase(), checked: /\bchecked\b/.test(match[2]) };
    if (match[1] === "select") {
      const markup = html.slice(match.index + match[0].length).split("</select>")[0];
      control.options = [...markup.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map(m => ({ value: m[1], selected: /selected/.test(m[2]) }));
      control.value = (control.options.find(option => option.selected) || control.options[0])?.value || "";
    }
    els[attributes.id] = control;
  }
  const colorSettingControls = [];
  for (const [prefix, names] of [["colorMix", ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]], ["colorGrade", ["Shadows", "Midtones", "Highlights"]]]) {
    for (const name of names) for (const component of ["Hue", "Saturation", "Luminance"]) {
      const id = prefix + name + component;
      const control = { id, tagName: "INPUT", type: "range", value: "0", min: "-100", max: "360" };
      els[id] = control;
      colorSettingControls.push(control);
    }
  }
  els.profileSelect = { children: [], set innerHTML(_) { this.children = []; }, appendChild(option) { this.children.push(option); } };
  els.undoEditsBtn = {}; els.redoEditsBtn = {};
  const storage = new Map(saved ? [["ondevice-film-lab-camera-profiles-v1", JSON.stringify(saved)]] : []);
  const context = vm.createContext({
    els, colorSettingControls, colorSettingDefaults: Object.fromEntries(colorSettingControls.map(control => [control.id, "0"])),
    window: { __FILMLAB_SERVER_MODE__: server }, console,
    document: { createElement: () => ({}) },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    cameraProfiles: [], activeCameraProfileId: "", batchSettings: {}, items: [], current: -1, editScope: "all", busy: false,
    activeMask: () => null, updateMaskUI: () => {}, activeMaskId: null,
    undoStack: [], redoStack: [], activeHistoryControls: new Set(), HISTORY_LIMIT: 50,
    cropIsFull: crop => !crop, cropsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    normalizedCrop: crop => crop, accepted: {}, persisted: [], settingsSaves: 0,
    rememberRangeValue(control) { context.accepted[control.id] = control.value; },
    scheduleLibraryState(item) { context.persisted.push(item.libraryId); },
    scheduleAllLibraryStates() { context.persisted.push(...context.items.map(item => item.libraryId)); },
    saveSettings() { context.settingsSaves++; }
  });
  for (const name of ["updateSliderLabels", "updateGrainUI", "updateStampUI", "updateLutUI", "updateProfileUI", "refreshSettingUI", "updateEditScopeUI", "updateThumbCustomBadge", "updateAllCustomBadges", "updateHistoryButtons", "updateButtons", "refreshThumb", "rerender", "makePreview", "showStraightenGrid", "closeEditScopeMenu", "setStatus"]) context[name] = () => {};
  vm.runInContext(slice("  const photoSettingControls=", "  function itemHasCustomEdits("), context);
  context.batchSettings = { ...vm.runInContext("capturePhotoSettings()", context), ...batch };
  vm.runInContext(slice("  const CAMERA_PROFILE_STORAGE_KEY=", "  function updateProfileUI("), context);
  vm.runInContext(slice("  function captureEditHistoryState(", "  const supported ="), context);
  vm.runInContext(slice("  function commitPhotoControl(", '  document.querySelectorAll(".sectionResetButton")'), context);
  const api = vm.runInContext("({restoreCameraProfiles,resetSettingsSection,loadPhotoSettings,capturePhotoSettings,undoEdits,redoEdits,neutralPhotoSettings,initialPhotoSettings,photoSettingControls,isBuiltInProfile})", context);
  return { ...api, context, els, storage, section: (...ids) => ({ contains: control => ids.includes(control.id) }) };
}

test("newcam is neutral with valid zero values for every edit slider; web keeps Cam1", () => {
  const api = editor();
  api.restoreCameraProfiles();
  assert.equal(api.context.activeCameraProfileId, "cam1-default");
  assert.equal(api.context.batchSettings.amount, "50");
  const profile = api.context.cameraProfiles.find(profile => profile.name === "newcam");
  for (const control of api.photoSettingControls) {
    if (control.type === "range") {
      assert.equal(profile.settings[control.id], "0", control.id);
      assert.ok(+control.min <= 0 && +control.max >= 0, control.id);
    }
  }
  assert.equal(profile.settings.grainEnabled, false);
  assert.equal(profile.settings.dateStamp, false);
  assert.equal(profile.settings.lutSelect, "none");
  assert.equal(api.els.profileSelect.children.find(option => option.value === "cam1-default").textContent, "Cam1 Profile (Default)");
  assert.equal(api.els.profileSelect.children.find(option => option.value === "newcam-default").textContent, "newcam");
});

test("Lab installs newcam as default without overwriting existing profiles or photo edits", () => {
  const saved = { activeId: "cam1-default", profiles: [{ id: "cam1-default", name: "Cam1 Profile", settings: { fade: "64", amount: "85" } }] };
  for (const previous of [null, saved]) {
    const api = editor({ server: true, saved: previous, batch: { exposure: "60" } });
    const oldPhoto = { libraryId: "old", settings: { exposure: "70", fade: "35" } };
    api.context.items.push(oldPhoto);
    api.restoreCameraProfiles();
    assert.equal(api.context.activeCameraProfileId, "newcam-default");
    assert.deepEqual(plain(api.context.batchSettings), plain(api.neutralPhotoSettings));
    assert.deepEqual(plain(api.capturePhotoSettings()), plain(api.neutralPhotoSettings));
    assert.deepEqual(oldPhoto.settings, { exposure: "70", fade: "35" });
    if (previous) assert.equal(api.context.cameraProfiles.find(profile => profile.id === "cam1-default").settings.fade, "64");
    assert.equal(api.els.profileSelect.children.find(option => option.value === "newcam-default").textContent, "newcam (Default)");
  }
});

test("profile migration is repeatable and retains subsequent profile choices and web settings", () => {
  const first = editor({ server: true });
  first.restoreCameraProfiles();
  const saved = JSON.parse(first.storage.get("ondevice-film-lab-camera-profiles-v1"));
  saved.activeId = "cam1-default";
  for (const server of [true, false]) {
    const api = editor({ server, saved, batch: { exposure: "42" } });
    api.restoreCameraProfiles();
    api.restoreCameraProfiles();
    assert.equal(api.context.activeCameraProfileId, "cam1-default");
    assert.equal(api.context.cameraProfiles.length, 2);
    assert.equal(api.isBuiltInProfile("newcam-default"), true);
    assert.equal(api.isBuiltInProfile("cam1-default"), true);
    if (!server) assert.equal(api.context.batchSettings.exposure, "42");
  }
});

test("section reset affects only this photo and supports one-step undo/redo and persistence", () => {
  const api = editor({ server: true });
  const before = { ...api.initialPhotoSettings, exposure: "35", contrast: "20", fade: "61" };
  api.context.items = [
    { libraryId: "one", settings: { ...before }, rotation: 90, straighten: 2, crop: { x: 0, y: 0, w: .5, h: .5 } },
    { libraryId: "two", settings: { ...before }, rotation: 0, straighten: 0, crop: null }
  ];
  api.context.current = 0;
  api.context.editScope = "photo";
  api.loadPhotoSettings(before);
  api.resetSettingsSection(api.section("exposure", "contrast"));
  assert.equal(api.context.items[0].settings.exposure, "0");
  assert.equal(api.context.items[0].settings.contrast, "0");
  assert.equal(api.context.items[0].settings.fade, "61");
  assert.equal(api.context.items[1].settings.exposure, "35");
  assert.equal(api.context.items[0].rotation, 90);
  assert.equal(api.context.undoStack.length, 1);
  assert.ok(api.context.persisted.includes("one"));
  assert.ok(!api.context.persisted.includes("two"));
  assert.equal(api.context.accepted.exposure, "0");
  api.undoEdits();
  assert.deepEqual(plain(api.context.items[0].settings), plain(before));
  api.redoEdits();
  assert.equal(api.context.items[0].settings.exposure, "0");
});

test("all-photo reset clears per-photo overrides even when shared controls already show zero", () => {
  const api = editor();
  api.context.items = [{ libraryId: "one", settings: { ...api.initialPhotoSettings, exposure: "45" } }, { libraryId: "two", settings: { ...api.initialPhotoSettings, contrast: "30" } }];
  api.resetSettingsSection(api.section("exposure", "contrast"));
  for (const item of api.context.items) {
    assert.equal(item.settings.exposure, "0");
    assert.equal(item.settings.contrast, "0");
    assert.equal(item.settings.amount, "50");
  }
  assert.equal(api.context.undoStack.length, 1);
});

test("individual color reset stays local; export reset restores usable defaults; busy blocks reset", () => {
  const api = editor();
  api.els.colorMixRedHue.value = "40";
  api.els.colorMixBlueHue.value = "60";
  api.resetSettingsSection(api.section("colorMixRedHue", "colorMixRedSaturation", "colorMixRedLuminance"));
  assert.equal(api.els.colorMixRedHue.value, "0");
  assert.equal(api.els.colorMixBlueHue.value, "60");
  api.els.quality.value = "75";
  api.els.dateRename.checked = false;
  api.resetSettingsSection(api.section("quality", "dateRename"));
  assert.equal(api.els.quality.value, "95");
  assert.equal(api.els.dateRename.checked, true);
  assert.equal(api.context.undoStack.length, 1);
  api.context.busy = true;
  api.resetSettingsSection(api.section("colorMixBlueHue"));
  assert.equal(api.els.colorMixBlueHue.value, "60");
});

test("neutral profile bypasses every effect in the shared preview/export pipeline", async () => {
  const api = editor();
  const settings = api.neutralPhotoSettings;
  const config = slice("  const colorMixChannels=", "  const colorSettingControls=");
  const source = slice("  function processCanvas(", "  function setComparePosition(");
  const functions = ["applyChromaNoiseReduction", "applyBasicAdjustments", "applyColorAdjustments", "applyColorLut", "applyChromaticAberration", "applyFade", "applyLightLeaks", "applyHalation", "applyBloom", "applyGrain", "applyDateStamp"];
  const effects = vm.runInNewContext(`${config}\n${source}\n({${functions.join(",")}})`, {
    customLuts: new Map(),
    settingValue: (settings, id) => settings[id], settingNumber: (settings, id) => +settings[id]
  });
  const canvas = { getContext() { throw new Error("Neutral edits must not read or change pixels"); } };
  for (const name of functions) {
    const args = name === "applyChromaNoiseReduction" ? [canvas, 1, settings]
      : name === "applyGrain" ? [canvas, {}, 1, settings]
      : ["applyLightLeaks", "applyDateStamp"].includes(name) ? [canvas, {}, settings]
      : [canvas, settings];
    assert.equal(await effects[name](...args), canvas, name);
  }
});
