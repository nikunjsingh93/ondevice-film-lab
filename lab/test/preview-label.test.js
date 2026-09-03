"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
const source=html.slice(html.indexOf('  function settingsHavePreviewEdits('),html.indexOf('  function captureEditHistoryState('));
const {previewHasEdits}=vm.runInNewContext(source+';({previewHasEdits})',{
 colorSettingDefaults:{colorMixRedHue:'0',colorGradeShadowsHue:'0',colorGradeShadowsSaturation:'0',colorGradeShadowsLuminance:'0'},
 customLuts:new Map([['loaded',{}]]),cropIsFull:crop=>!crop
});
test('neutral preview ignores inactive auxiliary controls and returns to Original after reset',()=>{
 for(const settings of [{},{exposure:'0',amount:'0'},{radius:'22',threshold:'5',grainSize:'20',grainStrength:'50',grainEnabled:false,lutStrength:'100',lutSelect:'none',colorGradeShadowsHue:'120'}])assert.equal(previewHasEdits({},settings),false);
 for(const settings of [{exposure:'-20'},{amount:'5'},{dateStamp:true},{grainEnabled:true,grainStrength:'10'},{lutSelect:'loaded',lutStrength:'50'},{colorMixRedHue:'10'},{colorGradeShadowsSaturation:'20'}])assert.equal(previewHasEdits({},settings),true);
 assert.equal(previewHasEdits({}, {exposure:'0'}),false);
});
test('geometry and enabled painted mask edits count, empty and disabled masks do not',()=>{
 for(const item of [{rotation:90},{straighten:2},{crop:{x:.1}}])assert.equal(previewHasEdits(item,{}),true);
 const mask={settings:{exposure:'20'},strokes:[{points:[{x:.5,y:.5}]}]};
 assert.equal(previewHasEdits({masks:[mask]},{}),true);
 for(const m of [{...mask,enabled:false},{...mask,strokes:[]},{...mask,settings:{exposure:'0'}},{...mask,strokes:[{erase:true,points:[{x:.5,y:.5}]}]}])assert.equal(previewHasEdits({masks:[m]},{}),false);
});
