const node=typeof process!=='undefined'&&!!process.versions?.node;
let send,listen;
if(node){const {parentPort}=await import('node:worker_threads');send=value=>parentPort.postMessage(value,[value.data?.buffer].filter(Boolean));listen=fn=>parentPort.on('message',fn)}
else{send=value=>self.postMessage(value,[value.data?.buffer].filter(Boolean));listen=fn=>{self.onmessage=event=>fn(event.data)}}
function checkSize(width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>100_000_000)throw new Error('The decoded image is invalid or exceeds the 100-megapixel limit.');
}
async function decodeRaw(buffer){
  const {default:createRaw}=await import('./vendor/libraw.mjs');
  const raw=await createRaw();
  const call=(name,result,args)=>raw.cwrap(name,result,args);
  const init=call('init','number',['number']),open=call('open_buffer','number',['number','number','number']);
  const close=call('close',null,['number']),setParam=call('set_param',null,['number','string','number']);
  const handle=init(0),input=raw._malloc(buffer.byteLength);
  let output=0;
  try{
    raw.HEAPU8.set(new Uint8Array(buffer),input);
    const code=open(handle,input,buffer.byteLength);
    if(code!==0)throw new Error(`This RAW camera or compression variant is not supported by the bundled decoder (code ${code}).`);
    const sizes=call('get_sizes','number',['number'])(handle);
    let view=new DataView(raw.HEAPU8.buffer);
    checkSize(view.getUint16(sizes+6,true),view.getUint16(sizes+4,true));
    const other=call('get_imgother','number',['number'])(handle);
    const timestamp=view.getUint32(other+16,true);
    setParam(handle,'use_camera_wb',1);setParam(handle,'output_color',1);setParam(handle,'output_bps',8);
    const callback=raw.addFunction(()=>{},'vii');
    output=call('get_image','number',['number','number'])(handle,callback);
    if(!output)throw new Error('This RAW file could not be developed. Its compression or camera model may not be supported.');
    view=new DataView(raw.HEAPU8.buffer);
    const format=view.getUint32(output,true),height=view.getUint16(output+4,true),width=view.getUint16(output+6,true),colors=view.getUint16(output+8,true),bits=view.getUint16(output+10,true),size=view.getUint32(output+12,true);
    checkSize(width,height);
    if(format!==2||colors!==3||bits!==8||size!==width*height*3)throw new Error('The RAW decoder returned an unsupported pixel layout.');
    const rgb=raw.HEAPU8.subarray(output+16,output+16+size),data=new Uint8ClampedArray(width*height*4);
    for(let i=0,j=0;i<rgb.length;i+=3,j+=4){data[j]=rgb[i];data[j+1]=rgb[i+1];data[j+2]=rgb[i+2];data[j+3]=255}
    return {width,height,data,captureTime:timestamp?timestamp*1000:null};
  }finally{if(output)call('clear_image',null,['number'])(output);close(handle);raw._free(input)}
}
async function decodeHeif(buffer){
  const {default:createHeif}=await import('./vendor/libheif.mjs');
  const libheif=await createHeif();
  const images=new libheif.HeifDecoder().decode(new Uint8Array(buffer));
  const image=images[0];
  if(!image)throw new Error('This HEIC/HEIF file could not be decoded.');
  const width=image.get_width(),height=image.get_height();checkSize(width,height);
  return new Promise((resolve,reject)=>image.display({width,height,data:new Uint8ClampedArray(width*height*4)},result=>result?resolve(result):reject(new Error('This HEIC/HEIF image uses an unsupported codec.'))));
}
function orient(result,orientation){
  if(!orientation||orientation===1)return result;
  const {width:w,height:h,data}=result,swap=orientation>=5,width=swap?h:w,height=swap?w:h,out=new Uint8ClampedArray(data.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let dx=x,dy=y;
    if(orientation===2)dx=w-1-x;
    if(orientation===3){dx=w-1-x;dy=h-1-y}
    if(orientation===4)dy=h-1-y;
    if(orientation===5){dx=y;dy=x}
    if(orientation===6){dx=h-1-y;dy=x}
    if(orientation===7){dx=h-1-y;dy=w-1-x}
    if(orientation===8){dx=y;dy=w-1-x}
    out.set(data.subarray((y*w+x)*4,(y*w+x)*4+4),(dy*width+dx)*4);
  }
  return {width,height,data:out};
}
listen(async({buffer,kind})=>{
  try{
    let result;
    if(kind==='raw')result=await decodeRaw(buffer);
    else if(kind==='heif')result=await decodeHeif(buffer);
    else if(kind==='tiff'){
      const {default:UTIF}=await import('./vendor/utif.mjs');
      const page=UTIF.decode(buffer).find(page=>page.t256&&page.t257);
      if(!page)throw new Error('No image was found in this TIFF.');
      checkSize(page.t256[0],page.t257[0]);UTIF.decodeImage(buffer,page);
      result=orient({width:page.width,height:page.height,data:UTIF.toRGBA8(page)},page.t274?.[0]||1);
    }else if(kind==='bmp'){
      const {default:decode}=await import('./vendor/bmp.mjs');
      const bitmap=decode(new Uint8Array(buffer));checkSize(bitmap.width,bitmap.height);
      // bmp-js returns ABGR; the editor and Sharp consume RGBA.
      const data=new Uint8ClampedArray(bitmap.data.length);
      for(let i=0;i<data.length;i+=4){data[i]=bitmap.data[i+3];data[i+1]=bitmap.data[i+2];data[i+2]=bitmap.data[i+1];data[i+3]=255}
      result={width:bitmap.width,height:bitmap.height,data};
    }else throw new Error('Unsupported decoder requested.');
    checkSize(result.width,result.height);
    if(result.data?.length!==result.width*result.height*4)throw new Error('The image decoder returned incomplete pixels.');
    send(result);
  }catch(error){send({error:error.message||'This photo could not be decoded.'})}
});
