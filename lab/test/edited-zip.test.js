"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

test("Lab gallery uploads each edited render before closing its editor frame",async()=>{
  const app=fs.readFileSync(path.join(__dirname,"../public/app.js"),"utf8");
  const source=app.slice(app.indexOf("  function renderPhotoForZip("),app.indexOf("  async function downloadSelectedZip()"));
  const jpeg=new Blob([Uint8Array.from([0xff,0xd8,0xff,0xd9])],{type:"image/jpeg"});
  let frame,removed=false;
  const document={
    createElement(tag){
      assert.equal(tag,"iframe");
      frame={style:{},setAttribute(){},addEventListener(event,handler){this[event]=handler},remove(){removed=true},
        contentWindow:{document:{},__FILMLAB_BATCH_READY__:Promise.resolve({ready:true}),__FILMLAB_SERVER_EDITOR__:{
          renderCurrent:async()=>jpeg,currentOutputName:async()=>"20260925_195954_FilmLab.jpg"
        }}};
      return frame;
    },
    body:{appendChild(value){assert.equal(value,frame);queueMicrotask(()=>frame.load())}}
  };
  const render=vm.runInNewContext(`${source};renderPhotoForZip`,{document,setTimeout,clearTimeout,DOMException,encodeURIComponent});
  let consumed=false;
  await render("photo-123",new AbortController().signal,async entry=>{
    assert.equal(removed,false);
    assert.equal(entry.blob,jpeg);
    assert.equal(entry.name,"20260925_195954_FilmLab.jpg");
    consumed=true;
  });
  assert.equal(consumed,true);
  assert.equal(removed,true);
  assert.match(frame.src,/photo=photo-123&labFrame=1&batchExport=1/);
  const cancelled=new AbortController();
  cancelled.abort();
  await assert.rejects(render("photo-456",cancelled.signal,async()=>{}),error=>error.name==="AbortError");
});

test("Lab gallery streams rendered JPEGs to the server ZIP endpoint",()=>{
  const app=fs.readFileSync(path.join(__dirname,"../public/app.js"),"utf8");
  const download=app.slice(app.indexOf("  async function downloadSelectedZip()"),app.indexOf("  function handleCard("));
  assert.match(download,/renderPhotoForZip\(ids\[i\]/);
  assert.match(download,/method:"PUT"/);
  assert.match(download,/\/api\/edited-zip\/\$\{encodeURIComponent\(jobId\)\}\/download/);
  assert.doesNotMatch(download,/FilmLabEditedZip|\/api\/photos\/download\.zip/);
});
