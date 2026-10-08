"use strict";
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const html=fs.readFileSync(path.resolve(__dirname,'../../index.html'),'utf8');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const plain=value=>JSON.parse(JSON.stringify(value));
function helpers(extra={}){
  return vm.runInNewContext(slice('  function exportDimensions(', '  async function getSourceExifSegment(')+'\n({exportDimensions,exportMegapixels,resizeExportCanvas,updateExportSizeUI})',extra);
}
test('export sizing preserves orientation and aspect ratio without enlarging smaller photos',()=>{
  assert.doesNotMatch(html,/Keeps the aspect ratio\. Smaller photos are never enlarged\./);
  const {exportDimensions:size}=helpers();
  assert.deepEqual(plain(size(8064,6048,12)),{width:4000,height:3000});
  assert.deepEqual(plain(size(6048,8064,12)),{width:3000,height:4000});
  assert.deepEqual(plain(size(4032,3024,24)),{width:4032,height:3024});
  const output=size(8064,6048,24);
  assert.ok(output.width*output.height<=24e6&&output.width*output.height>23.9e6);
  for(const limit of [0,-1,NaN,Infinity])assert.deepEqual(plain(size(8064,6048,limit)),{width:8064,height:6048});
  assert.deepEqual(plain(size(8000,1,.1)),{width:8000,height:1});
});
test('downsampling uses successive reductions and leaves the full-size source untouched',()=>{
  const stages=[];
  const document={createElement(){const canvas={width:0,height:0};canvas.getContext=()=>({drawImage(){stages.push([canvas.width,canvas.height])}});return canvas}};
  const {resizeExportCanvas:resize}=helpers({document});
  const source={width:8064,height:6048};
  assert.equal(resize(source,0),source);
  assert.equal(resize(source,100),source);
  const result=resize(source,3);
  assert.deepEqual(stages,[[4032,3024],[2016,1512],[2000,1500]]);
  assert.deepEqual(plain(result),{width:2000,height:1500});
  assert.deepEqual(source,{width:8064,height:6048});
});
test('custom export size is validated and the readout follows crop and rotation',()=>{
  const options=[{value:'mp12'},{value:'mp24'}];
  const els={exportSize:{value:'original',options},exportCustomMP:{value:'12'},exportCustomControl:{},exportSizeInfo:{},exportSizeNotice:{}};
  const item={exportSourceSize:{width:8064,height:6048},rotation:90,crop:{x:0,y:0,w:1,h:.5}};
  const api=helpers({els,items:[item],current:0,busy:false,rotatedSize:(w,h)=>[h,w],normalizedCrop:c=>c});
  assert.equal(api.exportMegapixels(),0);
  els.exportSize.value='custom';api.updateExportSizeUI();
  assert.equal(els.exportCustomControl.hidden,false);
  assert.match(els.exportSizeInfo.textContent,/12.0 MP \(4,242 × 2,828 px\)/);
  assert.equal(options[0].textContent,'12 MP (4,242 × 2,828 px)');
  assert.equal(els.exportSizeNotice.hidden,true);
  item.exportSourceSize={width:4032,height:3024};
  els.exportSize.value='mp24';api.updateExportSizeUI();
  assert.equal(els.exportSizeNotice.hidden,false);
  assert.match(els.exportSizeNotice.textContent,/already smaller.*without resizing/);
  els.exportSize.value='original';api.updateExportSizeUI();
  assert.equal(els.exportSizeNotice.hidden,true);
  els.exportSize.value='custom';
  els.exportCustomMP.value='-1';assert.equal(api.exportMegapixels(),12);
  els.exportCustomMP.value='999999';assert.equal(api.exportMegapixels(),100);
});
test('individual and ZIP renders resize after all edits and write the final EXIF dimensions',async()=>{
  const order=[];
  const full={width:8064,height:6048},small={width:4000,height:3000};
  const context={batchSettings:{},els:{quality:{value:'95'}},
    processingCheckpoint:async()=>{},throwIfProcessingCancelled(){},decodeForProcessing:async()=>full,
    normalizeDecodedBottomPadding:c=>c,drawRotated:()=>full,cropCanvas:c=>c,processCanvas:c=>c,
    applyDateStamp:async()=>order.push('stamp'),applyPhotoMasks:async()=>order.push('masks'),
    exportMegapixels:()=>12,resizeExportCanvas:(canvas,limit)=>{assert.equal(canvas,full);assert.equal(limit,12);order.push('resize');return small},
    canvasToBlob:async(canvas,mime,quality)=>{assert.equal(canvas,small);assert.equal(mime,'image/jpeg');assert.equal(quality,.95);order.push('encode');return 'jpeg'},
    preserveExifMetadata:async(blob,file,w,h)=>{assert.equal(w,4000);assert.equal(h,3000);order.push('exif');return blob}
  };
  for(const name of ['applyChromaNoiseReduction','applyLuminanceNoiseReduction','applyBasicAdjustments','applyColorAdjustments','applyColorLut','applySharpness','applyChromaticAberration','applyFade','applyLightLeaks','applyHalation','applyBloom','applyGrain'])context[name]=()=>{};
  const process=vm.runInNewContext(slice('  async function processItem(', '  async function downloadBlob(')+'\nprocessItem',context);
  for(const cancellable of [false,true]){
    order.length=0;assert.equal(await process({file:{}},cancellable),'jpeg');
    assert.deepEqual(order,['stamp','masks','resize','encode','exif']);
  }
});
