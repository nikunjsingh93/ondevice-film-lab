"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/pages.yml"), "utf8");

test("GitHub Pages copies every local script loaded by the offline editor", () => {
  const copyLine = workflow.split(/\r?\n/).find(line => /^\s*cp index\.html /.test(line));
  assert.ok(copyLine, "Pages asset copy command is missing");
  const copied = new Set(copyLine.trim().split(/\s+/).slice(1, -1));
  for (const [, script] of html.matchAll(/<script src="\.\/([^"]+)"/g)) {
    assert.ok(copied.has(script), `${script} is loaded by the editor but missing from Pages`);
    assert.ok(fs.existsSync(path.join(root, script)), `${script} is missing locally`);
  }
});

test("missing EXIF helper cannot stop export controls from initializing", () => {
  const source = html.match(/const readPhotoExif=([^;]+);/)?.[1];
  assert.ok(source, "EXIF reader initializer is missing");
  const readPhotoExif = vm.runInNewContext(source, { window: {} });
  assert.deepEqual(Array.from(readPhotoExif(new Uint8Array(0))), []);
});
