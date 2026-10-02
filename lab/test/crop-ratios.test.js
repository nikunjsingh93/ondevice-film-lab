"use strict";
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const html=fs.readFileSync(path.resolve(__dirname,'../../index.html'),'utf8');
const start=html.indexOf('  function fitCropRatio(');
const end=html.indexOf('  function updateCropOverlay(',start);
const {fitCropRatio,resizeCropRatio}=vm.runInNewContext(html.slice(start,end)+'\n({fitCropRatio,resizeCropRatio})');
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function check(crop,q){
  assert.ok(crop.w>0&&crop.h>0);
  assert.ok(crop.x>=-1e-8&&crop.y>=-1e-8);
  assert.ok(crop.x+crop.w<=1+1e-8&&crop.y+crop.h<=1+1e-8);
  close(crop.w/crop.h,q);
}
test('crop presets use pixel aspect ratios on landscape and portrait photos',()=>{
  for(const source of [3/2,2/3,16/9,9/16]){
    for(const ratio of [1,3/2,2/3,4/3,3/4,4/5,5/4,16/9,9/16,source]){
      for(const area of [{x:0,y:0,w:1,h:1},{x:.7,y:.05,w:.25,h:.3}]){
        check(fitCropRatio(area,source,ratio),ratio/source);
      }
    }
  }
});
test('all crop handles retain the chosen ratio and stay in bounds during extreme drags',()=>{
  for(const q of [.375,1,2.667]){
    const initial=fitCropRatio({x:.2,y:.2,w:.6,h:.6},1,q);
    for(const direction of ['n','ne','e','se','s','sw','w','nw']){
      for(const dx of [-2,-.1,0,.1,2])for(const dy of [-2,-.1,0,.1,2]){
        const crop=resizeCropRatio(initial,direction,dx,dy,q,.04,.04);
        check(crop,q);
        if(direction.includes('w'))close(crop.x+crop.w,initial.x+initial.w);
        else if(direction.includes('e'))close(crop.x,initial.x);
        else close(crop.x+crop.w/2,initial.x+initial.w/2);
        if(direction.includes('n'))close(crop.y+crop.h,initial.y+initial.h);
        else if(direction.includes('s'))close(crop.y,initial.y);
        else close(crop.y+crop.h/2,initial.y+initial.h/2);
      }
    }
  }
});
