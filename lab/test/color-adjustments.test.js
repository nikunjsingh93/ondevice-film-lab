"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
const config = html.slice(html.indexOf("  const colorMixChannels="), html.indexOf("  const colorSettingControls="));
const math = html.slice(html.indexOf("  function colorSettingNumber("), html.indexOf("  function applyColorLut("));
const clamp01 = value => Math.max(0, Math.min(1, value));
const smoothStep = (a, b, value) => { const t = clamp01((value - a) / (b - a)); return t * t * (3 - 2 * t); };
const colors = vm.runInNewContext(`${config}\n${math}\n({applyColorAdjustments,createColorMixTable,hslChannel,colorMixChannels,colorGradeRanges})`, {
  clamp01, smoothStep, settingValue: (settings, id) => settings?.[id] ?? 0
});

function process(pixels, settings = {}) {
  const data = new Uint8ClampedArray(pixels);
  let reads = 0, writes = 0;
  const canvas = { width: data.length / 4, height: 1, getContext() { return {
    getImageData() { reads++; return { data }; }, putImageData() { writes++; }
  }; } };
  assert.equal(colors.applyColorAdjustments(canvas, settings), canvas);
  return { data: Array.from(data), reads, writes };
}
const rgb = (h, s = .7, l = .5) => [0, 8, 4].map(offset => Math.round(colors.hslChannel(h, s, l, offset) * 255)).concat(127);
const luma = pixel => .2126 * pixel[0] + .7152 * pixel[1] + .0722 * pixel[2];

test("zero color controls and grading hue alone are exact no-ops without canvas reads", () => {
  const input = [0, 0, 0, 0, 49, 86, 113, 127, 255, 255, 255, 255];
  for (const settings of [{}, { colorGradeShadowsHue: "220" }, { colorMixRedHue: "NaN" }]) {
    assert.deepEqual(process(input, settings), { data: input, reads: 0, writes: 0 });
  }
});

test("Color Mix targets each channel, protects gray, and preserves alpha", () => {
  for (const [name, hue] of colors.colorMixChannels) {
    const input = rgb(hue);
    const output = process(input, { [`colorMix${name}Saturation`]: -100 }).data;
    // Quantized RGB may land a fraction of a degree off the band's center.
    assert.ok(Math.abs(output[0] - output[1]) <= 1);
    assert.ok(Math.abs(output[1] - output[2]) <= 1);
    assert.equal(output[3], 127);
    const gray = [83, 83, 83, 17];
    assert.deepEqual(process(gray, { [`colorMix${name}Luminance`]: 100 }).data, gray);
  }
  assert.deepEqual(process(rgb(240), { colorMixRedHue: 100, colorMixRedLuminance: 100 }).data, rgb(240));
});

test("mix hue, saturation and luminance move independently in both directions", () => {
  const original = rgb(0, .5, .5);
  const warm = process(original, { colorMixRedHue: 100 }).data;
  const cool = process(original, { colorMixRedHue: -100 }).data;
  assert.ok(warm[1] > warm[2]);
  assert.ok(cool[2] > cool[1]);
  const more = process(original, { colorMixRedSaturation: 100 }).data;
  assert.ok(more[0] - more[1] > original[0] - original[1]);
  assert.ok(luma(process(original, { colorMixRedLuminance: 100 }).data) > luma(original));
  assert.ok(luma(process(original, { colorMixRedLuminance: -100 }).data) < luma(original));
});

test("hue masks wrap smoothly at red and interpolate without band cutoffs", () => {
  const table = colors.createColorMixTable({ colorMixRedHue: 100, colorMixOrangeHue: -100 });
  for (let c = 0; c < 3; c++) assert.equal(table[c], table[360 * 3 + c]);
  assert.ok(Math.abs(table[0] - table[359 * 3]) < .01);
  for (let h = 1; h <= 360; h++) assert.ok(Math.abs(table[h * 3] - table[(h - 1) * 3]) < .11);
});

test("grading isolates tonal ranges and preserves neutral luminance with tint", () => {
  for (const [range, target] of [["Shadows", 38], ["Midtones", 128], ["Highlights", 217]]) {
    const settings = { [`colorGrade${range}Hue`]: 220, [`colorGrade${range}Saturation`]: 75 };
    const output = process([target, target, target, 201], settings).data;
    assert.ok(output[2] > output[0], range);
    assert.ok(Math.abs(luma(output) - target) < 1, range);
    assert.equal(output[3], 201);
    if (range === "Shadows") assert.deepEqual(process([240, 240, 240, 255], settings).data, [240, 240, 240, 255]);
    if (range === "Highlights") assert.deepEqual(process([15, 15, 15, 255], settings).data, [15, 15, 15, 255]);
    if (range === "Midtones") assert.deepEqual(process([15, 15, 15, 255], settings).data, [15, 15, 15, 255]);
    assert.ok(luma(process([target, target, target, 255], { [`colorGrade${range}Luminance`]: 70 }).data) > target);
    assert.ok(luma(process([target, target, target, 255], { [`colorGrade${range}Luminance`]: -70 }).data) < target);
  }
});

