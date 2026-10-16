'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),adapter=fs.readFileSync(path.join(root,'flashback.js'),'utf8');
test('editor, worker, imported modules and offline cache use a matching Flashback release',async()=>{
 const {ENGINE_VERSION}=await import('../../flashback/worker.js'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
 assert.ok(adapter.includes(`ENGINE_VERSION="${ENGINE_VERSION}"`));assert.ok(html.includes(`./flashback.js?v=${ENGINE_VERSION}`));assert.ok(sw.includes(`./flashback.js?v=${ENGINE_VERSION}`));
 const walk=dir=>{for(const name of fs.readdirSync(path.join(root,dir))){const file=dir+'/'+name;if(fs.statSync(path.join(root,file)).isDirectory()){walk(file);continue}if(!file.endsWith('.js'))continue;assert.ok(sw.includes(`./${file}?v=${ENGINE_VERSION}`),file+' must be available offline');const source=fs.readFileSync(path.join(root,file),'utf8');for(const [,target] of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.\.?\/[^"']+\.js[^"']*)["']/g)){assert.ok(target.endsWith('?v='+ENGINE_VERSION),file+': '+target);assert.ok(fs.existsSync(path.resolve(root,path.dirname(file),target.split('?')[0])));}}};walk('flashback');
});
function harness({oldEngine=false}={}){
 let releaseRead,posted,workerURL;const version=adapter.match(/ENGINE_VERSION="([^"]+)"/)[1];
 class Worker {constructor(url){workerURL=url.href}terminate(){}postMessage(request){posted=request;queueMicrotask(()=>this.onmessage({data:{id:request.id,look:request.look,engineVersion:oldEngine?undefined:version,image:{data:new Uint8ClampedArray(4),width:1,height:1},sourceWidth:4144,sourceHeight:3088}}))}}
 const context={URL,Worker,setTimeout,clearTimeout,Uint8ClampedArray,queueMicrotask,ImageData:class{},document:{currentScript:{src:'https://example.test/flashback.js'},createElement:()=>({getContext:()=>({putImageData(){}})})}};vm.runInNewContext(adapter,context);
 const file={arrayBuffer:()=>new Promise(resolve=>releaseRead=()=>resolve(new ArrayBuffer(4)))};
 return {api:context.FilmLabFlashback,file,release:()=>releaseRead(),get posted(){return posted},get workerURL(){return workerURL},version};
}
test('queued renders keep the selected look even if controls change while the file is being read',async()=>{
 const h=harness(),settings={flashbackMode:'1',flashbackLook:'classic',flashbackEdgeSoftness:false},job=h.api.render(h.file,settings);settings.flashbackLook='beta';h.release();await job;assert.equal(h.posted.look,'classic');assert.ok(h.workerURL.endsWith('?v='+h.version));
});
test('old processing responses and unsupported look names cannot silently display Disposable',async()=>{
 const h=harness({oldEngine:true}),job=h.api.render(h.file,{flashbackMode:'1',flashbackLook:'dmg'});h.release();await assert.rejects(job,/needs an update/);
 const {develop}=await import('../../flashback/worker.js');await assert.rejects(develop({look:'unsupported-camera-look'}),/Unsupported Flashback look/);
});
