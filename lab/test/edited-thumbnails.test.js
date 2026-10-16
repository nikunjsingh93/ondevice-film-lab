'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const slice=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
test('edited thumbnail updates the filmstrip and gallery, persists, and rejects late renders',()=>{
 const item={libraryId:'photo-one',settings:{flashbackMode:'1',flashbackLook:'classic'},rotation:0},img={src:'washed-out'},rot={},galleryImg={src:'washed-out'},row={querySelector:s=>s==='img'?img:rot},card={dataset:{libraryId:'photo-one'},querySelector:()=>galleryImg};let saved=0,events=0,drawn;
 const context={items:[item],current:0,batchSettings:{},cloneSettings:s=>({...s}),cropIsFull:()=>true,els:{thumbs:{children:[row]},galleryGrid:{querySelectorAll:()=>[card]}},window:{__FILMLAB_SERVER_MODE__:true,dispatchEvent:()=>events++},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail}},scheduleLibraryState:()=>saved++,document:{createElement:()=>({getContext:()=>({drawImage:source=>drawn=source}),toDataURL:()=> 'data:image/jpeg;base64,edited'})}};
 const api=vm.runInNewContext(slice('  function thumbnailKey(', '  const pendingEditedThumbnails=')+'\n({thumbnailKey,publishEditedThumbnail})',context),canvas={width:1800,height:1200},key=api.thumbnailKey(item);
 api.publishEditedThumbnail(item,canvas,key);assert.equal(drawn,canvas);assert.equal(img.src,'data:image/jpeg;base64,edited');assert.equal(galleryImg.src,img.src);assert.equal(item.editedThumbnail.key,key);assert.equal(saved,1);assert.equal(events,1);
 item.settings.flashbackLook='beta';api.publishEditedThumbnail(item,canvas,key);assert.equal(saved,1,'stale render must not overwrite a later look');
});
test('valid cached thumbnails are reused; missing thumbnails queue edited processing instead of decoding originals',async()=>{
 const item={editedThumbnail:{key:'current',dataUrl:'edited'}},img={},queued=[];const refresh=vm.runInNewContext(slice('  async function refreshThumb(', '  function createLibraryId(')+'\nrefreshThumb',{items:[item],els:{thumbs:{children:[{querySelector:()=>img}]}},thumbnailKey:()=> 'current',queueEditedThumbnail:item=>queued.push(item)});
 await refresh(0);assert.equal(img.src,'edited');assert.equal(queued.length,0);item.editedThumbnail=null;await refresh(0);assert.equal(queued[0],item);
 assert.match(slice('  async function makePreview(', '  function debounce('),/if\(!editingCrop\)publishEditedThumbnail\(it,editedBase\)/);
 assert.match(slice('  async function drainEditedThumbnails(', '  async function refreshThumb('),/await renderPreviewAdjustments/);
});
test('all additional One35 looks use the correct display colour space and preserve local formulas',async()=>{
 const {EXTRA_LOOKS,configForLook,finishLocalLook,atlasLut}=await import('../../flashback/looks.js');const {renderCpu}=await import('../../flashback/cpu.js');const sharp=require('sharp');assert.equal(Object.keys(EXTRA_LOOKS).length,8);
 for(const [id,look] of Object.entries(EXTRA_LOOKS)){assert.ok(html.includes(`value="${id}"`));const config=configForLook(id);if(look.atlas){assert.equal(config.lut_input_space,'srgb');assert.equal(config.enable_lut,true);const {data,info}=await sharp(new URL(config.lut_path).pathname.replace(/^\/(\w:)/,'$1')).ensureAlpha().raw().toBuffer({resolveWithObject:true});const lut=atlasLut(data,info.width,info.height);assert.equal(lut.size,64);assert.equal(lut.inputSpace,'srgb');const r=7,g=13,b=19,src=(((b>>3)*64+g)*512+(b%8)*64+r)*4,dst=((r*64+g)*64+b)*3;for(let c=0;c<3;c++)assert.ok(Math.abs(lut.data[dst+c]-data[src+c]/255)<1e-7)}else assert.equal(config.enable_lut,false)}
 const mono={data:Uint8ClampedArray.from([200,120,60,77])};finishLocalLook(mono,'mono');assert.equal(mono.data[0],mono.data[1]);assert.equal(mono.data[1],mono.data[2]);assert.equal(mono.data[3],77);
 const dmg={data:Uint8ClampedArray.from([0,0,0,91,255,255,255,255])};finishLocalLook(dmg,'dmg');assert.deepEqual(Array.from(dmg.data),[31,51,31,91,184,217,120,255]);
 // Identity camera table must see developed sRGB, without the native film LUT's +2 EV lift.
 const lut={size:2,data:Float32Array.from([0,0,0,0,0,1,0,1,0,0,1,1,1,0,0,1,0,1,1,1,0,1,1,1])},source={pixels:Float32Array.from([.05,.08,.12]),width:1,height:1,ccm:[1,0,0,0,1,0,0,0,1]},neutral=configForLook('natural'),camera={...neutral,enable_lut:true,lut_input_space:'srgb'};
 const original=renderCpu(source,neutral,null,null),graded=renderCpu(source,camera,lut,null);for(let c=0;c<3;c++)assert.ok(Math.abs(original.rgb[c]-graded.rgb[c])<1e-6);
});
