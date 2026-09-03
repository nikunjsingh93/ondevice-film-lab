"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const adapter=fs.readFileSync(path.join(__dirname,'../public/lab-editor.js'),'utf8');
const source=adapter.slice(adapter.indexOf('  function restoreEditClipboard()'),adapter.indexOf('  async function initialize()'));
test('copied adjustments survive editor replacement and remain account-specific',()=>{
  const storage=new Map();
  const settings={exposure:'35',contrast:'18',grainEnabled:false};
  function page(account){
    let restored=null;
    const context={copiedEditsKey:`filmLabCopiedEdits-${account}`,sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
      bridge:{getCopiedEdits:()=>settings,restoreCopiedEdits:value=>{restored=value}},notify(){}};
    vm.createContext(context);vm.runInContext(source,context);
    return {context,restored:()=>restored};
  }
  page('one').context.saveEditClipboard();
  const next=page('one');next.context.restoreEditClipboard();
  assert.deepEqual(JSON.parse(JSON.stringify(next.restored())),settings);
  const other=page('two');other.context.restoreEditClipboard();assert.equal(other.restored(),null);
  storage.set('filmLabCopiedEdits-one','invalid JSON');assert.doesNotThrow(()=>next.context.restoreEditClipboard());
});
