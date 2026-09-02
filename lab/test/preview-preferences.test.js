"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
const gestureSource = html.slice(html.indexOf("  function wireHoldPreview("), html.indexOf("  function applyPreviewZoom("));

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, values = {}) {
    const event = { type, button: 0, pointerId: 1, isPrimary: true, clientX: 20, clientY: 20, preventDefault() {}, ...values };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

function harness() {
  const viewer = new Events(), document = new Events(), window = new Events();
  const classes = new Set(), timers = new Map();
  let enabled = true, blocked = false, nextTimer = 1;
  const box = {
    isConnected: true,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    closest: selector => selector === ".compareBox" ? box : null,
    matches: selector => selector === ".compareBox"
  };
  const wire = vm.runInNewContext(`(${gestureSource.trim()})`, {
    document, window,
    setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const reset = wire(viewer, () => enabled, () => blocked);
  return {
    viewer, document, window, box, reset,
    down: values => viewer.emit("pointerdown", { target: box, ...values }),
    tick: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
    showing: () => classes.has("showingOriginal"),
    enabled: value => { enabled = value; }, blocked: value => { blocked = value; }
  };
}

test("web app inline scripts compile and preview preference is not a photo edit", () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const photoControls = html.slice(html.indexOf("const photoSettingControls="), html.indexOf("const globalSettingControls="));
  assert.doesNotMatch(photoControls, /holdOriginal/);
  assert.match(html, /globalSettingControls=\[els\.quality,els\.dateRename,els\.holdOriginal\]/);
});

for (const pointerType of ["mouse", "touch", "pen"]) {
  test(`${pointerType}: reveals only after holding and returns to edited on release`, () => {
    const h = harness();
    h.down({ pointerType });
    assert.equal(h.showing(), false);
    h.tick();
    assert.equal(h.showing(), true);
    h.document.emit("pointerup");
    assert.equal(h.showing(), false);
  });
}

test("quick tap, panning, multi-touch, and crop interaction do not reveal original", () => {
  const h = harness();
  h.down(); h.document.emit("pointerup"); h.tick(); assert.equal(h.showing(), false);
  h.down(); h.document.emit("pointermove", { clientX: 45 }); h.tick(); assert.equal(h.showing(), false);
  h.down(); h.down({ pointerId: 2, isPrimary: false }); h.tick(); assert.equal(h.showing(), false);
  h.blocked(true); h.down(); h.tick(); assert.equal(h.showing(), false);
  h.blocked(false); h.enabled(false); h.down(); h.tick(); assert.equal(h.showing(), false);
});

test("cancellation, leaving preview, window blur, and replacement restore edited", () => {
  const h = harness();
  for (const cancel of [
    () => h.document.emit("pointercancel"),
    () => h.viewer.emit("pointerleave"),
    () => h.viewer.emit("lostpointercapture"),
    () => h.window.emit("blur"),
    () => h.reset()
  ]) {
    h.down(); h.tick(); assert.equal(h.showing(), true);
    cancel(); assert.equal(h.showing(), false);
  }
  h.down(); h.box.isConnected = false; h.tick(); assert.equal(h.showing(), false);
});

test("keyboard users can hold Space to compare", () => {
  const h = harness();
  h.viewer.emit("keydown", { code: "Space", target: h.box });
  assert.equal(h.showing(), true);
  h.viewer.emit("keyup", { code: "Space", target: h.box });
  assert.equal(h.showing(), false);
});