test("extreme grading is bounded, smooth across tones, and anchors black and white", () => {
  const settings = { colorGradeShadowsHue: 240, colorGradeShadowsSaturation: 100,
    colorGradeMidtonesHue: 120, colorGradeMidtonesSaturation: 100,
    colorGradeHighlightsHue: 30, colorGradeHighlightsSaturation: 100 };
  const ramp = Array.from({ length: 256 }, (_, n) => [n, n, n, 128]).flat();
  const output = process(ramp, settings).data;
  assert.deepEqual(output.slice(0, 4), [0, 0, 0, 128]);
  assert.deepEqual(output.slice(-4), [255, 255, 255, 128]);
  for (let n = 4; n < output.length; n += 4) {
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(output[n + c] - output[n - 4 + c]) <= 4);
  }
  const extreme = process(ramp, { ...settings, colorGradeShadowsLuminance: 100, colorGradeHighlightsLuminance: -100 }).data;
  assert.ok(extreme.every(Number.isFinite));
  assert.ok(extreme.every(n => n >= 0 && n <= 255));
});

test("old settings and profiles gain neutral color defaults, never another photo's values", () => {
  const colorSettingDefaults = { colorMixRedHue: "0", colorGradeShadowsSaturation: "0" };
  const els = { colorMixRedHue: { value: "90" } };
  const context = { colorSettingDefaults, els, controlValue: control => control.value };
  const cloneSource = html.match(/function cloneSettings\(settings\)\{[^\n]+/)[0];
  const valueSource = html.slice(html.indexOf("  function settingValue("), html.indexOf("  function settingNumber("));
  const api = vm.runInNewContext(`${cloneSource}\n${valueSource}\n({cloneSettings,settingValue})`, context);
  assert.equal(api.cloneSettings({ fade: "40" }).colorMixRedHue, "0");
  assert.equal(api.cloneSettings({ colorMixRedHue: "10" }).colorMixRedHue, "10");
  assert.equal(api.settingValue({ fade: "40" }, "colorMixRedHue"), "0");
  assert.equal(api.settingValue(null, "colorMixRedHue"), "90");
  assert.match(html, /if\(settings\)settings=cloneSettings\(settings\);/);
});

test("color sliders participate in shared settings, preview and export; grain is in Film look", () => {
  assert.match(html, /const photoSettingControls=\[\s*\.\.\.colorSettingControls,/);
  assert.match(html, /applyBasicAdjustments\(editedBase,settings\);\s*applyColorAdjustments\(editedBase,settings\);\s*applyColorLut\(editedBase,settings\)/);
  assert.match(html, /applyBasicAdjustments\(out,settings\);\s*applyColorAdjustments\(out,settings\);\s*applyColorLut\(out,settings\)/);
  const basic = html.slice(html.indexOf('<div id="basicGroup"'), html.indexOf('<div id="colorsGroup"'));
  assert.doesNotMatch(basic, /id="saturation"/);
  const film = html.slice(html.indexOf('<div id="filmGroup"'), html.indexOf('<div id="exportSection"'));
  assert.match(film, /id="grainEnabled"/);
  assert.doesNotMatch(html, /id="grainGroup"|data-panel="grain"/);
  assert.match(html, /data-panel="colors"/);
});

test("color controls generate 33 neutral sliders and accessible single-panel tab groups", () => {
  // Small DOM double exercises initialization and tab event handlers, without a browser.
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.style = { setProperty() {} }; }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); }
    addEventListener(name, handler) { this.events[name] = handler; }
    click() { this.events.click?.(); }
    focus() { this.focused = true; }
    set innerHTML(markup) {
      const input = markup.match(/<input ([^>]+)>/);
      if (input) {
        this.input = new Element("INPUT");
        for (const [, key, value] of input[1].matchAll(/([\w-]+)="([^"]*)"/g)) this.input[key] = value;
        this.valueLabel = new Element("SPAN");
      }
    }
    querySelector(selector) { return selector === "input" ? this.input : this.valueLabel; }
  }
  const nodes = Object.fromEntries(["colorMixTabs", "colorMixPanels", "colorGradeTabs", "colorGradePanels"].map(id => [`#${id}`, new Element("DIV")]));
  const source = html.slice(html.indexOf("  const colorMixChannels="), html.indexOf("  const photoSettingControls="));
  const api = vm.runInNewContext(`${source}\n({colorSettingControls,colorSettingDefaults})`, {
    document: { createElement: tag => new Element(tag) }, $: selector => nodes[selector], els: {}
  });
  assert.equal(api.colorSettingControls.length, 33);
  assert.equal(new Set(api.colorSettingControls.map(control => control.id)).size, 33);
  assert.ok(api.colorSettingControls.every(control => control.value === "0"));
  assert.equal(api.colorSettingDefaults.colorGradeHighlightsHue, "0");
  for (const prefix of ["colorMix", "colorGrade"]) {
    const tabs = nodes[`#${prefix}Tabs`].children, panels = nodes[`#${prefix}Panels`].children;
    assert.equal(panels.filter(panel => !panel.hidden).length, 1);
    tabs[1].click();
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[1].hidden, false);
    assert.equal(tabs[1].attributes["aria-selected"], "true");
    tabs[1].events.keydown({ key: "End", preventDefault() {} });
    assert.equal(panels.at(-1).hidden, false);
    assert.equal(tabs.at(-1).focused, true);
  }
});
