(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FilmLabToneCurve=api})(globalThis,function(){
  'use strict';
  const channels=['rgb','red','green','blue'];
  const identity=()=>[[0,0],[1,1]];
  const clamp=v=>Math.max(0,Math.min(1,v));
  function parse(value){
    let data;try{data=typeof value==='string'?JSON.parse(value):value}catch{}
    return Object.fromEntries(channels.map(channel=>{
      const raw=data?.[channel];
      if(!Array.isArray(raw)||raw.length<2)return [channel,identity()];
      const points=raw.filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)).map(p=>p.map(clamp)).sort((a,b)=>a[0]-b[0]);
      const unique=points.filter((p,i)=>!i||p[0]-points[i-1][0]>=1/255).slice(0,16);
      if(unique.length<2)return [channel,identity()];
      unique[0][0]=0;unique[unique.length-1][0]=1;
      return [channel,unique];
    }));
  }
  function isActive(value){return channels.some(c=>parse(value)[c].some(p=>Math.abs(p[0]-p[1])>1e-6))}
  function serialize(data){return isActive(data)||channels.some(c=>data[c].length>2)?JSON.stringify(data):'0'}
  // Shape-preserving cubic Hermite interpolation avoids ringing around control points.
  function evaluate(points,x){
    const n=points.length,h=[],d=[],m=[];
    for(let i=0;i<n-1;i++){h[i]=points[i+1][0]-points[i][0];d[i]=(points[i+1][1]-points[i][1])/h[i]}
    m[0]=d[0];m[n-1]=d[n-2];
    for(let i=1;i<n-1;i++)m[i]=d[i-1]*d[i]<=0?0:3*(h[i-1]+h[i])/((2*h[i]+h[i-1])/d[i-1]+(h[i]+2*h[i-1])/d[i]);
    let i=0;while(i<n-2&&x>points[i+1][0])i++;
    const t=clamp((x-points[i][0])/h[i]),t2=t*t,t3=t2*t;
    return clamp((2*t3-3*t2+1)*points[i][1]+(t3-2*t2+t)*h[i]*m[i]+(-2*t3+3*t2)*points[i+1][1]+(t3-t2)*h[i]*m[i+1]);
  }
  function apply(canvas,value){
    if(!isActive(value))return canvas;
    const data=parse(value),tables=channels.map(c=>Uint8Array.from({length:256},(_,i)=>Math.round(evaluate(data[c],i/255)*255)));
    const ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height),pixels=image.data;
    for(let i=0;i<pixels.length;i+=4)for(let c=0;c<3;c++)pixels[i+c]=tables[c+1][tables[0][pixels[i+c]]];
    ctx.putImageData(image,0,0);return canvas;
  }
  function createEditor(root,input,{begin,change,disabled}){
    const svg=root.querySelector('svg.curveGraph'),path=root.querySelector('.curvePath'),nodes=root.querySelector('.curveNodes'),readout=root.querySelector('.curveReadout');
    let channel='rgb',selected=0,drag=null;
    const colors={rgb:'#eee',red:'#f47c7c',green:'#85d79b',blue:'#83afff'};
    function refresh(){
      const points=parse(input.value)[channel];selected=Math.min(selected,points.length-1);
      path.setAttribute('d',Array.from({length:257},(_,i)=>(i?'L':'M')+i+' '+(256-evaluate(points,i/256)*256)).join(' '));path.setAttribute('stroke',colors[channel]);
      nodes.innerHTML=points.map((p,i)=>`<circle data-point="${i}" cx="${p[0]*256}" cy="${256-p[1]*256}" r="${i===selected?5:4}" fill="${colors[channel]}"/>`).join('');
      readout.textContent=`Input ${Math.round(points[selected][0]*255)} · Output ${Math.round(points[selected][1]*255)}`;
      root.querySelectorAll('[data-channel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.channel===channel)));
    }
    function save(data){input.value=serialize(data);refresh();change()}
    function position(event){const rect=svg.getBoundingClientRect();return [clamp((event.clientX-rect.left)/rect.width),clamp(1-(event.clientY-rect.top)/rect.height)]}
    svg.addEventListener('pointerdown',event=>{
      if(disabled()||event.button!==0)return;event.preventDefault();begin();
      const data=parse(input.value),points=data[channel],pos=position(event),hit=event.target.dataset.point;
      if(hit!==undefined)selected=Number(hit);
      else {if(points.length>=16)return;selected=points.findIndex(p=>p[0]>pos[0]);if(selected<=0)return;pos[0]=Math.max(points[selected-1][0]+1/255,Math.min(points[selected][0]-1/255,pos[0]));points.splice(selected,0,pos);save(data)}
      drag=event.pointerId;svg.setPointerCapture(drag);svg.focus();refresh();
    });
    svg.addEventListener('pointermove',event=>{
      if(drag!==event.pointerId)return;const data=parse(input.value),points=data[channel],pos=position(event);
      pos[0]=selected===0?0:selected===points.length-1?1:Math.max(points[selected-1][0]+1/255,Math.min(points[selected+1][0]-1/255,pos[0]));points[selected]=pos;save(data);
    });
    const end=()=>{drag=null};svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);svg.addEventListener('lostpointercapture',end);
    function remove(){const data=parse(input.value);if(selected===0||selected===data[channel].length-1)return;begin();data[channel].splice(selected,1);selected--;save(data)}
    svg.addEventListener('dblclick',event=>{if(!disabled()&&event.target.dataset.point!==undefined){selected=Number(event.target.dataset.point);remove()}});
    svg.addEventListener('keydown',event=>{
      if(disabled())return;if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();remove();return}
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();begin();
      const data=parse(input.value),points=data[channel],p=points[selected],step=(event.shiftKey?10:1)/255;
      if(event.key==='ArrowUp'||event.key==='ArrowDown')p[1]=clamp(p[1]+(event.key==='ArrowUp'?step:-step));
      else if(selected>0&&selected<points.length-1)p[0]=Math.max(points[selected-1][0]+1/255,Math.min(points[selected+1][0]-1/255,p[0]+(event.key==='ArrowRight'?step:-step)));
      save(data);
    });
    root.querySelectorAll('[data-channel]').forEach(b=>b.addEventListener('click',()=>{channel=b.dataset.channel;selected=0;refresh()}));
    root.querySelector('.curvePreset').addEventListener('change',event=>{
      if(disabled())return;begin();const data=parse(input.value),strength=Number(event.target.value);data[channel]=strength?[[0,0],[.25,.25-strength],[.5,.5],[.75,.75+strength],[1,1]]:identity();save(data);event.target.value='';
    });
    function setHistogram(canvas){
      const sample=document.createElement('canvas');sample.width=128;sample.height=128;
      const ctx=sample.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0,128,128);
      const pixels=ctx.getImageData(0,0,128,128).data,bins=new Uint32Array(64);
      for(let i=0;i<pixels.length;i+=4)bins[Math.min(63,Math.floor((pixels[i]*.2126+pixels[i+1]*.7152+pixels[i+2]*.0722)/4))]++;
      const max=Math.max(...bins,1);root.querySelector('.curveHistogram').setAttribute('d','M0 256 '+Array.from(bins,(n,i)=>'L'+(i*256/63)+' '+(256-210*Math.sqrt(n/max))).join(' ')+' L256 256 Z');
    }
    refresh();return {refresh,setHistogram};
  }
  return {parse,serialize,isActive,evaluate,apply,createEditor};
});
