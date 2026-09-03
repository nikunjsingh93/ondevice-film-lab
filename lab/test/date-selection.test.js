"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function harness(request){
  const selected=new Set(['other-date']);
  const context={selected,selectionMode:true,selectionRevision:0,dateSelections:new Map(),sortMode:'captured',URLSearchParams,
    elements:{searchInput:{value:'trip'}},jsonRequest:request,updateSelection(){},notify(message){throw new Error(message)}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function toggleDateGroup('),source.indexOf('  async function loadPhotos(')),context);
  const button={disabled:false,dataset:{date:'2026-8-2',start:'2026-09-02T04:00:00.000Z',end:'2026-09-03T04:00:00.000Z'}};
  return {context,selected,button};
}
test('date toggle selects unloaded IDs, retains other days, and toggles partial/full selection',async()=>{
  let calls=0;
  const {context,selected,button}=harness(async url=>{calls++;assert.match(url,/q=trip/);return {ids:['loaded','unloaded']}});
  await context.toggleDateGroup(button);
  assert.deepEqual([...selected],['other-date','loaded','unloaded']);
  selected.delete('loaded');
  await context.toggleDateGroup(button);
  assert.equal(selected.has('loaded'),true);
  await context.toggleDateGroup(button);
  assert.deepEqual([...selected],['other-date']);
  assert.equal(calls,1);assert.equal(button.disabled,false);
});
test('leaving selection or changing filters discards a pending date response',async()=>{
  let resolve;
  const {context,selected,button}=harness(()=>new Promise(done=>{resolve=done}));
  const pending=context.toggleDateGroup(button);
  assert.equal(button.disabled,true);
  context.resetDateSelection();resolve({ids:['stale']});await pending;
  assert.equal(selected.size,0);assert.equal(context.dateSelections.size,0);assert.equal(button.disabled,false);
});
