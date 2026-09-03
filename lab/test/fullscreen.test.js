"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../public/lab-shell.js'),'utf8');
function button(id){return {id,setAttribute(key,value){this[key]=value}}}
function setup(){
  const frameEvents={},events={},urls=[];
  const frame={addEventListener(name,fn){frameEvents[name]=fn}};
  const doc={fullscreenElement:null,fullscreenEnabled:true,
    querySelector(){return frame},addEventListener(name,fn){events[name]=fn},
    documentElement:{async requestFullscreen(){doc.fullscreenElement=this;events.fullscreenchange()}},
    async exitFullscreen(){doc.fullscreenElement=null;events.fullscreenchange()}};
  const location={href:'https://lab.example/editor?photo=first',origin:'https://lab.example'};
  const window={};window.parent=window;
  vm.runInNewContext(source,{window,document:doc,location,history:{replaceState(_state,_unused,url){urls.push(url)}},URL,console});
  function navigate(route,editor=true){
    const controls=editor?[button('fullBtn')]:[],listeners={};
    const page={title:editor?'Editor':'Library',querySelectorAll(){return controls},
      querySelector(selector){if(selector==='#fullBtn')return controls.find(b=>b.id==='fullBtn');if(selector==='#labFullscreenButton')return controls.find(b=>b.id==='labFullscreenButton');return {appendChild(b){controls.push(b)}}},
      createElement(){return button('')},addEventListener(name,fn){listeners[name]=fn}};
    frame.contentDocument=page;frame.contentWindow={location:{href:'https://lab.example'+route}};frameEvents.load();
    return {controls,async click(){let stopped=false;listeners.click({target:{closest(){return controls[0]}},preventDefault(){},stopImmediatePropagation(){stopped=true}});await Promise.resolve();assert.equal(stopped,true)}};
  }
  return {doc,frame,urls,navigate};
}
test('fullscreen survives editor, filmstrip, library and settings navigation and can be exited there',async()=>{
  const app=setup();assert.equal(app.frame.src,'/editor?photo=first&labFrame=1');
  const first=app.navigate('/editor?photo=first&labFrame=1');await first.click();
  assert.equal(app.doc.fullscreenElement,app.doc.documentElement);
  for(const route of ['/editor?photo=second','/','/settings','/editor?photo=third']){
    const page=app.navigate(route,route.startsWith('/editor'));
    assert.equal(app.doc.fullscreenElement,app.doc.documentElement);
    assert.equal(page.controls[0]['aria-label'],'Exit full screen');
    assert.equal(page.controls[0]['aria-pressed'],'true');
  }
  const library=app.navigate('/',false);await library.click();
  assert.equal(app.doc.fullscreenElement,null);assert.equal(library.controls[0]['aria-pressed'],'false');
  assert.ok(app.urls.every(url=>!url.includes('labFrame')));
});
test('a nested shell falls back to the content route instead of creating another frame',()=>{
  let destination;
  vm.runInNewContext(source,{window:{parent:{}},location:{href:'https://lab.example/editor?photo=1',replace(url){destination=url}},URL});
  assert.equal(destination,'/editor?photo=1&labFrame=1');
});
test('Android uses a direct page instead of the persistent iframe shell',()=>{
  let destination;
  const window={};window.parent=window;
  vm.runInNewContext(source,{window,navigator:{userAgent:'Android'},location:{href:'https://lab.example/editor?photo=1',replace(url){destination=url}},URL});
  assert.equal(destination,'/editor?photo=1&labFrame=1');
});
