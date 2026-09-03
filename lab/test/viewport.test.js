"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/lab-viewport.js"), "utf8");
for (const embedded of [true, false]) {
  test(`system insets are reserved once: ${embedded ? "embedded Lab page" : "direct page"}`, () => {
    const classes = [], properties = {};
    const window = {};
    window.parent = embedded ? {} : window;
    const root = {classList:{add:value=>classes.push(value)},style:{setProperty:(name,value)=>{properties[name]=value}}};
    vm.runInNewContext(source, {window,document:{documentElement:root}});
    assert.equal(classes.includes("labEmbedded"), embedded);
    for (const side of ["top", "right", "bottom", "left"]) {
      assert.equal(properties[`--lab-safe-area-${side}`], embedded ? "0px" : undefined);
    }
  });
}
