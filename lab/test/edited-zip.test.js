"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {build}=require("../public/edited-zip");

test("gallery ZIP stores rendered JPEGs under capture-date names and separates duplicates",async()=>{
  const first=new Blob([Uint8Array.from([0xff,0xd8,1,0xff,0xd9])],{type:"image/jpeg"});
  const second=new Blob([Uint8Array.from([0xff,0xd8,2,0xff,0xd9])],{type:"image/jpeg"});
  const zip=Buffer.from(await (await build([
    {name:"20260925_195954.jpg",blob:first},
    {name:"20260925_195954.jpg",blob:second}
  ])).arrayBuffer());
  let offset=0;
  for(const [expectedName,expectedByte] of [["20260925_195954.jpg",1],["20260925_195954_2.jpg",2]]){
    assert.equal(zip.readUInt32LE(offset),0x04034b50);
    const size=zip.readUInt32LE(offset+18);
    const nameLength=zip.readUInt16LE(offset+26);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString();
    assert.equal(name,expectedName);
    assert.equal(size,5);
    assert.equal(zip[offset+30+nameLength+2],expectedByte);
    offset+=30+nameLength+size;
  }
  assert.equal(zip.readUInt32LE(offset),0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length-14),2);
});

test("gallery ZIP renders through each saved editor state instead of requesting originals",()=>{
  const app=fs.readFileSync(path.join(__dirname,"../public/app.js"),"utf8");
  const editor=fs.readFileSync(path.join(__dirname,"../public/lab-editor.js"),"utf8");
  const download=app.slice(app.indexOf("  async function downloadSelectedZip()"),app.indexOf("  function handleCard("));
  assert.match(download,/renderPhotoForZip\(ids\[i\]/);
  assert.match(download,/FilmLabEditedZip\.build\(entries/);
  assert.doesNotMatch(download,/\/api\/photos\/download\.zip/);
  assert.match(editor,/__FILMLAB_BATCH_READY__/);
  assert.match(editor,/if \(batchExportMode\) return true/);
});

test("gallery waits for an isolated editor to render and name a selected photo",async()=>{
  const app=fs.readFileSync(path.join(__dirname,"../public/app.js"),"utf8");
  const source=app.slice(app.indexOf("  function renderPhotoForZip("),app.indexOf("  async function downloadSelectedZip()"));
  const jpeg=new Blob([Uint8Array.from([0xff,0xd8,0xff,0xd9])],{type:"image/jpeg"});
  let frame,removed=false;
  const document={
    createElement(tag){
      assert.equal(tag,"iframe");
      frame={style:{},setAttribute(){},addEventListener(event,handler){this[event]=handler},remove(){removed=true},
        contentWindow:{__FILMLAB_BATCH_READY__:Promise.resolve({ready:true}),__FILMLAB_SERVER_EDITOR__:{
          renderCurrent:async()=>jpeg,currentOutputName:async()=>"20260925_195954_FilmLab.jpg"
        }}};
      return frame;
    },
    body:{appendChild(value){assert.equal(value,frame);queueMicrotask(()=>frame.load())}}
  };
  const render=vm.runInNewContext(`${source};renderPhotoForZip`,{document,setTimeout,clearTimeout,DOMException,encodeURIComponent});
  const result=await render("photo-123",new AbortController().signal);
  assert.equal(result.blob,jpeg);
  assert.equal(result.name,"20260925_195954_FilmLab.jpg");
  assert.match(frame.src,/photo=photo-123&labFrame=1&batchExport=1/);
  assert.equal(removed,true);
  const cancelled=new AbortController();
  cancelled.abort();
  await assert.rejects(render("photo-456",cancelled.signal),error=>error.name==="AbortError");
});
