"use strict";
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const html=fs.readFileSync(path.resolve(__dirname,'../../index.html'),'utf8');
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const geometry=vm.runInNewContext(slice('  function maskTransform(', '  function maskCoverage(')+'\n({maskTransform,maskPoint})',{
  normalizedCrop:crop=>crop||{x:0,y:0,w:1,h:1}
});

test('brush source coordinates follow rotation, straighten and crop at preview and export sizes',()=>{
  for(const rotation of [0,90,180,270])for(const straighten of [-12,0,8])for(const crop of [null,{x:.2,y:.1,w:.6,h:.7}]){
    const item={rotation,straighten,crop},aspect=4/3;
    for(const scale of [1,4]){
      const m=geometry.maskTransform(800*scale,600*scale,item,aspect);
      for(const p of [{x:.1,y:.1},{x:aspect/2,y:.5},{x:1.1,y:.8}]){
        const point=geometry.maskPoint(m,m.a*p.x+m.c*p.y+m.e,m.b*p.x+m.d*p.y+m.f);
        assert.ok(Math.abs(point.x-p.x)<.000001);assert.ok(Math.abs(point.y-p.y)<.000001);
      }
    }
  }
  const m=geometry.maskTransform(600,800,{rotation:90},4/3);
  const p={x:.2,y:.25};
  assert.ok(Math.abs(m.a*p.x+m.c*p.y+m.e-450)<.0001);
  assert.ok(Math.abs(m.b*p.x+m.d*p.y+m.f-120)<.0001);
});

test('mask slider changes stay local and trigger photo persistence rather than batch or profile saves',()=>{
  const control={id:'exposure',value:'45'},mask={settings:{exposure:'0'}};
  let saves=0,renders=0;
  const commit=vm.runInNewContext(slice('  function commitPhotoControl(', '  function resetSettingsSection(')+'\ncommitPhotoControl',{
    controlValue:c=>c.value,activeMask:()=>mask,saveMaskChange:()=>saves++,refreshSettingUI(){},updateMaskUI(){},rerender:()=>renders++
  });
  commit(control);assert.equal(mask.settings.exposure,'45');assert.equal(saves,1);assert.equal(renders,1);
});

test('mask paths and settings are deep-copied into persisted photo state',()=>{
  const item={libraryId:'photo',masks:[{id:'mask',settings:{exposure:'20'},strokes:[{points:[{x:.1,y:.2}]}]}],settings:{exposure:'0'}};
  const stored=vm.runInNewContext(slice('  function storedStateFor(', '  function fileFromStoredPhoto(')+'\nstoredStateFor',{
    cropIsFull:()=>true,cloneSettings:s=>({...s})
  })(item);
  item.masks[0].strokes[0].points[0].x=.8;item.masks[0].settings.exposure='80';
  assert.equal(stored.masks[0].strokes[0].points[0].x,.1);
  assert.equal(stored.masks[0].settings.exposure,'20');
  assert.equal(stored.settings.exposure,'0');
});

test('neutral and disabled masks bypass compositing; preview and export both apply photo masks',async()=>{
  const apply=vm.runInNewContext(slice('  async function applyPhotoMasks(', '  function saveMaskChange(')+'\napplyPhotoMasks',{
    neutralPhotoSettings:{exposure:'0'},settingsMatch:(a,b)=>a.exposure===b.exposure
  });
  const canvas={};
  assert.equal(await apply(canvas,{masks:[{enabled:false,strokes:[{}]},{strokes:[{}],settings:{exposure:'0'}}]},1,1),canvas);
  assert.match(slice('  async function makePreview(', '  function debounce('),/await applyPhotoMasks\(editedBase,it,previewScale,maskAspect,editingCrop\)/);
  assert.match(slice('  async function processItem(', '  async function downloadBlob('),/await applyPhotoMasks\(out,it,1,maskAspect\)/);
});

test('Lab arrow keys navigate server neighbors and respect inputs, active masks, boundaries, and modifiers',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../public/lab-editor.js'),'utf8');
  const start=source.indexOf('  document.addEventListener("keydown", event => {');
  const end=source.indexOf('\n  function renderServerFilmstrip',start);
  let listener,canNavigate=true,blocked=false,navigated=[];
  const context={photoId:'two',nearbyPhotos:[{id:'one'},{id:'two'},{id:'three'}],openingPhoto:false,
    bridge:{canNavigate:()=>canNavigate},openServerPhoto:id=>navigated.push(id),
    document:{addEventListener:(type,handler)=>listener=handler,body:{classList:{contains:()=>false}},querySelector:()=>blocked}
  };
  vm.runInNewContext(source.slice(start,end),context);
  const key=(key,options={})=>listener({key,target:{closest:()=>false},preventDefault(){},...options});
  key('ArrowRight');key('ArrowLeft');assert.deepEqual(navigated,['three','one']);
  key('ArrowRight',{target:{closest:()=>true}});key('ArrowLeft',{ctrlKey:true});key('ArrowRight',{repeat:true});
  canNavigate=false;key('ArrowRight');canNavigate=true;blocked=true;key('ArrowRight');blocked=false;
  context.photoId='three';key('ArrowRight');assert.deepEqual(navigated,['three','one']);
});
